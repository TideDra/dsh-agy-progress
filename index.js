import { importDshPackage } from './src/dsh-deps.js'
import {
  COMMAND_NAME,
  PLUGIN_SOURCE_NAME,
  PROJECTION_KEY,
  applyProgressEvent,
  buildAgyProgressNudgeMessage,
  createInitialProgressState,
  evaluateProgressNudgeDecision,
  isEligibleAgyGeminiStep,
  normalizeAgyProgressConfig,
  parseProgressCommandAction,
} from './src/logic.js'

const [{ default: z }, { z: zod }, { brandString }, { createUserMessage, boundContextSummary }] =
  await Promise.all([
    importDshPackage('@deepseek-ai/schemastery'),
    importDshPackage('zod'),
    importDshPackage('@deepseek-ai/dsh-brand'),
    importDshPackage('@deepseek-ai/dsh-llm'),
  ])

export const name = 'agy-progress'
export const inject = ['agents', 'sessionProjections']

export const Config = z.object({
  defaultEnabled: z.boolean().default(true),
  targetPreset: z.string().default('agy'),
  modelPattern: z.string().default('gemini'),
  firstUpdateStepThreshold: z.number().step(1).min(1).default(2),
  firstUpdateMinSeconds: z.number().min(0).default(10),
  silentElapsedSeconds: z.number().min(5).default(65),
  minSilentStepsForTimeNudge: z.number().step(1).min(1).default(2),
  silentStepThreshold: z.number().step(1).min(1).default(10),
  stepMinElapsedSeconds: z.number().min(0).default(45),
  cooldownSteps: z.number().step(1).min(1).default(4),
  cooldownSeconds: z.number().min(0).default(30),
  followUserLanguage: z.boolean().default(true),
})

/**
 * Resolve the current preset id of a live session (`'agy'`, `'codex'`, `'standard'`, etc.).
 */
function resolveSessionPreset(ctx, session) {
  if (!session) return undefined
  const presetSvc = ctx.get('agentPresets')
  if (presetSvc && typeof presetSvc.presetForSession === 'function') {
    const resolved = presetSvc.presetForSession(session)
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
  }
  return session.header?.agentPreset
}

