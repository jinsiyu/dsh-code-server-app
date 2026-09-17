// src/workspace.js —— 解析"当前工作区目录"(决定 workbench 用哪个 `?folder=` 打开)
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
export function pickWorkspaceCwd(input) {
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
