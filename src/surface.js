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
export const supportsMoveBefore = typeof Element !== 'undefined'
  && typeof Element.prototype.moveBefore === 'function'

var PARK_OFFSCREEN_LEFT = -20000

var state = {
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
    ready: state.frame !== null,
    docked: state.owner !== null,
    owner: state.owner,
    src: state.currentSrc,
    sameOrigin: state.sameOrigin,
    parkStrategy: state.parkStrategy,
    degraded: state.degraded,
    preloaded: state.preloaded,
    supportsMoveBefore: supportsMoveBefore,
    nudgeCount: state.nudgeCount,
    lastNudgeAt: state.lastNudgeAt,
  }
}

function notify() {
  var snap = snapshot()
  state.listeners.forEach(function (fn) {
    try { fn(snap) } catch (e) { /* 订阅者异常不影响移动 */ }
  })
}

/** 订阅常驻面状态(停靠/停放/降级),返回取消函数。 */
export function subscribeSurface(fn) {
  state.listeners.add(fn)
  return function () { state.listeners.delete(fn) }
}

export function surfaceSnapshot() { return snapshot() }

/** 停放策略:offscreen(默认)或 behind。切换时若当前处于停放态,立即重新摆放。 */
export function setParkStrategy(strategy) {
  if (strategy !== 'offscreen' && strategy !== 'behind') return
  if (state.parkStrategy === strategy) return
  state.parkStrategy = strategy
  if (state.frame !== null && state.owner === null) applyParkStyle()
  notify()
}

export function getParkStrategy() { return state.parkStrategy }

function parkHasFixedSize() {
  // 保留最后停靠尺寸:后台的 VS Code 布局不变,回到前台无需重排。
  var rect = state.lastRect
  if (rect === null) return
  state.park.style.width = Math.max(1, Math.round(rect.width)) + 'px'
  state.park.style.height = Math.max(1, Math.round(rect.height)) + 'px'
}

function applyParkStyle() {
  if (state.park === null) return
  parkHasFixedSize()
  if (state.parkStrategy === 'behind' && state.lastRect !== null) {
    // 原位、可视但不被点击:压在面板(z-index 10)之下 → 不会被判定为"不可见 iframe"。
    state.park.style.left = Math.round(state.lastRect.left) + 'px'
    state.park.style.top = Math.round(state.lastRect.top) + 'px'
    state.park.style.visibility = 'visible'
    state.park.style.zIndex = '0'
    return
  }
  state.park.style.left = PARK_OFFSCREEN_LEFT + 'px'
  state.park.style.top = '0px'
  state.park.style.visibility = 'hidden'
  state.park.style.zIndex = '0'
}

/** 停放态:不可交互、不进无障碍树、不抢焦点。 */
function markParked() {
  if (state.frame === null) return
  state.frame.setAttribute('inert', '')
  state.frame.setAttribute('aria-hidden', 'true')
}

function markDocked() {
  if (state.frame === null) return
  state.frame.removeAttribute('inert')
  state.frame.removeAttribute('aria-hidden')
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
  state.park = park
  state.frame = frame
  state.currentSrc = 'about:blank'
  state.owner = null
  applyParkStyle()
  markParked()
  return frame
}

/** serve=dsh 时 iframe 与 DSH 同源:此时不再挂 sandbox(同源 + allow-same-origin 可被 frame 自摘);
 *  loopback 跨源,sandbox 是真防护。属性变化会触发一次导航(模式切换本就该重载)。 */
function applyFrameAttrs(sameOrigin) {
  var frame = state.frame
  if (frame === null) return
  var changed = state.sameOrigin !== sameOrigin
  if (!changed && frame.hasAttribute('data-dshcs-attrs')) return
  if (sameOrigin === true) frame.removeAttribute('sandbox')
  else if (sameOrigin === false) {
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups '
      + 'allow-pointer-lock allow-clipboard-read allow-clipboard-write')
  }
  frame.setAttribute('data-dshcs-attrs', sameOrigin === true ? 'same-origin' : 'cross-origin')
  state.sameOrigin = sameOrigin
}

/** 确保常驻面存在并指向 src(不改变停靠状态)。用于后台预热与首次停靠前的准备。 */
export function ensureSurface(options) {
  var opts = options || {}
  if (state.frame === null) createSurface()
  if (typeof opts.sameOrigin === 'boolean') applyFrameAttrs(opts.sameOrigin)
  if (typeof opts.src === 'string' && opts.src !== '' && opts.src !== state.currentSrc) setSurfaceSrc(opts.src)
  return state.frame
}

