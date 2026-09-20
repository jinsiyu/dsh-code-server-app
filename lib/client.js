/**
 * lib/client.js —— DSH 客户端半部(**手写源码,不是构建产物;0.3.58 起不再构建**)
 *
 * 为什么不构建:这个文件必须是一个**经典脚本**(DSH 用 <script src> 加载,不是 ES module),
 * 且只有两种形态可用 —— 外部依赖走 factory 的 require('react') / require('react/jsx-runtime'),
 * 包内分块只能 require.async('client.*.js')。既然产物只能是单文件,就把它当成源码维护:
 * 改这里就是改客户端,没有中间产物、没有构建步骤、也没有"忘了重建"的漂移。
 *
 * 硬性约束(改动前先读;有 scripts/test-client-entry.mjs 守着):
 *   ① 顶层不许出现 import / export / await —— 经典脚本里它们是语法错误;
 *   ② require(...) 的实参只允许 'react' 与 'react/jsx-runtime'(DSH 冻结模块表);
 *   ③ 必须保留 window.__ModuleLoader__.load({id, factory}) 这层包装与 module.exports 的
 *      { apply, inject, name } 形状(app/inject/name 的定义在文件末尾的"插件主体"段);
 *   ④ 各段落原来的顶层标识符现在共享同一作用域 —— 新增顶层名字时先搜一遍别撞名
 *      (var/function 撞名是**静默覆盖**,不会报错)。
 *
 * 段落(按依赖顺序):地址语法 → 工作区解析 → 常驻面 → 全屏动作 → 认领类型(与 lib/claim-types.js
 * 同源的一致性副本)→ 插件主体。
 */

window.__ModuleLoader__.load({id:'dsh-code-server-app',factory:function(require){var module={exports:{}};var exports=module.exports;

// ================================ 地址语法 —— 原 src/address.js(0.3.58 起内联:客户端不再构建) ================================
/**
 * dsh-code-server — DSH 资源地址解析(0.2.5;0.2.11 起不再区分认领作用域)
 *
 * 官方 `openFile(path, { line? })`(产物 chip、"交付"卡片预览、正文内联提及)最终都变成
 * `dsh-resource://file/…` 地址交给 `ctx.sidebarRight.openResource`,由注册了匹配 `patterns`
 * 的 tab 类型认领 —— 认领地址即是官方入口的文件查看器。地址语法对齐 DSH
 * `packages/util/workspace-path/src/file-address.ts`(session 作用域 / absolute 作用域、
 * 段做 component 编码、`:` 保持字面量、忽略查询串);页面 tab 记在 `sidebar://<kind>` 下。
 *
 * 本模块只做"地址 → 路径"的解析;**认领与否按文件类型判断,见 lib/claim-types.js**
 * (session 与 absolute 一视同仁)。纯字符串处理,不碰文件系统 → 可离线单测。
 */

/** 文件地址前缀。 */
const FILE_PREFIX = 'dsh-resource://file/'
/** 右侧栏给"页面 tab"记的地址前缀(`sidebar://<kind>`)。 */
const PAGE_PREFIX = 'sidebar://'

/** 是否为右侧栏的"页面 tab"地址(`sidebar://<kind>`)。 */
function isPageAddress(address) {
  return typeof address === 'string' && address.startsWith(PAGE_PREFIX)
}

/** 解析文件地址(与 DSH `parseFileAddress` 同语义));失败返回 null。 */
function parseFileAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return null
  // 查询串/片段不参与路径
  var cut = address.length
  for (var i = 0; i < address.length; i += 1) {
    var ch = address.charAt(i)
    if (ch === '?' || ch === '#') { cut = i; break }
  }
  var parts = address.slice(FILE_PREFIX.length, cut).split('/')
  var scope = parts.shift()
  try {
    if (scope === 'session') {
      var id = parts.shift()
      if (id === undefined || id === '' || parts.length === 0) return null
      return { scope: 'session', sessionId: decodeURIComponent(id), path: decodeSegmentPath(parts) }
    }
    if (scope === 'absolute') {
      // `absolute//server/share/x`(UNC)首段为空且后面还有内容
      var unc = parts[0] === '' && parts.length > 1
      var segments = unc ? parts.slice(1) : parts
      var decoded = decodeSegmentPath(segments)
      if (decoded === '' || decoded.charAt(0) === '/') {
        if (!unc) return null
      }
      if (unc) return { scope: 'absolute', path: '//' + decoded }
      if (decoded === '') return null
      return { scope: 'absolute', path: isDrivePath(decoded) ? decoded : '/' + decoded }
    }
  } catch (e) {
    return null // decodeURIComponent 对非法转义抛 URIError
  }
  return null
}

function decodeSegmentPath(segments) {
  var out = []
  for (var i = 0; i < segments.length; i += 1) out.push(decodeURIComponent(segments[i]))
  return out.join('/')
}

/** `C:/x` 形式的盘符路径(地址里 `:` 是字面量)。 */
function isDrivePath(path) {
  return /^[A-Za-z]:($|\/)/.test(path)
}

/** 路径是否已是绝对路径(POSIX `/x`、Windows `C:/x`、UNC `//server/share`)。 */
function isAbsoluteFilePath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.charAt(0) === '/') return true
  return isDrivePath(path)
}

/** 地址末段(用作 tab 标题),按段解码;取不到时返回空串。 */
function basenameOfAddress(address) {
  var parsed = parseFileAddress(address)
  if (parsed === null) return ''
  var path = parsed.path.replace(/[/\\]+$/, '')
  var at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  var name = at === -1 ? path : path.slice(at + 1)
  return name
}