/**
 * Mount the Antigravity (`agy`)-exclusive Gemini progress commentary nudger:
 * 1. Registers `agyProgress` session projection (`stateVersion: 2`, pure log fold, zero custom
 *    session event types) with `wire.view` so the Web Composer pill stays synced across reloads.
 * 2. Registers `/agy-progress [on|off|status]` ONLY on `agy` root agents via `agent/created`
 *    so `standard`/`cordis`/`codex` command menus stay 100% untouched.
 * 3. Implements the two-stage GPT-6-calibrated cadence (`opening` 2 steps / 10s + `mid` 65s
 *    time-led / 10-step@45s fallback, with 4-step / 30s anti-spam cooldown) via Antigravity-native
 *    `<SYSTEM_MESSAGE>` envelopes at `agent/pre-step`, preserving 100% of `reasoning_opaque` /
 *    `thought_signature` prompt caches!
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeAgyProgressConfig(rawConfig)

  const stateSchema = zod.object({
    enabled: zod.boolean(),
    pendingCommand: zod
      .object({
        commandId: zod.string(),
        nextEnabled: zod.boolean(),
      })
      .nullable(),
    inTurn: zod.boolean(),
    hasSpokenInSegment: zod.boolean(),
    silentToolSteps: zod.number().int().nonnegative(),
    stepsSinceLastNudge: zod.number().int().nonnegative().nullable(),
    lastNudgeAt: zod.number().nullable(),
    lastVisibleAt: zod.number().nullable(),
    nudgeCountInTurn: zod.number().int().nonnegative(),
    userLang: zod.union([zod.literal('zh'), zod.literal('en')]),
  })

  const viewSchema = zod.object({
    enabled: zod.boolean(),
    pending: zod.boolean(),
  })

  // Cache unchanged wire views per `(enabled, pending)` pair so `sessionProjections` suppresses
  // redundant WebSocket frames when internal step counters advance!
  const VIEW_CACHE = {
    'true:false': Object.freeze({ enabled: true, pending: false }),
    'true:true': Object.freeze({ enabled: true, pending: true }),
    'false:false': Object.freeze({ enabled: false, pending: false }),
    'false:true': Object.freeze({ enabled: false, pending: true }),
  }

  const projectionHandle = await ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema,
    init: () => createInitialProgressState(config.defaultEnabled),
    apply: (state, event) => applyProgressEvent(state, event),
    wire: {
      viewSchema,
      summary: false,
      view(state) {
        const effective = state.pendingCommand?.nextEnabled ?? state.enabled
        const pending = state.pendingCommand !== null
        return VIEW_CACHE[`${effective}:${pending}`]
      },
    },
  })

  // Register `/agy-progress` strictly per-agent on root `agy` sessions (and clean up on plugin unload OR agent disposal!)
  const agentCommandDisposers = new Map()

  const attachScopedCommandIfAgy = (agent) => {
    if (!agent?.ctx || !agent?.session || agentCommandDisposers.has(agent.id)) return
    const header = agent.session.header
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return
    const presetId = resolveSessionPreset(ctx, agent.session)
    if (presetId !== config.targetPreset) return
    if (ctx.get('commands') === undefined) return

    const childFiber = agent.ctx.inject(['commands'], (cmdCtx) => {
      const unregisterCmd = cmdCtx.commands.register({
        definitionId: brandString('@local/dsh-agy-progress:command'),
        name: COMMAND_NAME,
        description: 'Toggle Antigravity mid-task progress commentary reminders (on | off | status)',
        input: {
          hint: '[on|off|status]',
        },
        handler: ({ agent: targetAgent, rawInput }) => {
          const st = projectionHandle.stateOf(targetAgent.session)
          const currentEnabled = st.pendingCommand?.nextEnabled ?? st.enabled
          const action = parseProgressCommandAction(rawInput)
          if (action === 'invalid') {
            return {
              kind: 'error',
              text: `Usage: /${COMMAND_NAME} [on|off|status]`,
            }
          }
          if (action === 'status') {
            const stageLabel =
              !st.hasSpokenInSegment && st.nudgeCountInTurn === 0 ? 'opening' : 'mid-task'
            return {
              kind: 'success',
              text: `Antigravity progress updates: ${currentEnabled ? 'ON' : 'OFF'} (stage: ${stageLabel}, opening: ${config.firstUpdateStepThreshold} steps / ${config.firstUpdateMinSeconds}s, mid-task: ${config.silentElapsedSeconds}s or ${config.silentStepThreshold} steps@${config.stepMinElapsedSeconds}s, cooldown: ${config.cooldownSteps} steps / ${config.cooldownSeconds}s, silent steps now: ${st.silentToolSteps}).`,
            }
          }
          const nextEnabled =
            action === 'on' ? true : action === 'off' ? false : !currentEnabled
          return {
            kind: 'success',
            text: nextEnabled
              ? `Antigravity progress updates ON — opening update at ${config.firstUpdateStepThreshold} steps / ${config.firstUpdateMinSeconds}s, then steady updates every ~${config.silentElapsedSeconds}s (or ${config.silentStepThreshold} steps@${config.stepMinElapsedSeconds}s).`
              : 'Antigravity progress updates OFF — silent tool loops will not be nudged.',
          }
        },
      })
      cmdCtx.effect(() => () => {
        agentCommandDisposers.delete(agent.id)
        unregisterCmd()
      }, 'agy-progress: scoped /agy-progress command')
    })

    agentCommandDisposers.set(agent.id, () => {
      agentCommandDisposers.delete(agent.id)
      return childFiber.dispose()
    })
  }

  // Attach to any already-live `agy` root sessions (supporting live hot-install without restart!)
  for (const liveAgent of ctx.agents.roots()) {
    attachScopedCommandIfAgy(liveAgent)
  }

  ctx.on('agent/created', ({ agent }) => {
    attachScopedCommandIfAgy(agent)
  })

  // Also handle blank sessions dynamically switched into `'agy'` before Turn 1 starts (e.g. via `Auto` mode!)
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    const live = ctx.agents.get(sessionId)
    if (agentPreset === config.targetPreset && live !== undefined) {
      attachScopedCommandIfAgy(live)
    } else if (agentPreset !== config.targetPreset && agentCommandDisposers.has(sessionId)) {
      const disp = agentCommandDisposers.get(sessionId)
      agentCommandDisposers.delete(sessionId)
      disp?.()
    }
  })

  ctx.effect(() => () => {
    for (const dispose of [...agentCommandDisposers.values()]) {
      dispose?.()
    }
    agentCommandDisposers.clear()
  }, 'agy-progress: cleanup all per-agent command registrations')

  // Core `agent/pre-step` nudger: runs exclusively on root `agy` Gemini steps!
  ctx.on('agent/pre-step', async ({ agent, signal, modelSelection }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const presetId = resolveSessionPreset(ctx, agent?.session)
    const modelId =
      modelSelection?.model ??
      agent?.session?.requestHeader()?.config?.model ??
      agent?.options?.model ??
      ctx.get('agentDefaultModel')?.currentSelection?.()?.model ??
      ''

    if (!isEligibleAgyGeminiStep({ agent, presetId, modelId, config })) {
      return decision
    }

    const state = projectionHandle.stateOf(agent.session)
    const evalResult = evaluateProgressNudgeDecision({
      state,
      proposedMessages: decision.messages,
      nowMs: Date.now(),
      config,
    })

    if (!evalResult.shouldNudge) {
      return decision
    }

    const { envelopeText, summary } = buildAgyProgressNudgeMessage({
      stage: evalResult.stage,
      silentToolSteps: evalResult.silentToolSteps,
      elapsedSec: evalResult.elapsedSec,
      lang: state.userLang,
      followUserLanguage: config.followUserLanguage,
    })

    const nudgeMsg = createUserMessage({
      content: [{ type: 'text', text: envelopeText }],
      source: {
        kind: PLUGIN_SOURCE_NAME,
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    })

    return {
      ...decision,
      messages: [...decision.messages, nudgeMsg],
    }
  })
}

export * from './src/logic.js'
