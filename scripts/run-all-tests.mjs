// scripts/run-all-tests.mjs —— 一条命令跑完全部回归(本机与 CI 共用**同一份清单**)。
//
// 为什么要有:README「回归脚本(改完跑一遍)」那 9 条现在也是 CI 的门禁(.github/workflows/ci.yml)
// 与发布前的门禁(.github/workflows/release.yml)。清单若在两处各写一遍,迟早漂移 ——
// 新加的测试只在一处生效,而"发布前少跑一条"是那种事后才知道的类型。这里是唯一清单。
//
// 语义:
//   · **顺序执行**:后面几个会起真进程 / 真 HTTP 服务 / 真 IPC 端点,串行避免它们互相干扰;
//   · **失败也继续跑完**:一次运行就能看到所有坏掉的地方,而不是修一个跑一次;
//   · 每个脚本自己打印 PASS / FAIL / SKIP —— 本脚本不改写它们的输出。有的脚本在环境不满足时
//     主动 SKIP 并 exit 0(如 test-launcher-routes 找不到"内部依赖已建链接"的 VS Code 树),
//     这是**通过**,汇总里会连耗时一起列出来;
//   · 任一脚本非零退出 ⇒ 本脚本 exit 1(CI 直接挂在这一行上)。
//
// CI 下的日志与注解(设 DSHCS_SUITE_LOG=<文件> 时生效):
//   每个脚本的输出会**同时**写进那个文件并原样打印;脚本失败时本脚本把判据行转成 GitHub
//   annotation(`::error::…`)。为什么值得这么做:Actions 的原始日志要鉴权才能拉(公开仓库上
//   jobs/logs 也返回 403),而 annotation 走 check-runs API **不需要 token** —— runner-only 的
//   失败(本机永远绿的那种)才能被直接读出来。子进程用**文件描述符重定向**而不是管道:
//   本机工作区沙箱禁止建管道(spawn EPERM),fd 重定向两边都能用。
//
// 用法:
//   node scripts/run-all-tests.mjs                 # 全跑(pnpm test / pnpm run test:all)
//   node scripts/run-all-tests.mjs bridge          # 只跑名字含 bridge 的(子串过滤,可给多个)
//   DSHCS_SUITE_LOG=/tmp/suite.log node scripts/run-all-tests.mjs   # CI:留日志 + 失败转 annotation
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
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
  'test-workspace-cwd.mjs',
  'test-workspace-switch.mjs',
  'test-dsh-resolve.mjs',
  'test-fim.mjs',
  'test-child-node.mjs',
  'test-package-files.mjs',
  'test-bridge-routes.mjs',
  'test-edit-snapshot.mjs',
  'test-bridge-extension.mjs',
  'test-vendored-table.mjs',
  'test-ask-dialog.mjs',
  'test-client-bundle-cwd.mjs',
  'test-client-bundle-tabs.mjs',
  'test-client-entry.mjs',
  'test-ask-panel-inline.mjs',
  'test-client-settings-seat.mjs',
  'test-launcher-routes.mjs',
];

/** CI 传进来的日志文件(不传 = 本机模式:输出直接继承终端,不写文件、不打 annotation)。 */
const LOG = typeof process.env.DSHCS_SUITE_LOG === 'string' && process.env.DSHCS_SUITE_LOG !== ''
  ? process.env.DSHCS_SUITE_LOG
  : null;

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const picked = filters.length === 0
  ? SUITE
  : SUITE.filter((name) => filters.some((f) => name.includes(f)));
if (picked.length === 0) {
  console.error(`没有匹配的测试脚本:${filters.join(', ')}\n可用:${SUITE.join(', ')}`);
  process.exit(1);
}

/** 跑一个脚本:本机模式 stdio 继承(stdout 直接进终端,**不建管道** —— 沙箱里管道会 EPERM);
 *  CI 模式把子进程的 stdout/stderr 重定向到日志文件,跑完把这一段补打到本步输出里。 */
