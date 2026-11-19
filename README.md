# @local/dsh-agy-progress

English | [简体中文](./README.zh.md)

An **Antigravity (`agy`)-exclusive** DeepSeek Harness enhancement bundle that gently nudges Gemini models to share concise mid-task progress commentary alongside tool calls — giving Gemini the same transparent, collaborative status updates as GPT-6 without interrupting tool loops or invalidating thought-signature caches.

---

## Empirical Cadence Calibration (60 Codex + 30 Agy Trajectories)

Thresholds were calibrated against 60 real OpenAI Codex CLI (`0.164.0`) trajectories (`gpt-6-luna` + `gpt-6.1-sol`) and 30 real Antigravity (`agy 1.5.9`, `gemini-4-hydrogen`) trajectories on the exact same FrontierHarness tasks:
- **GPT-6 in Codex**: 100% opening preamble on multi-step tasks, followed by steady mid-task commentary at a **median interval of `65.0s`** (`5` steps).
- **Gemini in Agy**: `0.47%` natural mid-task commentary (`6/1,290` tool steps), while running rapid fine-grained steps (**median `6.0s` per step**, `34.5` steps per task).

To match GPT-6's natural cadence without spamming fast file reads, `@local/dsh-agy-progress` uses a **two-stage policy**:
1. **Stage 1 — Opening Update** (before any visible update in the current user prompt segment):
   - Triggers after **`>= 2` silent tool steps AND `>= 10s` elapsed** (skips trivial <10s Q&A; delivers the first status + plan update at a median of `14s`).
2. **Stage 2 — Mid-Task Steady Cadence** (after >= 1 update or nudge):
   - **Time-led**: `>= 65s` elapsed since last visible update (with `>= 2` silent tool steps);
   - **Step-cap fallback**: `>= 10` consecutive silent tool steps AND `>= 45s` elapsed;
   - Produces a **median mid-task update interval of `73s` (`6` steps)** across the 30 Agy trajectories.
3. **Dual Anti-Spam Cooldown**:
   - If a nudge goes unanswered, waits at least **`4` steps AND `30s`** before nudging again.

---

## Key Guarantees

- **Zero Premature Stops**: Explicitly instructs Gemini to include 1–2 concise sentences of visible text **in the exact same response as its next tool call(s)**, forbidding tool-loop interruption or `ask_user` / `send_message` calls.
- **100% `reasoning_opaque` / Prompt Cache Safe**: Uses the exact `The following is a <SYSTEM_MESSAGE>...` envelope recognized by `@local/dsh-agy-mode`'s `envelopes.js` and `wire-bridge.js`.
- **Strictly Scoped to `Antigravity` (`agy`)**:
  - Other presets (`Standard`, `Creator`, `Codex`) and all child subagents (`invoke_subagent` / `run_swarm`) are 100% untouched.
  - Adds a compact **`进展播报 / Updates`** switch pill in the composer toolbar (`conversation.input.left`) and `/agy-progress [on|off|status]` slash command **only** inside `Antigravity` sessions.
- **Clean Chat History**: Recorded with `source: { kind: 'agy-progress', form: 'notice', summary: '...' }`, collapsing into a neat one-line context disclosure row in DSH Web UI.

---

## Installation & Usage

Requires [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode) (`preset-agy`) installed in your DeepSeek Harness `web` profile:

```bash
git clone https://github.com/TideDra/dsh-agy-progress.git
dsh plugin --profile web add /path/to/dsh-agy-progress
```

Once installed:
1. Open any **`Antigravity`** (`agy`) session in DSH Web UI (including Gemini sessions routed via [`dsh-auto-mode`](https://github.com/TideDra/dsh-auto-mode)).
2. The **`💬 Updates / 进展播报`** pill switch appears in the bottom-left composer bar (enabled by default). Click it — or run `/agy-progress [on|off|status]` — anytime to toggle or inspect live step counters.

---

## Configuration (`cordis.patch.yml`)

| Field | Default | Description |
| :--- | :---: | :--- |
| `defaultEnabled` | `true` | Initial state of progress updates for new `agy` sessions |
| `targetPreset` | `'agy'` | Only sessions running this preset are eligible |
| `modelPattern` | `'gemini'` | Case-insensitive regex matching target model IDs |
| `firstUpdateStepThreshold` | `2` | Stage-1 opening silent tool-step threshold |
| `firstUpdateMinSeconds` | `10` | Stage-1 opening minimum elapsed seconds |
| `silentElapsedSeconds` | `65` | Stage-2 time-led elapsed seconds threshold |
| `minSilentStepsForTimeNudge` | `2` | Minimum silent tool steps required for Stage-2 time nudge |
| `silentStepThreshold` | `10` | Stage-2 step-cap fallback threshold |
| `stepMinElapsedSeconds` | `45` | Minimum elapsed seconds required for Stage-2 step-cap fallback |
| `cooldownSteps` | `4` | Post-nudge cooldown step count |
| `cooldownSeconds` | `30` | Post-nudge cooldown elapsed seconds |
| `followUserLanguage` | `true` | Automatically match Chinese vs. English user prompts |

---

## Verification

```bash
npm test
```

## License

[MIT](./LICENSE)
