// dsh-cybernetics 规则归一化 / 注入消息工厂 / 会话状态构造（2026-10-25 从 index.js 下沉，verbatim；模块预算 ≤500 治理）
import { randomUUID } from 'node:crypto'
import { DEFAULT_MODES, DEFAULT_FEEDFORWARD } from './core.mjs'

// ---------- 规则归一化 ----------
// 兼容两种配置来源：
//   默认格式  { id, tools?, pattern, action: { strategy, ... } }
//   patch 格式 { name, match: [...], action: 'retry+timeout' | 'dry-run+confirm' }
export function normalizeRule(rule) {
  const action = typeof rule.action === 'string' ? { strategy: rule.action } : (rule.action ?? {})
  return {
    id: rule.id ?? rule.name ?? 'rule',
    tools: Array.isArray(rule.tools) ? rule.tools : undefined,
    pattern: rule.pattern ?? (Array.isArray(rule.match) ? rule.match.join('|') : ''),
    action,
  }
}

export function normalizeFeedforward(list) {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_FEEDFORWARD
  return list.map(normalizeRule)
}

// modes 兼容：数值 { fast: 0.3 } 或 patch 对象 { fast: { zeta: 0.3, label } }；缺省用默认
export function normalizeModes(modes) {
  const out = {}
  for (const [k, v] of Object.entries(modes ?? {})) {
    out[k] = typeof v === 'object' && v !== null ? (v.zeta ?? 0.5) : v
  }
  return Object.keys(out).length ? out : { ...DEFAULT_MODES }
}

// ---------- 注入消息工厂（v0.2.1） ----------
// 优先宿主 @deepseek-ai/dsh-llm 的 createUserMessage；该裸导入在插件真实目录下可能解析不到
// （本机实测 ERR_MODULE_NOT_FOUND：/home/boom/dsh-plugins/node_modules/@deepseek-ai/ 只有
// dsh-tools），原实现把 import 放在 try 里静默吞掉 ⇒ 全部警告注入恒失效（9/9 dropped-warn）。
// 解析失败时按宿主 createMessage 的等价形态兜底（role/content/source/id + 冻结）。
let _createUserMessage = null // null=未探测 / function=宿主工厂 / false=不可用
let _injectFactoryWarned = false
export async function makeInjectedUserMessage({ text, kind }) {
  const content = [{ type: 'text', text }]
  if (_createUserMessage === null) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      _createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : false
    } catch {
      _createUserMessage = false
    }
  }
  if (typeof _createUserMessage === 'function') {
    return _createUserMessage({ content, source: { kind } })
  }
  if (!_injectFactoryWarned) {
    _injectFactoryWarned = true
    console.warn('[dsh-cybernetics] @deepseek-ai/dsh-llm 不可解析，注入消息走等价兜底形态（建议补 node_modules/@deepseek-ai/dsh-llm 软链）')
  }
  return Object.freeze({ id: randomUUID(), role: 'user', content, source: { kind } })
}

// ---------- 会话状态工厂（B7：每会话一份控制状态） ----------
export function createSessionState(sid, seed = {}) {
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
    currentTurn: null,         // v0.2.1：稳定阀按 turn 边界清零（原按 step 清零永不触发）
    sandboxMode: null,         // v0.2.1：本插件切过的沙箱档位（提权判定用；null=未知）
    recentCalls: [],           // 最近调用 { tool, hash, ts }（冗余/熵窗口）
    toolDurations: new Map(),  // B5 工具耗时 { tool → { totalMs, count } }
    sessionObserved: new Set(), // 本次会话实际调用过的工具（能观性分层依据）
    lastStartTs: 0,            // B5 最近一次 pre-execute 起点
    lastStartTool: '',
    failedHintSent: false,     // 连续失败→skill_search 兜底提示已注入标记（每轮重置）
  }
}
