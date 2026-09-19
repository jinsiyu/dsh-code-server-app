// scripts/test-edit-snapshot.mjs —— 写前原文快照的回归(0.3.55)
//
// 背景:用户实测"diff 左侧空、右侧全文"。根因是 old 侧只有两条来源(编辑器缓冲区 / 扩展自己的
// 缓存),文件没在编辑器里打开时两条都落空 —— 而"写之前文件长什么样"只有 host 知道。现在从
// `tools/post-execute` 的 `result.value` 里取(durable 投影**故意**剥掉了 value,所以不能在
// `tools/result` 里取),存进有界缓存,事件只带不透明 key。
//
// 守四件事:
//   S1 **取值正确**:write/edit 的 value → 完整写前原文;create 与"工具没给文本"必须区分开
//      (前者左栏本来就该空,后者要如实说"拿不到",不能假装文件原来是空的)。
//   S2 **路径绝对化**:`value.path` 是 displayPath、`meta.diffs[].path` 更是原样的调用参数,
//      都可能是相对路径。交给编辑器前必须按**会话 cwd** 展开(否则判"工作区外"丢掉 / 匹配到别的文件)。
//   S3 **绝不抛**:`tools/post-execute` 的监听器抛错会把成功的调用变成 isError(DSH 源码注释),
//      所以每个函数对垃圾输入都只能返回 null。
//   S4 **缓存有界**:条数、字节、存活时长三重上限;key 是不透明随机串(不是路径)。
//
// 用法:node scripts/test-edit-snapshot.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';

const {
  MAX_SNAPSHOT_BYTES,
  absolutePath,
  createSnapshotStore,
  extractEditSnapshot,
  sessionCwdOf,
  snapshotResponse,
} = await import('../lib/edit-snapshot.mjs');
const { registerBridgeObserver } = await import('../lib/bridge-observe.mjs');

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

/** 会话 cwd 的形状与 DSH 一致:`exec.agent.session.header.cwd`。 */
const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const SEP = process.platform === 'win32' ? '\\' : '/';
const exec = (cwd = CWD) => ({ name: 'write', arguments: {}, agent: { session: { header: { cwd } } } });
const ABS = (...parts) => join(CWD, ...parts);

await test('会话 cwd:只在 DSH 那个形状上取值,缺一层就是 null(不许猜)', () => {
  assert.equal(sessionCwdOf(exec()), CWD);
  assert.equal(sessionCwdOf({ agent: { session: { header: { cwd: '' } } } }), null, '空串等于没有');
  assert.equal(sessionCwdOf({ agent: { session: {} } }), null);
  assert.equal(sessionCwdOf({ agent: {} }), null);
  assert.equal(sessionCwdOf({}), null);
  assert.equal(sessionCwdOf(null), null);
  assert.equal(sessionCwdOf(undefined), null);
});

await test('路径绝对化:绝对路径归一化,相对路径按会话 cwd 展开,没有 cwd 就原样返回', () => {
  assert.equal(absolutePath(ABS('src', 'a.ts'), CWD), ABS('src', 'a.ts'));
  assert.equal(absolutePath(`src${SEP}a.ts`, CWD), ABS('src', 'a.ts'), '相对路径必须按会话 cwd 展开');
  assert.equal(absolutePath(`${CWD}${SEP}src${SEP}..${SEP}a.ts`, CWD), ABS('a.ts'), '归一化要吃掉 ..');
  assert.equal(absolutePath(`src${SEP}a.ts`, null), `src${SEP}a.ts`, '没有 cwd 时保持原样(宁可不显示,也不要打开错的文件)');
  assert.equal(absolutePath('', CWD), null);
  assert.equal(absolutePath(null, CWD), null);
  assert.equal(absolutePath(42, CWD), null);
  assert.equal(absolutePath(Symbol('x'), CWD), null, '符号之类也要安全返回,不抛');
});

