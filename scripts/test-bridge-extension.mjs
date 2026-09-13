// scripts/test-bridge-extension.mjs —— 编辑器桥扩展侧的纯逻辑回归(0.3.0)
//
// 这个脚本**不需要 VS Code**:扩展的 lib/ 下三个模块刻意不 require('vscode'),
// 所以投影规则、diff 判据、配置读写、agent 投递都能在这里直接验。
//
// 守四件事:
//   B1 **未保存缓冲区必须被上报**:磁盘内容 ≠ 用户所见,agent 按磁盘改就会冲掉用户的编辑。
//      这条一旦回归,"只读地帮用户"就变成了"悄悄覆盖用户的工作"。
//   B2 **诊断收敛在工作区内 + 排序 + 截断**:越界的诊断既无意义又会把响应撑爆。
//   B3 **agent 改动只在"内容真变了"时才打扰用户**(空写、写回原样都不该弹窗)。
//   B4 **投递路径永不抛**:没有可用会话时返回 NO_AGENT(编辑器据此提示),而不是把异常扔到命令里。
//
// 用法:node scripts/test-bridge-extension.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const EXT = '../assets/extensions/dshcs-editor-bridge';

let pass = 0;
let fail = 0;
let skip = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    if (error && error.dshcsSkip === true) {
      skip += 1;
      console.log(`SKIP ${name}:${error.message}`);
      return;
    }
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

/** 沙箱(workspace-write)不允许**连接**命名管道(EPERM;监听是允许的)—— 这是本机沙箱边界,
 *  与代码正确性无关,真实部署没有这个问题。遇到时把用例标 SKIP,不静默通过。 */
function skipOnEperm(error) {
  if (error && error.code === 'EPERM') {
    const skipped = new Error('EPERM(沙箱不允许连接命名管道)');
    skipped.dshcsSkip = true;
    return skipped;
  }
  return error;
}

const contextModel = require2(`${EXT}/lib/context-model.js`);
const diffModel = require2(`${EXT}/lib/diff-model.js`);
const bridgeClient = require2(`${EXT}/lib/bridge-client.js`);

const WORKSPACE = process.platform === 'win32' ? 'C:\\repo' : '/repo';
/** 测试用的本机 IPC 端点(形状必须过 isBridgeEndpoint)。 */
const PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\dshcs-bridge-test-0123456789abcdef'
  : join(tmpdir(), 'dshcs-bridge-test.sock');
const OUTSIDE = process.platform === 'win32' ? 'C:\\other\\thing.ts' : '/other/thing.ts';
const inRepo = (p) => p === WORKSPACE || p.startsWith(`${WORKSPACE}${process.platform === 'win32' ? '\\' : '/'}`);
const projector = contextModel.createProjector(inRepo);

// ---------------------------------------------------------------- 上下文投影

await test('未保存缓冲区被上报(含无标题文档占位)', () => {
  const result = projector.context({
    active: { path: `${WORKSPACE}\\a.ts`, name: 'a.ts', language: 'typescript', dirty: true, selection: null },
    documents: [
      { path: `${WORKSPACE}\\a.ts`, name: 'a.ts', dirty: true, unsavedLines: 12, untitled: false },
      { path: `${WORKSPACE}\\b.ts`, name: 'b.ts', dirty: false, unsavedLines: 0, untitled: false },
      { path: 'untitled:Untitled-1', name: 'untitled:Untitled-1', dirty: true, unsavedLines: 4, untitled: true },
    ],
    diagnostics: [],
  });
  assert.equal(result.available, true);
  assert.equal(result.dirtyBuffers.length, 2, '两个脏文档(含无标题)都要出现');
  const paths = result.dirtyBuffers.map((item) => item.path);
  assert.ok(paths.includes(`${WORKSPACE}\\a.ts`));
  assert.ok(paths.includes('untitled:Untitled-1'), '无标题文档用 untitled:<n> 占位');
  assert.ok(!paths.includes(`${WORKSPACE}\\b.ts`), '干净的文档不该出现在脏列表里');
  assert.equal(result.active.dirty, true);
});

await test('诊断收敛在工作区内(工作区外的直接丢弃)', () => {
  const filtered = projector.filterDiagnostics([
    { path: `${WORKSPACE}\\a.ts`, items: [{ line: 3, column: 1, severity: 0, message: 'x' }] },
    { path: OUTSIDE, items: [{ line: 1, column: 1, severity: 0, message: 'should be dropped' }] },
  ]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].path, `${WORKSPACE}\\a.ts`);
});

