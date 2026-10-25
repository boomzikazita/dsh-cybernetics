// dsh-cybernetics 工具注册（2026-10-25 从 index.js 下沉，4 个 defineTool verbatim）
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODE_LIMITS } from './core.mjs'

export function registerCyberneticsTools(ctx, d) {
  const { cfg, state, logState, sessionOf, sidOf, logFile, replayPHat, slowestTools, healthOf } = d

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
      // 可用工具集（v0.2.1 修正）：`ctx.tools.schemas(scope)` 的 scope 语义是"查看作用域"，
      // 省略 scope 时在插件上下文里只拿到很窄的一层（实测漏掉 grep/glob 等宿主工具，
      // 于是 cybernetics_check 把明明可用的 grep 报成 missing → 误判 not-controllable）。
      // 改为：agent scope 视图 ∪ 全局视图 ∪ 被动观测 ∪ 插件自身注册，取并集（保守：宁可多认）。
      const collect = (scope) => {
        try {
          const list = ctx.tools?.schemas?.(scope)
          return Array.isArray(list) ? list.map((t) => t.name).filter(Boolean) : []
        } catch {
          return []
        }
      }
      const pluginTools = [...new Set([...collect(exec?.agent), ...collect(undefined)])]
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
  // 只写 sandbox/mode 事件、不碰 approval/policy——避开「Full access 预设绑定 approval=never」的坑。
  // v0.2.1：**提权改为走宿主审批门**（tools/pre-execute 对该工具返回 {kind:'ask'}）——
  // 原实现无任何确认，一次调用即可自我授予全盘写权；描述里"由 dsh-approval-gate 拦截"是
  // 不存在的组件（本机无此包，仅 ~/.dsh.sealed 有 hermes 时代封存副本），已删该保证。
  ctx.tools.register(defineTool({
    name: 'cybernetics_sandbox_mode',
    description: '切换当前会话的 DSH 文件沙箱模式（per-session 生效，重启后保留）：workspace-write=默认（可写工作区+临时区，工作区外写/删需批准）；danger-full-access=全部文件操作免沙箱拦截（任意目录可写，读取不受限）；read-only=所有变更被拒。**提权（danger-full-access，或从 read-only 升到 workspace-write）会触发宿主审批门，需你批准后才生效；降级立即生效。**',
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
      // 记录档位（提权判定用；本插件重启后由 sandbox/mode 事件回放决定实际模式）
      try { sessionOf(exec).sandboxMode = mode } catch { /* 状态不可用不影响切换 */ }
      const tip = mode === 'danger-full-access'
        ? '写全放开：任意目录可写（含 Obsidian 等工作区外）。注意：本机并无 dsh-approval-gate 组件，rm/mv/shred 等破坏性命令**不**会被该门拦截；本插件只对"提权到这个档位"这一步做了审批。'
        : mode === 'workspace-write'
          ? '默认模式：可写工作区 + 临时区；工作区外写/删触发沙箱拒绝，可升级请求批准。'
          : '只读：所有文件变更被拒，读取不受影响。'
      logState({ ts: Date.now(), event: 'sandbox-mode-switch', sid: sidOf(exec), mode })
      return `[cybernetics] 会话沙箱模式已切换为 ${mode}\n${tip}`
    },
  }))

}
