// scripts/test-claim-types.mjs —— "认领类型"策略的单元测试(设置卡文本框 ↔ canOpen 的判定)
//
// 为什么要有:这一层决定"点文件时谁来打开"(本插件 or DSH 自带预览),错了不会报错、只会静默
// 用错渲染器;而它同时被 host(Config 默认值/热更新)和 client(canOpen)使用,必须钉死语义:
//   * = 其余类型也认领;!ext = 排除(排除优先);无扩展名 = 走 *;`.` / `*.` 前缀容错。
//
// 用法:node scripts/test-claim-types.mjs
import assert from 'node:assert/strict';
import {
  DEFAULT_CLAIM_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  OFFICE_EXTENSIONS,
  PREVIEW_FRIENDLY_EXTENSIONS,
  claimsAddress,
  claimsPath,
  describeClaimPolicy,
  extensionOfPath,
  normalizeClaimExtensions,
  parseClaimPolicy,
} from '../lib/claim-types.js';

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

/** 默认策略下的判定(等价于 host 的默认设置)。 */
const DEF = parseClaimPolicy(DEFAULT_CLAIM_EXTENSIONS);

await test('默认值:DSH 预览渲染得好的 4 类留给它,其余全部认领', async () => {
  // 排除:markdown / html / 图片 / pdf
  for (const p of ['a.md', 'a.markdown', 'a.html', 'a.htm', 'a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico', 'a.svg', 'a.pdf']) {
    assert.equal(claimsPath(p, DEF), false, `${p} 应留给 DSH 预览`);
  }
  // 认领:代码 / 配置 / 文本 / 无扩展名 / 未知扩展名
  for (const p of ['main.py', 'a.ts', 'a.json', 'a.yaml', 'a.toml', 'a.sh', 'a.ps1', 'a.txt', 'a.log', 'Makefile', 'README', '.gitignore', 'a.zig', 'a.vue', 'a.unknown-ext']) {
    assert.equal(claimsPath(p, DEF), true, `${p} 应进 IDE`);
  }
});

await test('默认值:可执行文件与二进制产物不认领(0.3.51 用户要求)', async () => {
  const execs = [
    'app.exe', 'setup.msi', 'pkg.msix', 'a.dll', 'a.sys', 'a.scr', 'a.cpl', 'a.ocx', 'a.drv', 'a.efi', 'a.mui',
    'a.obj', 'a.o', 'a.a', 'a.lib', 'a.pdb', 'A.CLASS', 'a.jar', 'a.pyc', 'a.wasm', 'a.node',
    'libfoo.so', 'libfoo.dylib', 'a.ko', 'a.elf', 'fw.bin', 'a.out',
    'app.apk', 'app.ipa', 'a.deb', 'a.rpm', 'a.dmg', 'a.iso', 'a.img', 'a.cab',
  ];
  for (const p of execs) assert.equal(claimsPath(p, DEF), false, `${p} 是可执行/二进制产物,不该进 IDE`);
  // 文本形态的脚本**继续认领**(判据是"进编辑器有没有意义",不是"能不能被执行")
  for (const p of ['run.bat', 'run.cmd', 'deploy.ps1', 'a.sh', 'a.py', 'a.js']) {
    assert.equal(claimsPath(p, DEF), true, `${p} 是可编辑的文本脚本,应继续进 IDE`);
  }
});

await test('默认值:Office / 版式文档不认领(0.3.51 用户要求)', async () => {
  const office = [
    'a.doc', 'a.docx', 'a.docm', 'a.dot', 'a.dotx', 'a.rtf', 'a.odt',
    'a.xls', 'a.xlsx', 'a.xlsm', 'a.xlsb', 'a.xltx', 'a.ods',
    'a.ppt', 'a.pptx', 'a.pptm', 'a.potx', 'a.ppsx', 'a.odp',
    'a.vsdx', 'a.one', 'a.mpp', 'a.pub', 'a.msg', 'a.xps', 'a.odg',
  ];
  for (const p of office) assert.equal(claimsPath(p, DEF), false, `${p} 是 Office/版式文档,不该进 IDE`);
  // 纯文本的表格文件**不排除**:进 IDE 反而有用(只是 Excel 也能开)
  for (const p of ['data.csv', 'data.tsv']) {
    assert.equal(claimsPath(p, DEF), true, `${p} 是纯文本,应继续进 IDE`);
  }
});

await test('默认值:只想放开 Office(或某一组)时,换一段更短的白名单即可', async () => {
  const lean = parseClaimPolicy('*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf');
  assert.equal(claimsPath('a.docx', lean), true, '换回旧默认后 Office 文档重新进 IDE');
  assert.equal(claimsPath('a.exe', lean), true, '可执行文件同理');
  assert.equal(claimsPath('a.md', lean), false, '预览友好那几类仍然留给 DSH');
});

