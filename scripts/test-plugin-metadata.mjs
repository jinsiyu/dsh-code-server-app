// scripts/test-plugin-metadata.mjs —— 「插件页图标与文案」守约:把 DSH 宿主解析插件展示元数据时的
// **硬约束**和**两个静默失败模式**在本地钉住。
//
// 契约来源(逐行读过,本机 0.1.7-alpha.1 树内 @deepseek-ai/dsh-app-boot 的 readPluginMeta):
//   · 图标 = package.json 顶层 `icon`,经 iconOf(manifest.icon, manifestPath) 解析:
//       必须相对路径(绝对路径或带 scheme 一律抛错)、扩展名 ∈ {svg,png,jpg,jpeg,webp}、
//       realpath 后必须仍在 manifest 目录内、必须是常规文件、原始字节 ≤ 256 KiB;
//       宿主把它转成 `data:<mediaType>;base64,…` 交给前端(<img src>),**不放进 exports**。
//   · 文案 = 先解析 `<包>/locale/en.json` 作为锚点,再枚举同目录下的 *.json;
//       每个文件读 `meta.title` / `meta.description`(非空字符串);语言名 = 文件名,须匹配
//       LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,按小写去重。
//       词典走**模块解析器**(resolvePluginResource) ⇒ 必须在 package.json 的 `exports` 里暴露
//       `./locale/*.json`,否则 ERR_PACKAGE_PATH_NOT_EXPORTED 被当成"没有词典"而**静默不本地化**。
//
// 两个静默失败模式(错了界面上什么都不说,只退化):
//   ① 图标非法/缺失 ⇒ 退化成占位图形(宿主只记一条 meta.error);
//   ② 词典没导出    ⇒ 英文界面继续显示 manifest.description(我们那份是 2000 字长文)。
// 所以这个脚本既查"值对不对",也查"通道通不通"。
//
// 用法:node scripts/test-plugin-metadata.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep, win32 } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(pkgRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

/** 宿主 iconOf 的白名单(扩展名 → media type),这里只取键。 */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
/** 宿主 MAX_ICON_BYTES。 */
const MAX_ICON_BYTES = 256 * 1024;
/** 宿主 LANGUAGE_ID。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
/** 展示文案的长度上限:插件页一行放不下更长的东西(超了就该改文案,而不是让它被截断)。 */
const MAX_TITLE = 40;
const MAX_DESCRIPTION = 140;

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

/** files 白名单是否覆盖某个仓库相对路径(精确条目或落在某个目录条目下)。 */
function covered(rel) {
  const posix = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  return files.some((entry) => {
    const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return posix === e || posix.startsWith(e + '/');
  });
}

/** 列出 locale 目录下的词典文件(相对仓库根的 posix 路径)。 */
function localeFiles() {
  const dir = join(pkgRoot, 'locale');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => `locale/${e.name}`)
    .sort();
}

const iconRel = typeof pkg.icon === 'string' ? pkg.icon : null;

await test('package.json 声明了 icon,且是相对路径、扩展名在白名单里', async () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json 缺 icon 字段(插件页会退化成占位图形)');
  assert.ok(pkg.icon.trim() !== '', 'icon 不能是空串(宿主 textOf 会抛错)');
  assert.ok(!isAbsolute(pkg.icon) && !win32.isAbsolute(pkg.icon), `icon 必须是相对路径: ${pkg.icon}`);
  assert.ok(!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(pkg.icon), `icon 不能带 scheme(data:/http: 都会被宿主拒绝): ${pkg.icon}`);
  const ext = extname(pkg.icon).toLowerCase();
  assert.ok(ICON_MEDIA_TYPES.has(ext), `icon 扩展名必须属于 ${[...ICON_MEDIA_TYPES.keys()].join('/')},实际 ${ext}`);
});

await test('icon 指向的文件存在、在包内、是常规文件、且不超过 256 KiB', async () => {
  assert.ok(iconRel !== null, '上一条用例已报缺 icon');
  const abs = join(pkgRoot, iconRel);
  assert.ok(existsSync(abs), `icon 文件不存在: ${iconRel}`);
  const real = realpathSync(abs);
  const rootReal = realpathSync(pkgRoot);
  const rel = relative(rootReal, real);
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `icon 必须留在包目录内(宿主按 realpath 判),实际逃出到 ${real}`);
  assert.ok(statSync(real).isFile(), `icon 必须是常规文件: ${iconRel}`);
  const size = statSync(real).size;
  assert.ok(size <= MAX_ICON_BYTES, `icon 超过宿主上限 256 KiB,实际 ${size} B`);
});

await test('icon 文件被 package.json 的 files 覆盖(否则装完就没有它)', async () => {
  assert.ok(iconRel !== null, '上一条用例已报缺 icon');
  assert.ok(covered(iconRel), `icon 文件没进 files 白名单: ${iconRel}`);
});

