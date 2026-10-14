/**
 * dsh-cybernetics — 控制论内核 v4 运行时（DeepSeek Harness 插件）
 *
 * v0.2.0（2026-10-14，dsh 0.2 适配 + 规则收敛）：
 *   适配 1 删除 `export const Config = null`（Config 不导出才安全，null 会崩设置页）
 *   适配 2 feedforward 规则表删除不可逆写入类（irreversible-write 等）拦截规则——
 *      「批不批」收敛到 dsh-approval-gate；本插件只保留 retry/timeout 类「放行+警告」
 *   适配 3 agent/pre-step 注入 source 改 v4 形态 { kind: 'plugin:dsh-cybernetics' }
 *      （旧 { kind:'plugin', plugin:... } 形态被 0.2 v4 校验器直接拒绝）
 *
 * v4.3（2026-08-25，对照《工程控制论》精读 + state_log 实测，5 项修正）：
 *   D1 发散直通升档：连续失败（divergenceStreak≥阈值）直接升档，不再依赖 pHat——
 *      修复"发散告警 7 次但 pHat 卡 0.488 推不动档位"的解耦缺陷（core.adjustControlPure）
 *   D2 升档对称防抖：pHat 升档需连续 escalateStreak 次防抖，与降档对称——
 *      修复"突发失败→瞬间升到顶→快速降回"的档位抖动
 *   D3 自适应增益：连续失败时大 α（alphaHigh）快速跟上现实，稳态小 α（alphaLow）强滤波抗抖动
 *      （core.adaptiveAlpha，对照 15.11 卡尔曼自适应增益的工程简化）
 *   D4 保守档饱和兜底：conservative 下仍连续失败（≥saturationStreak）→ 注入"求助/人工介入"提示
 *   D5 熵告警豁免 subagent（UUID sid）——专注型批量任务工具单一化是正常行为；FS_NOT_OBSERVED
 *      失败兜底提示"先 read 再写"；异步 job pre/result 按 exec.__cyber 快照配对（修耗时/预测错位）
 *
 * v4.2（2026-08-19，13 项完善，对照 v4.1 实测反馈）：
 *   A1 修复冗余 hash 假误报（exec.args 恒 undefined → 改用 execArgsText 参数文本）
 *   A2 观测完整率钳制 ≤1（孤儿 result 不再把分子顶破）
 *   A3 boot 日志回放恢复状态（pHat/档位跨重启续算，消除系统失忆）
 *   B4 信息熵告警（工具单一化 = 死循环/偏执信号，带滞环防抖）
 *   B5 工具耗时观测（dtMs 入日志 + 最慢 TOP3）
 *   B6 agent/disposed 会话汇总事件（session-summary，供周检 automation）
 *   B7 按 session 分区状态（并发会话不互相污染 pHat/档位/计数）
 *   C8 冗余事件聚合记录（不再逐条刷日志）
 *   C9 status 内存态与日志回放态交叉校验（漂移标注）
 *   C10 版本常量统一 VERSION
 *   C11 警告注入失败留痕（dropped-warn）
 *   C12 纯函数下沉 core.mjs + node:test 单元测试
 *   C13 健康评分 healthScore（0-100）
 *
 * v4.1 对照《工程控制论》（钱学森/宋健·第三版）：
 *   P0-1 反馈回路闭合：EMA 滤波估计失败率 pHat，负反馈控制律驱动模式档位自适应
 *        （fast→deep→conservative），档位调节稳定阀阈值与提醒强度
 *   P0-2 能控性自检修复：可用工具集 = 插件工具 ∪ 被动观测到的宿主工具
 *   P1-1 一阶递归滤波（EMA）估计真实失败率，替代 v3 的二值 y_pred
 *   P1-2 发散检测（连续失败）与振荡检测（结果翻转率）
 *   P2   工具分布香农熵、冗余调用检测、能观性自检——观测完整率、
 *        前馈规则工具名白名单
 *
 * 结构（经典控制回路）：
 *   观测器    内存状态（按 session 分区）+ JSONL 持久化（stateLog）
 *   前馈控制  tools/pre-execute：规则表「放行+警告」（retry/timeout 类；
 *             不可逆拦截规则已收敛到 dsh-approval-gate）+ 本轮调用计数
 *   反馈校正  tools/result：delta → EMA → 控制律（档位自适应 + 发散/振荡检测）
 *   执行器    cybernetics_snap / cybernetics_status / cybernetics_check
 *             / cybernetics_sandbox_mode
 *   能控性    目标 + 所需工具 vs 当前可用工具 自检
 */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  VERSION,
  DEFAULT_MODES,
  MODE_ORDER,
  MODE_LIMITS,
  DEFAULT_FEEDFORWARD,
  ema,
  adaptiveAlpha,
  detectOscillationPure,
  adjustControlPure,
  execArgsText,
  redundantHash,
  computeEntropyPure,
  healthScorePure,
  classifyToolError,
} from './core.mjs'

export const name = 'dsh-cybernetics'
export const inject = ['tools', 'agents']

// ---------- 规则归一化 ----------
// 兼容两种配置来源：
//   默认格式  { id, tools?, pattern, action: { strategy, ... } }
//   patch 格式 { name, match: [...], action: 'retry+timeout' | 'dry-run+confirm' }
function normalizeRule(rule) {
  const action = typeof rule.action === 'string' ? { strategy: rule.action } : (rule.action ?? {})
  return {
    id: rule.id ?? rule.name ?? 'rule',
    tools: Array.isArray(rule.tools) ? rule.tools : undefined,
    pattern: rule.pattern ?? (Array.isArray(rule.match) ? rule.match.join('|') : ''),
    action,
  }
}

function normalizeFeedforward(list) {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_FEEDFORWARD
  return list.map(normalizeRule)
}

// modes 兼容：数值 { fast: 0.3 } 或 patch 对象 { fast: { zeta: 0.3, label } }；缺省用默认
function normalizeModes(modes) {
  const out = {}
  for (const [k, v] of Object.entries(modes ?? {})) {
    out[k] = typeof v === 'object' && v !== null ? (v.zeta ?? 0.5) : v
  }
  return Object.keys(out).length ? out : { ...DEFAULT_MODES }
}

