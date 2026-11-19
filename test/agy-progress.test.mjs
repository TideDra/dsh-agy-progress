import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { importDshPackage } from '../src/dsh-deps.js'
import {
  COMMAND_NAME,
  PLUGIN_SOURCE_NAME,
  applyProgressEvent,
  buildAgyProgressNudgeMessage,
  createInitialProgressState,
  detectPromptLanguage,
  evaluateProgressNudgeDecision,
  extractRawUserText,
  isEligibleAgyGeminiStep,
  normalizeAgyProgressConfig,
} from '../src/logic.js'

const PLUGIN_DIR = resolve(new URL('..', import.meta.url).pathname)
const AGY_MODE_DIR = [
  process.env.AGY_MODE_DIR,
  resolve(PLUGIN_DIR, '../dsh-agy-mode'),
  resolve(PLUGIN_DIR, '../../dsh-agy-mode'),
].find((p) => typeof p === 'string' && existsSync(join(p, 'package.json')))

test('1. Display metadata, manifest & SVG icon checklist', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@local/dsh-agy-progress')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-commands'))
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')

  const en = JSON.parse(readFileSync(join(PLUGIN_DIR, 'locale/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(PLUGIN_DIR, 'locale/zh.json'), 'utf8'))
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 0)
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 0)

  const iconBytes = statSync(join(PLUGIN_DIR, 'icon.svg')).size
  assert.ok(iconBytes > 100 && iconBytes <= 256 * 1024)
  const iconSvg = readFileSync(join(PLUGIN_DIR, 'icon.svg'), 'utf8')
  assert.ok(iconSvg.includes('<svg') && iconSvg.includes('</svg>'))
})

