/**
 * scripts/build-webview.mjs —— 把「问 DSH」面板打成两个静态资源(0.2.3 起)。
 *
 * ## 打的是什么
 * `assets/extensions/dshcs-editor-bridge/webview/src/app.jsx`(面板外壳:React 视图 + 授权卡片)
 * 加上 **DSH 官方 markdown 渲染器**:
 *
 *   - `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` —— 与 DSH 界面**同一份**代码:
 *     同一套 micromark/mdast 管线、同一个增量流式解析器、同一个 shiki 高亮、同一套 CSS 模块;
 *   - `@deepseek-ai/dsh-client-ui-theme` 里的官方设计令牌(`--dsw-*` 排版、`--shiki-*` 高亮配色、
 *     `--dsh-scrollbar-width` 等) —— 这些 CSS 不随包发布(被内联进 `lib/client.js` 的字符串),
 *     所以脚本从那份发布物里**原样抽出来**,生成 `webview/src/official-tokens.css`。
 *
 * 为什么要这一步:面板正文在 0.2.0–0.2.2 是自己拼 HTML、按 `white-space: pre-wrap` 原样显示,
 * 和 DSH 界面的排版完全不同;0.2.3 起正文交给官方渲染器 —— 而官方渲染器要打包
 * (React + micromark + shiki + 令牌),所以有了这个脚本。
 *
 * ## 产物(与 lib/client.js 一样是构建产物,不入 git;随 npm 包发布)
 *   assets/extensions/dshcs-editor-bridge/webview/thread.js       面板脚本(IIFE)
 *   assets/extensions/dshcs-editor-bridge/webview/thread.css      面板样式(官方令牌 + 外壳)
 *   assets/extensions/dshcs-editor-bridge/webview/THIRD-PARTY.md  打包进来的第三方包与许可
 *   assets/extensions/dshcs-editor-bridge/webview/src/official-tokens.css  抽出来的官方令牌表(中间产物)
 *
 * ## 版本一致性
 * 渲染器必须和 DSH 部署的界面**同版本**:脚本读 DSH 部署里 `@deepseek-ai/dsh-web-frontend`
 * 的版本(那份 UI 就在它里面),与本仓库 devDependency 的版本比对,不一致直接报错退出
 * (`--allow-version-mismatch` 放行,用于"先升 DSH 再重打")。运行期面板还会拿宿主回报的
 * `uiVersion` 再比一次,不一致就在面板顶部显示一行提示。
 *
 * ## 已知取舍(README 与 docs 里同样写明)
 *   1. shiki 只带 DSH 启动集的三套语法(typescript / shellscript / json);
 *      官方那些懒加载语法(约 1.6MB)在面板里换成"空注册" —— 那些语言纯文本显示,不报错;
 *   2. 面板只渲染**新内容**(宿主不重放历史),工具/授权是紧凑摘要行,不是官方的逐工具卡片。
 * KaTeX(数学公式)默认**打包**(+约 540KB,含 254KB woff2 字体),这样公式排版与 DSH 界面
 * 完全一致;要省体积可以 `--no-katex`,那时公式按字面 TeX 文本显示。
 *
 * ## 为什么用 CLI 而不是 esbuild 的 JS API
 * JS API 会以 `stdio: ["pipe","pipe","inherit"]` 拉起 esbuild 服务进程;在本仓库的
 * workspace-write 沙箱里**子进程管道的创建被拒**(spawn EPERM)。CLI 走的是
 * `execFileSync(binPath, args, { stdio: "inherit" })`(继承标准流),沙箱内可用 ——
 * 代价是不能用插件,所以这里把"虚拟模块"落成真实文件(`.tmp-webview/` 与 official-tokens.css)。
 *
 * 用法: node scripts/build-webview.mjs [--no-katex] [--all-grammars] [--allow-version-mismatch]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

import { dshEntry } from '../lib/dsh-resolve.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'assets', 'extensions', 'dshcs-editor-bridge');
const webviewDir = path.join(extDir, 'webview');
const srcDir = path.join(webviewDir, 'src');
const tmpDir = path.join(root, '.tmp-webview');

const argv = new Set(process.argv.slice(2));
const withKatex = !argv.has('--no-katex');
const allGrammars = argv.has('--all-grammars');
const allowMismatch = argv.has('--allow-version-mismatch');

/** esbuild 只吃正斜杠路径(Windows 反斜杠会被当成转义)。 */
function slash(file) {
  return file.replace(/\\/g, '/');
}

