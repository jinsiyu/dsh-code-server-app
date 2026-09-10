// dsh-code-server — client bundle(右侧栏标签 iframe;旧版 DSH 回退悬浮球 + 浮动窗口)
// 构建:node scripts/build-client.mjs → lib/client.js。
// 产物形态:window.__ModuleLoader__.load({ id, factory })——esbuild 以 CJS 打包,
// 整个 bundle 内嵌进 factory 函数体,静态 require('react'/'react-dom'/'react/jsx-runtime')
// 直接落在 factory 的 require 参数上(DSH 冻结模块表;种子含 react/jsx-runtime)。
// 唯一源码:src/factory.js;改动后执行 `pnpm run build:client` 重新生成 lib/client.js。
//
// 数据通道:同源 fetch DSH Connection 的共享 /api 通道(host: ctx.connection.fetch.register)
//   GET  /api/code-server/status → { ok, running, status, port, host, pid, cwd, url, version, error, logTail, adopted }
//   POST /api/code-server/start  → { cwd? } → status
//   POST /api/code-server/stop   → status
//   POST /api/code-server/setup / open-file
// web 与 desktop 路径相同:web 由 webServer 的 /api 前缀承载,desktop 由 IPC 帧管道承载 → 插件不依赖 webServer。
//
// UI 载体(二选一,运行时特性检测,不按版本号硬判):
//   A) DSH ≥ 0.1.5-alpha.1 且右侧栏服务就绪(ctx.inject(['sidebarRightTabs','sidebarRight'])
//      回调触发)→ 注册 tab 类型 kind=code-server(id=dsh-code-server-app):
//        - 一段:ctx.sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })
//          → 右侧栏 guide 页出现入口框(data-sidebar-right-guide-entry="code-server")
//        - 二段:ctx.slots.register({ name:'sidebar.right.pane.tab', key:id }, CodeServerBody)
//          → tab 内渲染 code-server iframe;body 经 props.useTabInfo() 取 navigation/visible
//        此时悬浮球与浮窗一律渲染 null(不再使用悬浮窗)。
//   B) 服务缺失(旧版 DSH / 注册失败)→ 保持原样:shell.overlay 悬浮球 + 内部浮动窗口。
//
// 浮窗结构(参照 dsh-univer-office 的 WorktreeWindow,仅回退路径使用):
//   - shell.overlay(id code-server):悬浮球(code-server 图标,点击展开/收起浮窗,
//     打开时发光)+ 内部浮动窗口——无标题栏、无控制按钮,顶部细条拖动、
//     双击最大化、8 向缩放;最大化/恢复/吸附动画由 motion 弹簧驱动
//
// 窗口几何与手势完全复刻 univer-office 模式:
//   - 根容器 position:fixed inset:0 pointer-events:none(点击穿透到底层)
//   - 窗口 pointer-events:auto,顶部细条 pointerdown 拖动(setPointerCapture),
//     双击最大化,8 个 resize handle 缩放,min 尺寸约束,viewport 边缘 clamp。
import { motion } from 'motion/react';
// 常驻 IDE 面:iframe 由 surface.js 持有,不随 React 装卸(切标签/收起侧栏不重载)
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
    // ReactDOM 为必需:窗口经 createPortal 挂到 document.body(跨越 shell.overlay 的
    // stacking context)。react-dom 在冻结模块表内(官方 feedback bundle 同款),
    // 缺失时在此显式失败(而非静默降级导致窗口被输入框遮挡)。
    let ReactDOM = require('react-dom')

    // ---------- 模块级共享 store:同步 open/status + 悬浮球位置(动画锚点) --------haihui
    var listeners = new Set()
    // sidebarActive=true 表示右侧栏服务已就绪并注册成功 → 悬浮球/浮窗全部停用。
    var state = { open: false, status: null, busy: false, ballPos: null, sidebarActive: false }
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

    /** 常驻 IDE 面组件(浮窗与右侧栏标签共用):只渲染"停靠位",iframe 由 surface.js 持有,
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
    var COMPOSER_RESERVE_DEFAULT = 148 // 输入框 + 下发 dock 的近似高度(测量失败时的回退)

    /** 输入区预留:flag=false(用户允许)不保留 → 0。
     *  flag=true(默认)时:若 composer 贴住视口底(会话页/对话中),让最大化窗口
     *  底边贴到 composer 输入卡顶部——窗口压住消息区,下面只露出输入框;
     *  若 composer 不在底部(hero 页/新会话描述画面),输入框在页面中间,
     *  最大化直接全屏(0),避免在输入框下方露出页面背景渐变。 */
    function reserveOf(flag) {
      if (flag === false) return 0
      try {
        if (typeof document === 'undefined') return 0
        var seats = document.querySelectorAll('[data-composer-seat]')
        if (seats === null || seats.length === 0) return 0 // 无 composer:全屏
        var top = Number.POSITIVE_INFINITY
        var bottom = 0
        for (var i = 0; i < seats.length; i++) {
          var rect = seats[i].getBoundingClientRect()
          if (rect === null || rect.width <= 0) continue
          if (rect.top < top) top = rect.top
          if (rect.bottom > bottom) bottom = rect.bottom
        }
        if (!isFinite(top) || bottom <= 0) return 0
        var viewportBottom = window.innerHeight
        // composer 未贴底(hero 页,seat 底沿离视口底 > 24px)→ 全屏
        if (viewportBottom - bottom > 24) return 0
        // 会话页:窗口底边 = 输入卡顶部,下面只留输入框(+ 8px 呼吸边距)
        return Math.min(Math.max(1, viewportBottom - top + 8), 420)
      } catch (e) {
        return 0
      }
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
      // 初始位置:输入框上方、靠右(右下偏上),级联偏移。
      // reserve=0(允许盖住)时初始仍在输入框上方(有效下沿 = composer 顶部,
      // 若 composer 贴底则留输入框高度,避免开局就压住输入框);用户想盖住
      // 输入框时点"最大化"(或拖到底部)即可,最大化才允许占满视口底。
      const composerTop = composerTopOf()
      const bottomLimit = composerTop > 0
        ? composerTop - 8
        : viewport.height - VIEWPORT_GUTTER - reserve
      return fitRect({
        x: viewport.width - VIEWPORT_GUTTER - width - stackIndex * CASCADE_OFFSET,
        y: Math.max(VIEWPORT_GUTTER, bottomLimit - height - stackIndex * CASCADE_OFFSET),
        width, height,
      }, viewport, reserve)
    }
    /** composer 输入区顶部(视口坐标);无 composer 时返回 -1。 */
    function composerTopOf() {
      try {
        if (typeof document === 'undefined') return -1
        var seats = document.querySelectorAll('[data-composer-seat]')
        if (seats === null || seats.length === 0) return -1
        var top = Number.POSITIVE_INFINITY
        for (var i = 0; i < seats.length; i++) {
          var rect = seats[i].getBoundingClientRect()
          if (rect !== null && rect.width > 0 && rect.top < top) top = rect.top
        }
        return isFinite(top) ? top : -1
      } catch (e) {
        return -1
      }
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

    // ---------- 样式(主题变量 + 兜底值;仅覆盖窗口与悬浮球自身结构) ----------
    // 悬浮球:code-server 图标球,点击展开/收起浮窗,打开时发光;窗口无任何控制按钮。
    var CSS =
      '.dshcs-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none}' +
      '.dshcs-win{--dshcs-accent:#5b6cff;pointer-events:auto;position:fixed;isolation:isolate;z-index:2147483000;display:flex;flex-direction:column;min-width:1px;min-height:1px;overflow:hidden;color:var(--dsw-alias-label-primary,#172033);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:12px;box-shadow:0 1px 2px rgba(13,22,38,.08),0 18px 48px rgba(13,22,38,.2),0 0 0 1px rgba(255,255,255,.4) inset;transition:border-color .16s ease,box-shadow .16s ease}' +
      '.dshcs-win:hover{border-color:color-mix(in srgb,var(--dshcs-accent) 28%,var(--dsw-alias-border-l2,#dfe3eb));box-shadow:0 2px 5px rgba(13,22,38,.1),0 22px 58px rgba(13,22,38,.24),0 0 0 1px rgba(255,255,255,.5) inset}' +
      '.dshcs-win[data-interaction]{transition:none;user-select:none}' +
      '.dshcs-win[data-interaction]::after{content:"";position:absolute;inset:0;z-index:18;background:transparent}' +
      '.dshcs-win-max{border-radius:14px;z-index:2147483001;box-shadow:0 1px 2px rgba(13,22,38,.06),0 8px 24px rgba(13,22,38,.12)}' +
      '.dshcs-win-max:hover{box-shadow:0 1px 2px rgba(13,22,38,.06),0 10px 28px rgba(13,22,38,.14)}' +
      '.dshcs-win-snap{border-color:color-mix(in srgb,var(--dshcs-accent) 70%,var(--dsw-alias-border-l2,#dfe3eb));box-shadow:0 0 0 3px color-mix(in srgb,var(--dshcs-accent) 26%,transparent),0 22px 58px rgba(13,22,38,.24),0 0 0 1px rgba(255,255,255,.5) inset}' +
      '.dshcs-snapghost{position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;display:grid;place-items:center;border:1.5px solid color-mix(in srgb,var(--dshcs-accent,#5b6cff) 85%,transparent);background:color-mix(in srgb,var(--dshcs-accent,#5b6cff) 11%,transparent);border-radius:12px;box-shadow:0 0 0 3px color-mix(in srgb,var(--dshcs-accent,#5b6cff) 20%,transparent),0 10px 34px rgba(13,22,38,.14)}' +
      '.dshcs-snapghint{position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:5px 14px;border-radius:999px;background:color-mix(in srgb,var(--dshcs-accent,#5b6cff) 92%,#172033);color:#fff;font-size:12px;font-weight:650;letter-spacing:.02em;white-space:nowrap;box-shadow:0 6px 18px rgba(13,22,38,.3)}' +
      '.dshcs-drag{position:absolute;top:0;left:0;right:0;height:14px;z-index:26;cursor:grab;touch-action:none;user-select:none}' +
      '.dshcs-win[data-interaction=move] .dshcs-drag{cursor:grabbing}.dshcs-win-max .dshcs-drag{cursor:default}' +
      '.dshcs-drag:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#172033) 5%,transparent)}' +
      '.dshcs-artbtn{appearance:none;display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:6px;color:var(--dsw-alias-label-secondary,#566174);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent);cursor:pointer;transition:color .12s ease,background .12s ease,border-color .12s ease;vertical-align:middle}' +
      '.dshcs-artbtn:hover{color:var(--dsw-alias-label-primary,#172033);border-color:color-mix(in srgb,var(--dshcs-accent) 40%,var(--dsw-alias-border-l2,#dfe3eb));background:color-mix(in srgb,var(--dshcs-accent) 8%,transparent)}' +
      '.dshcs-artbtn:active{transform:scale(.94)}' +
      '.dshcs-artbtn:focus-visible{outline:2px solid color-mix(in srgb,var(--dshcs-accent) 65%,transparent);outline-offset:1px}' +
      '.dshcs-artifacts{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px 8px;margin-top:16px;font-size:13px;line-height:22px;position:relative}' +
      '.dshcs-artlabel{color:var(--dsw-alias-label-tertiary,#7d8798);grid-area:1/1}' +
      '.dshcs-artrow{flex-wrap:nowrap;grid-area:1/2;align-items:center;gap:8px;min-width:0;display:flex;overflow:hidden}' +
      '.dshcs-artitem{display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0}' +
      '.dshcs-artfile{text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);max-width:320px;color:var(--dsw-alias-label-secondary,#566174);font:inherit;cursor:pointer;border:none;border-radius:6px;margin:0;padding:0 8px;overflow:hidden}' +
      '.dshcs-artfile:hover{color:var(--dsw-alias-label-primary,#172033);text-decoration:underline}' +
      '.dshcs-artfile:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3);outline:none}' +
      '.dshcs-artmore{white-space:nowrap;color:var(--dsw-alias-label-tertiary,#7d8798);flex:none}' +
      '.dshcs-body{position:relative;display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:var(--dsw-alias-bg-base,#fff)}.dshcs-body[hidden]{display:none}' +
      '.dshcs-frame{display:block;position:absolute;inset:0;z-index:1;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-loading{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-tertiary,#7d8798);font-size:13px}' +
      // 最小化:收起=隐藏(不卸载)。保留 DOM/iframe,VS Code 状态不丢;重新展开瞬时恢复。
      // opacity/位置由 motion 驱动(球锚动画),此处仅 pointer-events 关闭。
      '.dshcs-win-hidden{pointer-events:none!important}' +
      '.dshcs-empty{position:relative;z-index:2;flex:1;display:flex;align-items:center;justify-content:center;padding:44px 24px 24px}' +
      '.dshcs-emptybox{max-width:560px;text-align:left;background:var(--dsw-alias-bg-layer-2,#f7f8fb);border:1px solid var(--dsw-alias-border-l2,#dfe3eb);border-radius:12px;padding:16px 18px}' +
      '.dshcs-error{color:var(--dsw-alias-label-error,#d92d20);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin:8px 0 0}' +
      '.dshcs-hint{color:var(--dsw-alias-label-tertiary,#7d8798);font-size:12px;margin:6px 0 0}' +
      '.dshcs-resize{position:absolute;z-index:24;display:block;touch-action:none}' +
      '.dshcs-resize-n,.dshcs-resize-s{left:16px;right:16px;height:10px;cursor:ns-resize}.dshcs-resize-n{top:0}.dshcs-resize-s{bottom:0}' +
      '.dshcs-resize-w,.dshcs-resize-e{top:16px;bottom:16px;width:10px;cursor:ew-resize}.dshcs-resize-w{left:0}.dshcs-resize-e{right:0}' +
      '.dshcs-resize-nw,.dshcs-resize-ne,.dshcs-resize-sw,.dshcs-resize-se{width:18px;height:18px}' +
      '.dshcs-resize-nw{left:0;top:0;cursor:nwse-resize}.dshcs-resize-ne{right:0;top:0;cursor:nesw-resize}.dshcs-resize-sw{left:0;bottom:0;cursor:nesw-resize}.dshcs-resize-se{right:0;bottom:0;cursor:nwse-resize}' +
      '.dshcs-resize-se::after{content:"";position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-right:1.5px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d8798) 58%,transparent);border-bottom:1.5px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d8798) 58%,transparent);border-radius:0 0 2px}' +
      '.dshcs-ball{position:fixed;width:38px;height:38px;padding:0;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#dfe3eb) 80%,transparent);border-radius:50%;display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;z-index:2147483002;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f2f4f8) 88%,transparent);backdrop-filter:blur(8px) saturate(1.2);box-shadow:0 8px 20px rgba(13,22,38,.18),0 1px 2px rgba(13,22,38,.1);transition:transform .16s ease,box-shadow .16s ease,background .16s ease,border-color .16s ease}' +
      '.dshcs-ball img,.dshcs-ball svg{-webkit-user-drag:none;user-drag:none}' +
      '.dshcs-ball[data-dragging]{cursor:grabbing;transform:scale(1.06);box-shadow:0 14px 28px rgba(13,22,38,.28),0 2px 6px rgba(13,22,38,.16)}' +
      '.dshcs-ball:hover{transform:scale(1.06);box-shadow:0 10px 24px rgba(13,22,38,.22),0 1px 2px rgba(13,22,38,.1)}' +
      '.dshcs-ball:active{transform:scale(.94)}' +
      '.dshcs-ball:focus-visible{outline:2px solid color-mix(in srgb,var(--dshcs-accent) 65%,transparent);outline-offset:2px}' +
      '.dshcs-ball-open{background:color-mix(in srgb,var(--dshcs-accent) 14%,var(--dsw-alias-bg-layer-2,#f2f4f8));border-color:color-mix(in srgb,var(--dshcs-accent) 55%,var(--dsw-alias-border-l2,#dfe3eb));box-shadow:0 0 0 3px color-mix(in srgb,var(--dshcs-accent) 22%,transparent),0 0 20px color-mix(in srgb,var(--dshcs-accent) 38%,transparent),0 8px 20px rgba(13,22,38,.16);transform:scale(1.08)}' +
      '.dshcs-ball-dot{position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:#20a66a;border:2px solid var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-ball-dot[data-status=starting]{background:#d78b25}' +
      '.dshcs-ball-dot[data-status=error]{background:#f85149}' +
      '.dshcs-ball-dot[data-status=idle]{background:#7d8798}' +
      '.dshcs-ball-dot[data-status=running]::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid currentColor;opacity:.3;animation:dshcs-pulse 2s ease-out infinite}' +
      // 右侧栏标签 body:撑满面板(iframe/空态复用窗口内同一套 .dshcs-frame/.dshcs-empty)
      '.dshcs-tabroot{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#fff)}' +
      // 常驻面:停靠位占满面板;停放容器离屏(或按策略压在面板下),iframe 始终是同一个(见 src/surface.js)
      '.dshcs-slot{position:relative;display:block;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}' +
      '.dshcs-park{position:fixed;left:-20000px;top:0;width:320px;height:200px;overflow:hidden;pointer-events:none;z-index:0;visibility:hidden;contain:strict}' +
      '@keyframes dshcs-pulse{0%{transform:scale(.7);opacity:.35}70%,100%{transform:scale(1.65);opacity:0}}'
    var CSS_TAG = 'dsh-code-server/styles'
    if (typeof document !== 'undefined' && document.querySelector('style[data-dshcs=' + JSON.stringify(CSS_TAG) + ']') === null) {
      var tag = document.createElement('style')
      tag.setAttribute('data-dshcs', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------- 悬浮球(唯一入口/开关) ----------
    // code-server 图标球:点击展开浮窗并发光,再点击收起并复原;
    // 替代原侧栏底部按钮与窗口控制按钮组(那些按钮不再存在)。
    function CodeGlyph(props) {
      var [broken, setBroken] = React.useState(false)
      var urlRef = React.useRef(props.url)
      React.useEffect(function () {
        if (urlRef.current !== props.url) {
          urlRef.current = props.url
          setBroken(false)
        }
      }, [props.url])
      if (props.url != null && broken !== true) {
        // 固化官方图标(内联 data URI,随插件分发;不依赖任何服务端路由)
        // draggable:false 禁止原生图片拖拽,避免抓住图标时触发浏览器默认拖动(与指针拖拽打架)
        return React.createElement('img', {
          src: props.url, key: 'img-' + props.url, alt: '', 'aria-hidden': true,
          draggable: false,
          onError: function () { setBroken(true) },
          style: { width: 20, height: 20, display: 'block', objectFit: 'contain', borderRadius: 3, WebkitUserDrag: 'none', userSelect: 'none' },
        })
      }
      // 未运行/图标加载失败:自绘网格徽标
      return React.createElement('svg', { viewBox: '0 0 18 18', 'aria-hidden': true, style: { width: 17, height: 17 } },
        React.createElement('rect', { x: '3', y: '3', width: '12', height: '12', rx: '2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        React.createElement('path', { d: 'M3 7h12M7 3v12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 })
      )
    }
    // 悬浮球拖拽:localStorage 记忆位置;拖完松手不触发点击
    var BALL_SIZE = 38
    var BALL_MARGIN = 8
    var BALL_POS_KEY = 'dshcs-ball-pos'
    function clampBall(pos) {
      var maxX = Math.max(BALL_MARGIN, window.innerWidth - BALL_MARGIN - BALL_SIZE)
      var maxY = Math.max(BALL_MARGIN, window.innerHeight - BALL_MARGIN - BALL_SIZE)
      return { x: Math.min(maxX, Math.max(BALL_MARGIN, pos.x)), y: Math.min(maxY, Math.max(BALL_MARGIN, pos.y)) }
    }
    function loadBallPos() {
      try {
        var raw = window.localStorage.getItem(BALL_POS_KEY)
        if (raw == null) return null
        var v = JSON.parse(raw)
        if (v != null && typeof v.x === 'number' && typeof v.y === 'number' && isFinite(v.x) && isFinite(v.y)) return clampBall(v)
      } catch (e) { /* ignore */ }
      return null
    }
    function saveBallPos(pos) {
      try { window.localStorage.setItem(BALL_POS_KEY, JSON.stringify(pos)) } catch (e) { /* ignore */ }
    }
    function Ball(props) {
      var store = useStore()
      var status = store.status
      var env = status != null ? status.env : null
      var running = status != null && status.running === true
      var statusKind = running ? 'running' : status != null && status.status === 'starting' ? 'starting' : status != null && status.status === 'error' ? 'error' : 'idle'
      var reserve = reserveOf(status != null ? status.reserveComposer : true)
      var isOpen = store.open === true
      // 悬浮球图标固化:始终使用 host 提供的 code-server 官方图标(assets 随插件分发),
      // 不依赖 code-server 运行时——启动即显示,未运行/加载失败才回退自绘网格。
      var iconUrl = ICON_URL
      // 拖动定位:pos=null 时用默认位(输入框上方、右侧);拖动后记忆到 localStorage
      var [pos, setPos] = React.useState(loadBallPos)
      var [dragging, setDragging] = React.useState(false)
      var dragRef = React.useRef(null) // { pointerId, dx, dy, moved }
      var suppressClickRef = React.useRef(false)
      React.useEffect(function () {
        var onResize = function () {
          setPos(function (current) { return current == null ? current : clampBall(current) })
        }
        window.addEventListener('resize', onResize)
        return function () { window.removeEventListener('resize', onResize) }
      }, [])
      // 悬浮球位置同步到共享 store(Window 动画锚点);默认位(未拖动)也计算基准
      React.useEffect(function () {
        var base = pos != null ? pos : (function () {
          var reserve = reserveOf(status != null ? status.reserveComposer : true)
          return { x: window.innerWidth - BALL_MARGIN - BALL_SIZE, y: window.innerHeight - BALL_MARGIN - BALL_SIZE - (reserve > 0 ? reserve + 10 : 18) }
        })()
        setState({ ballPos: clampBall(base) })
      }, [pos, status])
      // 仅当环境明确检测不通过时隐藏(必须放在所有 Hook 之后,避免 React Hook 顺序违规)
      if (env != null && env.ok !== true) return null
      // 右侧栏模式:不再使用悬浮窗(入口 = 右侧栏 guide 入口框 / 产物按钮 / 设置卡按钮)
      if (store.sidebarActive === true) return null
      var ballOnPointerDown = function (event) {
        if (event.button !== 0) return
        var el = event.currentTarget
        var rect = el.getBoundingClientRect()
        dragRef.current = {
          pointerId: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          moved: false,
        }
        suppressClickRef.current = false
        setDragging(true)
        try { el.setPointerCapture(event.pointerId) } catch (e) { /* capture 失败仍可跟随 */ }
      }
      var ballOnPointerMove = function (event) {
        var d = dragRef.current
        if (d == null || event.pointerId !== d.pointerId) return
        var nx = event.clientX - d.dx
        var ny = event.clientY - d.dy
        if (Math.abs(nx - (pos != null ? pos.x : 0)) > 2 || Math.abs(ny - (pos != null ? pos.y : 0)) > 2) d.moved = true
        setPos(clampBall({ x: nx, y: ny }))
      }
      var ballOnPointerUp = function () {
        var d = dragRef.current
        dragRef.current = null
        setDragging(false)
        if (d != null && d.moved === true) suppressClickRef.current = true
        if (d != null && d.moved === true) {
          setPos(function (current) {
            if (current != null) saveBallPos(current)
            return current
          })
        }
      }
      var ballOnClick = function () {
        if (suppressClickRef.current === true) { suppressClickRef.current = false; return }
        // 窗口化:新标签页打开(未运行时先启动,带当前工作区目录)
        if (status != null && status.windowedOpen === true) {
          openExternalTab(activeWorkspaceCwd(props && props.useSessions, props && props.useWorkspaces))
          return
        }
        setState({ open: !isOpen })
      }
      // 位置:默认输入框上方靠右;拖动后固定于记忆位置(不遮挡 composer;打开时仍可见可点)
      var style = pos != null
        ? { left: pos.x, top: pos.y }
        : { right: 14, bottom: (reserve > 0 ? reserve + 10 : 18) }
      return ReactDOM.createPortal(
        React.createElement('button', {
          type: 'button',
          className: 'dshcs-ball' + (isOpen ? ' dshcs-ball-open' : ''),
          style: style,
          'data-dragging': dragging === true ? '' : undefined,
          title: status != null && status.windowedOpen === true
            ? '在浏览器新标签页打开 Code Server(可拖动)'
            : (isOpen ? '收起 Code Server(Esc)' : '打开 Code Server(可拖动)'),
          'aria-label': isOpen ? '收起 Code Server(Esc)' : '打开 Code Server',
          'aria-expanded': isOpen,
          onPointerDown: ballOnPointerDown,
          onPointerMove: ballOnPointerMove,
          onPointerUp: ballOnPointerUp,
          onPointerCancel: ballOnPointerUp,
          onDragStart: function (event) { if (event && event.preventDefault) event.preventDefault() },
          onClick: ballOnClick,
        },
          React.createElement(CodeGlyph, { url: iconUrl }),
          React.createElement('span', { className: 'dshcs-ball-dot', 'data-status': statusKind, 'aria-hidden': true })
        ),
        document.body
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

      // 顶部吸附手势:普通拖动时窗口顶边被夹在距顶 VIEWPORT_GUTTER(12px,设计留白),
      // 拖到该极限位置即出现"幽灵预览 + 松开以最大化"示意 → 松开最大化;
      // 最大化后按住顶部细条向下拖立即恢复(抓取点锚定,全程跟手)。
      var SNAP_Y = 12
      var RESTORE_THRESHOLD = 4
      var [snapMax, setSnapMax] = React.useState(false)
      var dragSessionRef = React.useRef(null)
      var beginPointerSession = function (event, kind) {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        cancelPointerSessionRef.current()
        var view = event.currentTarget.ownerDocument.defaultView
        if (view === null) return
        var pointerId = event.pointerId
        var element = event.currentTarget
        var wasMaximized = maximized
        // 起点:最大化时以最大化矩形为基准(用于"向下拖恢复"),否则用当前 rect
        var startRect = wasMaximized ? maximizedRect(viewportSize(), reserve) : rectRef.current
        var ratio = startRect.width > 0 ? (event.clientX - startRect.x) / startRect.width : 0
        var grabY = Math.min(14, Math.max(0, event.clientY - startRect.y)) // 抓取点在窗口内的 y(顶条区)
        var session = {
          pointerId: pointerId,
          origin: { x: event.clientX, y: event.clientY },
          start: startRect,
          ratio: ratio,
          grabY: grabY,
          wasMaximized: wasMaximized,
          restored: false,
          snapped: false,
          moved: false,
        }
        dragSessionRef.current = session
        setInteraction(kind)
        try { element.setPointerCapture(pointerId) } catch (e) { /* capture 失败仍可跟随 */ }
        var move = function (next) {
          if (next.pointerId !== pointerId) return
          if (kind !== 'move') { // 缩放手柄:纯 resize
            setRect(resizeRect(session.start, kind, next.clientX - session.origin.x, next.clientY - session.origin.y, viewportSize(), reserve))
            return
          }
          var dx = next.clientX - session.origin.x
          var dy = next.clientY - session.origin.y
          if (Math.abs(dx) + Math.abs(dy) > 3) session.moved = true
          if (session.wasMaximized) {
            if (!session.restored) {
              // 最大化中:向下拖立即恢复(抓取点锚定指针 → 窗口顶条始终贴着手),
              // 恢复后从当前指针位置继续拖。
              if (dy < RESTORE_THRESHOLD) return // 未达阈值:保持最大化
              var base = rectRef.current // 最大化前保存的 rect(恢复尺寸)
              var r = {
                x: next.clientX - base.width * Math.min(0.9, Math.max(0.1, session.ratio)),
                y: next.clientY - session.grabY,
                width: base.width,
                height: base.height,
              }
              r = fitRect(r, viewportSize(), reserve)
              session.restored = true
              session.start = r
              session.origin = { x: next.clientX, y: next.clientY }
              setMaximized(false)
              setRect(r)
              return
            }
            // 已恢复:落入下方普通拖动路径,逐帧跟手
          }
          // 吸附判定用未夹紧的期望 y:窗口顶边被 fitRect 夹在 VIEWPORT_GUTTER(12) 处,
          // 拖到该设计距离即亮起吸附高亮(否则永远够不到 8px 阈值)。
          var desiredY = session.start.y + dy
          var nextRect = moveRect(session.start, dx, dy, viewportSize(), reserve)
          setRect(nextRect)
          var snapping = desiredY <= SNAP_Y
          if (snapping !== session.snapped) {
            session.snapped = snapping
            setSnapMax(snapping)
          }
        }
        var cleanup = function () {
          view.removeEventListener('pointermove', move)
          view.removeEventListener('pointerup', finish)
          view.removeEventListener('pointercancel', finish)
          cancelPointerSessionRef.current = function () {}
          dragSessionRef.current = null
          try { element.releasePointerCapture(pointerId) } catch (e) { /* ignore */ }
        }
        var finish = function (next) {
          if (next.pointerId !== pointerId) return
          cleanup()
          setInteraction(null)
          // 拖到顶部松开 = 最大化(原地轻点不触发)。
          // 最大化会话中已恢复过(restored)的按普通拖拽对待:
          // 允许"拉下再拉回顶部"松手执行最大化;未恢复的保持最大化不动。
          if (!session.wasMaximized || session.restored === true) {
            if (session.snapped === true && session.moved === true) setMaximized(true)
            if (session.snapped === true) setSnapMax(false)
          }
        }
        cancelPointerSessionRef.current = cleanup
        view.addEventListener('pointermove', move)
        view.addEventListener('pointerup', finish)
        view.addEventListener('pointercancel', finish)
      }

      var toggleMaximized = function () {
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
        if (!store.open || store.sidebarActive === true) return
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
      }, [store.open, store.sidebarActive])

      // 跟随活动工作区(常驻,不等点球):工作区/会话变化即同步 cwd 到 code-server
      // (未运行时启动、运行中切目录重启),成功后刷新 iframe——后台持续对齐。
      React.useEffect(function () {
        if (store.sidebarActive === true) return
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
      }, [cwd, store.sidebarActive])

      // 窗口关闭时重置跟随基线,下次打开重新对齐
      React.useEffect(function () {
        if (!store.open) lastSyncedCwdRef.current = undefined
      }, [store.open])

      // 每 3s 轮询状态(常驻:最小化期间也保持状态新鲜,展开即时准确)
      React.useEffect(function () {
        if (store.sidebarActive === true) return
        var timer = window.setInterval(function () {
          api('/code-server/status').then(function (s) { setState({ status: s }) })
        }, 3000)
        return function () { window.clearInterval(timer) }
      }, [store.sidebarActive])

      // Esc 关闭
      React.useEffect(function () {
        if (!store.open) return
        function onKey(e) {
          if (e.key === 'Escape') setState({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [store.open])

      // 右侧栏模式:浮窗整棵子树不渲染(iframe 随之卸载;侧栏 body 自己挂 iframe)
      if (store.sidebarActive === true) return null

      // 常挂载:收起(open=false)仅隐藏,不卸载窗口/iframe——VS Code 状态保留,重新展开瞬时恢复
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

      var body = React.createElement(CodeServerSurface, {
        status: status, pageUrl: pageUrl, reloadTick: reloadTick, owner: 'window',
      })

      var className = ['dshcs-win', maximized ? 'dshcs-win-max' : '', snapMax ? 'dshcs-win-snap' : '', store.open === false ? 'dshcs-win-hidden' : ''].filter(Boolean).join(' ')
      // 最大化由 rect 驱动(maximizedRect 占满"输入栏上方"区域),不用 CSS inset;
      // 还原时回到拖动前的位置。
      var shownRect = maximized ? maximizedRect(viewportSize(), reserve) : rect
      // motion 驱动几何:拖动/缩放中即时跟随(duration 0),松手后的吸附/最大化/恢复用弹簧。
      // 展开/收回以悬浮球为锚点:收起 → 整体缩放(transform scale,内部不重新布局)
      // 到球的尺寸并落到球位;展开 → 从球位弹簧回窗口 rect。
      // 尺寸恒为 rect(不动画)——避免内容重排;视觉缩放只走 scale。
      var ball = store.ballPos != null ? store.ballPos : { x: window.innerWidth - BALL_MARGIN - BALL_SIZE, y: window.innerHeight - BALL_MARGIN - BALL_SIZE - (reserve > 0 ? reserve + 10 : 18) }
      var ballCenter = { x: ball.x + BALL_SIZE / 2, y: ball.y + BALL_SIZE / 2 }
      // scale 以元素中心为原点;收起时视觉最大边≈球径
      var shrinkScale = Math.max(0.05, BALL_SIZE / Math.max(shownRect.width, shownRect.height))
      var winPhysics = store.open === false
        ? {
            x: ballCenter.x - shownRect.width / 2,
            y: ballCenter.y - shownRect.height / 2,
            width: shownRect.width,
            height: shownRect.height,
            scale: shrinkScale,
            borderRadius: 19,
            opacity: 0, // 完全淡出:视觉被球收纳(球在该处,窗口不可见)
          }
        : {
            x: shownRect.x,
            y: shownRect.y,
            width: shownRect.width,
            height: shownRect.height,
            scale: 1,
            borderRadius: 12,
            opacity: 1,
          }
      var winTransition = interaction !== null
        ? { duration: 0 }
        : { type: 'spring', stiffness: 340, damping: 38, mass: 0.9, opacity: { type: 'spring', stiffness: 420, damping: 40, mass: 0.8 }, borderRadius: { duration: 0.2 } }

      var windowTree = React.createElement(motion.section, {
          className: className,
          // 收起态由样式直接兜底(不依赖 motion 结束态)——pointer-events 关闭防误点;
          // 视觉由 motion 驱动(scale 小球 + 半透明),不用 style opacity(避免与 motion 动画冲突)。
          style: store.open === false
            ? { left: 0, top: 0, pointerEvents: 'none' }
            : { left: 0, top: 0 },
          animate: winPhysics,
          initial: false,
          transition: winTransition,
          'data-interaction': interaction !== null ? interaction : undefined,
          role: 'dialog',
          'aria-label': 'Code Server',
        },
        // 无标题栏、无控制按钮:拖动区为顶部细条(拖动移动、双击最大化;关闭/展开由悬浮球)。
        React.createElement('span', {
          className: 'dshcs-drag',
          title: '拖动移动 / 双击最大化',
          onPointerDown: onHeaderPointerDown,
          onDoubleClick: onHeaderDoubleClick,
        }),
        React.createElement('div', { className: 'dshcs-body' },
          body
        ),
        !maximized
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
      // portal 到 document.body:脱离 shell.overlay(z-index 20)的 stacking context,
      // 让窗口真正覆盖到 DSH 输入框区(输入框不再透出)。
      // 吸附示意:达到顶部阈值时显示"幽灵预览"(目标最大化区)+ 松开提示。
      var maxRect = maximizedRect(viewportSize(), reserve)
      var snapGhost = React.createElement(motion.div, {
        className: 'dshcs-snapghost',
        initial: false,
        animate: {
          opacity: snapMax === true ? 1 : 0,
          x: maxRect.x,
          y: maxRect.y,
          width: maxRect.width,
          height: maxRect.height,
        },
        transition: snapMax === true ? { type: 'spring', stiffness: 500, damping: 44, mass: 0.9 } : { duration: 0.14 },
      },
        React.createElement('span', { className: 'dshcs-snapghint' }, '松开以最大化')
      )
      return ReactDOM.createPortal(
        React.createElement(React.Fragment, null, windowTree, snapGhost),
        document.body
      )
    }

    // ---------- 右侧栏标签(DSH ≥ 0.1.5-alpha.1:ctx.sidebarRightTabs / ctx.sidebarRight) ----------
    // 二段式注册:类型定义进 sidebarRightTabs,body 进 keyed 插槽 sidebar.right.pane.tab。
    // 服务缺失(旧版 DSH / 注册失败)时整段不生效 → 自动回退悬浮球(见 internalApply 的 ctx.inject)。
    var CS_KIND = 'code-server'
    var CS_TAB_ID = 'dsh-code-server-app'
    // 产物按钮/设置卡调用侧栏的桥接;未注册(旧版 DSH)时保持 null。
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
     *  与浮窗共用共享 store 与 CodeServerSurface;挂载即让实例跟随当前会话工作区。
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
          // 无挂载 seat(无会话/侧栏未渲染)→ 调用方回退新标签页或浮窗
          console.warn('[code-server] sidebar openTab failed:', e != null && e.message != null ? e.message : String(e))
          return false
        }
      }
      // 卸载 / HMR 重载:复位为悬浮球模式,避免桥接指向已失效的服务
      sctx.effect(function () {
        return function () {
          sidebarBridge.openTab = null
          setState({ sidebarActive: false })
        }
      }, 'code-server: sidebar mode reset')
      setState({ sidebarActive: true, open: false })
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
      var [open, setOpen] = React.useState(false)
      var state = props.state
      if (state === null || state === undefined || state.available !== true) return null
      var title = props.title
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

    /** 设置卡片页面:useState+useEffect 订阅 settingsScope(不投机 useSyncExternalStore
     *  对 snapshot 引用稳定性的要求;不建中间 store)。 */
    function csSettingsPage(props) {
      try {
        var scope = props.scope
        var [snapshot, setSnapshot] = React.useState(function () { return scope !== undefined ? scope.getSnapshot() : null })
        var [draft, setDraft] = React.useState(null) // null | { reserveComposer, windowedOpen, keepResident }(未保存草稿)
        var [saving, setSaving] = React.useState(false)
        var [failed, setFailed] = React.useState(false)
        // 共享 store:读取当前 UI 载体(右侧栏标签 / 悬浮球),必须放在所有提前 return 之前
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
        reserveComposer: value.reserveComposer !== false,
        windowedOpen: value.windowedOpen === true,
        keepResident: value.keepResident !== false,
      }
      var overridden = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'reserveComposer')
      var overriddenWin = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'windowedOpen')
      var overriddenKeep = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'keepResident')
      var sidebarActive = liveStore != null && liveStore.sidebarActive === true
      var dirty = draft !== null && (draft.reserveComposer !== loaded.reserveComposer
        || draft.windowedOpen !== loaded.windowedOpen
        || draft.keepResident !== loaded.keepResident)
      var saveDisabled = !dirty || saving
      var state = {
        available: true,
        writable: snapshot.writable,
        dirty: dirty,
        invalid: false,
        saving: saving,
        failed: failed,
        reserveComposer: { text: draft !== null ? draft.reserveComposer : loaded.reserveComposer, overridden: overridden },
      }
      // 保存/恢复成功后,把 host 最新 status(含 windowedOpen/reserveComposer)推给
      // 模块共享 store → 悬浮球与窗口立即按新设置生效(无需刷新页面)。
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
            await props.scope.set('reserveComposer', d.reserveComposer === true)
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
            await props.scope.unset('reserveComposer')
            await props.scope.unset('windowedOpen')
            await props.scope.unset('keepResident')
          } else {
            await props.scope.set('reserveComposer', value.reserveComposer === undefined || value.reserveComposer === null ? true : value.reserveComposer)
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
        description: '入口:右侧栏标签(DSH ≥ 0.1.5-alpha.1)/ 悬浮球回退;窗口化设置控制新标签页打开',
        state: state,
        unsavedLabel: '未保存', readOnlyLabel: '本部署的设置为只读。',
        saveFailedLabel: '本部署没有接受这些值，已保留供你修改。',
        discardLabel: '放弃修改', saveLabel: '保存', savingLabel: '保存中…',
        onSave: doSave, onDiscard: function () { setDraft(null); setFailed(false) },
      },
        // 入口:说明当前载体,并给一个直接打开侧栏标签的按钮(悬浮球模式禁用)
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
            sidebarActive === true
              ? '当前:右侧栏标签(DSH ≥ 0.1.5-alpha.1)。从右侧栏「开始」页的 Code Server 入口框、产物旁按钮或上面的按钮打开。'
              : '当前:悬浮球(本部署无右侧栏服务)。点击右下角悬浮球展开浮窗。')
        ),
        // 右侧栏模式:浮窗几何设置无意义(浮窗不渲染),隐藏该行
        sidebarActive === true ? null : React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '保留输入框上方空间'),
            overridden === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csCheck, {
            checked: draft !== null ? draft.reserveComposer : loaded.reserveComposer,
            disabled: snapshot.writable !== true,
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { reserveComposer: v === true }) }); setFailed(false) },
          }, '开启时窗口初始/缩放/最大化止于输入框上方;关闭后允许盖住输入框(最大化到视口底)')
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
          }, '开启后入口(产物按钮/设置卡/悬浮球)在浏览器新标签页打开 code-server(自动启动并跟随当前工作区);关闭则使用右侧栏标签或内部浮动窗口')
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
      /** 打开顺序:windowedOpen → 浏览器新标签页;侧栏模式 → 右侧栏 tab(带 path);否则浮窗。 */
      function openInCodeServer(p) {
        var st = store.status
        if (st != null && st.windowedOpen === true) {
          openExternalTab(activeWorkspaceCwd(props.useSessions, props.useWorkspaces))
          return
        }
        if (store.sidebarActive === true && sidebarBridge.openTab !== null) {
          if (sidebarBridge.openTab({ path: p }) === true) return
        }
        setState({ open: true }) // 回退:展开浮窗(若收起)
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
      // settings scope 提前绑定(悬浮球/指引弹窗/设置卡共用)
      var settingsScope = ctx.settingsScope
      var scope = null
      if (settingsScope !== undefined && typeof settingsScope.bind === 'function') {
        scope = settingsScope.bind({ namespace: 'code-server' })
      } else {
        console.error('[code-server] settingsScope unavailable (inject missing?); settings card disabled')
        return
      }
      // 预拉取 status:让悬浮球首帧就有 env 与运行状态(检测通过才显示,不闪烁)
      api('/code-server/status').then(function (s) {
        setState({ status: s })
      }).catch(function () { /* 首次失败由后续轮询补救 */ })
      // 悬浮球 + 浮窗(球是唯一入口/开关;无侧栏按钮、无窗口控制按钮)
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'code-server', order: 70, label: 'Code Server' },
        (props) => React.createElement(React.Fragment, null,
          React.createElement(Ball, props),
          React.createElement(Window, props),
          // 常驻预热:始终挂载(不渲染任何东西),宿主 running 时把 IDE 加载到停放区
          React.createElement(Resident, props)
        )
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
        console.log('[code-server] turnTail artifacts buttons registered')
      } catch (e) {
        console.warn('[code-server] turnTail register failed:', e != null && e.message != null ? e.message : String(e))
      }

      // ---- 设置卡片(settings.plugin.item 插槽 + settingsScope 命名空间) ----
      slots.inject('settings.plugin.item', () => slots.register(
        { name: 'settings.plugin.item', key: 'code-server', label: 'Code Server', inject: function () { return { scope: scope } } },
        csSettingsPage
      ))

      // ---- 右侧栏标签(DSH ≥ 0.1.5-alpha.1) ----
      // 特性检测而非版本比较:ctx.inject 在服务就绪时回调(可能晚于 apply),
      // 服务缺失(旧版 DSH)时永久挂起且不影响本插件的 loader entry 状态 → 悬浮球回退。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (sctx) {
            try {
              registerSidebarTab(sctx)
            } catch (e) {
              console.warn('[code-server] sidebar tab registration failed; keep floating ball:',
                e != null && e.message != null ? e.message : String(e))
            }
          })
        } else {
          console.warn('[code-server] ctx.inject unavailable; keep floating ball')
        }
      } catch (e) {
        console.warn('[code-server] sidebar inject failed; keep floating ball:',
          e != null && e.message != null ? e.message : String(e))
      }

      console.log('[code-server] client bundle registered (floating ball + window + settings card; right-sidebar tab pending/active)')
    }

    const inject = ['slots', 'settingsScope']
    const name = 'code-server'
    export { apply, inject, name }
