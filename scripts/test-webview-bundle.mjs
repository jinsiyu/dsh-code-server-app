// scripts/test-webview-bundle.mjs —— 「问 DSH」面板 webview 的打包回归(0.2.3)
//
// 面板的真身是 `scripts/build-webview.mjs` 打出来的两个静态资源(thread.js / thread.css):
// 面板脚本体是 React 视图 + **DSH 官方 markdown 渲染器**
// (`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`),样式里带着官方的设计令牌
// (从 `@deepseek-ai/dsh-client-ui-theme` 的发布物里抽出来的 `--dsw-*` / `--shiki-*` / `--dsh-*`)。
//
// 这里守四件事:
//   W1 **产物必须在**(`pnpm pack` 之前跑的是 build:webview,漏了就会开出一个空白面板);
//   W2 **渲染器版本必须与 devDependency 一致**(版本错配 = 面板与 DSH 界面排版不一致);
//   W3 **官方令牌必须在样式里**(少了令牌,markdown 会退回"没排版"的样子:标题没字号、
//      代码块没底色、高亮没颜色 —— 而这正是这次要修的东西);
//   W4 **宿主/扩展两侧的接线在位**(/sync 给 thread/approvals/approvalHoldMs/uiVersion,
//      扩展上报 watch 列表并把对话流并进面板状态)。
//
// 用法:node scripts/test-webview-bundle.mjs   (先跑 pnpm run build:webview 或 prepack)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const EXT = '../assets/extensions/dshcs-editor-bridge';
const WEBVIEW = `${EXT}/webview`;

let pass = 0;
let fail = 0;
let skip = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    if (error && error.dshcsSkip === true) {
      skip += 1;
      console.log(`SKIP ${name}:${error.message}`);
      return;
    }
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));
const extPkg = JSON.parse(read(`${EXT}/package.json`));
const rendererVersion = pkg.devDependencies['@deepseek-ai/dsh-client-ui-primitives'];
const themeVersion = pkg.devDependencies['@deepseek-ai/dsh-client-ui-theme'];
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;

/** 产物缺失:这是"没跑构建",不是代码错 —— 标 SKIP 并说清楚怎么修(不静默通过)。 */
function requireArtifact(relative) {
  const url = new URL(relative, import.meta.url);
  if (!existsSync(url)) {
    const skipped = new Error(`缺少 ${relative}:先跑 pnpm run build:webview(或 pnpm pack,prepack 会跑)`);
    skipped.dshcsSkip = true;
    throw skipped;
  }
  return url;
}

// ---------------------------------------------------------------- W1 产物

await test('webview 产物:thread.js / thread.css / THIRD-PARTY.md 都在,大小落在合理区间', () => {
  for (const relative of [`${WEBVIEW}/thread.js`, `${WEBVIEW}/thread.css`, `${WEBVIEW}/THIRD-PARTY.md`]) {
    requireArtifact(relative);
  }
  const js = statSync(new URL(`${WEBVIEW}/thread.js`, import.meta.url)).size;
  const css = statSync(new URL(`${WEBVIEW}/thread.css`, import.meta.url)).size;
  // 下界:少于 300KB 说明官方渲染器根本没打进去(React + micromark + shiki + katex 不可能更小)。
  assert.ok(js > 300 * 1024, `thread.js 只有 ${kb(js)}:官方渲染器没被打进去?`);
  assert.ok(js < 4 * 1024 * 1024, `thread.js 有 ${kb(js)}:打包失控(是不是把懒加载语法全带上了?)`);
  assert.ok(css > 20 * 1024, `thread.css 只有 ${kb(css)}:官方令牌表没进去?`);
  assert.ok(css < 1024 * 1024, `thread.css 有 ${kb(css)}:异常`);
  // KaTeX 默认打包:字体要在(数学公式的排版全靠它们)。
  const fonts = readdirSync(new URL(`${WEBVIEW}/fonts`, import.meta.url));
  assert.ok(fonts.some((name) => name.endsWith('.woff2')), 'KaTeX 字体缺失(默认会打包;是不是用了 --no-katex?)');
  // 扩展目录整包发布 ⇒ 产物随 npm 包走(files 里有 assets/extensions/dshcs-editor-bridge)。
  assert.ok(pkg.files.includes('assets/extensions/dshcs-editor-bridge'), '产物必须在 npm 包的文件清单里');
  assert.equal(pkg.scripts['build:webview'], 'node scripts/build-webview.mjs');
  assert.match(pkg.scripts.prepack, /build-webview\.mjs/, 'prepack 必须重新构建 webview(不然发的还是旧面板)');
});