/** 一个包解析成磁盘目录(拿它的 package.json)。 */
function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

/** 读一个 package.json 的 version(读不到返回 null)。 */
function packageVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 人类可读的大小。 */
function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ---------------------------------------------------------------- 版本核对

const RENDERER_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives';
const rendererDir = packageDir(RENDERER_PACKAGE);
const themeDir = packageDir('@deepseek-ai/dsh-client-ui-theme');
const rendererVersion = packageVersion(path.join(rendererDir, 'package.json'));
const themeVersion = packageVersion(path.join(themeDir, 'package.json'));

/** DSH 部署里 UI 的版本(`dsh-web-frontend` 里就带着这份渲染器)。 */
function deployedUiVersion() {
  const entry = dshEntry();
  if (entry === null) return null;
  const candidates = [
    path.join(path.dirname(entry), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json'),
    path.join(path.dirname(entry), '..', 'dsh-web-frontend', 'package.json'),
  ];
  for (const candidate of candidates) {
    const version = packageVersion(candidate);
    if (version !== null) return version;
  }
  return null;
}

const deployed = deployedUiVersion();
console.log(`[webview] 渲染器:${RENDERER_PACKAGE}@${rendererVersion}`);
console.log(`[webview] 设计令牌:@deepseek-ai/dsh-client-ui-theme@${themeVersion}`);
console.log(`[webview] DSH 部署的界面版本:${deployed ?? '(没有找到 DSH 部署,跳过比对)'}`);
if (deployed !== null && rendererVersion !== null && deployed !== rendererVersion && !allowMismatch) {
  console.error(
    `[webview] 版本不一致:部署里的界面是 ${deployed},而 devDependency 是 ${rendererVersion}。\n`
    + '          面板会和 DSH 界面长得不一样。请把 package.json 里的 '
    + `${RENDERER_PACKAGE} / @deepseek-ai/dsh-client-ui-theme 升到 ${deployed} 后重跑;`
    + '确实要先用旧版渲染器打包时加 --allow-version-mismatch。',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- 官方设计令牌

/**
 * markdown / 代码块样式依赖的令牌(少任何一个都要报出来 —— 不静默降级)。
 * `--dsl-code-block-*` 不在令牌表里:它们由 ui-primitives 的 CodeBlock.module.css 自己定义。
 */
const REQUIRED_TOKENS = [
  '--ds-font-family-code',
  '--dsw-font-family',
  '--dsw-font-markdown-base',
  '--dsw-font-markdown-h1',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-inline-code',
  '--shiki-token-keyword',
  '--dsh-scrollbar-width',
];

/**
 * 从一段 CSS 里抠出"令牌块":选择器是 `:root` / `body` / `body[data-…]` 的块,
 * 每个块只保留**本层**的 `--` 自定义属性声明;`@media` / `@supports` 里的继续往下找。
 * 这样既能拿到官方令牌,又保证注入 DSH 页面时不会带上任何普通声明(那会改掉宿主界面)。
 */
function extractTokenBlocks(css) {
  const out = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const selector = css.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = css.slice(open + 1, cursor - 1);
    if (/^(?::root|html|body)(\[[^\]]*\])*$/.test(selector)) {
      // 去掉嵌套块后只留本层声明;分号切分即可(值里不含裸分号以外的东西)。
      const flat = body.replace(/\{[^{}]*\}/g, '');
      const declarations = flat
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration.startsWith('--'));
      if (declarations.length > 0) out.push(`${selector} {\n${declarations.join(';\n')};\n}`);
    } else if (selector.startsWith('@')) {
      out.push(...extractTokenBlocks(body));
    }
    index = cursor;
  }
  return out;
}