/** 把地址里的路径解析成给 VS Code 用的绝对路径;相对路径且 cwd 未知时 null。 */
function resolveFilePath(parsed, cwd) {
  if (parsed === null || parsed == null) return null
  var path = typeof parsed.path === 'string' ? parsed.path : ''
  if (path === '') {
    // 会话根自身:交给工作区(不打开具体文件)
    return null
  }
  if (isAbsoluteFilePath(path)) return path
  if (typeof cwd !== 'string' || cwd === '') return null
  var sep = cwd.indexOf('\\') !== -1 ? '\\' : '/'
  var root = cwd.replace(/[\\/]+$/, '')
  return root + sep + (sep === '\\' ? path.replace(/\//g, '\\') : path)
}

// ================================ 当前工作区目录解析 —— 原 src/workspace.js(0.3.58 起内联:客户端不再构建) ================================
// —— 解析"当前工作区目录"(决定 workbench 用哪个 `?folder=` 打开)
//
// 为什么单独成模块:这段逻辑的真实输入是 **DSH 客户端 store 的形状**,而它随 DSH 版本变过 ——
//   · DSH ≤ 0.1.6-alpha.1:`SessionListState` 带 `current`(选中的会话 id 就挂在会话列表快照上,
//     老写法 `useSessions(s => s).current` 即"当前会话");
//   · DSH ≥ 0.1.6-alpha.2:`current` 被移出列表 store(上游 refactor 的注释:view selection remains
//     outside the Controller;快照只剩 `{ ids, byId, phase, subagentsByParent, jobsBySession }`),
//     会话作用域插槽改为用标准 prop `sessionId` 告诉 body"你是哪个会话的" —— 官方自己的右侧栏标签
//     就是这么读 cwd 的(ui-deliverables 的 ReviewTab:`useSessions(s => s.byId[sessionId]?.cwd)`)。
// 只认一种形状 ⇒ 在另一版上静默拿到 undefined:0.3.46 在 0.1.6-alpha.2 上就是这样 —— 客户端不再
// 发 cwd,IDE 以**空工作区**启动(pid.json 里 cwd/launchCwd 双空)。所以这里按
// 「会话标准 prop → 旧版 current → 工作区表补位」的顺序取,并把判断留在纯函数里(可离线单测,
// 见 scripts/test-workspace-cwd.mjs;hook 一律留在组件内,本模块不碰 React)。
//
// 全部输入都是"可能不存在"的:拿不到就返回 undefined,调用方不传 cwd(/start 不带 cwd = 保留当前
// 目录),**绝不猜一个目录** —— 猜错会把 IDE 开到别人的工作区里。

/** 会话摘要里的 cwd(空串/非字符串一律视为缺失)。 */
function cwdOf(sessions, sessionId) {
  if (sessions == null || sessions.byId == null) return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  var row = sessions.byId[sessionId]
  if (row == null) return undefined
  return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
}

/** 工作区表里"包含该会话"的那个工作区的路径(DSH ≤ 0.1.6-alpha.1 的 currentAddress 语义由它兜底)。 */
function pathHoldingSession(workspaces, sessionId) {
  if (workspaces == null || !Array.isArray(workspaces.items)) return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  for (var i = 0; i < workspaces.items.length; i += 1) {
    var w = workspaces.items[i]
    if (w == null || !Array.isArray(w.sessionIds)) continue
    if (w.sessionIds.indexOf(sessionId) === -1) continue
    if (typeof w.path === 'string' && w.path !== '') return w.path
  }
  return undefined
}

/**
 * 取当前工作区目录。
 * @param input - `{ sessionId?, sessions?, workspaces? }`
 *   · sessionId:会话作用域标准 prop(根作用域没有);文件 tab 用地址里的会话 id
 *   · sessions:`useSessions(s => s)` 的快照(服务缺失时 null)
 *   · workspaces:`useWorkspaces(s => s)` 的快照(服务缺失时 null)
 * @returns 绝对路径;判断不出来时 undefined(调用方不传 cwd,由宿主保留当前目录)
 */
function pickWorkspaceCwd(input) {
  var opts = input == null ? {} : input
  var sessions = opts.sessions == null ? null : opts.sessions
  var workspaces = opts.workspaces == null ? null : opts.workspaces
  var sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : undefined

  // 1) 会话自带的 cwd(新 DSH:标准 prop 给 sessionId;两条版本都吃这一条)
  var fromSession = cwdOf(sessions, sessionId)
  if (fromSession !== undefined) return fromSession

  // 2) 旧版 DSH:列表快照上的 current
  var legacyCurrent = sessions == null ? undefined : sessions.current
  var fromLegacy = cwdOf(sessions, legacyCurrent)
  if (fromLegacy !== undefined) return fromLegacy

  // 3) 工作区表:该会话所属的工作区
  var fromWorkspace = pathHoldingSession(workspaces, sessionId)
  if (fromWorkspace !== undefined) return fromWorkspace
  var fromLegacyWorkspace = pathHoldingSession(workspaces, typeof legacyCurrent === 'string' ? legacyCurrent : undefined)
  if (fromLegacyWorkspace !== undefined) return fromLegacyWorkspace

  // 4) 根作用域(后台预热)没有 sessionId:退到"最近活跃的那个会话"所属的工作区。
  //    host 的会话列表按活跃度排序(list() 文档:ordered by activity),所以 ids[0] 就是它。
  var recent = sessions != null && Array.isArray(sessions.ids) ? sessions.ids[0] : undefined
  var fromRecent = pathHoldingSession(workspaces, typeof recent === 'string' ? recent : undefined)
  if (fromRecent !== undefined) return fromRecent

  // 5) 旧字段兼容(recentWorkspaceId 在现版 WorkspaceSnapshot 里已不存在,留着不害事)
  if (workspaces != null && Array.isArray(workspaces.items) && workspaces.recentWorkspaceId !== undefined) {
    for (var j = 0; j < workspaces.items.length; j += 1) {
      var item = workspaces.items[j]
      if (item == null || item.workspaceId !== workspaces.recentWorkspaceId) continue
      if (typeof item.path === 'string' && item.path !== '') return item.path
    }
  }

  // 6) 最后兜底:工作区表的第一个(hook 拿不到选中态时的既有行为)
  if (workspaces != null && Array.isArray(workspaces.items) && workspaces.items.length > 0) {
    var first = workspaces.items[0]
    if (first != null && typeof first.path === 'string' && first.path !== '') return first.path
  }
  return undefined
}

// ================================ 常驻 IDE 面 —— 原 src/surface.js(0.3.58 起内联:客户端不再构建)(内联时 state → surfaceState:与插件主体的同名顶层变量撞名,94 处引用一并改名) ================================
/**
 * dsh-code-server — 常驻 IDE 面(0.2.2)
 *
 * 背景(实测):ui-dockkit 只渲染当前激活标签的 body(TabPanel.tsx:412),切走即 React 卸载 =
 * iframe 被移出文档 = 浏览上下文销毁;而普通 `appendChild` 移动 iframe 会让内部计时器归零(等价重载),
 * `Element.moveBefore()`(Chromium ≥133)才是状态保持型原子移动(实测计时器 1→2 连续)。
 * 因此 iframe 由本模块持有:激活时 `host.moveBefore(frame, null)` 停靠,失活时移回文档级 park
 * 容器(离屏、保留最后尺寸、不销毁),只有 src 真变化(工作区/端口)才显式导航。
 *
 * 实测坑:曾出现"元素在、画面不重绘"(尺寸/命中/可见性全对但一片白);`translateZ(0)`、`opacity`
 * 无效,`display:none → 强制重排 → 还原` 可在同一 JS 任务内恢复且不重载文档 —— 触发条件未复现,
 * 故按兜底处理:每次"停放 → 停靠"补一次 `nudgeRepaint()`(`setNudgeEnabled(false)` 可现场 A/B)。
 *
 * 不支持 `moveBefore` 时退回 `appendChild`(会重载)并标记 `degraded`,由界面明示,不静默失败。
 */

/** 状态保持型移动是否可用(Chromium ≥133)。 */
const supportsMoveBefore = typeof Element !== 'undefined'
  && typeof Element.prototype.moveBefore === 'function'

var PARK_OFFSCREEN_LEFT = -20000

var surfaceState = {
  park: null,
  frame: null,
  currentSrc: null,
  sameOrigin: null,
  owner: null,
  /** 最后一次有效停靠尺寸:停放时沿用它,避免 VS Code 触发 0×0 重排。 */
  lastRect: null,
  /** 'offscreen'(默认,省 CPU)| 'behind'(停在原位、压在面板下,规避不可见 iframe 节流)。 */
  parkStrategy: 'offscreen',
  degraded: false,
  preloaded: false,
  /** 陈旧合成表面修复计数(排障用:每次停靠最多 +1)。 */
  nudgeCount: 0,
  nudgeEnabled: true,
  lastNudgeAt: 0,
  listeners: new Set(),
}

function snapshot() {
  return {
    ready: surfaceState.frame !== null,
    docked: surfaceState.owner !== null,
    owner: surfaceState.owner,
    src: surfaceState.currentSrc,
    sameOrigin: surfaceState.sameOrigin,
    parkStrategy: surfaceState.parkStrategy,
    degraded: surfaceState.degraded,
    preloaded: surfaceState.preloaded,
    supportsMoveBefore: supportsMoveBefore,
    nudgeCount: surfaceState.nudgeCount,
    lastNudgeAt: surfaceState.lastNudgeAt,
  }
}

function notify() {
  var snap = snapshot()
  surfaceState.listeners.forEach(function (fn) {
    try { fn(snap) } catch (e) { /* 订阅者异常不影响移动 */ }
  })
}

/** 订阅常驻面状态(停靠/停放/降级),返回取消函数。 */
function subscribeSurface(fn) {
  surfaceState.listeners.add(fn)
  return function () { surfaceState.listeners.delete(fn) }
}

function surfaceSnapshot() { return snapshot() }

/** 停放策略:offscreen(默认)或 behind。切换时若当前处于停放态,立即重新摆放。 */
function setParkStrategy(strategy) {
  if (strategy !== 'offscreen' && strategy !== 'behind') return
  if (surfaceState.parkStrategy === strategy) return
  surfaceState.parkStrategy = strategy
  if (surfaceState.frame !== null && surfaceState.owner === null) applyParkStyle()
  notify()
}

function getParkStrategy() { return surfaceState.parkStrategy }

function parkHasFixedSize() {
  // 保留最后停靠尺寸:后台的 VS Code 布局不变,回到前台无需重排。
  var rect = surfaceState.lastRect
  if (rect === null) return
  surfaceState.park.style.width = Math.max(1, Math.round(rect.width)) + 'px'
  surfaceState.park.style.height = Math.max(1, Math.round(rect.height)) + 'px'
}

function applyParkStyle() {
  if (surfaceState.park === null) return
  parkHasFixedSize()
  if (surfaceState.parkStrategy === 'behind' && surfaceState.lastRect !== null) {
    // 原位、可视但不被点击:压在面板(z-index 10)之下 → 不会被判定为"不可见 iframe"。
    surfaceState.park.style.left = Math.round(surfaceState.lastRect.left) + 'px'
    surfaceState.park.style.top = Math.round(surfaceState.lastRect.top) + 'px'
    surfaceState.park.style.visibility = 'visible'
    surfaceState.park.style.zIndex = '0'
    return
  }
  surfaceState.park.style.left = PARK_OFFSCREEN_LEFT + 'px'
  surfaceState.park.style.top = '0px'
  surfaceState.park.style.visibility = 'hidden'
  surfaceState.park.style.zIndex = '0'
}

/** 停放态:不可交互、不进无障碍树、不抢焦点。 */
function markParked() {
  if (surfaceState.frame === null) return
  surfaceState.frame.setAttribute('inert', '')
  surfaceState.frame.setAttribute('aria-hidden', 'true')
}

function markDocked() {
  if (surfaceState.frame === null) return
  surfaceState.frame.removeAttribute('inert')
  surfaceState.frame.removeAttribute('aria-hidden')
}

function createSurface() {
  var park = document.createElement('div')
  park.className = 'dshcs-park'
  park.setAttribute('data-dshcs-park', '')
  park.setAttribute('aria-hidden', 'true')
  var frame = document.createElement('iframe')
  frame.className = 'dshcs-frame'
  frame.setAttribute('title', 'code-server')
  frame.setAttribute('allow', 'clipboard-read; clipboard-write')
  frame.setAttribute('data-dshcs-resident', '')
  frame.src = 'about:blank'
  park.appendChild(frame)
  document.body.appendChild(park)
  surfaceState.park = park
  surfaceState.frame = frame
  surfaceState.currentSrc = 'about:blank'
  surfaceState.owner = null
  applyParkStyle()
  markParked()
  return frame
}

/** serve=dsh 时 iframe 与 DSH 同源:此时不再挂 sandbox(同源 + allow-same-origin 可被 frame 自摘);
 *  loopback 跨源,sandbox 是真防护。属性变化会触发一次导航(模式切换本就该重载)。 */
function applyFrameAttrs(sameOrigin) {
  var frame = surfaceState.frame
  if (frame === null) return
  var changed = surfaceState.sameOrigin !== sameOrigin
  if (!changed && frame.hasAttribute('data-dshcs-attrs')) return
  if (sameOrigin === true) frame.removeAttribute('sandbox')
  else if (sameOrigin === false) {
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups '
      + 'allow-pointer-lock allow-clipboard-read allow-clipboard-write')
  }
  frame.setAttribute('data-dshcs-attrs', sameOrigin === true ? 'same-origin' : 'cross-origin')
  surfaceState.sameOrigin = sameOrigin
}

/** 确保常驻面存在并指向 src(不改变停靠状态)。用于后台预热与首次停靠前的准备。 */
function ensureSurface(options) {
  var opts = options || {}
  if (surfaceState.frame === null) createSurface()
  if (typeof opts.sameOrigin === 'boolean') applyFrameAttrs(opts.sameOrigin)
  if (typeof opts.src === 'string' && opts.src !== '' && opts.src !== surfaceState.currentSrc) setSurfaceSrc(opts.src)
  return surfaceState.frame
}

/** 显式导航(工作区/端口变化时唯一的正常重载入口)。 */
function setSurfaceSrc(src) {
  if (surfaceState.frame === null || typeof src !== 'string' || src === '' || src === surfaceState.currentSrc) return
  surfaceState.currentSrc = src
  surfaceState.frame.src = src
  notify()
}

/** 陈旧合成表面修复:**同一 JS 任务内**关/开一次布局,逼浏览器重建 iframe 的合成表面。
 *  不重载文档、不改变内部状态(实测:VS Code 布局与"欢迎"页状态保持),也不产生可见闪烁。 */
function nudgeRepaint() {
  var frame = surfaceState.frame
  if (surfaceState.nudgeEnabled !== true || frame === null || frame.isConnected !== true) return false
  var prev = frame.style.display
  frame.style.display = 'none'
  void frame.offsetHeight // 强制重排:丢弃陈旧表面
  frame.style.display = prev
  surfaceState.nudgeCount += 1
  surfaceState.lastNudgeAt = Date.now()
  return true
}

/** 排障用:临时关闭修复,做 A/B 对照(默认开启)。 */
function setNudgeEnabled(enabled) {
  surfaceState.nudgeEnabled = enabled !== false
  return surfaceState.nudgeEnabled
}

function moveInto(target) {
  if (surfaceState.frame === null) return
  if (supportsMoveBefore) {
    try {
      target.moveBefore(surfaceState.frame, null)
      return
    } catch (error) {
      // 实测:源容器已被摘出文档时(React 先删 DOM、后跑 passive effect cleanup),
      // moveBefore 抛 HierarchyRequestError("invalid hierarchy")。此时退回 appendChild:
      // 会重载一次,但**绝不丢帧**(绝不能把 iframe 留在已脱离文档的宿主里)。
      surfaceState.degraded = true
      surfaceState.lastMoveError = (error && error.name ? error.name + ': ' : '') + (error && error.message ? error.message : String(error))
    }
  } else {
    surfaceState.degraded = true
  }
  target.appendChild(surfaceState.frame)
}

/** 把常驻面停靠到 host 容器(标签 body 里的占位 div)。 */
function dockInto(host, owner) {
  if (surfaceState.frame === null || host == null) return
  var wasParked = surfaceState.owner === null
  var rect = host.getBoundingClientRect()
  if (rect.width >= 1 && rect.height >= 1) {
    surfaceState.lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
  surfaceState.owner = owner === undefined ? null : owner
  markDocked()
  surfaceState.park.setAttribute('aria-hidden', 'true')
  moveInto(host)
  // 从停放回到停靠:补一次重绘唤醒(见文件头"另一个实测坑")。
  if (wasParked) nudgeRepaint()
  notify()
}

/** 把常驻面移回停放区;仅当 owner 匹配(或未指定)时生效,避免非当前停靠者误停放。 */
function parkSurface(owner) {
  if (surfaceState.frame === null) return
  if (owner !== undefined && surfaceState.owner !== owner) return
  surfaceState.owner = null
  applyParkStyle()
  markParked()
  surfaceState.park.setAttribute('aria-hidden', 'true')
  moveInto(surfaceState.park)
  notify()
}

/** 后台预热:建面 + 指向 src 并停在停放区(keepResident=true 时由宿主侧状态驱动)。
 *  已经停靠着(用户正在看 IDE)时只更新 src,绝不把面拽走。 */
function preloadSurface(options) {
  var opts = options || {}
  ensureSurface(opts)
  if (surfaceState.owner === null) {
    if (typeof opts.src === 'string' && opts.src !== '') surfaceState.preloaded = true
    parkSurface()
  }
  return surfaceState.frame
}

/** 仅供排障/测试:销毁并复位。 */
function destroySurface() {
  if (surfaceState.park !== null && surfaceState.park.parentNode !== null) surfaceState.park.parentNode.removeChild(surfaceState.park)
  surfaceState.park = null
  surfaceState.frame = null
  surfaceState.currentSrc = null
  surfaceState.sameOrigin = null
  surfaceState.owner = null
  surfaceState.lastRect = null
  surfaceState.degraded = false
  surfaceState.preloaded = false
  surfaceState.nudgeCount = 0
  surfaceState.lastNudgeAt = 0
  notify()
}

// 排障/应急句柄:控制台可直接查看状态、切停放策略(offscreen ↔ behind)、手动停靠/停放。
if (typeof window !== 'undefined') {
  window.__dshcsSurface = {
    snapshot: snapshot,
    setParkStrategy: setParkStrategy,
    getParkStrategy: getParkStrategy,
    preload: preloadSurface,
    dock: dockInto,
    park: parkSurface,
    nudge: nudgeRepaint,
    setNudgeEnabled: setNudgeEnabled,
    destroy: destroySurface,
  }
}

// ================================ 右侧栏全屏动作 —— 原 src/sidebar-mode.js(0.3.58 起内联:客户端不再构建) ================================
// —— 把右侧栏切到"全屏(铺满窗口)"这一个动作(打开 Code Server 标签时自动做)
//
// 为什么是"点它自己的按钮",而不是调服务:
//   DSH 只把"展开/收起"开放给插件(ctx.sidebarRight.isExpanded / toggleExpanded);
//   push ⟷ fullscreen 这个"模式"记在 ui-sidebar-right 自己的 store 里(actions.setMode),
//   只发给它的 seat 内部组件,插件拿不到。ctx.layout.openRightbar(track, fullscreen) 不是控制面 ——
//   它是 seat 用来"汇报"presentation 的通道(源码注释:the occupant reports it; nothing else writes it),
//   插件去写只会被 seat 的下一次提交覆盖。
//   所以这里复刻用户的动作本身:点面板 chrome 上的那颗「全屏」按钮 —— 与用户手点完全同一条路径
//   (含窄视口下的连带处理),上游改模式语义时本插件自动跟随。
//
// 作用域:只在本插件 body 所属的那个面板内查找(closest('[data-sidebar-right-panel]')),
// 因此多会话/多面板并存时不会误点别人的按钮;找不到就保持现状并回报原因,由调用方记一次日志。

/** 面板根节点:ui-sidebar-right 的 SidebarPanel 挂的属性。 */
var PANEL_SELECTOR = '[data-sidebar-right-panel]'
/** chrome 上的模式按钮,属性值是"点它之后的目标模式":非全屏时即 "fullscreen"。 */
var FULLSCREEN_CONTROL = '[data-sidebar-right-mode="fullscreen"]'

/**
 * 把本插件所在面板切到全屏模式(等价用户点「全屏」)。已全屏时该按钮不存在 → 'no-control'。
 * 纯查询/点击失败一律回报原因,不抛错:这是"锦上添花"的动作,绝不能打断右侧栏渲染。
 * @param rootEl - 本插件 body 的根 DOM 节点。
 * @returns 'clicked' | 'no-root' | 'no-panel' | 'no-control' | 'lookup-failed' | 'click-failed'
 */
function requestFullscreenPanel(rootEl) {
  if (rootEl == null || typeof rootEl.closest !== 'function') return 'no-root'
  var panel
  var control
  try {
    panel = rootEl.closest(PANEL_SELECTOR)
    if (panel == null || typeof panel.querySelector !== 'function') return 'no-panel'
    control = panel.querySelector(FULLSCREEN_CONTROL)
  } catch (e) { return 'lookup-failed' }
  if (control == null || typeof control.click !== 'function') return 'no-control'
  // 点的是 React 组件上的 onClick:事件冒泡到 root 容器后由 React 委托分发。
  // 上游 handler 抛错也不该顺着 layout effect 冒进 React 渲染流程。
  try { control.click() } catch (e) { return 'click-failed' }
  return 'clicked'
}

// ================================ 认领类型(与 host 同源,见 scripts/test-client-entry.mjs 的一致性守卫) —— 原 lib/claim-types.js(0.3.58 起内联:客户端不再构建) ================================
/**
 * dsh-code-server — 认领类型策略(0.2.11)
 *
 * 决定"哪些文件地址由本插件认领"(即交给 VS Code 打开),**只按文件类型判断,不再区分作用域**:
 * `dsh-resource://file/session/…` 与 `…/file/absolute/…` 一视同仁,未认领的落回 DSH 自带预览
 * (`ui-sidebar-documentpreview`,优先级 fallback),它内部按扩展名分派 markdown / html / 图片 / PDF /
 * 代码高亮 / 纯文本。
 *
 * 文本语法(用户可在设置卡里改,分号分隔,`,`/空白/换行也认):
 *   *            其余类型也认领(兜底)
 *   py           认领 .py(写 `py`、`.py`、`*.py` 等价;大小写不敏感)
 *   !md          不认领 .md(排除优先于认领)
 * 空文本 = 不认领任何文件类型(只保留页面 tab,文件点击全部落回 DSH 预览)。
 *
 * 本模块是 host(`lib/index.js` 的 Config 默认值)与 client(`lib/client.js` 内联的那份副本)的
 * **同一份** 事实来源,随 npm 包一起发布(见 package.json 的 files),避免两边默认值漂移。
 * 纯字符串逻辑,不碰文件系统 → 可离线单测(scripts/test-claim-types.mjs)。
 */

/**
 * 默认策略(0.3.51 起三组):
 *   ① **DSH 自带预览渲染得好的类型留给它**(markdown / html / 图片 / PDF);
 *   ② **可执行文件与二进制产物不认领**(用户 2026-09-18 要求):它们不是文本,进编辑器只会看到
 *      "二进制/乱码",没有编辑价值;
 *   ③ **Office / 版式文档不认领**(同一要求):都是 zip/OLE 二进制容器,同理。
 * 其余(代码、json/yaml/toml、txt、日志、无扩展名、其它未知扩展名)仍全部进 IDE —— 未认领的类型
 * 没有"没渲染器"的风险(DSH 预览对任何扩展名都有兜底),反之未知扩展名进 IDE 更实用。
 *
 * 想放开某一组(例如仍希望 Office 文档进 IDE):把设置卡的「认领类型」改回
 * `*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf` 即可。
 */

/** ① 预览友好的类型(DSH 自带预览比"进 IDE 当文本看"更好)。 */
const PREVIEW_FRIENDLY_EXTENSIONS = [
  'md', 'markdown', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf',
]

/**
 * ② 可执行文件与二进制产物。
 * **文本形态的脚本刻意不在其中**(bat/cmd/ps1/sh/py/js…):它们是可编辑的文本,继续进 IDE。
 * 判据统一是"进编辑器有没有意义",而不是"能不能被执行"。
 */
const EXECUTABLE_EXTENSIONS = [
  // Windows:可执行程序 / 安装包 / 系统与驱动组件
  'exe', 'com', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'dll', 'sys', 'scr', 'cpl', 'ocx', 'drv', 'efi', 'mui',
  // 编译与中间产物
  'obj', 'o', 'a', 'lib', 'pdb', 'class', 'jar', 'pyc', 'pyo', 'wasm', 'node',
  // POSIX:动态库 / 可执行 / 内核模块
  'so', 'dylib', 'ko', 'elf', 'bin', 'out',
  // 打包体(读不了也装不上)
  'apk', 'ipa', 'deb', 'rpm', 'dmg', 'iso', 'img', 'cab',
]

/**
 * ③ Office / 版式文档(zip / OLE 二进制容器)。
 * `csv` / `tsv` **不在此列** —— 它们是纯文本,进 IDE 反而有用(只是 Excel 也能开)。
 */
const OFFICE_EXTENSIONS = [
  // Word
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'docb', 'rtf', 'odt',
  // Excel
  'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'xla', 'xlam', 'ods',
  // PowerPoint
  'ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppam', 'odp',
  // Visio / OneNote / Project / Publisher / 版式文档
  'vsd', 'vsdx', 'vssx', 'vstx', 'vsdm', 'vssm', 'vstm', 'one', 'onetoc2', 'mpt', 'mpp', 'pub', 'msg', 'xps', 'oxps', 'odg',
]

/** 默认策略文本:`*` + 三组排除(同一份事实来源,host 的 Config 默认值与 client 的 canOpen 共用)。 */
const DEFAULT_CLAIM_EXTENSIONS = ['*']
  .concat(PREVIEW_FRIENDLY_EXTENSIONS)
  .concat(EXECUTABLE_EXTENSIONS)
  .concat(OFFICE_EXTENSIONS)
  .map(function (token, index) { return index === 0 ? token : '!' + token })
  .join(';')

/** 分隔符:分号为主,逗号/空白/换行也接受(用户手抄时不该因为标点被坑)。 */
const SEPARATORS = /[;,\s]+/

/** 切词:`!` 可以和后面的扩展名隔着空白写(`! .md` ≡ `!.md`),其余按分隔符切。 */
function tokenize(text) {
  return String(text).replace(/!\s+/g, '!').split(SEPARATORS)
}

/** 单个 token 归一化:去 `*.`/`.` 前缀、去首尾空白、小写;`*`/`!x` 形式保留语义。 */
function normalizeToken(raw) {
  var token = typeof raw === 'string' ? raw.trim() : ''
  if (token === '') return ''
  var deny = token.charAt(0) === '!'
  var body = deny ? token.slice(1).trim() : token
  if (body === '*') return deny ? '!*' : '*'
  if (body.slice(0, 2) === '*.') body = body.slice(2)
  else if (body.charAt(0) === '.') body = body.slice(1)
  body = body.toLowerCase()
  if (body === '') return ''
  return deny ? '!' + body : body
}

/**
 * 归一化成一串规范文本(保存进设置用):去空、去重、保持"先出现的先写"。
 * @param text - 用户输入(任意标点)。
 * @returns 规范文本;输入非字符串时返回 ''。
 */
function normalizeClaimExtensions(text) {
  if (typeof text !== 'string') return ''
  var parts = tokenize(text)
  var seen = []
  for (var i = 0; i < parts.length; i += 1) {
    var token = normalizeToken(parts[i])
    if (token === '' || token === '!*') continue // `!*` 无意义:排除"其余"等于清空,不猜意图,直接忽略
    if (seen.indexOf(token) === -1) seen.push(token)
  }
  return seen.join(';')
}

/**
 * 解析策略文本。
 * @param text - 归一化前或后的文本都接受。
 * @returns {{all: boolean, allow: string[], deny: string[]}} all = `*` 出现(其余类型也认领)。
 */
function parseClaimPolicy(text) {
  var normalized = normalizeClaimExtensions(text)
  var tokens = normalized === '' ? [] : normalized.split(';')
  var all = false
  var allow = []
  var deny = []
  for (var i = 0; i < tokens.length; i += 1) {
    var token = tokens[i]
    if (token === '*') { all = true; continue }
    if (token.charAt(0) === '!') deny.push(token.slice(1))
    else allow.push(token)
  }
  return { all: all, allow: allow, deny: deny }
}

/** 路径的扩展名(小写、不含点);无扩展名(含 dotfile、目录、空路径)返回 ''。 */
function extensionOfPath(path) {
  if (typeof path !== 'string' || path === '') return ''
  var name = path.replace(/[/\\]+$/, '')
  var at = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (at !== -1) name = name.slice(at + 1)
  var dot = name.lastIndexOf('.')
  // dot <= 0:`Makefile` / `README`(无扩展名)、`.gitignore`(dotfile)都按"无扩展名"处理
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 是否认领这个路径。排除优先,其次显式认领,最后看 `*`。
 * @param path - 地址里的路径(可为相对路径)。
 * @param policy - parseClaimPolicy 的结果。
 * @returns 认领返回 true。
 */
function claimsPath(path, policy) {
  if (policy == null) return false
  var ext = extensionOfPath(path)
  if (ext !== '' && policy.deny.indexOf(ext) !== -1) return false
  if (ext !== '' && policy.allow.indexOf(ext) !== -1) return true
  return policy.all === true
}

/**
 * 是否认领这个文件地址(供 tab 类型的 canOpen 用)。
 * @param parsed - parseFileAddress 的结果(或 null)。
 * @param policy - parseClaimPolicy 的结果。
 * @returns 认领返回 true。
 */
function claimsAddress(parsed, policy) {
  if (parsed === null || parsed == null) return false
  return claimsPath(parsed.path, policy)
}

/** 给设置卡/日志用的一句话摘要(不参与判定)。 */
function describeClaimPolicy(text) {
  var policy = parseClaimPolicy(text)
  var parts = []
  if (policy.all) parts.push('其余类型全部认领')
  if (policy.allow.length > 0) parts.push('指定认领 ' + policy.allow.length + ' 项')
  if (policy.deny.length > 0) {
    // 把"排除了哪几组"说出来:默认值里可执行文件与 Office 各占几十项,只报总数看不出重点。
    var groups = []
    if (intersects(policy.deny, EXECUTABLE_EXTENSIONS)) groups.push('可执行文件')
    if (intersects(policy.deny, OFFICE_EXTENSIONS)) groups.push('Office 文档')
    parts.push('排除 ' + policy.deny.length + ' 项' + (groups.length > 0 ? '(含' + groups.join('、') + ')' : ''))
  }
  if (parts.length === 0) return '不认领任何文件(只有页面标签)'
  return parts.join(' · ')
}

/** 两个列表有没有交集(摘要用;两侧都可能很长,用 Set 查)。 */
function intersects(list, group) {
  var set = new Set(group)
  for (var i = 0; i < list.length; i += 1) {
    if (set.has(list[i])) return true
  }
  return false
}

// ================================ 插件主体 —— 原 src/factory.js(0.3.58 起内联:客户端不再构建) ================================
// dsh-code-server — 客户端半部(右侧栏标签内的常驻 IDE 面;**只支持带右侧栏的 DSH**)
// 形态:window.__ModuleLoader__.load({id,factory}) 的经典脚本;factory 内静态 require('react')
// (DSH 冻结模块表)。0.3.58 起**不再构建** —— 这个文件就是源码,改它即改客户端。
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

    // ---------- 标准 prop 里的会话/工作区快照 ----------
    // 取哪条路、退到哪条路**全在本文件的工作区解析段**(纯函数):DSH ≤ 0.1.6-alpha.1 的
    // `SessionListState.current` 在 0.1.6-alpha.2 被移出列表 store,会话作用域插槽改用标准 prop
    // `sessionId` 标识当前会话 —— 只认旧形状会让 cwd 静默变成 undefined(IDE 以空工作区启动)。
    /** 服务缺失时的占位选择器:**hook 调用次数必须恒定**(React 按位置对账),
     *  否则"服务晚到"的那一次渲染会抛 "Rendered more hooks than during the previous render"。 */
    function noopSelector() { return undefined }
    function workspaceSnapshots(props) {
      var useSessions = typeof props.useSessions === 'function' ? props.useSessions : noopSelector
      var useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : noopSelector
      return {
        sessions: useSessions(function (s) { return s }),
        workspaces: useWorkspaces(function (s) { return s }),
      }
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
        : '当前以独立回环端口提供(端口 ' + (status != null && status.port != null ? status.port : '随机')
          + ' + 路径令牌;要在新标签页打开,复制设置卡里的完整地址 —— 缺了令牌那段会 404)。'
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
      // 根作用域没有 sessionId:由 workspace.js 退到"最近活跃会话所属工作区"(拿不到就不带 folder,
      // 打开面板时 body 会带着正确 `?folder=` 重新导航)。
      var snapshots = workspaceSnapshots(props != null ? props : {})
      var cwd = pickWorkspaceCwd({ sessions: snapshots.sessions, workspaces: snapshots.workspaces })
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
    /** 本插件的**包名**,同时是客户端 bundle 的 loader id(banner 里 `load({id})` 那一个)。
     *  插件页按包名派发配置区(`renderSlot('plugins.bundle.config', …, { entryKey: pkg.name })`),
     *  所以这个键必须与安装进来的包名逐字相同 —— 0.3.50 起设置卡搬去插件页就是靠它认领。 */
    var PKG_NAME = 'dsh-code-server-app'
    /** 插件页配置区的 `summary` 视图(插件页只用得到 `page`;留着一句简介以防上游改用 summary)。 */
    var CS_CONFIG_SUMMARY = '在右侧栏标签里运行 VS Code 网页版,跟随当前会话工作区;'
      + '认领类型、打开即全屏、后台常驻都在这里设。'
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

    /** 当前认领类型策略(host 快照里的 claimExtensions)。
     *  host 未应答时**不认领任何文件** —— 这时 IDE 也起不来,把点击交给 DSH 自带预览,
     *  比"猜一个默认值"更诚实(host 一到,认领立即按设置生效)。 */
    var NO_CLAIM_POLICY = parseClaimPolicy('')
    function claimPolicy() {
      var status = state.status
      if (status == null || typeof status.claimExtensions !== 'string') return NO_CLAIM_POLICY
      return parseClaimPolicy(status.claimExtensions)
    }

    /** 默认认领策略的**分行展示文本**(设置卡提示块用,0.3.52)。
     *  与 `DEFAULT_CLAIM_EXTENSIONS` 同源(都是 lib/claim-types.js 的三组常量),只是把 `;` 换成按组的换行,
     *  便于阅读;解析器把换行与分号一视同仁,所以整段复制回输入框得到的策略与默认值逐字相同。 */
    function claimDefaultLines() {
      var lines = ['*']
      var groups = [PREVIEW_FRIENDLY_EXTENSIONS, EXECUTABLE_EXTENSIONS, OFFICE_EXTENSIONS]
      for (var i = 0; i < groups.length; i += 1) {
        var tokens = []
        for (var j = 0; j < groups[i].length; j += 1) tokens.push('!' + groups[i][j])
        lines.push(tokens.join(';'))
      }
      return lines.join('\n')
    }

    /**
     * DSH 侧**只保留一个** code-server 标签页(0.3.57,用户要求:"打开新文件不添加新的标签页")。
     *
     * 为什么需要插件自己收:官方的标签页身份就是**地址**本身 ——
     * `SidebarRightTabClaim.contentId` 注释写着 "Stable identity of the content, which is the address
     * itself. Two opens of the same address are the same tab"(同址幂等、异址必新开),
     * 而 `replaceTab` 只有**发起方**(产品自己的 openFile / openResource)能传,插件拿不到那个机会。
     * 所以插件在"新标签页的 body 挂载时"把同窗格里的旧标签页关掉 —— 结束时只剩一个,
     * 用户看到的就是"这**一个** code-server 页面在换内容"。
     *
     * 为什么敢关:常驻 IDE 面是 **surface.js 持有的单例 iframe**(在停靠位/停放区之间 moveBefore),
     * 标签页只是它的停靠宿主 —— 关掉旧标签不会重载、不会丢 IDE 状态(见 surface.js 文件头)。
     *
     * 两个刻意的边界:
     *   · **只收同窗格的**:多窗格是用户主动切分的布局,官方自己也是"每窗格一份"的约定
     *     (`SidebarRightTabDefinition.multiple` 的注释:"one page per kind in each pane")。
     *   · **只有"首次可见"的那个收**:标签页恢复/激活顺序不可控,若每个可见的 body 都收别人,
     *     关掉一个会让下一个变可见 → 互相收(乒乓)。用 ref 钉住"每个挂载只收一次"。
     */
    var csTabSeats = new Map()

    /** 收掉同窗格里的其它本插件标签页(登记见 body 里的 layout effect)。 */
    function closeSiblingTabs(selfId, paneId) {
      var closed = 0
      csTabSeats.forEach(function (seat, id) {
        if (id === selfId) return
        // 两边窗格都已知且不同 ⇒ 放过(多窗格是用户主动切的布局);
        // 任一边窗格未知(老版 DSH 没给 panel)⇒ 按"同窗格"处理,宁可只留一个。
        if (paneId !== null && seat.pane !== null && seat.pane !== paneId) return
        try {
          seat.close()
          // 关成功就立刻注销座位:body 的 unmount cleanup 也会注销,但那是**稍后**(React 卸载时机),
          // 这期间若再来一次合并就会对同一个已关闭的标签页重复调 close(会抛,且日志噪音)。
          csTabSeats.delete(id)
          closed += 1
        } catch (error) {
          // 关不掉只是"多一个标签页",绝不能因此让 body 渲染失败
          console.warn('[code-server] 收起旧的 code-server 标签页失败:'
            + (error != null && error.message != null ? error.message : error))
        }
      })
      return closed
    }

    /** 右侧栏 tab 的 body:面板里铺满常驻 IDE 面(iframe 由 surface.js 持有)。
     *  走共享 store 与 CodeServerSurface;挂载即让实例跟随当前会话工作区。
     *  文件 tab(navigation.address = `dsh-resource://file/…`)会让 workbench 定位到该文件;
     *  页面 tab(`sidebar://code-server`)只显示工作区 IDE。
     *  0.2.2 起 ui-dockkit 的"切走即卸载 body"不再导致重载:卸载只把面停放到停放区。
     *  0.3.57 起:新标签页挂载时会收掉同窗格里的旧 code-server 标签页(见 closeSiblingTabs)。 */
    function CodeServerBody(props) {
      var info = props.useTabInfo()
      var tab = info.tab
      var store = useStore()
      var status = store.status
      var navigation = tab.navigation
      var revision = navigation != null && typeof navigation.revision === 'number' ? navigation.revision : 0
      // 地址:文件 tab 可能来自会话树里的别的会话,故优先用地址里的 sessionId 对齐工作区;
      // 页面 tab 用**会话作用域标准 prop** `sessionId`(DSH ≥ 0.1.6-alpha.2 的当前会话信源,
      // 老版的 `useSessions().current` 已被上游移除 —— 详见本文件的工作区解析段)。
      var address = navigation != null && typeof navigation.address === 'string' ? navigation.address : ''
      var parsed = isPageAddress(address) ? null : parseFileAddress(address)
      var snapshots = workspaceSnapshots(props)
      var addressedSession = parsed != null && typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
      var cwd = pickWorkspaceCwd({
        sessions: snapshots.sessions,
        workspaces: snapshots.workspaces,
        sessionId: addressedSession !== undefined ? addressedSession : props.sessionId,
      })
      var cwdWarnedRef = React.useRef(false)
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
      // 单标签页(0.3.57):登记自己的"座位"(能关掉自己的那个函数 + 所在窗格),
      // 并在**首次可见**时把同窗格里的旧 code-server 标签页收掉 —— 见 closeSiblingTabs 的注释。
      var paneId = info.panel != null && info.panel.id !== undefined ? info.panel.id : null
      var actions = tab.actions != null ? tab.actions : null
      var tabId = tab.id
      var consolidatedRef = React.useRef(false)
      React.useLayoutEffect(function () {
        if (actions === null) return undefined
        csTabSeats.set(tabId, { pane: paneId, close: actions.close })
        return function () { csTabSeats.delete(tabId) }
      }, [tabId, paneId, actions])
      React.useLayoutEffect(function () {
        if (consolidatedRef.current || visible !== true || actions === null) return
        consolidatedRef.current = true
        closeSiblingTabs(tabId, paneId)
      }, [visible, tabId, paneId, actions])
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

      // 工作区跟随:对齐会话 cwd(未运行则启动;运行中 host 只改"当前 workbench 目录",**不重启进程**),
      // 成功后 url 变化(reloadTick / folder 参数)让常驻面重新导航到新工作区。
      // 触发时机是"本标签挂载期间 cwd 变化",与侧栏是否可见无关(收起侧栏时 body 并不卸载)。
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

      // 解析不出工作区时**必须留痕**:这正是 0.3.46 在 DSH 0.1.6-alpha.2 上踩的坑 ——
      // 客户端悄悄不发 cwd,IDE 以空工作区打开,界面与日志里都没有任何线索。每次挂载只报一次。
      React.useEffect(function () {
        if (typeof cwd === 'string' && cwd !== '') return
        if (cwdWarnedRef.current) return
        cwdWarnedRef.current = true
        console.warn('[code-server] 未能解析当前工作区目录(会话无 cwd / 标准 prop 无 sessionId /'
          + ' 工作区表也没匹配上):本次不向宿主发送 cwd,IDE 会以空工作区打开')
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
          canOpen: function (a) { return claimsAddress(parseFileAddress(a), claimPolicy()) },
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

    // ---------- 设置(参照 auto-open-web 的自绘卡片模式) ----------
    // 数据通道:settingsScope(官方 settings 域,命名空间 code-server)—— 两个座位共用。
    // 座位(0.3.50 起两条腿都注册,谁被声明谁生效):
    //   · `plugins.bundle.config`(DSH ≥ 0.1.6-alpha.2):插件页按**包名**派发的配置区,页面自带
    //     标题/面包屑,我们只出表单 + 保存控件(seat='bundle-config');
    //   · `settings.plugin.item`(DSH ≤ 0.1.6-alpha.1):设置页里自绘的可折叠卡片(已在新版退役)。
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
      '.dshcs-text{display:flex}' +
      '.dshcs-text input,.dshcs-text textarea{font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;width:100%;min-width:0}' +
      // 多行输入(0.3.52):等宽 + 软换行 + 只允许纵向拉伸;`overflow-wrap` 保证没有空格的 `!ext;!ext;…` 也能断行
      '.dshcs-text textarea{display:block;box-sizing:border-box;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}' +
      '.dshcs-text input:disabled,.dshcs-text textarea:disabled{opacity:.5;cursor:default}' +
      '.dshcs-text input:focus-visible,.dshcs-text textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}' +
      // 提示里的"默认值"代码块(0.3.52):保留换行、随便哪里都能断,不再把卡片撑破
      '.dshcs-code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:11.5px/1.55 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;margin:4px 0 0;max-width:100%}' +
      '.dshcs-badges{align-items:center;gap:8px;display:inline-flex}' +
      '.dshcs-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.dshcs-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}' +
      '.dshcs-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.dshcs-reset:disabled{cursor:default}' +
      // 插件页配置区(0.3.50;页面自带标题/面包屑,这里只排表单与保存控件)
      '.dshcs-cfgpage{display:flex;flex-direction:column;gap:0}' +
      '.dshcs-cfgfoot{justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}'
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
    /** 多行文本输入(0.3.52 起,用于"认领类型"这类清单)。
     *  为什么不是单行 input:0.3.51 之后默认值有 98 条排除项(≈700 字符),单行框只能看到开头,
     *  剩下全靠横向滚动 —— 既看不全也改不动。这里改用 textarea,并**按内容自动长高**(上限 12 行),
     *  保证默认值打开就能一眼看全;`resize: vertical` 允许手动再拉。 */
    function csTextarea(props) {
      var text = typeof props.value === 'string' ? props.value : ''
      var rows = Math.min(12, Math.max(3, Math.ceil(text.length / 64)))
      return React.createElement('label', { className: 'dshcs-text' },
        React.createElement('textarea', {
          value: props.value, disabled: props.disabled === true, rows: rows,
          spellCheck: false, autoComplete: 'off', wrap: 'soft', placeholder: props.placeholder,
          onChange: function (event) { props.onChange(event.target.value) },
        })
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
        claimExtensions: typeof value.claimExtensions === 'string' ? value.claimExtensions : DEFAULT_CLAIM_EXTENSIONS,
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
      var overriddenClaim = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'claimExtensions')
      var overriddenFullscreen = user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'fullscreenOnOpen')
      var dirty = draft !== null && (draft.keepResident !== loaded.keepResident
        || normalizeClaimExtensions(draft.claimExtensions) !== normalizeClaimExtensions(loaded.claimExtensions)
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
            await props.scope.set('claimExtensions', normalizeClaimExtensions(d.claimExtensions))
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
            await props.scope.unset('claimExtensions')
            await props.scope.unset('fullscreenOnOpen')
          } else {
            await props.scope.set('keepResident', value.keepResident === undefined || value.keepResident === null ? true : value.keepResident)
            await props.scope.set('claimExtensions', typeof value.claimExtensions === 'string' ? normalizeClaimExtensions(value.claimExtensions) : DEFAULT_CLAIM_EXTENSIONS)
            await props.scope.set('fullscreenOnOpen', value.fullscreenOnOpen === undefined || value.fullscreenOnOpen === null ? true : value.fullscreenOnOpen)
          }
          setDraft(null)
          syncStatusToStore()
        } catch (e) {
          setFailed(true)
        }
        setSaving(false)
      }
      var fields = [
        // 三个设置(0.2.11 起):认领类型 + 打开即全屏 + 后台常驻。入口/依赖安装/环境检测三行已移除
        // (入口在右侧栏「开始」页的 guide 入口框;诊断看 host 日志里的 [code-server] 输出)。
        React.createElement('div', { className: 'dshcs-field' },
          React.createElement('div', { className: 'dshcs-fieldHead' },
            React.createElement('span', { className: 'dshcs-fieldLabel' }, '认领类型(按扩展名,分号分隔)'),
            overriddenClaim === true
              ? React.createElement(csBadges, {
                  overridden: true, disabled: snapshot.writable !== true,
                  overriddenLabel: '已覆盖', resetLabel: '恢复默认',
                  onReset: function () { doReset() },
                })
              : null
          ),
          React.createElement(csTextarea, {
            value: draft !== null ? draft.claimExtensions : loaded.claimExtensions,
            disabled: snapshot.writable !== true,
            placeholder: '例如 py;ts;!md(留空 = 不认领任何文件)',
            onChange: function (v) { setDraft(function (prev) { return Object.assign({}, prev !== null ? prev : loaded, { claimExtensions: v }) }); setFailed(false) },
          }),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '写扩展名(不带点,大小写随意);`*` = 其余类型也认领;`!ext` = 不认领(排除优先)。'
            + '不再区分会话内/绝对路径 —— 所有 `dsh-resource://file/**` 一视同仁,未认领的落回 DSH 自带预览。'),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '实际规则:' + describeClaimPolicy(draft !== null ? draft.claimExtensions : loaded.claimExtensions)
            + (normalizeClaimExtensions(draft !== null ? draft.claimExtensions : loaded.claimExtensions)
              !== (draft !== null ? draft.claimExtensions : loaded.claimExtensions) ? '(保存后归一化)' : '')),
          // 提示块(0.3.52):分三行写清楚 + 默认值**折成多行**显示。
          // 以前这里是一整行"… · 默认 <700 字符>" —— `;` 在 CSS 里不是断行点,那串既不折行也复制不全,
          // 直接把卡片撑破。现在:三组各自成行(与 lib/claim-types.js 的常量同源),换行与分号等价,
          // 所以整段连换行一起复制回输入框,解析结果与官方默认值逐字相同。
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 6 } },
            '默认排除三类:① DSH 预览渲染得好的 markdown/html/图片/PDF;'
            + '② 可执行文件与二进制产物(exe/dll/msi/jar/so…);'
            + '③ Office 与版式文档(docx/xlsx/pptx/vsdx…)。'
            + '文本脚本(bat/cmd/ps1/sh/py)与 csv/tsv 仍进 IDE。'
            + '想整组放开,把下面这段换成 `*;!md;!html;!png;!jpg;!pdf` 之类的短清单即可。'),
          React.createElement('div', { className: 'dshcs-hint', style: { marginTop: 4 } },
            '默认值(可整段复制;换行与分号等价):',
            React.createElement('code', { className: 'dshcs-code', 'data-claim-default': 'lines' }, claimDefaultLines())
          )
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
      ]
      // ---- 插件页的配置区(DSH ≥ 0.1.6-alpha.2)----
      // 上游把插件设置从"设置 → 插件"搬到**插件页**:页面自己画标题/图标/面包屑,把
      // `plugins.bundle.config`(按包名为键)渲染在描述与行之间,只问 `view: 'page'`。
      // 所以这里不再套可折叠卡片(标题会与页面标题重复),只出表单 + 自己的保存控件
      // (契约原文:the form with its own save control)。
      if (props.seat === 'bundle-config') {
        return React.createElement('div', { className: 'dshcs-cfgpage', 'data-code-server-config': 'page' },
          snapshot.writable !== true
            ? React.createElement('p', { className: 'dshcs-cardReadOnly', role: 'status' }, '本部署的设置为只读。')
            : null,
          ...fields,
          failed === true
            ? React.createElement('p', { className: 'dshcs-cardFailed', role: 'status' }, '本部署没有接受这些值，已保留供你修改。')
            : null,
          React.createElement('div', { className: 'dshcs-cfgfoot' },
            React.createElement(csBtn, {
              disabled: !dirty || saving,
              onClick: function () { setDraft(null); setFailed(false) },
            }, '放弃修改'),
            React.createElement(csBtn, {
              variant: 'primary', disabled: saveDisabled, onClick: function () { doSave() },
            }, saving === true ? '保存中…' : '保存')
          )
        )
      }
      return React.createElement(csCard, {
        title: 'Code Server',
        description: '入口:右侧栏标签(DSH ≥ 0.1.5-alpha.1);认领类型决定哪些文件交给 Code Server 打开',
        state: state,
        unsavedLabel: '未保存', readOnlyLabel: '本部署的设置为只读。',
        saveFailedLabel: '本部署没有接受这些值，已保留供你修改。',
        discardLabel: '放弃修改', saveLabel: '保存', savingLabel: '保存中…',
        onSave: doSave, onDiscard: function () { setDraft(null); setFailed(false) },
      }, ...fields)
      } catch (e) {
        // 渲染异常:记日志不打断;官方插槽对异常有边界,卡片留空即可
        console.error('[code-server] card render error:', e !== null && e !== undefined && e.message !== undefined ? e.message : String(e))
        return null
      }
    }

    /** 插件页配置区的入口组件(0.3.50)。
     *  上游契约:同一个 entry 会被要两种视图 —— `summary`(标题下的一句话)与 `page`(表单,
     *  自带保存控件)。插件页对 `plugins.bundle.config` 只用 `page`,但两种都答得起才算合格。
     *  本组件自身不调 hook(两个分支都不调),真正的设置表单在 csSettingsPage 里(独立组件边界)。 */
    function BundleConfigEntry(props) {
      if (props != null && props.view === 'summary') return CS_CONFIG_SUMMARY
      return React.createElement(csSettingsPage, Object.assign({}, props, { seat: 'bundle-config' }))
    }

    // ---------- 「问 DSH」对话框(0.3.24)----------    // 对话**不在编辑器的侧栏/tab 里**,而是作为一个浮在 DSH 页面上的对话框(用户的原话:
    // "对话不要用侧边栏,还是改成对话框形式")。这里就是那个对话框的壳:
    //   - 定时问 host `/ask/state?rev=N`,没变就只回一个数字(不重传对话流);
    //   - 打开时懒加载面板产物(`/ask/bundle` → thread.js / thread.css 文本)并注入:
    //     CSS 进一个 <style>(面板样式只在 `.dshcs-panel` 里生效,不碰 DSH 自己的 body),
    //     JS 进一个 <script>(它调用 acquireVsCodeApi —— 这里给它一个路由到本模块的替身);
    //   - 面板里的 ask / approve / close 消息 → host 的 `/ask/send|approve|close`。
    var ASK_POLL_MS = 900
    var ask = {
      rev: -1,
      open: false,
      mounted: false,
      pending: null,
      el: null, body: null, title: null, timer: null, loading: false,
    }

    /** 面板 → 对话框壳的消息通道(替身 acquireVsCodeApi 把消息交到这里)。 */
    function askOnMessage(message) {
      if (message === null || typeof message !== 'object') return
      if (message.type === 'ready') { askPush(true); return }
      if (message.type === 'ask' && typeof message.text === 'string') {
        api('/code-server/ask/send', { text: message.text, mode: ask.pending === null ? undefined : ask.pending.mode })
          .then(function (result) { ask.rev = -1; askPush(true) })
          .catch(function () { /* 下一趟轮询会带回状态 */ })
        return
      }
      if (message.type === 'approve' && typeof message.id === 'string') {
        api('/code-server/ask/approve', { id: message.id, outcome: message.outcome })
          .then(function (result) {
            if (result != null && result.ok === false) askNotice(result.error || '授权提交失败')
            ask.rev = -1
            askPush(true)
          })
          .catch(function (err) { askNotice('授权提交失败:' + String(err && err.message ? err.message : err)) })
        return
      }
      if (message.type === 'close') askClose()
    }

    /** 把 host 的状态推进面板(面板顶层的 `__DSHCS_ASK_PUSH__` 由 app.jsx 暴露)。 */
    function askPush(force) {
      if (ask.el === null) return
      var push = window.__DSHCS_ASK_PUSH__
      if (typeof push === 'function') push(ask.pending)
      else if (force === true) setTimeout(function () { askPush(false) }, 120)
    }

    /** 状态行里说一句(面板自己在 statusText 里显示;这里只兜底日志)。 */
    function askNotice(text) {
      console.warn('[code-server] ask dialog:', text)
    }

    function askClose() {
      ask.open = false
      if (ask.el !== null) ask.el.style.display = 'none'
      api('/code-server/ask/close', {}).catch(function () { /* 下一趟轮询会纠正 */ })
    }

    /** 造对话框外壳(只造一次):头部(标题 / 上下文 / ✕)+ 面板挂载点。 */
    function askEnsureShell() {
      if (ask.el !== null) return
      var el = document.createElement('div')
      el.className = 'dshcs-dialog'
      el.setAttribute('data-dshcs-dialog', 'ask')
      el.style.cssText = [
        'position:fixed', 'right:24px', 'bottom:24px', 'width:460px', 'height:600px',
        'min-width:320px', 'min-height:280px', 'max-width:96vw', 'max-height:92vh',
        'resize:both', 'overflow:hidden', 'display:none', 'z-index:2147483000',
        'border-radius:10px', 'box-shadow:0 18px 48px rgba(0,0,0,.45)',
        'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        'background:var(--dsw-alias-bg-base, var(--vscode-editor-background, #1e1e1e))',
      ].join(';')
      var head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:move;'
        + 'border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));'
        + 'font:var(--dsw-font-markdown-base, 13px/20px sans-serif)'
      var title = document.createElement('span')
      title.textContent = 'DSH 对话'
      title.style.cssText = 'font-weight:600;flex:none'
      var where = document.createElement('span')
      where.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        + 'color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));font-size:12px'
      var close = document.createElement('button')
      close.type = 'button'
      close.textContent = '✕'
      close.title = '关闭'
      close.setAttribute('aria-label', '关闭')
      close.style.cssText = 'flex:none;border:0;background:transparent;color:inherit;cursor:pointer;'
        + 'font-size:13px;line-height:1;padding:2px 6px;border-radius:4px'
      close.addEventListener('click', function () { askClose() })
      head.appendChild(title)
      head.appendChild(where)
      head.appendChild(close)
      var body = document.createElement('div')
      body.className = 'dshcs-panel'
      body.setAttribute('data-dshcs-ask-root', '')
      body.style.cssText = 'height:calc(100% - 33px);overflow:hidden'
      el.appendChild(head)
      el.appendChild(body)
      document.body.appendChild(el)
      ask.el = el
      ask.body = body
      ask.title = where
      // 拖动:按住头部移动(位置只在本次会话内有效,不做持久化)。
      var drag = null
      head.addEventListener('pointerdown', function (event) {
        if (event.target === close) return
        var rect = el.getBoundingClientRect()
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        el.style.left = rect.left + 'px'
        el.style.top = rect.top + 'px'
        try { head.setPointerCapture(event.pointerId) } catch (e) { /* 忽略 */ }
      })
      head.addEventListener('pointermove', function (event) {
        if (drag === null) return
        el.style.left = Math.max(0, Math.min(window.innerWidth - 80, drag.left + (event.clientX - drag.x))) + 'px'
        el.style.top = Math.max(0, Math.min(window.innerHeight - 40, drag.top + (event.clientY - drag.y))) + 'px'
      })
      head.addEventListener('pointerup', function () { drag = null })
    }

    /**
     * 取面板产物:内存 → sessionStorage(15 分钟)→ host `/ask/bundle`。
     *
     * 为什么要缓存 + 预热(0.3.42):产物是官方渲染器那一整套(JS ≈1MB、CSS ≈426KB,KaTeX 字体已内联),
     * 第一次打开对话框要"取文本 + 注入 + 解析 + 执行",实测就是"第一次启动很耗时"。
     * 现在页面加载后空闲时**先取好放内存**(用户点开时直接注入),并用 sessionStorage 顶住刷新。
     */
    var ASK_BUNDLE_KEY = 'dshcs.ask.bundle'
    var ASK_BUNDLE_TTL_MS = 15 * 60 * 1000
    var askBundleCache = null

    function askBundleFromStorage() {
      try {
        var raw = window.sessionStorage.getItem(ASK_BUNDLE_KEY)
        if (raw == null) return null
        var parsed = JSON.parse(raw)
        if (parsed == null || typeof parsed.js !== 'string' || typeof parsed.css !== 'string') return null
        if (Date.now() - Number(parsed.at || 0) > ASK_BUNDLE_TTL_MS) return null
        return { css: parsed.css, js: parsed.js }
      } catch (e) {
        return null
      }
    }

    function askBundleToStorage(bundle) {
      try {
        window.sessionStorage.setItem(ASK_BUNDLE_KEY, JSON.stringify({ at: Date.now(), css: bundle.css, js: bundle.js }))
      } catch (e) {
        // 容量/隐私模式失败都无所谓:内存那份已经够用
      }
    }

    /** 预热:页面加载后空闲时先把产物取回来(不挂载、不显示任何东西)。 */
    function askPreload() {
      if (askBundleCache !== null || ask.mounted) return
      var stored = askBundleFromStorage()
      if (stored !== null) {
        askBundleCache = stored
        return
      }
      api('/code-server/ask/bundle').then(function (bundle) {
        if (bundle == null || bundle.ok !== true) return
        askBundleCache = { css: bundle.css, js: bundle.js }
        askBundleToStorage(askBundleCache)
        console.log('[code-server] ask bundle preloaded (' + Math.round((bundle.js.length + bundle.css.length) / 1024) + 'KB)')
      }).catch(function () { /* 预热失败不打扰:真正打开时会再取一次 */ })
    }

    /** 懒加载面板产物并挂载(只做一次)。 */
    function askMount() {
      if (ask.mounted || ask.loading) return
      ask.loading = true
      var ready = askBundleCache !== null
        ? Promise.resolve(askBundleCache)
        : (askBundleFromStorage() !== null
          ? Promise.resolve(askBundleFromStorage())
          : api('/code-server/ask/bundle'))
      ready.then(function (body) {
        ask.loading = false
        var bundle = body
        if (askBundleCache === null && body != null && body.ok === true) {
          bundle = { css: body.css, js: body.js }
          askBundleCache = bundle
          askBundleToStorage(bundle)
        }
        if (bundle == null || typeof bundle.js !== 'string') {
          askNotice(bundle != null && bundle.error ? bundle.error : '面板产物不可用')
          return
        }
        askEnsureShell()
        if (document.getElementById('dshcs-ask-style') === null) {
          var style = document.createElement('style')
          style.id = 'dshcs-ask-style'
          style.textContent = bundle.css
          document.head.appendChild(style)
        }
        // 面板脚本:给它 acquireVsCodeApi 替身 + 挂载点,再执行。
        window.__DSHCS_HOST__ = 'dsh'
        window.__DSHCS_MOUNT__ = ask.body
        window.acquireVsCodeApi = function () { return { postMessage: askOnMessage } }
        var script = document.createElement('script')
        script.textContent = bundle.js
        document.head.appendChild(script)
        ask.mounted = true
        setTimeout(function () { askPush(true) }, 60)
      }).catch(function (err) {
        ask.loading = false
        askNotice('面板产物加载失败:' + String(err && err.message ? err.message : err))
      })
    }

    /** 轮询 host 状态:open 就显示并推状态,关了或没变化就什么都不做。 */
    function askPoll() {
      api('/code-server/ask/state?rev=' + ask.rev).then(function (result) {
        if (result == null || result.ok !== true) return
        if (result.changed !== true) return
        ask.rev = typeof result.rev === 'number' ? result.rev : -1
        ask.pending = result
        if (result.open === true) {
          askEnsureShell()
          ask.el.style.display = 'block'
          if (ask.title !== null) ask.title.textContent = result.contextText || '来自编辑器'
          ask.open = true
          askMount()
          if (ask.mounted) askPush(true)
        } else if (ask.el !== null) {
          ask.el.style.display = 'none'
          ask.open = false
        }
      }).catch(function () { /* 宿主没起/旧版:静默重试 */ })
    }

    function askStart() {
      if (ask.timer !== null) return
      ask.timer = setInterval(askPoll, ASK_POLL_MS)
      setTimeout(askPoll, 800)
      // 空闲时预热面板产物(0.3.42):用户点「问 DSH」时就不必再等一次 1.4MB 的取+解析。
      setTimeout(askPreload, 3000)
      console.log('[code-server] ask dialog poller started (every ' + ASK_POLL_MS + 'ms)')
    }

    function apply(ctx) {
      try {
        internalApply(ctx)
        askStart()
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

      // ---- 设置:两条腿都注册,谁被声明谁生效(两次注册不会同时出现) ----
      // ① 插件页的配置区(DSH ≥ 0.1.6-alpha.2):`settings.plugin.item` 退役,上游把插件配置搬到
      //    插件页 —— 键是**包名**(页面按 `pkg.name` 派发),只问 `view: 'page'`。插件页只在
      //    `ledger.bundles.has(包名)` 时才渲染那一块,所以键写错就等于"设置又不见了"。
      slots.inject('plugins.bundle.config', () => slots.register(
        { name: 'plugins.bundle.config', key: PKG_NAME, inject: function () { return { scope: scope } } },
        BundleConfigEntry
      ))
      // ② 设置页里的插件卡片(DSH ≤ 0.1.6-alpha.1;也是极旧 DSH 里唯一的提示出口)。
      //    `slots.inject` 只在插槽真被声明时才回调 ⇒ 新 DSH 上这一条自然不生效。
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

    // 入口导出(与原 `export { apply, inject, name }` 等价;banner/footer 的 CJS 形态要求)
    module.exports = { apply: apply, inject: inject, name: name }

// ---- 测试钩子(唯一为测试而存在的代码;DSH 永不设置该标志)----
// scripts/client-bundle-harness.mjs 的 testHooks 选项会先设 window.__dshcsTestHooks = true,
// 于是两个"纯函数单元套件"(workspace 解析、全屏动作)可以直接调这里的内部函数,
// 不需要为了可测而把模块拆出去(拆出去就意味着又要有构建)。
if (typeof window !== 'undefined' && window.__dshcsTestHooks === true) {
  module.exports.__internals = {
    parseFileAddress: parseFileAddress,
    basenameOfAddress: basenameOfAddress,
    resolveFilePath: resolveFilePath,
    isPageAddress: isPageAddress,
    pickWorkspaceCwd: pickWorkspaceCwd,
    requestFullscreenPanel: requestFullscreenPanel,
    getParkStrategy: getParkStrategy,
    surfaceSnapshot: surfaceSnapshot,
    normalizeClaimExtensions: normalizeClaimExtensions,
    parseClaimPolicy: parseClaimPolicy,
    claimsAddress: claimsAddress,
    describeClaimPolicy: describeClaimPolicy,
    DEFAULT_CLAIM_EXTENSIONS: DEFAULT_CLAIM_EXTENSIONS,
    PREVIEW_FRIENDLY_EXTENSIONS: PREVIEW_FRIENDLY_EXTENSIONS,
    EXECUTABLE_EXTENSIONS: EXECUTABLE_EXTENSIONS,
    OFFICE_EXTENSIONS: OFFICE_EXTENSIONS,
  }
}

return module.exports;}});