await test('诊断排序:error → warning → info → hint,同级按文件与行', () => {
  const { diagnostics, total } = projector.diagnostics({
    diagnostics: [{
      path: `${WORKSPACE}\\a.ts`,
      items: [
        { line: 9, column: 1, severity: 3, message: 'hint' },
        { line: 5, column: 1, severity: 0, message: 'error-late' },
        { line: 1, column: 1, severity: 1, message: 'warn' },
        { line: 2, column: 1, severity: 0, message: 'error-early' },
      ],
    }],
  });
  assert.equal(total, 4);
  assert.deepEqual(diagnostics.map((d) => d.severity), ['error', 'error', 'warning', 'hint']);
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), ['error-early', 'error-late']);
});

await test('诊断按文件过滤 + 严重度下限 + 截断都生效', () => {
  const diagnostics = [
    { path: `${WORKSPACE}\\a.ts`, items: [{ line: 1, column: 1, severity: 0, message: 'e' }, { line: 2, column: 1, severity: 2, message: 'i' }] },
    { path: `${WORKSPACE}\\b.ts`, items: [{ line: 1, column: 1, severity: 1, message: 'w' }] },
  ];
  assert.equal(projector.diagnostics({ diagnostics, file: `${WORKSPACE}\\a.ts` }).total, 1 + 1);
  assert.equal(projector.diagnostics({ diagnostics, severity: 'error' }).total, 1, '只要 error 及以上');
  assert.equal(projector.diagnostics({ diagnostics, severity: 'warning' }).total, 2);
  const limited = projector.diagnostics({ diagnostics, limit: 1 });
  assert.equal(limited.diagnostics.length, 1);
  assert.equal(limited.total, 3);
  assert.equal(limited.truncated, true);
});

await test('无标题文档不接受按文件查诊断(那条路径在磁盘上不存在)', () => {
  const result = projector.diagnostics({
    diagnostics: [{ path: `${WORKSPACE}\\a.ts`, items: [{ line: 1, column: 1, severity: 0, message: 'e' }] }],
    file: 'untitled:Untitled-1',
  });
  assert.equal(result.diagnostics.length, 0);
  assert.match(result.note, /未保存/);
});

await test('超长诊断 message 与选中文本都被截断(有界)', () => {
  const long = 'x'.repeat(contextModel.MAX_MESSAGE_CHARS + 500);
  const result = projector.diagnostics({ diagnostics: [{ path: `${WORKSPACE}\\a.ts`, items: [{ line: 1, column: 1, severity: 0, message: long }] }] });
  assert.ok(result.diagnostics[0].message.length <= contextModel.MAX_MESSAGE_CHARS + 8, 'message 必须截断');
  const ctx = projector.context({
    active: { path: `${WORKSPACE}\\a.ts`, dirty: false, selection: null, selectedText: 'y'.repeat(contextModel.MAX_SELECTION_CHARS + 100) },
    documents: [],
    diagnostics: [],
  });
  assert.ok(ctx.active.selectedText.length <= contextModel.MAX_SELECTION_CHARS + 16);
  assert.match(ctx.truncated, /截断/);
});

// ---------------------------------------------------------------- diff 判据

