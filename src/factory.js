// dsh-code-server — client bundle(右侧栏标签内的常驻 IDE 面;**只支持带右侧栏的 DSH**)
// 构建:`pnpm run build:client` → lib/client.js;产物形态 window.__ModuleLoader__.load({id,factory}),
// factory 内静态 require('react')/('react/jsx-runtime')(DSH 冻结模块表)。
//
// 数据通道:同源 fetch DSH Connection 的共享 /api(status / start / stop / setup / open-file / ui-mode;
// web 走 webServer 的 /api 前缀,desktop 走 IPC 帧管道 → 插件不依赖 webServer)。
//
// UI 载体只有右侧栏标签(需要 sidebarRightTabs / sidebarRight 服务,DSH ≥ 0.1.5-alpha.1):
//   一段 ctx.sidebarRightTabs.register({ id, kind, priority, patterns, canOpen, title, guide })
//     → guide 页入口框;并通过 patterns 认领 `dsh-resource://file/**` 文件地址,成为官方 openFile
//       (产物 chip / "交付"卡片预览 / 正文提及)与任何 openResource(fileAddress) 的落点。
//   二段 ctx.slots.register({ name:'sidebar.right.pane.tab', key:id }, CodeServerBody)
//     → tab 内渲染常驻 iframe;body 从 navigation.address 解析文件并让 workbench 定位。
//
// 探测不到右侧栏服务(旧版 DSH)时:除「设置 → 插件 → Code Server」的一条提示外不注册任何 UI、
// 不预热 IDE,并上报 host /ui-mode 让它回收已自动预启动的实例。
import {
  basenameOfAddress,
  claimsAddress,
  isPageAddress,
  parseFileAddress,
  resolveFilePath,
  SCOPE_SESSION,
} from './address.js';
import { requestFullscreenPanel } from './sidebar-mode.js';
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
    var state = { status: null, busy: false, sidebarUi: 'unknown', sidebarRegisterFailed: false }
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

    /** 构建 code-server 页面 URL(base + 实例标记 + ?folder=<cwd>,Windows 路径须为 /C:/ 形式)。
     *  cwd 为空时回退 status.cwd;两者皆无 → 只有实例标记。
     *  末尾的 `s=` 是"实例标记"(pid/启动时间):IDE 重启后 URL 变化 → iframe 会自动重新导航。
     *  **没有它的话**,IDE 未就绪时加载到的错误页(503/连接失败)会一直粘在 iframe 上,
     *  即使用户点了重启也不会重新加载(0.2.x 的老毛病)。 */
    function buildPageUrl(status, cwd) {
      if (status == null || typeof status.url !== 'string' || status.url === '') return null
      var tag = status.pid != null ? String(status.pid) : (status.startedAt != null ? String(status.startedAt) : '0')
      var url = status.url + '?s=' + encodeURIComponent(tag)
      var dir = typeof cwd === 'string' && cwd !== '' ? cwd : (status != null && status.cwd != null ? status.cwd : null)
      if (dir == null || dir === '') return url
      var normalized = dir.replace(/\\/g, '/')
      var folder = normalized
      if (/^[A-Za-z]:\//.test(normalized)) folder = '/' + normalized
      else if (normalized.charCodeAt(0) !== 47) folder = '/' + normalized
      return url + '&folder=' + encodeURIComponent(folder)
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
            '若此处长期未运行,请查看 DSH host 日志里的 [code-server] 输出(或在设置卡片里切换「后台常驻」触发一次启动)。' +
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

    // ---------- 样式(主题变量 + 兜底值;只覆盖插件自身结构) ----------
    var CSS =
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
    var LEGACY_NOTICE_MS = 2500
    /** 更久的宽限:到这里仍无服务才通知 host 停止预启动/回收实例(避免误杀慢启动的宿主)。 */
    var LEGACY_REPORT_MS = 10000
    /** 服务已在注册表、但 ctx.inject 迟迟不回调时的兜底注册延迟。 */
    var SYNC_FALLBACK_MS = 1500

    /** 侧栏入口图标:code-server 官方图标(内联 data URI,不依赖服务端路径)。 */
    function CodeServerIcon(props) {
      var size = props != null && typeof props.size === 'number' ? props.size : 16
      return React.createElement('img', {
        src: ICON_URL, alt: '', 'aria-hidden': true, draggable: false,
        className: props != null ? props.className : undefined,
        style: { width: size, height: size, display: 'block', objectFit: 'contain', WebkitUserDrag: 'none', userSelect: 'none' },
      })
    }

    /** 当前认领范围策略(host 快照里的 fileOpenScope;未到达时保守用 session)。 */
    function fileOpenScope() {
      var status = state.status
      return status != null && status.fileOpenScope === 'all' ? 'all' : SCOPE_SESSION
    }

    /** 会话 cwd 查询(同步;把地址里的相对路径变成绝对路径要用)。 */
    function sessionCwd(useSessions, sessionId) {
      try {
        var list = useSessions(function (s) { return s })
        if (list != null && sessionId != null && list.byId != null) {
          var entry = list.byId[sessionId]
          if (entry != null && typeof entry.cwd === 'string' && entry.cwd !== '') return entry.cwd
        }
      } catch (e) { /* 服务缺失时退回 undefined */ }
      return undefined
    }

    /** 右侧栏 tab 的 body:面板里铺满常驻 IDE 面(iframe 由 surface.js 持有)。
     *  走共享 store 与 CodeServerSurface;挂载即让实例跟随当前会话工作区。
     *  文件 tab(navigation.address = `dsh-resource://file/…`)会让 workbench 定位到该文件;
     *  页面 tab(`sidebar://code-server`)只显示工作区 IDE。
     *  0.2.2 起 ui-dockkit 的"切走即卸载 body"不再导致重载:卸载只把面停放到停放区。 */
    function CodeServerBody(props) {
      var info = props.useTabInfo()
      var tab = info.tab
      var store = useStore()
      var status = store.status
      var navigation = tab.navigation
      var revision = navigation != null && typeof navigation.revision === 'number' ? navigation.revision : 0
      // 地址:文件 tab 可能来自会话树里的别的会话,故优先用地址里的 sessionId 对齐工作区
      var address = navigation != null && typeof navigation.address === 'string' ? navigation.address : ''
      var parsed = isPageAddress(address) ? null : parseFileAddress(address)
      var addressedCwd = sessionCwd(props.useSessions, parsed != null ? parsed.sessionId : undefined)
      var cwd = addressedCwd !== undefined ? addressedCwd : activeWorkspaceCwd(props.useSessions, null)
      var targetFile = resolveFilePath(parsed, cwd)
      var line = navigation != null && navigation.params != null && typeof navigation.params.line === 'number'
        ? navigation.params.line : null
      var lastCwdRef = React.useRef(undefined)
      var [tick, setTick] = React.useState(0)
      // 打开即全屏(设置 fullscreenOnOpen,默认开):右侧栏里跑 IDE,只有铺满窗口才够用。
      var rootRef = React.useRef(null)
      var forcedFullscreenRef = React.useRef(false)
      var visible = info.tab != null && info.tab.visible === true
      var fullscreen = info.sidebar != null && info.sidebar.fullscreen === true
      // status 未到达(host 尚未应答)时按"未知"处理 → 不抢跑;值到达后由依赖变化补一次。
      // 反过来(未知即当真)会在用户关掉设置、而 status 还在路上时误切一次全屏。
      var fullscreenOnOpen = status != null && status.fullscreenOnOpen !== false
      // 触发时机 = 本标签"变得可见"的那一刻(打开、切回、重新展开侧栏),每个可见周期只切一次:
      // 之后用户点「退出全屏」不会被抢回去(退出全屏→再切走切回才会重新切全屏)。
      // layout effect:与面板同一次提交,按钮已在 DOM 里 → 不会先画一帧 push 再跳全屏。
      React.useLayoutEffect(function () {
        if (!visible) { forcedFullscreenRef.current = false; return }
        if (!fullscreenOnOpen || fullscreen || forcedFullscreenRef.current) return
        forcedFullscreenRef.current = true
        var result = requestFullscreenPanel(rootRef.current)
        if (result !== 'clicked') {
          console.warn('[code-server] 未能自动切到全屏右侧栏(' + result + ');本次打开保持原模式')
        }
      }, [visible, fullscreen, fullscreenOnOpen])

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

      // 文件定位:地址变化(或官方 openFile 带来的 line 参数)→ 让内建扩展在 workbench 里打开它。
      // 扩展每 800ms 轮询信号文件且失败保留重试,故实例尚未就绪时也可先写入。
      React.useEffect(function () {
        if (targetFile === null) return
        api('/code-server/open-file', line === null ? { file: targetFile } : { file: targetFile, line: line })
          .catch(function () { /* 忽略:由用户重试 */ })
      }, [revision, targetFile, line])

      return React.createElement('div', { className: 'dshcs-tabroot', 'data-code-server-tab': 'body', ref: rootRef },
        React.createElement(CodeServerSurface, {
          status: status, pageUrl: buildPageUrl(status, cwd), reloadTick: tick, owner: 'tab:' + tab.id,
        })
      )
    }

    /** 取服务:先按 ctx 属性(注入上下文的常规形态),再回退 `ctx.get(name)`。
     *  实测踩坑:某些上下文(desktop)只保证 `get()` 可见,属性访问可能是 undefined ——
     *  只读属性会让注册被静默跳过(界面表现为"卡片正常但侧栏没有入口")。 */
    function serviceOf(sctx, name) {
      if (sctx == null) return null
      var direct = sctx[name]
      if (direct != null) return direct
      if (typeof sctx.get === 'function') {
        var viaGet = sctx.get(name)
        if (viaGet != null) return viaGet
      }
      return null
    }

    /** 注册右侧栏 tab 类型 + body,并接上入口桥接。返回是否注册成功(失败会显式报错,不静默)。 */
    function registerSidebarTab(sctx) {
      var tabs = serviceOf(sctx, 'sidebarRightTabs')
      var controller = serviceOf(sctx, 'sidebarRight')
      if (tabs == null || controller == null) {
        console.error('[code-server] 右侧栏服务上下文不可见(sidebarRightTabs='
          + (tabs != null) + ', sidebarRight=' + (controller != null) + '):跳过侧栏注册')
        return false
      }
      var slots = serviceOf(sctx, 'slots')
      sctx.effect(function () {
        return tabs.register({
          id: CS_TAB_ID,
          kind: CS_KIND,
          // 产品外插件 = extension 段(rank 3),高于官方的 fallback 段(rank 1):
          // 官方的纯文本预览(`ui-sidebar-documentpreview`,kind text)故意用 fallback,
          // 它的注释写明"这是 VS Code 的文本编辑器在编辑器中的位次,任何更具体的类型都应当击败它"。
          priority: 'extension',
          // **认领文件地址**:官方 openFile(产物 chip、"交付"卡片预览、正文内联提及)以及任何
          // 第三方 openResource(fileAddress) 都会落到本 tab。含 `:` 的 pattern 按整址 glob 匹配。
          patterns: ['dsh-resource://file/**'],
          canOpen: function (a) { return claimsAddress(parseFileAddress(a), fileOpenScope()) },
          // 文件 tab 用文件名当 chip 文本;页面 tab(openTab/openResource 指定 kind)仍是产品名
          title: function (a) {
            if (isPageAddress(a) || a === undefined || a === null || a === '') return 'Code Server'
            var name = basenameOfAddress(a)
            return name === '' ? 'Code Server' : name
          },
          // guide 页入口框:点它即以本类型打开一个页面 tab(替换 guide 自身)
          guide: [{
            order: 20,
            title: function () { return 'Code Server' },
            description: function () { return '在右侧栏标签里运行 VS Code 网页版,跟随当前会话工作区;产物/交付文件点击后在此打开。' },
            icon: CodeServerIcon,
          }],
        })
      }, 'code-server: sidebar tab type')
      if (slots != null) {
        sctx.effect(function () {
          return slots.inject('sidebar.right.pane.tab', function () {
            return slots.register({ name: 'sidebar.right.pane.tab', key: CS_TAB_ID }, CodeServerBody)
          })
        }, 'code-server: sidebar tab body')
      } else {
        console.error('[code-server] slots 服务不可见:侧栏标签 body 未注册')
        return false
      }
      // 卸载 / HMR 重载:复位载体状态(legacy 判定由下一次 apply 重新做)
      sctx.effect(function () {
        return function () {
          setState({ sidebarUi: 'unknown' })
        }
      }, 'code-server: sidebar mode reset')
      console.log('[code-server] right-sidebar tab registered (kind=' + CS_KIND + ')')
      return true
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
      '.dshcs-card .dshcs-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;line-height:1.5}' +
      '.dshcs-check{display:flex;align-items:center;gap:8px;cursor:pointer}' +
      '.dshcs-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;margin:0;flex:none}' +
      '.dshcs-check input:disabled{cursor:default}' +
      '.dshcs-select{display:inline-flex;align-items:center}' +
      '.dshcs-select select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px;min-width:220px;cursor:pointer}' +
      '.dshcs-select select:disabled{opacity:.5;cursor:default}' +
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
    /** 下拉选择(用于两三个离散取值,如"认领范围");观感与 csCheck 一致。 */
    function csSelect(props) {
      var options = Array.isArray(props.options) ? props.options : []
      return React.createElement('label', { className: 'dshcs-select' },
        React.createElement('select', {
          value: props.value, disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value) },
        }, options.map(function (opt) {
          return React.createElement('option', { key: opt.value, value: opt.value }, opt.label)
        }))
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
        var [draft, setDraft] = React.useState(null) // null | { keepResident, fileOpenScope }(未保存草稿)
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
        keepResident: value.keepResident !== false,
        fileOpenScope: value.fileOpenScope === 'all' ? 'all' : 'session',
        fullscreenOnOpen: value.fullscreenOnOpen !== false,
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
      var overriddenKeep = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'keepResident')
      var overriddenScope = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'fileOpenScope')
      var overriddenFullscreen = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'fullscreenOnOpen')
      var dirty = draft !== null && (draft.keepResident !== loaded.keepResident
        || draft.fileOpenScope !== loaded.fileOpenScope
        || draft.fullscreenOnOpen !== loaded.fullscreenOnOpen)
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
            await props.scope.set('keepResident', d.keepResident === true)
            await props.scope.set('fileOpenScope', d.fileOpenScope === 'all' ? 'all' : 'session')
            await props.scope.set('fullscreenOnOpen', d.fullscreenOnOpen === true)
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
            await props.scope.unset('keepResident')
            await props.scope.unset('fileOpenScope')
            await props.scope.unset('fullscreenOnOpen')
          } else {
            await props.scope.set('keepResident', value.keepResident === undefined || value.keepResident === null ? true : value.keepResident)
            await props.scope.set('fileOpenScope', value.fileOpenScope === 'all' ? 'all' : 'session')
            await props.scope.set('fullscreenOnOpen', value.fullscreenOnOpen === undefined || value.fullscreenOnOpen === null ? true : value.fullscreenOnOpen)
          }
          setDraft(null)
          syncStatusToStore()
        } catch (e) {
          setFailed(true)
        }
        setSaving(false)
      }
      return React.createElement(csCard, {
        title: 'Code Server',
        description: '入口:右侧栏标签(DSH ≥ 0.1.5-alpha.1);认领范围决定哪些文件交给 Code Server 打开',
        state: state,
        unsavedLabel: '未保存', readOnlyLabel: '本部署的设置为只读。',
        saveFailedLabel: '本部署没有接受这些值，已保留供你修改。',
        discardLabel: '放弃修改', saveLabel: '保存', savingLabel: '保存中…',
        onSave: doSave, onDiscard: function () { setDraft(null); setFailed(false) },
      },
        // 卡片三个设置(0.2.9 起):认领范围 + 打开即全屏 + 后台常驻。入口/依赖安装/环境检测三行已移除
        // (入口在右侧栏「开始」页的 guide 入口框;诊断看 host 日志里的 [code-server] 输出)。
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '认领范围(哪些文件交给 Code Server)'),
            overriddenScope === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csSelect, {
            value: draft !== null ? draft.fileOpenScope : loaded.fileOpenScope,
            disabled: snapshot.writable !== true,
            options: [
              { value: 'session', label: '仅会话内文件(推荐)' },
              { value: 'all', label: '所有文件(含工作区外的绝对路径)' },
            ],
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { fileOpenScope: v === 'all' ? 'all' : 'session' }) }); setFailed(false) },
          }),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '会话内文件 = DSH 用 `dsh-resource://file/session/…` 命名的文件(产物、交付、正文提及、工具视图);'
            + '“所有文件”还会认领不带会话的绝对路径 `dsh-resource://file/absolute/…`。'
            + '未被认领的地址由 DSH 自带预览兜底。')
        ),
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '打开即全屏(右侧栏铺满窗口)'),
            overriddenFullscreen === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csCheck, {
            checked: draft !== null ? draft.fullscreenOnOpen : loaded.fullscreenOnOpen,
            disabled: snapshot.writable !== true,
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { fullscreenOnOpen: v === true }) }); setFailed(false) },
          }, '打开 Code Server 标签(含点开产物/交付文件)时,自动把右侧栏从"与对话并排"切到全屏;'
            + '想同时看对话就关掉它,或随时点右侧栏的「退出全屏」—— 本次打开不会被抢回去'),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '只影响"打开那一刻":切走再切回、再次打开文件 tab 会重新切全屏;'
            + 'DSH 未向插件开放模式接口,本项由点击右侧栏自身的「全屏」按钮实现。')
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
        )
      )
      } catch (e) {
        // 渲染异常:记日志不打断;官方插槽对异常有边界,卡片留空即可
        console.error('[code-server] card render error:', e !== null && e !== undefined && e.message !== undefined ? e.message : String(e))
        return null
      }
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

      // ---- 能力探测:只有带右侧栏服务(DSH ≥ 0.1.5-alpha.1)才注册可用 UI;探测不到就只留设置页提示 ----
      var modernSettled = false

      function onModernUi(sctx, via) {
        if (modernSettled) return
        modernSettled = true
        clearTimers()
        var registered = false
        try {
          registered = registerSidebarTab(sctx)
        } catch (e) {
          console.error('[code-server] sidebar tab registration failed:',
            e != null && e.message != null ? e.message : String(e))
        }
        if (state.sidebarUi === 'legacy') {
          // 自愈:旧版判定之后服务才出现(慢启动的宿主)→ 撤销判定,并让 host 恢复预启动逻辑
          console.log('[code-server] 右侧栏服务晚到(经 ' + via + '):撤销旧版 DSH 判定')
          api('/code-server/ui-mode', { sidebar: true }).catch(function () { /* 仅优化 */ })
        }
        setState({ sidebarUi: 'modern', sidebarRegisterFailed: registered !== true })
        // 常驻预热:不渲染任何东西,宿主 running 时把 IDE 加载到停放区
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'code-server', order: 70, label: 'Code Server' },
          (props) => React.createElement(Resident, props)
        ))
        // 不注册 conversation.chat.turnTail:官方产物/交付行由 ui-deliverables 渲染,
        // 我们只通过 patterns/canOpen 认领文件地址,让它的 openFile 落到本 tab。
        console.log('[code-server] client registered via ' + via + ': sidebar tab=' + registered
          + '(claims dsh-resource://file/**) + resident preload + settings card')
      }

      function onLegacyDsh(reportToHost) {
        setState({ sidebarUi: 'legacy' })
        console.warn('[code-server] 未探测到右侧栏服务(sidebarRightTabs/sidebarRight):'
          + ' 本插件自 0.2.3 起不再兼容旧版 DSH —— 除「设置 → 插件 → Code Server」的提示外不提供任何入口,'
          + '也不预热 IDE。请升级 DSH。')
        if (reportToHost === true) {
          // 上报 host:让它别为一个用不了的 UI 自动预启动/继续运行 IDE
          api('/code-server/ui-mode', { sidebar: false }).catch(function () { /* 只是优化,失败不影响提示 */ })
        }
      }

      var noticeTimer = null
      var reportTimer = null
      var syncTimer = null
      function clearTimers() {
        if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null }
        if (reportTimer !== null) { clearTimeout(reportTimer); reportTimer = null }
        if (syncTimer !== null) { clearTimeout(syncTimer); syncTimer = null }
      }

      // 统一经 ctx.inject 拿服务上下文(服务已就绪时也会回调,只是可能晚一个 tick)
      var injectAccepted = false
      try {
        if (typeof ctx.inject === 'function') {
          injectAccepted = true
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (sctx) { onModernUi(sctx, 'inject') })
        }
      } catch (e) {
        console.warn('[code-server] sidebar inject failed:', e != null && e.message != null ? e.message : String(e))
      }

      // 同步探测:只看"服务是否已在注册表里",用于决定要不要启动旧版判定/兜底注册
      var syncReady = typeof ctx.get === 'function'
        && ctx.get('sidebarRightTabs') !== undefined && ctx.get('sidebarRight') !== undefined

      if (syncReady) {
        // 服务已在,但 inject 可能迟迟不回调(上下文差异)→ 1.5s 后用同步服务兜底注册,
        // 避免"卡片正常、侧栏却没有入口"这种静默失败。
        syncTimer = setTimeout(function () {
          if (modernSettled) return
          console.warn('[code-server] ctx.inject 未在 1.5s 内回调,改用同步服务注册侧栏')
          onModernUi(ctx, 'sync-fallback')
        }, SYNC_FALLBACK_MS)
        return
      }
      if (injectAccepted !== true) {
        onLegacyDsh(true)
        return
      }
      // 服务晚到:先只给提示(可逆),更久仍无服务才通知 host 回收/停止预启动
      noticeTimer = setTimeout(function () {
        if (modernSettled) return
        onLegacyDsh(false)
      }, LEGACY_NOTICE_MS)
      reportTimer = setTimeout(function () {
        if (modernSettled) return
        onLegacyDsh(true)
      }, LEGACY_REPORT_MS)
    }

    const inject = ['slots', 'settingsScope']
    const name = 'code-server'
    export { apply, inject, name }
