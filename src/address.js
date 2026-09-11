/**
 * dsh-code-server — DSH 资源地址解析(0.2.5;0.2.11 起不再区分认领作用域)
 *
 * 官方 `openFile(path, { line? })`(产物 chip、"交付"卡片预览、正文内联提及)最终都变成
 * `dsh-resource://file/…` 地址交给 `ctx.sidebarRight.openResource`,由注册了匹配 `patterns`
 * 的 tab 类型认领 —— 认领地址即是官方入口的文件查看器。地址语法对齐 DSH
 * `packages/util/workspace-path/src/file-address.ts`(session 作用域 / absolute 作用域、
 * 段做 component 编码、`:` 保持字面量、忽略查询串);页面 tab 记在 `sidebar://<kind>` 下。
 *
 * 本模块只做"地址 → 路径"的解析;**认领与否按文件类型判断,见 lib/claim-types.js**
 * (session 与 absolute 一视同仁)。纯字符串处理,不碰文件系统 → 可离线单测。
 */

/** 文件地址前缀。 */
const FILE_PREFIX = 'dsh-resource://file/'
/** 右侧栏给"页面 tab"记的地址前缀(`sidebar://<kind>`)。 */
const PAGE_PREFIX = 'sidebar://'

/** 是否为右侧栏的"页面 tab"地址(`sidebar://<kind>`)。 */
export function isPageAddress(address) {
  return typeof address === 'string' && address.startsWith(PAGE_PREFIX)
}

/** 解析文件地址(与 DSH `parseFileAddress` 同语义));失败返回 null。 */
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

/** 路径是否已是绝对路径(POSIX `/x`、Windows `C:/x`、UNC `//server/share`)。 */
function isAbsoluteFilePath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.charAt(0) === '/') return true
  return isDrivePath(path)
}

/** 地址末段(用作 tab 标题),按段解码;取不到时返回空串。 */
export function basenameOfAddress(address) {
  var parsed = parseFileAddress(address)
  if (parsed === null) return ''
  var path = parsed.path.replace(/[/\\]+$/, '')
  var at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  var name = at === -1 ? path : path.slice(at + 1)
  return name
}

/** 把地址里的路径解析成给 VS Code 用的绝对路径;相对路径且 cwd 未知时 null。 */
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
