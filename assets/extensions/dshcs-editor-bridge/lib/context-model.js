// dshcs-editor-bridge / lib/context-model.js —— 纯逻辑:把编辑器快照投影成桥的响应
//
// **不 require('vscode')**:入参是已经拍平的纯数据(见 createProjector 的文档),
// 这样 scripts/test-bridge-extension.mjs 能在没有 VS Code 的环境里直接验投影规则。
//
// 投影规则里每一条都对应一个真实坑:
//   - **未保存缓冲区才是重点**:磁盘内容 ≠ 用户所见,agent 按磁盘文件改就会把人家的编辑冲掉,
//     所以 dirty 文档必须在 /context 里出现,并且带上"未保存行数"的量级。
//   - **无标题文档没有路径**:用 `untitled:<n>` 占位,且**不接受**它作为 diagnostics 的 file 入参
//     (那条路径在磁盘上不存在,按它去查只会得到空结果,不如直说)。
//   - **诊断必须收敛在工作区内**:workspaceFolder 之外的诊断(比如 node_modules 里的、
//     或另一个根目录的)对当前任务没有意义,而且会把响应撑爆。
//   - **一切有界**:诊断按严重度排序后截断;选中文本截断。上限在这里,不在 host —— 扩展才是
//     唯一知道真实规模的一方。

'use strict';

/** 选中文本 / 单条诊断 message 的截断上限。 */
const MAX_SELECTION_CHARS = 8000;
const MAX_MESSAGE_CHARS = 500;
/** 默认返回的诊断条数上限(host 侧工具最多要 200)。 */
const MAX_DIAGNOSTICS = 200;
/** /context 里按文件聚合的问题条数上限。 */
const MAX_PROBLEM_SUMMARIES = 30;

/** 严重度排序权重(小的在前):error → warning → info → hint。 */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3 };

/** 把 VS Code 的 DiagnosticSeverity 数值化名转成字符串(调用方给数值也行)。 */
function severityName(severity) {
  if (typeof severity === 'string') {
    const lower = severity.toLowerCase();
    return SEVERITY_RANK[lower] === undefined ? 'info' : lower;
  }
  switch (severity) {
    case 0: return 'error';
    case 1: return 'warning';
    case 2: return 'info';
    case 3: return 'hint';
    default: return 'info';
  }
}