await test('write:value 给出完整写前/写后 → oldSide=snapshot', () => {
  const before = 'line1\nline2\n';
  const info = extractEditSnapshot('write', { file_path: ABS('a.txt') }, {
    isError: false,
    value: { path: ABS('a.txt'), operation: 'update', before, after: 'line1\nCHANGED\n' },
  }, exec());
  assert.equal(info.oldSide, 'snapshot');
  assert.equal(info.beforeText, before, '必须是**完整**原文(meta.diffs 里只有 3 行上下文的 hunk)');
  assert.equal(info.operation, 'update');
  assert.equal(info.path, ABS('a.txt'));
  assert.equal(info.bytes, Buffer.byteLength(before, 'utf8'));
});

await test('write 新建:before=null 与 operation=create 都判为 create(左栏本来就该空)', () => {
  const viaOperation = extractEditSnapshot('write', { file_path: ABS('new.txt') }, {
    value: { path: ABS('new.txt'), operation: 'create', before: null, after: 'x\n' },
  }, exec());
  assert.equal(viaOperation.oldSide, 'create');
  assert.equal(viaOperation.operation, 'create');
  assert.equal(viaOperation.beforeText, null);
  const viaNull = extractEditSnapshot('write', { file_path: ABS('new2.txt') }, {
    value: { path: ABS('new2.txt'), before: null, after: 'x\n' },
  }, exec());
  assert.equal(viaNull.oldSide, 'create', 'before=null 只可能是新建(fs 层写前必读)');
  assert.equal(viaNull.operation, 'create', '没给 operation 时按 create 记录,免得下游显示"拿不到"');
});

await test('edit:value 是整份文件文本(不是 hunk)', () => {
  const info = extractEditSnapshot('edit', { file_path: ABS('a.ts') }, {
    value: { path: ABS('a.ts'), before: 'const a = 1;\nconst b = 2;\n', after: 'const a = 1;\nconst b = 3;\n' },
  }, exec());
  assert.equal(info.oldSide, 'snapshot');
  assert.match(info.beforeText, /const a = 1;/);
  assert.equal(info.operation, null, 'edit 的 value 里没有 operation');
});

await test('路径来源:value.path 优先(displayPath),否则退回参数,并一律绝对化', () => {
  const relative = extractEditSnapshot('write', { file_path: `src${SEP}a.ts` }, {
    value: { path: `src${SEP}a.ts`, operation: 'update', before: 'x', after: 'y' },
  }, exec());
  assert.equal(relative.path, ABS('src', 'a.ts'), '相对路径必须按会话 cwd 展开(否则编辑器判"工作区外"丢掉)');
  const fromArgs = extractEditSnapshot('str_replace_editor', { command: 'str_replace', path: `src${SEP}b.ts` }, {}, exec());
  assert.equal(fromArgs.path, ABS('src', 'b.ts'), '工具没给 value 时退回参数里的路径');
  assert.equal(fromArgs.oldSide, 'unavailable', '拿不到文本要如实说,而不是假装原来是空的');
  const noCwd = extractEditSnapshot('write', { file_path: `src${SEP}c.ts` }, { value: { before: 'x' } }, { agent: undefined });
  assert.equal(noCwd.path, `src${SEP}c.ts`, '没有会话 cwd 时不展开(不许拿进程 cwd 顶替)');
  const noPath = extractEditSnapshot('write', {}, { value: { before: 'x', after: 'y' } }, exec());
  assert.equal(noPath, null, '连路径都没有 → 不产生快照');
});

await test('不该产生快照的调用:只读工具 / view / 失败的结果 / 空工具名', () => {
  const value = { path: ABS('a.ts'), operation: 'update', before: 'x', after: 'y' };
  assert.equal(extractEditSnapshot('read', { file_path: ABS('a.ts') }, { value }, exec()), null, '只读工具');
  assert.equal(extractEditSnapshot('str_replace_editor', { command: 'view', path: ABS('a.ts') }, { value }, exec()), null, 'view 不改文件');
  assert.equal(extractEditSnapshot('write', { file_path: ABS('a.ts') }, { isError: true, value }, exec()), null, '失败的写没有落点');
  assert.equal(extractEditSnapshot('write', { file_path: ABS('a.ts') }, null, exec()), null);
  assert.equal(extractEditSnapshot('', {}, { value }, exec()), null);
});