/**
 * 从 ui-theme 的 client.js 里抽出官方令牌表(CSS 文本 = "顶层为 :root/body 的字面量")。
 *
 * **只保留自定义属性声明**(`--x: …;`):0.2.5 起面板会被注入 DSH 页面里当浮动对话框,
 * 官方令牌表里若有普通声明(background / font-family …)就会**改掉宿主界面**。
 * 令牌本身(--dsw-* / --shiki-*)在 DSH 页面里是同样的值,重定义一次幂等;普通声明一律丢掉。
 */
function extractOfficialTokens() {
  const file = path.join(themeDir, 'lib', 'client.js');
  const source = fs.readFileSync(file, 'utf8');
  const sheets = [];
  const literal = /"(?:\\.|[^"\\])*"/g;
  let match;
  while ((match = literal.exec(source)) !== null) {
    const text = match[0].slice(1, -1);
    if (text.length < 200 || !text.includes('--')) continue;
    // 只认"整段就是样式表"的字符串(组件 CSS 是 .class{…} / @media… 也行,里面同样只有令牌)。
    if (!/^(?::root|body|html|@)/.test(text)) continue;
    sheets.push(...extractTokenBlocks(text.replace(/\\"/g, '"').replace(/\\n/g, '\n')));
  }
  // `--dsh-scrollbar-width` 只出现在上面那张嵌套表里(滚动条样式),这里补官方值兜底:
  // webview 里没有 DSH 页面替我们定义它,少了它代码块的 `scrollbar-width` 会无效(不致命,但没必要)。
  const scrollbarWidth = '--dsh-scrollbar-width';
  const fallback = sheets.join('\n').includes(scrollbarWidth)
    ? []
    : ['/* 兜底:官方 scrollbar.css 里那条(嵌套 @supports 块,不整段注入)。 */', 'body { --dsh-scrollbar-width: 8px; }'];
  const css = [
    '/* 官方设计令牌(DSH 界面同一套):由 scripts/build-webview.mjs 从',
    ` * @deepseek-ai/dsh-client-ui-theme@${themeVersion} 的 lib/client.js 内联 CSS 原样抽出;`,
    ' * **只保留 -- 自定义属性声明**(普通声明会把宿主 DSH 页面也改掉)。',
    ' * 不要手改 —— 这个文件是生成物,重新构建会覆盖。 */',
    ...sheets,
    ...fallback,
    '',
  ].join('\n');
  const missing = REQUIRED_TOKENS.filter((token) => !css.includes(token));
  return { css, sheets: sheets.length, missing, file };
}

const officialTokens = extractOfficialTokens();
fs.writeFileSync(path.join(srcDir, 'official-tokens.css'), officialTokens.css, 'utf8');
console.log(`[webview] 官方令牌表:${officialTokens.sheets} 段 → src/official-tokens.css(${kb(Buffer.byteLength(officialTokens.css))})`);
if (officialTokens.missing.length > 0) {
  console.error(
    `[webview] 警告:官方令牌表里没有这些令牌 —— ${officialTokens.missing.join(' ')}\n`
    + `          来源:${officialTokens.file}\n`
    + '          面板会退回继承编辑器的字体/颜色,排版会与 DSH 界面不一致(不静默:这里明确报出来)。',
  );
}

// ---------------------------------------------------------------- 替身模块(CLI 没有插件)

fs.mkdirSync(tmpDir, { recursive: true });

/** 懒加载语法的替身:空注册 = 该语言按官方的降级路径纯文本显示。 */
const stubGrammar = path.join(tmpDir, 'stub-grammar.js');
fs.writeFileSync(
  stubGrammar,
  '/* 面板不带这套 shiki 语法(官方的懒加载集,约 1.6MB):空注册 = 纯文本降级。 */\nexport default [];\n',
  'utf8',
);

/** KaTeX 替身(只在 `--no-katex` 时用):公式按字面 TeX 文本显示,不假装排版。 */
const katexStub = path.join(tmpDir, 'katex-stub.js');
fs.writeFileSync(
  katexStub,
  [
    '/* 面板不带 KaTeX(--no-katex):公式按字面 TeX 文本显示。 */',
    'function escape(text) {',
    "  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
    '}',
    'export default {',
    '  renderToString(source) {',
    '    return `<span class="dshcs-tex" style="font-family: var(--ds-font-family-code, monospace)">${escape(source)}</span>`;',
    '  },',
    '};',
    '',
  ].join('\n'),
  'utf8',
);
const katexCssStub = path.join(tmpDir, 'katex-css-stub.css');
fs.writeFileSync(katexCssStub, '/* 面板不带 KaTeX(--no-katex)。 */\n', 'utf8');

/** 官方懒加载语法名:从渲染器发布物里现读(不硬编码,官方加了语言这里自动跟上)。 */
function lazyGrammarNames() {
  const entry = fs.readFileSync(path.join(rendererDir, 'lib', 'index.js'), 'utf8');
  const names = new Set();
  for (const m of entry.matchAll(/import\(\s*["']@shikijs\/langs\/([a-z0-9-]+)["']\s*\)/g)) names.add(m[1]);
  return [...names].sort();
}

// ---------------------------------------------------------------- 打包

const aliases = [];
if (!withKatex) {
  aliases.push(`--alias:katex=${slash(katexStub)}`);
  aliases.push(`--alias:katex/dist/katex.min.css=${slash(katexCssStub)}`);
}
const grammars = lazyGrammarNames();
if (!allGrammars) {
  for (const name of grammars) aliases.push(`--alias:@shikijs/langs/${name}=${slash(stubGrammar)}`);
}

const metaFile = path.join(tmpDir, 'meta.json');
const args = [
  slash(path.join(srcDir, 'app.jsx')),
  '--bundle',
  '--format=iife',
  '--platform=browser',
  '--target=chrome120',
  '--jsx=automatic',
  '--minify',
  '--legal-comments=none',
  `--outdir=${slash(webviewDir)}`,
  '--entry-names=thread',
  '--asset-names=fonts/[name]-[hash]',
  `--metafile=${slash(metaFile)}`,
  '--log-level=warning',
  '--loader:.module.css=local-css',
  ...(withKatex
    // 字体**内联成 data URI**(0.2.5 起):面板 CSS 会被注入 DSH 页面当浮动对话框,
    // 相对 `fonts/...` 的 url() 在那边解析不到(404);内联后 CSS 自带字体,注入哪里都完整。
    ? ['--loader:.woff2=dataurl', '--loader:.woff=empty', '--loader:.ttf=empty']
    : ['--loader:.woff2=empty', '--loader:.woff=empty', '--loader:.ttf=empty']),
  '--define:process.env.NODE_ENV="production"',
  `--define:__DSHCS_RENDERER_VERSION__=${JSON.stringify(rendererVersion ?? '')}`,
  `--define:__DSHCS_RENDERER_PACKAGE__=${JSON.stringify(RENDERER_PACKAGE)}`,
  ...aliases,
];

/** 跑 esbuild:优先直接执行平台二进制(继承标准流),否则退回 node 版包装脚本。 */
function runEsbuild(esbuildArgs) {
  const platformPkg = `@esbuild/${process.platform}-${process.arch}`;
  const candidates = process.platform === 'win32'
    ? [`${platformPkg}/esbuild.exe`, `${platformPkg}/bin/esbuild`]
    : [`${platformPkg}/bin/esbuild`];
  for (const candidate of candidates) {
    let file;
    try {
      file = require.resolve(candidate);
    } catch {
      continue;
    }
    try {
      execFileSync(file, esbuildArgs, { stdio: 'inherit', cwd: root });
      return true;
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.status !== undefined && error.status !== 0) {
        // esbuild 自己报的错(退出码非 0):原样上抛,不要再试别的路径。
        throw error;
      }
      // 连二进制都起不来(EPERM/ENOENT)→ 试下一个
    }
  }
  const wrapper = require.resolve('esbuild/bin/esbuild');
  const result = spawnSync(process.execPath, [wrapper, ...esbuildArgs], { stdio: 'inherit', cwd: root });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return true;
}

console.log(`[webview] esbuild:${grammars.length} 套懒加载语法${allGrammars ? '(--all-grammars:全部打包)' : '换成空注册'},KaTeX ${withKatex ? '打包' : '不打'}`);
const started = Date.now();
runEsbuild(args);
console.log(`[webview] 打包完成(${Date.now() - started}ms)`);

// ---------------------------------------------------------------- 产物大小

const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
console.log('[webview] 产物:');
let total = 0;
for (const [file, info] of Object.entries(meta.outputs).sort((a, b) => b[1].bytes - a[1].bytes)) {
  if (info.entryPoint === undefined && !file.endsWith('.css') && !file.endsWith('.js')) continue;
  total += info.bytes;
  console.log(`  ${slash(path.relative(root, file))}  ${kb(info.bytes)}`);
}
console.log(`  合计 ${kb(total)}`);

// ---------------------------------------------------------------- 第三方许可证

/** 打包进产物的第三方包(直接依赖 + 它们的运行时依赖)。 */
function collectPackages() {
  const seen = new Map();
  const queue = [RENDERER_PACKAGE, '@deepseek-ai/dsh-client-ui-theme', 'react', 'react-dom'];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    let dir;
    try {
      dir = packageDir(name);
    } catch {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    seen.set(name, { name, version: manifest.version, license: manifest.license ?? '(见包内 LICENSE)' });
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const packages = collectPackages();
const thirdParty = [
  '# 面板 webview 打包进去的第三方代码',
  '',
  '本目录下的 `thread.js` / `thread.css` 由 `scripts/build-webview.mjs` 打包生成,',
  '其中包含下列第三方包(全部 MIT 许可)。它们不是本插件的代码,原样打包只为让面板的消息正文',
  '与 DSH 界面完全一致(markdown 管线 / 语法高亮 / 排版令牌)。',
  '',
  '| 包 | 版本 | 许可 |',
  '| --- | --- | --- |',
  ...packages.map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  `生成时间:${new Date().toISOString()}`,
  `渲染器:${RENDERER_PACKAGE}@${rendererVersion}(DSH 部署的界面版本:${deployed ?? '未知'})`,
  `设计令牌:@deepseek-ai/dsh-client-ui-theme@${themeVersion}(${officialTokens.sheets} 段)`,
  `KaTeX:${withKatex ? '已打包(公式排版与 DSH 界面一致)' : '未打包(--no-katex:公式按字面 TeX 显示)'}`,
  `shiki 语法:${allGrammars ? '全部(官方懒加载集)' : 'typescript / shellscript / json(与 DSH 启动集一致)'}`,
  officialTokens.missing.length === 0
    ? '令牌自检:通过'
    : `令牌自检:缺少 ${officialTokens.missing.join(' ')}`,
  '',
  '许可证原文见各包目录下的 LICENSE 文件(例如 `node_modules/@deepseek-ai/dsh-client-ui-primitives/LICENSE`)。',
  '',
];
fs.writeFileSync(path.join(webviewDir, 'THIRD-PARTY.md'), thirdParty.join('\n'), 'utf8');
console.log('[webview] 已写入 THIRD-PARTY.md');

const fontDir = path.join(webviewDir, 'fonts');
if (fs.existsSync(fontDir)) {
  const fonts = fs.readdirSync(fontDir);
  const bytes = fonts.reduce((sum, name) => sum + fs.statSync(path.join(fontDir, name)).size, 0);
  console.log(`[webview] 字体文件:${fonts.length === 0 ? '无' : `${fonts.length} 个(${kb(bytes)})`}`);
}
