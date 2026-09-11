// scripts/test-asset-mirror.mjs —— lib/asset-mirror.mjs 的离线测试(不需要 DSH/IDE)
//
// 覆盖:URL 空间枚举(形状与规模)、非法文件名的过滤、文档路由与转发(用一个假的 IDE 监听器)。
// 用法:node scripts/test-asset-mirror.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_BASE, ASSET_DOCUMENT, createAssetMirror, enumerateAssetPaths, isRegistrable } from '../lib/asset-mirror.mjs';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000))]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

// 造一棵最小树:out/**、extensions/**(含两个非法文件名)、src/browser/**
const tree = mkdtempSync(join(tmpdir(), 'dshcs-mirror-'));
mkdirSync(join(tree, 'lib', 'vscode', 'out', 'vs', 'code', 'browser', 'workbench'), { recursive: true });
writeFileSync(join(tree, 'lib', 'vscode', 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.js'), '/*bundle*/');
writeFileSync(join(tree, 'lib', 'vscode', 'out', 'nls.messages.js'), '/*nls*/');
writeFileSync(join(tree, 'lib', 'vscode', 'out', 'stream-demo.js'), '/*stream*/');
mkdirSync(join(tree, 'lib', 'vscode', 'extensions', 'javascript', 'syntaxes'), { recursive: true });
writeFileSync(join(tree, 'lib', 'vscode', 'extensions', 'javascript', 'syntaxes', 'Regular Expressions (JavaScript).tmLanguage'), '{}');
writeFileSync(join(tree, 'lib', 'vscode', 'extensions', 'javascript', 'package.json'), '{}');
mkdirSync(join(tree, 'src', 'browser', 'media'), { recursive: true });
writeFileSync(join(tree, 'src', 'browser', 'media', 'favicon.ico'), 'x');

const PRODUCT = 'stable-test';

await test('枚举:形状正确(out/extensions/_static 三个来源 + singletons)', () => {
  const urls = enumerateAssetPaths(tree, PRODUCT);
  assert.ok(urls.includes(`/${PRODUCT}/static/out/vs/code/browser/workbench/workbench.js`), 'out 下的文件应按 static 前缀映射');
  assert.ok(urls.includes(`/${PRODUCT}/static/out/nls.messages.js`));
  assert.ok(urls.includes(`/${PRODUCT}/static/extensions/javascript/package.json`));
  assert.ok(urls.includes('/_static/src/browser/media/favicon.ico'));
  assert.ok(urls.includes('/vscode-remote-resource'), '扩展资源端点必须在集合里');
  assert.ok(urls.includes('/manifest.json'));
});

await test('非法文件名被识别(空格/括号/加号),合法路径通过', () => {
  const bad = `/${PRODUCT}/static/extensions/javascript/syntaxes/Regular Expressions (JavaScript).tmLanguage`;
  assert.equal(isRegistrable(bad), false);
  assert.equal(isRegistrable(`/${PRODUCT}/static/extensions/objective-c/syntaxes/objective-c++.tmLanguage.json`), false);
  assert.equal(isRegistrable(`/${PRODUCT}/static/out/vs/loader.js`), true);
  assert.equal(isRegistrable('/vscode-remote-resource'), true);
  assert.equal(isRegistrable(`${ASSET_BASE}/`), false, '空段不可注册 → 文档必须用具体文件名');
});

// 假 IDE 监听器:回显路径与查询串,另给一个流式端点
const ide = createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head></head><body>workbench</body></html>');
    return;
  }
  if (req.url.startsWith('/stream-demo.js') || req.url.includes('/stream-demo.js')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('A');
    setTimeout(() => res.end('B'), 30);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`echo:${req.url}`);
});
await new Promise((r) => ide.listen(0, '127.0.0.1', r));
const PORT = ide.address().port;

const registered = new Map();
const fakeConnection = { fetch: { register: (route) => { registered.set(route.path, route); return () => {}; } } };
const mirror = createAssetMirror({ getTarget: () => ({ kind: 'loopback', port: PORT }), tree, productPath: PRODUCT, log: () => {} });
const dispose = mirror.register(fakeConnection);

await test('注册:枚举到的合法路径都注册,且都带 GET/HEAD 与 buffered 体', () => {
  const snap = mirror.snapshot();
  assert.ok(snap.registered > 5, `应注册若干路由(实际 ${snap.registered})`);
  assert.equal(snap.skipped, 1, '一个非法文件名应被跳过');
  const route = registered.get(`${ASSET_BASE}/${PRODUCT}/static/out/nls.messages.js`);
  assert.ok(route !== undefined, '静态文件应有精确路由');
  assert.deepEqual(route.methods, ['GET', 'HEAD']);
  assert.equal(route.requestBody, 'buffered');
  assert.ok(registered.has(ASSET_DOCUMENT), '文档路由必须注册');
});

await test('转发:同路径 + 同查询串到达上游,响应体原样回传', async () => {
  const route = registered.get(`${ASSET_BASE}/${PRODUCT}/static/out/nls.messages.js`);
  const response = await route.fetch(new Request(`https://dsh.invalid${ASSET_BASE}/${PRODUCT}/static/out/nls.messages.js?x=1`, { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `echo:/${PRODUCT}/static/out/nls.messages.js?x=1`);
  assert.equal(mirror.snapshot().served, 1);
});

await test('文档路由:映射到上游 `/`(不是 /index.html)', async () => {
  const route = registered.get(ASSET_DOCUMENT);
  const response = await route.fetch(new Request(`https://dsh.invalid${ASSET_DOCUMENT}`, { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /workbench/);
});

await test('响应流式回传(分片按到达顺序)', async () => {
  const route = registered.get(`${ASSET_BASE}/${PRODUCT}/static/out/stream-demo.js`);
  assert.ok(route !== undefined, '流式端点也应能注册(枚举到的文件)');
  const response = await route.fetch(new Request(`https://dsh.invalid/${PRODUCT}/static/out/stream-demo.js`, { method: 'GET' }));
  const reader = response.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(new TextDecoder().decode(value));
  }
  assert.deepEqual(parts, ['A', 'B']);
});

await test('IDE 未运行 → 503(而不是抛错)', async () => {
  const idle = createAssetMirror({ getTarget: () => null, tree, productPath: PRODUCT, log: () => {} });
  const map = new Map();
  idle.register({ fetch: { register: (route) => { map.set(route.path, route); return () => {}; } } });
  const response = await map.get(ASSET_DOCUMENT).fetch(new Request('https://dsh.invalid/doc', { method: 'GET' }));
  assert.equal(response.status, 503);
});

dispose();
ide.close();
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
