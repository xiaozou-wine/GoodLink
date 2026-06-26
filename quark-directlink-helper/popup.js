/**
 * GoodLink 夸克 Cookie 抓取器 — Popup
 */
var $ = function(id) { return document.getElementById(id); };

// ==================== 无痕权限检测 ====================
async function checkIncognito() {
  var warn = $('incognito-warning');
  var idle = $('view-idle');
  try {
    var allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) {
      warn.style.display = 'block';
      idle.style.display = 'none';
      return false;
    }
  } catch (e) { /* API 不可用时跳过 */ }
  warn.style.display = 'none';
  return true;
}

// ==================== 视图切换 ====================
function showView(name) {
  ['idle', 'capturing', 'done'].forEach(function(v) {
    var el = $('view-' + v);
    if (el) el.style.display = v === name ? 'block' : 'none';
  });
}

// ==================== Toast ====================
function showToast(msg) {
  var el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2000);
}

// ==================== 复制文本 ====================
function copyText(text) {
  navigator.clipboard.writeText(text).then(function() {
    showToast('已复制');
  }).catch(function() {
    showToast('复制失败');
  });
}

// ==================== 渲染结果 ====================
function renderResult(r) {
  if (!r) return;

  var items = [
    { label: '账号', value: r.account_name },
    { label: '昵称', value: r.quark_nickname || '未获取' },
    { label: 'Cookie 数量', value: r.cookie_count + ' 个' },
    { label: '__puus', value: r.has_puus ? '✅ ' + r.has_puus_value : '❌ 未获取', tag: r.has_puus ? 'success' : 'error' },
    { label: 'tfstk', value: r.has_tfstk ? '✅ 已获取' : '⚠️ 未获取', tag: r.has_tfstk ? 'success' : 'warning' },
    { label: '_UP_* Cookie', value: r._UP_count + ' 个', tag: r._UP_count > 0 ? 'success' : 'warning' },
    { label: '字符串长度', value: r.cookie_string_length + ' 字符' },
    { label: '导出', value: r.exported ? '成功' : '失败', tag: r.exported ? 'success' : 'error' },
    { label: '时间', value: new Date(r.captured_at).toLocaleString() }
  ];

  $('result-content').innerHTML = items.map(function(i) {
    var val;
    if (i.tag) {
      val = '<span class="tag tag-' + i.tag + '">' + i.value + '</span>';
    } else {
      val = '<span class="result-value" onclick="copyText(this.textContent)">' + i.value + '</span>';
    }
    return '<div class="result-item"><span class="result-label">' + i.label + '</span>' + val + '</div>';
  }).join('');
}

// ==================== 渲染历史 ====================
function renderHistory(accounts) {
  var sec = $('history-section');
  if (!accounts || !accounts.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  $('history-count').textContent = accounts.length;
  $('history-list').innerHTML = accounts.slice().reverse().map(function(a) {
    return '<div class="history-item">' +
      '<span class="history-name">' + a.account_name + '</span>' +
      '<span style="color:#80868b;font-size:11px">' +
        (a.has_puus ? '✅' : '❌') + ' __puus · ' +
        (a.cookie_count || '?') + ' cookies · ' +
        new Date(a.captured_at).toLocaleDateString() +
      '</span></div>';
  }).join('');
}

// ==================== 初始化 ====================
async function init() {
  await checkIncognito();

  var data = await chrome.storage.local.get(['gl_export_path', 'gl_state', 'gl_last_result', 'gl_accounts']);
  var gl_export_path = data.gl_export_path || '';
  var gl_state = data.gl_state || 'idle';
  var gl_last_result = data.gl_last_result || null;
  var gl_accounts = data.gl_accounts || [];

  $('export-path').value = gl_export_path;

  if (gl_state === 'done') {
    showView('done');
    renderResult(gl_last_result);
    // 尝试加载 cookie 预览
    loadCookiePreview();
  } else if (gl_state === 'capturing') {
    showView('capturing');
  } else {
    showView('idle');
  }

  renderHistory(gl_accounts);
}

// ==================== 加载 Cookie 预览 ====================
async function loadCookiePreview() {
  // 从最近导出的数据中显示关键 cookie
  var data = await chrome.storage.local.get(['gl_last_cookie_data']);
  var cookieData = data.gl_last_cookie_data;

  if (cookieData) {
    var preview = [];
    if (cookieData.__puus) preview.push('__puus = ' + cookieData.__puus.slice(0, 40) + '...');
    if (cookieData.tfstk) preview.push('tfstk = ' + cookieData.tfstk.slice(0, 40) + '...');
    if (cookieData._UP_names && cookieData._UP_names.length) {
      preview.push('_UP_* = ' + cookieData._UP_names.join(', '));
    }
    preview.push('全部 Cookie: ' + cookieData.total_count + ' 个');
    preview.push('字符串长度: ' + cookieData.string_length + ' 字符');

    $('cookie-preview').textContent = preview.join('\n');
    $('cookie-preview').style.display = 'block';
    $('cookie-preview-empty').style.display = 'none';
  }
}

// ==================== 事件绑定 ====================

// 开始抓取
$('btn-start').onclick = async function() {
  await chrome.storage.local.set({ gl_export_path: $('export-path').value.trim() });
  chrome.runtime.sendMessage({ type: 'GL_QUARK_START_CAPTURE' });
  showView('capturing');
};

// 立即抓取当前标签页
$('btn-grab-now').onclick = function() {
  chrome.runtime.sendMessage({ type: 'GL_QUARK_GRAB_NOW' });
  showToast('正在抓取...');
  // 延迟刷新状态
  setTimeout(init, 2000);
};

// 抓取中 - 手动确认抓取
$('btn-grab-while').onclick = function() {
  chrome.runtime.sendMessage({ type: 'GL_QUARK_GRAB_NOW' });
  showToast('正在抓取 Cookie...');
};

// 复制完整 Cookie 字符串
$('btn-copy-all').onclick = async function() {
  var data = await chrome.storage.local.get(['gl_last_cookie_data']);
  if (data.gl_last_cookie_data && data.gl_last_cookie_data.full_string) {
    copyText(data.gl_last_cookie_data.full_string);
  } else {
    showToast('Cookie 数据不可用，请重新抓取');
  }
};

// 重置
$('btn-reset').onclick = function() {
  chrome.runtime.sendMessage({ type: 'GL_QUARK_RESET' });
  showView('idle');
};

// 导出路径变化
$('export-path').onchange = function() {
  chrome.storage.local.set({ gl_export_path: $('export-path').value.trim() });
};

// 重新检测无痕权限
$('btn-recheck').onclick = async function() {
  var ok = await checkIncognito();
  if (ok) init();
};

// ==================== 状态变化自动刷新 ====================
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area !== 'local') return;

  if (changes.gl_state) {
    var newState = changes.gl_state.newValue;
    if (newState === 'done') {
      showView('done');
      chrome.storage.local.get(['gl_last_result', 'gl_accounts'], function(data) {
        renderResult(data.gl_last_result);
        renderHistory(data.gl_accounts);
        loadCookiePreview();
      });
    } else if (newState === 'idle') {
      showView('idle');
    } else if (newState === 'capturing') {
      showView('capturing');
    }
  }
});

init();
