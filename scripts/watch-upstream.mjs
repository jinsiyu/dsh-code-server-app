// scripts/watch-upstream.mjs —— 上游 code-server 版本「看门狗」(本机脚本;手动跑,或由 DSH 会话内提醒定时唤起)。
//
// 为什么要有:升级链是「上游 code-server 发版 → 重打 @jinsiyu 子包 → 钉进依赖 → 升插件版本」,
// 而这条链的**起点**过去只有人主动去看才会知道 —— 仓库三个工作流(ci / release / repacks)全是
// push / PR / 手动触发,**没有任何 schedule**;CI 里那条 `vendor:check` 又是 continue-on-error,
// 于是「上游早就发版、内置树还停在上一个」这种漂移在一整片绿灯里完全看不见。
// 本脚本只做一件事:把上游版本摆到人眼前(报告 + Windows 系统通知)。
//
// 覆盖范围(刻意收窄 —— 2026-09-30 与用户确认):**只盯 npm 上 code-server 的 latest 版本**。
// 不查 @jinsiyu/* 子包漂移、也不判断「我们的重打包是否已发布对应版本」——那是升级流程自身的事。
//
// 退出码语义(**只报告,不拦截**):
//   0 = 检查成功(有新版本 / 没有新版本**都算成功**:脚本的职责是"报告",不是"卡住流程")
//   1 = 检查失败(网络不通 / registry 应答异常 / 本地基线读不到)
//   2 = 有新版本 **且** 显式给了 --fail-on-update(给"以后想拿它当门禁"的人留的口子)
//
// 用法:
//   node scripts/watch-upstream.mjs                    # 检查一次;有新版本 → 报告 + 系统通知;无更新 → 一行结论
//   node scripts/watch-upstream.mjs --json             # 机器可读(DSH 会话内提醒解析这一份);人类输出转 stderr
//   node scripts/watch-upstream.mjs --no-notify        # 不发通知(回归 / 无人值守)
//   node scripts/watch-upstream.mjs --force-notify     # 无视节流,强制发一次
//   node scripts/watch-upstream.mjs --notify-verify-seconds 0   # 不等通知历史回读(默认 3 秒)
//   node scripts/watch-upstream.mjs --local 4.140.0    # 覆盖本地基线(不读 vendor/;试算用)
//   node scripts/watch-upstream.mjs --fixture f.json   # 用本地 JSON 当 registry 应答(离线回归)
//   node scripts/watch-upstream.mjs --fail-on-update   # 有更新时 exit 2
//   pnpm run watch:upstream                            # 等价于第一条
//
// 环境变量:DSHCS_WATCH_REGISTRY / DSHCS_WATCH_NO_NOTIFY / DSHCS_WATCH_STATE / DSHCS_WATCH_TIMEOUT_MS /
//          DSHCS_WATCH_FIXTURE / DSHCS_WATCH_RETRIES / DSHCS_WATCH_APP_ID / DSHCS_WATCH_POWERSHELL
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const NPM_PACKAGE = 'code-server'; // 上游在 npm 上的包名(code-server 的发行版号即 @jinsiyu/dshcs-vscode-server 的版本号)

/** 同一个上游版本只通知一次;超过这个天数还没升级就再提醒一次 ——
 *  否则「提醒过一次」会退化成「永远不再提」,而漂移恰恰是拖出来的。 */
const REMIND_EVERY_DAYS = 7;

/** 升级链(与 README「打包」一节逐字一致):报告里直接给出下一步,免得看的人再去翻文档。 */
const NEXT_STEPS = [
  'pnpm run vendor:latest',
  'pnpm run repack:build -- --target <目标> --pack',
  'pnpm run publish:repacks',
  '插件版本 +1',
  'pnpm pack && pnpm run publish:plugin',
];

function argValue(name) {
  for (let i = process.argv.length - 2; i >= 0; i -= 1) {
    if (process.argv[i] === name) return process.argv[i + 1];
  }
  return null;
}
const hasFlag = (name) => process.argv.includes(name);