// ---------- 会话状态工厂（B7：每会话一份控制状态） ----------
function createSessionState(sid, seed = {}) {
  return {
    sid,
    createdAt: Date.now(),
    toolCallsInTurn: 0,        // 本轮（当前请求）内调用数，agent/pre-step 重置
    totalSessionCalls: 0,
    lastDelta: 0,
    mode: seed.autoMode ?? 'fast',   // 当前生效档位（auto 或 manual）
    modeSource: 'auto',        // 'auto' | 'manual'
    manualModeUntil: 0,        // snap 手动模式的到期时间戳
    autoMode: seed.autoMode ?? 'fast', // 自适应档位（控制律输出）
    lastModeSwitch: 0,
    deescalateStreak: 0,
    escalateStreak: 0,        // 升档防抖计数（v4.3 对称防抖）
    yPred: null,
    pHat: seed.pHat ?? 0,      // EMA 失败率估计（P1-1）
    startPHat: seed.pHat ?? 0, // B6 会话汇总用：起始失败率
    divergence: false,         // 发散标志（P1-2）
    divergenceStreak: 0,
    divergenceWarned: false,
    saturationWarned: false,   // v4.3 保守档饱和求助防抖
    oscillation: false,        // 振荡标志（P1-2）
    oscillationWarned: false,
    resultBuf: [],             // delta 环形缓冲（振荡检测）
    redundantCalls: 0,         // 窗口内冗余调用累计（P2）
    entropy: 0,                // 窗口内工具分布香农熵（P2）
    entropyWarned: false,      // B4 熵告警防抖
    preExecCount: 0,           // 放行调用数（能观性分母）
    resultCount: 0,            // 结果观测数（能观性分子）
    observationRate: 'n/a',    // 观测完整率（P2 能观性自检，A2 钳制 ≤1）
    pendingWarns: [],          // 待注入警告队列（agent/pre-step 消费）
    warnedOverLimit: false,
    recentCalls: [],           // 最近调用 { tool, hash, ts }（冗余/熵窗口）
    toolDurations: new Map(),  // B5 工具耗时 { tool → { totalMs, count } }
    sessionObserved: new Set(), // 本次会话实际调用过的工具（能观性分层依据）
    lastStartTs: 0,            // B5 最近一次 pre-execute 起点
    lastStartTool: '',
    failedHintSent: false,     // 连续失败→skill_search 兜底提示已注入标记（每轮重置）
  }
}

