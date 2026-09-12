/**
 * lib/bridge-tools.mjs — 编辑器桥的 agent 侧接口(0.3.0)。
 *
 * 两个**只读**工具 + 一段系统提示词说明:
 *   - `editor_context`     :编辑器当前状态(活动文件/选区、未保存缓冲区、诊断计数)
 *   - `editor_diagnostics` :按严重度排序的诊断(可只问一个文件)
 *
 * 为什么是工具而不是"每步注入":
 *   `agent/pre-step` 每步都会跑,把编辑器状态无条件塞进上下文会让每个请求都变重且多半无关。
 *   工具化 = 按需、有界、可被模型自己取舍。提示词只在桥可用时渲染(函数式 `text` 返回空串
 *   会被 DSH 丢弃),所以 IDE 没起来时模型完全看不到这套东西。
 *
 * 为什么只在桥存活时注册:
 *   桥不可用时注册会留下"永远不可用"的工具,模型会反复试。注销掉更干净 —— `tools/change`
 *   会让客户端刷新工具集。若实测发现客户端对工具集变化处理不佳,把 `registerEditorTools`
 *   改成"始终注册 + execute 里返回不可用说明"即可(单点开关)。
 *
 * 依赖注入:`defineTool` 从 DSH 部署里解析(见 `loadDefineTool`),不引入新的包依赖。
 */

import { loadDshExport } from './dsh-resolve.mjs';

/** 工具名(模型可见)。 */
export const EDITOR_CONTEXT_TOOL = 'editor_context';
export const EDITOR_DIAGNOSTICS_TOOL = 'editor_diagnostics';

/** systemPrompt 段名与排序位置:靠后(在工具说明之后、运行时上下文之前)。 */
export const PROMPT_SECTION = 'code-server:editor-bridge';
export const PROMPT_ORDER = 4500;

/** 提示词全文(仅桥可用时渲染)。 */
export const PROMPT_TEXT = [
  '## Editor bridge (VS Code / code-server)',
  '',
  'A VS Code workbench is running next to this session and can be queried read-only:',
  '',
  '- `editor_context` — what the user is looking at right now: active file and selection, which',
  '  buffers have UNSAVED changes, and how many problems each file has.',
  '- `editor_diagnostics` — errors/warnings with file:line, produced by the real language servers',
  '  (TypeScript, ESLint, …). Prefer this over guessing: it is cheaper and more accurate than',
  '  re-reading whole files.',
  '',
  'Use them when the user mentions "this file", "my selection", "the error I see", or when a change',
  'must not clobber unsaved edits. If a file has unsaved changes in the editor, the on-disk content',
  'differs from what the user sees — say so instead of silently overwriting it. Both tools are',
  'read-only: they never edit files or run commands.',
].join('\n');

/** 工具描述(内联,避免 z.string().default 那种"必须重启才生效"的配置面)。 */
const CONTEXT_DESCRIPTION = [
  'Read the current state of the VS Code editor: active file + selection, open buffers with unsaved',
  'changes, and problem counts per file. Read-only. Returns {"available":false} when no editor is',
  'attached (then fall back to reading files from disk).',
].join(' ');

const DIAGNOSTICS_DESCRIPTION = [
  'Read errors/warnings reported by the editor\'s language servers (the Problems panel), newest',
  'state, sorted by severity. Optionally narrow to one file. Read-only. Returns',
  '{"available":false} when no editor is attached.',
].join(' ');

// ---------------------------------------------------------------- DSH 依赖懒解析

/**
 * 解析 `defineTool`(解析策略见 lib/dsh-resolve.mjs)。
 * 解析不到 = 当前 DSH 没有工具服务 → 返回 null,桥退化为"只有 HTTP 面",不影响主流程。
 */
async function loadDefineTool() {
  return loadDshExport('@deepseek-ai/dsh-tools', 'defineTool');
}

