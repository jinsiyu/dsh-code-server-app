// scripts/patch-vscode-bundle.mjs —— B2 外科补丁(阶段 1,见 docs/plan-noport-desktop-ide.md §7)
//
// 做两件事(都只动 workbench bundle 的字节,不改 VS Code 源码):
//   1. 在包首插入 src/pipe-ws.js 的内容(定义 globalThis.__DSH_WS_FACTORY__);
//   2. 把入口 IIFE 里的 options 字面量补一个字段:
//        remoteAuthority:location.host}  →  remoteAuthority:location.host,webSocketFactory:globalThis.__DSH_WS_FACTORY__}
//      这是 VS Code 官方 seam(IWorkbenchConstructionOptions.webSocketFactory),
//      上游源码里 BrowserSocketFactory 就是拿它构造的。
//
// 用法:
//   node scripts/patch-vscode-bundle.mjs <workbench.js>            # 打补丁(首次会留 .dshcs-orig 备份)
//   node scripts/patch-vscode-bundle.mjs <workbench.js> --revert   # 还原
//   node scripts/patch-vscode-bundle.mjs <workbench.js> --check    # 只报告状态
//
// 断言:标记必须恰好命中 1 次;插入内容必须纯 ASCII(bundle 里非 ASCII 会被 esbuild 转义,
// 字节级断言只能盯 ASCII)。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 原子替换:先写临时文件再 rename。
 *  为什么不能直接 writeFileSync:profile 里的这些文件是 pnpm 硬链接,
 *  就地截断+写会把 store 里的那份也改掉(污染所有共用该 store 的 profile)。 */
function replaceFile(file, text) {
  const tmp = `${file}.dshcs-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const here = dirname(fileURLToPath(import.meta.url));
const shimPath = resolve(here, '..', 'src', 'pipe-ws.js');
const SENTINEL = '/*__DSHCS_PIPE_WS__*/';
const MARKER = 'remoteAuthority:location.host}';
const PATCHED = 'remoteAuthority:location.host,webSocketFactory:globalThis.__DSH_WS_FACTORY__}';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const mode = argv.includes('--revert') ? 'revert' : (argv.includes('--check') ? 'check' : 'patch');

if (target === undefined) {
  console.error('用法: node scripts/patch-vscode-bundle.mjs <workbench.js> [--revert|--check]');
  process.exit(1);
}
const file = resolve(target);
const backup = `${file}.dshcs-orig`;
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

if (!existsSync(file)) {
  console.error(`找不到目标文件:${file}`);
  process.exit(1);
}

const current = readFileSync(file, 'utf8');
const patched = current.includes(SENTINEL);

if (mode === 'check') {
  console.log(JSON.stringify({
    file,
    patched,
    hasMarker: current.includes(MARKER),
    hasBackup: existsSync(backup),
    bytes: Buffer.byteLength(current, 'utf8'),
    sha256: sha(current),
  }, null, 2));
  process.exit(patched && current.includes(MARKER) === false ? 0 : (patched ? 0 : 1));
}

if (mode === 'revert') {
  if (!existsSync(backup)) {
    console.error('没有备份文件,无法还原(补丁未打过?)');
    process.exit(1);
  }
  const original = readFileSync(backup, 'utf8');
  replaceFile(file, original);
  console.log(`[patch] 已还原:${file} (${Buffer.byteLength(original, 'utf8')} B, sha=${sha(original)})`);
  process.exit(0);
}

if (!existsSync(shimPath)) {
  console.error(`找不到 shim 源:${shimPath}(先实现 src/pipe-ws.js)`);
  process.exit(1);
}
const shim = readFileSync(shimPath, 'utf8');
if (/[^\x00-\x7F]/.test(shim)) {
  console.error('shim 含非 ASCII 字符:补丁必须保持纯 ASCII');
  process.exit(1);
}
if (patched) {
  console.log(`[patch] 已经是打过补丁的版本,跳过(想更新 shim 先 --revert 再打)`);
  process.exit(0);
}

const count = current.split(MARKER).length - 1;
if (count !== 1) {
  console.error(`标记命中 ${count} 次(期望 1 次),拒绝打补丁:${MARKER}`);
  process.exit(1);
}

if (!existsSync(backup)) writeFileSync(backup, current);
const next = `${SENTINEL}\n${shim}\n${current.split(MARKER).join(PATCHED)}`;
replaceFile(file, next);
console.log(`[patch] 已打补丁:${file}`);
console.log(`[patch] 体积 ${Buffer.byteLength(current, 'utf8')} → ${Buffer.byteLength(next, 'utf8')} B(sim ${Buffer.byteLength(shim, 'utf8')} B);sha ${sha(current)} → ${sha(next)}`);
console.log(`[patch] 备份:${backup}`);