export function apply(ctx, config = {}) {
  // ---------- 配置兜底合并 ----------
  // stateLog / observedToolsFile 支持 '~' 前缀（cordis.patch.yml 配置常带字面 '~'）
  function expandHome(p) {
    if (typeof p !== 'string' || p === '') return p
    if (p === '~') return homedir()
    if (p.startsWith('~/')) return join(homedir(), p.slice(2))
    return p
  }
  const stateLogPath = expandHome(config.stateLog) || resolve(homedir(), '.dsh', 'cybernetics', 'state_log.ndjson')
  const cfg = {
    stateLog: stateLogPath,
    observedToolsFile: expandHome(config.observedToolsFile) || join(dirname(stateLogPath), 'observed_tools.json'),
    feedforward: normalizeFeedforward(config.feedforward),
    stability: { maxToolCallsPerTurn: config.stability?.maxToolCallsPerTurn ?? 5 },
    modes: normalizeModes(config.modes),
    control: {
      alpha: config.control?.alpha ?? 0.2,             // EMA 滤波系数（旧；被 alphaLow/alphaHigh 取代，兼容保留）
      alphaLow: config.control?.alphaLow ?? config.control?.alpha ?? 0.15, // v4.3 稳态小增益（强滤波抗抖动）
      alphaHigh: config.control?.alphaHigh ?? 0.5,     // v4.3 突变大增益（连续失败时快速跟上现实）
      escalateAt: config.control?.escalateAt ?? 0.6,   // 升档阈值（失败率高）
      deescalateAt: config.control?.deescalateAt ?? 0.15, // 降档阈值（失败率低）
      deescalateStreak: config.control?.deescalateStreak ?? 5, // 降档防抖连续次数（滞环）
      escalateStreak: config.control?.escalateStreak ?? 3,     // v4.3 升档防抖连续次数（对称滞环）
      divergenceStreak: config.control?.divergenceStreak ?? 3, // 连续失败判定发散
      saturationStreak: config.control?.saturationStreak ?? 6, // v4.3 保守档饱和求助阈值
      oscillationWindow: config.control?.oscillationWindow ?? 10, // 振荡检测窗口
      oscillationRatio: config.control?.oscillationRatio ?? 0.7,  // 翻转率阈值
      redundantWindow: config.control?.redundantWindow ?? 20,     // 冗余/熵窗口
      manualModeMs: config.control?.manualModeMs ?? 60000,        // snap 手动模式持续
      entropyWarnAt: config.control?.entropyWarnAt ?? 1.0,        // B4 低熵告警阈值
      entropyRecoverAt: config.control?.entropyRecoverAt ?? 1.5,  // B4 熵恢复阈值（滞环）
    },
  }
  const logFile = resolve(cfg.stateLog)

  // ---------- 1. 全局状态（跨会话）：工具发现、前馈统计、恢复种子 ----------
  const state = {
    totalToolCalls: 0,
    feedforwardHits: 0,
    feedforwardBlocks: 0,
    observedTools: new Set(),    // 已知工具：插件 ∪ 历史记忆 ∪ 本次观测（P0-2）
    obsPersistedSize: 0,         // 已落盘的观测集大小（变更才写盘）
    bySession: new Map(),        // B7: sid → sessionState
    pHatSeed: 0,                 // A3: 重启恢复的全局失败率种子
    autoModeSeed: 'fast',        // A3: 重启恢复的档位种子
    recovered: null,             // A3: 恢复摘要（日志回放结果）
  }
  // 插件自身工具先行登记，避免冷启动时自检误报
  for (const t of ['cybernetics_snap', 'cybernetics_status', 'cybernetics_check', 'cybernetics_sandbox_mode']) state.observedTools.add(t)
  // v4.1 观测记忆：boot 恢复上次会话观测到的宿主工具（消除冷启动能控性误报）
  try {
    if (existsSync(cfg.observedToolsFile)) {
      const remembered = JSON.parse(readFileSync(cfg.observedToolsFile, 'utf8'))
      if (Array.isArray(remembered)) for (const t of remembered) if (typeof t === 'string') state.observedTools.add(t)
    }
  } catch { /* 记忆损坏则从空开始 */ }
  state.obsPersistedSize = state.observedTools.size
  function persistObservedTools() {
    try {
      mkdirSync(dirname(cfg.observedToolsFile), { recursive: true })
      writeFileSync(cfg.observedToolsFile, JSON.stringify([...state.observedTools].sort()))
      state.obsPersistedSize = state.observedTools.size
    } catch { /* 持久化失败不阻断控制回路 */ }
  }

  function logState(entry) {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, JSON.stringify(entry) + '\n')
    } catch {
      // 观测失败不阻断控制回路
    }
  }

  // ---------- 会话路由（B7） ----------
  // rc.6 的 exec/agent 挂 session；无 session 的调用路径（如 cron/后台）归入 'global' 兜底
  function sidOf(exec) {
    return exec?.agent?.session?.id ?? exec?.session?.id ?? 'global'
  }
  function getSessionState(sid) {
    let s = state.bySession.get(sid)
    if (!s) {
      s = createSessionState(sid, { pHat: state.pHatSeed, autoMode: state.autoModeSeed })
      state.bySession.set(sid, s)
      logState({ ts: Date.now(), event: 'session-start', sid, seedPHat: s.pHat, seedMode: s.autoMode })
    }
    return s
  }
  function sessionOf(exec) {
    return getSessionState(sidOf(exec))
  }

  // ---------- 控制律（P0-1 闭合回路 + P1-1 滤波 + P1-2 检测；按会话） ----------
  function pushResultBuf(s, delta) {
    s.resultBuf.push(delta)
    if (s.resultBuf.length > cfg.control.oscillationWindow) s.resultBuf.shift()
  }
  function queueWarn(s, text) {
    s.pendingWarns.push(text)
  }
  function currentMode(s) {
    if (s.modeSource === 'manual' && Date.now() >= s.manualModeUntil) {
      s.modeSource = 'auto' // 手动模式到期，恢复自适应
      s.mode = s.autoMode
    }
    return s.mode
  }
  function adjustControl(s, delta) {
    // v4.3 自适应增益：连续失败时大 α 快速跟上现实，稳态小 α 强滤波抗抖动（对照 15.11）
    const alpha = adaptiveAlpha(s.divergenceStreak, cfg.control)
    // P1-1 一阶递归滤波：pHat = (1-α)·pHat + α·delta
    s.pHat = ema(s.pHat, delta, alpha)
    // 发散检测：连续失败（正反馈发散倾向）
    s.divergenceStreak = delta === 1 ? s.divergenceStreak + 1 : 0
    if (s.divergenceStreak >= cfg.control.divergenceStreak && !s.divergence) {
      s.divergence = true
      if (!s.divergenceWarned) {
        s.divergenceWarned = true
        logState({ ts: Date.now(), event: 'divergence-warn', sid: s.sid, streak: s.divergenceStreak, pHat: s.pHat })
        queueWarn(s, `[控制律] 连续 ${s.divergenceStreak} 次工具失败（pHat=${s.pHat.toFixed(2)}），检测到发散倾向，请检查工具链/命令正确性并降低并发`)
      }
    } else if (delta === 0 && s.divergence) {
      s.divergence = false
      s.divergenceWarned = false
    }
    // 振荡检测：结果 0/1 高频翻转（自激振荡）
    pushResultBuf(s, delta)
    const osc = detectOscillationPure(s.resultBuf, cfg.control.oscillationRatio)
    if (osc && !s.oscillation) {
      s.oscillation = true
      if (!s.oscillationWarned) {
        s.oscillationWarned = true
        logState({ ts: Date.now(), event: 'oscillation-warn', sid: s.sid, window: s.resultBuf.length, pHat: s.pHat })
        queueWarn(s, `[控制律] 工具结果在失败/成功间高频翻转（窗口 ${s.resultBuf.length} 内翻转率 ≥ ${cfg.control.oscillationRatio}），疑似振荡，建议减少并行依赖`)
      }
    } else if (!osc && s.oscillation) {
      s.oscillation = false
      s.oscillationWarned = false
    }
    // 负反馈 + 滞环 + 发散直通升档（v4.3）：纯函数决策，副作用（日志/警告）在此呈现
    const r = adjustControlPure({
      pHat: s.pHat,
      autoMode: s.autoMode,
      deescalateStreak: s.deescalateStreak,
      escalateStreak: s.escalateStreak,
      divergenceStreak: s.divergenceStreak,
      control: cfg.control,
    })
    if (r.escalated || r.deescalated) {
      const prev = s.autoMode
      s.autoMode = r.autoMode
      if (s.modeSource !== 'manual') s.mode = r.autoMode
      s.lastModeSwitch = Date.now()
      const cause = r.escalated ? (s.divergence ? 'escalate-divergence' : 'escalate') : 'deescalate'
      logState({ ts: Date.now(), event: 'mode-switch', sid: s.sid, from: prev, to: r.autoMode, pHat: s.pHat, cause })
      const reason = r.escalated
        ? (s.divergence ? `连续 ${s.divergenceStreak} 次失败（发散直通升档）` : `失败率 pHat=${s.pHat.toFixed(2)} 连续超阈值 ${cfg.control.escalateAt}`)
        : `失败率 pHat=${s.pHat.toFixed(2)} 连续 ${cfg.control.deescalateStreak} 次低于阈值 ${cfg.control.deescalateAt}`
      queueWarn(s, `[控制律] ${reason}，模式档位 ${prev}→${r.autoMode}（稳定阀阈值 ${MODE_LIMITS[prev]}→${MODE_LIMITS[r.autoMode]}）`)
    }
    s.deescalateStreak = r.deescalateStreak
    s.escalateStreak = r.escalateStreak
    // v4.3 饱和兜底：保守档仍连续失败（超 saturationStreak）→ 求助而非硬试（控制饱和，对照第 4 章反例）
    if (s.autoMode === 'conservative' && s.divergenceStreak >= cfg.control.saturationStreak && !s.saturationWarned) {
      s.saturationWarned = true
      logState({ ts: Date.now(), event: 'saturation-warn', sid: s.sid, streak: s.divergenceStreak, pHat: s.pHat })
      queueWarn(s, `[控制律] 保守档下仍连续 ${s.divergenceStreak} 次失败（饱和），继续硬试无益，建议暂停并求助用户或人工介入，不要继续盲目重试`)
    }
    if (delta === 0) s.saturationWarned = false // 成功后复位，允许下次饱和再告警
  }

  // ---------- A3 日志回放恢复（boot 时调用）：pHat/档位跨重启续算 ----------
  function recoverStateFromLog(maxLines = 500) {
    try {
      if (!existsSync(logFile)) return false
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
      let p = 0
      let autoMode = 'fast'
      let deescalateStreak = 0
      let escalateStreak = 0
      let divergenceStreak = 0
      let results = 0
      let lastResultTs = 0
      for (const l of lines) {
        let e
        try { e = JSON.parse(l) } catch { continue }
        if (e.event === 'result' && typeof e.delta === 'number') {
          divergenceStreak = e.delta === 1 ? divergenceStreak + 1 : 0
          const alpha = adaptiveAlpha(divergenceStreak, cfg.control)
          p = ema(p, e.delta, alpha)
          lastResultTs = e.ts ?? 0
          results += 1
          const r = adjustControlPure({ pHat: p, autoMode, deescalateStreak, escalateStreak, divergenceStreak, control: cfg.control })
          autoMode = r.autoMode
          deescalateStreak = r.deescalateStreak
          escalateStreak = r.escalateStreak
        } else if (e.event === 'mode-switch' && typeof e.to === 'string') {
          autoMode = e.to
        }
      }
      if (results === 0) return false
      state.pHatSeed = p
      state.autoModeSeed = autoMode
      state.recovered = { entries: lines.length, results, pHat: p, autoMode, lastResultTs }
      logState({ ts: Date.now(), event: 'boot-recover', ...state.recovered })
      return true
    } catch {
      return false
    }
  }

  // ---------- C9 日志回放 pHat（status 交叉校验用） ----------
  function replayPHat(n = 50) {
    try {
      if (!existsSync(logFile)) return null
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-n)
      let p = 0
      let count = 0
      for (const l of lines) {
        let e
        try { e = JSON.parse(l) } catch { continue }
        if (e.event === 'result' && typeof e.delta === 'number') {
          p = ema(p, e.delta, cfg.control.alpha)
          count += 1
        }
      }
      return count ? p : null
    } catch {
      return null
    }
  }

  // ---------- B5 最慢工具 TOP3（会话级） ----------
  function slowestTools(s, top = 3) {
    return [...s.toolDurations.entries()]
      .map(([tool, { totalMs, count }]) => ({ tool, avgMs: Math.round(totalMs / Math.max(1, count)), count }))
      .sort((x, y) => y.avgMs - x.avgMs)
      .slice(0, top)
  }

  // ---------- C13 健康评分（会话级） ----------
  function healthOf(s) {
    return healthScorePure({
      pHat: s.pHat,
      observationRate: typeof s.observationRate === 'number' ? s.observationRate : 1,
      redundantRate: s.preExecCount > 0 ? s.redundantCalls / s.preExecCount : 0,
      divergence: s.divergence,
      oscillation: s.oscillation,
    })
  }

  // ---------- 前馈匹配（P2：工具名白名单，pattern 只匹配参数） ----------
  function matchFeedforward(exec) {
    const toolName = exec?.name || exec?.tool || exec?.id || ''
    const argsText = execArgsText(exec)
    let first = null
    for (const rule of cfg.feedforward) {
      try {
        if (rule.tools && !rule.tools.includes(toolName)) continue // 工具名白名单
        if (!rule.pattern) continue
        if (new RegExp(rule.pattern).test(argsText)) {
          // 不可逆/破坏性操作（dry-run+confirm）永远最优先，避免被网络类规则抢先短路
          if (rule.action.strategy === 'dry-run+confirm') return rule
          first = first ?? rule
        }
      } catch {
        // 无效正则跳过
      }
    }
    return first
  }

  // ---------- 2. tools/pre-execute：计数 + 前馈拦截 + 观测收集（B7 会话级） ----------
  ctx.on('tools/pre-execute', (exec, next) => {
    const toolName = exec?.name || exec?.tool || exec?.id || 'unknown'
    const now = Date.now()
    const sid = sidOf(exec)
    const s = sessionOf(exec)
    state.totalToolCalls += 1
    s.toolCallsInTurn += 1
    s.totalSessionCalls += 1
    state.observedTools.add(toolName) // P0-2：被动观测宿主工具
    s.sessionObserved.add(toolName)
    if (state.observedTools.size !== state.obsPersistedSize) persistObservedTools()

    // P2 冗余/熵窗口（A1 修复：hash 基于参数文本，见 core.redundantHash）
    const hash = redundantHash(toolName, exec)
    const isRedundant = s.recentCalls.some((c) => c.tool === toolName && c.hash === hash)
    if (isRedundant) {
      s.redundantCalls += 1
      // C8：聚合记录，不逐条刷日志（首次与每 10 次各记一条）
      if (s.redundantCalls === 1 || s.redundantCalls % 10 === 0) {
        logState({ ts: now, event: 'redundant-burst', sid, count: s.redundantCalls })
      }
    }
    s.recentCalls.push({ tool: toolName, hash, ts: now })
    if (s.recentCalls.length > cfg.control.redundantWindow) s.recentCalls.shift()
    s.entropy = computeEntropyPure(s.recentCalls)

    // B4 熵告警（低熵 = 工具单一化 → 可能死循环/偏执；带滞环防抖）
    // 2026-08-23 豁免：automation/lark 固定流程会话天然单工具，低熵是正常行为非偏执
    // （周检实测：48 次 entropy-warn 中 automation 9 + lark 7 = 16 次确定性误报，占 1/3）
    // 2026-08-23 豁免 automation/lark（固定流程天然单工具）；2026-08-25 扩展 subagent——
    // 专注型批量任务（连续 read 一本书/批量文件）工具单一化是正常行为，非死循环/偏执
    // subagent 会话 sid 为 UUID 格式（如 e28b9019-0487-…），与正常 session 的 session-xxx 前缀区分
    const entropyExempt = /^(dsh-automation|automation|lark)/.test(sid) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)
    if (!entropyExempt && s.recentCalls.length >= 8 && s.entropy < cfg.control.entropyWarnAt && !s.entropyWarned) {
      s.entropyWarned = true
      logState({ ts: now, event: 'entropy-warn', sid, entropy: s.entropy, window: s.recentCalls.length })
      queueWarn(s, `[控制律] 工具分布熵 ${s.entropy.toFixed(2)} 过低（<${cfg.control.entropyWarnAt}，最近 ${s.recentCalls.length} 次调用工具单一化），疑似陷入循环/偏执，请检查当前策略并多样化工具使用`)
    } else if (s.entropy >= cfg.control.entropyRecoverAt) {
      s.entropyWarned = false // 恢复条件（滞环）
    }

    // 前馈：高风险/不可逆操作 → 批准门（dry-run+confirm）或放行+警告（retry+timeout）
    const hit = matchFeedforward(exec)
    if (hit) {
      state.feedforwardHits += 1
      const isAsk = hit.action.strategy === 'dry-run+confirm' // 不可逆操作：强制批准门
      if (!isAsk) state.feedforwardBlocks += 1
      logState({
        ts: now,
        event: 'pre-execute',
        sid,
        tool: toolName,
        feedforward: hit.id,
        strategy: hit.action.strategy,
        ask: isAsk,
        blocked: !isAsk,
      })
      if (isAsk) {
        // 批准门：返回 {kind:'ask'}，工具中心走 ctx.approval.request 弹批准，
        // allowed-once 放行执行；rejected/cancelled/unavailable 一律不执行（fail closed）
        return {
          kind: 'ask',
          reason: `[前馈·批准门] 规则「${hit.id}」命中不可逆/破坏性操作（${toolName}: ${execArgsText(exec).slice(0, 120)}），需要你批准后才执行`,
        }
      }
      // retry+timeout（网络不稳定类）规则：不得硬拦截——原实现 kind:'block' 没有任何确认/重试
      // 放行路径，会把 git/npm/curl/wget/pnpm 命令永久阻断。修正：记录命中、注入警告、放行执行。
      s.pendingWarns.push(`[前馈] 规则「${hit.id}」命中 ${toolName}（${hit.action.strategy}）：已放行；网络类命令若失败请带超时重试`)
      return next()
    }

    // 稳定阀（本轮窗口，会话级）：超限降级为警告，交互/观测工具豁免
    const modeNow = currentMode(s)
    const maxPerTurn = MODE_LIMITS[modeNow] ?? cfg.stability.maxToolCallsPerTurn
    const overLimit = s.toolCallsInTurn > maxPerTurn
    const exempt = toolName === 'ask_user_question' || toolName === 'cybernetics_snap' || toolName === 'cybernetics_status' || toolName === 'cybernetics_check' || toolName === 'cybernetics_sandbox_mode'
    if (overLimit && !exempt) {
      // conservative 档持续提醒；fast/deep 档超限只提醒一次（复位机制）
      if (modeNow === 'conservative' || !s.warnedOverLimit) {
        s.warnedOverLimit = true
        logState({
          ts: now,
          event: 'stability-warn',
          sid,
          tool: toolName,
          turn: s.toolCallsInTurn,
          max: maxPerTurn,
          mode: modeNow,
          blocked: false,
        })
        queueWarn(s, `[稳定性提示] 工具调用窗口 ${s.toolCallsInTurn}/${maxPerTurn}（模式 ${modeNow}），请收敛：合并操作、减少重复调用。`)
      }
    } else if (!overLimit) {
      s.warnedOverLimit = false
    }

    // B5 耗时起点 + 记录预测 y_pred（= 滤波失败率 pHat）并放行
    // v4.3 异步配对：把起点快照挂在 exec 对象上，result 按同一 exec 引用配对，
    // 避免异步 job/subagent 的 result 迟到导致耗时/预测错位（对照第 11 章时滞）
    exec.__cyber = { startedAt: now, yPred: s.pHat }
    s.lastStartTs = now
    s.lastStartTool = toolName
    s.yPred = s.pHat
    s.preExecCount += 1
    logState({
      ts: now,
      event: 'pre-execute',
      sid,
      tool: toolName,
      y_pred: s.yPred,
      blocked: false,
    })
    return next()
  })

  // ---------- 3. tools/result：反馈误差 → 滤波 → 控制律（B7 会话级 + B5 耗时） ----------
  ctx.on('tools/result', (exec, result) => {
    const sid = sidOf(exec)
    const s = getSessionState(sid) // 孤儿 result 也会拉出会话（A2 配对口径）
    const tool = exec?.name || exec?.tool || 'unknown'
    const isError = !!(result && (result.isError === true || result.error != null || result.ok === false))
    const delta = isError ? 1.0 : 0
    s.lastDelta = delta
    s.resultCount += 1

    // B5 工具耗时（v4.3 异步配对：优先用 exec.__cyber 起点，fallback lastStartTs）
    const meta = exec?.__cyber
    const yPred = meta?.yPred ?? s.yPred
    let dtMs = null
    const startedAt = meta?.startedAt ?? s.lastStartTs
    if (startedAt) {
      dtMs = Date.now() - startedAt
      const d = s.toolDurations.get(tool) ?? { totalMs: 0, count: 0 }
      d.totalMs += dtMs
      d.count += 1
      s.toolDurations.set(tool, d)
    }

    // A2 观测完整率：钳制 ≤1（孤儿 result 不把分子顶破）
    s.observationRate = s.preExecCount > 0 ? Math.min(1, s.resultCount / s.preExecCount) : 'n/a'
    adjustControl(s, delta)
    const entry = {
      ts: Date.now(),
      event: 'result',
      sid,
      tool,
      isError,
      delta,
      y_pred: yPred,
      pHat: s.pHat,
    }
    // 方案 B（2026-08-19）：失败归因观测——errorType/errMsg 供周检第④项做根因分布
    if (isError) {
      const cls = classifyToolError(result)
      if (cls) {
        entry.errorType = cls.errorType
        if (cls.errMsg) entry.errMsg = cls.errMsg
        // v4.3 兜底：写/编辑前未 read 导致的沙箱拒绝 → 提示先 read（可消除的失败，对照第 5 章前馈意图）
        if (cls.errorType === 'FS_NOT_OBSERVED') {
          queueWarn(s, '[能控性兜底] 写/编辑文件被沙箱拒绝（FS_NOT_OBSERVED：目标文件本会话尚未 read）。请先用 read 工具读取该文件内容，再执行写/编辑。')
        }
      }
    }
    if (dtMs != null) entry.dtMs = dtMs

    // ---------- 连续失败 → skill_search 兜底（2026-08-24 能控性补全） ----------
    // 场景：模型遇到「读图/OCR/转换」等任务时用底层工具反复试错、连续失败，
    //       却跳过技能库检索。此处复用 divergenceStreak（delta===1 递增、成功清零）
    //       作为连续失败计数，达到阈值即注入强制提示，点名 skill_search 工具，
    //       把「遇阻先查技能库」从模型自觉变成程序前馈（不依赖记性）。
    // 豁免：skill_search / skill_mece_check / skill 本身——避免「检索失败→再提示检索」死循环。
    const SKILL_DISCOVERY_TOOLS = new Set(['skill_search', 'skill_mece_check', 'skill', 'list_agents'])
    if (isError && !SKILL_DISCOVERY_TOOLS.has(tool) && s.divergenceStreak >= 2 && !s.failedHintSent) {
      s.failedHintSent = true
      const lastArgs = execArgsText(exec) || ''
      const ctxHint = lastArgs ? `（最近失败调用：\`${tool}\` ${lastArgs.slice(0, 120)}）` : ''
      logState({ ts: Date.now(), event: 'skill-search-fallback', sid, tool, streak: s.divergenceStreak })
      queueWarn(s, `[能控性兜底] 连续 ${s.divergenceStreak} 次工具调用失败，疑似在用底层工具硬解、而非检索既有能力。` +
        `请立即调用 \`skill_search\` 工具检索「${tool}」相关关键词，确认是否有对口技能/现成脚本（如 OCR、读图、转换类），` +
        `再决定下一步；禁止在未检索技能库的情况下判定任务不可行。${ctxHint}`)
    }

    logState(entry)
  })

  // ---------- 3b. agent/pre-step：警告注入 + 本轮计数重置（B7 会话级 + C11 留痕） ----------
  // 在请求组装前通过 waterfall enter 追加 user 消息（合并为一条，避免角色交替破坏）
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (!decision || decision.kind === 'reject') return decision
        const sid = payload?.agent?.session?.id ?? 'global'
        const s = getSessionState(sid)
        s.toolCallsInTurn = 0 // 本轮计数重置（每轮请求边界）
        s.failedHintSent = false // 连续失败兜底提示每轮允许重新触发
        if (s.pendingWarns.length === 0) return decision
        const warns = s.pendingWarns
        s.pendingWarns = []
        try {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
          const msg = createUserMessage({
            content: [{ type: 'text', text: warns.join('\n') }],
            source: { kind: 'plugin:dsh-cybernetics' },
          })
          return { ...decision, messages: [...decision.messages, msg] }
        } catch {
          // C11：注入失败留痕，避免警告静默丢失
          logState({ ts: Date.now(), event: 'dropped-warn', sid, count: warns.length })
          return decision
        }
      })
    } catch { /* pre-step 不可用则跳过 */ }
  }

  // ---------- 3c. agent/disposed：会话汇总（B6，供周检 automation / 复盘消费） ----------
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/disposed', async ({ agent }, next) => {
        const sid = agent?.session?.id ?? 'unknown'
        const s = state.bySession.get(sid)
        if (s) {
          logState({
            ts: Date.now(),
            event: 'session-summary',
            sid,
            toolCalls: s.preExecCount,
            results: s.resultCount,
            pHatStart: s.startPHat,
            pHatEnd: s.pHat,
            modeEnd: s.mode,
            lastModeSwitch: s.lastModeSwitch ? new Date(s.lastModeSwitch).toISOString() : null,
            redundantCalls: s.redundantCalls,
            entropy: s.entropy,
            observationRate: s.observationRate,
            observedTools: s.sessionObserved.size,
            slowest: slowestTools(s).map((t) => `${t.tool}(${t.avgMs}ms)`),
          })
          state.bySession.delete(sid)
        }
        return next()
      })
    } catch { /* disposed 不可用则跳过 */ }
  }

  // ---------- 4. 工具：cybernetics_snap（状态快照 + 手动模式，B7 会话级） ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_snap',
    description: '将控制论内核当前状态（内存状态 + 前馈规则摘要 + 模式）写入状态日志并返回摘要；mode 参数临时切换模式（fast/deep/conservative，到期自动恢复自适应）',
    parameters: {
      mode: { type: 'string', description: '临时切换模式：fast / deep / conservative（60 秒后恢复自适应）' },
    },
    output: {
      schema: { type: 'string', description: '快照摘要文本' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const sid = sidOf(exec)
      const s = sessionOf(exec)
      const mode = input?.mode
      if (mode && cfg.modes[mode] != null) {
        s.mode = mode
        s.modeSource = 'manual'
        s.manualModeUntil = Date.now() + cfg.control.manualModeMs
      }
      const slowest = slowestTools(s)
      const snap = {
        ts: Date.now(),
        event: 'snap',
        state: {
          sid,
          totalToolCalls: state.totalToolCalls,
          toolCallsInTurn: s.toolCallsInTurn,
          lastDelta: s.lastDelta,
          mode: s.mode,
          modeSource: s.modeSource,
          autoMode: s.autoMode,
          pHat: s.pHat,
          feedforwardHits: state.feedforwardHits,
          feedforwardBlocks: state.feedforwardBlocks,
          divergence: s.divergence,
          oscillation: s.oscillation,
          redundantCalls: s.redundantCalls,
          entropy: s.entropy,
          observationRate: s.observationRate,
          healthScore: healthOf(s),
          slowest,
          knownTools: state.observedTools.size,
          sessionObserved: s.sessionObserved.size,
          recovered: state.recovered,
        },
        config: {
          maxToolCallsPerTurn: MODE_LIMITS[s.mode],
          modes: cfg.modes,
          feedforward: cfg.feedforward.map((r) => ({ id: r.id, tools: r.tools ?? null, pattern: r.pattern, strategy: r.action.strategy })),
        },
      }
      logState(snap)
      const lines = [
        '[cybernetics] 快照已写入',
        `session=${sid}  mode=${s.mode}（${s.modeSource}${s.modeSource === 'manual' ? `，${Math.max(0, Math.round((s.manualModeUntil - Date.now()) / 1000))}s 后恢复自适应` : ''}）`,
        `healthScore=${healthOf(s)}`,
        `toolCallsInTurn=${s.toolCallsInTurn}  totalToolCalls=${state.totalToolCalls}`,
        `lastDelta=${s.lastDelta}  pHat=${s.pHat.toFixed(3)}`,
        `feedforwardHits=${state.feedforwardHits}（blocks=${state.feedforwardBlocks}）`,
        `divergence=${s.divergence}  oscillation=${s.oscillation}`,
        `redundantCalls=${s.redundantCalls}  entropy=${s.entropy.toFixed(3)}`,
        `observationRate=${typeof s.observationRate === 'number' ? s.observationRate.toFixed(3) : s.observationRate}`,
        `knownTools=${state.observedTools.size}（本次实测 ${s.sessionObserved.size}）`,
        `slowest=${slowest.length ? slowest.map((t) => `${t.tool}(${t.avgMs}ms)`) .join(' ') : 'n/a'}`,
        `recovered=${state.recovered ? `pHat=${state.recovered.pHat.toFixed(3)} mode=${state.recovered.autoMode}（回放 ${state.recovered.results} 条 result）` : 'none'}`,
      ]
      return lines.join('\n')
    },
  }))

  // ---------- 5. 工具：cybernetics_status（状态摘要，B7 会话级 + C9 交叉校验 + C13 健康分） ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_status',
    description: '读取最近 N 条状态日志，输出摘要：工具调用次数、delta 均值、失败率估计 pHat、模式档位、发散/振荡、冗余调用、熵、观测完整率、健康评分',
    parameters: {
      n: { type: 'number', description: '读取最近多少条日志，默认 50' },
    },
    output: {
      schema: { type: 'string', description: '状态摘要文本' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const n = input?.n ?? 50
      const sid = sidOf(exec)
      const s = sessionOf(exec)
      const slowest = slowestTools(s)
      const health = healthOf(s)
      if (!existsSync(logFile)) return '[cybernetics] 状态日志尚不存在'
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-n)
      const entries = lines
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const results = entries.filter((e) => e.event === 'result')
      const deltas = results.map((e) => e.delta).filter((d) => typeof d === 'number')
      const meanDelta = deltas.length ? (deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(3) : 'n/a'
      const hits = entries.filter((e) => e.feedforward).length
      const blocked = entries.filter((e) => e.blocked).length
      const switches = entries.filter((e) => e.event === 'mode-switch')

      // C9 交叉校验：内存态 pHat vs 日志回放 pHat
      const replay = replayPHat(n)
      const drift = replay != null && typeof s.pHat === 'number' ? Math.abs(s.pHat - replay) : null
      const driftNote = drift != null ? (drift > 0.1 ? `（⚠ 与日志回放偏差 ${drift.toFixed(3)}，漂移可疑）` : `（与日志回放一致，偏差 ${drift.toFixed(3)}）`) : ''

      const out = [
        `[cybernetics] 状态摘要（最近 ${entries.length} 条）`,
        `session=${sid}  healthScore=${health}/100`,
        `工具调用（累计）: ${state.totalToolCalls}`,
        `日志内工具调用: ${results.length}`,
        `delta 均值（0=成功，1=失败）: ${meanDelta}`,
        `失败率估计 pHat（EMA）: ${typeof s.pHat === 'number' ? s.pHat.toFixed(3) : 'n/a'}${driftNote}`,
        `前馈命中: ${hits}（拦截: ${blocked}）`,
        `当前模式: ${s.mode}（${s.modeSource}${s.modeSource === 'manual' ? '，手动临时' : '，自适应'}` +
          (switches.length ? `；最近档位切换: ${switches[switches.length - 1].from}→${switches[switches.length - 1].to}（${switches[switches.length - 1].cause}）` : '') + '）',
        `发散: ${s.divergence}  振荡: ${s.oscillation}`,
        `冗余调用: ${s.redundantCalls}  工具分布熵: ${s.entropy.toFixed(3)}`,
        `观测完整率（能观性）: ${typeof s.observationRate === 'number' ? s.observationRate.toFixed(3) : s.observationRate}（${s.resultCount}/${s.preExecCount}）`,
        `最慢工具 TOP${slowest.length}: ${slowest.length ? slowest.map((t) => `${t.tool}(${t.avgMs}ms×${t.count})`).join(' ') : 'n/a'}`,
        `已知工具: ${state.observedTools.size}（本次实测 ${s.sessionObserved.size}）`,
        `boot 恢复: ${state.recovered ? `pHat=${state.recovered.pHat.toFixed(3)} mode=${state.recovered.autoMode}（回放 ${state.recovered.results} 条 result）` : 'none'}`,
      ]
      return out.join('\n')
    },
  }))

  // ---------- 6. 工具：cybernetics_check（能控性自检，P0-2 修复 + B7 会话级） ----------
  ctx.tools.register(defineTool({
    name: 'cybernetics_check',
    description: '能控性自检：给定目标与所需工具，对照当前可用工具，返回 missing / controllable / advice。可用工具集 = 插件工具 ∪ 调用中观测到的宿主工具',
    parameters: {
      goal: { type: 'string', required: true, description: '当前目标描述' },
      requiredTools: { type: 'array', items: { type: 'string' }, description: '所需工具名数组' },
    },
    output: {
      schema: { type: 'string', description: '能控性自检结论' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const goal = input?.goal || '（未提供目标）'
      const required = Array.isArray(input?.requiredTools) ? input.requiredTools : []
      const s = sessionOf(exec)
      // 可用工具集：插件自身注册工具（确定性）+ 被动观测到的宿主工具
      // （sandbox 的 ctx.tools.schemas() 按插件 scope 过滤，宿主工具不可见，
      //   故以观测法收集；对照 4.10 能观性——观测越充分，能控性判定越可信）
      let pluginTools = []
      try {
        if (typeof ctx.tools?.schemas === 'function') pluginTools = ctx.tools.schemas().map((t) => t.name).filter(Boolean)
      } catch {
        pluginTools = []
      }
      // 语义分层（v4.1）：未观测 ≠ 缺失
      //   missing     确定性缺失（插件/记忆/观测均无）→ not-controllable（真警告）
      //   unobserved  已知可用但本次会话尚未实测（依据观测记忆）→ 提示 caution，不判不可控
      const known = new Set([...pluginTools, ...state.observedTools])
      const missing = required.filter((t) => !known.has(t))
      const unobserved = required.filter((t) => known.has(t) && !pluginTools.includes(t) && !s.sessionObserved.has(t))
      const controllable = missing.length === 0
      const advice = !controllable
        ? `缺少工具：${missing.join(', ')}。建议：1) 检查插件 inject 依赖；2) 注册缺失工具；3) 用 cybernetics_snap 记录当前配置后复核。`
        : unobserved.length
          ? `所需工具齐备；其中 ${unobserved.length} 个本次会话尚未实测（依据上次观测记忆），建议调用一次确认可用。`
          : '所需工具齐备，系统可控，可按目标推进。'
      return [
        '[cybernetics] 能控性自检',
        `目标: ${goal}`,
        `所需工具(${required.length}): ${required.join(', ') || '无'}`,
        `已知工具(${known.size}): ${[...known].join(', ') || '无'}`,
        `未实测（本次会话）: ${unobserved.join(', ') || '无'}`,
        `missing: ${missing.join(', ') || '无'}`,
        `能控性: ${controllable ? (unobserved.length ? 'controllable（含未实测提示）' : 'controllable') : 'not-controllable'}`,
        `advice: ${advice}`,
        `注: 宿主工具为观测所得（记忆 ${known.size} 个，本次实测 ${s.sessionObserved.size} 个）；观测完整率 ${typeof s.observationRate === 'number' ? s.observationRate.toFixed(3) : s.observationRate}`,
      ].join('\n')
    },
  }))

  // ---------- 6.5 工具：cybernetics_sandbox_mode（切换会话沙箱模式） ----------
  // 零依赖实现 dsh-sandbox-policy 的 setSandboxMode（等价：session.append('sandbox/mode', {mode})），
  // 只写 sandbox/mode 事件、不碰 approval/policy——避开「Full access 预设绑定 approval=never」的坑
  ctx.tools.register(defineTool({
    name: 'cybernetics_sandbox_mode',
    description: '切换当前会话的 DSH 文件沙箱模式（per-session 生效，重启后保留）：workspace-write=默认（可写工作区+临时区，工作区外写/删需批准）；danger-full-access=全部文件操作免沙箱拦截（任意目录可写，删除等不可逆命令仍由 dsh-approval-gate 批准门拦截）；read-only=所有变更被拒。模式不影响读取（读取始终无限制）。切换由用户明确确认后执行',
    parameters: {
      mode: { type: 'string', required: true, description: '目标沙箱模式：read-only / workspace-write / danger-full-access' },
    },
    output: {
      schema: { type: 'string', description: '切换结果' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const mode = input?.mode
      const VALID = ['read-only', 'workspace-write', 'danger-full-access']
      if (!VALID.includes(mode)) throw new Error(`invalid mode "${mode}": must be one of ${VALID.join(' / ')}`)
      const session = exec?.agent?.session
      if (!session) throw new Error('no session available to switch sandbox mode')
      session.append('sandbox/mode', { mode })
      const tip = mode === 'danger-full-access'
        ? '写全放开：任意目录可写（含 Obsidian 等工作区外）。删除/不可逆命令（rm/mv/shred/git push 等）仍由 dsh-approval-gate 批准门拦截，需用户批准。'
        : mode === 'workspace-write'
          ? '默认模式：可写工作区 + 临时区；工作区外写/删触发沙箱拒绝，可升级请求批准。'
          : '只读：所有文件变更被拒，读取不受影响。'
      logState({ ts: Date.now(), event: 'sandbox-mode-switch', sid: sidOf(exec), mode })
      return `[cybernetics] 会话沙箱模式已切换为 ${mode}\n${tip}`
    },
  }))

  // ---------- 7. 注册完成：A3 恢复 + boot 日志 ----------
  const recovered = recoverStateFromLog(500)
  logState({
    ts: Date.now(),
    event: 'boot',
    plugin: name,
    version: VERSION,
    mode: state.autoModeSeed,
    feedforwardRules: cfg.feedforward.length,
    maxToolCallsPerTurn: MODE_LIMITS[state.autoModeSeed],
    control: cfg.control,
    recovered: recovered ? state.recovered : null,
  })

  return { state, logState }
}

export default { name, inject, apply }
