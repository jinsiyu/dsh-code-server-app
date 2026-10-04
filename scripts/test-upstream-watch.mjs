// scripts/test-upstream-watch.mjs —— 上游看门狗(scripts/watch-upstream.mjs)的回归。
//
// 三条铁律,这个文件就是钉它们的:
//   ① **离线**:一律走 --fixture,绝不打 registry(CI 上网络不可控,测试不能靠外网);
//   ② **不打扰人**:一律带 --no-notify / DSHCS_WATCH_NO_NOTIFY=1,跑测试不该弹通知;
//   ③ **只报告不拦截**:有新版本是 exit 0,--fail-on-update 才是 exit 2,检查失败才是 exit 1
//      —— 这三种退出码混淆过一次(把"检查失败"当成"没有更新"),所以逐条钉死。
//
// 姿态:用**真子进程**跑 CLI(参数解析、退出码、stdout/stderr 分流都要真过一遍),
// 只有纯逻辑(版本比较 / 基线回退 / 节流判定 / 通知载荷)才 import 进来直接调。
// 子进程用**文件描述符重定向**而不是管道:本机工作区沙箱禁管道(spawn EPERM),
// fd 两边都能用 —— 与 scripts/run-all-tests.mjs 用的是同一套理由。
//
// 用法:node scripts/test-upstream-watch.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions, describeError, localBaseline, notifierScript, parseVersion, shouldNotify, toastXml,
} from './watch-upstream.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const WATCHER = join(here, 'watch-upstream.mjs');
const work = join(pkgRoot, '.spike', 'upstream-watch-test');

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

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ── 真子进程跑 CLI ──────────────────────────────────────────────────────────────────────────

