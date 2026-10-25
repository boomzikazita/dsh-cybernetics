// dsh-cybernetics 控制律与状态回放（2026-10-25 从 index.js 下沉，verbatim）
// 工厂注入 apply 作用域依赖；返回全部控制器供钩子与工具共用
import { readFileSync, existsSync } from 'node:fs'
import { MODE_LIMITS, ema, adaptiveAlpha, detectOscillationPure, adjustControlPure, execArgsText, healthScorePure } from './core.mjs'

export function makeControl({ cfg, state, logState, logFile }) {
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

  return { pushResultBuf, queueWarn, currentMode, adjustControl, recoverStateFromLog, replayPHat, slowestTools, healthOf, matchFeedforward }
}