const JSON_MODE = hasFlag('--json');
const FORCE_NOTIFY = hasFlag('--force-notify');
const FAIL_ON_UPDATE = hasFlag('--fail-on-update');
const REGISTRY = (process.env.DSHCS_WATCH_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/u, '');
const TIMEOUT_MS = Number(process.env.DSHCS_WATCH_TIMEOUT_MS || 15000);
/** 重试:registry 偶发 ECONNRESET 会造成"检查失败"的假警报(本机实测遇到过),而假警报多了
 *  这个提醒就会被无视 —— 对看门狗来说"狼来了"和"不叫"一样致命。所以抖动要重试,只有连续失败才算失败。 */
const RETRIES = Math.max(1, Number(process.env.DSHCS_WATCH_RETRIES || 3));
const RETRY_DELAY_MS = Number(process.env.DSHCS_WATCH_RETRY_DELAY_MS || 600);
const APP_ID = process.env.DSHCS_WATCH_APP_ID || 'dsh-code-server-app.UpstreamWatch';
const APP_DISPLAY_NAME = 'dsh-code-server-app 上游监控';
const TOAST_TAG = 'dshcs-upstream-watch';
const TOAST_GROUP = 'dshcs';
const STATE_FILE = resolve(process.env.DSHCS_WATCH_STATE || join(pkgRoot, '.upstream-watch.json'));

/** 人类可读的输出:--json 时全部转 stderr,保证 stdout 上只有那一个 JSON(调用方直接 JSON.parse)。 */
const say = (line = '') => { (JSON_MODE ? process.stderr : process.stdout).write(`${line}\n`); };

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

// ── 版本比较 ────────────────────────────────────────────────────────────────────────────────
// 不引 semver:它在本仓库只是 pnpm 的传递依赖(不是直接依赖),为了一个比较函数把依赖表改脏不值当。

/** 解析 `v?x.y.z[-pre][+build]`;解析不了返回 null(调用方按"无法比较"处理,而不是当成相等)。 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text.trim());
  if (m === null) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null, raw: text.trim() };
}

/** 语义化比较:a > b 返回 1,a < b 返回 -1,相等 0,任一侧解析不了返回 null。
 *  预发布版小于同号正式版(4.140.0-rc.1 < 4.140.0)—— 本脚本只认 latest 那条 dist-tag,所以这个方向是对的。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // 正式版 > 预发布版
  if (pb.pre === null) return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    if (sa[i] === undefined) return -1; // 段少的一方更小(4.140.0-rc < 4.140.0-rc.1)
    if (sb[i] === undefined) return 1;
    if (sa[i] === sb[i]) continue;
    const na = /^\d+$/u.test(sa[i]);
    const nb = /^\d+$/u.test(sb[i]);
    if (na && nb) return Number(sa[i]) > Number(sb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;  // 数字段 < 字母段
    return sa[i] > sb[i] ? 1 : -1;
  }
  return 0;
}

// ── 本地基线 ────────────────────────────────────────────────────────────────────────────────

/** 内置 VS Code 树的 code-server 版本,三级回退:
 *    ① vendor/VENDOR.json —— 打包元数据(树被裁过也在)
 *    ② vendor/vscode/package.json —— vendor-vscode-server.mjs 写进去的树版本
 *    ③ package.json 的 @jinsiyu/dshcs-vscode-server 钉版 —— 树还没生成时的退路
 *  三级都读不到才算"基线缺失"(那是真环境问题,必须 exit 1 而不是猜一个版本)。 */
