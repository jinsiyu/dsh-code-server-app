// scripts/test-workspace-cwd.mjs —— "当前工作区目录"解析的单元测试(lib/client.js 内的同名函数)
//
// 为什么要有:这段逻辑决定 workbench 用哪个 `?folder=` 打开(以及会不会给宿主发 cwd),
// 而它的输入是 **DSH 客户端 store 的形状** —— 形状随 DSH 版本变过一次,错法又完全静默:
// 0.3.46 在 DSH 0.1.6-alpha.2 上读 `useSessions(s => s).current`,而 `current` 已被上游从
// SessionListState 移除 ⇒ cwd 恒为 undefined ⇒ 客户端不发 cwd ⇒ IDE 以**空工作区**启动
// (本机实测:pid.json 里 cwd/launchCwd 双空)。这里把两版形状都钉死,顺带钉死"拿不到就
// 返回 undefined(绝不猜目录)"这条底线。
//
// 形状锚点(装在本机的 DSH,可直接对照):
//   · 0.1.6-alpha.2:`@deepseek-ai/dsh-api-session-controller/lib/client.js` 里 list.set({ids,byId,phase,subagentsByParent,jobsBySession})
//     —— 全文件 0 处 `current:`;`ui-deliverables` 的 ReviewTab 用 `useSessions(s => s.byId[sessionId]?.cwd)`;
//   · 0.1.6-alpha.1:`.../sessions/service.ts` 的 SessionListState 里仍有 `current: SessionId | undefined`。
//
// **0.3.58 起客户端入口是手写单文件**(不再构建),这段逻辑就内联在 lib/client.js 里。
// 为了不把模块再拆出去(拆出去 = 又要有构建),函数经入口的测试钩子取:
// harness 的 `testHooks: true` 让入口额外导出 `__internals`。断言与原套件逐字相同。
//
// 用法:node scripts/test-workspace-cwd.mjs
import assert from 'node:assert/strict';
import { loadClientBundle } from './client-bundle-harness.mjs';

const { pickWorkspaceCwd } = loadClientBundle({ testHooks: true }).internals;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const WS_ALPHA = 'C:/work/alpha';
const WS_BETA = 'C:/work/beta';

/** DSH ≤ 0.1.6-alpha.1 的会话列表快照:带 `current`。 */
function sessionsAlpha1({ current, rows }) {
  const byId = {};
  for (const row of rows) byId[row.id] = row;
  return { ids: rows.map((r) => r.id), byId, current, phase: 'ready' };
}

/** DSH ≥ 0.1.6-alpha.2 的会话列表快照:**没有** `current`(上游把它移出了列表 store)。 */
function sessionsAlpha2({ rows }) {
  const byId = {};
  for (const row of rows) byId[row.id] = row;
  return { ids: rows.map((r) => r.id), byId, phase: 'ready', subagentsByParent: {}, jobsBySession: {} };
}

const workspaces = (items) => ({ items, state: 'idle', phase: 'ready', error: null });

await test('0.1.6-alpha.2:会话标准 prop 的 sessionId → 该会话的 cwd(修复点)', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'b', cwd: WS_BETA }] });
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: workspaces([]), sessionId: 'b' }), WS_BETA);
});

await test('0.1.6-alpha.2:同形状下读旧字段必然拿不到 —— 这就是 0.3.46 的空工作区根因', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'b', cwd: WS_BETA }] });
  assert.equal(Object.prototype.hasOwnProperty.call(sessions, 'current'), false, 'alpha.2 快照不应再有 current');
  // 没有 sessionId(旧代码只认 current)且工作区表为空 → 不猜目录
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: workspaces([]) }), undefined);
});

await test('0.1.6-alpha.1:列表快照上的 current 仍然认(向后兼容)', async () => {
  const sessions = sessionsAlpha1({ current: 'a', rows: [{ id: 'a', cwd: WS_ALPHA }] });
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: workspaces([]) }), WS_ALPHA);
});

