// scripts/test-package-files.mjs —— 「发布物白名单」守卫:files 里的模块,**它们 import 的本地文件也必须在 files 里**
//
// 为什么要有(0.3.53 的真实事故):新增 lib/child-node.mjs 后忘了往 package.json 的 files 加一行。
// 本地一切正常(仓库里那文件就在),但 `pnpm pack` 出来的 tarball 里没有它 ⇒ 装完 import lib/index.js 直接
// `ERR_MODULE_NOT_FOUND` ⇒ release 的 install-smoke 挂 ⇒ publish 被 skip。既有门禁都抓不到:
//   · 门禁5「tarball 清单校验」只验 files 里**列出的**条目在不在包里(漏列的不可能被它发现);
//   · test-installed 只跑在**已安装副本**上(CI 里才有),本地绿得毫无破绽。
// 所以这条守卫放在本地清单里:从 files 里的每个 .js/.mjs 出发,**递归**跟进相对 import,
// 任何一个没被 files 覆盖(精确条目或所在目录条目)就判失败;顺带反向校验 files 里的条目都存在。
//
// 用法:node scripts/test-package-files.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];

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

/** 某个仓库相对路径是否被 files 覆盖(精确条目,或落在某个目录条目下)。 */
function covered(rel) {
  const posix = rel.replace(/\\/g, '/');
  return files.some((entry) => {
    const e = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    return posix === e || posix.startsWith(e + '/');
  });
}

/** 从一个模块里抽出相对 import/require 的目标(只认 ./ 与 ../ 开头的静态或动态说明符)。 */
function relativeImports(source) {
  const out = new Set();
  const patterns = [
    /(?:^|[^\w.])import\s+[^'"]*from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|[^\w.])import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|[^\w.])require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|[^\w.])export\s+[^'"]*from\s*['"](\.[^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

/** 把相对说明符落成仓库内的真实文件(补 .js/.mjs/index 的常见形态)。 */
function resolveRelative(fromRel, spec) {
  const base = normalize(join(dirname(fromRel), spec));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js'), join(base, 'index.mjs')];
  for (const candidate of candidates) {
    const abs = join(pkgRoot, candidate);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return candidate;
    } catch { /* 下一个 */ }
  }
  return null;
}

await test('files 里的每个条目在仓库里都存在(白名单不许有幽灵条目)', async () => {
  const missing = files.filter((entry) => !existsSync(join(pkgRoot, entry)));
  assert.deepEqual(missing, [], `files 里这些条目不存在:${missing.join(', ')}`);
});

await test('模块依赖闭包:所有被 import 的本地文件都在 files 覆盖范围内(0.3.53 事故的守卫)', async () => {
  const shippedModules = files.filter((entry) => /\.(m?js|cjs)$/.test(entry));
  assert.ok(shippedModules.length >= 5, `应当有一批发布用的 JS 模块可扫,实际 ${shippedModules.length} 个`);

  const seen = new Set();
  const queue = [...shippedModules];
  const uncovered = [];
  let edges = 0;
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!existsSync(join(pkgRoot, rel))) continue; // 由上面那条用例负责报缺
    const source = readFileSync(join(pkgRoot, rel), 'utf8');
    for (const spec of relativeImports(source)) {
      const target = resolveRelative(rel, spec);
      if (target === null) continue; // 目录/资源等非模块目标,跳过
      edges += 1;
      if (!covered(target)) uncovered.push(`${rel} -> ${target}`.replace(/\\/g, '/'));
      if (!seen.has(target)) queue.push(target);
    }
  }
  assert.ok(edges >= 5, `应当扫到若干条本地 import 边,实际 ${edges}(守卫本身可能失效了)`);
  assert.deepEqual(uncovered, [],
    `这些被 import 的文件没进 package.json 的 files(装完就会 ERR_MODULE_NOT_FOUND):\n  ${uncovered.join('\n  ')}`);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