/**
 * 取一个 DSH 服务。
 *
 * **必须走 `ctx.get()`,不能走属性访问**(0.3.6 的真实线上事故:用 `ctx.systemPrompt`
 * 让整棵插件树加载失败、dsh web 直接起不来)。
 *
 * 区别是确定的(cordis `src/reflect.ts`):
 *   - `ctx.get(name)` → `ReflectService.get()` → `_getImpl()`:服务没提供就返回 `undefined`,
 *     **永不抛**;
 *   - `ctx.tools` 这类属性访问 → 走代理的 get trap,服务"存在但对该 fiber 不可达"时
 *     依次尝试 `internal/get` 瀑布 / `props[prop].get` / `reflect.get(prop,false)`,
 *     任一失败都会抛 `cannot get property "x" without inject`
 *     —— 而那是在 `apply()` 里,loader 会因此判定 `failed to apply loader entry` 并终止整个 profile。
 *
 * 所以:`ctx.get()` + 判空 = 可选服务的正确姿势;属性访问只对**已声明 inject** 的服务安全。
 */
function getService(ctx, name) {
  if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined; // 连 get 都抛(上下文形态异常)时,退化为"没有这个服务"
  }
}

/** 取一个服务上的方法,绑定好 this(避免调用时丢上下文)。 */
function getServiceMethod(ctx, serviceName, methodName) {
  const service = getService(ctx, serviceName);
  if (service === undefined || service === null || typeof service[methodName] !== 'function') return null;
  return service[methodName].bind(service);
}

// ---------------------------------------------------------------- 工具值投影

/**
 * 把 `/context` 的响应压成模型友好的短文本。
 *
 * 上限在**扩展侧**也有一份(它才是权威);这里再兜一层是因为模型看到的是这个字符串,
 * 不能因为扩展版本不一致就把一整棵诊断树塞进上下文。
 */
function renderContext(value) {
  if (value.available !== true) {
    return `编辑器上下文不可用:${value.reason ?? '未知原因'}(回退到直接读磁盘文件)`;
  }
  const lines = [];
  const active = value.active ?? null;
  if (active === null) {
    lines.push('活动编辑器:无(用户没有聚焦任何文件)');
  } else {
    const sel = active.selection === null || active.selection === undefined
      ? ''
      : ` 选区 ${active.selection.startLine}:${active.selection.startColumn}-${active.selection.endLine}:${active.selection.endColumn}`;
    lines.push(`活动编辑器:${active.path ?? active.name}${active.language ? ` (${active.language})` : ''}`
      + `${active.dirty === true ? ' — 有未保存改动' : ''}${sel}`);
    if (typeof active.selectedText === 'string' && active.selectedText !== '') {
      lines.push('选中的文本:');
      lines.push('```');
      lines.push(active.selectedText.length > 4000 ? `${active.selectedText.slice(0, 4000)}\n…(已截断)` : active.selectedText);
      lines.push('```');
    }
  }
  const dirty = Array.isArray(value.dirtyBuffers) ? value.dirtyBuffers : [];
  if (dirty.length === 0) {
    lines.push('未保存缓冲区:无(磁盘内容 = 用户所见)');
  } else {
    lines.push(`未保存缓冲区(${dirty.length} 个,磁盘内容与用户所见不一致;不要直接覆盖):`);
    for (const item of dirty.slice(0, 20)) {
      lines.push(`  - ${item.path ?? item.name}${typeof item.unsavedLines === 'number' ? `(+${item.unsavedLines} 行未保存)` : ''}`);
    }
    if (dirty.length > 20) lines.push(`  …(还有 ${dirty.length - 20} 个)`);
  }
  const problems = Array.isArray(value.problems) ? value.problems : [];
  if (problems.length === 0) {
    lines.push('问题面板:无错误/警告');
  } else {
    lines.push('问题面板(按文件聚合,用 editor_diagnostics 看细节):');
    for (const item of problems.slice(0, 30)) {
      lines.push(`  - ${item.path}:${item.line ?? ''} ${item.severity} ${item.message}`);
    }
    if (problems.length > 30) lines.push(`  …(还有 ${problems.length - 30} 个)`);
  }
  if (typeof value.truncated === 'string' && value.truncated !== '') lines.push(`(注:${value.truncated})`);
  return lines.join('\n');
}