function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (LOG === null) {
      const child = spawn(process.execPath, [join(here, name)], { cwd: pkgRoot, stdio: 'inherit' });
      child.on('error', (error) => resolve({ name, code: 1, ms: Date.now() - started, error: error.message, output: '' }));
      child.on('close', (code, signal) => {
        resolve({ name, code: code ?? 1, ms: Date.now() - started, ...(signal ? { signal } : {}), output: '' });
      });
      return;
    }
    const before = existsSync(LOG) ? statSync(LOG).size : 0;
    const fd = openSync(LOG, 'a');
    let child;
    try {
      child = spawn(process.execPath, [join(here, name)], { cwd: pkgRoot, stdio: ['ignore', fd, fd] });
    } finally {
      // 子进程有自己的副本,父进程这份立刻关掉。
      closeSync(fd);
    }
    child.on('error', (error) => resolve({ name, code: 1, ms: Date.now() - started, error: error.message, output: '' }));
    child.on('close', (code, signal) => {
      const size = existsSync(LOG) ? statSync(LOG).size : before;
      // **按字节切**:before/size 是 statSync 给的**字节**偏移,直接拿它们当字符串下标会在
      // 非 ASCII 输出(本仓库的用例名全是中文)下错位 —— 切片会从中间开始,把 FAIL 行整段切掉,
      // 于是注解里只剩 SUMMARY(2026-09-16 ubuntu 上 test-bridge-extension 就是这么被掩盖的:
      // 输出 947 字符 vs SUMMARY fail=4)。往前多读 2000 字节做重叠容错。
      const buf = readFileSync(LOG);
      const output = buf.subarray(Math.max(0, before - 2000), size).toString('utf8');
      process.stdout.write(output); // 让 Actions UI 里仍然按顺序看到每个脚本的输出
      resolve({ name, code: code ?? 1, ms: Date.now() - started, ...(signal ? { signal } : {}), output });
    });
  });
}

/** 失败时把判据行转成 annotation(只在 CI 模式打,免得本机终端里出现一堆 ::error::)。
 *  注意 GitHub 对每个 check run 的 annotation 数量有硬上限(~20),所以**只报最有信息量的少数几行**:
 *  按"FAIL 行 → SUMMARY → 报错行 → 最后几行非 PASS"的顺序凑够 6 条为止。 */
function annotate(result) {
  if (LOG === null) return;
  const lines = result.output.split(/\r?\n/);
  // 不锚定 ^:孩子脚本的输出可能与其它行交织,锚定会让"有 FAIL 却挑不到"变成这种最难查的形态。
  const fails = lines.filter((line) => /\bFAIL\b/u.test(line));
  const summary = lines.filter((line) => /^\s*SUMMARY/u.test(line));
  const noisy = lines.filter((line) => /(Error|error|ENOENT|EPERM|EACCES|EADDRINUSE|ERR_|\bat .*:\d+|^\s*\^)/u.test(line));
  const rest = lines.filter((line) => line.trim() !== '' && !/^\s*PASS/u.test(line));
  const picked = [];
  for (const pool of [fails, summary, noisy, rest]) {
    for (const line of pool) {
      if (picked.length >= 6) break;
      if (!picked.includes(line)) picked.push(line);
    }
    if (picked.length >= 6) break;
  }
  console.log(`::error::${result.name} 失败(exit ${result.code}${result.error ? `,${result.error}` : ''};`
    + `输出 ${result.output.length} 字节,FAIL 行 ${fails.length} 条)`);
  for (const line of picked) console.log(`::error::${line.slice(0, 900)}`);
}

console.log(`[suite] 共 ${picked.length} 个回归脚本(node ${process.version}, ${process.platform}/${process.arch})`);
if (LOG !== null) console.log(`[suite] CI 模式:日志 ${LOG},失败行会转成 annotation`);
console.log('');
const results = [];
for (const name of picked) {
  console.log(`[suite] ── ${name} ${'─'.repeat(Math.max(4, 60 - name.length))}`);
  const result = await runOne(name);
  results.push(result);
  if (result.code !== 0) {
    annotate(result);
  } else if (LOG !== null) {
    // 每个脚本一行 notice:既能在 CI 里一眼看到"跑到了哪、输出多少",也用来判定
    // 「失败脚本的输出切片是否完整」(切片掉了开头 ⇒ FAIL 行挑不到,注解等于没报)。
    console.log(`::notice::${name}: exit 0(输出 ${result.output.length} 字节)`);
  }
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