await test('icon 能被当作 <img src=data:…> 用:无外部引用、无脚本、有 viewBox', async () => {
  assert.ok(iconRel !== null, '上一条用例已报缺 icon');
  if (extname(iconRel).toLowerCase() !== '.svg') return; // 位图无需这些检查
  const svg = readFileSync(join(pkgRoot, iconRel), 'utf8');
  assert.ok(!/<script[\s>]/iu.test(svg), '图标 SVG 里不该有 <script>(会被 data: URL 内联进界面)');
  assert.ok(!/(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(svg), '图标 SVG 不该引用外部资源(内联后取不到)');
  assert.ok(!/url\(\s*["']?(?:https?:)?\/\//iu.test(svg), '图标 SVG 不该用外部 url()(内联后取不到)');
  assert.ok(/viewBox\s*=/iu.test(svg), '图标 SVG 缺 viewBox ⇒ 缩放到图标框里会丢比例');
});

await test('locale/en.json 存在(宿主的本地化锚点:缺了就等于没有词典)', async () => {
  assert.ok(existsSync(join(pkgRoot, 'locale', 'en.json')),
    '缺 locale/en.json —— 宿主不枚举任何词典,插件页会退回 manifest.description 长文');
});

await test('每个词典文件:文件名是合法语言 id、meta.title/description 为非空字符串、键集一致', async () => {
  const files = localeFiles();
  assert.ok(files.length > 0, 'locale/ 下没有任何 *.json');
  const seen = new Map();
  let reference = null;
  for (const rel of files) {
    const name = rel.slice('locale/'.length, -'.json'.length);
    assert.ok(LANGUAGE_ID.test(name), `${rel}: 文件名必须是语言 id(${LANGUAGE_ID})`);
    const id = name.toLowerCase();
    assert.ok(!seen.has(id), `${rel}: 与 ${seen.get(id)} 重复(宿主按小写去重会抛错)`);
    seen.set(id, rel);
    const parsed = JSON.parse(readFileSync(join(pkgRoot, rel), 'utf8'));
    const meta = parsed.meta;
    assert.ok(meta !== null && typeof meta === 'object' && !Array.isArray(meta), `${rel}: 缺 meta 对象`);
    const keys = Object.keys(meta).sort();
    assert.deepEqual(keys, ['description', 'title'],
      `${rel}: meta 的键必须恰好是 description + title(宿主只读这两个;多写的键是死重量)`);
    for (const key of keys) {
      assert.equal(typeof meta[key], 'string', `${rel}: meta.${key} 必须是字符串`);
      assert.ok(meta[key].trim() !== '', `${rel}: meta.${key} 不能为空(宿主 textOf 会抛错)`);
    }
    if (reference === null) reference = { rel, keys };
  }
  for (const rel of files) {
    const meta = JSON.parse(readFileSync(join(pkgRoot, rel), 'utf8')).meta;
    assert.deepEqual(Object.keys(meta).sort(), reference.keys,
      `${rel}: 键集与 ${reference.rel} 不一致(新语言只覆盖一半会让该语言缺标题或缺描述)`);
  }
});

await test('词典文案长度在插件页一行放得下(title ≤ 40、description ≤ 140)', async () => {
  for (const rel of localeFiles()) {
    const meta = JSON.parse(readFileSync(join(pkgRoot, rel), 'utf8')).meta;
    assert.ok(meta.title.length <= MAX_TITLE, `${rel}: title ${meta.title.length} 字,超过 ${MAX_TITLE}`);
    assert.ok(meta.description.length <= MAX_DESCRIPTION,
      `${rel}: description ${meta.description.length} 字,超过 ${MAX_DESCRIPTION}(会被行宽截断)`);
    assert.ok(!meta.description.includes('\n'), `${rel}: description 不能换行`);
  }
});

await test('exports 里暴露了 ./locale/*.json(不导出 ⇒ 宿主静默不本地化)', async () => {
  const exp = pkg.exports;
  assert.ok(exp !== null && typeof exp === 'object', 'package.json 缺 exports');
  const key = Object.keys(exp).find((k) => k === './locale/*.json' || k.startsWith('./locale/'));
  assert.ok(key !== undefined,
    'exports 里没有 ./locale/*.json —— 宿主用模块解析器取 ${specifier}/locale/en.json,会拿到 '
    + 'ERR_PACKAGE_PATH_NOT_EXPORTED 并当成"没有词典"(界面继续显示 manifest.description)');
  const value = String(exp[key]);
  assert.ok(value.includes('locale/'), `exports["${key}"] 应指向 locale/ 下的文件,实际 ${value}`);
});

await test('文案来自词典而不是 manifest.description(后者是给 npm 页面看的长文)', async () => {
  const longDescription = String(pkg.description ?? '');
  assert.ok(longDescription.length > MAX_DESCRIPTION,
    'manifest.description 已经够短了 —— 那么这条守卫失去了意义,请重新确认本地化是否还有必要');
  const en = JSON.parse(readFileSync(join(pkgRoot, 'locale', 'en.json'), 'utf8')).meta;
  assert.notEqual(en.description, longDescription,
    'en.json 的 description 不能等于 manifest.description(否则英文界面照样是长文)');
  assert.equal(pkg.title, undefined,
    'package.json 的顶层 title 不会被宿主读取(readPluginMeta 只认词典与 manifest.name),别写它');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
