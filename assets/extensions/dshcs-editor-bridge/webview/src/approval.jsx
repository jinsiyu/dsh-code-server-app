// dshcs-editor-bridge / webview/src/approval.jsx —— 待决授权卡片(0.2.3;0.2.4 修"失效")
//
// 背景(见 lib/bridge-approval.mjs):DSH 的敏感动作(写工作区外的文件、执行命令)会走
// `approval/request` 这条 agent 作用域的 waterfall。面板在旁边看的时候先接住它:
//   - 用户在这张卡片上点「允许一次 / 拒绝」→ 立刻生效(官方卡片不再出现);
//   - **面板关掉**(或等满宿主给的窗口,默认 5 分钟)→ 交回官方链路,DSH 界面里照旧弹同一张卡片。
//
// 0.2.3 的教训(用户实测:"授权框失效了"):卡片自己按 8 秒判过期 → 读完再点,按钮已经是灰的。
// 现在**不再由前端判过期**:只要卡片还在(宿主这边仍未决),按钮就可点;请求被交回官方链路时
// 它会从 `approvals` 里消失,面板改为显示审计行。倒计时只是"还有多久交回官方链路"的提示,
// 不再决定能不能点。
//
// 卡片只做两件事:**显示**这次请求要干什么(工具名 + 原因),**回答**它。
// 没有任何"记住这次选择""以后都允许"的入口 —— 授权只对这一次动作有效。

/** 剩余时间文案(超过一分钟就 mm:ss,避免秒数跳动带来的紧张感)。 */
function remainingText(item, holdMs, now) {
  const at = Number.isSafeInteger(item.at) ? item.at : now;
  const left = Math.max(0, at + holdMs - now);
  if (left === 0) return '已交回 DSH 界面';
  const totalSeconds = Math.ceil(left / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒后交回 DSH 界面`
    : `${seconds} 秒后交回 DSH 界面`;
}

export function ApprovalCard({ item, holdMs, now, decided, onDecide }) {
  const choice = decided ?? null;
  // 已提交(点了但宿主还没确认):锁住按钮避免连点;这张卡片何时消失由宿主决定。
  const locked = choice !== null;

  return (
    <div className="dshcs-approval" data-decided={choice ?? undefined}>
      <div className="dshcs-approval-head">
        <span className="dshcs-approval-title">需要你的授权</span>
        <span className="dshcs-approval-timer">{remainingText(item, holdMs, now)}</span>
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
        {choice === null
          ? <span className="dshcs-approval-note">只对这一次动作有效;关掉面板即交回 DSH 界面</span>
          : (
            <span className="dshcs-approval-note">
              {choice === 'allowed-once' ? '已允许一次(DSH 继续执行)' : '已拒绝'}
            </span>
          )}
      </div>
    </div>
  );
}