let runSeq = 0;
/** 返回 { code, stdout, stderr }。stdout/stderr 分开落文件,才能验证 --json 的"stdout 只有 JSON"。 */
function runCli(args, env = {}) {
  runSeq += 1;
  const outFile = join(work, `stdout-${runSeq}.txt`);
  const errFile = join(work, `stderr-${runSeq}.txt`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  try {
    return new Promise((done) => {
      const child = spawn(process.execPath, [WATCHER, ...args], {
        cwd: pkgRoot,
        env: { ...process.env, DSHCS_WATCH_NO_NOTIFY: '1', ...env },
        stdio: ['ignore', outFd, errFd],
      });
      child.on('error', (error) => done({ code: 1, stdout: '', stderr: String(error), spawnError: error }));
      child.on('close', (code) => done({
        code: code ?? 1,
        stdout: readFileSync(outFile, 'utf8'),
        stderr: readFileSync(errFile, 'utf8'),
      }));
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

const fixture = (name, version) => {
  const file = join(work, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ name: 'code-server', version }, null, 2)}\n`, 'utf8');
  return file;
};
const stateFile = (name) => join(work, `state-${name}.json`);
/** 造一个新版本号。by < 0 时**必须借位** —— 直接算 `patch + by` 会在 patch 为 0 时造出
 *  `4.140.-1` 这种非法版本,而非法版本会让 compareVersions 返回 null ⇒ 结论退化成 uncomparable,
 *  用例报的错看起来像"local-ahead 没生效",其实是用例自己生成了垃圾输入。
 *  (2026-10-04 真实踩到:基线从 4.139.1 抬到 4.140.0 后才暴露 —— 之前 patch≥1 一直掩盖着它。) */
const bump = (version, by = 1) => {
  const p = parseVersion(version);
  if (p === null) return null;
  const [maj, min, pat] = p.nums;
  if (by >= 0) return `${maj}.${min}.${pat + by}`;
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  if (maj > 0) return `${maj - 1}.0.0`;
  return null;
};

// 基线从被测脚本自己的解析结果取(CI 全新 clone 里 vendor/ 不存在,会落到 package.json 的钉版),
// 这样用例永远和真实基线一致,不会因为上游版本变了而假失败。
const baseline = localBaseline(pkgRoot);
const LOCAL = baseline?.version ?? null;

// ── 纯逻辑:版本比较 ────────────────────────────────────────────────────────────────────────

await test('compareVersions:数字段按数值比,不按字典序', async () => {
  assert.equal(compareVersions('4.140.0', '4.139.1'), 1);
  assert.equal(compareVersions('4.139.1', '4.140.0'), -1);
  assert.equal(compareVersions('4.139.1', '4.139.1'), 0);
  assert.equal(compareVersions('4.9.0', '4.10.0'), -1, '9 < 10,字典序会答错');
  assert.equal(compareVersions('10.0.0', '9.99.99'), 1);
});

await test('compareVersions:v 前缀 / 构建元数据 / 预发布版的次序', async () => {
  assert.equal(compareVersions('v4.140.0', '4.140.0'), 0, 'v 前缀要容忍');
  assert.equal(compareVersions('4.140.0+build.7', '4.140.0'), 0, '构建元数据不参与比较');
  assert.equal(compareVersions('4.140.0-rc.1', '4.140.0'), -1, '预发布 < 正式');
  assert.equal(compareVersions('4.140.0-rc.2', '4.140.0-rc.1'), 1);
  assert.equal(compareVersions('4.140.0-rc', '4.140.0-rc.1'), -1, '段少的一方更小');
});

await test('compareVersions:解析不了就是 null,绝不当作"相等"', async () => {
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('4.140'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(compareVersions('latest', '4.0.0'), null);
  assert.equal(compareVersions('4.0.0', 'latest'), null);
});

// ── 纯逻辑:本地基线三级回退 ────────────────────────────────────────────────────────────────

await test('localBaseline:① vendor/VENDOR.json 优先', async () => {
  const root = join(work, 'root-vendor');
  mkdirSync(join(root, 'vendor'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'VENDOR.json'), JSON.stringify({ codeServerVersion: '9.9.9', preparedAt: 'X' }));
  const got = localBaseline(root);
  assert.equal(got.version, '9.9.9');
  assert.equal(got.source, 'vendor/VENDOR.json');
  assert.equal(got.preparedAt, 'X');
});

await test('localBaseline:② 退到 vendor/vscode/package.json', async () => {
  const root = join(work, 'root-tree');
  mkdirSync(join(root, 'vendor', 'vscode'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'vscode', 'package.json'), JSON.stringify({ version: '8.8.8' }));
  assert.equal(localBaseline(root).version, '8.8.8');
});

await test('localBaseline:③ 再退到 package.json 的钉版(CI 全新 clone 就是这条)', async () => {
  const root = join(work, 'root-pin');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@jinsiyu/dshcs-vscode-server': '7.7.7' } }));
  assert.equal(localBaseline(root).version, '7.7.7');
});

await test('localBaseline:三级都读不到 → null(调用方必须报错,不许猜)', async () => {
  const root = join(work, 'root-empty');
  mkdirSync(root, { recursive: true });
  assert.equal(localBaseline(root), null);
  assert.equal(localBaseline(join(work, 'root-does-not-exist')), null);
});

// ── 纯逻辑:节流 ────────────────────────────────────────────────────────────────────────────

await test('shouldNotify:新版本要提醒;同版本近期不提醒;超过 7 天再提醒', async () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  assert.equal(shouldNotify({}, '4.140.0', now).yes, true, '从没提醒过');
  assert.equal(shouldNotify({ lastNotifiedVersion: '4.140.0', lastNotifiedAt: '2026-09-29T00:00:00Z' }, '4.140.0', now).yes, false);
  assert.equal(shouldNotify({ lastNotifiedVersion: '4.139.0', lastNotifiedAt: '2026-09-29T00:00:00Z' }, '4.140.0', now).yes, true, '换了版本必须提醒');
  assert.equal(shouldNotify({ lastNotifiedVersion: '4.140.0', lastNotifiedAt: '2026-09-01T00:00:00Z' }, '4.140.0', now).yes, true, '拖过 7 天要再催');
  assert.equal(shouldNotify({ lastNotifiedVersion: '4.140.0', lastNotifiedAt: '不是时间' }, '4.140.0', now).yes, true, '时间读不到宁可提醒');
});

// ── 纯逻辑:通知载荷 ────────────────────────────────────────────────────────────────────────

await test('toastXml:XML 转义,notice 不允许被正文里的尖括号/引号破坏', async () => {
  const xml = toastXml(['标题 <A&B>', '带"引号"和\'单引号\'', 'plain']);
  assert.match(xml, /^<toast duration="long">/u);
  assert.ok(xml.includes('标题 &lt;A&amp;B&gt;'), '尖括号与 & 必须转义');
  assert.ok(xml.includes('&quot;引号&quot;'), '双引号必须转义');
  const unescaped = xml.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/gu, '');
  assert.ok(!unescaped.includes('&'), `不得留下生 & :${unescaped}`);
  assert.equal((xml.match(/<text>/gu) ?? []).length, 3, '一条标题 + 两条正文');
});

await test('notifierScript:走 WinRT toast + 通知历史核验,且必须是纯 ASCII', async () => {
  const script = notifierScript();
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\u0000-\u007F]*$/u.test(script), '.ps1 必须纯 ASCII —— PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解,中文会乱');
  assert.ok(script.includes('CreateToastNotifier($p.appId).Show($toast)'), '必须走 WinRT toast');
  assert.ok(script.includes('History.GetHistory($p.appId)'), '必须带 applicationId 回读历史(0 参重载在 powershell.exe 里必然 ELEMENT_NOT_FOUND)');
  assert.ok(!script.includes('MsgBox'), '不得退回模态 MsgBox(用户 2026-09-30 明确改为系统通知)');
  assert.ok(script.includes('AppUserModelId'), '署名要在 HKCU\\...\\AppUserModelId 下注册 DisplayName');
});

await test('describeError:把 cause 链挖出来,不许只剩 "fetch failed"', async () => {
  const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:12345'), { code: 'ECONNREFUSED' });
  const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
  const text = describeError(outer);
  assert.ok(text.includes('fetch failed'));
  assert.ok(text.includes('ECONNREFUSED'), '真因必须出现在报告里');
});

// ── 端到端:真 CLI ──────────────────────────────────────────────────────────────────────────

if (LOCAL === null) {
  console.log('SKIP 端到端用例:读不到本地基线(localBaseline 回退三级全空)');
} else {
  const sameFixture = fixture('same', LOCAL);
  const newer = bump(LOCAL, 1);
  const older = bump(LOCAL, -1);

  await test('E2E 基线 = 上游 → current / exit 0 / 不通知', async () => {
    const r = await runCli(['--fixture', sameFixture, '--json', '--no-notify', '--local', LOCAL]);
    assert.equal(r.code, 0, `期望 exit 0,实得 ${r.code};stderr=${r.stderr}`);
    const json = JSON.parse(r.stdout); // stdout 必须**只有** JSON(人类输出走 stderr)
    assert.equal(json.status, 'current');
    assert.equal(json.notify.requested, false);
    assert.equal(json.notify.shown, false);
    assert.equal(json.next, undefined, '没有更新就不该给升级链');
  });

  await test('E2E 上游更新 → update-available / exit 0 / 请求了通知(测试里不发)', async () => {
    const r = await runCli(['--fixture', fixture('newer', newer), '--json', '--no-notify', '--local', LOCAL, '--notify-verify-seconds', '0']);
    assert.equal(r.code, 0, '有更新也必须 exit 0 —— 只报告不拦截');
    const json = JSON.parse(r.stdout);
    assert.equal(json.status, 'update-available');
    assert.equal(json.upstream.version, newer);
    assert.equal(json.local.version, LOCAL);
    assert.equal(json.notify.requested, true);
    assert.equal(json.notify.shown, false, '--no-notify 下不得真的发');
    assert.ok(Array.isArray(json.next) && json.next.length > 0, '有更新要给升级链');
  });

  await test('E2E --fail-on-update → exit 2', async () => {
    const r = await runCli(['--fixture', fixture('newer2', newer), '--no-notify', '--local', LOCAL, '--fail-on-update']);
    assert.equal(r.code, 2);
    assert.ok(r.stdout.includes('有新版本'), `报告里要有新版本:${r.stdout}`);
  });

  await test('E2E 本地比上游新 → local-ahead(上游可能撤版)/ exit 0', async () => {
    const r = await runCli(['--fixture', fixture('older', older), '--json', '--no-notify', '--local', LOCAL]);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).status, 'local-ahead');
  });

  await test('E2E registry 打不通 → exit 1 且 stdout 明说"检查失败"而不是"没有更新"', async () => {
    const r = await runCli(['--json', '--no-notify'], {
      DSHCS_WATCH_REGISTRY: 'http://127.0.0.1:12345', DSHCS_WATCH_RETRIES: '1', DSHCS_WATCH_TIMEOUT_MS: '4000',
    });
    assert.equal(r.code, 1, '检查失败必须是 exit 1');
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'upstream-unreachable');
    assert.match(json.detail, /12345|ECONNREFUSED|fetch failed/u, `detail 要带真因:${json.detail}`);
  });

  await test('E2E --no-notify 不得写提醒状态(否则这个版本永远不会被通知)', async () => {
    const state = stateFile('no-notify');
    rmSync(state, { force: true });
    const r = await runCli(['--fixture', fixture('newer3', newer), '--json', '--no-notify', '--local', LOCAL], { DSHCS_WATCH_STATE: state });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).notify.requested, true);
    let exists = true;
    try { readFileSync(state, 'utf8'); } catch { exists = false; }
    assert.equal(exists, false, '没真发出通知就不许记账');
  });

  await test('E2E --no-notify 时报告要写明"为什么没发"', async () => {
    const r = await runCli(['--fixture', fixture('newer4', newer), '--no-notify', '--local', LOCAL]);
    assert.ok(/未发出\(按 --no-notify/u.test(r.stdout), `报告要给出未发原因:${r.stdout}`);
  });

  await test('E2E fixture 文件不存在 → exit 1,且不误报成"没有更新"', async () => {
    const r = await runCli(['--fixture', join(work, 'nope.json'), '--json', '--no-notify', '--local', LOCAL]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
    assert.ok(r.stderr.includes('不存在'), `stderr 要说明原因:${r.stderr}`);
  });

  await test('E2E --json 的 stdout 可被 JSON.parse,人类输出全在 stderr', async () => {
    const r = await runCli(['--fixture', sameFixture, '--json', '--no-notify', '--local', LOCAL]);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout 必须是纯 JSON:${r.stdout.slice(0, 200)}`);
    assert.ok(r.stderr.includes('[watch] 上游 code-server latest:'), `人类报告应在 stderr:${r.stderr}`);
  });
}

rmSync(work, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
