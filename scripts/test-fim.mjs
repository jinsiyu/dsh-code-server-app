// scripts/test-fim.mjs —— 实验性 FIM(幽灵)补全的回归(宿主侧纯逻辑 + 适配器流 + 扩展侧纯逻辑)
//
// 这个功能有三处**容易在改动中静默退化**的地方,本文件把它们钉死:
//   1. **互斥计量**:DSH 的 TokenUsage 里 `inputTokens` 只算未缓存输入,而 DeepSeek 的
//      `prompt_tokens` 含缓存命中 —— 写错的表现是"数字虚高、缓存收益看不见",界面上看不出来;
//   2. **信封**:prefix/suffix 是塞在 messages 里的自造约定(方案 A 的唯一"丑"),解不出信封必须
//      **报错而不是静默降级**成一次普通对话;
//   3. **两侧常量一致**:扩展是随包分发的静态文件、不能 import 宿主代码,窗口上限只能靠这条断言对齐。
//
// 用法:node scripts/test-fim.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const require = createRequire(import.meta.url);

const host = await import(pathToFileURL(join(pkgRoot, 'lib', 'fim-adapter.mjs')).href);
const ext = require(join(pkgRoot, 'assets', 'extensions', 'dshcs-editor-bridge', 'lib', 'fim-completion.js'));

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

/** 造一个假 fetch:记录请求,按预置队列回响应(队列只剩一个时反复用它)。 */
function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responses.length > 1 ? responses.shift() : responses[0];
  };
  impl.calls = calls;
  return impl;
}

const okResponse = (text, usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ text, finish_reason: 'stop' }], usage }),
});

const errorResponse = (status, body = '{}') => ({ ok: false, status, text: async () => body });

// ---------------------------------------------------------------- 信封

await test('信封:encode → decode 往返;可选字段缺省不写进 JSON', () => {
  const encoded = host.encodeFimRequest({ prompt: 'a\n', suffix: 'b', language: 'ts', path: '/x/a.ts' });
  assert.equal(encoded.startsWith(host.FIM_ENVELOPE_PREFIX), true);
  assert.deepEqual(host.decodeFimRequest(encoded), { prompt: 'a\n', suffix: 'b', language: 'ts', path: '/x/a.ts' });
  const bare = host.encodeFimRequest({ prompt: 'a', suffix: 'b' });
  assert.equal(bare.includes('language'), false, '未提供的可选字段不得出现在载荷里');
  assert.deepEqual(host.decodeFimRequest(bare), { prompt: 'a', suffix: 'b', language: '', path: '' });
});

await test('信封:非信封 / 坏 JSON / 字段类型不对 一律 null(不静默降级成普通对话)', () => {
  assert.equal(host.decodeFimRequest('你好'), null);
  assert.equal(host.decodeFimRequest(`${host.FIM_ENVELOPE_PREFIX}{bad`), null);
  assert.equal(host.decodeFimRequest(`${host.FIM_ENVELOPE_PREFIX}{"prompt":1,"suffix":"b"}`), null);
  assert.equal(host.decodeFimRequest(`${host.FIM_ENVELOPE_PREFIX}{"prompt":"a"}`), null);
  assert.equal(host.decodeFimRequest(null), null);
});

await test('信封:能从 messages 的 text 块里找出来;普通对话找不到', () => {
  const text = host.encodeFimRequest({ prompt: 'p', suffix: 's' });
  const messages = [{ role: 'user', content: [{ type: 'text', text: '普通提问' }, { type: 'text', text }] }];
  assert.deepEqual(host.extractFimEnvelope(messages), { prompt: 'p', suffix: 's', language: '', path: '' });
  assert.equal(host.extractFimEnvelope([{ role: 'user', content: [{ type: 'text', text: '普通提问' }] }]), null);
  assert.equal(host.extractFimEnvelope(null), null);
});

// ---------------------------------------------------------------- 窗口 / 清洗 / 计量

