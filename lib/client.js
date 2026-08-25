// dsh-code-server — client bundle(侧栏按钮 + 内部浮动窗口 iframe)
// 格式:window.__ModuleLoader__.load({ id, factory });factory(require) 的
// require 解析浏览器端冻结模块表(react 等官方共享模块)。
//
// 数据通道:同源 fetch DSH webServer 上的 /code-server JSON API
//   GET  /code-server/status → { ok, running, status, port, host, pid, cwd, url, version, error, logTail, adopted }
//   POST /code-server/start  → { cwd? } → status
//   POST /code-server/stop   → status
//
// UI 结构(参照 dsh-univer-office 的 WorktreeWindow):
//   - sidebar.footer.action(id code-server-panel):"Code Server"按钮;点击打开窗口
//   - shell.overlay(id code-server):内部浮动窗口——固定定位 + 空转根容器,
//     窗口自身接管 pointer-events,可拖动/8 向缩放/最大化/折叠/关闭
//
// 窗口几何与手势完全复刻 univer-office 模式:
//   - 根容器 position:fixed inset:0 pointer-events:none(点击穿透到底层)
//   - 窗口 pointer-events:auto,标题栏 pointerdown 拖动(setPointerCapture),
//     双击最大化,8 个 resize handle 缩放,min 尺寸约束,viewport 边缘 clamp。
window.__ModuleLoader__.load({
  id: 'dsh-code-server',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ---------- 模块级共享 store(两个 occupant 之间同步 open/status) ----------
    var listeners = new Set()
    var state = { open: false, status: null, busy: false }
    function setState(patch) {
      state = Object.assign({}, state, patch)
      listeners.forEach(function (fn) { fn() })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    function getState() { return state }
    function useStore() {
      return React.useSyncExternalStore(subscribe, getState)
    }

    // ---------- /code-server API ----------
    async function api(path, body) {
      var options = { method: body === undefined ? 'GET' : 'POST', headers: {} }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      var res = await fetch(path, options)
      var text = await res.text()
      var data = null
      try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + (data !== null && data.error !== undefined ? ': ' + data.error : '') }
      return data !== null ? data : { ok: false, error: 'invalid JSON response' }
    }

    // 解析当前活动工作区目录,优先级:
    //   1. 当前会话的 cwd(useSessions.byId[current].cwd)
    //   2. 当前会话所属 workspace 的 path(workspace.sessionIds 含 current)
    //   3. recentWorkspaceId 对应 workspace 的 path
    //   4. 第一个 workspace 的 path
    // 均缺失时返回 undefined(调用方不传 cwd,由 host 保留当前目录)。
    function activeWorkspaceCwd(useSessions, useWorkspaces) {
      try {
        var list = useSessions(function (s) { return s })
        var wsList = useWorkspaces === null ? null : (typeof useWorkspaces === 'function' ? useWorkspaces(function (s) { return s }) : null)
        var current = list != null ? list.current : undefined
        if (current !== undefined && list != null && list.byId != null) {
          var cur = list.byId[current]
          if (cur != null && typeof cur.cwd === 'string' && cur.cwd !== '') return cur.cwd
        }
        var items = wsList != null && Array.isArray(wsList.items) ? wsList.items : []
        if (current !== undefined) {
          for (var i = 0; i < items.length; i++) {
            var w = items[i]
            if (w.sessionIds != null && w.sessionIds.indexOf(current) !== -1 && typeof w.path === 'string' && w.path !== '') return w.path
          }
        }
        var recentId = wsList != null ? wsList.recentWorkspaceId : undefined
        if (recentId !== undefined) {
          for (var j = 0; j < items.length; j++) {
            if (items[j].workspaceId === recentId && typeof items[j].path === 'string' && items[j].path !== '') return items[j].path
          }
        }
        if (items.length > 0 && typeof items[0].path === 'string' && items[0].path !== '') return items[0].path
      } catch (e) { /* props 未提供时静默 */ }
      return undefined
    }

    // ---------- 窗口几何(复刻 univer-office 的 fit/move/resize) ----------
    // 底部预留输入栏高度(可在设置卡片切换):true 时窗口初始/缩放/最大化
    // 都止于输入框上方,不遮挡 composer;false 时允许盖住输入框(最大化到视口底)。
    var RESIZE_DIRECTIONS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']
    var VIEWPORT_GUTTER = 12
    var DEFAULT_WIDTH = 720
    var DEFAULT_HEIGHT = 520
    var MIN_WIDTH = 360
    var MIN_HEIGHT = 260
    var CASCADE_OFFSET = 24
    var COMPOSER_RESERVE_DEFAULT = 148 // 输入框 + 下发 dock 的近似高度

    function reserveOf(flag) {
      return flag === false ? 0 : COMPOSER_RESERVE_DEFAULT
    }
    function viewportSize() {
      return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) }
    }
    /** 窗口可用的最大高度:视口高 - 上下 gutter - 输入栏预留(reserve 设为 0 时不预留)。 */
    function usableViewport(viewport, reserve) {
      return {
        width: Math.max(1, viewport.width - VIEWPORT_GUTTER * 2),
        height: Math.max(1, viewport.height - VIEWPORT_GUTTER * 2 - reserve),
      }
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }
    function fitRect(rect, viewport, reserve) {
      const available = usableViewport(viewport, reserve)
      const width = clamp(rect.width, Math.min(MIN_WIDTH, available.width), available.width)
      const height = clamp(rect.height, Math.min(MIN_HEIGHT, available.height), available.height)
      return {
        x: clamp(rect.x, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, viewport.width - VIEWPORT_GUTTER - width)),
        y: clamp(rect.y, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, viewport.height - VIEWPORT_GUTTER - reserve - height)),
        width, height,
      }
    }
    function initialRect(stackIndex, viewport, reserve) {
      const available = usableViewport(viewport, reserve)
      const width = Math.min(DEFAULT_WIDTH, available.width)
      const height = Math.min(DEFAULT_HEIGHT, available.height)
      // 初始位置:输入框上方、靠右(右下偏上),级联偏移;reserve=0 时贴底
      return fitRect({
        x: viewport.width - VIEWPORT_GUTTER - width - stackIndex * CASCADE_OFFSET,
        y: viewport.height - VIEWPORT_GUTTER - reserve - height - stackIndex * CASCADE_OFFSET,
        width, height,
      }, viewport, reserve)
    }
    function moveRect(start, dx, dy, viewport, reserve) {
      return fitRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport, reserve)
    }
    function resizeRect(start, direction, dx, dy, viewport, reserve) {
      const fitted = fitRect(start, viewport, reserve)
      const available = usableViewport(viewport, reserve)
      const minWidth = Math.min(MIN_WIDTH, available.width)
      const minHeight = Math.min(MIN_HEIGHT, available.height)
      const bottomLimit = viewport.height - VIEWPORT_GUTTER - reserve
      let left = fitted.x
      let right = fitted.x + fitted.width
      let top = fitted.y
      let bottom = fitted.y + fitted.height
      if (direction.includes('w')) left = clamp(fitted.x + dx, VIEWPORT_GUTTER, right - minWidth)
      if (direction.includes('e')) right = clamp(right + dx, left + minWidth, viewport.width - VIEWPORT_GUTTER)
      if (direction.includes('n')) top = clamp(fitted.y + dy, VIEWPORT_GUTTER, bottom - minHeight)
      if (direction.includes('s')) bottom = clamp(bottom + dy, top + minHeight, bottomLimit)
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
    /** 最大化矩形:占满"输入栏上方"区域(reserve=0 时到视口底)。 */
    function maximizedRect(viewport, reserve) {
      const available = usableViewport(viewport, reserve)
      return {
        x: VIEWPORT_GUTTER,
        y: VIEWPORT_GUTTER,
        width: available.width,
        height: available.height,
      }
    }

    // ---------- 样式(主题变量 + 兜底值;仅覆盖窗口自身结构) ----------
    var CSS =
      '.dshcs-root{position:fixed;inset:0;z-index:1200;pointer-events:none}' +
      '.dshcs-win{--dshcs-accent:#5b6cff;pointer-events:auto;position:fixed;isolation:isolate;display:flex;flex-direction:column;min-width:1px;min-height:1px;overflow:hidden;color:var(--dsw-alias-label-primary,#172033);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:16px;box-shadow:0 1px 2px rgba(13,22,38,.08),0 18px 48px rgba(13,22,38,.2),0 0 0 1px rgba(255,255,255,.4) inset;transition:border-color .16s ease,box-shadow .16s ease}' +
      '.dshcs-win:hover{border-color:color-mix(in srgb,var(--dshcs-accent) 28%,var(--dsw-alias-border-l2,#dfe3eb));box-shadow:0 2px 5px rgba(13,22,38,.1),0 22px 58px rgba(13,22,38,.24),0 0 0 1px rgba(255,255,255,.5) inset}' +
      '.dshcs-win[data-interaction]{transition:none;user-select:none}' +
      '.dshcs-win[data-interaction]::after{content:"";position:absolute;inset:0;z-index:18;background:transparent}' +
      '.dshcs-win-folded{height:48px!important}' +
      '.dshcs-win-max{border-radius:18px;z-index:1300}' +
      '.dshcs-header{position:relative;z-index:10;display:flex;align-items:center;gap:10px;height:48px;padding:0 8px 0 10px;flex:none;cursor:grab;touch-action:none;user-select:none;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 96%,#7583ff),color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 92%,#dfe3f5));border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#dfe3eb) 78%,transparent)}' +
      '.dshcs-win[data-interaction=move] .dshcs-header{cursor:grabbing}.dshcs-win-max .dshcs-header{cursor:default}.dshcs-win-folded .dshcs-header{border-bottom:0}' +
      '.dshcs-glyph{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:9px;color:#fff;background:linear-gradient(145deg,#2ea043,#1f883d);box-shadow:0 5px 12px rgba(31,136,61,.25)}' +
      '.dshcs-identity{display:flex;flex-direction:column;justify-content:center;min-width:0;flex:1;line-height:1.2}' +
      '.dshcs-title,.dshcs-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshcs-title{font-size:12.5px;font-weight:650;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#172033)}.dshcs-sub{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#7d8798)}' +
      '.dshcs-chip{display:inline-flex;align-items:center;gap:6px;flex:none;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:999px;font-size:10.5px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-secondary,#566174);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 75%,transparent)}' +
      '.dshcs-chip[data-status=running]{color:#16784d;border-color:color-mix(in srgb,#20a66a 30%,var(--dsw-alias-border-l2,#dfe3eb));background:color-mix(in srgb,#20a66a 8%,var(--dsw-alias-bg-base,#fff))}' +
      '.dshcs-chip[data-status=starting]{color:#9a6114;border-color:color-mix(in srgb,#d78b25 34%,var(--dsw-alias-border-l2,#dfe3eb));background:color-mix(in srgb,#d78b25 9%,var(--dsw-alias-bg-base,#fff))}' +
      '.dshcs-chip[data-status=error]{color:#b42318;border-color:color-mix(in srgb,#f85149 30%,var(--dsw-alias-border-l2,#dfe3eb));background:color-mix(in srgb,#f85149 8%,var(--dsw-alias-bg-base,#fff))}' +
      '.dshcs-dot,.dshcs-pulse{position:relative;width:7px;height:7px;border-radius:50%;background:#20a66a;flex:none}.dshcs-pulse::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1px solid currentColor;opacity:.24;animation:dshcs-pulse 2s ease-out infinite}' +
      '.dshcs-chip[data-status=starting] .dshcs-dot{background:#d78b25}.dshcs-chip[data-status=starting] .dshcs-dot::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1px solid currentColor;opacity:.24;animation:dshcs-pulse 2s ease-out infinite}' +
      '.dshcs-chip[data-status=error] .dshcs-dot{background:#f85149}.dshcs-chip[data-status=idle] .dshcs-dot{background:#7d8798}' +
      '@keyframes dshcs-pulse{0%{transform:scale(.7);opacity:.35}70%,100%{transform:scale(1.65);opacity:0}}' +
      '.dshcs-controls{display:flex;align-items:center;gap:3px;flex:none}' +
      '.dshcs-ctl{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary,#566174);background:transparent;cursor:pointer;transition:color .12s ease,background .12s ease,transform .12s ease}' +
      '.dshcs-ctl:hover{color:var(--dsw-alias-label-primary,#172033);background:color-mix(in srgb,var(--dsw-alias-label-primary,#172033) 8%,transparent)}' +
      '.dshcs-ctl:active{transform:scale(.92)}.dshcs-ctl:focus-visible{outline:2px solid color-mix(in srgb,var(--dshcs-accent) 65%,transparent);outline-offset:1px}' +
      '.dshcs-ctl[data-danger]:hover{color:#d94242;background:rgba(217,66,66,.1)}' +
      '.dshcs-ctl svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}' +
      '.dshcs-body{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:var(--dsw-alias-bg-base,#fff)}.dshcs-body[hidden]{display:none}' +
      '.dshcs-toolbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#dfe3eb);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 94%,#edf0f8);font-size:11.5px;line-height:1.5}' +
      '.dshcs-btn{appearance:none;font:inherit;color:var(--dsw-alias-label-secondary,#566174);background:transparent;border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:7px;padding:3px 9px;cursor:pointer;white-space:nowrap}' +
      '.dshcs-btn:hover{color:var(--dsw-alias-label-primary,#172033);background:color-mix(in srgb,var(--dsw-alias-label-primary,#172033) 8%,transparent)}' +
      '.dshcs-btn:disabled{opacity:.5;cursor:default}' +
      '.dshcs-meta{color:var(--dsw-alias-label-secondary,#566174);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}' +
      '.dshcs-frame{display:block;flex:1;min-width:0;min-height:0;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}' +
      '.dshcs-emptybox{max-width:560px;text-align:left;background:var(--dsw-alias-bg-layer-2,#f7f8fb);border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:12px;padding:16px 18px}' +
      '.dshcs-error{color:var(--dsw-alias-label-error,#d92d20);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin:8px 0 0}' +
      '.dshcs-hint{color:var(--dsw-alias-label-tertiary,#7d8798);font-size:12px;margin:6px 0 0}' +
      '.dshcs-resize{position:absolute;z-index:20;display:block;touch-action:none}' +
      '.dshcs-resize-n,.dshcs-resize-s{left:16px;right:16px;height:10px;cursor:ns-resize}.dshcs-resize-n{top:0}.dshcs-resize-s{bottom:0}' +
      '.dshcs-resize-w,.dshcs-resize-e{top:16px;bottom:16px;width:10px;cursor:ew-resize}.dshcs-resize-w{left:0}.dshcs-resize-e{right:0}' +
      '.dshcs-resize-nw,.dshcs-resize-ne,.dshcs-resize-sw,.dshcs-resize-se{width:18px;height:18px}' +
      '.dshcs-resize-nw{left:0;top:0;cursor:nwse-resize}.dshcs-resize-ne{right:0;top:0;cursor:nesw-resize}.dshcs-resize-sw{left:0;bottom:0;cursor:nesw-resize}.dshcs-resize-se{right:0;bottom:0;cursor:nwse-resize}' +
      '.dshcs-resize-se::after{content:"";position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-right:1.5px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d8798) 58%,transparent);border-bottom:1.5px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d8798) 58%,transparent);border-radius:0 0 2px}'
    var CSS_TAG = 'dsh-code-server/styles'
    if (typeof document !== 'undefined' && document.querySelector('style[data-dshcs=' + JSON.stringify(CSS_TAG) + ']') === null) {
      var tag = document.createElement('style')
      tag.setAttribute('data-dshcs', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------- 小图标 ----------
    function Glyph() {
      return React.createElement('svg', { viewBox: '0 0 18 18', 'aria-hidden': true },
        React.createElement('rect', { x: '3', y: '3', width: '12', height: '12', rx: '2' }),
        React.createElement('path', { d: 'M3 7h12M7 3v12' })
      )
    }
    function FoldIcon(props) {
      return React.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
        props.expanded
          ? React.createElement('path', { d: 'm4 10 4-4 4 4' })
          : React.createElement('path', { d: 'M4 9h8' })
      )
    }
    function MaximizeIcon(props) {
      return React.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
        props.restored
          ? React.createElement(React.Fragment, null,
              React.createElement('rect', { x: '3', y: '5', width: '8', height: '8', rx: '1' }),
              React.createElement('path', { d: 'M5 5V3h8v8h-2' })
            )
          : React.createElement('rect', { x: '3', y: '3', width: '10', height: '10', rx: '1.5' })
      )
    }
    function CloseIcon() {
      return React.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
        React.createElement('path', { d: 'm4 4 8 8m0-8-8 8' })
      )
    }

    // ---------- 侧栏按钮 ----------
    function SidebarAction(props) {
      var store = useStore()
      function openPanel() {
        setState({ open: true })
      }
      var label = store.open ? 'Code Server…' : 'Code Server'
      return React.createElement(
        'button',
        { type: 'button', onClick: openPanel, title: '在 DSH 内打开 code-server(VS Code 网页版)', style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { 'aria-hidden': true, style: { fontSize: 14 } }, '⌘'),
        props && props.wide === true ? React.createElement('span', null, label) : null
      )
    }

    // ---------- 内部浮动窗口(参照 univer-office WorktreeWindow) ----------
    function Window(props) {
      var store = useStore()
      var status = store.status
      var running = status != null && status.ok === true && status.running === true
      var starting = status != null && status.status === 'starting'
      var errored = status != null && status.ok === false
      var cwd = activeWorkspaceCwd(props && props.useSessions, props && props.useWorkspaces)
      // 上次同步(或打开服务)时的工作区;变化时自动重启并刷新 iframe
      var lastSyncedCwdRef = React.useRef(undefined)
      var [reloadTick, setReloadTick] = React.useState(0)

      // ---- 窗口状态与手势(复刻 univer-office 的 WorktreeWindow) ----
      // reserveComposer(设置卡片):true 不盖输入框;false 允许盖住(最大化到视口底)。
      var reserve = reserveOf(status != null ? status.reserveComposer : true)
      var [folded, setFolded] = React.useState(false)
      var [maximized, setMaximized] = React.useState(false)
      var [interaction, setInteraction] = React.useState(null)
      var [rect, setRect] = React.useState(function () { return initialRect(0, viewportSize(), reserve) })
      var rectRef = React.useRef(rect)
      var cancelPointerSessionRef = React.useRef(function () {})
      rectRef.current = rect
      React.useEffect(function () {
        var onViewportResize = function () {
          setRect(function (current) {
            // 最大化时保持占满"输入栏上方"区域;否则仅 fit 防止越界
            return maximized ? maximizedRect(viewportSize(), reserve) : fitRect(current, viewportSize(), reserve)
          })
        }
        window.addEventListener('resize', onViewportResize)
        return function () { window.removeEventListener('resize', onViewportResize) }
      }, [maximized, reserve])
      // 设置变化(reserve 切换)时重新 fit 当前 rect(立即生效,不遮挡/不越界)
      React.useEffect(function () {
        setRect(function (current) { return fitRect(current, viewportSize(), reserve) })
      }, [reserve])
      React.useEffect(function () {
        return function () { cancelPointerSessionRef.current() }
      }, [])

      var beginPointerSession = function (event, kind) {
        if (event.button !== 0 || maximized) return
        event.preventDefault()
        event.stopPropagation()
        cancelPointerSessionRef.current()
        var view = event.currentTarget.ownerDocument.defaultView
        if (view === null) return
        var pointerId = event.pointerId
        var origin = { x: event.clientX, y: event.clientY }
        var start = rectRef.current
        var element = event.currentTarget
        setInteraction(kind)
        try { element.setPointerCapture(pointerId) } catch (e) { /* capture 失败仍可跟随 */ }
        var move = function (next) {
          if (next.pointerId !== pointerId) return
          var dx = next.clientX - origin.x
          var dy = next.clientY - origin.y
          setRect(kind === 'move' ? moveRect(start, dx, dy, viewportSize(), reserve) : resizeRect(start, kind, dx, dy, viewportSize(), reserve))
        }
        var cleanup = function () {
          view.removeEventListener('pointermove', move)
          view.removeEventListener('pointerup', finish)
          view.removeEventListener('pointercancel', finish)
          cancelPointerSessionRef.current = function () {}
          try { element.releasePointerCapture(pointerId) } catch (e) { /* ignore */ }
        }
        var finish = function (next) {
          if (next.pointerId !== pointerId) return
          cleanup()
          setInteraction(null)
        }
        cancelPointerSessionRef.current = cleanup
        view.addEventListener('pointermove', move)
        view.addEventListener('pointerup', finish)
        view.addEventListener('pointercancel', finish)
      }

      var toggleFolded = function () {
        setMaximized(false)
        setFolded(function (current) { return !current })
      }
      var toggleMaximized = function () {
        setFolded(false)
        setMaximized(function (current) { return !current })
      }
      var onHeaderPointerDown = function (event) {
        if (event.target.closest('[data-window-control]') !== null) return
        beginPointerSession(event, 'move')
      }
      var onHeaderDoubleClick = function (event) {
        if (event.target.closest('[data-window-control]') === null) toggleMaximized()
      }

      // ---- 生命周期/数据同步(与原全屏浮层一致) ----
      // 打开时:拉状态;未运行则尝试启动(带当前会话 cwd)
      React.useEffect(function () {
        if (!store.open) return
        var cancelled = false
        async function boot() {
          setState({ busy: true })
          var s = await api('/code-server/status')
          if (cancelled) return
          if (s != null && s.ok === true && s.running === true) {
            setState({ status: s, busy: false })
            return
          }
          var started = await api('/code-server/start', typeof cwd === 'string' ? { cwd: cwd } : {})
          if (cancelled) return
          setState({ status: started, busy: false })
        }
        boot()
        return function () { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [store.open])

      // 跟随活动工作区:快照变化(切换会话/工作区)自动重启到新目录,成功后刷新 iframe
      React.useEffect(function () {
        if (!store.open) return
        if (typeof cwd !== 'string' || cwd === '') return
        if (lastSyncedCwdRef.current === cwd) return
        var changed = lastSyncedCwdRef.current !== undefined && lastSyncedCwdRef.current !== cwd
        lastSyncedCwdRef.current = cwd
        var cancelled = false
        async function sync() {
          setState({ busy: true })
          var s = await api('/code-server/start', { cwd: cwd })
          if (cancelled) return
          setState({ status: s, busy: false })
          if (changed && s != null && s.ok === true && s.running === true) {
            setReloadTick(function (t) { return t + 1 })
          }
        }
        sync()
        return function () { cancelled = true }
      }, [store.open, cwd])

      // 窗口关闭时重置跟随基线,下次打开重新对齐
      React.useEffect(function () {
        if (!store.open) lastSyncedCwdRef.current = undefined
      }, [store.open])

      // 打开期间每 3s 轮询状态
      React.useEffect(function () {
        if (!store.open) return
        var timer = window.setInterval(function () {
          api('/code-server/status').then(function (s) { setState({ status: s }) })
        }, 3000)
        return function () { window.clearInterval(timer) }
      }, [store.open])

      // Esc 关闭
      React.useEffect(function () {
        if (!store.open) return
        function onKey(e) {
          if (e.key === 'Escape') setState({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [store.open])

      if (!store.open) return null

      var statusKind = running ? 'running' : starting ? 'starting' : errored ? 'error' : 'idle'
      var statusLabel = running ? '运行中' : starting ? '启动中…' : errored ? '错误' : '未运行'

      var baseUrl = status != null && typeof status.url === 'string' ? status.url : null
      // code-server 前端记住"最近工作区"并自行恢复;必须用 ?folder= 显式指定
      // 打开目录,否则 iframe 裸根 URL 会显示上一次的工具区(不跟随切换)。
      //
      // folder 参数格式(实测):VS Code web 要求以 "/" 开头的平台路径——Windows
      // 盘符路径必须统一为正斜杠并加前导 "/"(/C:/Users/...)。裸 Windows 路径
      // (C:\Users\...) 会被前端当 URI scheme 解析而剥掉盘符,file:/// 形式则报
      // "Workspace does not exist"。
      var activeDir = running && status != null && typeof status.cwd === 'string' && status.cwd !== '' ? status.cwd : null
      var folderParam = null
      if (activeDir !== null) {
        var normalized = activeDir.replace(/\\/g, '/')
        folderParam = normalized
        if (/^[A-Za-z]:\//.test(normalized)) folderParam = '/' + normalized
        else if (normalized.charCodeAt(0) !== 47) folderParam = '/' + normalized
      }
      var pageUrl = baseUrl !== null
        ? baseUrl + (folderParam !== null ? '?folder=' + encodeURIComponent(folderParam) : '')
        : null

      var metaBits = []
      if (status != null) {
        if (status.host != null) metaBits.push(String(status.host) + ':' + String(status.port))
        if (status.cwd != null) metaBits.push('cwd: ' + status.cwd)
        if (status.adopted === true) metaBits.push('接管既有实例')
      }
      if (typeof cwd === 'string' && cwd !== '') {
        metaBits.push(running && status != null && typeof status.cwd === 'string' && status.cwd !== cwd
          ? '目标: ' + cwd + '(切换即重启)'
          : '跟随: ' + cwd)
      }

      var body
      if (running && pageUrl !== null) {
        body = React.createElement('iframe', {
          key: reloadTick,
          className: 'dshcs-frame',
          src: pageUrl,
          title: 'code-server',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock',
        })
      } else {
        var errText = errored && status != null && status.error
          ? status.error
          : (starting ? '正在启动 code-server…' : 'code-server 未运行')
        body = React.createElement('div', { className: 'dshcs-empty' },
          React.createElement('div', { className: 'dshcs-emptybox' },
            React.createElement('div', null, starting ? '正在启动 code-server…' : errored ? 'code-server 启动失败' : 'code-server 未运行'),
            React.createElement('pre', { className: 'dshcs-error' }, errText),
            React.createElement('p', { className: 'dshcs-hint' },
              '安装命令(Windows 原生):npm install -g code-server@latest(需配套最新版 node-gyp 与 VS Spectre 缓解库);' +
              '或在 cordis.patch.yml 的 code-server config 中设置 bin 指向已安装位置。' +
              '端口 ' + (status != null ? status.port : '8090') + ' 被占用时请释放或修改 port 配置。')
          ))
      }

      var className = ['dshcs-win', folded ? 'dshcs-win-folded' : '', maximized ? 'dshcs-win-max' : ''].filter(Boolean).join(' ')
      // 最大化由 rect 驱动(maximizedRect 占满"输入栏上方"区域),不用 CSS inset;
      // 还原时回到拖动前的位置。
      var shownRect = maximized ? maximizedRect(viewportSize(), reserve) : rect
      var style = { left: shownRect.x, top: shownRect.y, width: shownRect.width, height: shownRect.height }

      return React.createElement('section', {
          className: className,
          style: style,
          'data-interaction': interaction !== null ? interaction : undefined,
          role: 'dialog',
          'aria-label': 'Code Server',
        },
        React.createElement('header', {
          className: 'dshcs-header',
          onPointerDown: onHeaderPointerDown,
          onDoubleClick: onHeaderDoubleClick,
        },
          React.createElement('span', { className: 'dshcs-glyph', 'aria-hidden': true }, React.createElement(Glyph, null)),
          React.createElement('span', { className: 'dshcs-identity' },
            React.createElement('span', { className: 'dshcs-title' }, 'Code Server'),
            React.createElement('span', { className: 'dshcs-sub' }, metaBits.length > 0 ? metaBits.join(' · ') : 'VS Code 网页版')
          ),
          React.createElement('span', { className: 'dshcs-chip', 'data-status': statusKind },
            React.createElement('span', { className: 'dshcs-dot', 'aria-hidden': true }),
            statusLabel
          ),
          React.createElement('span', { className: 'dshcs-controls' },
            React.createElement('button', {
              type: 'button', className: 'dshcs-ctl', 'data-window-control': '', title: folded ? '展开' : '折叠',
              'aria-label': folded ? '展开' : '折叠', onClick: toggleFolded,
            }, React.createElement(FoldIcon, { expanded: folded })),
            React.createElement('button', {
              type: 'button', className: 'dshcs-ctl', 'data-window-control': '', title: maximized ? '还原' : '最大化',
              'aria-label': maximized ? '还原' : '最大化', onClick: toggleMaximized,
            }, React.createElement(MaximizeIcon, { restored: maximized })),
            React.createElement('button', {
              type: 'button', className: 'dshcs-ctl', 'data-window-control': '', 'data-danger': '', title: '关闭(Esc)',
              'aria-label': '关闭', onClick: function () { setState({ open: false }) },
            }, React.createElement(CloseIcon, null))
          )
        ),
        React.createElement('div', { className: 'dshcs-body', hidden: folded },
          React.createElement('div', { className: 'dshcs-toolbar' },
            React.createElement('span', { className: 'dshcs-meta' }, metaBits.join(' · ')),
            React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: !running, onClick: function () { setReloadTick(function (t) { return t + 1 }) } }, '重新加载'),
            React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: !running || pageUrl === null, onClick: function () { if (pageUrl !== null) window.open(pageUrl, '_blank', 'noopener') } }, '新标签打开'),
            React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: store.busy || running, onClick: async function () { setState({ busy: true }); var s = await api('/code-server/start', typeof cwd === 'string' ? { cwd: cwd } : {}); setState({ status: s, busy: false }) } }, running ? '已运行' : '启动'),
            React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: store.busy || !running, onClick: async function () { setState({ busy: true }); var s = await api('/code-server/stop'); setState({ status: s, busy: false }) } }, '停止')
          ),
          body
        ),
        !folded && !maximized
          ? RESIZE_DIRECTIONS.map(function (direction) {
              return React.createElement('span', {
                key: direction,
                className: 'dshcs-resize dshcs-resize-' + direction,
                'data-direction': direction,
                onPointerDown: function (event) { beginPointerSession(event, direction) },
              })
            })
          : null
      )
    }

    // ---------- 设置卡片(参照 auto-open-web 的自绘卡片模式) ----------
    // 数据通道:settingsScope(官方 settings 域,命名空间 code-server);
    // 插槽:settings.plugin.item(keyed 注册,卡片自绘,观感对齐官方设计令牌)。
    var CARD_CSS =
      '.dshcs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}' +
      '.dshcs-card:hover{border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2))}' +
      '.dshcs-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2))}' +
      '.dshcs-cardHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.dshcs-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.dshcs-cardHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.dshcs-cardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.dshcs-cardDescription{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px;line-height:1.5}' +
      '.dshcs-cardChevron{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;transition:transform .16s;display:inline-flex}' +
      '.dshcs-cardChevronOpen{transform:rotate(180deg)}' +
      '.dshcs-cardBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
      '.dshcs-cardReadOnly{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:12px 0 0;font-size:12px;line-height:1.5}' +
      '.dshcs-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.dshcs-cardFooter{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +
      '.dshcs-cardFailed{min-width:0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary));flex:1;margin:0;font-size:12px;line-height:1.5}' +
      '.dshcs-cbtn{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;border:1px solid transparent}' +
      '.dshcs-cbtn:disabled{opacity:.55;cursor:default}' +
      '.dshcs-cbtnOutline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}' +
      '.dshcs-cbtnOutline:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.dshcs-cbtnPrimary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff);border-color:var(--dsw-alias-brand-primary);font-weight:600}' +
      '.dshcs-cbtnPrimary:hover:not(:disabled){filter:brightness(.95)}' +
      '.dshcs-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
      '.dshcs-field+.dshcs-field{border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.dshcs-fieldHead{align-items:center;gap:8px;display:flex}' +
      '.dshcs-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}' +
      '.dshcs-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;line-height:1.5}' +
      '.dshcs-check{display:flex;align-items:center;gap:8px;cursor:pointer}' +
      '.dshcs-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;margin:0;flex:none}' +
      '.dshcs-check input:disabled{cursor:default}' +
      '.dshcs-badges{align-items:center;gap:8px;display:inline-flex}' +
      '.dshcs-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.dshcs-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}' +
      '.dshcs-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.dshcs-reset:disabled{cursor:default}'
    var CARD_TAG = 'dsh-code-server/Card.module.css'
    function injectCss(tagId, css) {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-code-server'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }
    injectCss(CARD_TAG, CARD_CSS)

    function csIconChevron(props) {
      return React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true, className: props.className,
      },
        React.createElement('path', {
          d: 'M3.5 5.25L7 8.75L10.5 5.25', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        })
      )
    }
    function csBtn(props) {
      return React.createElement('button', {
        type: 'button',
        className: 'dshcs-cbtn ' + (props.variant === 'primary' ? 'dshcs-cbtnPrimary' : 'dshcs-cbtnOutline'),
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }
    function csCheck(props) {
      return React.createElement('label', { className: 'dshcs-check' },
        React.createElement('input', {
          type: 'checkbox', checked: props.checked === true, disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.checked) },
        }),
        React.createElement('span', { className: 'dshcs-hint' }, props.children)
      )
    }
    function csBadges(props) {
      var children = []
      if (props.overridden === true) {
        children.push(React.createElement('span', { className: 'dshcs-badge' }, props.overriddenLabel))
        children.push(React.createElement('button', { type: 'button', className: 'dshcs-reset', disabled: props.disabled === true, onClick: props.onReset }, props.resetLabel))
      }
      if (children.length === 0) return null
      return React.createElement('span', { className: 'dshcs-badges' }, ...children)
    }
    function csCard(props) {
      var [open, setOpen] = React.useState(false)
      var state = props.state
      if (state === null || state === undefined || state.available !== true) return null
      var title = props.title
      var blocked = state.dirty !== true && state.invalid !== true && state.saving !== true
      var saveDisabled = !state.dirty || state.invalid || state.saving
      return React.createElement('li', { className: 'dshcs-card' + (open ? ' dshcs-cardOpen' : '') },
        React.createElement('button', {
          type: 'button', className: 'dshcs-cardHeader', 'aria-expanded': open,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { className: 'dshcs-cardHeadText' },
            React.createElement('span', { className: 'dshcs-cardName' }, title),
            React.createElement('span', { className: 'dshcs-cardDescription' }, props.description)
          ),
          state.dirty === true ? React.createElement('span', { className: 'dshcs-pending' }, props.unsavedLabel) : null,
          React.createElement(csIconChevron, { className: 'dshcs-cardChevron' + (open ? ' dshcs-cardChevronOpen' : '') })
        ),
        open === true ? React.createElement('div', { className: 'dshcs-cardBody' },
          state.writable !== true ? React.createElement('p', { className: 'dshcs-cardReadOnly', role: 'status' }, props.readOnlyLabel) : null,
          props.children,
          React.createElement('div', { className: 'dshcs-cardFooter' },
            state.failed === true ? React.createElement('p', { className: 'dshcs-cardFailed', role: 'status' }, props.saveFailedLabel) : null,
            React.createElement(csBtn, { disabled: state.dirty !== true || state.saving === true, onClick: props.onDiscard }, props.discardLabel),
            React.createElement(csBtn, { variant: 'primary', disabled: saveDisabled, onClick: props.onSave }, state.saving === true ? props.savingLabel : props.saveLabel)
          )
        ) : null
      )
    }

    /** 设置卡片页面:reserveComposer 开关(是否保留输入框上方空间)。 */
    function csSettingsPage(props) {
      var state = props.useCsCard(function (s) { return s })
      return React.createElement(csCard, {
        title: 'Code Server',
        description: '窗口行为:是否保留输入框上方空间(不遮挡 composer)',
        state: state,
        unsavedLabel: '未保存', readOnlyLabel: '本部署的设置为只读。',
        saveFailedLabel: '本部署没有接受这些值，已保留供你修改。',
        discardLabel: '放弃修改', saveLabel: '保存', savingLabel: '保存中…',
        onSave: props.save, onDiscard: props.discard,
      },
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '保留输入框上方空间'),
            state.reserveComposer !== undefined && state.reserveComposer.overridden === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: state.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { props.resetField('reserveComposer') },
                })
              : null
          ),
          React.createElement(csCheck, {
            checked: state.reserveComposer !== undefined ? state.reserveComposer.text === true : true,
            disabled: state.writable !== true,
            onChange: function (v) { props.edit('reserveComposer', v) },
          }, '开启时窗口初始/缩放/最大化止于输入框上方;关闭后允许盖住输入框(最大化到视口底)')
        )
      )
    }

    // ---------- 设置卡片控制器(设置域 → 投影 store + 表单动作) ----------
    // 参照 auto-open-web:settingsScope 提供 { getSnapshot() → { status, writable,
    // value, base, user }, set/unset };单字段 reserveComposer。
    var runtime2 = null
    try {
      runtime2 = require('@deepseek-ai/dsh-client-runtime')
    } catch (e) {
      console.error('[code-server] runtime require failed:', e !== null && e !== undefined && e.message !== undefined ? e.message : String(e))
    }
    var createSnapshotStore = runtime2 !== null && runtime2.createSnapshotStore !== undefined ? runtime2.createSnapshotStore : fallbackSnapshotStore
    function fallbackSnapshotStore(init) {
      var value = init
      var listeners = new Set()
      return {
        getSnapshot: function () { return value },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: function (next) {
          value = next
          for (var listener of [...listeners]) listener(value)
        },
      }
    }

    function cardProjection(scope) {
      return function () {
        var snapshot = scope.getSnapshot()
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: false, invalid: false, saving: false, failed: false,
          reserveComposer: booleanFieldView(snapshot, 'reserveComposer'),
        }
      }
    }
    function booleanFieldView(snapshot, field) {
      var value = snapshot.value !== undefined && snapshot.value !== null ? snapshot.value[field] : undefined
      var user = snapshot.user
      var overridden = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, field)
      return { text: value === true, overridden: overridden }
    }
    function createCardController(scope, store) {
      var staged = null // null | boolean(未保存草稿);null 表示无草稿
      var saving = false
      var failed = false
      var listeners = new Set()
      function publish() {
        var projection = cardProjection(scope)()
        projection.dirty = staged !== null
        projection.saving = saving
        projection.failed = failed
        store.set(projection)
        for (var listener of [...listeners]) listener(projection)
      }
      scope.subscribe(function () { publish() })
      return {
        inject: function () {
          return {
            hooks: { csCard: store },
            edit: function (field, value) {
              if (field !== 'reserveComposer') return
              staged = value === true
              failed = false
              publish()
            },
            resetField: function (field) {
              if (field !== 'reserveComposer') return
              staged = null
              failed = false
              publish()
            },
            save: async function () {
              if (staged === null || saving) return
              var snapshot = scope.getSnapshot()
              var base = snapshot.base !== undefined && snapshot.base !== null ? snapshot.base : {}
              var current = snapshot.value !== undefined && snapshot.value !== null ? snapshot.value : base
              var value = staged === true
              if (current.reserveComposer === value) { staged = null; publish(); return }
              saving = true
              failed = false
              publish()
              try {
                // 官方 settings 域写入:set 到 user 层;base 未定义时直接 set
                if (base.reserveComposer !== undefined || Object.prototype.hasOwnProperty.call(base, 'reserveComposer')) {
                  await scope.set('reserveComposer', value)
                } else {
                  await scope.set('reserveComposer', value)
                }
                var user = scope.getSnapshot().value
                if (user !== undefined && user !== null && user.reserveComposer === value) {
                  staged = null
                } else {
                  failed = true
                }
              } catch (e) {
                failed = true
              }
              saving = false
              publish()
            },
            discard: function () {
              staged = null
              failed = false
              publish()
            },
          }
        },
      }
    }

    // ---------- 插件注册 ----------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) {
        console.error('[code-server] slots service unavailable')
        return
      }
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'code-server-panel', order: 60, label: 'Code Server' },
        (props) => React.createElement(SidebarAction, props)
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'code-server', order: 70, label: 'Code Server' },
        (props) => React.createElement(Window, props)
      ))

      // ---- 设置卡片(settings.plugin.item 插槽 + settingsScope 命名空间) ----
      var settingsScope = ctx.get('settingsScope')
      if (settingsScope === undefined || typeof settingsScope.bind !== 'function') {
        console.error('[code-server] settingsScope unavailable; settings card disabled')
        return
      }
      ctx.effect(function () {
        var scope = settingsScope.bind({ namespace: 'code-server' })
        var store = createSnapshotStore(cardProjection(scope))
        var controller = createCardController(scope, store)
        var dispose = slots.inject('settings.plugin.item', () => slots.register(
          { name: 'settings.plugin.item', key: 'code-server', label: 'Code Server', inject: () => controller.inject() },
          csSettingsPage
        ))
        return function () { dispose() }
      }, 'code-server: settings card')

      console.log('[code-server] client bundle registered (sidebar action + floating window + settings card)')
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    exports.name = 'code-server'
    return module.exports
  }
})