test('2. Two-stage (Opening + Mid-task) projection fold, cadence thresholds & dual cooldown', () => {
  const cfg = normalizeAgyProgressConfig()
  assert.equal(cfg.firstUpdateStepThreshold, 2)
  assert.equal(cfg.firstUpdateMinSeconds, 10)
  assert.equal(cfg.silentElapsedSeconds, 65)
  assert.equal(cfg.silentStepThreshold, 10)
  assert.equal(cfg.stepMinElapsedSeconds, 45)
  assert.equal(cfg.cooldownSteps, 4)
  assert.equal(cfg.cooldownSeconds, 30)

  const wrappedZh =
    '<USER_REQUEST>\n帮我重构登录模块并跑通测试\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-17T22:00:00+08:00.\n</ADDITIONAL_METADATA>'
  assert.equal(extractRawUserText(wrappedZh), '帮我重构登录模块并跑通测试')
  assert.equal(detectPromptLanguage(wrappedZh), 'zh')

  let st = createInitialProgressState(true)
  const t0 = 1_700_000_000_000

  // Unrelated event returns exact same reference
  assert.equal(applyProgressEvent(st, { type: 'tool/result', time: t0, data: {} }), st)

  // Turn starts + Chinese user prompt -> Stage 1 (opening)
  st = applyProgressEvent(st, { type: 'turn/start', time: t0, data: { turn: 1 } })
  st = applyProgressEvent(st, {
    type: 'user/message',
    time: t0,
    data: {
      role: 'user',
      content: [{ type: 'text', text: wrappedZh }],
      source: { kind: 'user' },
    },
  })
  assert.equal(st.hasSpokenInSegment, false)

  // 2 rapid silent tool steps finishing in just 6s (< 10s opening floor) -> NO nudge yet!
  for (let i = 1; i <= 2; i++) {
    st = applyProgressEvent(st, {
      type: 'assistant/message',
      time: t0 + i * 3000,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: `c_${i}`, name: 'read_file', arguments: { Path: '/a' } }],
        },
      },
    })
  }
  assert.equal(st.silentToolSteps, 2)
  assert.equal(
    evaluateProgressNudgeDecision({ state: st, nowMs: t0 + 7000, config: cfg }).shouldNudge,
    false,
  )

  // At 12s (>= 10s opening floor with 2 silent steps) -> triggers Stage 1 (`opening`) nudge!
  const openingEval = evaluateProgressNudgeDecision({ state: st, nowMs: t0 + 12_000, config: cfg })
  assert.equal(openingEval.shouldNudge, true)
  assert.equal(openingEval.stage, 'opening')

  // Model responds to opening nudge with visible commentary + next tool call at t0+15s -> transitions to Stage 2 (`hasSpokenInSegment = true`)!
  st = applyProgressEvent(st, {
    type: 'user/message',
    time: t0 + 12_100,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'The following is a <SYSTEM_MESSAGE>...' }],
      source: { kind: PLUGIN_SOURCE_NAME, form: 'notice', summary: 'opening nudged' },
    },
  })
  st = applyProgressEvent(st, {
    type: 'assistant/message',
    time: t0 + 15_000,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '已阅读入口文件，定位到鉴权中间件问题，接下来修改逻辑并补测试。' },
          { type: 'tool-call', id: 'c_3', name: 'edit_file', arguments: {} },
        ],
      },
    },
  })
  assert.equal(st.hasSpokenInSegment, true)
  assert.equal(st.silentToolSteps, 0)
  assert.equal(st.stepsSinceLastNudge, null)

  // Stage 2: 5 silent steps taking 35s (< 65s time threshold and < 10 step fallback) -> NO nudge!
  for (let i = 1; i <= 5; i++) {
    st = applyProgressEvent(st, {
      type: 'assistant/message',
      time: t0 + 15_000 + i * 7000,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: `mid_${i}`, name: 'read_file', arguments: {} }],
        },
      },
    })
  }
  assert.equal(st.silentToolSteps, 5)
  assert.equal(
    evaluateProgressNudgeDecision({ state: st, nowMs: t0 + 50_000, config: cfg }).shouldNudge,
    false,
  )

  // Once 66s have elapsed since `t0 + 15_000` (`nowMs = t0 + 81_000`) -> triggers Stage 2 (`mid` time-threshold)!
  const midTimeEval = evaluateProgressNudgeDecision({ state: st, nowMs: t0 + 81_000, config: cfg })
  assert.equal(midTimeEval.shouldNudge, true)
  assert.equal(midTimeEval.stage, 'mid')
  assert.equal(midTimeEval.reason, 'time-threshold')

  // Commit Stage-2 nudge at t0+81_100, then verify dual cooldown (4 steps AND 30s) when unanswered
  st = applyProgressEvent(st, {
    type: 'user/message',
    time: t0 + 81_100,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'The following is a <SYSTEM_MESSAGE>...' }],
      source: { kind: PLUGIN_SOURCE_NAME, form: 'notice', summary: 'mid nudged' },
    },
  })
  // 4 fast steps taking only 15s -> step cooldown satisfied (4 >= 4), but time cooldown (15s < 30s) blocks!
  for (let i = 1; i <= 4; i++) {
    st = applyProgressEvent(st, {
      type: 'assistant/message',
      time: t0 + 81_100 + i * 3000,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: `cd_${i}`, name: 'read_file', arguments: {} }],
        },
      },
    })
  }
  const cdTimeBlocked = evaluateProgressNudgeDecision({
    state: st,
    nowMs: t0 + 96_000,
    config: cfg,
  })
  assert.equal(cdTimeBlocked.shouldNudge, false)
  assert.equal(cdTimeBlocked.reason, 'cooldown-time')

  // Once >= 30s after nudge (`t0 + 115_000`), cooldown clears and Step-cap fallback (9 silent steps? add 1 more -> 10 steps >= 45s) triggers!
  st = applyProgressEvent(st, {
    type: 'assistant/message',
    time: t0 + 112_000,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'cd_5', name: 'read_file', arguments: {} }],
      },
    },
  })
  assert.equal(st.silentToolSteps, 10)
  const afterCd = evaluateProgressNudgeDecision({ state: st, nowMs: t0 + 115_000, config: cfg })
  assert.equal(afterCd.shouldNudge, true)
  assert.equal(afterCd.stage, 'mid')
})

