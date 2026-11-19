/**
 * dsh-qq-companion — 设置页（浏览器半）。
 *
 * 布局照 `dsh-mc-chat-watch`：整页 max-width 760px，每行是
 * 「左边文字（标题 + 说明）+ 右边控件」的横向排列。
 * 输入框逻辑也是同一套：`onChange` 只更新本地草稿，**`onBlur` 才真正保存**，
 * 免得每敲一个字就发一次请求。
 *
 * 数据不走 DSH 的 configForms —— 本机实测它拿到的是**没有字段的空壳**
 * （host 侧没有 installSection/register，`set()` 静默无效，见 index.js 的说明）。
 * 所以走 host 半自建的 loopback 接口 `CONFIG_ROUTE`。
 *
 * 打包成 lazy-CJS 工厂产物：`window.__ModuleLoader__.load({ id, factory })`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-companion',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'qq-companion'
    /** 与 index.js 的 CONFIG_ROUTE 必须一致。 */
    const CONFIG_ROUTE = '/qq-companion-config'

    const CSS = `
.qqc-page { max-width: 760px; padding: 8px 4px 40px; color: var(--dsh-text-primary, inherit); }
.qqc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.qqc-title { font-size: 15px; font-weight: 600; }
.qqc-sub { font-size: 12px; opacity: .6; margin-bottom: 12px; line-height: 1.6; }
.qqc-status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 9px 12px; border-radius: 8px; background: var(--dsh-surface-subtle, rgba(128,128,128,.08)); margin-bottom: 18px; }
.qqc-statusDot { font-size: 10px; line-height: 1; }
.qqc-statusDot.ok { color: #2e9e5b; }
.qqc-statusDot.err { color: #d9534f; }
.qqc-statusMeta { opacity: .6; margin-left: auto; font-size: 11.5px; }
.qqc-group { margin-bottom: 22px; }
.qqc-groupTitle { font-size: 12px; font-weight: 600; opacity: .55; letter-spacing: .04em; margin-bottom: 8px; text-transform: uppercase; }
.qqc-row { display: flex; align-items: center; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--dsh-border-subtle, rgba(128,128,128,.16)); }
.qqc-row:last-child { border-bottom: none; }
.qqc-label { flex: 1 1 auto; min-width: 0; }
.qqc-labelText { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.qqc-help { font-size: 11.5px; opacity: .55; margin-top: 3px; line-height: 1.5; }
.qqc-key { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 400; opacity: .5; letter-spacing: 0; white-space: nowrap; user-select: all; }
.qqc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsh-accent, #4b8bf5); flex: 0 0 auto; }
.qqc-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.qqc-input { width: 210px; padding: 6px 9px; font-size: 12.5px; border-radius: 7px; border: 1px solid var(--dsh-border-default, rgba(128,128,128,.32)); background: var(--dsh-surface, transparent); color: inherit; outline: none; font-family: inherit; }
.qqc-input:focus { border-color: var(--dsh-accent, #4b8bf5); }
.qqc-input.overridden { border-color: var(--dsh-accent, #4b8bf5); }
.qqc-select { width: 210px; padding: 6px 9px; font-size: 12.5px; border-radius: 7px; border: 1px solid var(--dsh-border-default, rgba(128,128,128,.32)); background: var(--dsh-surface, transparent); color: inherit; outline: none; font-family: inherit; }
.qqc-ro { font-size: 12.5px; opacity: .75; max-width: 340px; word-break: break-all; text-align: right; }
.qqc-note { font-size: 12px; padding: 10px 12px; border-radius: 8px; background: var(--dsh-surface-subtle, rgba(128,128,128,.1)); line-height: 1.6; margin-top: 10px; }
.qqc-note.err { color: #d9534f; }
.qqc-saveState { font-size: 12px; opacity: .65; margin-top: 14px; min-height: 18px; }
.qqc-saveState.ok { color: #2e9e5b; opacity: 1; }
.qqc-saveState.err { color: #d9534f; opacity: 1; }
`

    /** 样式只注入一次（卸载时移除）。 */
    function useStyles() {
      React.useEffect(() => {
        const id = 'qqc-settings-style'
        if (document.getElementById(id)) return undefined
        const style = document.createElement('style')
        style.id = id
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          try {
            style.remove()
          } catch {
            /* 忽略 */
          }
        }
      }, [])
    }

    /** 把字段值渲染成可以塞进输入框的字符串。 */
    function toText(value) {
      if (value === undefined || value === null) return ''
      if (Array.isArray(value)) return value.join(', ')
      return String(value)
    }

    function QQSettingsPage() {
      useStyles()
      const [payload, setPayload] = React.useState(null)
      const [fatal, setFatal] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' } })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
          setPayload(data)
          setFatal('')
        } catch (error) {
          setFatal(String((error && error.message) || error))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      // 状态行要自己更新：8 秒一次够了（每次会真去问一次协议端 get_status，
      // 不能太快；也不给 host 添麻烦）。
      React.useEffect(() => {
        const timer = setInterval(() => {
          load()
        }, 8000)
        return () => clearInterval(timer)
      }, [load])

      /** 保存一个字段；`null` 表示取消覆盖、回落到 cordis config。 */
      const commit = React.useCallback(
        async (field, raw) => {
          const key = field.key
          let value = raw
          if (field.type === 'bool') value = raw === 'true' || raw === true
          else if (field.type === 'number') {
            const num = Number(raw)
            if (raw === '' || Number.isNaN(num)) {
              setMessage({ kind: 'err', text: '请输入数字' })
              return
            }
            value = num
          } else if (field.type === 'list') {
            value = String(raw)
              .split(/[,，]/)
              .map((part) => part.trim())
              .filter(Boolean)
          }
          try {
            const res = await fetch(CONFIG_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ [key]: value }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
            setPayload(data)
            setDrafts((prev) => {
              const next = { ...prev }
              delete next[key]
              return next
            })
            const applied = Array.isArray(data.applied) ? data.applied : []
            const needRestart = Array.isArray(data.needsRestart) ? data.needsRestart : []
            const reconnecting = data.reconnecting === true
            setMessage({
              kind: 'ok',
              text:
                needRestart.length > 0
                  ? `已保存；${needRestart.join('、')} 需要重启 DSH 才生效`
                  : reconnecting
                    ? '已保存，正在按新地址重连…'
                    : '已保存并立即生效',
            })
            setTimeout(() => setMessage((cur) => (cur && cur.kind === 'ok' ? null : cur)), 2600)
          } catch (error) {
            setMessage({ kind: 'err', text: `保存失败：${String((error && error.message) || error)}` })
          }
        },
        [],
      )

      const renderControl = (field) => {
        if (field.type === 'readonly') {
          const text = field.key === 'bindings' && Array.isArray(field.value)
            ? field.value.map((row) => `${row.key} → ${String(row.sessionId || '').slice(0, 22)}…`).join('；') || '（未绑定）'
            : toText(field.value) || '（未设置）'
          return h('span', { className: 'qqc-ro' }, text)
        }
        if (field.type === 'bool') {
          return h(
            'select',
            {
              className: 'qqc-select',
              value: String(field.value === true),
              onChange: (event) => commit(field, event.target.value),
            },
            h('option', { value: 'true' }, '开启'),
            h('option', { value: 'false' }, '关闭'),
          )
        }
        const draftKey = field.key
        const draft = drafts[draftKey]
        const text = draft !== undefined ? draft : toText(field.value)
        return h('input', {
          className: field.overridden ? 'qqc-input overridden' : 'qqc-input',
          type: field.type === 'number' ? 'number' : 'text',
          value: text,
          spellCheck: false,
          onChange: (event) => setDrafts((prev) => ({ ...prev, [draftKey]: event.target.value })),
          onBlur: (event) => {
            const next = event.target.value
            if (next === toText(field.value)) return // 没改就不发请求
            commit(field, next)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          },
        })
      }

      if (fatal) {
        return h(
          'div',
          { className: 'qqc-page' },
          h('div', { className: 'qqc-title' }, 'QQ 伙伴'),
          h('div', { className: 'qqc-note err' }, `读不到插件配置：${fatal}`),
          h('div', { className: 'qqc-note' }, 'Host 半可能没加载，或者 webServer 服务不可用。'),
        )
      }

      if (!payload) {
        return h('div', { className: 'qqc-page' }, h('div', { className: 'qqc-title' }, 'QQ 伙伴'), h('div', { className: 'qqc-note' }, '正在读取配置…'))
      }

      // 分组：按字段 key 分。2026-11-19 重排过一次 —— 原先按前缀粗分，
      // 把「图片落盘目录」塞进了「连接」，而 selfId/ownerId/bindingSessionId
      // 三个掉进了"其他"（没有任何 group 匹配它们）。
      //
      // ⚠️ **match 必须互斥**：下面的 seen 只用来兜底"其他"分组，不用来
      // 过滤已渲染的字段。两个 group 同时匹配同一个 key → 那个字段会渲染两遍。
      const groups = [
        { title: '开关', match: (key) => key === 'enabled' || key === 'observeOnly' },
        // 身份：谁是机器人、谁是主人、怎么叫它
        {
          title: '身份',
          match: (key) => key === 'selfId' || key === 'ownerId' || key === 'names',
        },
        { title: '连接', match: (key) => key.startsWith('snowLuma.') },
        // 会话绑定：消息投到哪个 DSH 会话
        {
          title: '会话绑定',
          match: (key) => key === 'bindings' || key === 'bindingSessionId',
        },
        // 消息投递：缓冲期管的是"消息什么时候算定稿"，跟主动苏醒是两件事
        { title: '消息投递', match: (key) => key === 'wake.bufferSeconds' },
        // 主动苏醒：间隔、冷却、上限、时段、抖动、工作日
        {
          title: '主动苏醒',
          match: (key) => key.startsWith('wake.') && key !== 'wake.bufferSeconds',
        },
        { title: '存储', match: (key) => key === 'imageDir' },
      ]
      // 顶部状态行：连不上协议端时要一眼能看出来（照 MC 那页的做法）。
      const status = payload.status || {}
      const statusOk = status.ok === true
      const statusText = statusOk
        ? `协议端已连接${status.ws ? `（WS ${status.ws}）` : ''}${status.online === false ? ' · QQ 未在线' : ''}`
        : `未连接：${status.error || '协议端点未就绪'}`
      const statusNode = h(
        'div',
        { className: 'qqc-status' },
        h('span', { className: `qqc-statusDot ${statusOk ? 'ok' : 'err'}` }, '●'),
        h('span', null, statusText),
        status.stats ? h('span', { className: 'qqc-statusMeta' }, `已收 ${status.stats.received ?? 0} 条`) : null,
      )

      const seen = new Set()
      const blocks = []
      for (const group of groups) {
        const rows = (payload.fields || []).filter((field) => group.match(field.key))
        rows.forEach((row) => seen.add(row.key))
        if (rows.length === 0) continue
        blocks.push(
          h(
            'div',
            { className: 'qqc-group', key: group.title },
            h('div', { className: 'qqc-groupTitle' }, group.title),
            rows.map((field) =>
              h(
                'div',
                { className: 'qqc-row', key: field.key },
                h(
                  'div',
                  { className: 'qqc-label' },
                  h(
                    'div',
                    { className: 'qqc-labelText' },
                    field.overridden ? h('span', { className: 'qqc-dot', title: '已被设置页覆盖' }) : null,
                    field.label,
                    // 把代码里的真实 key 也显示出来。
                    //
                    // 起因（2026-11-19 用户）：会话里经常被要求「改一下
                    // wake.wakeIntervalSec」，但用户在设置页只看到「苏醒间隔（秒）」，
                    // 对不上号，得挨个试或者来问。把 key 直接摆在 label 后面就完了。
                    //
                    // user-select: all —— 点一下就能整段选中复制，省得手拖。
                    h('code', { className: 'qqc-key', title: '代码里的配置键（点一下可全选）' }, field.key),
                  ),
                  field.help ? h('div', { className: 'qqc-help' }, field.help) : null,
                ),
                h('div', { className: 'qqc-control' }, renderControl(field)),
              ),
            ),
          ),
        )
      }
      // 兜底：以后加字段忘了归组也不会消失
      const rest = (payload.fields || []).filter((field) => !seen.has(field.key))
      if (rest.length > 0) {
        blocks.push(
          h(
            'div',
            { className: 'qqc-group', key: '其他' },
            h('div', { className: 'qqc-groupTitle' }, '其他'),
            rest.map((field) =>
              h(
                'div',
                { className: 'qqc-row', key: field.key },
                h(
                  'div',
                  { className: 'qqc-label' },
                  h(
                    'div',
                    { className: 'qqc-labelText' },
                    field.label,
                    h('code', { className: 'qqc-key', title: '代码里的配置键（点一下可全选）' }, field.key),
                  ),
                ),
                h('div', { className: 'qqc-control' }, renderControl(field)),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'qqc-page' },
        h('div', { className: 'qqc-head' }, h('div', { className: 'qqc-title' }, 'QQ 伙伴')),
        h(
          'div',
          { className: 'qqc-sub' },
          '监听 QQ 消息并唤醒 agent 自主回复。改任何一项都**保存即生效**——连接地址变了会自动重连；只有总开关需要重启 DSH。',
        ),
        statusNode,
        blocks,
        message
          ? h('div', { className: `qqc-saveState ${message.kind === 'ok' ? 'ok' : 'err'}` }, message.text)
          : h('div', { className: 'qqc-saveState' }, ''),
        h('div', { className: 'qqc-note' }, `配置文件：${payload.settingsPath || '(未知)'}`),
      )
    }

    exports.name = 'dsh-qq-companion'

    /**
     * 只向 `settings.section` 槽注册页面。
     *
     * 🔴 `inject` 里**绝不能**出现可选服务 —— cordis 的插件级 inject 语义是
     * "声明的服务不出现就永久 pending"，会把整轮 web boot 拖垮。
     * 这里只需要 `slots`，它启动早期必定存在。
     */
    exports.inject = ['slots']

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: NS, order: 40, label: 'QQ 伙伴' }, QQSettingsPage),
      )
    }

    exports.apply = apply
    return module.exports
  },
})