export function localBaseline(root) {
  const vendorJson = readJson(join(root, 'vendor', 'VENDOR.json'));
  if (typeof vendorJson?.codeServerVersion === 'string') {
    return { version: vendorJson.codeServerVersion, source: 'vendor/VENDOR.json', preparedAt: vendorJson.preparedAt ?? null };
  }
  const treePkg = readJson(join(root, 'vendor', 'vscode', 'package.json'));
  if (typeof treePkg?.version === 'string') {
    return { version: treePkg.version, source: 'vendor/vscode/package.json', preparedAt: null };
  }
  const pin = readJson(join(root, 'package.json'))?.dependencies?.['@jinsiyu/dshcs-vscode-server'];
  if (typeof pin === 'string') {
    return { version: pin, source: 'package.json dependencies.@jinsiyu/dshcs-vscode-server(树未生成时的退路)', preparedAt: null };
  }
  return null;
}

// ── 上游查询 ────────────────────────────────────────────────────────────────────────────────

/** 只写 "fetch failed" 是没法排查的(Node 的 fetch 把真因藏在 cause 里)——排障信息必须留在报告里。 */
export function describeError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errno ?? null;
  const parts = [error?.message ?? String(error)];
  if (code !== null) parts.push(`[${code}]`);
  if (typeof cause?.message === 'string' && cause.message !== error?.message) parts.push(cause.message);
  for (let e = cause?.cause; e !== undefined && e !== null; e = e.cause) {
    if (typeof e?.message === 'string') parts.push(e.message);
    else if (e?.code !== undefined) parts.push(`[${e.code}]`);
  }
  return [...new Set(parts)].join(' ');
}

async function fetchLatestOnce(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'dsh-code-server-app watch-upstream' },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (typeof json?.version !== 'string') throw new Error(`GET ${url} 的应答里没有 version`);
  return json.version;
}

/** 上游 latest。--fixture 时读本地 JSON(离线回归用),否则打 registry(带退避重试)。 */
export async function upstreamLatest() {
  const fixture = argValue('--fixture') ?? process.env.DSHCS_WATCH_FIXTURE ?? null;
  if (fixture !== null) {
    const abs = resolve(fixture);
    if (!existsSync(abs)) throw new Error(`--fixture ${abs} 不存在`);
    const json = readJson(abs);
    if (json === null) throw new Error(`--fixture ${abs} 不是合法 JSON`);
    const version = typeof json.version === 'string' ? json.version : json['dist-tags']?.latest;
    if (typeof version !== 'string') throw new Error(`--fixture ${abs} 里既没有 version 也没有 dist-tags.latest`);
    return { version, source: `fixture:${abs}`, attempts: 1 };
  }
  const url = `${REGISTRY}/${NPM_PACKAGE}/latest`;
  const tries = [];
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      const version = await fetchLatestOnce(url);
      return { version, source: url, attempts: i };
    } catch (error) {
      tries.push(`第 ${i}/${RETRIES} 次:${describeError(error)}`);
      if (i < RETRIES) await sleep(RETRY_DELAY_MS * i);
    }
  }
  throw new Error(`${RETRIES} 次都失败 —— ${tries.join(' | ')}`);
}

// ── 节流状态 ────────────────────────────────────────────────────────────────────────────────

export function readState(file) {
  const json = readJson(file);
  return json !== null && typeof json === 'object' ? json : {};
}

/** 要不要发这一次通知?三个分支都在报告里写明原因 —— "为什么没发"必须可见,
 *  否则「节流」和「通知坏了」在观感上一模一样(而这脚本存在的意义就是不要静默)。 */
export function shouldNotify(state, latest, now) {
  if (FORCE_NOTIFY) return { yes: true, why: '--force-notify' };
  if (state.lastNotifiedVersion !== latest) return { yes: true, why: '这个版本还没提醒过' };
  const last = Date.parse(state.lastNotifiedAt ?? '');
  if (!Number.isFinite(last)) return { yes: true, why: '上次提醒时间读不到,按"该提醒"处理' };
  const days = (now - last) / 86400000;
  if (days >= REMIND_EVERY_DAYS) return { yes: true, why: `距上次提醒已 ${days.toFixed(1)} 天(≥${REMIND_EVERY_DAYS} 天)` };
  return { yes: false, why: `同一版本 ${latest} 已于 ${state.lastNotifiedAt} 提醒过(节流 ${REMIND_EVERY_DAYS} 天)` };
}

