window.__ModuleLoader__.load({
  id: '@local/dsh-agy-progress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOCALE_NS = 'agy-progress-ui'
    const STYLE_TAG_ID = '@local/dsh-agy-progress/client.css'

    const CSS = [
      '.agyProg_wrap { display: inline-flex; align-items: center; gap: 6px; }',
      '.agyProg_btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  height: 28px;',
      '  padding: 0 8px;',
      '  border-radius: 6px;',
      '  border: 1px solid var(--dsw-alias-border-l1);',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-secondary);',
      '  font-size: 13px;',
      '  font-weight: 500;',
      '  line-height: 20px;',
      '  cursor: pointer;',
      '  user-select: none;',
      '  transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;',
      '}',
      '.agyProg_btn[aria-checked="true"] {',
      '  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, transparent);',
      '  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);',
      '  color: var(--dsw-alias-brand-primary);',
      '}',
      '@media (hover: hover) {',
      '  .agyProg_btn:hover:not(:disabled) {',
      '    background: var(--dsw-alias-bg-layer-2);',
      '    color: var(--dsw-alias-label-primary);',
      '  }',
      '  .agyProg_btn[aria-checked="true"]:hover:not(:disabled) {',
      '    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);',
      '    color: var(--dsw-alias-brand-primary);',
      '  }',
      '}',
      '.agyProg_btn:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-brand-primary);',
      '  outline-offset: 2px;',
      '}',
      '.agyProg_btn:disabled { opacity: 0.55; cursor: default; }',
      '.agyProg_icon { width: 13px; height: 13px; flex: none; display: block; }',
      '.agyProg_dot {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 999px;',
      '  flex: none;',
      '  background: var(--dsw-alias-state-idle-primary);',
      '}',
      '.agyProg_btn[aria-checked="true"] .agyProg_dot {',
      '  background: var(--dsw-alias-brand-primary);',
      '}',
      '@container (width <= 520px) {',
      '  .agyProg_label { display: none; }',
      '}',
      '.agyProg_err { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }',
    ].join('\n')

    const EN_DICT = {
      'progress.label': 'Updates',
      'progress.on.title':
        'Antigravity progress updates ON — nudges Gemini to share brief mid-task commentary alongside tool calls. Click to turn off (/agy-progress off)',
      'progress.off.title':
        'Antigravity progress updates OFF — Gemini runs silent tool loops until final answer. Click to turn on (/agy-progress on)',
      'progress.aria': 'Antigravity mid-task progress commentary updates',
      'progress.failed': 'Failed to switch progress updates',
    }

    const ZH_DICT = {
      'progress.label': '进展播报',
      'progress.on.title':
        'Antigravity 进展播报已开启 — 连续静默调工具时自动轻推 Gemini 边干活边汇报简短进度。点击关闭（/agy-progress off）',
      'progress.off.title':
        'Antigravity 进展播报已关闭 — 保持默认静默执行直至任务完成。点击开启（/agy-progress on）',
      'progress.aria': 'Antigravity 干活过程进展播报开关',
      'progress.failed': '切换进展播报失败',
    }

    function PulseBubbleIcon() {
      return h(
        'svg',
        {
          className: 'agyProg_icon',
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H12.5C13.05 2.5 13.5 2.95 13.5 3.5V9.5C13.5 10.05 13.05 10.5 12.5 10.5H6.8L3.8 13V10.5H3.5C2.95 10.5 2.5 10.05 2.5 9.5V3.5Z',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5.2 6.5H6.6L7.5 4.8L8.6 8.2L9.5 6.5H10.8',
          stroke: 'currentColor',
          strokeWidth: '1.25',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function AgyProgressSwitch(props) {
      const { useProjection, useSession, toggleProgress, t } = props
      const agentPreset = useProjection('agentPreset')
      const progState = useProjection('agyProgress')
      const subagent = useSession ? useSession((s) => s.subagent) : null
      const removed = useSession ? useSession((s) => s.removed) : false

      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const mountedRef = React.useRef(true)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      // Strictly render ONLY when the session preset is `"agy"` and not a child subagent transcript!
      if (agentPreset !== 'agy' || subagent !== null) {
        return null
      }

      const isEnabled = progState === undefined ? true : Boolean(progState.enabled)
      const isPending = Boolean(progState && progState.pending) || busy
      const translate = typeof t === 'function' ? t : (k) => EN_DICT[k] || k

      const onToggle = () => {
        if (isPending || removed) return
        const nextEnabled = !isEnabled
        setBusy(true)
        setError(null)
        toggleProgress(nextEnabled).then(
          (errText) => {
            if (!mountedRef.current) return
            setBusy(false)
            if (errText) setError(errText)
          },
          (err) => {
            if (!mountedRef.current) return
            setBusy(false)
            setError(err instanceof Error ? err.message : String(err))
          },
        )
      }

      return h(
        'span',
        { className: 'agyProg_wrap' },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': isEnabled,
            'aria-label': translate('progress.aria'),
            title: isEnabled ? translate('progress.on.title') : translate('progress.off.title'),
            className: 'agyProg_btn',
            disabled: isPending || removed,
            onMouseDown: (e) => e.preventDefault(),
            onClick: onToggle,
          },
          h(PulseBubbleIcon, null),
          h('span', { className: 'agyProg_label' }, translate('progress.label')),
          h('span', { className: 'agyProg_dot', 'aria-hidden': 'true' }),
        ),
        error !== null
          ? h(
              'span',
              {
                className: 'agyProg_err',
                role: 'status',
                title: error,
              },
              translate('progress.failed'),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          let styleEl = document.querySelector(
            'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']',
          )
          let created = false
          if (styleEl === null) {
            styleEl = document.createElement('style')
            styleEl.dataset.plugin = '@local/dsh-agy-progress'
            styleEl.dataset.pluginCss = STYLE_TAG_ID
            styleEl.textContent = CSS
            document.head.appendChild(styleEl)
            created = true
          }
          return () => {
            if (created && styleEl && styleEl.parentNode) {
              styleEl.parentNode.removeChild(styleEl)
            }
          }
        }, 'agy-progress: toggle styles')

        ctx.effect(() => {
          const offEn = ctx.locale.register(LOCALE_NS, 'en', EN_DICT)
          const offZh = ctx.locale.register(LOCALE_NS, 'zh', ZH_DICT)
          return () => {
            if (typeof offEn === 'function') offEn()
            if (typeof offZh === 'function') offZh()
          }
        }, 'agy-progress: toggle locales')

        const tBound = ctx.locale.bind(LOCALE_NS)

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'agy-progress-switch',
              order: 12,
              label: () => tBound('progress.label'),
              locale: LOCALE_NS,
              inject: (sessionId) => ({
                toggleProgress: async (nextEnabled) => {
                  const cmdLine = nextEnabled ? '/agy-progress on' : '/agy-progress off'
                  const res = await ctx.remote.commands.execute(sessionId, cmdLine, [])
                  if (!res.ok) {
                    return res.error.message + ' (' + res.error.code + ')'
                  }
                  if (res.value === undefined) {
                    return 'Command unavailable in this session'
                  }
                  if (res.value.result && res.value.result.kind === 'error') {
                    return res.value.result.text
                  }
                  return null
                },
              }),
            },
            AgyProgressSwitch,
          ),
        )
      },
    }
  },
})