await test('超大文件:超过上限就不存文本,只报 too-large(扩展据此说明原因)', () => {
  const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
  const info = extractEditSnapshot('write', { file_path: ABS('big.txt') }, {
    value: { path: ABS('big.txt'), operation: 'update', before: huge, after: 'y' },
  }, exec());
  assert.equal(info.oldSide, 'too-large');
  assert.equal(info.beforeText, null, '不能把整份大文件塞进事件/响应');
  assert.ok(info.bytes > MAX_SNAPSHOT_BYTES);
  const atLimit = extractEditSnapshot('write', { file_path: ABS('edge.txt') }, {
    value: { path: ABS('edge.txt'), operation: 'update', before: 'x'.repeat(MAX_SNAPSHOT_BYTES), after: 'y' },
  }, exec());
  assert.equal(atLimit.oldSide, 'snapshot', '正好等于上限要收(边界取闭区间)');
});

await test('垃圾输入一律返回 null,绝不抛(post-execute 里抛错会把成功的调用变成 isError)', () => {
  for (const result of [undefined, null, 0, '', 'write', [], { value: null }, { value: 5 }, { value: { path: 7 } }]) {
    assert.doesNotThrow(() => extractEditSnapshot('write', { file_path: ABS('a.ts') }, result, exec()));
  }
  assert.doesNotThrow(() => extractEditSnapshot('write', null, { value: null }, exec()));
  assert.doesNotThrow(() => extractEditSnapshot('write', { file_path: ABS('a.ts') }, { value: null }, { agent: 'nope' }));
  assert.doesNotThrow(() => extractEditSnapshot('write', { file_path: ABS('a.ts') }, { value: { before: 5 } }, exec()));
});

await test('快照缓存:不透明 key、可重复取、clear 清空', () => {
  const store = createSnapshotStore();
  const key = store.put(ABS('a.ts'), 'hello');
  assert.equal(typeof key, 'string');
  assert.ok(key.length >= 8);
  assert.equal(key.includes('a.ts'), false, 'key 不能带路径(令牌泄露时也读不到"是哪个文件")');
  const got = store.get(key);
  assert.equal(got.path, ABS('a.ts'));
  assert.equal(got.text, 'hello');
  assert.equal(store.get(key).text, 'hello', '重复取必须拿到同一份(扩展可能重复轮询)');
  assert.equal(store.get('nope'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(null), null);
  assert.equal(store.put('', 'x'), null);
  assert.equal(store.put(ABS('a.ts'), null), null);
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.get(key), null);
});

await test('快照缓存有界:条数上限丢最旧', () => {
  const store = createSnapshotStore({ maxEntries: 2, budgetBytes: 1024 * 1024 });
  const k1 = store.put(ABS('a.ts'), 'a');
  const k2 = store.put(ABS('b.ts'), 'b');
  const k3 = store.put(ABS('c.ts'), 'c');
  assert.equal(store.size(), 2, '条数封顶');
  assert.equal(store.get(k1), null, '最旧的被淘汰');
  assert.equal(store.get(k2).text, 'b');
  assert.equal(store.get(k3).text, 'c');
});

await test('快照缓存有界:字节预算按 UTF-8 算,超预算丢最旧', () => {
  const perEntry = createSnapshotStore({ maxEntries: 8, budgetBytes: 1024, maxBytes: 10 });
  assert.equal(perEntry.put(ABS('x.txt'), 'x'.repeat(20)), null, '超过单份上限就不存');
  assert.equal(perEntry.put(ABS('cn.txt'), '汉汉字字'), null, '4 个汉字 = 12 字节 > 10 ⇒ 不存(按字节,不是字符)');
  assert.equal(typeof perEntry.put(ABS('ok.txt'), 'abcd'), 'string');

  const tight = createSnapshotStore({ maxEntries: 8, budgetBytes: 6, maxBytes: 64 });
  const first = tight.put(ABS('a.txt'), 'abcd'); // 4 字节
  assert.equal(tight.bytes(), 4);
  const second = tight.put(ABS('b.txt'), 'efgh'); // 再 4 字节 → 总量 8 > 6
  assert.equal(tight.bytes(), 4, `总量不许超预算(实际 ${tight.bytes()})`);
  assert.equal(tight.size(), 1, '超预算要丢最旧的');
  assert.equal(tight.get(first), null);
  assert.equal(tight.get(second).text, 'efgh');
  assert.equal(tight.put(ABS('huge.txt'), 'x'.repeat(65)), null, '单份超上限直接拒');
});