/** 显式导航(工作区/端口变化时唯一的正常重载入口)。
 *  阶段 1 起给 URL 加 `?dshcs=<每次加载的标记>`:工作台 HTML 与其中的资源都是
 *  长缓存(max-age=31536000),不加标记的话打过补丁的 bundle 永远拿不到。 */
export function setSurfaceSrc(src) {
  if (state.frame === null || typeof src !== 'string' || src === '' || src === state.currentSrc) return
  state.currentSrc = src
  state.frame.src = withCacheTag(src)
  notify()
}

/** 每次插件加载一个标记(同一次加载内稳定,保证 currentSrc 比较仍然有效)。 */
var SURFACE_TAG = String(Date.now())

/** 只在 URL 没有查询串时补标记(不覆盖调用方自己的参数)。 */
export function withCacheTag(src) {
  if (typeof src !== 'string' || src === '' || src === 'about:blank') return src
  return src.indexOf('?') >= 0 ? src : src + (src.indexOf('#') >= 0 ? '' : '') + '?dshcs=' + SURFACE_TAG
}

/** 陈旧合成表面修复:**同一 JS 任务内**关/开一次布局,逼浏览器重建 iframe 的合成表面。
 *  不重载文档、不改变内部状态(实测:VS Code 布局与"欢迎"页状态保持),也不产生可见闪烁。 */
export function nudgeRepaint() {
  var frame = state.frame
  if (state.nudgeEnabled !== true || frame === null || frame.isConnected !== true) return false
  var prev = frame.style.display
  frame.style.display = 'none'
  void frame.offsetHeight // 强制重排:丢弃陈旧表面
  frame.style.display = prev
  state.nudgeCount += 1
  state.lastNudgeAt = Date.now()
  return true
}

/** 排障用:临时关闭修复,做 A/B 对照(默认开启)。 */
export function setNudgeEnabled(enabled) {
  state.nudgeEnabled = enabled !== false
  return state.nudgeEnabled
}

function moveInto(target) {
  if (state.frame === null) return
  if (supportsMoveBefore) {
    try {
      target.moveBefore(state.frame, null)
      return
    } catch (error) {
      // 实测:源容器已被摘出文档时(React 先删 DOM、后跑 passive effect cleanup),
      // moveBefore 抛 HierarchyRequestError("invalid hierarchy")。此时退回 appendChild:
      // 会重载一次,但**绝不丢帧**(绝不能把 iframe 留在已脱离文档的宿主里)。
      state.degraded = true
      state.lastMoveError = (error && error.name ? error.name + ': ' : '') + (error && error.message ? error.message : String(error))
    }
  } else {
    state.degraded = true
  }
  target.appendChild(state.frame)
}

/** 把常驻面停靠到 host 容器(标签 body 里的占位 div)。 */
export function dockInto(host, owner) {
  if (state.frame === null || host == null) return
  var wasParked = state.owner === null
  var rect = host.getBoundingClientRect()
  if (rect.width >= 1 && rect.height >= 1) {
    state.lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
  state.owner = owner === undefined ? null : owner
  markDocked()
  state.park.setAttribute('aria-hidden', 'true')
  moveInto(host)
  // 从停放回到停靠:补一次重绘唤醒(见文件头"另一个实测坑")。
  if (wasParked) nudgeRepaint()
  notify()
}

/** 把常驻面移回停放区;仅当 owner 匹配(或未指定)时生效,避免非当前停靠者误停放。 */
export function parkSurface(owner) {
  if (state.frame === null) return
  if (owner !== undefined && state.owner !== owner) return
  state.owner = null
  applyParkStyle()
  markParked()
  state.park.setAttribute('aria-hidden', 'true')
  moveInto(state.park)
  notify()
}

/** 后台预热:建面 + 指向 src 并停在停放区(keepResident=true 时由宿主侧状态驱动)。
 *  已经停靠着(用户正在看 IDE)时只更新 src,绝不把面拽走。 */
export function preloadSurface(options) {
  var opts = options || {}
  ensureSurface(opts)
  if (state.owner === null) {
    if (typeof opts.src === 'string' && opts.src !== '') state.preloaded = true
    parkSurface()
  }
  return state.frame
}

/** 仅供排障/测试:销毁并复位。 */
export function destroySurface() {
  if (state.park !== null && state.park.parentNode !== null) state.park.parentNode.removeChild(state.park)
  state.park = null
  state.frame = null
  state.currentSrc = null
  state.sameOrigin = null
  state.owner = null
  state.lastRect = null
  state.degraded = false
  state.preloaded = false
  state.nudgeCount = 0
  state.lastNudgeAt = 0
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
