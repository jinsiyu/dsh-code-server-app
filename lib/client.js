// dsh-code-server — client bundle(侧栏按钮 + 全屏浮层 iframe)
// 格式:window.__ModuleLoader__.load({ id, factory });factory(require) 的
// require 解析浏览器端冻结模块表(react 等官方共享模块)。
//
// 数据通道:同源 fetch DSH webServer 上的 /code-server JSON API
//   GET  /code-server/status → { ok, running, status, port, host, pid, cwd, url, version, error, logTail, adopted }
//   POST /code-server/start  → { cwd? } → status
//   POST /code-server/stop   → status
//
// UI 结构:
//   - sidebar.footer.action(id code-server-panel):"Code Server"按钮;点击打开浮层并触发启动
//   - shell.overlay(id code-server):固定全屏浮层(顶栏 + iframe + 状态控件)
// 浮层默认接管 pointer-events(shell.overlay 层默认 click-through)。
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

    // ---------- 样式(主题变量 + 兜底值;仅覆盖我们自己的结构) ----------
    var CSS =
      '.dshcs-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#16161a);color:var(--dsw-alias-label-primary,#e8e8ec);pointer-events:auto}' +
      '.dshcs-toolbar{flex:none;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2a30);background:var(--dsw-alias-bg-layer-2,#1c1c22);font-size:13px;line-height:1.5}' +
      '.dshcs-dot{width:9px;height:9px;border-radius:50%;flex:none}' +
      '.dshcs-dot-running{background:#3fb950}' +
      '.dshcs-dot-starting{background:#d29922}' +
      '.dshcs-dot-error{background:#f85149}' +
      '.dshcs-dot-idle{background:#6e7681}' +
      '.dshcs-meta{color:var(--dsw-alias-label-secondary,#9a9aa3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}' +
      '.dshcs-btn{appearance:none;font:inherit;color:var(--dsw-alias-label-secondary,#c8c8d0);background:transparent;border:1px solid var(--dsw-alias-border-l2,#33333c);border-radius:7px;padding:4px 10px;cursor:pointer;white-space:nowrap}' +
      '.dshcs-btn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,#26262e)}' +
      '.dshcs-btn:disabled{opacity:.5;cursor:default}' +
      '.dshcs-frame{flex:1;min-height:0;border:0;background:#fff}' +
      '.dshcs-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}' +
      '.dshcs-emptybox{max-width:560px;text-align:left;background:var(--dsw-alias-bg-layer-2,#1c1c22);border:1px solid var(--dsw-alias-border-l2,#2a2a30);border-radius:12px;padding:16px 18px}' +
      '.dshcs-error{color:var(--dsw-alias-label-error,#f85149);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin:8px 0 0}' +
      '.dshcs-hint{color:var(--dsw-alias-label-tertiary,#7a7a85);font-size:12px;margin:6px 0 0}'
    var CSS_TAG = 'dsh-code-server/styles'
    if (typeof document !== 'undefined' && document.querySelector('style[data-dshcs=' + JSON.stringify(CSS_TAG) + ']') === null) {
      var tag = document.createElement('style')
      tag.setAttribute('data-dshcs', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
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

    // ---------- 全屏浮层 ----------
    function Overlay(props) {
      var store = useStore()
      var status = store.status
      var running = status != null && status.ok === true && status.running === true
      var starting = status != null && status.status === 'starting'
      var errored = status != null && status.ok === false
      var cwd = activeWorkspaceCwd(props && props.useSessions, props && props.useWorkspaces)
      // 上次同步(或打开服务)时的工作区;变化时自动重启并刷新 iframe
      var lastSyncedCwdRef = React.useRef(undefined)
      var [reloadTick, setReloadTick] = React.useState(0)

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

      // 跟随活动工作区:浮层打开期间,useSessions/useWorkspaces 快照变化
      // (切换会话/工作区)会传入新 cwd;与上次同步值不同则让 host 重启到新目录,
      // 重启成功后刷新 iframe。start 在 host 侧幂等:同 cwd 直接返回不切换。
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

      // 浮层关闭时重置跟随基线,下次打开重新对齐
      React.useEffect(function () {
        if (!store.open) lastSyncedCwdRef.current = undefined
      }, [store.open])

      // 打开期间每 3s 轮询状态(client bundle 内真实浏览器环境,window timers 可用)
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

      var dotClass = '.dshcs-dot-' + (running ? 'running' : starting ? 'starting' : errored ? 'error' : 'idle')
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
        if (status.cwd != null) metaBits.push('编辑器 cwd: ' + status.cwd)
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
        var errText = errored && status != null && status.error ? status.error : (starting ? '正在启动 code-server…' : 'code-server 未运行')
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

      return React.createElement('div', { className: 'dshcs-root', role: 'dialog', 'aria-label': 'Code Server' },
        React.createElement('div', { className: 'dshcs-toolbar' },
          React.createElement('span', { className: 'dshcs-dot ' + dotClass.slice(1) }),
          React.createElement('strong', null, 'Code Server'),
          React.createElement('span', { className: 'dshcs-meta' }, metaBits.join(' · ')),
          React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: !running, onClick: function () { setReloadTick(function (t) { return t + 1 }) } }, '重新加载'),
          React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: !running || pageUrl === null, onClick: function () { if (pageUrl !== null) window.open(pageUrl, '_blank', 'noopener') } }, '在新标签打开'),
          React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: store.busy || running, onClick: async function () { setState({ busy: true }); var s = await api('/code-server/start', typeof cwd === 'string' ? { cwd: cwd } : {}); setState({ status: s, busy: false }) } }, running ? '已运行' : '启动'),
          React.createElement('button', { type: 'button', className: 'dshcs-btn', disabled: store.busy || !running, onClick: async function () { setState({ busy: true }); var s = await api('/code-server/stop'); setState({ status: s, busy: false }) } }, '停止'),
          React.createElement('button', { type: 'button', className: 'dshcs-btn', onClick: function () { setState({ open: false }) } }, '关闭(Esc)')
        ),
        body
      )
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
        (props) => React.createElement(Overlay, props)
      ))
      console.log('[code-server] client bundle registered (sidebar action + overlay)')
    }

    exports.apply = apply
    exports.name = 'code-server'
    return module.exports
  }
})
