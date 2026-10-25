/**
 * dsh-cybernetics — 控制论内核 v4 运行时（DeepSeek Harness 插件）
 *
 * v0.2.1（2026-10-15，修 6 处运行期缺陷）：
 *   1. 警告注入恒失效：@deepseek-ai/dsh-llm 裸导入在插件真实目录不可解析，且失败即整批丢弃
 *      → 等价兜底消息工厂 + 注入失败回队 + 留痕（原日志 9/9 dropped-warn）
 *   2. 稳定阀按 step 清零（`maxToolCallsPerTurn` 永不触发，22h 0 命中）→ 按 turn 边界清零；
 *      且 patch 基线原为死配置，现 patch 值优先（5→25）
 *   3. 前馈正则被 YAML 单引号写成双反斜杠（`test('git status')===false`，从未命中）→ 单反斜杠
 *   4. 沙箱提权无审批门（一次调用即可自我授予全盘写权）→ tools/pre-execute 返回 {kind:'ask'}
 *   5. agent/disposed 误用 waterfall 签名（emit 事件无 next，每次销毁抛错）→ emit 形态
 *   6. cybernetics_check 工具集取 agent scope ∪ 全局视图（原把可用的 grep 报成 missing）
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
import { normalizeFeedforward, normalizeModes, createSessionState, makeInjectedUserMessage } from './state.mjs'
import { makeControl } from './control.mjs'
import { registerCyberneticsTools } from './tools.mjs'

export const name = 'dsh-cybernetics'
export const inject = ['tools', 'agents']

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

  // ---------- 控制律与状态回放（2026-10-25 下沉 control.mjs，verbatim；模块预算治理） ----------
  const { pushResultBuf, queueWarn, currentMode, adjustControl, recoverStateFromLog, replayPHat, slowestTools, healthOf, matchFeedforward } = makeControl({ cfg, state, logState, logFile })

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

    // 沙箱提权门（v0.2.1 新增）
    // 原实现只写 sandbox/mode、无任何确认 ⇒ 一次工具调用即可自我授予 danger-full-access
    // （任意目录写），唯一约束是工具描述里那句"需用户确认"（提示词级，不可强制）。
    // 宿主的正规路径是逐操作的 sandbox_permissions 升级（要批准往返）。此处把提权挂进
    // 同一道宿主审批门：返回 {kind:'ask'} → ctx.approval.request → allowed-once 才执行。
    const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
    if (toolName === 'cybernetics_sandbox_mode') {
      const target = String(exec?.arguments?.mode ?? exec?.args?.mode ?? '')
      const rank = SANDBOX_RANK[target]
      const isEscalation = rank === 2 || (rank === 1 && s.sandboxMode === 'read-only')
      if (isEscalation) {
        logState({ ts: now, event: 'sandbox-mode-ask', sid, target })
        return {
          kind: 'ask',
          reason: `[沙箱提权] 请求把本会话文件沙箱切到 ${target}（任意目录可写）。请批准后再执行。`,
          displayReason: {
            en: `Escalate this session's file sandbox to ${target} (unrestricted writes)?`,
            zh: `确认把本会话文件沙箱提权到 ${target}（任意目录可写）？`,
          },
        }
      }
    }

    // 前馈：高风险/不可逆操作 → 批准门（dry-run+confirm）或放行+警告（retry+timeout）
    const hit = matchFeedforward(exec)
    if (hit) {
      state.feedforwardHits += 1
      const isAsk = hit.action.strategy === 'dry-run+confirm' // 不可逆操作：强制批准门
      if (!isAsk) state.feedforwardBlocks += 1
      if (isAsk) {
        // ask 分支会提前 return（走审批），单独留痕；放行分支则由下方统一的 pre-execute
        // 一条记录带 feedforward 字段，避免同一调用写两条 pre-execute。
        logState({ ts: now, event: 'feedforward-ask', sid, tool: toolName, feedforward: hit.id, strategy: hit.action.strategy })
      }
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
      // v0.2.1：这里不再 `return next()`——放行后继续走稳定阀/耗时起点/exec.__cyber 配对，
      // 否则该次调用缺 exec.__cyber，result 迟到时会与下一次调用错配（B5 配对失效）。
    }

    // 稳定阀（本轮窗口，会话级）：超限降级为警告，交互/观测工具豁免
    const modeNow = currentMode(s)
    // v0.2.1：配置优先级修正——原 `MODE_LIMITS[modeNow] ?? cfg.stability.maxToolCallsPerTurn`
    // 中 MODE_LIMITS 覆盖三档全部取值 ⇒ patch 里的 maxToolCallsPerTurn 是**死配置**。
    // 现改为：patch 显式配置优先，未配时回落到档位表（fast 5 / deep 4 / conservative 3）。
    // 注：窗口已修正为按 turn 计数，故 patch 侧基线调成 25（见 cordis.patch.yml 注释）。
    const maxPerTurn = cfg.stability.maxToolCallsPerTurn ?? MODE_LIMITS[modeNow] ?? 5
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
      ...(hit ? { feedforward: hit.id, strategy: hit.action.strategy } : {}),
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
        // v0.2.1：稳定阀窗口修正——原实现每次 pre-step（**每个 step 都触发**）无条件清零，
        // 计数只能覆盖单次模型回复内的并行调用（通常 ≤5），`maxToolCallsPerTurn: 5`
        // 永远够不到（22h/516 次调用 stability-warn 0 次）。改为**按 turn 边界**清零。
        const turn = payload?.turn
        if (turn === undefined || s.currentTurn !== turn) {
          if (turn !== undefined) s.currentTurn = turn
          s.toolCallsInTurn = 0
          s.warnedOverLimit = false
        }
        s.failedHintSent = false // 连续失败兜底提示每轮允许重新触发
        if (s.pendingWarns.length === 0) return decision
        const warns = s.pendingWarns
        s.pendingWarns = []
        try {
          const msg = await makeInjectedUserMessage({
            text: warns.join('\n'),
            kind: 'plugin:dsh-cybernetics',
          })
          return { ...decision, messages: [...decision.messages, msg] }
        } catch (e) {
          // C11：注入失败留痕 + v0.2.1 整批回队（原实现只在日志留痕，警告仍被丢弃且无重试）
          s.pendingWarns.unshift(...warns)
          logState({ ts: Date.now(), event: 'dropped-warn', sid, count: warns.length, error: String(e?.message || e) })
          return decision
        }
      })
    } catch { /* pre-step 不可用则跳过 */ }
  }

  // ---------- 3c. agent/disposed：会话汇总（B6，供周检 automation / 复盘消费） ----------
  // v0.2.1：`agent/disposed` 是 @mode emit（不是 waterfall），监听器只收到 `{agent}`，
  // 原实现签名 `({agent}, next) => { …; return next() }` 每次销毁都抛 TypeError
  // （被宿主吞掉记 warn）。emit 形态不调 next。
  if (typeof ctx.on === 'function' && ctx.agents) {
    try {
      ctx.on('agent/disposed', ({ agent }) => {
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
      })
    } catch { /* disposed 不可用则跳过 */ }
  }

  // ---------- 4. 工具注册（2026-10-25 下沉 tools.mjs，snap/status/check/sandbox_mode 4 工具 verbatim） ----------
  registerCyberneticsTools(ctx, { cfg, state, logState, sessionOf, sidOf, logFile, replayPHat, slowestTools, healthOf })

  // ---------- 7. 注册完成：A3 恢复 + boot 日志 ----------
  const recovered = recoverStateFromLog(500)
  logState({
    ts: Date.now(),
    event: 'boot',
    plugin: name,
    version: VERSION,
    mode: state.autoModeSeed,
    feedforwardRules: cfg.feedforward.length,
    // v0.2.1：打印**生效值**（patch 基线优先，回落档位表）——原来打印 MODE_LIMITS，
    // 与稳定阀实际使用值不一致（日志显示 5，实际用 patch 的 25）。
    maxToolCallsPerTurn: cfg.stability.maxToolCallsPerTurn ?? MODE_LIMITS[state.autoModeSeed],
    control: cfg.control,
    recovered: recovered ? state.recovered : null,
  })

  return { state, logState }
}

export default { name, inject, apply }
