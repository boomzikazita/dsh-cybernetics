# dsh-cybernetics

A **cybernetic control kernel runtime** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH). It wraps an agent session in a classical closed-loop control system — observer, feedforward controller, feedback correction, and actuators — so the harness can watch its own tool-call behavior, detect instability (divergence, oscillation, redundant calls, tool-stuck loops), and adapt its own operating mode in real time.

Implemented as a Cordis plugin (pure ESM) and informed by classical engineering cybernetics (*Engineering Cybernetics*, Tsien Hsue-shen & Song Jian, 3rd ed.).

> 中文简介：dsh-cybernetics 是一个面向 DeepSeek Harness 的「控制论内核」运行时插件，用经典控制回路（观测器 / 前馈控制 / 反馈校正 / 执行器）让智能体自我观测、自我诊断并自适应调节运行档位。源码注释含中文，功能文档以英文为准。

## Features

- **Observer** — per-session in-memory state plus JSONL persistence (`~/.dsh/cybernetics/state_log.ndjson`); `pHat` and the current mode survive restarts via boot-time log replay.
- **Feedforward control** — `tools/pre-execute` rule table with tool-name whitelists and argument regexes. Destructive commands are routed through an approval gate (`dry-run+confirm`); flaky network commands are logged and warned (`retry+timeout`).
- **Feedback correction** — `tools/result` events feed a delta signal (0 = success, 1 = failure) through an EMA filter that estimates the failure rate `pHat`; a hysteresis control law then adapts the operating mode (`fast → deep → conservative`).
- **Instability detection** — divergence (consecutive failures), oscillation (high 0/1 flip rate), redundant calls (parameter-text hash), low tool-distribution entropy (loop / tunnel-vision signal), slow-tool TOP3, and observation completeness.
- **Health score** — 0–100 synthesized from success rate, observation completeness, redundancy, divergence, and oscillation.
- **Controllability self-check** — given a goal and its required tools, compare against the available tool set (plugin tools ∪ observed host tools) and return `controllable` / `not-controllable` with advice.
- **Sandbox mode actuator** — switch the session's file-sandbox mode at runtime (`read-only` / `workspace-write` / `danger-full-access`).

## Provided tools

| Tool | Description |
|------|-------------|
| `cybernetics_snap` | Write the current kernel state (in-memory state + feedforward rule summary + mode) to the state log and return a summary. `mode` temporarily switches mode (`fast`/`deep`/`conservative`; auto-reverts to adaptive after 60 s). |
| `cybernetics_status` | Read the last N state-log entries and summarize: tool call counts, delta mean, `pHat`, mode, divergence/oscillation, redundant calls, entropy, observation rate, health score. |
| `cybernetics_check` | Controllability self-check: goal + required tools vs currently available tools → `missing` / `controllable` / `advice`. |
| `cybernetics_sandbox_mode` | Switch the current session's file sandbox mode (`read-only` / `workspace-write` / `danger-full-access`); runs only after explicit user confirmation. |

## Installation

```bash
dsh plugin --profile web add github:boomzikazita/dsh-cybernetics
```

Or install from a local bundle directory:

```bash
dsh plugin --profile web add /path/to/dsh-cybernetics
```

> **Important**: the plugin's `node_modules` must be symlinked to the global DSH host (`ln -s $DSH_NODE_MODULES node_modules`). Do **not** install its dependencies yourself (e.g. with pnpm) — a second copy of `@deepseek-ai/dsh-tools` breaks the module-level `TOOL_RUNTIME_SCHEDULER` symbol and crashes all tool scheduling.

## Configuration

The bundle ships its own default patch (`cordis.patch.yml`). To customize, override the plugin entry in your profile:

```yaml
# append to ~/.dsh/profiles/web/cordis.patch.yml (or headless)
- insert:
    - id: cybernetics
      name: 'dsh-cybernetics'
      config:
        stateLog: '~/.dsh/cybernetics/state_log.ndjson'
        feedforward:
          - id: 'network-unstable'
            tools: ['bash']
            pattern: '\\b(git|npm|curl|wget|pnpm)\\b'
            action: { strategy: 'retry+timeout', retry: 2, timeout: 30000 }
          - id: 'irreversible-write'
            tools: ['bash']
            pattern: '\\b(rm|mv|rmdir|shred)\\b|git (push|reset --hard|clean)'
            action: { strategy: 'dry-run+confirm', dryRun: true, confirm: true }
        stability:
          maxToolCallsPerTurn: 5
        modes:
          fast: { label: '快速响应', zeta: 0.3 }
          deep: { label: '深度分析', zeta: 0.7 }
          conservative: { label: '保守稳定', zeta: 1.2 }
```

### Control parameters (all configurable under `control`)

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `alpha` | 0.2 | EMA smoothing coefficient |
| `escalateAt` / `deescalateAt` | 0.6 / 0.15 | `pHat` thresholds for mode up-shift / down-shift |
| `deescalateStreak` | 5 | consecutive low-`pHat` runs required to down-shift (hysteresis) |
| `divergenceStreak` | 3 | consecutive failures to flag divergence |
| `oscillationWindow` / `oscillationRatio` | 10 / 0.7 | oscillation detection window / flip ratio |
| `redundantWindow` | 20 | redundancy / entropy window |
| `entropyWarnAt` / `entropyRecoverAt` | 1.0 / 1.5 | low-entropy warn / recover thresholds (hysteresis) |

Mode → per-turn tool-call stability limits: `fast: 5` / `deep: 4` / `conservative: 3` (higher mode = tighter).

## How the control loop works

Classical negative-feedback loop:

1. **Observe** — every tool call is recorded per session. On boot, the JSONL log is replayed to restore `pHat` and the mode, so the kernel does not "forget" across restarts.
2. **Feedforward** — before a tool runs, rules can force an approval gate (destructive / irreversible ops) or attach a warning (flaky network commands), instead of reacting only after failure.
3. **Feedback** — each `tools/result` yields `delta` (0 success / 1 failure); EMA estimates `pHat`; the control law (with hysteresis + debounce) shifts modes; divergence and oscillation are flagged and warnings are queued.
4. **Actuate** — warnings are injected into the next agent request (`agent/pre-step`); the four `cybernetics_*` tools let the agent or a human inspect and steer the kernel; `agent/disposed` emits a per-session summary event for downstream review automations.

## Development

```bash
node --check index.js && node --check core.mjs   # syntax check
node --test test/cybernetics.test.mjs            # unit tests (11 cases)
```

`core.mjs` contains the pure control-law functions (EMA, hysteresis, oscillation/entropy/health-score, error classification) with no Node side effects and no external dependencies, so they are directly unit-testable with `node:test`.

## License

MIT © 2026 [boomzikazita](https://github.com/boomzikazita)