/** 诊断结果 → 模型友好短文本(带 file:line,便于模型直接定位)。 */
function renderDiagnostics(value) {
  if (value.available !== true) {
    return `编辑器诊断不可用:${value.reason ?? '未知原因'}(回退到在你自己的终端里跑 tsc/eslint)`;
  }
  const items = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  if (items.length === 0) return '没有匹配的诊断(编辑器当前没有报错或警告)';
  const lines = [`诊断 ${items.length} 条${typeof value.total === 'number' && value.total > items.length ? `(共 ${value.total},已截断)` : ''}:`];
  for (const d of items) {
    lines.push(`${d.path}:${d.line}:${d.column} [${d.severity}] ${d.message}${d.source ? ` (${d.source}${d.code ? ` ${d.code}` : ''})` : ''}`);
  }
  return lines.join('\n');
}

/** 桥不可用时的统一值(永不抛:工具失败会让模型重试,而"没接编辑器"不是错误)。 */
function unavailable(reason) {
  return { available: false, reason, active: null, dirtyBuffers: [], problems: [], diagnostics: [], total: 0 };
}

/** 严重度排序权重(与扩展侧 lib/context-model.js 的 SEVERITY_RANK 一致)。 */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3 };
const MAX_DIAGNOSTICS = 200;

/** 把缓存里的诊断树(`[{path, items:[{line,column,severity,message,source,code}]}]`)按入参过滤。 */
function projectDiagnostics(tree, args) {
  const rows = [];
  for (const group of tree) {
    if (group === null || typeof group.path !== 'string') continue;
    if (typeof args.file === 'string' && args.file !== '' && group.path !== args.file) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      const severity = typeof item.severity === 'string' ? item.severity : 'info';
      if (typeof args.severity === 'string' && SEVERITY_RANK[severity] !== undefined && SEVERITY_RANK[severity] > SEVERITY_RANK[args.severity]) continue;
      rows.push({
        path: group.path,
        line: Number.isSafeInteger(item.line) ? item.line : 1,
        column: Number.isSafeInteger(item.column) ? item.column : 1,
        severity,
        message: typeof item.message === 'string' ? item.message : '',
        ...(typeof item.source === 'string' && item.source !== '' ? { source: item.source } : {}),
        ...(item.code === undefined || item.code === null || item.code === '' ? {} : { code: String(item.code) }),
      });
    }
  }
  rows.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || (a.line - b.line));
  const cap = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_DIAGNOSTICS) : 100;
  return { diagnostics: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
}

/** 桥是否"活着":启用 + 扩展在最近一个 TTL 内上报过。 */
function bridgeLive(deps) {
  const meta = deps.target();
  if (meta === null || meta === undefined) return { live: false, reason: '编辑器桥未启用(IDE 没在运行,或 serve=dsh 不支持桥)' };
  const cache = deps.cache();
  if (cache === null || cache === undefined || cache.get() === null) {
    return { live: false, reason: '编辑器里的扩展还没有上报状态(IDE 刚起?扩展被禁用了?)' };
  }
  if (cache.isStale()) {
    const age = cache.ageMs();
    return { live: false, reason: `编辑器状态已过期(${age === null ? '未知' : `${Math.round(age / 1000)}s`} 没更新;IDE 面板关掉了吗?)` };
  }
  return { live: true };
}

// ---------------------------------------------------------------- 注册

/**
 * 注册编辑器工具,返回**同步** disposer。
 *
 * 由 `lib/index.js` 在桥进入 running 时调用、离开 running 时调用 disposer。
 * `tools` 服务缺失 / `defineTool` 解析不到时返回 null(调用方据此退化为"只有 HTTP 面")。
 *
 * @param {object} ctx cordis 上下文(需要有 `tools` 服务)
 * @param {{target: () => object|null, cache: () => object|null}} deps
 *        `target()` 取当前桥目标(null = 未启用);`cache()` 取编辑器状态缓存
 *        (见 lib/bridge.mjs 的 createContextCache —— 扩展在每次 /sync 里刷新它)。
 */
