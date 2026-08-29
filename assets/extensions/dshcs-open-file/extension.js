// dshcs-open-file:DSH host 通过信号文件请求打开文件。
// host 写入 <user-data>/User/dshcs-open.json 后,本扩展在已连接的窗口中打开该文件。
// 信号路径优先取环境变量 DSHCS_OPEN_FILE_SIGNAL(host 注入);
// 取不到时用 context.globalStorageUri 推导(=<user-data>/User/globalStorage/<id> 的上两级)。
const fs = require('fs');
const vscode = require('vscode');

function signalPath(context) {
  const envP = process.env.DSHCS_OPEN_FILE_SIGNAL;
  if (typeof envP === 'string' && envP !== '') return envP;
  try {
    const user = vscode.Uri.joinPath(context.globalStorageUri, '..', '..');
    return vscode.Uri.joinPath(user, 'dshcs-open.json').fsPath;
  } catch {
    return null;
  }
}

let timer = null;
function processSignal(signal) {
  let raw;
  try {
    raw = fs.readFileSync(signal, 'utf8');
  } catch {
    return; // 尚无信号
  }
  let file = null;
  try {
    file = JSON.parse(raw).file;
  } catch {
    return;
  }
  if (typeof file !== 'string' || file === '') return;
  const uri = vscode.Uri.file(file);
  vscode.window.showTextDocument(uri, { preview: false }).then(
    () => {
      try {
        fs.unlinkSync(signal);
      } catch {}
    },
    (err) => {
      // 尚未有窗口连接(或打开失败):保留信号,轮询会重试
      console.log('[dshcs-open-file] open failed, will retry:', err && err.message ? err.message : String(err));
    },
  );
}

function activate(context) {
  const signal = signalPath(context);
  if (signal === null) {
    console.log('[dshcs-open-file] no signal path (env/globalStorage both unavailable)');
    return;
  }
  console.log('[dshcs-open-file] watching ' + signal);
  // 启动先处理一次,随后每 800ms 轮询(信号可能由 host 晚些写入)
  processSignal(signal);
  timer = setInterval(function () { processSignal(signal); }, 800);
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
}

exports.activate = activate;
