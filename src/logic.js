export const PROJECTION_KEY = 'agyProgress'
export const COMMAND_NAME = 'agy-progress'
export const PLUGIN_SOURCE_NAME = 'agy-progress'

const USER_REQ_OPEN_TAG = '<USER_REQUEST>\n'
const USER_REQ_CLOSE_TAG = '\n</USER_REQUEST>'
const META_OPEN_TAG = '\n<ADDITIONAL_METADATA>\n'

/**
 * Format an ISO-8601 timestamp with local numeric timezone offset matching `agy 1.5.9`.
 * @param {Date} [date]
 */
export function formatAgyIsoTimestamp(date = new Date()) {
  const pad2 = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const tzMin = -date.getTimezoneOffset()
  const sign = tzMin >= 0 ? '+' : '-'
  const absMin = Math.abs(tzMin)
  const offsetH = pad2(Math.floor(absMin / 60))
  const offsetM = pad2(absMin % 60)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${offsetH}:${offsetM}`
  )
}

/**
 * Normalize raw plugin configuration with safe defaults calibrated on 60 Codex + 30 Agy trajectories:
 * - Stage 1 (Opening update before any visible output in the turn):
 *   `firstUpdateStepThreshold` = 2 silent steps AND `firstUpdateMinSeconds` = 10s
 *   (or >= 1 silent step AND >= `silentElapsedSeconds` 65s).
 * - Stage 2 (Mid-task steady cadence after >= 1 update or nudge in the turn):
 *   Time-led: >= `minSilentStepsForTimeNudge` (2) silent steps AND >= `silentElapsedSeconds` (65s);
 *   Step-cap fallback: >= `silentStepThreshold` (10) silent steps AND >= `stepMinElapsedSeconds` (45s).
 * - Post-nudge anti-spam cooldown:
 *   >= `cooldownSteps` (4) silent steps AND >= `cooldownSeconds` (30s) if a prior nudge went unanswered.
 *
 * @param {Record<string, unknown>} [raw]
 */
export function normalizeAgyProgressConfig(raw = {}) {
  const firstUpdateStepThreshold =
    Number.isInteger(raw.firstUpdateStepThreshold) && raw.firstUpdateStepThreshold >= 1
      ? raw.firstUpdateStepThreshold
      : 2
  const firstUpdateMinSeconds =
    typeof raw.firstUpdateMinSeconds === 'number' &&
    Number.isFinite(raw.firstUpdateMinSeconds) &&
    raw.firstUpdateMinSeconds >= 0
      ? raw.firstUpdateMinSeconds
      : 10
  const silentElapsedSeconds =
    typeof raw.silentElapsedSeconds === 'number' &&
    Number.isFinite(raw.silentElapsedSeconds) &&
    raw.silentElapsedSeconds >= 5
      ? raw.silentElapsedSeconds
      : 65
  const minSilentStepsForTimeNudge =
    Number.isInteger(raw.minSilentStepsForTimeNudge) && raw.minSilentStepsForTimeNudge >= 1
      ? raw.minSilentStepsForTimeNudge
      : 2
  const silentStepThreshold =
    Number.isInteger(raw.silentStepThreshold) && raw.silentStepThreshold >= 1
      ? raw.silentStepThreshold
      : 10
  const stepMinElapsedSeconds =
    typeof raw.stepMinElapsedSeconds === 'number' &&
    Number.isFinite(raw.stepMinElapsedSeconds) &&
    raw.stepMinElapsedSeconds >= 0
      ? raw.stepMinElapsedSeconds
      : 45
  const cooldownSteps =
    Number.isInteger(raw.cooldownSteps) && raw.cooldownSteps >= 1
      ? raw.cooldownSteps
      : 4
  const cooldownSeconds =
    typeof raw.cooldownSeconds === 'number' &&
    Number.isFinite(raw.cooldownSeconds) &&
    raw.cooldownSeconds >= 0
      ? raw.cooldownSeconds
      : 30

  return {
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : true,
    targetPreset:
      typeof raw.targetPreset === 'string' && raw.targetPreset.trim().length > 0
        ? raw.targetPreset.trim()
        : 'agy',
    modelPattern:
      typeof raw.modelPattern === 'string' && raw.modelPattern.trim().length > 0
        ? raw.modelPattern.trim()
        : 'gemini',
    firstUpdateStepThreshold,
    firstUpdateMinSeconds,
    silentElapsedSeconds,
    minSilentStepsForTimeNudge,
    silentStepThreshold,
    stepMinElapsedSeconds,
    cooldownSteps,
    cooldownSeconds,
    followUserLanguage: typeof raw.followUserLanguage === 'boolean' ? raw.followUserLanguage : true,
  }
}

/**
 * Parse `/agy-progress` command arguments.
 * @param {string | undefined} rawArgs
 * @returns {'on' | 'off' | 'toggle' | 'status' | 'invalid'}
 */
export function parseProgressCommandAction(rawArgs) {
  const token = String(rawArgs ?? '').trim().toLowerCase()
  if (token === '' || token === 'toggle') return 'toggle'
  if (token === 'on' || token === 'enable' || token === 'true' || token === '1') return 'on'
  if (token === 'off' || token === 'disable' || token === 'false' || token === '0') return 'off'
  if (token === 'status') return 'status'
  return 'invalid'
}

/**
 * Extract the inner human text from a raw or `<USER_REQUEST>`-wrapped prompt so language
 * detection inspects only what the user actually wrote (ignoring English `<ADDITIONAL_METADATA>`).
 * @param {string} text
 */
export function extractRawUserText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  if (!text.startsWith(USER_REQ_OPEN_TAG)) return text
  const metaStart = text.lastIndexOf(META_OPEN_TAG)
  if (metaStart < USER_REQ_OPEN_TAG.length) return text
  const bodyEnd = metaStart - USER_REQ_CLOSE_TAG.length
  if (bodyEnd >= USER_REQ_OPEN_TAG.length && text.slice(bodyEnd, metaStart) === USER_REQ_CLOSE_TAG) {
    return text.slice(USER_REQ_OPEN_TAG.length, bodyEnd)
  }
  return text
}

/**
 * Detect whether the user's prompt primarily uses Chinese characters (`'zh'`) or English/other (`'en'`).
 * @param {string} rawUserText
 * @returns {'zh' | 'en'}
 */
export function detectPromptLanguage(rawUserText) {
  const cleaned = extractRawUserText(rawUserText)
  if (!cleaned) return 'en'
  const cjkMatches = cleaned.match(/[\u4e00-\u9fff]/gu)
  return cjkMatches && cjkMatches.length >= 2 ? 'zh' : 'en'
}

/**
 * Create the initial durable projection state for a session (`stateVersion: 2`).
 * @param {boolean} defaultEnabled
 */
export function createInitialProgressState(defaultEnabled = true) {
  return {
    enabled: Boolean(defaultEnabled),
    pendingCommand: null,
    inTurn: false,
    hasSpokenInSegment: false,
    silentToolSteps: 0,
    stepsSinceLastNudge: null,
    lastNudgeAt: null,
    lastVisibleAt: null,
    nudgeCountInTurn: 0,
    userLang: 'zh',
  }
}

/**
 * Pure, deterministic session-event fold for `ctx.sessionProjections`.
 * Returns the exact input `state` reference whenever an event leaves all fields unchanged.
 */
export function applyProgressEvent(state, event) {
  if (!event || typeof event !== 'object') return state

  if (event.type === 'command/run' && event.data?.name === COMMAND_NAME) {
    const action = parseProgressCommandAction(event.data.args)
    if (action === 'status' || action === 'invalid') return state
    const currentEffective = state.pendingCommand?.nextEnabled ?? state.enabled
    const nextEnabled =
      action === 'on' ? true : action === 'off' ? false : !currentEffective
    return {
      ...state,
      pendingCommand: {
        commandId: String(event.data.commandId),
        nextEnabled,
      },
    }
  }

  if (
    event.type === 'command/done' &&
    state.pendingCommand !== null &&
    String(event.data?.commandId) === state.pendingCommand.commandId
  ) {
    if (event.data?.kind === 'success') {
      return {
        ...state,
        enabled: state.pendingCommand.nextEnabled,
        pendingCommand: null,
      }
    }
    return {
      ...state,
      pendingCommand: null,
    }
  }

  if (event.type === 'turn/start') {
    return {
      ...state,
      inTurn: true,
      hasSpokenInSegment: false,
      silentToolSteps: 0,
      stepsSinceLastNudge: null,
      lastNudgeAt: null,
      lastVisibleAt: typeof event.time === 'number' ? event.time : state.lastVisibleAt,
      nudgeCountInTurn: 0,
    }
  }

  if (event.type === 'turn/end') {
    if (
      !state.inTurn &&
      !state.hasSpokenInSegment &&
      state.silentToolSteps === 0 &&
      state.stepsSinceLastNudge === null &&
      state.lastNudgeAt === null
    ) {
      return state
    }
    return {
      ...state,
      inTurn: false,
      hasSpokenInSegment: false,
      silentToolSteps: 0,
      stepsSinceLastNudge: null,
      lastNudgeAt: null,
    }
  }

  if (event.type === 'user/message') {
    const src = event.data?.source
    // Track our own committed nudge injection so Stage-1 transitions to Stage-2 and cooldown starts!
    if (
      src?.kind === PLUGIN_SOURCE_NAME ||
      (src?.kind === 'plugin' && src?.plugin === PLUGIN_SOURCE_NAME)
    ) {
      return {
        ...state,
        stepsSinceLastNudge: 0,
        lastNudgeAt: typeof event.time === 'number' ? event.time : state.lastNudgeAt,
        nudgeCountInTurn: state.nudgeCountInTurn + 1,
      }
    }
    // Genuine human user message (including mid-turn human steer): reset to Stage-1 opening state!
    if (src === undefined || src?.kind === 'user') {
      const blocks = Array.isArray(event.data?.content) ? event.data.content : []
      const joined = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
      const trimmed = joined.trimStart()
      // Ignore synthetic Agy mid-turn `<SYSTEM_MESSAGE>` / retry envelopes if any carried `user` source
      if (
        trimmed.startsWith('The following is a <SYSTEM_MESSAGE>') ||
        trimmed.startsWith('<SYSTEM_MESSAGE>') ||
        trimmed.startsWith('Error: Your previous response was cut off') ||
        trimmed.startsWith('Error: model output error:')
      ) {
        return state
      }
      const detectedLang = joined.trim().length > 0 ? detectPromptLanguage(joined) : state.userLang
      return {
        ...state,
        hasSpokenInSegment: false,
        silentToolSteps: 0,
        stepsSinceLastNudge: null,
        lastNudgeAt: null,
        lastVisibleAt: typeof event.time === 'number' ? event.time : state.lastVisibleAt,
        nudgeCountInTurn: 0,
        userLang: detectedLang,
      }
    }
    return state
  }

  if (event.type === 'assistant/message') {
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const hasVisibleText = blocks.some(
      (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
    )
    const toolCalls = blocks.filter((b) => b && b.type === 'tool-call')
    const calledUserFacingTool = toolCalls.some(
      (tc) => tc.name === 'ask_user' || tc.name === 'notify_user',
    )

    if (hasVisibleText || calledUserFacingTool) {
      return {
        ...state,
        hasSpokenInSegment: true,
        silentToolSteps: 0,
        stepsSinceLastNudge: null,
        lastNudgeAt: null,
        lastVisibleAt: typeof event.time === 'number' ? event.time : state.lastVisibleAt,
      }
    }

    if (toolCalls.length > 0) {
      return {
        ...state,
        silentToolSteps: state.silentToolSteps + 1,
        stepsSinceLastNudge:
          state.stepsSinceLastNudge === null ? null : state.stepsSinceLastNudge + 1,
      }
    }

    return state
  }

  return state
}

/**
 * Check whether an agent is a root Antigravity (`agy`) session running a matching Gemini model
 * (excluding all child subagents).
 */
export function isEligibleAgyGeminiStep({ agent, presetId, modelId, config }) {
  if (!agent?.session) return false
  const header = agent.session.header
  if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) {
    return false
  }
  const effectivePreset = presetId ?? header?.agentPreset
  if (effectivePreset !== config.targetPreset) {
    return false
  }
  if (!modelId) return false
  try {
    return new RegExp(config.modelPattern, 'i').test(String(modelId))
  } catch {
    return String(modelId).toLowerCase().includes(String(config.modelPattern).toLowerCase())
  }
}

/**
 * Decide whether the upcoming step should append a progress commentary nudge under the
 * two-stage GPT-6-calibrated policy:
 * - Stage 1 (Opening — before any visible update or nudge in the current user request segment):
 *   Triggers once `silentToolSteps >= firstUpdateStepThreshold` (2) AND `elapsed >= firstUpdateMinSeconds` (10s),
 *   OR if a single slow initial command already exceeded `silentElapsedSeconds` (65s).
 * - Stage 2 (Mid-task steady cadence — after >= 1 visible update or nudge):
 *   Time-led: `silentToolSteps >= minSilentStepsForTimeNudge` (2) AND `elapsed >= silentElapsedSeconds` (65s);
 *   Step-cap fallback: `silentToolSteps >= silentStepThreshold` (10) AND `elapsed >= stepMinElapsedSeconds` (45s).
 * - Post-nudge cooldown (when a previous nudge has not yet been answered with visible text):
 *   Requires BOTH `stepsSinceLastNudge >= cooldownSteps` (4) AND `sinceNudge >= cooldownSeconds` (30s).
 */
export function evaluateProgressNudgeDecision({
  state,
  proposedMessages = [],
  nowMs = Date.now(),
  config,
}) {
  const effectiveEnabled = state.pendingCommand?.nextEnabled ?? state.enabled
  if (!effectiveEnabled) {
    return { shouldNudge: false, reason: 'disabled' }
  }

  // Never nudge on a step that already carries a fresh human user message (e.g. Turn 1 Step 1 or live user steer)
  const hasFreshHumanMessage = proposedMessages.some((m) => {
    const kind = m?.source?.kind
    if (kind !== undefined && kind !== 'user') return false
    const text = Array.isArray(m?.content)
      ? m.content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trimStart()
      : ''
    return (
      !text.startsWith('The following is a <SYSTEM_MESSAGE>') &&
      !text.startsWith('<SYSTEM_MESSAGE>') &&
      !text.startsWith('Error: ')
    )
  })
  if (hasFreshHumanMessage) {
    return { shouldNudge: false, reason: 'fresh-human-input' }
  }

  if (state.silentToolSteps < 1) {
    return { shouldNudge: false, reason: 'not-silent' }
  }

  // Post-nudge dual cooldown (both step count AND wall-clock seconds must pass if a prior nudge went unanswered)
  if (state.stepsSinceLastNudge !== null) {
    if (state.stepsSinceLastNudge < config.cooldownSteps) {
      return { shouldNudge: false, reason: 'cooldown-steps' }
    }
    if (
      typeof state.lastNudgeAt === 'number' &&
      Math.max(0, nowMs - state.lastNudgeAt) < config.cooldownSeconds * 1000
    ) {
      return { shouldNudge: false, reason: 'cooldown-time' }
    }
  }

  const elapsedMs =
    typeof state.lastVisibleAt === 'number' ? Math.max(0, nowMs - state.lastVisibleAt) : 0
  const elapsedSec = Math.floor(elapsedMs / 1000)

  const isOpeningStage = !state.hasSpokenInSegment && state.nudgeCountInTurn === 0

  if (isOpeningStage) {
    const hitOpening =
      (state.silentToolSteps >= config.firstUpdateStepThreshold &&
        elapsedMs >= config.firstUpdateMinSeconds * 1000) ||
      (state.silentToolSteps >= 1 && elapsedMs >= config.silentElapsedSeconds * 1000)

    if (!hitOpening) {
      return { shouldNudge: false, reason: 'below-opening-threshold' }
    }

    return {
      shouldNudge: true,
      stage: 'opening',
      reason: 'opening-threshold',
      silentToolSteps: state.silentToolSteps,
      elapsedSec,
    }
  }

  // Stage 2: Mid-task steady cadence
  const hitTimeThreshold =
    state.silentToolSteps >= config.minSilentStepsForTimeNudge &&
    elapsedMs >= config.silentElapsedSeconds * 1000
  const hitStepFallback =
    state.silentToolSteps >= config.silentStepThreshold &&
    elapsedMs >= config.stepMinElapsedSeconds * 1000

  if (!hitTimeThreshold && !hitStepFallback) {
    return { shouldNudge: false, reason: 'below-mid-threshold' }
  }

  return {
    shouldNudge: true,
    stage: 'mid',
    reason: hitTimeThreshold ? 'time-threshold' : 'step-threshold',
    silentToolSteps: state.silentToolSteps,
    elapsedSec,
  }
}

/**
 * Build the exact Antigravity `<SYSTEM_MESSAGE>` envelope text that:
 * 1) Starts with `'The following is a <SYSTEM_MESSAGE>'` so `dsh-agy-mode`'s `wire-bridge.js`
 *    treats it as an in-task system continuation and preserves 100% of `reasoning_opaque` /
 *    `thought_signature` prompt cache!
 * 2) Tailors copy to Stage 1 (`opening` initial findings + plan) vs Stage 2 (`mid` progress update),
 *    explicitly requiring Gemini to emit 1-2 concise sentences IN THE SAME RESPONSE as its next
 *    tool call(s) WITHOUT stopping tool execution or calling `ask_user` / `send_message`.
 */
export function buildAgyProgressNudgeMessage({
  stage = 'mid',
  silentToolSteps,
  elapsedSec = 0,
  lang = 'zh',
  followUserLanguage = true,
  timestampIso = formatAgyIsoTimestamp(),
}) {
  const isZh = followUserLanguage && lang === 'zh'
  const elapsedClauseZh = elapsedSec >= 5 ? `（已耗时 ${elapsedSec} 秒）` : ''
  const elapsedClauseEn = elapsedSec >= 5 ? ` (${elapsedSec}s elapsed)` : ''

  let instruction
  if (stage === 'opening') {
    instruction = isZh
      ? `[Progress Commentary Reminder] 你已连续执行了 ${silentToolSteps} 步初步探索${elapsedClauseZh}，尚未向用户发出开场反馈。若任务仍需继续调用工具：请在本步**正常发起下一个/下一批工具调用的同时**，在同一条回复的正文（visible response text）中用 1～2 句简短中文向用户同步你的初步勘察结论与接下来的执行思路。硬性约束：(1) 严禁为了汇报而停止调用工具或提前中断任务；(2) 直接输出普通可见正文即可，不要为此调用 ask_user 或 send_message 工具；(3) 若任务已完成则直接给出最终答复。`
      : `[Progress Commentary Reminder] You have run ${silentToolSteps} initial tool steps${elapsedClauseEn} without sending an opening update to the user. If the task still requires further tool calls, include a concise 1-2 sentence opening update in your visible response text IN THIS SAME RESPONSE alongside your next tool call(s), sharing your initial findings and immediate plan. Strict rules: (1) Do NOT stop calling tools or pause the task just to report status; (2) Output plain visible text directly—do NOT call ask_user or send_message for this update; (3) If all work is genuinely complete, provide your final answer.`
  } else {
    instruction = isZh
      ? `[Progress Commentary Reminder] 距上次向用户反馈已过 ${elapsedSec} 秒（期间已静默执行 ${silentToolSteps} 步工具）。若任务尚未全部完成、仍需继续调用工具：请在本步**正常发起下一个/下一批工具调用的同时**，在同一条回复的正文（visible response text）中用 1～2 句简短中文告诉用户你刚完成了什么/关键发现是什么、以及下一步准备做什么。硬性约束：(1) 严禁为了汇报进度而停止调用工具或提前结束回合；(2) 直接输出普通可见正文即可，不要为此调用 ask_user 或 send_message 工具；(3) 若任务已彻底完成并验证无误，则直接给出完整最终总结。`
      : `[Progress Commentary Reminder] ${elapsedSec}s have elapsed since your last visible update (${silentToolSteps} silent tool steps). If the task is still in progress and requires further tool calls, include a brief 1-2 sentence progress update in your visible response text IN THIS SAME RESPONSE alongside your next tool call(s), summarizing your latest progress/finding and immediate next step. Strict rules: (1) Do NOT stop calling tools or pause the task just to report status; (2) Output plain visible text directly—do NOT call ask_user or send_message for this update; (3) If all work is genuinely finished and verified, provide your normal final answer.`
  }

  const envelopeText =
    `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n` +
    `<SYSTEM_MESSAGE>\n` +
    `[Message] timestamp=${timestampIso} sender=progress_monitor priority=MESSAGE_PRIORITY_LOW content=${instruction}\n` +
    `</SYSTEM_MESSAGE>`

  const summary =
    stage === 'opening'
      ? isZh
        ? `初步探索 ${silentToolSteps} 步（${elapsedSec}s）· 轻推开场反馈`
        : `${silentToolSteps} initial tool steps (${elapsedSec}s) · nudged opening update`
      : isZh
        ? `已静默 ${elapsedSec}s（${silentToolSteps} 步工具）· 轻推途中播报`
        : `${elapsedSec}s silent (${silentToolSteps} tool steps) · nudged progress update`

  return { envelopeText, summary }
}
