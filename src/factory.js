// dsh-code-server — client bundle(右侧栏标签常驻 iframe;**只支持带右侧栏的 DSH**)
// 构建:node scripts/build-client.mjs → lib/client.js。
// 产物形态:window.__ModuleLoader__.load({ id, factory })——esbuild 以 CJS 打包,
// 整个 bundle 内嵌进 factory 函数体,静态 require('react'/'react/jsx-runtime')
// 直接落在 factory 的 require 参数上(DSH 冻结模块表;种子含 react/jsx-runtime)。
// 唯一源码:src/factory.js;改动后执行 `pnpm run build:client` 重新生成 lib/client.js。
//
// 数据通道:同源 fetch DSH Connection 的共享 /api 通道(host: ctx.connection.fetch.register)
//   GET  /api/code-server/status → { ok, running, status, port, host, pid, cwd, url, version, error, logTail, adopted }
//   POST /api/code-server/start  → { cwd? } → status
//   POST /api/code-server/stop   → status
//   POST /api/code-server/setup / open-file
//   POST /api/code-server/ui-mode → { sidebar: boolean }(客户端上报本部署是否带右侧栏)
// web 与 desktop 路径相同:web 由 webServer 的 /api 前缀承载,desktop 由 IPC 帧管道承载 → 插件不依赖 webServer。
//
// UI 载体:仅**右侧栏标签**一种(DSH ≥ 0.1.5-alpha.1 的 sidebarRightTabs / sidebarRight 服务):
//     - 一段:ctx.sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })
//       → 右侧栏 guide 页出现入口框(data-sidebar-right-guide-entry="code-server")
//     - 二段:ctx.slots.register({ name:'sidebar.right.pane.tab', key:id }, CodeServerBody)
//       → tab 内渲染常驻 code-server iframe;body 经 props.useTabInfo() 取 navigation/visible
//
// 0.2.3 起**不再兼容旧版 DSH**:不再提供悬浮球与内部浮动窗口回退。
// 探测不到右侧栏服务时,除「设置 → 插件 → Code Server」的一条提示外,不注册任何 UI,
// 也不预热/启动 IDE;同时上报 host(/ui-mode),让 host 停掉已自动预启动的实例。
import {
  dockInto,
  ensureSurface,
  parkSurface,
  preloadSurface,
  setSurfaceSrc,
  subscribeSurface,
  supportsMoveBefore,
  surfaceSnapshot,
} from './surface.js';