export async function registerEditorTools(ctx, deps) {
  const tools = getService(ctx, 'tools');
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return null;
  const defineTool = await loadDefineTool();
  if (defineTool === null) return null;
  const register = tools.register.bind(tools);

  const contextTool = defineTool({
    name: EDITOR_CONTEXT_TOOL,
    description: CONTEXT_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          active: { type: 'json' },
          dirtyBuffers: { type: 'array', items: { type: 'json' } },
          problems: { type: 'array', items: { type: 'json' } },
          diagnostics: { type: 'array', items: { type: 'json' } },
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderContext(value) }],
    },
    async execute(_args, _exec) {
      const status = bridgeLive(deps);
      if (status.live !== true) return unavailable(status.reason);
      const context = deps.cache().get().context;
      return { ...context, available: true };
    },
    presentCall: () => ({ card: 'generic', title: '读取编辑器状态', kind: 'read' }),
  });

  const diagnosticsTool = defineTool({
    name: EDITOR_DIAGNOSTICS_TOOL,
    description: DIAGNOSTICS_DESCRIPTION,
    parameters: {
      file: { type: 'string', description: '可选:只看这个文件(绝对路径,必须已在编辑器的工作区内)' },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'hint'],
        description: '可选:只保留该严重度及以上(默认全部)',
      },
      limit: { type: 'integer', description: '可选:最多返回多少条(默认 100,上限 200)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          diagnostics: { type: 'array', items: { type: 'json' } },
          total: { type: 'integer' },
          truncated: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDiagnostics(value) }],
    },
    async execute(args, _exec) {
      const status = bridgeLive(deps);
      if (status.live !== true) return unavailable(status.reason);
      const cached = deps.cache().get();
      const projected = projectDiagnostics(cached.diagnostics, args);
      return {
        available: true,
        diagnostics: projected.diagnostics,
        total: projected.total,
        truncated: projected.truncated ? `只返回前 ${projected.diagnostics.length} 条(共 ${projected.total})` : '',
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.file ? `读取诊断:${args.file}` : '读取诊断',
      kind: 'read',
      ...(args.file ? { locations: [{ path: args.file }] } : {}),
    }),
  });

  const disposers = [register(contextTool), register(diagnosticsTool)];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 双保险:注册本身也挂在 fiber 上
      }
    }
  };
}

/**
 * 系统提示词段落里"桥是否可用"的同步探针。
 *
 * `PromptSection.text` 不支持 async 也不支持 `when` 谓词,所以只能用一个同步可读的开关:
 * 由 `lib/index.js` 在桥状态变化时维护(`setPromptLiveProbe(() => bridgeLive)`),
 * 段落文本按它返回整段或空串(空串会被 DSH 整个丢弃 —— 模型看不到"有一个用不了的工具")。
 */
let promptLiveProbe = () => false;

/** 注入同步探针(桥 running 时为 true)。 */
export function setPromptLiveProbe(probe) {
  promptLiveProbe = typeof probe === 'function' ? probe : () => false;
}

function bridgeIsLive() {
  try {
    return promptLiveProbe() === true;
  } catch {
    return false;
  }
}

/**
 * 注册系统提示词段落,返回 disposer(或 null = 该 DSH 没有 systemPrompt 服务)。
 *
 * **这里就是 0.3.6 线上事故的位置**:原实现写的是 `ctx?.systemPrompt ?? ctx.get(...)`,
 * 而属性访问会抛(见 `getService` 的说明)—— 可选链只挡 null/undefined,挡不住抛错,
 * 于是 `??` 右边的 `ctx.get()` 永远没机会执行,整个 profile 加载失败。
 * 现在只走 `ctx.get()`,并且对 `section` 调用本身也加保护。
 *
 * @param {object} ctx cordis 上下文
 */
export function registerEditorPrompt(ctx) {
  const section = getServiceMethod(ctx, 'systemPrompt', 'section');
  if (section === null) return null;
  try {
    return section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: () => (bridgeIsLive() ? PROMPT_TEXT : ''),
    });
  } catch (error) {
    console.warn(`[code-server] 编辑器桥:提示词段落注册失败(不影响其余能力):${error && error.message ? error.message : error}`);
    return null;
  }
}
