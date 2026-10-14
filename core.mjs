/**
 * dsh-cybernetics core — 纯函数控制律内核（v4.2）
 *
 * 与插件 index.js 分离，无 Node 副作用、无外部依赖，可被 node:test 直接测试，
 * 也可被其他工具（周检 automation、observer 脚本）复用。
 * 控制回路的数据结构/副作用（state、hooks、日志）留在 index.js。
 *
 * v0.2.0（2026-10-14，规则收敛）：
 *   DEFAULT_FEEDFORWARD 清空——irreversible-write 等不可逆拦截规则移交
 *   dsh-approval-gate（rules.json 内置 deny 段），cybernetics 不再持有拦截类规则；
 *   retry/timeout 类「放行+警告」规则由 cordis.patch.yml 的 feedforward 配置按需下发。
 *
 * v4.2（2026-08-19）：
 *   A1 冗余 hash 改用参数文本（exec.arguments），修复 rc.6 下 exec.args 恒 undefined
 *      导致的同工具全判"同参数重复"假冗余。
 *   C13 健康评分、B4 熵阈值等纯逻辑下沉到此处。
 */

export const VERSION = 'v4.4'

// 档位 → 阻尼系数 zeta（速度-稳定权衡；保留默认，patch 可覆盖）
export const DEFAULT_MODES = { fast: 0.3, deep: 0.7, conservative: 1.2 }

export const MODE_ORDER = ['fast', 'deep', 'conservative']

// 档位 → 稳定阀阈值（档位越高越收紧；对照第5章 控制装置参数选择）
export const MODE_LIMITS = { fast: 5, deep: 4, conservative: 3 }

export const DEFAULT_FEEDFORWARD = [
  // v0.2.0（2026-10-14 规则收敛）：irreversible-write 拦截规则移交 dsh-approval-gate，
  // 本表默认清空；retry/timeout 类「放行+警告」规则由 cordis.patch.yml 按需配置。
  // 更早历史：network-unstable（git/npm/curl/wget/pnpm 拦截）已于 2026-08-18 移除；
  // 2026-08-20 周检扰动入库（插件加载失败 → systemd 重启风暴）落地为 dsh-web.service
  // ExecStartPre 启动前自检（~/.dsh/scripts/dsh_prestart_check.sh）。
]

/**
 * EMA 一阶递归滤波（P1-1，对照 15.11 递推滤波工程简化）：
 * pHat = (1-α)·pHat + α·delta；delta=1 失败 / 0 成功。
 */
export function ema(prev, delta, alpha = 0.2) {
  return (1 - alpha) * prev + alpha * delta
}

/**
 * 自适应增益（v4.3，对照 15.11 卡尔曼自适应增益的工程简化）：
 * 固定 α 的缺陷——α 小（滤波强）则失败率突变时响应慢，α 大则偶发失败抖动。
 * 解法：连续失败（divergenceStreak ≥ 阈值）时用大 α 快速跟上现实，否则用小 α 强滤波抗抖动。
 * 返回当前应使用的滤波系数 α。
 */
export function adaptiveAlpha(divergenceStreak, { alphaLow = 0.15, alphaHigh = 0.5, divergenceStreak: divReq = 2 } = {}) {
  return divergenceStreak >= divReq ? alphaHigh : alphaLow
}

/**
 * 振荡检测（纯）：窗口内 0/1 翻转率 ≥ ratio 判振荡（P1-2，对照 7.3 周期运动稳定性）。
 * 与发散（连续失败）区分：振荡要"降耦合"，发散要"查根因"。
 */
export function detectOscillationPure(buf, ratio = 0.7) {
  if (!Array.isArray(buf) || buf.length < 6) return false
  let flips = 0
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== buf[i - 1]) flips++
  }
  return flips / (buf.length - 1) >= ratio
}

/**
 * 滞环控制律（纯，P0-1 负反馈 + 滞环防抖；v4.3 发散直通升档 + 升档对称防抖）：
 * 输入当前 pHat/档位/降档防抖/升档防抖/发散计数 → 输出目标档位与迁移标记。不产生副作用，
 * 是否写日志/发警告由调用方决定。
 *
 * v4.3 修订（对照实测）：
 *  - 发散（连续失败 divergenceStreak ≥ 阈值）是强信号，直接升档，不依赖 pHat——
 *    修复"连续失败告警了但 pHat 卡在 0.488 推不动档位"的解耦缺陷。
 *  - 升档加对称防抖（escalateStreak ≥ 阈值才升）——修复"突发失败→瞬间升到顶→快速降回"的档位抖动。
 *
 * 返回 { autoMode, deescalateStreak, escalateStreak, escalated, deescalated }
 */