// ── 系统通知(Windows 操作中心) ─────────────────────────────────────────────────────────────
// 2026-09-30 在本机(Windows 11 ARM64)实测出三条结论,都是这台机器上跑出来的、别再靠猜:
//   · [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
//     在 Windows PowerShell 5.1 下可用,中文标题/正文/图标都正常。
//   · **自定义 AUMID 也能送达**,不必借 PowerShell 那个已注册的 AUMID;但要在
//     HKCU\SOFTWARE\Classes\AppUserModelId\<AppId> 里写一个 DisplayName,通知署名才会显示成
//     「dsh-code-server-app 上游监控」,否则是一串 GUID。**这是本脚本唯一的系统副作用**,可用
//     --no-register-notify-id 关掉;它只是 HKCU 下的一个键,删掉即完全还原。
//   · 送达**可以验证**:$History.GetHistory($AppId)(带 applicationId 的那个重载)返回该 AppId 的
//     通知历史。不带参数的重载查的是"调用进程自己的 AUMID",在 powershell.exe 里必然报
//     0x80070490 ELEMENT_NOT_FOUND —— 一开始就是被这个假象误导的。有了它,报告里给的是
//     "已送达"的实证,而不是"命令没报错所以大概发出去了"。
// 为什么不弹 MsgBox 窗口:用户 2026-09-30 明确要求改成系统提示;而且 MsgBox 是模态窗口挡人,
//   还会被专注助手那类静默策略之外的场景反复打断。toast 进操作中心,有历史可回读。
// 编码坑:.ps1 保持**纯 ASCII**,中文全部走 UTF-8 的 payload JSON ——
//   Windows PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI 解,中文必乱(同一类坑在 .vbs 上也踩过)。

const xmlEscape = (text) => String(text)
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');

/** 第一条 text 是标题(粗体行),其余是正文行。 */
export function toastXml(lines) {
  const [title, ...body] = lines;
  return '<toast duration="long"><visual><binding template="ToastGeneric">'
    + `<text>${xmlEscape(title)}</text>`
    + body.map((line) => `<text>${xmlEscape(line)}</text>`).join('')
    + '</binding></visual></toast>';
}