await test('默认值本身是归一化形式(大小写/前缀/分隔符都规范)', async () => {
  assert.equal(normalizeClaimExtensions(DEFAULT_CLAIM_EXTENSIONS), DEFAULT_CLAIM_EXTENSIONS);
});

await test('扩展名解析:大小写、路径分隔、无扩展名、dotfile、目录', async () => {
  assert.equal(extensionOfPath('C:/a/b/Main.PY'), 'py');
  assert.equal(extensionOfPath('C:\\a\\b\\x.tar.gz'), 'gz');
  assert.equal(extensionOfPath('dir/'), '');
  assert.equal(extensionOfPath('dir'), '');
  assert.equal(extensionOfPath('.gitignore'), '');
  assert.equal(extensionOfPath('a.'), '');
  assert.equal(extensionOfPath(''), '');
  assert.equal(extensionOfPath(null), '');
});

await test('纯白名单(无 *):只认领列出的类型', async () => {
  const policy = parseClaimPolicy('py; ts ;JSON');
  assert.equal(claimsPath('a.py', policy), true);
  assert.equal(claimsPath('a.ts', policy), true);
  assert.equal(claimsPath('a.json', policy), true, '大小写不敏感');
  assert.equal(claimsPath('a.md', policy), false);
  assert.equal(claimsPath('Makefile', policy), false, '无扩展名且无 * → 不认领');
});

await test('`*` 与 `!` 的组合:排除优先于 `*`,也优先于显式认领', async () => {
  const policy = parseClaimPolicy('*;!md;py;!py')
  assert.equal(claimsPath('a.py', policy), false, '同时出现 py 与 !py 时排除胜出')
  assert.equal(claimsPath('a.md', policy), false)
  assert.equal(claimsPath('a.rs', policy), true, '* 兜底')
  assert.equal(claimsPath('Makefile', policy), true, '无扩展名走 *')
});

await test('前缀容错与分隔符:`.` / `*.` / 逗号 / 空白 / 换行 / 分号', async () => {
  const policy = parseClaimPolicy(' .py, *.ts\njs;  ! .MD ')
  assert.equal(claimsPath('a.py', policy), true)
  assert.equal(claimsPath('a.ts', policy), true)
  assert.equal(claimsPath('a.js', policy), true)
  assert.equal(claimsPath('a.md', policy), false)
  assert.equal(normalizeClaimExtensions('py;PY;.py;*.py'), 'py', '去重且归一')
});

await test('空清单 = 不认领任何文件(只保留页面 tab)', async () => {
  for (const text of ['', '   ', ';', ';;', '!*', null, undefined]) {
    const policy = parseClaimPolicy(text)
    assert.equal(claimsPath('a.py', policy), false, `${JSON.stringify(text)} 不应认领 a.py`)
    assert.equal(claimsPath('Makefile', policy), false, `${JSON.stringify(text)} 不应认领 Makefile`)
    assert.match(describeClaimPolicy(text), /不认领任何文件/)
  }
  assert.equal(normalizeClaimExtensions(undefined), '')
});

await test('claimsAddress:非 file 地址(null)一律不认领', async () => {
  assert.equal(claimsAddress(null, DEF), false);
  assert.equal(claimsAddress({ scope: 'session', sessionId: 's', path: 'a.py' }, DEF), true);
  assert.equal(claimsAddress({ scope: 'absolute', path: 'C:/x/a.md' }, DEF), false, '绝对路径也按类型判,不再按作用域');
  assert.equal(claimsAddress({ scope: 'absolute', path: 'C:/x/a.py' }, DEF), true, '0.2.11 起绝对路径同样认领');
});

await test('describeClaimPolicy:摘要覆盖各种形态(默认值要点出"含可执行文件、Office 文档")', async () => {
  const summary = describeClaimPolicy(DEFAULT_CLAIM_EXTENSIONS);
  assert.match(summary, /其余类型全部认领/);
  assert.match(summary, /排除 \d+ 项\(含可执行文件、Office 文档\)/, `默认摘要应点名两组,实际:${summary}`);
  assert.equal(DEF.deny.length, PREVIEW_FRIENDLY_EXTENSIONS.length + EXECUTABLE_EXTENSIONS.length + OFFICE_EXTENSIONS.length,
    '排除项 = 三组之和(默认值就是这个并集)');
  assert.match(describeClaimPolicy('py;ts'), /指定认领 2 项/);
  assert.match(describeClaimPolicy('*'), /其余类型全部认领/);
  assert.match(describeClaimPolicy('*;!md'), /排除 1 项(?!\()/, '只排除了预览类时不点名那两组');
  assert.doesNotMatch(describeClaimPolicy('*;!md'), /可执行文件/);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
