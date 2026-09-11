/**
 * dsh-code-server — 认领类型策略(0.2.11)
 *
 * 决定"哪些文件地址由本插件认领"(即交给 VS Code 打开),**只按文件类型判断,不再区分作用域**:
 * `dsh-resource://file/session/…` 与 `…/file/absolute/…` 一视同仁,未认领的落回 DSH 自带预览
 * (`ui-sidebar-documentpreview`,优先级 fallback),它内部按扩展名分派 markdown / html / 图片 / PDF /
 * 代码高亮 / 纯文本。
 *
 * 文本语法(用户可在设置卡里改,分号分隔,`,`/空白/换行也认):
 *   *            其余类型也认领(兜底)
 *   py           认领 .py(写 `py`、`.py`、`*.py` 等价;大小写不敏感)
 *   !md          不认领 .md(排除优先于认领)
 * 空文本 = 不认领任何文件类型(只保留页面 tab,文件点击全部落回 DSH 预览)。
 *
 * 本模块是 host(`lib/index.js` 的 Config 默认值)与 client(`src/factory.js` 的 canOpen)的
 * **同一份** 事实来源,随 npm 包一起发布(见 package.json 的 files),避免两边默认值漂移。
 * 纯字符串逻辑,不碰文件系统 → 可离线单测(scripts/test-claim-types.mjs)。
 */

/**
 * 默认策略:**DSH 自带预览渲染得好的类型留给它**(markdown / html / 图片 / PDF 四类),
 * 其余(代码、json/yaml/toml、txt、日志、无扩展名、其它未知扩展名)全部进 IDE。
 * 未认领的类型没有"没渲染器"的风险(DSH 预览对任何扩展名都有兜底),反之未知扩展名进 IDE 更实用。
 */
export const DEFAULT_CLAIM_EXTENSIONS = '*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf'

/** 分隔符:分号为主,逗号/空白/换行也接受(用户手抄时不该因为标点被坑)。 */
const SEPARATORS = /[;,\s]+/

/** 切词:`!` 可以和后面的扩展名隔着空白写(`! .md` ≡ `!.md`),其余按分隔符切。 */
function tokenize(text) {
  return String(text).replace(/!\s+/g, '!').split(SEPARATORS)
}

/** 单个 token 归一化:去 `*.`/`.` 前缀、去首尾空白、小写;`*`/`!x` 形式保留语义。 */
function normalizeToken(raw) {
  var token = typeof raw === 'string' ? raw.trim() : ''
  if (token === '') return ''
  var deny = token.charAt(0) === '!'
  var body = deny ? token.slice(1).trim() : token
  if (body === '*') return deny ? '!*' : '*'
  if (body.slice(0, 2) === '*.') body = body.slice(2)
  else if (body.charAt(0) === '.') body = body.slice(1)
  body = body.toLowerCase()
  if (body === '') return ''
  return deny ? '!' + body : body
}

/**
 * 归一化成一串规范文本(保存进设置用):去空、去重、保持"先出现的先写"。
 * @param text - 用户输入(任意标点)。
 * @returns 规范文本;输入非字符串时返回 ''。
 */
export function normalizeClaimExtensions(text) {
  if (typeof text !== 'string') return ''
  var parts = tokenize(text)
  var seen = []
  for (var i = 0; i < parts.length; i += 1) {
    var token = normalizeToken(parts[i])
    if (token === '' || token === '!*') continue // `!*` 无意义:排除"其余"等于清空,不猜意图,直接忽略
    if (seen.indexOf(token) === -1) seen.push(token)
  }
  return seen.join(';')
}

/**
 * 解析策略文本。
 * @param text - 归一化前或后的文本都接受。
 * @returns {{all: boolean, allow: string[], deny: string[]}} all = `*` 出现(其余类型也认领)。
 */
export function parseClaimPolicy(text) {
  var normalized = normalizeClaimExtensions(text)
  var tokens = normalized === '' ? [] : normalized.split(';')
  var all = false
  var allow = []
  var deny = []
  for (var i = 0; i < tokens.length; i += 1) {
    var token = tokens[i]
    if (token === '*') { all = true; continue }
    if (token.charAt(0) === '!') deny.push(token.slice(1))
    else allow.push(token)
  }
  return { all: all, allow: allow, deny: deny }
}

/** 路径的扩展名(小写、不含点);无扩展名(含 dotfile、目录、空路径)返回 ''。 */
export function extensionOfPath(path) {
  if (typeof path !== 'string' || path === '') return ''
  var name = path.replace(/[/\\]+$/, '')
  var at = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (at !== -1) name = name.slice(at + 1)
  var dot = name.lastIndexOf('.')
  // dot <= 0:`Makefile` / `README`(无扩展名)、`.gitignore`(dotfile)都按"无扩展名"处理
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 是否认领这个路径。排除优先,其次显式认领,最后看 `*`。
 * @param path - 地址里的路径(可为相对路径)。
 * @param policy - parseClaimPolicy 的结果。
 * @returns 认领返回 true。
 */
export function claimsPath(path, policy) {
  if (policy == null) return false
  var ext = extensionOfPath(path)
  if (ext !== '' && policy.deny.indexOf(ext) !== -1) return false
  if (ext !== '' && policy.allow.indexOf(ext) !== -1) return true
  return policy.all === true
}

/**
 * 是否认领这个文件地址(供 tab 类型的 canOpen 用)。
 * @param parsed - parseFileAddress 的结果(或 null)。
 * @param policy - parseClaimPolicy 的结果。
 * @returns 认领返回 true。
 */
export function claimsAddress(parsed, policy) {
  if (parsed === null || parsed == null) return false
  return claimsPath(parsed.path, policy)
}

/** 给设置卡/日志用的一句话摘要(不参与判定)。 */
export function describeClaimPolicy(text) {
  var policy = parseClaimPolicy(text)
  var parts = []
  if (policy.all) parts.push('其余类型全部认领')
  if (policy.allow.length > 0) parts.push('指定认领 ' + policy.allow.length + ' 项')
  if (policy.deny.length > 0) parts.push('排除 ' + policy.deny.length + ' 项')
  if (parts.length === 0) return '不认领任何文件(只有页面标签)'
  return parts.join(' · ')
}