await test('webview 产物:第三方许可写清楚(MIT,与源码一起发布)', () => {
  const third = read(`${WEBVIEW}/THIRD-PARTY.md`);
  assert.match(third, /@deepseek-ai\/dsh-client-ui-primitives/, '要写明打包了官方渲染器');
  assert.match(third, /@deepseek-ai\/dsh-client-ui-theme/, '要写明打包了官方设计令牌');
  assert.match(third, /MIT/, '许可是 MIT');
  assert.match(third, new RegExp(rendererVersion.replace(/\./g, '\\.')), '要写上渲染器版本');
  assert.match(third, /令牌自检:通过/, '令牌自检必须通过(缺令牌要报出来,不许静默降级)');
});

// ---------------------------------------------------------------- W2 渲染器版本

await test('渲染器版本:产物里注入的版本 = devDependency 钉住的版本', () => {
  const js = readFileSync(requireArtifact(`${WEBVIEW}/thread.js`), 'utf8');
  assert.ok(js.includes(rendererVersion), `产物里没找到渲染器版本 ${rendererVersion}(构建时没注入?)`);
  assert.ok(js.includes('@deepseek-ai/dsh-client-ui-primitives'), '产物里要带上包名(版本提示用)');
  // 设计令牌的版本也要一致(两边都是同一版 DSH 界面出来的)。
  assert.equal(themeVersion, rendererVersion, 'ui-primitives 与 ui-theme 必须同版本(同一版 DSH 的界面)');
  const extPkgVersion = extPkg.version;
  assert.match(extPkgVersion, /^\d+\.\d+\.\d+$/, '扩展版本号要正常');
});

await test('渲染器版本:构建脚本会在"部署与 devDependency 不一致"时报错退出', () => {
  const build = read('../scripts/build-webview.mjs');
  assert.match(build, /dsh-web-frontend/, '要读 DSH 部署里界面包的版本作为比对基准');
  assert.match(build, /版本不一致:部署里的界面是/, '不一致时必须明确报错');
  assert.match(build, /process\.exit\(1\)/, '报错要退出(不能拿旧渲染器悄悄打包)');
  assert.match(build, /--allow-version-mismatch/, '要留一个显式放行开关(先升 DSH 再重打的场景)');
  // 面板运行期再比一次:版本错配要在面板上看得见。
  const app = read(`${WEBVIEW}/src/app.jsx`);
  assert.match(app, /view\.uiVersion !== RENDERER_VERSION/, '面板运行期要比对 uiVersion');
  assert.match(app, /pnpm run build:webview/, '提示里要给出重建命令');
});

// ---------------------------------------------------------------- W3 官方令牌与渲染器接线

await test('样式:官方设计令牌都在(标题排版 / 代码块底色 / 高亮配色 / 滚动条)', () => {
  const css = readFileSync(requireArtifact(`${WEBVIEW}/thread.css`), 'utf8');
  for (const token of [
    '--dsw-font-markdown-h1',
    '--dsw-font-markdown-base',
    '--dsw-alias-markdown-code-block',
    '--dsw-alias-markdown-inline-code',
    '--ds-font-family-code',
    '--dsh-scrollbar-width',
    '--shiki-token-keyword',
  ]) {
    assert.ok(css.includes(token), `样式里缺少官方令牌 ${token}`);
  }
  assert.ok(css.includes('.katex'), 'KaTeX 的样式要打进去(公式排版)');
  assert.ok(css.includes('--dsl-code-block-background'), '代码块自己的令牌(由 CodeBlock.module.css 定义)');
  // 面板外壳自己的类名(证明 panel.css 也进来了)。
  assert.ok(css.includes('.dshcs-approval'), '面板外壳样式缺失');
  // 暗色主题走官方令牌表的 body[data-ds-dark-theme];app.jsx 负责按 VS Code 主题设置它。
  assert.ok(css.includes('[data-ds-dark-theme]'), '官方暗色调色板要在样式里');
});

await test('构建脚本:令牌从官方发布物里抽(不复制粘贴、不改一个字)', () => {
  const build = read('../scripts/build-webview.mjs');
  assert.match(build, /lib.*client\.js|\path\.join\(themeDir, 'lib', 'client\.js'\)/, '令牌要从 ui-theme 的 client.js 里抽');
  assert.match(build, /REQUIRED_TOKENS/, '要有令牌清单自检');
  assert.match(build, /official-tokens\.css/, '抽出来的令牌要落成生成物文件');
  assert.match(build, /不要手改/, '生成物要标明是生成物');
  const css = readFileSync(requireArtifact(`${WEBVIEW}/src/official-tokens.css`), 'utf8');
  assert.match(css, /^\/\* 官方设计令牌/, '令牌文件要有来源说明');
  assert.ok(!css.includes('dswcs-'), '令牌文件里不该有我们自己的东西(原样抽取)');
});