export function adjustControlPure({ pHat, autoMode, deescalateStreak = 0, escalateStreak = 0, divergenceStreak = 0, control }) {
  const {
    escalateAt = 0.6,
    deescalateAt = 0.15,
    deescalateStreak: dsReq = 5,
    escalateStreak: esReq = 3,
    divergenceStreak: divReq = 3,
  } = control
  let next = autoMode
  let newDs = deescalateStreak
  let newEs = escalateStreak
  let escalated = false
  let deescalated = false

  const divergent = divergenceStreak >= divReq // 发散：连续失败，强信号
  const phHigh = pHat >= escalateAt            // 失败率高
  const phLow = pHat <= deescalateAt           // 失败率低

  if (autoMode !== 'conservative' && (divergent || phHigh)) {
    newDs = 0
    // 发散直接升档（连续失败 divReq 次本身即是防抖）；pHat 高需连续 esReq 次防抖
    if (divergent || newEs + 1 >= esReq) {
      next = MODE_ORDER[Math.min(MODE_ORDER.indexOf(autoMode) + 1, MODE_ORDER.length - 1)]
      escalated = true
      newEs = 0
    } else {
      newEs += 1
    }
  } else if (autoMode !== 'fast' && phLow) {
    newEs = 0
    newDs += 1
    if (newDs >= dsReq) {
      next = MODE_ORDER[Math.max(MODE_ORDER.indexOf(autoMode) - 1, 0)]
      deescalated = true
      newDs = 0
    }
  } else {
    newEs = 0
    newDs = 0
  }
  return { autoMode: next, deescalateStreak: newDs, escalateStreak: newEs, escalated, deescalated }
}

/** 参数文本提取（A1）：rc.6 参数字段为 arguments，兼容旧字段名 args 兜底 */
export function execArgsText(exec) {
  try {
    const raw = exec?.arguments ?? exec?.args ?? ''
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return ''
  }
}

/** 稳定的对象序列化（键排序），供冗余 hash / 去重使用 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * 冗余调用 hash（A1 修复）：
 * 旧实现用 exec?.args（rc.6 中恒为 undefined）→ hash 退化为「工具名|''」，
 * 同一工具的所有调用都被判为"同参数重复"→ 假冗余刷屏。
 * 修复：hash 基于参数文本（execArgsText，arguments 优先）。
 */
export function redundantHash(toolName, exec) {
  return `${toolName}|${stableStringify(execArgsText(exec))}`
}

/** 工具分布香农熵（纯，P2 对照 20.2）：calls: [{ tool }]；0=单一化，log2(n)=均匀 */
export function computeEntropyPure(calls) {
  const counts = new Map()
  for (const c of calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (!total) return 0
  const h = -[...counts.values()].reduce((acc, n) => {
    const p = n / total
    return acc + (p > 0 ? p * Math.log2(p) : 0)
  }, 0)
  return h === 0 ? 0 : h // 单一工具时结果为 -0，规范为 +0
}

/**
 * 健康评分（纯，C13，0-100）：
 *   基线 = 成功率（pHat 反比）×100；观测不完整扣 (1-obs)×20；冗余扣 red×10；
 *   发散/振荡各 -10。全失败 → 0，全成功 → 100。
 * 供 cybernetics_status / snap 与周检 automation 直接消费。
 */
export function healthScorePure({ pHat = 0, observationRate = 1, redundantRate = 0, divergence = false, oscillation = false }) {
  const p = Math.min(1, Math.max(0, pHat))
  const obs = Math.min(1, Math.max(0, Number.isFinite(observationRate) ? observationRate : 1))
  const red = Math.min(1, Math.max(0, redundantRate))
  let score = (1 - p) * 100 - (1 - obs) * 20 - red * 10
  if (divergence) score -= 10
  if (oscillation) score -= 10
  return Math.max(0, Math.min(100, Math.round(score)))
}

/**
 * 工具失败归类（纯，2026-08-19 方案 B：给周检装"显微镜"）。
 * 输入 tools/result 的 result payload（dsh-tools 结构）：
 *   错误: { isError: true, error: { message, info?: { name, code } } }
 *   info.code 来自 HarnessError 子类（如 FsError 的 FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT / FS_SANDBOX_DENIED）。
 * 返回 { errorType, errMsg } 或 null（成功时）。errMsg 截断 120 字符防日志膨胀。
 */
export function classifyToolError(result, maxMsg = 120) {
  if (!result || result.isError !== true) return null
  const error = result.error ?? {}
  const info = error.info ?? {}
  const message = typeof error.message === 'string' ? error.message : ''
  const code = typeof info.code === 'string' ? info.code : ''
  // 1) 有结构化 code（FsError/HarnessError）→ 直接使用
  if (code) {
    return { errorType: code, errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
  }
  // 2) 无 code：按消息模式归类到粗类
  const lower = message.toLowerCase()
  const patterns = [
    ['sandbox-denied', /sandbox|denied|permission/i],
    ['not-found', /does not exist|not found|enoent/i],
    ['edit-no-match', /did not appear verbatim|no replacement was performed/i],
    ['edit-ambiguous', /multiple occurrences|not unique|ambiguous/i],
    ['network', /econn|etimedout|network|socket/i],
    ['param-invalid', /required|must be|invalid/i],
    ['timeout', /timeout|timed out/i],
  ]
  for (const [type, re] of patterns) {
    if (re.test(lower)) return { errorType: type, errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
  }
  return { errorType: 'other', errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
}
