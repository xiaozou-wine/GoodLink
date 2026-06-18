/**
 * GoodLink Popup — 简洁版
 */
const $ = id => document.getElementById(id);

// 检测是否允许在无痕模式运行
async function checkIncognito() {
  const warn = $('incognito-warning');
  const idle = $('view-idle');
  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) {
      warn.style.display = 'block';
      idle.style.display = 'none';
      return false;
    }
  } catch (e) {
    // API 不可用时跳过检测
  }
  warn.style.display = 'none';
  return true;
}

function showView(name) {
  ['idle', 'capturing', 'done'].forEach(v => {
    const el = $('view-' + v);
    if (el) el.style.display = v === name ? 'block' : 'none';
  });
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('已复制'));
}

function renderResult(r) {
  if (!r) return;
  const items = [
    { label: '账号', value: r.account_name },
    { label: '用户名', value: r.baidu_username },
    { label: 'BDUSS', value: r.has_bduss ? '已获取' : '未获取', tag: r.has_bduss ? 'success' : 'warning' },
    { label: '导出', value: r.exported ? '成功' : '失败', tag: r.exported ? 'success' : 'error' },
    { label: '时间', value: new Date(r.captured_at).toLocaleString() }
  ];
  $('result-content').innerHTML = items.map(i =>
    `<div class="result-item"><span class="result-label">${i.label}</span>${
      i.tag ? `<span class="tag tag-${i.tag}">${i.value}</span>`
            : `<span class="result-value" onclick="copyText('${i.value.replace(/'/g, "\\'")}')">${i.value}</span>`
    }</div>`
  ).join('');
}

function renderHistory(accounts) {
  const sec = $('history-section');
  if (!accounts || !accounts.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  $('history-count').textContent = accounts.length;
  $('history-list').innerHTML = accounts.slice().reverse().map(a =>
    `<div class="history-item"><span class="history-name">${a.account_name}</span><span style="color:#80868b;font-size:11px">${new Date(a.captured_at).toLocaleDateString()}</span></div>`
  ).join('');
}

// 初始化
async function init() {
  // 检测无痕权限
  await checkIncognito();

  const { gl_export_path = '', gl_state = 'idle', gl_last_result, gl_accounts = [] } =
    await chrome.storage.local.get(['gl_export_path', 'gl_state', 'gl_last_result', 'gl_accounts']);

  $('export-path').value = gl_export_path;
  showView(gl_state === 'done' ? 'done' : gl_state === 'capturing' ? 'capturing' : 'idle');
  if (gl_state === 'done') renderResult(gl_last_result);
  renderHistory(gl_accounts);
}

// 事件
$('btn-start').onclick = async () => {
  await chrome.storage.local.set({ gl_export_path: $('export-path').value.trim() });
  chrome.runtime.sendMessage({ type: 'GL_START_CAPTURE' });
  showView('capturing');
};

$('btn-force').onclick = () => {
  chrome.runtime.sendMessage({ type: 'GL_FORCE_OAUTH' });
  showToast('正在跳转...');
};

$('btn-reset').onclick = () => {
  chrome.runtime.sendMessage({ type: 'GL_RESET' });
  showView('idle');
};

$('export-path').onchange = () => {
  chrome.storage.local.set({ gl_export_path: $('export-path').value.trim() });
};

// 状态变化自动刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.gl_state?.newValue === 'done') {
    showView('done');
    chrome.storage.local.get(['gl_last_result', 'gl_accounts'], ({ gl_last_result, gl_accounts }) => {
      renderResult(gl_last_result);
      renderHistory(gl_accounts);
    });
  }
  if (changes.gl_state?.newValue === 'idle') showView('idle');
});

init();

// 重新检测无痕权限
$('btn-recheck').onclick = async () => {
  const ok = await checkIncognito();
  if (ok) {
    // 权限已开启，重新初始化
    const { gl_export_path = '', gl_state = 'idle', gl_last_result, gl_accounts = [] } =
      await chrome.storage.local.get(['gl_export_path', 'gl_state', 'gl_last_result', 'gl_accounts']);
    $('export-path').value = gl_export_path;
    showView(gl_state === 'done' ? 'done' : gl_state === 'capturing' ? 'capturing' : 'idle');
    if (gl_state === 'done') renderResult(gl_last_result);
    renderHistory(gl_accounts);
  }
};