await test('构建脚本:懒加载语法换成空注册(不把 1.6MB 语法全打进面板)', () => {
  const build = read('../scripts/build-webview.mjs');
  assert.match(build, /lazyGrammarNames/, '要从官方发布物里现读懒加载语法清单(不硬编码)');
  assert.match(build, /import\\\(\\s\*\["'\]=?|import\\\(/, '要按官方源码里的动态 import 扫描语法名');
  assert.match(build, /export default \[\];/, '替身必须是"空注册"(shiki 侧是空操作,语言纯文本降级)');
  assert.match(build, /--alias:@shikijs\/langs\//, '替身通过 --alias 接上');
  assert.match(build, /--all-grammars/, '要留一个全量打包的开关');
  const js = readFileSync(requireArtifact(`${WEBVIEW}/thread.js`), 'utf8');
  // 启动集三套语法必须在(答案里最常见的三种代码块)。
  for (const grammar of ['typescript', 'shellscript', 'json']) {
    assert.ok(js.includes(grammar), `启动集语法 ${grammar} 没进去(代码块会没高亮)`);
  }
});

await test('构建脚本:用 esbuild CLI(沙箱里 JS API 的管道会 EPERM),且不改动官方包', () => {
  const build = read('../scripts/build-webview.mjs');
  assert.doesNotMatch(build, /from 'esbuild'/, '不许用 esbuild 的 JS API(它会以管道拉起服务进程,沙箱里 EPERM)');
  assert.match(build, /execFileSync\(file, esbuildArgs, \{ stdio: 'inherit'/, '要直接跑平台二进制并继承标准流');
  assert.doesNotMatch(build, /writeFileSync\([^)]*node_modules/, '绝不改 node_modules 里的官方文件');
});

// ---------------------------------------------------------------- W4 宿主 / 扩展接线

await test('宿主 /sync:带上 thread / approvals / approvalHoldMs / uiVersion', () => {
  const host = read('../lib/index.js');
  assert.match(host, /thread: bridgeThread\.supported\(\)/, '/sync 要给被观看会话的对话流');
  assert.match(host, /approvals: bridgeApprovalBoard\.snapshot\(\)/, '/sync 要给待决授权');
  assert.match(host, /approvalHoldMs: DEFAULT_HOLD_MS/, '授权窗口长度要由宿主给出(面板不猜)');
  assert.match(host, /uiVersion: uiVersion\(\)/, '/sync 要给界面版本(面板比对渲染器版本)');
  assert.match(host, /function uiVersion\(\)/, '要有 uiVersion 助手');
  assert.match(host, /dsh-web-frontend/, '界面版本来自 dsh-web-frontend(那份 UI 就在它里面)');
  // 面板在不在看,决定授权是否先问面板(关掉面板就不该拦)。
  assert.match(host, /hasPanel: \(\) => bridgeWatch\.ids\.length > 0/, '授权拦截只在面板看着时生效');
});

await test('扩展:上报 watch 列表,并把对话流并进面板状态', () => {
  const source = read(`${EXT}/extension.js`);
  assert.match(source, /watch: askPanel !== null && askPanel\.state\.sessionId !== null \? \[askPanel\.state\.sessionId\] : \[\]/,
    '每趟轮询要声明"面板在看哪个会话"');
  assert.match(source, /applySync\(askPanel\.state, result\)/, '对话流要经纯模型并进面板状态');
  assert.doesNotMatch(source, /stalePolls|applyAnswers/, '旧的"回答同步"路径必须彻底删掉(不再有第二条通道)');
  const client = read(`${EXT}/lib/bridge-client.js`);
  assert.match(client, /thread: body !== null && body\.thread !== undefined \? body\.thread : undefined/,
    '客户端要原样透传 thread(undefined = 旧版宿主,面板据此报错)');
  assert.match(client, /async approve\(id, outcome\)/, '客户端要有 /approve');
  assert.match(client, /`\$\{BRIDGE_BASE\}\/approve`/, '/approve 路径要由 BRIDGE_BASE 拼出');
});

await test('桥的安全不变式:唯一的非只读路由是 /approve,且只能回答既有请求', () => {
  const bridge = read('../lib/bridge.mjs');
  assert.match(bridge, /唯一/, '桥头部的"只读"说明必须写明这个例外');
  const host = read('../lib/index.js');
  assert.match(host, /if \(!PANEL_OUTCOMES\.includes\(outcome\)\)/, 'outcome 白名单在宿主侧把关');
  assert.match(host, /if \(bridgeApprovalBoard\.get\(id\) === null\)/, '只认本进程发起且仍未决的 id(单次使用)');
  const approval = read('../lib/bridge-approval.mjs');
  assert.match(approval, /export const PANEL_OUTCOMES = \['allowed-once', 'rejected'\]/, '面板只能给这两个 outcome');
  assert.match(approval, /没有答案者就 fail closed|fail closed/, '没有答案者必须失败关闭(不自动放行)');
  assert.doesNotMatch(host.split('handleBridgeApprove')[1].split('async function handleBridgeEvent')[0], /body\.(text|path|command|args)/,
    '/approve 不接受任何自由文本 / 路径 / 命令参数');
});

console.log(`\nSUMMARY pass=${pass} fail=${fail} skip=${skip}`);
if (fail > 0) process.exit(1);