test('3. Strict Agy-only scope & <SYSTEM_MESSAGE> CAPI signature safety', () => {
  const cfg = normalizeAgyProgressConfig()
  const rootAgySession = { header: { id: 's1', agentPreset: 'agy' } }
  const subAgySession = { header: { id: 's2', agentPreset: 'agy', origin: 'subagent', delegationDepth: 1 } }
  const codexSession = { header: { id: 's3', agentPreset: 'codex' } }

  assert.equal(
    isEligibleAgyGeminiStep({
      agent: { session: rootAgySession },
      presetId: 'agy',
      modelId: 'gemini-4-carbon',
      config: cfg,
    }),
    true,
  )
  assert.equal(
    isEligibleAgyGeminiStep({
      agent: { session: subAgySession },
      presetId: 'agy',
      modelId: 'gemini-4-carbon',
      config: cfg,
    }),
    false,
  )
  assert.equal(
    isEligibleAgyGeminiStep({
      agent: { session: codexSession },
      presetId: 'codex',
      modelId: 'gemini-4-carbon',
      config: cfg,
    }),
    false,
  )

  const openingMsg = buildAgyProgressNudgeMessage({
    stage: 'opening',
    silentToolSteps: 2,
    elapsedSec: 14,
    lang: 'zh',
  })
  assert.ok(openingMsg.envelopeText.startsWith('The following is a <SYSTEM_MESSAGE> not actually sent by the user.'))
  assert.ok(openingMsg.envelopeText.includes('开场反馈'))
  assert.ok(openingMsg.envelopeText.includes('不要为此调用 ask_user 或 send_message'))

  const midMsg = buildAgyProgressNudgeMessage({
    stage: 'mid',
    silentToolSteps: 6,
    elapsedSec: 72,
    lang: 'zh',
  })
  assert.ok(midMsg.envelopeText.startsWith('The following is a <SYSTEM_MESSAGE> not actually sent by the user.'))
  assert.ok(midMsg.envelopeText.includes('已过 72 秒'))
})

