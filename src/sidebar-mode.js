// src/sidebar-mode.js —— 把右侧栏切到"全屏(铺满窗口)"这一个动作(打开 Code Server 标签时自动做)
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
export function requestFullscreenPanel(rootEl) {
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