await test('agent 改动:内容没变就不打扰', () => {
  assert.equal(diffModel.describeChange('abc\n', 'abc\n').show, false);
  assert.equal(diffModel.describeChange('', '').show, false);
  assert.equal(diffModel.describeChange(null, '').show, false, '没有 old 侧且新内容为空 = 无意义');
  const changed = diffModel.describeChange('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(changed.show, true);
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
});

await test('agent 改动:只有一侧时 show=true 但行数不猜(避免误导)', () => {
  const created = diffModel.describeChange(null, 'line1\nline2\n');
  assert.equal(created.show, true);
  assert.equal(created.added, null, '没有 old 侧就不该报具体行数');
  assert.equal(created.removed, null);
  const deleted = diffModel.describeChange('line1\n', null);
  assert.equal(deleted.show, true);
  assert.equal(deleted.removed, null);
  assert.match(deleted.reason, /删除/);
});

await test('行级统计用公共前后缀裁剪(纯追加 = 只加不减)', () => {
  assert.deepEqual(diffModel.lineStats('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
  assert.deepEqual(diffModel.lineStats('a\nb\nc\n', 'a\nc\n'), { added: 0, removed: 1 });
  assert.equal(diffModel.countLines(''), 0);
  assert.equal(diffModel.countLines('a\r\nb'), 2, 'CRLF 与 LF 都算一行');
});

await test('diff 缓存:有界 LRU,命中会刷新次序', () => {
  const cache = diffModel.createDiffCache(2);
  cache.remember('a', 'A');
  cache.remember('b', 'B');
  assert.equal(cache.recall('a'), 'A', '命中应刷新 a 的次序');
  cache.remember('c', 'C'); // 淘汰最旧的 = b
  assert.equal(cache.has('b'), false, 'b 应被淘汰');
  assert.equal(cache.recall('a'), 'A');
  assert.equal(cache.recall('c'), 'C');
  assert.equal(cache.size, 2);
});

// ---------------------------------------------------------------- 配置与游标

await test('桥配置:只接受本机 IPC 端点与合法令牌(坏配置 = 休眠)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext-'));
  const file = bridgeClient.bridgeFile(dir);
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '缺文件 = 休眠');
  writeFileSync(file, 'not json', 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '坏 JSON = 休眠');
  writeFileSync(file, JSON.stringify({ pipe: 'http://10.0.0.5:8090', token: 'a'.repeat(32) }), 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '不是本机 IPC 端点必须拒绝(0.3.13 起不再有 HTTP 传输)');
  writeFileSync(file, JSON.stringify({ pipe: PIPE, token: 'short' }), 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '令牌长度不足必须拒绝');
  writeFileSync(file, JSON.stringify({ pipe: PIPE, token: 'a'.repeat(32), pid: 7 }), 'utf8');
  const good = bridgeClient.readBridgeConfig(dir);
  assert.equal(good.pipe, PIPE);
  assert.equal(good.pid, 7);
  rmSync(dir, { recursive: true, force: true });
});

