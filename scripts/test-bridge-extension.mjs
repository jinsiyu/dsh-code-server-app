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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const EXT = '../assets/extensions/dshcs-editor-bridge';

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

const contextModel = require2(`${EXT}/lib/context-model.js`);
const diffModel = require2(`${EXT}/lib/diff-model.js`);
const bridgeClient = require2(`${EXT}/lib/bridge-client.js`);

const WORKSPACE = process.platform === 'win32' ? 'C:\\repo' : '/repo';
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

await test('桥配置:只接受本机回环 URL 与合法令牌(坏配置 = 休眠)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext-'));
  const file = bridgeClient.bridgeFile(dir);
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '缺文件 = 休眠');
  writeFileSync(file, 'not json', 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '坏 JSON = 休眠');
  writeFileSync(file, JSON.stringify({ url: 'http://10.0.0.5:8090', token: 'a'.repeat(32) }), 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '非回环地址必须拒绝');
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:8090', token: 'short' }), 'utf8');
  assert.equal(bridgeClient.readBridgeConfig(dir), null, '令牌长度不足必须拒绝');
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:8090', token: 'a'.repeat(32), pid: 7 }), 'utf8');
  const good = bridgeClient.readBridgeConfig(dir);
  assert.equal(good.url, 'http://127.0.0.1:8090');
  assert.equal(good.pid, 7);
  rmSync(dir, { recursive: true, force: true });
});

await test('客户端:休眠时 sync 不抛,也不发请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext2-'));
  let calls = 0;
  const client = bridgeClient.createClient({
    extensionsDir: dir,
    fetchImpl: () => { calls += 1; throw new Error('不该被调用'); },
  });
  assert.equal(client.isDormant(), true);
  const result = await client.sync({ context: {}, diagnostics: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'dormant');
  assert.equal(calls, 0, '休眠时一个请求都不该发出去');
  rmSync(dir, { recursive: true, force: true });
});

await test('客户端:sync 带令牌头、一趟取回事件并推进游标', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-ext3-'));
  mkdirSync(join(dir, bridgeClient.BRIDGE_DIRNAME), { recursive: true });
  writeFileSync(bridgeClient.bridgeFile(dir), JSON.stringify({ url: 'http://127.0.0.1:8090', token: 'a'.repeat(32), pid: 7 }), 'utf8');
  const seen = [];
  const client = bridgeClient.createClient({
    extensionsDir: dir,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, events: [{ seq: 3, kind: 'agent-edit', path: `${WORKSPACE}\\a.ts` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const payload = { context: { dirtyBuffers: [] }, diagnostics: [] };
  const result = await client.sync(payload);
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
  assert.equal(client.cursor, 3, '游标必须前进');
  assert.equal(seen[0].headers[bridgeClient.TOKEN_HEADER], 'a'.repeat(32), '必须带令牌头');
  assert.deepEqual(seen[0].body, payload, '上报体必须是投影结果');
  assert.match(seen[0].url, /\/code-server-bridge\/sync\?since=0$/, '第一次应该从 since=0 开始(且路径是 0.3.9 起的挂载前缀)');
  // 第二次:游标应带上
  await client.sync(payload);
  assert.match(seen[1].url, /since=3$/, '第二次必须带上次的游标');
  rmSync(dir, { recursive: true, force: true });
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

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