await test('窗口:字符与行数取先到者;fromEnd 决定保留哪一端', () => {
  const lines = ['l1', 'l2', 'l3', 'l4'].join('\n');
  assert.equal(host.trimWindow(lines, { maxChars: 0, maxLines: 2, fromEnd: true }), 'l3\nl4');
  assert.equal(host.trimWindow(lines, { maxChars: 0, maxLines: 2, fromEnd: false }), 'l1\nl2');
  assert.equal(host.trimWindow('abcdef', { maxChars: 3, maxLines: 0, fromEnd: true }), 'def');
  assert.equal(host.trimWindow('abcdef', { maxChars: 3, maxLines: 0, fromEnd: false }), 'abc');
  assert.equal(host.trimWindow('', { maxChars: 10, maxLines: 10, fromEnd: true }), '');
});

await test('清洗:剥代码围栏、剥控制标记、CRLF 归一、按上限截断', () => {
  assert.equal(host.cleanFimCompletion('```typescript\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(host.cleanFimCompletion('const a = 1;\n```'), 'const a = 1;');
  assert.equal(host.cleanFimCompletion('x = 1;'), 'x = 1;');
  const withControl = `a${'<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>'}b`;
  assert.equal(host.cleanFimCompletion(withControl), 'ab', '控制标记必须被剥掉');
  assert.equal(host.cleanFimCompletion('a\r\nb'), 'a\nb', 'CRLF 归一');
  const long = 'x'.repeat(host.FIM_MAX_OUTPUT_CHARS + 100);
  assert.equal(host.cleanFimCompletion(long).length, host.FIM_MAX_OUTPUT_CHARS);
});

await test('计量:prompt_tokens 含缓存 ⇒ 必须减出去(互斥口径)', () => {
  assert.deepEqual(
    host.mapFimUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 60 }),
    { inputTokens: 40, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 0, totalTokens: 110 },
  );
  const noCache = host.mapFimUsage({ prompt_tokens: 5, completion_tokens: 1 });
  assert.equal(noCache.inputTokens, 5);
  assert.equal(noCache.cacheReadTokens, 0);
  assert.equal(noCache.totalTokens, 6, '总数不自洽时按 prompt + completion 算');
  const bogus = host.mapFimUsage({ prompt_tokens: 5, prompt_cache_hit_tokens: 99 });
  assert.equal(bogus.cacheReadTokens, 5, '缓存命中不得超过 prompt');
  assert.equal(bogus.inputTokens, 0, '不得为负');
});

// ---------------------------------------------------------------- 计数 / 闸门

await test('计数:成功累计用量、失败只记错误码;快照是脱离的副本', () => {
  const stats = host.createFimStats();
  stats.recordOk({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, totalTokens: 14 }, 123);
  stats.recordFailure('TRANSPORT', 900);
  const snap = stats.snapshot();
  assert.equal(snap.calls, 2);
  assert.equal(snap.ok, 1);
  assert.equal(snap.failed, 1);
  assert.equal(snap.inputTokens, 10, '失败不得污染用量');
  assert.equal(snap.outputTokens, 4);
  assert.equal(snap.cacheReadTokens, 6);
  assert.equal(snap.totalTokens, 14);
  assert.equal(snap.lastError, 'TRANSPORT');
  assert.equal(snap.lastMs, 900, '最近一次耗时按最后一次调用算');
  snap.inputTokens = 999;
  assert.equal(stats.snapshot().inputTokens, 10, '快照必须是副本(状态栏/设置卡都能安全读)');
});

await test('闸门:最小间隔 → too-fast;并发 → busy;频率上限 → rate-limited', () => {
  let t = 1000;
  const budget = host.createFimBudget({ minIntervalMs: 120, maxInflight: 1, callsPerMinute: 2, now: () => t });
  assert.equal(budget.acquire(), 'ok');
  assert.equal(budget.acquire(), 'busy', '上一个还没放行 ⇒ 并发拒绝(先于间隔判定)');
  budget.release();
  assert.equal(budget.acquire(), 'too-fast', '同一时刻的第二次 ⇒ 太快');
  t += 200;
  assert.equal(budget.acquire(), 'ok');
  budget.release();
  t += 200;
  assert.equal(budget.acquire(), 'rate-limited', '一分钟内第三次 ⇒ 超频');
  assert.equal(budget.snapshot().inflight, 0);
});

// ---------------------------------------------------------------- 取数(线上)

await test('取数:成功路径清洗文本、映射用量,并带上 attribution 头', async () => {
  const fetchImpl = stubFetch([okResponse('  const a = 1;\n```', {
    prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_cache_hit_tokens: 90,
  })]);
  const result = await host.callFimWire({
    fetchImpl, apiKey: 'k', payload: { prompt: 'p', suffix: 's' }, headers: { 'x-attribution': 'dsh' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '  const a = 1;', '围栏被剥掉,行首缩进必须保留');
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.cacheReadTokens, 90);
  assert.equal(result.finish, 'stop');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${host.FIM_BASE_URL}/completions`);
  assert.equal(call.init.headers.authorization, 'Bearer k');
  assert.equal(call.init.headers['x-attribution'], 'dsh', 'attribution 头必须透传(适配器契约)');
  const body = JSON.parse(call.init.body);
  assert.equal(body.prompt, 'p');
  assert.equal(body.suffix, 's');
  assert.equal(body.stream, false, '必须非流式(实测非流式反而更快)');
  assert.equal(body.temperature, 0);
  assert.equal(body.stop, undefined, '不得设 stop:会腰斩合法的多行补全');
});

await test('取数:HTTP 错误映射成稳定错误码(AUTH / PROVIDER / INVALID_REQUEST)', async () => {
  const auth = await host.callFimWire({ fetchImpl: stubFetch([errorResponse(401, '{"error":"bad key"}')]), apiKey: 'k', payload: { prompt: 'p', suffix: '' } });
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 'AUTH');
  assert.equal(auth.status, 401);
  const provider = await host.callFimWire({ fetchImpl: stubFetch([errorResponse(500)]), apiKey: 'k', payload: { prompt: 'p', suffix: '' } });
  assert.equal(provider.code, 'PROVIDER');
  const bad = await host.callFimWire({ fetchImpl: stubFetch([errorResponse(400)]), apiKey: 'k', payload: { prompt: 'p', suffix: '' } });
  assert.equal(bad.code, 'INVALID_REQUEST');
});

await test('取数:调用方取消 ⇒ ABORTED;响应缺 choices ⇒ PROVIDER(都不得抛)', async () => {
  const aborted = await host.callFimWire({
    fetchImpl: async () => { throw new Error('network down'); },
    apiKey: 'k', payload: { prompt: 'p', suffix: '' }, signal: AbortSignal.abort(),
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.code, 'ABORTED');
  const weird = await host.callFimWire({
    fetchImpl: stubFetch([{ ok: true, status: 200, json: async () => ({ usage: {} }) }]),
    apiKey: 'k', payload: { prompt: 'p', suffix: '' },
  });
  assert.equal(weird.ok, false);
  assert.equal(weird.code, 'PROVIDER');
});

// ---------------------------------------------------------------- 适配器(方案 A 的核心)

class FakeBase {}

const makeAdapter = (deps) => new (host.createFimAdapterClass(FakeBase, deps))();

const envelopeOptions = (payload, overrides = {}) => ({
  provider: host.FIM_PROVIDER,
  model: host.FIM_MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: host.encodeFimRequest(payload) }] }],
  ...overrides,
});

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

await test('适配器:providerInfo / listModels / resolveModel 满足契约(id 必须等于路由名)', async () => {
  const adapter = makeAdapter({ resolveApiKey: async () => 'k', fetchImpl: stubFetch([okResponse('x')]) });
  assert.deepEqual(adapter.providerInfo(host.FIM_PROVIDER), { id: host.FIM_PROVIDER, name: 'DSH FIM(实验性)' });
  const models = await adapter.listModels(host.FIM_PROVIDER);
  assert.equal(models[0].provider, host.FIM_PROVIDER, 'LlmModelInfo 必须带 provider');
  assert.equal(models[0].id, host.FIM_MODEL);
  const resolved = await adapter.resolveModel(host.FIM_PROVIDER, host.FIM_MODEL);
  assert.equal(resolved.provider, host.FIM_PROVIDER);
  assert.equal(resolved.defaultMaxTokens, host.FIM_MAX_TOKENS);
  assert.ok(resolved.context.contextWindow > 0, '要声明上下文窗口,否则计量与截断策略会失真');
});

await test('适配器:正常流的 chunk 顺序与用量(block-start → text-delta → usage → block-end → finish)', async () => {
  const fetchImpl = stubFetch([okResponse('const a = 1;', {
    prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 12,
  })]);
  const adapter = makeAdapter({
    resolveApiKey: async () => 'k', fetchImpl, attributionHeaders: () => ({ 'x-a': '1' }),
  });
  const chunks = await collect(adapter.stream(envelopeOptions({ prompt: 'p', suffix: 's' })));
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'usage', 'block-end', 'finish']);
  assert.equal(chunks[0].blockType, 'text');
  assert.equal(chunks[1].text, 'const a = 1;');
  assert.equal(chunks[2].usage.inputTokens, 8, '互斥口径:20 − 12');
  assert.equal(chunks[3].block.text, 'const a = 1;');
  assert.equal(chunks[4].reason.kind, 'stop');
  assert.equal(fetchImpl.calls[0].init.headers['x-a'], '1', 'attribution 头必须真的上到线上请求');
});

await test('适配器:前后缀超窗时按窗口裁掉(从**靠光标**的一端保留)', async () => {
  const fetchImpl = stubFetch([okResponse('x')]);
  const adapter = makeAdapter({ resolveApiKey: async () => 'k', fetchImpl });
  const longPrompt = Array.from({ length: host.FIM_MAX_PREFIX_LINES + 50 }, (_, i) => `line${i}`).join('\n');
  await collect(adapter.stream(envelopeOptions({ prompt: longPrompt, suffix: 's' })));
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  const sentLines = body.prompt.split('\n');
  assert.equal(sentLines.length, host.FIM_MAX_PREFIX_LINES);
  assert.equal(sentLines[sentLines.length - 1], `line${host.FIM_MAX_PREFIX_LINES + 49}`, '保留的是靠近光标那端');
});

await test('适配器:不是信封 ⇒ INVALID_REQUEST 终态(绝不静默当成普通对话)', async () => {
  const fetchImpl = stubFetch([okResponse('x')]);
  const adapter = makeAdapter({ resolveApiKey: async () => 'k', fetchImpl });
  const chunks = await collect(adapter.stream({
    provider: host.FIM_PROVIDER, model: host.FIM_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我写个函数' }] }],
  }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'INVALID_REQUEST');
  assert.equal(fetchImpl.calls.length, 0, '不该发任何线上请求');
});

await test('适配器:没有凭据 ⇒ MISSING_CREDENTIAL 终态(也不发请求)', async () => {
  const fetchImpl = stubFetch([okResponse('x')]);
  const adapter = makeAdapter({
    resolveApiKey: async () => { throw new Error('没有可用的 DEEPSEEK_API_KEY'); }, fetchImpl,
  });
  const chunks = await collect(adapter.stream(envelopeOptions({ prompt: 'p', suffix: 's' })));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.failure.code, 'MISSING_CREDENTIAL');
  assert.equal(fetchImpl.calls.length, 0);
});

await test('适配器:线上 500 ⇒ error 终态带 PROVIDER;finish_reason=length ⇒ max-tokens', async () => {
  const failing = makeAdapter({ resolveApiKey: async () => 'k', fetchImpl: stubFetch([errorResponse(500)]) });
  const failed = await collect(failing.stream(envelopeOptions({ prompt: 'p', suffix: 's' })));
  assert.equal(failed[0].reason.kind, 'error');
  assert.equal(failed[0].reason.failure.code, 'PROVIDER');
  const truncated = makeAdapter({
    resolveApiKey: async () => 'k',
    fetchImpl: stubFetch([{ ok: true, status: 200, json: async () => ({ choices: [{ text: 'abc', finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }]),
  });
  const chunks = await collect(truncated.stream(envelopeOptions({ prompt: 'p', suffix: 's' })));
  assert.equal(chunks[chunks.length - 1].reason.kind, 'max-tokens', '被 max_tokens 截断要如实上报');
});

// ---------------------------------------------------------------- 扩展侧(纯逻辑)

await test('两侧常量一致:扩展镜像的窗口上限必须等于宿主(扩展不能 import 宿主代码)', () => {
  assert.equal(ext.FIM_MAX_PREFIX_CHARS, host.FIM_MAX_PREFIX_CHARS);
  assert.equal(ext.FIM_MAX_SUFFIX_CHARS, host.FIM_MAX_SUFFIX_CHARS);
  assert.equal(ext.FIM_MAX_PREFIX_LINES, host.FIM_MAX_PREFIX_LINES);
  assert.equal(ext.FIM_MAX_SUFFIX_LINES, host.FIM_MAX_SUFFIX_LINES);
});

await test('扩展门控:选区 / 非文件 / 空文档 / 过大文档 / 空上下文 都不问', () => {
  const base = { selectionEmpty: true, scheme: 'file', lineCount: 10, prefixText: 'const a =', suffixText: '', lineTextBefore: 'const a =' };
  assert.equal(ext.shouldRequest(base).ask, true);
  assert.equal(ext.shouldRequest({ ...base, selectionEmpty: false }).ask, false, '有选区不补');
  assert.equal(ext.shouldRequest({ ...base, scheme: 'untitled' }).ask, false);
  assert.equal(ext.shouldRequest({ ...base, lineCount: 0 }).ask, false);
  assert.equal(ext.shouldRequest({ ...base, lineCount: ext.FIM_MAX_DOCUMENT_LINES + 1 }).ask, false);
  assert.equal(ext.shouldRequest({ ...base, prefixText: '  ', suffixText: '', lineTextBefore: '  ' }).ask, false, '空上下文不补');
});

await test('扩展载荷:窗口化后送出;指纹同输入同键、内容变则键变', () => {
  const payload = ext.buildPayload({ prefixText: 'a\nb\nc', suffixText: 'd', language: 'ts', path: '/x.ts' });
  assert.equal(payload.prompt, 'a\nb\nc');
  assert.equal(payload.language, 'ts');
  const long = ext.buildPayload({ prefixText: 'x'.repeat(ext.FIM_MAX_PREFIX_CHARS + 500), suffixText: '' });
  assert.equal(long.prompt.length, ext.FIM_MAX_PREFIX_CHARS);
  const key = ext.fingerprint('p', 's', 'ts');
  assert.equal(key, ext.fingerprint('p', 's', 'ts'), '同输入同键(缓存命中靠它)');
  assert.notEqual(key, ext.fingerprint('p', 's', 'js'));
  assert.notEqual(key, ext.fingerprint('p2', 's', 'ts'));
});

await test('扩展缓存:LRU 淘汰最旧,TTL 到期失效', () => {
  let t = 0;
  const cache = ext.createCompletionCache({ max: 2, ttlMs: 100, now: () => t });
  cache.set('a', 'A');
  cache.set('b', 'B');
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C');
  assert.equal(cache.get('b'), null, '最久未用的被淘汰');
  assert.equal(cache.size(), 2);
  t = 1000;
  assert.equal(cache.get('a'), null, 'TTL 过期');
});

await test('扩展展示:token 短串 + 状态栏文案(关闭 / 不可用 / 有错误都要说清)', () => {
  assert.equal(ext.formatTokens(0), '0');
  assert.equal(ext.formatTokens(999), '999');
  assert.equal(ext.formatTokens(1234), '1.2k');
  assert.equal(ext.formatTokens(12345), '12k');
  assert.equal(ext.formatTokens(1234567), '1.2M');
  assert.deepEqual(ext.describeFimUsage({ enabled: false }), ['FIM 补全:已关闭(设置里可开,实验性)']);
  const on = ext.describeFimUsage({
    enabled: true, calls: 3, ok: 2, failed: 1, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 300, lastMs: 180, lastError: 'PROVIDER',
  });
  assert.ok(on[0].includes('已开启'));
  assert.ok(on[1].includes('3 次'));
  assert.ok(on[2].includes('缓存命中 300'));
  assert.ok(on[3].includes('停顿 250ms'), '要显示当前生效的停顿(用户改完能立刻在状态栏确认)');
  assert.ok(on[3].includes('允许多行'), '要显示多行策略(0.3.62)');
  assert.ok(on[4].includes('180ms'));
  assert.ok(on[5].includes('PROVIDER'));
  const tuned = ext.describeFimUsage({
    enabled: true, calls: 1, ok: 1, failed: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
    debounceMs: 800, multiline: false, disableGlobs: ['*.md', 'vendor/**'],
  });
  assert.ok(tuned[3].includes('800ms'), '停顿要按宿主给的数显示');
  assert.ok(tuned[3].includes('仅单行'), '关掉多行要说清');
  assert.ok(tuned[3].includes('禁用 2 条 glob'), '禁用条数要显示');
  const unavailable = ext.describeFimUsage({ enabled: true, available: false, reason: '这个 DSH 没有 llm 服务' });
  assert.ok(unavailable[0].includes('没有 llm 服务'), '不可用要说清原因,别让用户对着"没反应"猜');
});

// ---------------------------------------------------------------- glob / 多行 / 停顿(0.3.62)

await test('glob 清单:分号/逗号/空白/换行都能分隔;去重、去 ./ 前缀;空 ⇒ 空表', () => {
  assert.deepEqual(host.compileGlobList('*.md; vendor/**'), ['*.md', 'vendor/**']);
  assert.deepEqual(host.compileGlobList('*.md\nvendor/**\n  **/dist/** '), ['*.md', 'vendor/**', '**/dist/**']);
  assert.deepEqual(host.compileGlobList('a, b ,a'), ['a', 'b']);
  assert.deepEqual(host.compileGlobList('./a/b'), ['a/b']);
  assert.deepEqual(host.compileGlobList(''), []);
  assert.deepEqual(host.compileGlobList('   '), []);
});

await test('glob 语义:不含 / 只看文件名;含 / 按尾段匹配;** 跨目录;/ 结尾视作 /**', () => {
  const hit = (p, g) => host.matchDisabledGlob(p, [g]);
  assert.equal(hit('/x/a.md', '*.md'), '*.md');
  assert.equal(hit('/x/src/a.md', '*.md'), '*.md', '不含 / 的模式只看文件名');
  assert.equal(hit('/x/src/a.ts', '*.md'), null);
  assert.equal(hit('/x/vendor/a.ts', 'vendor/**'), 'vendor/**', '含 / 的模式按尾段匹配 ⇒ 任何层级的 vendor');
  assert.equal(hit('/x/src/vendor/a.ts', 'vendor/**'), 'vendor/**', '嵌套的 vendor 也命中(用户直觉)');
  assert.equal(hit('/x/src/vendorish/a.ts', 'vendor/**'), null, '不许前缀误命中');
  assert.equal(hit('/x/src/a.ts', 'src/*.ts'), 'src/*.ts', '尾段里可以单层通配');
  assert.equal(hit('/x/src/deep/a.ts', 'src/*.ts'), null, '`*` 不跨目录');
  assert.equal(hit('/x/a.ts', '**/vendor/**'), null);
  assert.equal(hit('/x/a.md', '**/*.md'), '**/*.md', '**/ 允许 0 层目录');
  assert.equal(hit('/x/node_modules/a.js', 'node_modules/'), 'node_modules/', '/ 结尾视作 /**');
  assert.equal(hit('C:\\x\\vendor\\a.ts', 'vendor/**'), 'vendor/**', 'Windows 反斜杠要归一');
  assert.equal(host.matchDisabledGlob('/x/a.ts', []), null, '空清单不禁用任何东西');
});

await test('glob 一致性:扩展侧与宿主侧对同一组(模式,路径)结论必须相同', () => {
  const corpus = [
    ['*.md', '/x/a.md'], ['*.md', '/x/a.ts'], ['*.md', '/x/src/a.md'],
    ['**/*.md', '/x/a.md'], ['**/*.md', '/x/src/a.md'], ['**/*.md', '/x/src/a.ts'],
    ['vendor/**', '/x/vendor/a.ts'], ['vendor/**', '/x/src/vendor/a.ts'],
    ['**/vendor/**', '/x/src/vendor/a.ts'], ['**/dist/**', '/x/dist/a.js'],
    ['node_modules/', '/x/node_modules/a.js'], ['a?b.ts', '/x/acb.ts'], ['a?b.ts', '/x/a/b.ts'],
    ['src/*.ts', '/x/src/a.ts'], ['src/*.ts', '/x/src/deep/a.ts'],
  ];
  for (const [pattern, file] of corpus) {
    const a = host.matchDisabledGlob(file, [pattern]) === null ? 'no' : 'yes';
    const b = ext.matchDisabledGlob(file, [pattern]) === null ? 'no' : 'yes';
    assert.equal(b, a, `两侧对 ${pattern} × ${file} 结论不一致(宿主=${a} 扩展=${b})`);
  }
  assert.deepEqual(ext.compileGlobList('*.md; vendor/**'), host.compileGlobList('*.md; vendor/**'));
});

await test('多行关掉:只保留第一行;首行空白 ⇒ 空串(这次不补)', () => {
  assert.equal(host.toSingleLine('const a = 1;'), 'const a = 1;');
  assert.equal(host.toSingleLine('const a = 1;\nconst b = 2;'), 'const a = 1;');
  assert.equal(host.toSingleLine('\n  const a = 1;'), '', '首行空白 ⇒ 空(不许把换行当成一次补全)');
  assert.equal(host.toSingleLine('   '), '');
  assert.equal(host.toSingleLine(''), '');
  assert.equal(ext.toSingleLine('a\nb'), host.toSingleLine('a\nb'), '两侧同语义');
});

await test('停顿夹取:非法值回落默认,越界夹到 [100, 3000]', () => {
  assert.equal(host.clampDebounce(250), 250);
  assert.equal(host.clampDebounce(1), 100);
  assert.equal(host.clampDebounce(99999), 3000);
  assert.equal(host.clampDebounce('400'), 400, '设置里是字符串也要接受');
  assert.equal(host.clampDebounce(null), 250);
  assert.equal(host.clampDebounce('abc'), 250);
  assert.equal(host.clampDebounce(199.6), 200, '取整');
});

// ---------------------------------------------------------------- 默认值(实验性功能必须默认关)

await test('默认关:宿主 Config 里 fim 默认 false;对照 editorBridge 仍默认 true', async () => {
  const plugin = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href);
  // 0.3.66 起 Config 的字段在 alpha 线是 **volatile 活引用**(`{get()}`,schemastery 3.18.3 才有),
  // 在 rc 线(3.18.2)是普通值 —— 默认值两种形状都要断得出来。
  const resolved = {};
  for (const [key, value] of Object.entries(plugin.Config({}))) {
    resolved[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  }
  assert.equal(resolved.fim, false, '实验性功能必须默认关闭');
  assert.equal(resolved.fimDebounceMs, 250, '停顿默认 250ms');
  assert.equal(resolved.fimMultiline, true, '默认允许多行(与 Continue 的默认一致)');
  assert.equal(resolved.fimDisableGlobs, '', '默认不禁用任何文件');
  assert.equal(resolved.editorBridge, true, '对照组:编辑器桥的默认值没有被顺手改掉');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