test('4. Full Web Profile End-to-End Integration with @local/dsh-agy-mode', async () => {
  const [
    { runProfile },
    { loadLayeredEnv },
    { SessionId },
    { createUserMessage },
  ] = await Promise.all([
    importDshPackage('@deepseek-ai/dsh/profile-boot'),
    importDshPackage('@deepseek-ai/dsh-app-boot'),
    importDshPackage('@deepseek-ai/dsh-session'),
    importDshPackage('@deepseek-ai/dsh-llm'),
  ])

  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-agy-prog-home-'))
  const tempRuntime = mkdtempSync(join(tmpdir(), 'dsh-agy-prog-rt-'))
  const tempWork = mkdtempSync(join(tmpdir(), 'dsh-agy-prog-ws-'))
  writeFileSync(join(tempWork, 'demo.txt'), 'line 1\nline 2\n')

  process.env.DSH_HOME = tempHome
  process.env.XDG_RUNTIME_DIR = tempRuntime
  process.env.XDG_CACHE_HOME = join(tempHome, 'cache')
  process.env.XDG_STATE_HOME = join(tempHome, 'state')
  process.env.NPM_CONFIG_STORE_DIR = join(tempHome, 'pnpm-store')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.OPENAI_API_KEY = 'sk-test-mock'

  const capturedWireBodies = []
  let mockStepCounter = 0

  const hasLocalAgyBundle = Boolean(AGY_MODE_DIR)
  const toolName = hasLocalAgyBundle ? 'read_file' : 'read'
  const toolArgs = hasLocalAgyBundle
    ? { Path: join(tempWork, 'demo.txt') }
    : { file_path: join(tempWork, 'demo.txt') }

  const mockServer = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const body = JSON.parse(raw)
      capturedWireBodies.push(body)
      const isTitleCall = !Array.isArray(body.tools) || body.tools.length === 0

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (isTitleCall) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-title',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Test Title' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          })}\n\ndata: [DONE]\n\n`,
        )
        res.end()
        return
      }

      mockStepCounter += 1
      if (mockStepCounter <= 2) {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-step-${mockStepCounter}`,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_silent_${mockStepCounter}`,
                      type: 'function',
                      function: {
                        name: toolName,
                        arguments: JSON.stringify(toolArgs),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
          })}\n\ndata: [DONE]\n\n`,
        )
      } else if (mockStepCounter === 3) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-step-3',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '已完成初步文件扫描，正在核对最后一项配置。',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_with_commentary_3',
                      type: 'function',
                      function: {
                        name: toolName,
                        arguments: JSON.stringify(toolArgs),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 },
          })}\n\ndata: [DONE]\n\n`,
        )
      } else {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-step-4',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '全部检查完成，结果正常。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          })}\n\ndata: [DONE]\n\n`,
        )
      }
      res.end()
    })
  })

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r))
  const mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}/v1`

  // Override `firstUpdateMinSeconds: 0` in the E2E test patch so the mock server doesn't need a 10s sleep!
  const fallbackPresetLines = hasLocalAgyBundle
    ? []
    : [
        '- insert:',
        '    - id: preset-agy',
        '      name: "@deepseek-ai/dsh-agent-preset"',
        '      config:',
        '        id: agy',
        '        name: Antigravity',
        '        plugins:',
        '          - id: tool-fs',
        '            name: "@deepseek-ai/dsh-tool-fs"',
      ]

  const providerPatch = join(tempHome, 'mock-gemini.patch.yml')
  writeFileSync(
    providerPatch,
    [
      ...fallbackPresetLines,
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      mock-copilot:',
      '        displayName: Mock Copilot Gemini',
      '        apiKeyEnv: OPENAI_API_KEY',
      '        api: openai-completions',
      `        baseURL: ${JSON.stringify(mockBaseUrl)}`,
      '        models:',
      '          - id: gemini-4-carbon',
      '            name: Gemini 4 Carbon',
      '            contextWindow: 1000000',
      '            maxTokens: 65536',
      '            input: [text, image]',
      '- id: agy-progress',
      '  name: "@local/dsh-agy-progress"',
      '  config:',
      '    firstUpdateStepThreshold: 2',
      '    firstUpdateMinSeconds: 0',
      '    silentElapsedSeconds: 65',
    ].join('\n'),
  )

  let booted
  try {
    const port = 22000 + Math.floor(Math.random() * 4000)
    booted = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: 'web',
      patchFiles: [providerPatch],
      args: ['--port', String(port), '--no-open'],
    })

    const { ctx } = booted
    const pluginManager = ctx.get('pluginManager')

    if (hasLocalAgyBundle) {
      const resAgy = await pluginManager.installBundle(AGY_MODE_DIR)
      assert.equal(resAgy.application, 'applied')
    }
    const resProg = await pluginManager.installBundle(PLUGIN_DIR)
    assert.equal(resProg.application, 'applied')

    const agentPresets = ctx.get('agentPresets')
    const commandsSvc = ctx.get('commands')
    const signal = new AbortController().signal

    const agySession = await ctx.agents.create({
      sessionId: SessionId('session-agy-progress-v2-e2e'),
      meta: { cwd: tempWork, agentPreset: 'agy' },
      agentOptions: { provider: 'mock-copilot', model: 'gemini-4-carbon' },
      setup: async (agentCtx) => {
        await agentPresets.mount(agentCtx, 'agy')
      },
    })
    try {
      agySession.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '请帮我检查当前目录里的文件' }],
          source: { kind: 'user' },
        }),
      )
      await agySession.agent.whenIdle()

      const agentCalls = capturedWireBodies.filter((b) => Array.isArray(b.tools) && b.tools.length > 0)
      assert.equal(agentCalls.length, 4, 'Expected exact 4 agent steps')

      // Steps 1 & 2: no nudge yet
      for (const idx of [0, 1]) {
        assert.ok(!JSON.stringify(agentCalls[idx].messages).includes('sender=progress_monitor'))
      }

      // Step 3 (after 2 silent initial steps): receives clean Stage-1 Opening `<SYSTEM_MESSAGE>`!
      const step3Messages = agentCalls[2].messages
      const lastUserOnStep3 = [...step3Messages].reverse().find((m) => m.role === 'user')
      const lastUserText =
        typeof lastUserOnStep3.content === 'string'
          ? lastUserOnStep3.content
          : lastUserOnStep3.content.map((c) => c.text).join('\n')
      assert.ok(lastUserText.startsWith('The following is a <SYSTEM_MESSAGE>'))
      assert.ok(!lastUserText.includes('<USER_REQUEST>'))
      assert.ok(lastUserText.includes('开场反馈'))

      // Step 4 (after Step 3 spoke): transitioned to Stage-2 (`mid`), so NO second nudge at <65s!
      const step4Nudges = agentCalls[3].messages.filter((m) =>
        JSON.stringify(m.content).includes('sender=progress_monitor'),
      )
      assert.equal(step4Nudges.length, 1)

      const statusRes = await commandsSvc.execute(agySession.agent, '/agy-progress status', [], signal)
      assert.equal(statusRes?.result?.kind, 'success')
      assert.ok(statusRes.result.text.includes('opening: 2 steps / 0s'))
    } finally {
      await agySession.dispose()
    }
  } finally {
    if (booted !== undefined) {
      await booted.ctx.fiber.dispose()
    }
    await new Promise((r) => mockServer.close(r))
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempRuntime, { recursive: true, force: true })
    rmSync(tempWork, { recursive: true, force: true })
  }
})
