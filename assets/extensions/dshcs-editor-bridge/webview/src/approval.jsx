// dshcs-editor-bridge / webview/src/approval.jsx —— 待决授权卡片(0.2.3)
//
// 背景(见 lib/bridge-approval.mjs):DSH 的敏感动作(写工作区外的文件、执行命令)会走
// `approval/request` 这条 agent 作用域的 waterfall。面板在旁边看的时候先接住它:
//   - 用户在这张卡片上点「允许一次 / 拒绝」→ 立刻生效(官方卡片不再出现);
//   - 窗口内没人答(倒计时走完)→ 交回官方链路,DSH 界面里照旧弹同一张卡片。
//
// 卡片只做两件事:**显示**这次请求要干什么(工具名 + 原因),**回答**它。
// 没有任何"记住这次选择""以后都允许"的入口 —— 授权只对这一次动作有效。

/** 毫秒 → 剩余秒数(向上取整,0 表示已过期)。 */
function secondsLeft(item, holdMs, now) {
  const deadline = (Number.isSafeInteger(item.at) ? item.at : now) + holdMs;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function ApprovalCard({ item, holdMs, now, decided, onDecide }) {
  const left = secondsLeft(item, holdMs, now);
  const expired = left <= 0;
  const choice = decided ?? null;
  const locked = expired || choice !== null;

  return (
    <div className="dshcs-approval" data-decided={choice ?? undefined}>
      <div className="dshcs-approval-head">
        <span className="dshcs-approval-title">需要你的授权</span>
        <span className="dshcs-approval-timer">
          {expired ? '已交给 DSH 界面' : `${left}s 后交给 DSH 界面`}
        </span>
      </div>
      <div className="dshcs-approval-body">
        <span className="dshcs-approval-tool">{item.toolName}</span>
        {item.reason === '' ? null : <div className="dshcs-approval-reason">{item.reason}</div>}
      </div>
      <div className="dshcs-approval-actions">
        <button type="button" disabled={locked} onClick={() => onDecide(item.id, 'allowed-once')}>
          允许一次
        </button>
        <button type="button" disabled={locked} onClick={() => onDecide(item.id, 'rejected')}>
          拒绝
        </button>
        {choice === null ? null : (
          <span className="dshcs-approval-note">
            {choice === 'allowed-once' ? '已允许一次(DSH 继续执行)' : '已拒绝'}
          </span>
        )}
        {choice === null && expired ? (
          <span className="dshcs-approval-note">这条请求已交给 DSH 界面,请在那边处理</span>
        ) : null}
      </div>
    </div>
  );
}