// 工厂体:module/exports/require 由构建产物外层的 factory 参数提供(见 footer/banner)
let React = require('react')

    // ---------- 模块级共享 store:同步 status/busy + UI 载体状态 ----------
    var listeners = new Set()
    // sidebarUi:'unknown'(未探测)| 'modern'(右侧栏服务就绪)| 'legacy'(旧版 DSH,只提示)
    var state = { status: null, busy: false, sidebarActive: false, sidebarUi: 'unknown' }
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

    // ---------- /api/code-server API ----------
    // 通道:DSH Connection 服务的共享 /api 通道(host 侧 ctx.connection.fetch.register)。
    // web 由 webServer 的 /api 前缀承载,desktop 由 IPC 帧管道承载 → 客户端只写相对路径,
    // 不再依赖 /code-server/* 这类 webServer 专有路由。
    var API_PREFIX = '/api'
    // code-server 官方图标(assets/favicon.svg 内联为 data URI)。
    // 内联原因:插件不再注册任何 HTTP 路由(desktop 无 webServer),图标不依赖服务端路径。
    var ICON_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB2aWV3Qm94PSIwIDAgMTQ3IDE0NyIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8c3R5bGU+QG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaykgeyogeyBmaWxsOiB3aGl0ZTsgfX08L3N0eWxlPgogIDxwYXRoIGQ9Im00Mi40MjE0LDM5LjY1NWMtMjQuNDA1NywwIC00Mi4xNTU0LDEzLjE3MjEgLTQyLjE1NTQsMzMuODQ1YzAsMjAuNTgxNCAxOC40ODkyLDMzLjg0NSA0Mi4xNTU0LDMzLjg0NWMyMy42NjYyLDAgMzguMTgwMywtMTEuNjE3MSAzOC43MzQ5LC0yOC43MjI1bC0yMS4wNzc3LC0wLjQ1NzRjLTAuOTI0NCw5LjMzMDMgLTkuMTA1OSwxNS4xODQ1IC0xNy42NTcyLDE1LjE4NDVjLTExLjc0MDYsMCAtMjAuNDMwNiwtNy41OTIyIC0yMC40MzA2LC0xOS44NDk2YzAsLTEyLjI1NzQgOC42OSwtMTkuOTg2OCAyMC40MzA2LC0yMC4yMTU1YzguNTUxMywtMC4xODMgMTYuOTE3Nyw1Ljk0NTcgMTcuNDcyMywxNS4yNzZsMjEuMDc3NywtMC42NDAzYy0wLjQ2MjIsLTE2LjgzMTEgLTE0LjE0NDIsLTI4LjI2NTIgLTM4LjU1LC0yOC4yNjUyem00OC44NDQ2LDJsNTUuNDY4LDBsMCw2NC4wMzExbC01NS40NjgsMGwwLC02NC4wMzExeiIgY2xpcC1ydWxlPSJldmVub2RkIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiLz4KPC9zdmc+Cg=='
    async function api(path, body) {
      var options = { method: body === undefined ? 'GET' : 'POST', headers: {} }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      var res = await fetch(API_PREFIX + path, options)
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

    /** 构建 code-server 页面 URL(base + ?folder=<cwd>,Windows 路径须为 /C:/ 形式)。
     *  cwd 为空时回退 status.cwd;两者皆无 → 裸根 URL。 */
    function buildPageUrl(status, cwd) {
      if (status == null || typeof status.url !== 'string' || status.url === '') return null
      var dir = typeof cwd === 'string' && cwd !== '' ? cwd : (status != null && status.cwd != null ? status.cwd : null)
      if (dir == null || dir === '') return status.url
      var normalized = dir.replace(/\\/g, '/')
      var folder = normalized
      if (/^[A-Za-z]:\//.test(normalized)) folder = '/' + normalized
      else if (normalized.charCodeAt(0) !== 47) folder = '/' + normalized
      return status.url + '?folder=' + encodeURIComponent(folder)
    }

    /** 常驻 IDE 面组件(右侧栏标签 body 的唯一渲染者):只渲染"停靠位",iframe 由 surface.js 持有,
     *  经 moveBefore 移入/移出 —— 切标签、收起侧栏、拖成浮动窗口都不再重载。
     *  reloadTick 变化 = 显式重载(切工作区/重试);owner 用于多停靠位仲裁:后停靠者接管,
     *  非当前停靠者卸载时不得把面拽走。 */
    function CodeServerSurface(props) {
      var status = props.status
      var pageUrl = props.pageUrl
      var reloadTick = props.reloadTick
      var owner = props.owner
      var hostRef = React.useRef(null)
      var running = status != null && status.ok === true && status.running === true
      var starting = status != null && status.status === 'starting'
      var errored = status != null && status.ok === false
      // serve=dsh 时 iframe 与 DSH 同源(不挂 sandbox);loopback 跨源,sandbox 是真防护。
      var sameOrigin = status != null && status.serve === 'dsh'

      // 停靠必须在绘制前完成(useLayoutEffect)→ 不闪白;src 变化时只做"重新停靠 + 导航"。
      React.useLayoutEffect(function () {
        if (!running || pageUrl === null) {
          // 未运行/启动中:本组件不再渲染停靠位(React 会摘掉 slot)。必须先把面收回停放区,
          // 否则 iframe 会留在被摘除的宿主里(源容器脱离文档 → 下次 moveBefore 抛错并降级)。
          parkSurface(owner)
          return
        }
        ensureSurface({ src: pageUrl, sameOrigin: sameOrigin })
        if (hostRef.current !== null) dockInto(hostRef.current, owner)
      }, [running, pageUrl, sameOrigin, reloadTick, owner])

      // 停放必须用 **layout** cleanup:React 在提交阶段先跑 layout effect 销毁、再摘除 DOM,
      // 此时 iframe 仍连着文档 → moveBefore 成功(状态保持);若放到 passive cleanup,
      // 宿主已被摘除,实测会抛 HierarchyRequestError 并把 iframe 丢掉。
      React.useLayoutEffect(function () {
        return function () { parkSurface(owner) }
      }, [owner])

      if (running && pageUrl !== null) {
        return React.createElement('div', {
          ref: hostRef,
          className: 'dshcs-slot',
          'data-code-server-slot': owner != null ? owner : 'code-server',
        })
      }
      if (starting) {
        // 启动中:先给占位与提示;常驻面由上一次的 cleanup 停在停放区,启动完成后自动停靠。
        return React.createElement('div', { className: 'dshcs-loading' }, '正在启动 code-server…')
      }
      var errText = errored && status != null && status.error
        ? status.error
        : 'code-server 未运行'
      var modeHint = sameOrigin
        ? '当前以 DSH 同源路径 ' + ((status != null && status.url) || '/code-server/') + ' 提供(无独立端口)。'
        : '当前以独立回环端口提供(端口 ' + (status != null && status.port != null ? status.port : '8090') + ' 被占用时请释放或修改 port 配置)。'
      var residentHint = supportsMoveBefore
        ? '常驻面:可用(切标签/收起侧栏不重载)。'
        : '常驻面:当前浏览器不支持 Element.moveBefore —— 切标签会整页重载(升级浏览器后自动可用)。'
      return React.createElement('div', { className: 'dshcs-empty' },
        React.createElement('div', { className: 'dshcs-emptybox' },
          React.createElement('div', null, errored ? 'code-server 启动失败' : 'code-server 未运行'),
          React.createElement('pre', { className: 'dshcs-error' }, errText),
          React.createElement('p', { className: 'dshcs-hint' },
            'VS Code 树随插件包内置、就地运行(无需全局安装、无需联网安装、无「安装环境」步骤);' +
            '内部依赖与预编译原生模块由包管理器在安装插件时一并装好(无需 C++ 工具链)。' +
            '若此处长期未运行,请到 设置 → 插件 → Code Server 点「检测环境」查看原因。' +
            modeHint + residentHint)
        ))
    }

    /** 后台常驻预热(keepResident=true):宿主 running 后立即在停放区加载 workbench,
     *  首次点开免等待。它不占任何插槽位置,也不把已停靠的面拽走。 */
    function Resident(props) {
      var store = useStore()
      var status = store.status
      var running = status != null && status.ok === true && status.running === true
      var keep = status != null && status.keepResident === true
      var cwd = activeWorkspaceCwd(props && props.useSessions, props && props.useWorkspaces)
      var url = running ? buildPageUrl(status, cwd) : null
      React.useEffect(function () {
        if (!keep || !running || url === null) return
        preloadSurface({ src: url, sameOrigin: status != null && status.serve === 'dsh' })
      }, [keep, running, url, status != null ? status.serve : null])
      return null
    }

    /** 在浏览器新标签页打开 code-server(windowedOpen=true 的入口共用);未运行先启动。 */
    function openExternalTab(cwd) {
      var openTab = function (s) {
        var u = buildPageUrl(s, cwd)
        if (u != null && typeof window.open === 'function') window.open(u, '_blank', 'noopener')
      }
      var current = getState().status
      if (current != null && current.running === true) { openTab(current); return }
      if (getState().busy === true) return
      setState({ busy: true })
      api('/code-server/start', typeof cwd === 'string' ? { cwd: cwd } : {})
        .then(function (s) { setState({ status: s, busy: false }); openTab(s) })
        .catch(function () { setState({ busy: false }) })
    }

    // ---------- 样式(主题变量 + 兜底值;只覆盖插件自身结构) ----------
    var CSS =
      // 产物按钮/列表(每轮产物旁,点击在 code-server 打开)
      '.dshcs-artbtn{appearance:none;display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:6px;color:var(--dsw-alias-label-secondary,#566174);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent);cursor:pointer;transition:color .12s ease,background .12s ease,border-color .12s ease;vertical-align:middle}' +
      '.dshcs-artbtn:hover{color:var(--dsw-alias-label-primary,#172033);border-color:color-mix(in srgb,var(--dshcs-accent,#5b6cff) 40%,var(--dsw-alias-border-l2,#dfe3eb));background:color-mix(in srgb,var(--dshcs-accent,#5b6cff) 8%,transparent)}' +
      '.dshcs-artbtn:active{transform:scale(.94)}' +
      '.dshcs-artbtn:focus-visible{outline:2px solid color-mix(in srgb,var(--dshcs-accent,#5b6cff) 65%,transparent);outline-offset:1px}' +
      '.dshcs-artifacts{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px 8px;margin-top:16px;font-size:13px;line-height:22px;position:relative}' +
      '.dshcs-artlabel{color:var(--dsw-alias-label-tertiary,#7d8798);grid-area:1/1}' +
      '.dshcs-artrow{flex-wrap:nowrap;grid-area:1/2;align-items:center;gap:8px;min-width:0;display:flex;overflow:hidden}' +
      '.dshcs-artitem{display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0}' +
      '.dshcs-artfile{text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);max-width:320px;color:var(--dsw-alias-label-secondary,#566174);font:inherit;cursor:pointer;border:none;border-radius:6px;margin:0;padding:0 8px;overflow:hidden}' +
      '.dshcs-artfile:hover{color:var(--dsw-alias-label-primary,#172033);text-decoration:underline}' +
      '.dshcs-artfile:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3);outline:none}' +
      '.dshcs-artmore{white-space:nowrap;color:var(--dsw-alias-label-tertiary,#7d8798);flex:none}' +
      // 常驻 IDE 面:iframe 由 surface.js 持有,借 moveBefore 在停靠位/停放区之间搬
      '.dshcs-frame{display:block;position:absolute;inset:0;z-index:1;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-tabroot{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-slot{position:relative;display:block;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-park{position:fixed;left:-20000px;top:0;width:320px;height:200px;overflow:hidden;pointer-events:none;z-index:0;visibility:hidden;contain:strict}' +
      // 空态/提示(未运行、启动中、旧版 DSH 提示)
      '.dshcs-loading{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-tertiary,#7d8798);font-size:13px}' +
      '.dshcs-empty{position:relative;z-index:2;flex:1;display:flex;align-items:center;justify-content:center;padding:44px 24px 24px}' +
      '.dshcs-emptybox{max-width:560px;text-align:left;background:var(--dsw-alias-bg-layer-2,#f7f8fb);border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:12px;padding:16px 18px}' +
      '.dshcs-error{color:var(--dsw-alias-label-error,#d92d20);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin:8px 0 0}' +
      '.dshcs-hint{color:var(--dsw-alias-label-tertiary,#7d8798);font-size:12px;margin:6px 0 0}' +
      '.dshcs-legacy{color:var(--dsw-alias-label-warning,#b54708);font-size:12px;font-weight:600;margin:0 0 6px}'
    var CSS_TAG = 'dsh-code-server/styles'
    if (typeof document !== 'undefined' && document.querySelector('style[data-dshcs=' + JSON.stringify(CSS_TAG) + ']') === null) {
      var tag = document.createElement('style')
      tag.setAttribute('data-dshcs', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------- 右侧栏标签(DSH ≥ 0.1.5-alpha.1:ctx.sidebarRightTabs / ctx.sidebarRight) ----------
    // 二段式注册:类型定义进 sidebarRightTabs,body 进 keyed 插槽 sidebar.right.pane.tab。
    // 服务始终不就绪(旧版 DSH)→ 判定 legacy:只留设置页提示(见 internalApply)。
    var CS_KIND = 'code-server'
    var CS_TAB_ID = 'dsh-code-server-app'
    /** 旧版判定等待窗口:服务可能晚于本插件就绪,超过这个时间仍无服务即认定旧版 DSH。 */
    var LEGACY_PROBE_TIMEOUT_MS = 2500
    // 产物按钮/设置卡调用侧栏的桥接;legacy(旧版 DSH)时保持 null。
    var sidebarBridge = { openTab: null }

    /** 侧栏入口图标:code-server 官方图标(内联 data URI,不依赖服务端路径)。 */
    function CodeServerIcon(props) {
      var size = props != null && typeof props.size === 'number' ? props.size : 16
      return React.createElement('img', {
        src: ICON_URL, alt: '', 'aria-hidden': true, draggable: false,
        className: props != null ? props.className : undefined,
        style: { width: size, height: size, display: 'block', objectFit: 'contain', WebkitUserDrag: 'none', userSelect: 'none' },
      })
    }

    /** 右侧栏 tab 的 body:面板里铺满常驻 IDE 面(iframe 由 surface.js 持有)。
     *  走共享 store 与 CodeServerSurface;挂载即让实例跟随当前会话工作区。
     *  0.2.2 起 ui-dockkit 的"切走即卸载 body"不再导致重载:卸载只把面停放到停放区。 */
    function CodeServerBody(props) {
      var info = props.useTabInfo()
      var tab = info.tab
      var store = useStore()
      var status = store.status
      var cwd = activeWorkspaceCwd(props.useSessions, null)
      var lastCwdRef = React.useRef(undefined)
      var [tick, setTick] = React.useState(0)
      var navigation = tab.navigation
      var revision = navigation != null && typeof navigation.revision === 'number' ? navigation.revision : 0

      // 工作区跟随:对齐会话 cwd(未运行则启动;运行中切目录由 host 重启),成功后刷新 iframe
      React.useEffect(function () {
        if (typeof cwd !== 'string' || cwd === '') return
        if (lastCwdRef.current === cwd) return
        var changed = lastCwdRef.current !== undefined
        lastCwdRef.current = cwd
        var cancelled = false
        api('/code-server/start', { cwd: cwd }).then(function (s) {
          if (cancelled) return
          setState({ status: s })
          if (changed && s != null && s.ok === true && s.running === true) setTick(function (t) { return t + 1 })
        }).catch(function () { /* 由状态轮询兜底 */ })
        return function () { cancelled = true }
      }, [cwd])

      // 标签挂载期间保持状态新鲜(切走即停;回来时先 GET 一次再挂 iframe)
      React.useEffect(function () {
        api('/code-server/status').then(function (s) { if (s != null) setState({ status: s }) }).catch(function () {})
        var timer = window.setInterval(function () {
          api('/code-server/status').then(function (s) { setState({ status: s }) }).catch(function () {})
        }, 3000)
        return function () { window.clearInterval(timer) }
      }, [])

      // 再次导航(产物按钮 / 重复点 guide 入口框)带 path → 交给内建扩展打开该文件;
      // 扩展每 800ms 轮询信号文件且失败保留重试,故实例尚未就绪时也可先写入。
      React.useEffect(function () {
        var params = navigation != null ? navigation.params : null
        var file = params != null && typeof params.path === 'string' ? params.path : ''
        if (file === '') return
        api('/code-server/open-file', { file: file }).catch(function () { /* 忽略:由用户重试 */ })
      }, [revision])

      return React.createElement('div', { className: 'dshcs-tabroot', 'data-code-server-tab': 'body' },
        React.createElement(CodeServerSurface, {
          status: status, pageUrl: buildPageUrl(status, cwd), reloadTick: tick, owner: 'tab:' + tab.id,
        })
      )
    }

    /** 注册右侧栏 tab 类型 + body,并接上入口桥接(仅当两个服务都已就绪时被调用)。 */
    function registerSidebarTab(sctx) {
      var tabs = sctx.sidebarRightTabs
      var controller = sctx.sidebarRight
      if (tabs == null || controller == null) return
      sctx.effect(function () {
        return tabs.register({
          id: CS_TAB_ID,
          kind: CS_KIND,
          // 产品外插件 = extension 段(最高;同名 kind 可覆盖 builtin,本插件无冲突)
          priority: 'extension',
          title: function () { return 'Code Server' },
          // guide 页入口框:点它即以本类型打开一个页面 tab(替换 guide 自身)
          guide: [{
            order: 20,
            title: function () { return 'Code Server' },
            description: function () { return '在右侧栏标签里运行 VS Code 网页版,跟随当前会话工作区。' },
            icon: CodeServerIcon,
          }],
        })
      }, 'code-server: sidebar tab type')
      sctx.effect(function () {
        return sctx.slots.inject('sidebar.right.pane.tab', function () {
          return sctx.slots.register({ name: 'sidebar.right.pane.tab', key: CS_TAB_ID }, CodeServerBody)
        })
      }, 'code-server: sidebar tab body')
      sidebarBridge.openTab = function (params) {
        try {
          controller.openTab(CS_KIND, params != null ? { params: params } : undefined)
          return true
        } catch (e) {
          // 无挂载 seat(无会话/侧栏未渲染)→ 调用方回退浏览器新标签页
          console.warn('[code-server] sidebar openTab failed:', e != null && e.message != null ? e.message : String(e))
          return false
        }
      }
      // 卸载 / HMR 重载:清桥接并复位载体状态(legacy 判定由下一次 apply 重新做)
      sctx.effect(function () {
        return function () {
          sidebarBridge.openTab = null
          setState({ sidebarActive: false, sidebarUi: 'unknown' })
        }
      }, 'code-server: sidebar mode reset')
      setState({ sidebarActive: true })
      console.log('[code-server] right-sidebar tab registered (kind=' + CS_KIND + ')')
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
      '.dshcs-cbtn{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;border:1px solid transparent;transition:color .12s ease,background .12s ease}' +
      '.dshcs-cbtn:disabled{opacity:.4;cursor:default}' +
      '.dshcs-cbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      '.dshcs-cbtnOutline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}' +
      '.dshcs-cbtnOutline:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,transparent)}' +
      '.dshcs-cbtnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-label-primary);font-weight:600}' +
      '.dshcs-cbtnPrimary:hover:not(:disabled){filter:brightness(.95)}' +
      '.dshcs-cbtnPrimary:active:not(:disabled){filter:brightness(.9)}' +
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
      var [open, setOpen] = React.useState(props.defaultOpen === true)
      var state = props.state
      if (state === null || state === undefined || state.available !== true) return null
      var title = props.title
      var noticeOnly = props.noticeOnly === true
      var saveDisabled = state.dirty !== true || state.invalid === true || state.saving === true
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
          // 旧版 DSH 提示卡:没有可保存的项,不渲染只读条与底部按钮
          noticeOnly === true ? null
            : (state.writable !== true ? React.createElement('p', { className: 'dshcs-cardReadOnly', role: 'status' }, props.readOnlyLabel) : null),
          props.children,
          noticeOnly === true ? null : React.createElement('div', { className: 'dshcs-cardFooter' },
            state.failed === true ? React.createElement('p', { className: 'dshcs-cardFailed', role: 'status' }, props.saveFailedLabel) : null,
            React.createElement(csBtn, { disabled: state.dirty !== true || state.saving === true, onClick: props.onDiscard }, props.discardLabel),
            React.createElement(csBtn, { variant: 'primary', disabled: saveDisabled, onClick: props.onSave }, state.saving === true ? props.savingLabel : props.saveLabel)
          )
        ) : null
      )
    }

    /** 设置卡片页面:useState+useEffect 订阅 settingsScope(不投机 useSyncExternalStore
     *  对 snapshot 引用稳定性的要求;不建中间 store)。 */
    function csSettingsPage(props) {
      try {
        var scope = props.scope
        var [snapshot, setSnapshot] = React.useState(function () { return scope !== undefined ? scope.getSnapshot() : null })
        var [draft, setDraft] = React.useState(null) // null | { reserveComposer, windowedOpen, keepResident }(未保存草稿)
        var [saving, setSaving] = React.useState(false)
        var [failed, setFailed] = React.useState(false)
        // 共享 store:读取当前 UI 载体状态(右侧栏是否就绪 / 是否旧版 DSH),必须放在所有提前 return 之前
        var liveStore = useStore()
        // 常驻面实时状态(停靠/停放/降级):卡片里显示,便于判断"切标签是否还会重载"
        var [surfaceState, setSurfaceState] = React.useState(surfaceSnapshot())
        React.useEffect(function () {
          return subscribeSurface(function (snap) { setSurfaceState(snap) })
        }, [])
        React.useEffect(function () {
          if (scope === undefined || typeof scope.subscribe !== 'function') return
          function onUpdate() {
            try { setSnapshot(scope.getSnapshot()) } catch (e) { /* ignore */ }
          }
          var dispose = scope.subscribe(onUpdate)
          return function () { if (typeof dispose === 'function') dispose() }
        }, [scope])
        if (scope === undefined) {
          console.error('[code-server] card scope missing')
          return null
        }
        if (snapshot === null || snapshot === undefined || snapshot.status !== 'ready') {
          // 尚未就绪(连接/镜像加载中):静默留空,官方插槽边界接管;不显示占位
          if (snapshot !== null && snapshot !== undefined && snapshot.status === 'unavailable') {
            console.warn('[code-server] settings scope unavailable:', snapshot.status)
          }
          return null
        }
      var value = snapshot.value !== undefined && snapshot.value !== null ? snapshot.value : {}
      var user = snapshot.user
      var loaded = {
        windowedOpen: value.windowedOpen === true,
        keepResident: value.keepResident !== false,
      }
      // ---- 旧版 DSH(无右侧栏服务):本页是唯一的提示出口,不显示任何设置项 ----
      if (liveStore != null && liveStore.sidebarUi === 'legacy') {
        return React.createElement(csCard, {
          title: 'Code Server',
          description: '当前 DSH 版本不受支持(缺少右侧栏服务)',
          defaultOpen: true,
          noticeOnly: true,
          state: { available: true, writable: false, dirty: false, invalid: false, saving: false, failed: false },
        },
          React.createElement('div', { className: 'dshcs-field' },
            React.createElement('div', { className: 'dshcs-legacy' }, '本插件自 0.2.3 起不再兼容旧版 DSH。'),
            React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 0 } },
              '未检测到右侧栏插件服务 sidebarRightTabs / sidebarRight,因此插件不提供任何入口'
              + '(旧版的悬浮球与浮动窗口已移除),也不会后台启动 IDE。'
              + '\n升级 DSH 到带右侧栏的版本(≥ 0.1.5-alpha.1)后,Code Server 会出现在右侧栏标签里,'
              + '本页同时显示完整设置项;升级后无需重装本插件,刷新页面即可。'
            )
          )
        )
      }
      var overriddenWin = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'windowedOpen')
      var overriddenKeep = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'keepResident')
      var sidebarActive = liveStore != null && liveStore.sidebarActive === true
      var dirty = draft !== null && (draft.windowedOpen !== loaded.windowedOpen
        || draft.keepResident !== loaded.keepResident)
      var saveDisabled = !dirty || saving
      var state = {
        available: true,
        writable: snapshot.writable,
        dirty: dirty,
        invalid: false,
        saving: saving,
        failed: failed,
      }
      // 保存/恢复成功后,把 host 最新 status 推给模块共享 store → 常驻预热等立即按新设置生效。
      function syncStatusToStore() {
        api('/code-server/status').then(function (s) {
          if (s != null && typeof s === 'object') setState({ status: s })
        }).catch(function () { /* 失败由下次轮询兜底 */ })
      }
      async function doSave() {
        if (dirty && !saving) {
          setSaving(true); setFailed(false)
          try {
            var d = draft !== null ? draft : loaded
            await props.scope.set('windowedOpen', d.windowedOpen === true)
            await props.scope.set('keepResident', d.keepResident === true)
            setDraft(null)
            syncStatusToStore()
          } catch (e) {
            setFailed(true)
          }
          setSaving(false)
        }
      }
      async function doReset() {
        if (saving || snapshot.writable !== true) return
        setSaving(true); setFailed(false)
        try {
          // unset 清除 user 覆盖层 → 回到 base 默认值;成功后镜像同步
          if (typeof props.scope.unset === 'function') {
            await props.scope.unset('windowedOpen')
            await props.scope.unset('keepResident')
          } else {
            await props.scope.set('windowedOpen', value.windowedOpen === true)
            await props.scope.set('keepResident', value.keepResident === undefined || value.keepResident === null ? true : value.keepResident)
          }
          setDraft(null)
          syncStatusToStore()
        } catch (e) {
          setFailed(true)
        }
        setSaving(false)
      }
      // ---- 环境检测(host /api/code-server/status.env;0.1.36 起没有安装步骤) ----
      var [envInfo, setEnvInfo] = React.useState(null) // null=待检测 | { ok, entry, native, vscodeInner, innerDeps, nativeRuntime } | { error }
      var [envBusy, setEnvBusy] = React.useState(false)
      var envSection = React.createElement('div', { className: 'dshcs-field' },
        React.createElement('div', { className: 'dshcs-fieldHead' },
          React.createElement('span', { className: 'dshcs-fieldLabel' }, '环境检测'),
          React.createElement('span', { className: 'dshcs-badges' },
            React.createElement(csBtn, { variant: 'primary', disabled: envBusy, onClick: async function () {
              setEnvBusy(true)
              var s = await api('/code-server/status')
              setEnvInfo(s != null && s.env != null ? s.env : { error: 'status 未返回 env' })
              setEnvBusy(false)
            } }, envBusy ? '检测中…' : '检测环境')
          )
        ),
        envInfo != null
          ? React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 6 } },
              envInfo.error != null
                ? React.createElement('span', null, '检测失败: ' + envInfo.error)
                : React.createElement('span', null,
                    '状态: ' + (envInfo.ok === true ? '✅ 就绪' : '❌ 不通过') +
                    (envInfo.treeVersion != null ? ' · VS Code 树: ' + envInfo.treeVersion : '') +
                    (envInfo.upToDate === false && envInfo.vendored != null ? '(内置 ' + envInfo.vendored + ') ' : '') +
                    (envInfo.productPath != null ? ' · 客户端路径: ' + envInfo.productPath : '') +
                    (envInfo.entry != null ? ' · 入口: ' + envInfo.entry : ' · 入口缺失') +
                    ' · VS Code 内部依赖: ' + (envInfo.vscodeInner === true ? '✅' : '❌') +
                    ' · 预编译原生包: ' + (envInfo.nativeRuntime != null && envInfo.nativeRuntime.packages > 0
                      ? '✅ ' + envInfo.nativeRuntime.name + '@' + (envInfo.nativeRuntime.version != null ? envInfo.nativeRuntime.version : '?')
                        + '(' + envInfo.nativeRuntime.packages + ' 包)'
                      : '❌ 未安装(' + (envInfo.nativeRuntime != null && envInfo.nativeRuntime.name != null ? envInfo.nativeRuntime.name : '平台聚合包') + ')'))
            )
          : React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 6 } }, '点击"检测环境"查看 VS Code 树状态(依赖由包管理器安装,无需安装步骤)')
        ,
        React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 10, color: 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))' } },
          '运行位置: ' + (envInfo != null && envInfo.tree != null ? envInfo.tree : '<插件目录>\\vendor\\vscode') +
          '\n卸载: dsh plugin --profile web remove dsh-code-server-app'
        )
      )
      return React.createElement(csCard, {
        title: 'Code Server',
        description: '入口:右侧栏标签(DSH ≥ 0.1.5-alpha.1);窗口化设置控制新标签页打开',
        state: state,
        unsavedLabel: '未保存', readOnlyLabel: '本部署的设置为只读。',
        saveFailedLabel: '本部署没有接受这些值，已保留供你修改。',
        discardLabel: '放弃修改', saveLabel: '保存', savingLabel: '保存中…',
        onSave: doSave, onDiscard: function () { setDraft(null); setFailed(false) },
      },
        // 入口:说明载体,并给一个直接打开侧栏标签的按钮
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '入口'),
            React.createElement('span', { className: 'dshcs-badges' },
              React.createElement(csBtn, {
                disabled: sidebarActive !== true,
                onClick: function () { if (sidebarBridge.openTab !== null) sidebarBridge.openTab(null) },
              }, '在右侧栏打开')
            )
          ),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 6 } },
            '当前:右侧栏标签。从右侧栏「开始」页的 Code Server 入口框、产物旁按钮或上面的按钮打开。')
        ),
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '窗口化打开(新标签页)'),
            overriddenWin === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csCheck, {
            checked: draft !== null ? draft.windowedOpen : loaded.windowedOpen,
            disabled: snapshot.writable !== true,
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { windowedOpen: v === true }) }); setFailed(false) },
          }, '开启后入口(产物按钮/设置卡)在浏览器新标签页打开 code-server(自动启动并跟随当前工作区);关闭则使用右侧栏标签')
        ),
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '后台常驻(切标签不重载)'),
            overriddenKeep === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csCheck, {
            checked: draft !== null ? draft.keepResident : loaded.keepResident,
            disabled: snapshot.writable !== true,
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { keepResident: v === true }) }); setFailed(false) },
          }, '开启后宿主启动即把 IDE 加载到后台"停放区":切换右侧栏标签、收起/展开侧栏、拖成浮动窗口都不再重载,首次打开免等待;关闭则只在打开面板时加载(省内存)'),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            supportsMoveBefore
              ? '常驻面:' + (surfaceState.docked ? '已停靠' : (surfaceState.ready ? '已停放(后台运行中)' : '未启动'))
                + (surfaceState.degraded ? ' · 本次发生过降级重载' : '')
              : '当前浏览器不支持 Element.moveBefore(Chromium <133)→ 常驻不可用,切标签仍会整页重载(升级浏览器后自动生效)')
        ),
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '依赖安装'),
            null
          ),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '0.1.36 起 code-server 本体随插件包发布,VS Code 内部依赖与预编译原生模块(平台聚合包)全部由包管理器在 dsh plugin add 时安装,不再需要「安装环境」步骤。')
        ),
        envSection
      )
      } catch (e) {
        // 渲染异常:记日志不打断;官方插槽对异常有边界,卡片留空即可
        console.error('[code-server] card render error:', e !== null && e !== undefined && e.message !== undefined ? e.message : String(e))
        return null
      }
    }

    // ---------- 产物列表+图标(替代官方 deliverables 列表,链内唯一匹配) ----------
    // 数据:owner.turn.data.get("deliverables") → { produced: [{ path, seq }] }
    // 过滤:produced.seq <= owner.seq(官方 producedForClosing 同款——不拿后续 tool 的文件)。
    function producePathList(owner) {
      var list = []
      try {
        var d = owner.turn.data.get('deliverables')
        var seq = owner.seq != null ? owner.seq : Number.POSITIVE_INFINITY
        if (d != null && Array.isArray(d.produced)) {
          var seen = {}
          for (var i = 0; i < d.produced.length; i++) {
            var p = d.produced[i]
            if (p == null || typeof p.path !== 'string' || p.path === '') continue
            if (p.seq != null && p.seq > seq) continue
            if (seen[p.path] === true) continue
            seen[p.path] = true
            list.push(p.path)
          }
        }
      } catch (e) { /* respect */ }
      return list
    }
    function selectProduced(owner) {
      var paths = producePathList(owner)
      return paths.length === 0 ? null : paths
    }
    function OpenFileGlyph(props) {
      // code-server 官方图标(内联 data URI,随插件分发)
      return React.createElement('img', {
        src: ICON_URL, alt: '', 'aria-hidden': true, draggable: false,
        style: { width: 15, height: 15, display: 'block', objectFit: 'contain', WebkitUserDrag: 'none', userSelect: 'none' },
      })
    }
    function TurnArtifacts(props) {
      var store = useStore()
      if (props == null || !Array.isArray(props.matched) || props.matched.length === 0) return null
      var paths = props.matched
      function basenameOf(p) {
        var s = String(p).replace(/\\/g, '/')
        var i = s.lastIndexOf('/')
        return i >= 0 ? s.slice(i + 1) : s
      }
      /** 打开顺序:windowedOpen → 浏览器新标签页;否则右侧栏 tab(带 path);再不行只启动并提示。 */
      function openInCodeServer(p) {
        var st = store.status
        if (st != null && st.windowedOpen === true) {
          openExternalTab(activeWorkspaceCwd(props.useSessions, props.useWorkspaces))
          return
        }
        if (store.sidebarActive === true && sidebarBridge.openTab !== null) {
          if (sidebarBridge.openTab({ path: p }) === true) return
        }
        // 侧栏不可用(未挂载 seat / 无会话):退化为"在浏览器新标签页打开",不再有浮窗兜底
        openExternalTab(activeWorkspaceCwd(props.useSessions, props.useWorkspaces))
        api('/code-server/open-file', { file: p }).then(function (s) {
          if (s == null || s.ok !== true) {
            window.alert(s != null && s.error ? s.error : '打开失败')
          }
        }).catch(function (e) { window.alert('打开失败: ' + String(e)) })
      }
      // 复刻官方列表(label + 行),但每个文件名旁加"仅图标"按钮 → 在 code-server 打开
      return React.createElement('div', { className: 'dshcs-artifacts' },
        React.createElement('span', { className: 'dshcs-artlabel' }, '产物'),
        React.createElement('div', { className: 'dshcs-artrow' },
          paths.slice(0, 6).map(function (p) {
            return React.createElement('span', { key: p, className: 'dshcs-artitem' },
              React.createElement('button', {
                type: 'button', className: 'dshcs-artfile', title: p,
                'aria-label': '打开: ' + p,
                onClick: function () { openInCodeServer(p) },
              }, basenameOf(p)),
              React.createElement('button', {
                type: 'button', className: 'dshcs-artbtn',
                title: '在 Code Server 打开: ' + p,
                'aria-label': '在 Code Server 打开: ' + p,
                onClick: function () { openInCodeServer(p) },
              }, React.createElement(OpenFileGlyph, null))
            )
          }),
          paths.length > 6 ? React.createElement('span', { className: 'dshcs-artmore' }, '…' ) : null
        )
      )
    }
    function apply(ctx) {
      try {
        internalApply(ctx)
      } catch (err) {
        console.error('[code-server] apply failed:', err && err.stack ? err.stack : String(err))
        try { document.title = 'CS-ERR ' + ((err && err.message) || String(err)) } catch (e) { /* ignore */ }
      }
    }
    function internalApply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) {
        console.error('[code-server] slots service unavailable')
        return
      }
      // settings scope 提前绑定(设置卡共用)
      var settingsScope = ctx.settingsScope
      var scope = null
      if (settingsScope !== undefined && typeof settingsScope.bind === 'function') {
        scope = settingsScope.bind({ namespace: 'code-server' })
      } else {
        console.error('[code-server] settingsScope unavailable (inject missing?); settings card disabled')
        return
      }
      // 预拉取 status(设置卡/预热/侧栏 body 共用)
      api('/code-server/status').then(function (s) {
        setState({ status: s })
      }).catch(function () { /* 首次失败由后续轮询补救 */ })

      // ---- 设置卡片:任何 DSH 版本都注册(旧版 DSH 里它是唯一的提示出口) ----
      slots.inject('settings.plugin.item', () => slots.register(
        { name: 'settings.plugin.item', key: 'code-server', label: 'Code Server', inject: function () { return { scope: scope } } },
        csSettingsPage
      ))

      // ---- 能力探测:只有带右侧栏服务(DSH ≥ 0.1.5-alpha.1)才注册可用 UI ----
      // 旧的“悬浮球 + 内部浮动窗口”回退已在 0.2.3 删除:探测不到服务时除设置页提示外什么都不注册。
      function onModernUi(sctx) {
        registerSidebarTab(sctx)
        setState({ sidebarActive: true, sidebarUi: 'modern' })
        // 常驻预热:不渲染任何东西,宿主 running 时把 IDE 加载到停放区
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'code-server', order: 70, label: 'Code Server' },
          (props) => React.createElement(Resident, props)
        ))
        // ---- 产物图标按钮(每轮产物旁,点击在 code-server 打开) ----
        // 与 deliverables 共用 turnTail 插槽;select 读 owner.turn.data 的 deliverables。
        try {
          slots.inject('conversation.chat.turnTail', function () {
            return slots.register({
              name: 'conversation.chat.turnTail',
              priority: -9, // 先于官方 deliverables(chain 唯一匹配 → 我们渲染完整"列表+图标")
              id: 'dshcs-open-file',
              select: selectProduced,
            }, TurnArtifacts)
          })
        } catch (e) {
          console.warn('[code-server] turnTail register failed:', e != null && e.message != null ? e.message : String(e))
        }
        console.log('[code-server] client registered: right-sidebar tab + turnTail artifacts + resident preload + settings card')
      }

      function onLegacyDsh() {
        setState({ sidebarActive: false, sidebarUi: 'legacy' })
        console.warn('[code-server] 未探测到右侧栏服务(sidebarRightTabs/sidebarRight):'
          + ' 本插件自 0.2.3 起不再兼容旧版 DSH —— 除「设置 → 插件 → Code Server」的提示外不提供任何入口,'
          + '也不预热 IDE。请升级 DSH。')
        // 上报 host:让它别为一个用不了的 UI 自动预启动/继续运行 IDE
        api('/code-server/ui-mode', { sidebar: false }).catch(function () { /* 只是优化,失败不影响提示 */ })
      }

      var ready = typeof ctx.get === 'function'
        ? (ctx.get('sidebarRightTabs') !== undefined && ctx.get('sidebarRight') !== undefined)
        : false
      if (ready) {
        try {
          onModernUi(ctx)
        } catch (e) {
          console.error('[code-server] sidebar tab registration failed:',
            e != null && e.message != null ? e.message : String(e))
        }
        return
      }
      // 服务可能晚于本插件就绪 → ctx.inject 等待;超时仍未就绪则判定旧版 DSH(只给设置页提示)
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        onLegacyDsh()
      }, LEGACY_PROBE_TIMEOUT_MS)
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (sctx) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try {
              onModernUi(sctx)
            } catch (e) {
              console.error('[code-server] sidebar tab registration failed:',
                e != null && e.message != null ? e.message : String(e))
            }
          })
        } else {
          clearTimeout(timer)
          settled = true
          onLegacyDsh()
        }
      } catch (e) {
        clearTimeout(timer)
        settled = true
        console.warn('[code-server] sidebar inject failed:', e != null && e.message != null ? e.message : String(e))
        onLegacyDsh()
      }
    }

    const inject = ['slots', 'settingsScope']
    const name = 'code-server'
    export { apply, inject, name }