await test('快照缓存有界:过期即丢(扩展没在跑时不长期占内存)', () => {
  let now = 1000;
  const store = createSnapshotStore({ ttlMs: 50, now: () => now });
  const key = store.put(ABS('a.ts'), 'hello');
  assert.equal(store.get(key).text, 'hello');
  now += 51;
  assert.equal(store.get(key), null, '过期后取不到');
  assert.equal(store.size(), 0);
});

await test('/old 的响应语义:缺 key 400 / 取不到 404 / 取到 200 且不消费', () => {
  const store = createSnapshotStore();
  const key = store.put(ABS('a.ts'), 'BEFORE');
  assert.deepEqual(snapshotResponse(store, ''), { status: 400, body: { ok: false, error: '需要 key 参数' } });
  assert.deepEqual(snapshotResponse(store, null), { status: 400, body: { ok: false, error: '需要 key 参数' } });
  assert.deepEqual(snapshotResponse(store, 'nope'), { status: 404, body: { ok: false, error: '快照已失效' } });
  assert.deepEqual(snapshotResponse(null, 'nope'), { status: 404, body: { ok: false, error: '快照已失效' } }, '缓存缺失也不能抛');
  const first = snapshotResponse(store, key);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, path: ABS('a.ts'), text: 'BEFORE', bytes: 6 });
  assert.deepEqual(snapshotResponse(store, key).body, first.body, '重复取必须拿到同一份(扩展可能重复轮询)');
  assert.equal(store.size(), 1, '读取不消费');
});

/** 造一个只收集 handler 的桩 ctx(与注册表实现无关,只验我们注册了什么)。 */
function makeObserverCtx() {
  const handlers = new Map();
  return {
    handlers,
    ctx: { on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } },
  };
}

await test('观察器集成:post-execute 记快照 → tools/result 的事件带 oldKey → 用 key 取回完整原文', async () => {
  // 端到端那条链路的替身:两个观察点的时间顺序、字段名、以及"扩展拿 key 换文本"都要真的成立。
  const { handlers, ctx } = makeObserverCtx();
  const emitted = [];
  const snapshots = createSnapshotStore();
  const dispose = registerBridgeObserver(ctx, {
    emit: (kind, fields) => emitted.push({ kind, ...fields }),
    context: () => null,
    isLive: () => false,
    snapshots,
  });
  assert.equal(typeof handlers.get('tools/post-execute'), 'function', '必须注册 tools/post-execute(value 只在这里可见)');
  assert.equal(typeof handlers.get('tools/result'), 'function');
  assert.equal(typeof handlers.get('tools/pre-execute'), 'function', '旧的脏缓冲区提醒不能被挤掉');

  const before = 'const a = 1;\nconst b = 2;\n';
  const after = 'const a = 1;\nconst b = 3;\n';
  const call = {
    name: 'edit',
    arguments: { file_path: `src${SEP}target.ts` },
    agent: { id: 'agent-1', session: { id: 'session-1', header: { cwd: CWD } } },
  };
  const result = { isError: false, value: { path: `src${SEP}target.ts`, before, after } };
  let nextCalls = 0;
  const decision = await handlers.get('tools/post-execute')(call, result, async () => { nextCalls += 1; return { kind: 'accept' }; });
  assert.deepEqual(decision, { kind: 'accept' }, '决策必须原样返回(改它会改掉调用结果)');
  assert.equal(nextCalls, 1);

  handlers.get('tools/result')(call, result);
  assert.equal(emitted.length, 1, '一次写只推一条事件');
  const event = emitted[0];
  assert.equal(event.kind, 'agent-edit');
  assert.equal(event.path, ABS('src', 'target.ts'), '事件里的路径必须已绝对化');
  assert.equal(event.sessionId, 'session-1');
  assert.equal(event.tool, 'edit');
  assert.equal(event.oldSide, 'snapshot');
  assert.equal(typeof event.oldKey, 'string');
  assert.equal(snapshots.get(event.oldKey).text, before, '用事件里的 key 必须取回**完整**写前原文');
  assert.equal(JSON.stringify(event).includes('const a'), false, '事件里不许带正文(/sync 响应驮不动)');

  // 消费语义:同一次调用的快照只配给紧随其后的那一次事件 —— 去抖窗口里被丢掉的那条
  // 也把自己的快照一起丢掉,免得错配给下一次改动。
  const second = { isError: false, value: { path: `src${SEP}target.ts`, before: 'STALE', after: 'newer' } };
  await handlers.get('tools/post-execute')(call, second, async () => ({ kind: 'accept' }));
  handlers.get('tools/result')(call, second);
  assert.equal(emitted.length, 1, '1500ms 去抖窗口内的第二次不该再推事件');
  assert.equal(snapshots.size(), 1, '被去抖丢掉的那次不能留下快照(否则会错配)');

  // 另一个文件正常推,且各拿各的快照
  const other = {
    name: 'write',
    arguments: { file_path: `other${SEP}b.ts` },
    agent: { session: { id: 'session-1', header: { cwd: CWD } } },
  };
  const otherResult = { isError: false, value: { path: `other${SEP}b.ts`, operation: 'update', before: 'OLD-B', after: 'NEW-B' } };
  await handlers.get('tools/post-execute')(other, otherResult, async () => ({ kind: 'accept' }));
  handlers.get('tools/result')(other, otherResult);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].operation, 'update');
  assert.equal(snapshots.get(emitted[1].oldKey).text, 'OLD-B');

  dispose();
  assert.equal(handlers.size, 0, 'disposer 要把注册收干净');
});

