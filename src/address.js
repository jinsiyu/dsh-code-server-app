/**
 * dsh-code-server — DSH 资源地址解析(0.2.5)
 *
 * DSH 右侧栏用 `dsh-resource://file/…` 地址命名文件,由 tab 类型按 `patterns` 认领;
 * 官方 `openFile(path, { line? })`(产物 chip、"交付"卡片预览、正文里的内联提及)最终都是
 * `ctx.sidebarRight.openResource(address)`。**认领这些地址 = 成为官方入口的文件查看器**,
 * 于是不必再顶掉官方的产物行(0.2.4 及更早的做法)。
 *
 * 地址语法(对齐 DSH `packages/util/workspace-path/src/file-address.ts`):
 *   - `dsh-resource://file/session/<sessionId>/<path>`
 *     path 相对该会话工作区根,或绝对(工作区内的绝对路径会被规范成相对;工作区外的绝对路径
 *     保留绝对写法但仍在 session 作用域里)。id 与每段路径都做 component 编码,
 *     `:` 保持字面量(盘符),查询串/片段忽略。
 *   - `dsh-resource://file/absolute/<path>`
 *     绝对路径(去掉前导 `/`;Windows 盘符写作 `C:/…`;UNC 保留一个空首段)。
 *   - 页面 tab 不是文件:右侧栏把页面记在 `sidebar://<kind>` 下(`openTab(kind)` 走这条)。
 *
 * 本模块只做纯字符串处理,不碰文件系统 —— 便于离线单测(见 .spike/spike-legacy-ui.mjs)。
 */

/** 文件地址前缀。 */
const FILE_PREFIX = 'dsh-resource://file/'
/** 右侧栏给"页面 tab"记的地址前缀(`sidebar://<kind>`)。 */
const PAGE_PREFIX = 'sidebar://'
/** 认领范围策略:只认领会话作用域,或连无会话的绝对路径也认领。 */
export const SCOPE_SESSION = 'session'
export const SCOPE_ALL = 'all'

/**
 * 是否为右侧栏的"页面 tab"地址。
 * @param address - 候选地址。
 * @returns 是否 `sidebar://…`。
 */
export function isPageAddress(address) {
  return typeof address === 'string' && address.startsWith(PAGE_PREFIX)
}

/**
 * 解析文件地址(与 DSH 的 `parseFileAddress` 同语义,但不依赖其包)。
 * @param address - 候选地址。
 * @returns `{ scope, sessionId?, path }`,无法解析时 null。
 */
export function parseFileAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return null
  // 查询串/片段不参与路径
  var cut = address.length
  for (var i = 0; i < address.length; i += 1) {
    var ch = address.charAt(i)
    if (ch === '?' || ch === '#') { cut = i; break }
  }
  var parts = address.slice(FILE_PREFIX.length, cut).split('/')
  var scope = parts.shift()
  try {
    if (scope === 'session') {
      var id = parts.shift()
      if (id === undefined || id === '' || parts.length === 0) return null
      return { scope: 'session', sessionId: decodeURIComponent(id), path: decodeSegmentPath(parts) }
    }
    if (scope === 'absolute') {
      // `absolute//server/share/x`(UNC)首段为空且后面还有内容
      var unc = parts[0] === '' && parts.length > 1
      var segments = unc ? parts.slice(1) : parts
      var decoded = decodeSegmentPath(segments)
      if (decoded === '' || decoded.charAt(0) === '/') {
        if (!unc) return null
      }
      if (unc) return { scope: 'absolute', path: '//' + decoded }
      if (decoded === '') return null
      return { scope: 'absolute', path: isDrivePath(decoded) ? decoded : '/' + decoded }
    }
  } catch (e) {
    return null // decodeURIComponent 对非法转义抛 URIError
  }
  return null
}

function decodeSegmentPath(segments) {
  var out = []
  for (var i = 0; i < segments.length; i += 1) out.push(decodeURIComponent(segments[i]))
  return out.join('/')
}

/** `C:/x` 形式的盘符路径(地址里 `:` 是字面量)。 */
function isDrivePath(path) {
  return /^[A-Za-z]:($|\/)/.test(path)
}

/**
 * 路径是否已是绝对路径(POSIX `/x`、Windows `C:/x`、UNC `//server/share`)。
 * @param path - `/` 分隔的路径。
 * @returns 是否绝对。
 */
export function isAbsoluteFilePath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.charAt(0) === '/') return true
  return isDrivePath(path)
}

/**
 * 地址末段(用作 tab 标题),按段解码。
 * @param address - 文件地址。
 * @returns 文件名;取不到时返回空串。
 */
export function basenameOfAddress(address) {
  var parsed = parseFileAddress(address)
  if (parsed === null) return ''
  var path = parsed.path.replace(/[/\\]+$/, '')
  var at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  var name = at === -1 ? path : path.slice(at + 1)
  return name
}

/**
 * 把地址里的路径解析成"给 VS Code 用的绝对路径"。
 * @param parsed - `parseFileAddress` 的结果。
 * @param cwd - 该会话的工作区根(相对路径时必需)。
 * @returns 绝对路径;相对路径且 cwd 未知时 null。
 */
export function resolveFilePath(parsed, cwd) {
  if (parsed === null || parsed == null) return null
  var path = typeof parsed.path === 'string' ? parsed.path : ''
  if (path === '') {
    // 会话根自身:交给工作区(不打开具体文件)
    return null
  }
  if (isAbsoluteFilePath(path)) return path
  if (typeof cwd !== 'string' || cwd === '') return null
  var sep = cwd.indexOf('\\') !== -1 ? '\\' : '/'
  var root = cwd.replace(/[\\/]+$/, '')
  return root + sep + (sep === '\\' ? path.replace(/\//g, '\\') : path)
}

/**
 * 是否认领这个地址(供 tab 类型的 `canOpen` 用)。
 * @param parsed - `parseFileAddress` 的结果。
 * @param policy - `'session'`(仅会话作用域)或 `'all'`(含无会话的绝对路径)。
 * @returns 是否认领。
 */
export function claimsAddress(parsed, policy) {
  if (parsed === null || parsed == null) return false
  if (parsed.scope === 'session') return true
  return policy === SCOPE_ALL
}