await test('sessionId 优先于 current(切标签/看别的会话的文件时不能串工作区)', async () => {
  const sessions = sessionsAlpha1({ current: 'a', rows: [{ id: 'a', cwd: WS_ALPHA }, { id: 'b', cwd: WS_BETA }] });
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: workspaces([]), sessionId: 'b' }), WS_BETA);
});

await test('会话摘要没有 cwd 时退到工作区表(按 sessionIds 归属)', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'b' }] });
  const ws = workspaces([{ workspaceId: 'w1', path: WS_ALPHA, sessionIds: [] }, { workspaceId: 'w2', path: WS_BETA, sessionIds: ['b'] }]);
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: ws, sessionId: 'b' }), WS_BETA);
});

await test('文件 tab 的会话来自地址:地址里的 sessionId 一样能用', async () => {
  // 地址 dsh-resource://file/session/<id>/src/a.ts → parseFileAddress().sessionId 交给本模块
  const sessions = sessionsAlpha2({ rows: [{ id: 'other', cwd: 'D:/repo/other' }] });
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: null, sessionId: 'other' }), 'D:/repo/other');
});

await test('根作用域(后台预热,无 sessionId)退到"最近活跃会话所属工作区"', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'recent', cwd: '' }, { id: 'old' }] });
  const ws = workspaces([
    { workspaceId: 'w1', path: WS_ALPHA, sessionIds: ['old'] },
    { workspaceId: 'w2', path: WS_BETA, sessionIds: ['recent'] },
  ]);
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: ws }), WS_BETA, 'ids[0] = 最近活跃(host 按活跃度排序)');
});

await test('根作用域:最近活跃会话不属于任何工作区时退到第一个工作区', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'loose', cwd: '' }] });
  const ws = workspaces([{ workspaceId: 'w1', path: WS_ALPHA, sessionIds: [] }]);
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: ws }), WS_ALPHA);
});

await test('recentWorkspaceId(旧字段)仍被兼容', async () => {
  const ws = { ...workspaces([{ workspaceId: 'w1', path: WS_ALPHA, sessionIds: [] }, { workspaceId: 'w2', path: WS_BETA, sessionIds: [] }]), recentWorkspaceId: 'w2' };
  assert.equal(pickWorkspaceCwd({ sessions: null, workspaces: ws }), WS_BETA);
});

await test('拿不到任何信源 → undefined(绝不猜目录;调用方不传 cwd)', async () => {
  assert.equal(pickWorkspaceCwd({}), undefined);
  assert.equal(pickWorkspaceCwd({ sessions: sessionsAlpha2({ rows: [] }), workspaces: workspaces([]) }), undefined);
  assert.equal(pickWorkspaceCwd({ sessions: { byId: { x: { cwd: '' } } }, workspaces: null, sessionId: 'x' }), undefined, '空串 cwd 视为缺失');
  assert.equal(pickWorkspaceCwd({ sessions: null, workspaces: { items: [{ workspaceId: 'w', path: '', sessionIds: [] }] } }), undefined);
});

await test('畸形输入不抛错(服务缺失/半截快照/别的类型)', async () => {
  const bad = [
    { sessions: { byId: null, ids: null }, workspaces: { items: null }, sessionId: 'x' },
    { sessions: { byId: { x: null } }, workspaces: { items: [null, 42, 'nope'] }, sessionId: 'x' },
    { sessions: { byId: { x: { cwd: 42 } }, ids: 'not-an-array' }, workspaces: { items: [{ path: 7, sessionIds: 'nope' }] } },
    { sessions: { byId: { x: { cwd: WS_ALPHA } }, current: 42 }, workspaces: null, sessionId: 42 },
  ];
  for (const input of bad) assert.equal(pickWorkspaceCwd(input), undefined);
});

await test('路径原样返回(Windows 反斜杠不在本层做 URL 归一)', async () => {
  const sessions = sessionsAlpha2({ rows: [{ id: 'w', cwd: 'C:\\Users\\u\\proj' }] });
  assert.equal(pickWorkspaceCwd({ sessions, workspaces: null, sessionId: 'w' }), 'C:\\Users\\u\\proj');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