await test('观察器集成:被拦下的调用不记快照;工具没给 value 时不带 oldKey(退回旧行为)', async () => {
  const { handlers, ctx } = makeObserverCtx();
  const emitted = [];
  const snapshots = createSnapshotStore();
  registerBridgeObserver(ctx, { emit: (kind, fields) => emitted.push({ kind, ...fields }), context: () => null, isLive: () => false, snapshots });
  const post = handlers.get('tools/post-execute');
  const call = { name: 'write', arguments: { file_path: ABS('a.txt') }, agent: { session: { header: { cwd: CWD } } } };

  await post(call, { isError: false, value: { path: ABS('a.txt'), operation: 'update', before: 'x', after: 'y' } },
    async () => ({ kind: 'block', feedback: '不行' }));
  handlers.get('tools/result')(call, { isError: false, meta: { diffs: [{ path: ABS('a.txt') }] } });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].oldKey, undefined, '被拦下的调用不该留下快照');
  assert.equal(snapshots.size(), 0, '被拦下 ⇒ 缓存里什么都不留');

  // 工具没给 value(str_replace_editor 这类 output 是字符串的工具):仍然推事件,但没有 oldKey
  const call2 = { name: 'str_replace_editor', arguments: { command: 'str_replace', path: ABS('b.txt') }, agent: { session: { header: { cwd: CWD } } } };
  await post(call2, { isError: false }, async () => ({ kind: 'accept' }));
  handlers.get('tools/result')(call2, { isError: false });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].oldKey, undefined);
  assert.equal(emitted[1].oldSide, 'unavailable', '如实报告"工具没给文本"');

  // post-execute 的监听器**绝不抛**(抛了会把成功的调用变成 isError)
  await assert.doesNotReject(async () => {
    await post(null, null, async () => ({ kind: 'accept' }));
    await post({ name: 'write', arguments: null }, { isError: false, value: { path: 7 } }, async () => ({ kind: 'accept' }));
    await post(call, { isError: false, value: { path: ABS('a.txt'), before: 5, after: 6 } }, async () => ({ kind: 'accept' }));
    await post(call, null, async () => ({ kind: 'accept' }));
  });
  // next() 抛错时必须原样传出(那是工具自己的失败,不能被我们吞掉)
  await assert.rejects(async () => {
    await post(call, { isError: true }, async () => { throw new Error('工具炸了'); });
  }, /工具炸了/);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