await test('配置目录解析:host 注入的 DSHCS_EXTENSIONS_DIR 优先于自身位置反推(0.3.12 修正)', () => {
  // 0.3.12 起桥扩展装在内置目录(树里),与 <extensionsDir> 不同级 —— 只能靠 host 注入的 env 找到配置。
  // 老代码在 extension.js 里自己算过 `resolve(__dirname,'..','..')`,比 <extensionsDir> 还高一级,
  // 任何布局都读不到 bridge.json(桥永远休眠)。这里钉住"env 优先"与"只在这一处算"。
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext-env-'));
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  writeFileSync(bridgeClient.bridgeFile(dir), JSON.stringify({ pipe: PIPE, token: 'b'.repeat(32), pid: 9 }), 'utf8');
  const saved = process.env.DSHCS_EXTENSIONS_DIR;
  try {
    assert.equal(bridgeClient.defaultExtensionsDir(), join(import.meta.dirname, '..', 'assets', 'extensions'),
      '没有 env 时按 <ext>/lib/ 上溯两级');
    process.env.DSHCS_EXTENSIONS_DIR = dir;
    assert.equal(bridgeClient.defaultExtensionsDir(), dir, 'env 必须优先');
    const viaEnv = bridgeClient.readBridgeConfig();
    assert.equal(viaEnv === null ? null : viaEnv.pipe, PIPE, '不带参数也要能按 env 读到配置');
    const client = bridgeClient.createClient({ requestImpl: () => { throw new Error('不该发请求'); } });
    assert.equal(client.refresh() === null ? null : client.config.pipe, PIPE);
  } finally {
    if (saved === undefined) delete process.env.DSHCS_EXTENSIONS_DIR;
    else process.env.DSHCS_EXTENSIONS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('源码级:扩展侧自己不再算配置目录(计算只留在 bridge-client 一处)', () => {
  const source = readFileSync(new URL('../assets/extensions/dshcs-editor-bridge/extension.js', import.meta.url), 'utf8');
  const offenders = source.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /resolve\(__dirname/.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.deepEqual(offenders.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`), [],
    'extension.js 不该自己反推目录(0.3.0–0.3.11 的那次上溯多了一级)');
  assert.match(source, /createClient\(\)/, 'extension.js 必须走 createClient 的默认解析');
});

await test('客户端:休眠时 sync 不抛,也不发请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext2-'));
  let calls = 0;
  const client = bridgeClient.createClient({
    extensionsDir: dir,
    requestImpl: () => { calls += 1; throw new Error('不该被调用'); },
  });
  assert.equal(client.isDormant(), true);
  const result = await client.sync({ context: {}, diagnostics: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'dormant');
  assert.equal(calls, 0, '休眠时一个请求都不该发出去');
  rmSync(dir, { recursive: true, force: true });
});

await test('客户端:sync 走 socketPath(不是 HTTP),带令牌头、一趟取回事件并推进游标', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext3-'));
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  writeFileSync(bridgeClient.bridgeFile(dir), JSON.stringify({ pipe: PIPE, token: 'a'.repeat(32), pid: 7 }), 'utf8');
  const seen = [];
  const client = bridgeClient.createClient({
    extensionsDir: dir,
    requestImpl: async (request) => {
      seen.push(request);
      return { status: 200, json: { ok: true, events: [{ seq: 3, kind: 'agent-edit', path: `${WORKSPACE}\\a.ts` }] } };
    },
  });
  const payload = { context: { dirtyBuffers: [] }, diagnostics: [] };
  const result = await client.sync(payload);
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
  assert.equal(client.cursor, 3, '游标必须前进');
  assert.equal(seen[0].socketPath, PIPE, '0.3.13 起必须走本机 IPC(desktop 没有 HTTP 面)');
  assert.equal(seen[0].headers[bridgeClient.TOKEN_HEADER], 'a'.repeat(32), '必须带令牌头');
  assert.deepEqual(JSON.parse(seen[0].body), payload, '上报体必须是投影结果');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].path, `${bridgeClient.BRIDGE_BASE}/sync?since=0`, '第一次应该从 since=0 开始');
  // 第二次:游标应带上
  await client.sync(payload);
  assert.equal(seen[1].path, `${bridgeClient.BRIDGE_BASE}/sync?since=3`, '第二次必须带上次的游标');
  rmSync(dir, { recursive: true, force: true });
});

await test('端到端:真实命名管道上跑一次 sync(host 监听口 ⇄ 扩展客户端)', async () => {
  // 这条是"传输真的通了"的证据:用 host 侧生产代码 startBridgeListener 起一个监听口,
  // 再用扩展侧生产代码(createClient 的默认传输 defaultRequest)去请求它。
  // 两端都是各自实现(扩展不能 import host 代码),所以这里同时钉住"两边对同一份协议的理解"。
  const { startBridgeListener, bridgeEndpointPath } = await import('../lib/bridge-ipc.mjs');
  const endpoint = bridgeEndpointPath(mkdtempSync(join(tmpdir(), 'dshcs-ipc-')), process.pid);
  const token = 'e2e-'.padEnd(24, 'x');
  const seen = [];
  const listener = await startBridgeListener({
    socketPath: endpoint,
    handler: (req, res) => {
      seen.push({ url: req.url, method: req.method, token: req.headers[bridgeClient.TOKEN_HEADER] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events: [{ seq: 1, kind: 'agent-edit', path: `${WORKSPACE}\\a.ts` }] }));
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dshcs-e2e-'));
    mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
    writeFileSync(bridgeClient.bridgeFile(dir), JSON.stringify({ pipe: endpoint, token, pid: 3 }), 'utf8');
    const client = bridgeClient.createClient({ extensionsDir: dir });
    const result = await client.sync({ context: { dirtyBuffers: [] }, diagnostics: [] });
    if (result.code === 'EPERM') throw skipOnEperm(Object.assign(new Error('x'), { code: 'EPERM' }));
    assert.equal(result.ok, true, `sync 应成功:${JSON.stringify(result)}`);
    assert.equal(result.events.length, 1);
    assert.equal(client.cursor, 1);
    assert.equal(seen[0].url, `${bridgeClient.BRIDGE_BASE}/sync?since=0`);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].token, token, '令牌头必须真的到了监听口');
    // health 也要能过(无鉴权路由)
    const health = await client.health();
    assert.equal(health.ok, true);
    // 端点不可达(宿主没在跑):sync 返回 ok:false 而不是抛
    const dead = bridgeClient.createClient({ extensionsDir: dir });
    await listener.close();
    const failed = await dead.sync({ context: {}, diagnostics: [] });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 0, '连不上宿主时 status=0(扩展据此休眠/重试)');
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw skipOnEperm(error);
  } finally {
    await listener.close().catch(() => {});
  }
});

await test('内置安装的扩展:没有 env 也能在"自己旁边"读到配置(0.3.16,adopt 的 IDE 拿不到 env)', async () => {
  // 环境变量只在 host **spawn** IDE 时注入;而 adopt(接管正在运行的 IDE)的那个进程是上一次启动的,
  // env 早已定死 ⇒ 扩展必须能只靠自身位置找到配置:`<ext>/lib/` 上溯两级 = <树>/lib/vscode/extensions。
  // host 侧对应 `bridgeConfigDirs()` 的第二份写入位置。
  const { copyFileSync } = await import('node:fs');
  const tree = mkdtempSync(join(tmpdir(), 'dshcs-tree-'));
  const extDir = join(tree, 'lib', 'vscode', 'extensions', 'dshcs-editor-bridge');
  mkdirSync(join(extDir, 'lib'), { recursive: true });
  for (const rel of ['package.json', 'extension.js', 'lib/bridge-client.js', 'lib/context-model.js', 'lib/diff-model.js']) {
    copyFileSync(new URL(`../assets/extensions/dshcs-editor-bridge/${rel}`, import.meta.url), join(extDir, rel));
  }
  const siblingDir = join(tree, 'lib', 'vscode', 'extensions');
  mkdirSync(join(siblingDir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  writeFileSync(join(siblingDir, bridgeClient.BRIDGE_DIRNAME, 'bridge.json'),
    JSON.stringify({ version: 2, pipe: PIPE, token: 'd'.repeat(32), pid: 11 }), 'utf8');
  const saved = process.env.DSHCS_EXTENSIONS_DIR;
  delete process.env.DSHCS_EXTENSIONS_DIR;
  try {
    const copied = require2(join(extDir, 'lib', 'bridge-client.js'));
    assert.equal(copied.defaultExtensionsDir(), siblingDir, '默认解析必须落在扩展所在的那一层');
    const config = copied.readBridgeConfig();
    assert.equal(config === null ? null : config.pipe, PIPE, '没有 env 时也应读到隔壁的配置');
  } finally {
    if (saved !== undefined) process.env.DSHCS_EXTENSIONS_DIR = saved;
    rmSync(tree, { recursive: true, force: true });
  }
});

await test('端点形状:Windows 必须是命名管道名,其它平台必须是绝对路径(两边同判定)', () => {
  assert.equal(bridgeClient.isBridgeEndpoint(PIPE), true);
  assert.equal(bridgeClient.isBridgeEndpoint('http://127.0.0.1:8123'), false, 'HTTP URL 不再是合法端点');
  assert.equal(bridgeClient.isBridgeEndpoint(''), false);
  assert.equal(bridgeClient.isBridgeEndpoint(null), false);
  // 配置里是 HTTP URL(0.3.12 及更早的 bridge.json)→ 必须判为未配置、休眠,而不是拿它发请求
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext-legacy-'));
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  writeFileSync(bridgeClient.bridgeFile(dir), JSON.stringify({ version: 1, url: 'http://127.0.0.1:8123', token: 'c'.repeat(32), pid: 5 }), 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '旧版 v1 配置(url)应视为未配置');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 编辑器右键菜单

await test('编辑器右键菜单:两个提问命令在**最上面**,并且带图标', () => {
  // 顺序规则(源码实证,VS Code 1.137 `workbench.web.main.internal.js` 的 `_compareMenuItems`):
  //   if (i === 'navigation') return -1;            // 只有 "navigation" 这一个组被特殊化到最前
  //   let c = i.localeCompare(n);                   // 其它组按组名比较 ⇒ 自造组名(如 dsh)被排到后面
  //   let r = e.order || 0, a = t.order || 0;       // 组内按 @order 升序
  // 菜单解析用 `Number(group.substr(i+1)) || void 0` ⇒ **负 order 合法**,于是 navigation@-2/-1
  // 稳定排在 VS Code 自己的 navigation@1(转到定义…)之前 = 右键菜单的第一、第二项。
  const ext = require2(`${EXT}/package.json`);
  const commands = new Map(ext.contributes.commands.map((command) => [command.command, command]));
  const selection = commands.get('dsh-code-server.askAboutSelection');
  const file = commands.get('dsh-code-server.askAboutFile');
  assert.ok(selection !== undefined && file !== undefined, '两个提问命令必须都注册');
  for (const [name, command] of [['选中内容', selection], ['当前文件', file]]) {
    assert.match(String(command.icon), /^\$\([a-z0-9-]+\)$/, `${name}命令必须带 codicon 图标(实际 ${command.icon})`);
  }
  const menu = ext.contributes.menus['editor/context'];
  assert.deepEqual(menu.map((item) => item.group), ['navigation@-2', 'navigation@-1'],
    '两条必须在 navigation 组里用负 order(否则会被 localeCompare 排到 1_modification 之后)');
  assert.equal(menu.find((item) => item.command === 'dsh-code-server.askAboutSelection').when, 'editorHasSelection',
    '「针对选中内容提问」只在有选区时出现');
  assert.equal(menu.find((item) => item.command === 'dsh-code-server.askAboutFile').when, undefined,
    '「针对当前文件提问」任何时候都该出现');
});

// ---------------------------------------------------------------- 事件抽取

await test('写操作抽取:meta.diffs 优先,参数路径兜底,view 不算改动', async () => {
  const { extractEditedPaths } = await import('../lib/bridge-observe.mjs');
  const p1 = `${WORKSPACE}\\a.ts`;
  const p2 = `${WORKSPACE}\\b.ts`;
  assert.deepEqual(
    extractEditedPaths('write', { file_path: p1 }, { meta: { diffs: [{ path: p1 }] } }),
    [p1],
    'meta 里的路径最准',
  );
  assert.deepEqual(
    extractEditedPaths('edit', { file_path: p2 }, { meta: undefined }),
    [p2],
    '没有 meta 时退回参数里的 file_path',
  );
  assert.deepEqual(
    extractEditedPaths('str_replace_editor', { command: 'view', path: p1 }, {}),
    [],
    'view 是只读,不该报成改动',
  );
  assert.deepEqual(
    extractEditedPaths('str_replace_editor', { command: 'str_replace', path: p1 }, {}),
    [p1],
    'str_replace_editor 没有 meta,必须靠参数',
  );
  assert.deepEqual(extractEditedPaths('read', { file_path: p1 }, {}), [], '只读工具不产生事件');
  assert.deepEqual(extractEditedPaths('write', { file_path: '' }, {}), []);
});

// ---------------------------------------------------------------- 投递(编辑器 → DSH)

await test('投递:提示文本带上 文件:行 与选区代码块', async () => {
  const { composeEditorPrompt } = await import('../lib/bridge-session.mjs');
  const text = composeEditorPrompt({
    text: '这里为什么报错?',
    file: `${WORKSPACE}\\a.ts`,
    lineStart: 3,
    lineEnd: 5,
    languageId: 'typescript',
    selection: 'const x = 1;',
  });
  assert.match(text, /From the editor: .*a\.ts:3-5/);
  assert.match(text, /```typescript/);
  assert.match(text, /const x = 1;/);
  assert.ok(text.endsWith('这里为什么报错?'), '用户原话应当在最后');
});

await test('投递:没有可用会话时返回 NO_AGENT 而不是抛异常', async () => {
  const { deliverEditorPrompt } = await import('../lib/bridge-session.mjs');
  const stubCtx = { get: () => undefined };
  const result = await deliverEditorPrompt(stubCtx, { text: 'hi', file: null, lineStart: null, lineEnd: null, selection: null, languageId: null });
  assert.equal(result.ok, false);
  // DSH 部署存在时应是 NO_AGENT;部署缺 dsh-llm 时是 NO_LLM —— 两者都算"优雅降级"
  assert.ok(result.code === 'NO_AGENT' || result.code === 'NO_LLM', `实际 code=${result.code}`);
  assert.ok(typeof result.error === 'string' && result.error !== '', '必须给出可读原因');
});

await test('投递:选中的 agent 收到 followup 消息', async () => {
  const { deliverEditorPrompt } = await import('../lib/bridge-session.mjs');
  const sent = [];
  const agent = {
    id: 'session-x',
    status: 'running',
    session: { id: 'session-x' },
    followup(message) { sent.push(message); },
  };
  const stubCtx = {
    get: (name) => (name === 'agents' ? { list: () => [agent], currentInitiator: () => undefined } : undefined),
  };
  const result = await deliverEditorPrompt(stubCtx, {
    text: '看看这段',
    file: `${WORKSPACE}\\a.ts`,
    lineStart: 1,
    lineEnd: 2,
    selection: 'let a = 1;',
    languageId: 'typescript',
  });
  if (result.code === 'NO_LLM') {
    console.log('     (本机没有 @deepseek-ai/dsh-llm,跳过投递断言)');
    return;
  }
  assert.equal(result.ok, true, `应投递成功(实际 ${JSON.stringify(result)})`);
  assert.equal(sent.length, 1, 'followup 应恰好调用一次');
  assert.equal(sent[0].role, 'user');
  assert.equal(sent[0].source.kind, 'plugin');
  assert.equal(sent[0].source.plugin, 'dsh-code-server-app:editor-bridge');
  assert.match(sent[0].content[0].text, /看看这段/);
});

console.log(`SUMMARY pass=${pass} fail=${fail}${skip > 0 ? ` skip=${skip}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