/** 通知脚本(纯 ASCII,见上面"编码坑")。注册署名 → 弹 → 可选地回读通知历史核验送达。 */
export function notifierScript() {
  return [
    'param([string]$Payload)',
    "$ErrorActionPreference = 'Stop'",
    '$p = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json',
    "$key = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\' + $p.appId",
    'if ($p.register) {',
    '  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null; Write-Output \'REGISTERED\' }',
    "  Set-ItemProperty -Path $key -Name 'DisplayName' -Value $p.displayName",
    '}',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($p.xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `$toast.Tag = '${TOAST_TAG}'`,
    `$toast.Group = '${TOAST_GROUP}'`,
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($p.appId).Show($toast)',
    "Write-Output 'SHOWN'",
    'if ($p.verifySeconds -gt 0) {',
    '  Start-Sleep -Seconds $p.verifySeconds',
    '  try {',
    '    $h = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($p.appId)',
    `    $hit = @($h | Where-Object { $_.Tag -eq '${TOAST_TAG}' })`,
    '    if ($hit.Count -gt 0) { Write-Output "DELIVERED count=$($hit.Count)" }',
    '    else { Write-Output "NOT_DELIVERED history=$($h.Count)" }',
    '  } catch { Write-Output "VERIFY_ERROR $($_.Exception.Message)" }',
    '}',
    '',
  ].join('\r\n');
}

/** powershell.exe 一定在;万一被去掉就退到 pwsh。可用 DSHCS_WATCH_POWERSHELL 指定。 */
function powershellExe() {
  const forced = process.env.DSHCS_WATCH_POWERSHELL;
  if (typeof forced === 'string' && forced !== '') return forced;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
  return probe.error === undefined ? 'powershell.exe' : 'pwsh.exe';
}

/**
 * 发一条系统通知。返回 { shown, verified, channel, appId, registered, why }。
 * shown = Show() 执行过;verified = 通知历史里真的能查到它。
 */
export function notifyViaToast(lines, { verifySeconds = 3, register = true } = {}) {
  if (process.platform !== 'win32') return { shown: false, verified: false, channel: 'none', why: `系统通知只在 Windows 实现(当前 ${process.platform})` };
  const ps1 = join(tmpdir(), 'dshcs-upstream-watch.ps1');
  const payload = join(tmpdir(), 'dshcs-upstream-watch.json');
  try {
    mkdirSync(dirname(ps1), { recursive: true });
    writeFileSync(ps1, notifierScript(), 'utf8'); // 纯 ASCII,不需要 BOM
    writeFileSync(payload, JSON.stringify({
      appId: APP_ID, displayName: APP_DISPLAY_NAME, xml: toastXml(lines), register: register === true, verifySeconds: Number(verifySeconds) || 0,
    }), 'utf8');
  } catch (error) {
    return { shown: false, verified: false, channel: 'toast', appId: APP_ID, why: `写不出通知载荷(${ps1}):${error.code ?? error.message}` };
  }

  const exe = powershellExe();
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Payload', payload], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const out = res.stdout ?? '';
  const err = (res.stderr ?? '').trim();
  if (res.error !== undefined) {
    return { shown: false, verified: false, channel: 'toast', appId: APP_ID, why: `${exe} 起不来:${res.error.code ?? res.error.message}` };
  }
  if (!out.includes('SHOWN')) {
    return { shown: false, verified: false, channel: 'toast', appId: APP_ID, why: `${exe} 退出码 ${res.status},未执行到 Show():${err.split(/\r?\n/u)[0] || '(stderr 为空)'}` };
  }
  const registered = out.includes('REGISTERED');
  const verified = out.includes('DELIVERED');
  const historyLine = out.split(/\r?\n/u).find((line) => /^(NOT_DELIVERED|VERIFY_ERROR)/u.test(line)) ?? null;
  return {
    shown: true,
    verified,
    channel: 'toast',
    appId: APP_ID,
    registered,
    ...(verified || historyLine === null ? {} : { why: `Show() 已执行,但通知历史里查不到:${historyLine}` }),
    ...(err === '' ? {} : { stderr: err.split(/\r?\n/u)[0] }),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────────

function report(result) {
  const { local, upstream, status, notify } = result;
  say(`[watch] 上游 ${NPM_PACKAGE} latest:${upstream.version}(${upstream.source}${upstream.attempts > 1 ? `,重试 ${upstream.attempts} 次` : ''})`);
  say(`[watch] 内置树:${local.version}(${local.source}${local.preparedAt ? `,${local.preparedAt}` : ''})`);
  say('');
  if (status === 'update-available') {
    say(`[watch] ⚠ 有新版本:${local.version} → ${upstream.version}`);
    say('[watch] 升级链(顺序不能换,子包必须先重打重发):');
    for (const step of NEXT_STEPS) say(`[watch]   · ${step}`);
    say(`[watch] 通知:${notify.shown
      ? (notify.verified ? `已送达(Windows 操作中心,通知历史已核验;署名 ${APP_DISPLAY_NAME})` : `已发出但未能核验到(${notify.why ?? '未知'})`)
      : `未发出(${notify.why})`}`);
    if (notify.registered === true) say(`[watch] 顺带注册了通知署名:HKCU\\SOFTWARE\\Classes\\AppUserModelId\\${notify.appId} = ${APP_DISPLAY_NAME}(一次性,删掉即还原)`);
  } else if (status === 'current') {
    say('[watch] 已是最新,无需动作。');
    if (notify.requested === false) say(`[watch] 通知:未发(${notify.why})`);
  } else if (status === 'local-ahead') {
    say(`[watch] 本地基线比上游 latest 还新(${local.version} > ${upstream.version})——`
      + '可能上游撤版/回滚了 latest,也可能本地树来自一个还没发 latest 的版本,请人工确认。');
  } else {
    say(`[watch] 无法比较版本:本地 ${local.version} vs 上游 ${upstream.version}(不是 x.y.z 形态)。`);
  }
}

async function main() {
  const localOverride = argValue('--local');
  const local = localOverride !== null
    ? { version: localOverride, source: '--local 命令行覆盖', preparedAt: null }
    : localBaseline(pkgRoot);
  if (local === null) {
    say('[watch] 读不到本地基线:vendor/VENDOR.json、vendor/vscode/package.json 与 package.json 依赖里都没有版本。');
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: 'no-local-baseline' }, null, 2)}\n`);
    process.exit(1);
  }

  let upstream;
  try {
    upstream = await upstreamLatest();
  } catch (error) {
    say(`[watch] 上游检查失败:${error.message}`);
    say('[watch] 这是"检查失败",不是"没有更新" —— 两者必须区分,否则网络一坏就等于永不告警。');
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: 'upstream-unreachable', detail: error.message }, null, 2)}\n`);
    process.exit(1);
  }

  const cmp = compareVersions(upstream.version, local.version);
  const status = cmp === null ? 'uncomparable' : cmp > 0 ? 'update-available' : cmp < 0 ? 'local-ahead' : 'current';

  const state = readState(STATE_FILE);
  const decision = status === 'update-available'
    ? shouldNotify(state, upstream.version, Date.now())
    : { yes: false, why: '没有新版本' };
  const disabled = hasFlag('--no-notify') || process.env.DSHCS_WATCH_NO_NOTIFY === '1';
  const verifySeconds = Number(argValue('--notify-verify-seconds') ?? 3);
  const notify = (decision.yes && !disabled)
    ? notifyViaToast([
      '上游 code-server 有新版本',
      `内置树 ${local.version} → 上游 ${upstream.version}`,
      '下一步:pnpm run vendor:latest → repack:build → publish:repacks → 版本 +1 → pnpm pack',
    ], { verifySeconds, register: !hasFlag('--no-register-notify-id') })
    : { shown: false, verified: false, channel: 'toast', appId: APP_ID, why: disabled ? '按 --no-notify / DSHCS_WATCH_NO_NOTIFY 关闭' : decision.why };
  notify.requested = decision.yes;

  // **只在真的送达之后才记账**:否则一次 --no-notify 的例行检查会把额度用掉,
  // 而这个版本就再也不会通知用户 —— 那正是"静默漏报"。
  // verifySeconds=0 表示明知不做核验,此时按"已发出"记账。
  if (notify.shown && (notify.verified || verifySeconds === 0)) {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(STATE_FILE, `${JSON.stringify({
        lastNotifiedVersion: upstream.version,
        lastNotifiedAt: new Date().toISOString(),
        localVersionAtNotify: local.version,
        notifyChannel: notify.channel,
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      say(`[watch] 警告:提醒状态写不进去(${STATE_FILE}):${error.code ?? error.message} —— 下次可能重复通知。`);
    }
  }

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    status,
    upstream,
    local,
    notify: {
      requested: notify.requested,
      shown: notify.shown,
      verified: notify.verified,
      channel: notify.channel,
      appId: notify.appId,
      ...(notify.registered === undefined ? {} : { registeredIdentity: notify.registered }),
      why: notify.why ?? null,
      reason: decision.why,
    },
    ...(status === 'update-available' ? { next: NEXT_STEPS } : {}),
  };
  report(result);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (status === 'update-available' && FAIL_ON_UPDATE) {
    if (!JSON_MODE) say('[watch] --fail-on-update:有更新 ⇒ exit 2。');
    process.exit(2);
  }
  process.exit(0);
}

// 被 import 时(回归脚本取纯函数)不执行主流程;直接 node 跑时才执行。
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
