// scripts/run-all-tests.mjs —— 一条命令跑完全部回归(本机与 CI 共用**同一份清单**)。
//
// 为什么要有:README「回归脚本(改完跑一遍)」那 9 条现在也是 CI 的门禁(.github/workflows/ci.yml)
// 与发布前的门禁(.github/workflows/release.yml)。清单若在两处各写一遍,迟早漂移 ——
// 新加的测试只在一处生效,而"发布前少跑一条"是那种事后才知道的类型。这里是唯一清单。
//
// 语义:
//   · **顺序执行**:后面几个会起真进程 / 真 HTTP 服务 / 真 unix socket,串行避免它们互相干扰
//     (端口、DSH_HOME、tmp 目录都在各自脚本里隔离,但没必要赌);
//   · **失败也继续跑完**:一次运行就能看到所有坏掉的地方,而不是修一个跑一次;
//   · 每个脚本自己打印 PASS / FAIL / SKIP —— 本脚本不改写它们的输出。有的脚本在环境不满足时
//     主动 SKIP 并 exit 0(如 test-launcher-routes 找不到"内部依赖已建链接"的 VS Code 树),
//     这是**通过**,但汇总里会把耗时一并列出来,便于发现"整段被跳过"的情况;
//   · 任一脚本非零退出 ⇒ 本脚本 exit 1(CI 直接挂在这一行上)。
//
// 用法:
//   node scripts/run-all-tests.mjs                 # 全跑(pnpm test / pnpm run test:all)
//   node scripts/run-all-tests.mjs bridge          # 只跑名字含 bridge 的(子串过滤,可给多个)
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

/** 唯一清单。顺序:纯逻辑 → 起进程/起服务的 → 最慢的放最后。
 *  新增回归脚本时**只改这里**,CI 与 README 都跟着它走。 */
const SUITE = [
  'test-plugin-apply.mjs',
  'test-claim-types.mjs',
  'test-sidebar-fullscreen.mjs',
  'test-workspace-switch.mjs',
  'test-bridge-routes.mjs',
  'test-bridge-extension.mjs',
  'test-vendored-table.mjs',
  'test-webview-bundle.mjs',
  'test-launcher-routes.mjs',
];

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const picked = filters.length === 0
  ? SUITE
  : SUITE.filter((name) => filters.some((f) => name.includes(f)));
if (picked.length === 0) {
  console.error(`没有匹配的测试脚本:${filters.join(', ')}\n可用:${SUITE.join(', ')}`);
  process.exit(1);
}

/** 跑一个脚本:stdio 继承(stdout 直接进 CI 日志;**不建管道** —— 沙箱里管道会 EPERM)。 */
function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(here, name)], { cwd: pkgRoot, stdio: 'inherit' });
    child.on('error', (error) => {
      resolve({ name, code: 1, ms: Date.now() - started, error: error.message });
    });
    child.on('close', (code, signal) => {
      resolve({ name, code: code ?? 1, ms: Date.now() - started, ...(signal ? { signal } : {}) });
    });
  });
}

console.log(`[suite] 共 ${picked.length} 个回归脚本(node ${process.version}, ${process.platform}/${process.arch})\n`);
const results = [];
for (const name of picked) {
  console.log(`[suite] ── ${name} ${'─'.repeat(Math.max(4, 60 - name.length))}`);
  results.push(await runOne(name));
  console.log('');
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
console.log('[suite] 汇总:');
for (const r of results) {
  const mark = r.code === 0 ? 'ok  ' : 'FAIL';
  const note = r.error !== undefined ? ` (${r.error})` : r.signal !== undefined ? ` (signal ${r.signal})` : '';
  console.log(`[suite]   ${mark} ${r.name.padEnd(30)} ${seconds(r.ms).padStart(7)}${note}`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length}`);
if (failed.length > 0) {
  console.error(`[suite] 失败:${failed.map((r) => r.name).join(', ')}`);
  console.error('[suite] 注意:SKIP(exit 0)也是通过;上面每个脚本自己的 SKIP 行说明跳过了什么。');
  process.exit(1);
}
console.log('[suite] 全部通过(各脚本内标注的 SKIP 见上文)。');