function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}…(已截断)` : text;
}

/**
 * 拍平一条诊断。
 *
 * @param {{path: string|null, name: string, line: number, column: number, severity: unknown,
 *          message: string, source?: string, code?: string|number}} raw 1 基行列
 */
function normalizeDiagnostic(raw) {
  const diagnostic = {
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : (raw.name ?? '(无路径)'),
    line: Number.isSafeInteger(raw.line) && raw.line > 0 ? raw.line : 1,
    column: Number.isSafeInteger(raw.column) && raw.column > 0 ? raw.column : 1,
    severity: severityName(raw.severity),
    message: truncate(typeof raw.message === 'string' ? raw.message : '', MAX_MESSAGE_CHARS),
  };
  if (typeof raw.source === 'string' && raw.source !== '') diagnostic.source = raw.source;
  if (raw.code !== undefined && raw.code !== null && raw.code !== '') diagnostic.code = String(raw.code);
  return diagnostic;
}

/**
 * 排序 + 截断诊断。
 * 排序键:严重度 → 文件 → 行(稳定且与用户看 Problems 面板的顺序接近)。
 */
function sortDiagnostics(items, limit) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_DIAGNOSTICS) : MAX_DIAGNOSTICS;
  const sorted = items.slice().sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return { diagnostics: sorted.slice(0, cap), total: sorted.length, truncated: sorted.length > cap };
}

/**
 * 造一个"快照 → 响应"的投影器。
 *
 * @param {(path: string) => boolean} isInWorkspace 该绝对路径是否落在某个工作区文件夹内
 */
function createProjector(isInWorkspace) {
  const inWorkspace = typeof isInWorkspace === 'function' ? isInWorkspace : () => true;

  /**
   * 只保留工作区内的诊断(raw 形态:`{uriPath, items: [{line, column, severity, message, source, code}]}`)。
   */
  function filterDiagnostics(rawDiagnostics) {
    const out = [];
    for (const group of Array.isArray(rawDiagnostics) ? rawDiagnostics : []) {
      if (group === null || typeof group.path !== 'string' || group.path === '') continue;
      if (!inWorkspace(group.path)) continue;
      for (const item of Array.isArray(group.items) ? group.items : []) {
        out.push(normalizeDiagnostic(Object.assign({ path: group.path }, item)));
      }
    }
    return out;
  }

  /**
   * 组 /diagnostics 的响应。
   * @param {object} input `{diagnostics, file?, severity?, limit?}`
   */
  function diagnostics(input) {
    let items = filterDiagnostics(input.diagnostics);
    if (typeof input.file === 'string' && input.file !== '') {
      if (input.file.startsWith('untitled:')) {
        return { available: true, diagnostics: [], total: 0, truncated: false, note: '未保存的新文件没有磁盘路径,无法按文件查诊断' };
      }
      items = items.filter((item) => item.path === input.file);
    }
    if (typeof input.severity === 'string' && SEVERITY_RANK[input.severity] !== undefined) {
      const floor = SEVERITY_RANK[input.severity];
      items = items.filter((item) => SEVERITY_RANK[item.severity] <= floor);
    }
    const sorted = sortDiagnostics(items, input.limit);
    return {
      available: true,
      diagnostics: sorted.diagnostics,
      total: sorted.total,
      truncated: sorted.truncated,
    };
  }

  /**
   * 组 /context 的响应。
   * @param {object} input `{active, documents, diagnostics}`
   *   - `active`: `null` 或 `{path, name, language, dirty, selection: {startLine, startColumn, endLine, endColumn}|null, selectedText?}`
   *   - `documents`: `[{path, name, dirty, unsavedLines, untitled}]`
   *   - `diagnostics`: 同 `diagnostics()` 的入参
   */
  function context(input) {
    const notes = [];
    const active = input.active === null || input.active === undefined
      ? null
      : (() => {
        const item = {
          path: input.active.path ?? null,
          name: input.active.name ?? null,
          language: input.active.language ?? null,
          dirty: input.active.dirty === true,
          selection: input.active.selection ?? null,
        };
        if (typeof input.active.selectedText === 'string' && input.active.selectedText !== '') {
          const raw = input.active.selectedText;
          item.selectedText = raw.length > MAX_SELECTION_CHARS ? `${raw.slice(0, MAX_SELECTION_CHARS)}\n…(已截断)` : raw;
          if (raw.length > MAX_SELECTION_CHARS) notes.push('选中文本已截断');
        }
        return item;
      })();

    const dirtyBuffers = (Array.isArray(input.documents) ? input.documents : [])
      .filter((doc) => doc !== null && doc.dirty === true)
      .map((doc) => ({
        path: doc.path ?? null,
        name: doc.name ?? null,
        unsavedLines: Number.isSafeInteger(doc.unsavedLines) ? doc.unsavedLines : null,
        untitled: doc.untitled === true,
      }));

    // 问题面板按文件聚合(只算工作区内的):给模型一个"哪里有问题"的量级,细节按需再查。
    const all = filterDiagnostics(input.diagnostics);
    const byFile = new Map();
    for (const item of all) {
      const current = byFile.get(item.path);
      if (current === undefined) byFile.set(item.path, item);
      else if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[current.severity]) byFile.set(item.path, item);
    }
    const problems = [...byFile.values()]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.path < b.path ? -1 : 1))
      .slice(0, MAX_PROBLEM_SUMMARIES)
      .map((item) => ({ path: item.path, line: item.line, severity: item.severity, message: item.message }));
    if (byFile.size > MAX_PROBLEM_SUMMARIES) notes.push(`问题面板仅列出前 ${MAX_PROBLEM_SUMMARIES} 个文件(共 ${byFile.size} 个)`);

    return {
      available: true,
      active,
      dirtyBuffers,
      problems,
      diagnosticCount: all.length,
      truncated: notes.join(';'),
    };
  }

  return { context, diagnostics, filterDiagnostics };
}

module.exports = {
  MAX_SELECTION_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_DIAGNOSTICS,
  MAX_PROBLEM_SUMMARIES,
  SEVERITY_RANK,
  severityName,
  normalizeDiagnostic,
  sortDiagnostics,
  createProjector,
};
