/**
 * GoodLink 夸克直链助手 — Content Script
 *
 * 普通浏览器也注入面板用于抓直链和发送 Motrix；只有“抓取/自动更新完整 Cookie”限制在无痕模式。
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[GoodLink Quark]';
  function log(msg) { console.log(LOG_PREFIX + ' ' + msg); }

  function getRpcConfigPromptDefaults(source) {
    source = source || {};
    return {
      rpcUrl: source.rpcUrl || 'http://127.0.0.1:29100/jsonrpc',
      // Secret 允许为空字符串；只有 undefined/null 才回落为空，避免把“主动清空”误判成未加载。
      secret: source.rpcSecret == null ? '' : String(source.rpcSecret),
    };
  }

  function resolveRpcConfigPromptResult(input) {
    input = input || {};
    var currentUrl = input.currentUrl || 'http://127.0.0.1:29100/jsonrpc';
    var currentSecret = input.currentSecret == null ? '' : String(input.currentSecret);
    // prompt 返回 null 表示取消；取消必须原样保留旧配置，不向后台发送保存请求。
    if (input.promptedUrl === null || input.promptedSecret === null) {
      return { shouldSave: false, canceled: true, rpcUrl: currentUrl, secret: currentSecret };
    }
    return {
      shouldSave: true,
      canceled: false,
      rpcUrl: String(input.promptedUrl || currentUrl).trim() || currentUrl,
      // 用户确认空字符串才表示主动清空 Secret。
      secret: input.promptedSecret == null ? currentSecret : String(input.promptedSecret),
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getRpcConfigPromptDefaults: getRpcConfigPromptDefaults, resolveRpcConfigPromptResult: resolveRpcConfigPromptResult };
  }

  if (!location.hostname.includes('quark.cn')) return;

  var canCaptureCookies = !!chrome.extension.inIncognitoContext;
  if (!canCaptureCookies) {
    log('普通浏览器窗口：仅启用直链和 Motrix，Cookie 刷新需无痕模式');
  }

  var state = {
    accounts: [],
    links: [],
    selectedAccountId: '',
    rpcUrl: 'http://127.0.0.1:29100/jsonrpc',
    rpcSecret: '',
    hasSecret: false,
  };

  function esc(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function formatSize(bytes) {
    var n = Number(bytes || 0);
    if (!n) return '';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var idx = 0;
    while (n >= 1024 && idx < units.length - 1) { n /= 1024; idx++; }
    return n.toFixed(idx > 0 ? 1 : 0) + ' ' + units[idx];
  }

  function send(type, payload, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || 10000;
    return new Promise(function(resolve) {
      var settled = false;
      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: '扩展后台响应超时，请检查扩展 Service Worker 是否正常，或稍后重试。' });
      }, timeoutMs);
      function finish(response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      }
      try {
        chrome.runtime.sendMessage({ type: type, payload: payload }, function(response) {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          finish(response || { ok: false, error: '扩展后台无响应' });
        });
      } catch (e) {
        finish({ ok: false, error: e.message || String(e) });
      }
    });
  }

  function isSharePage() {
    return /\/s\//.test(location.pathname) || /\/share\//.test(location.pathname);
  }

  function getPwdId() {
    try {
      var match = location.pathname.match(/^\/(?:s|share)\/([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    } catch (e) {}
    return '';
  }

  var pageExtractorReady = false;
  var pageExtractorPromise = null;

  function injectPageExtractor() {
    if (pageExtractorReady) return Promise.resolve();
    if (pageExtractorPromise) return pageExtractorPromise;

    pageExtractorPromise = new Promise(function(resolve) {
      function finish() {
        pageExtractorReady = true;
        window.removeEventListener('message', onReady);
        resolve();
      }
      function onReady(event) {
        if (event.source !== window) return;
        if (event.data && event.data.type === 'GOODLINK_EXT_EXTRACTOR_READY') finish();
      }

      window.addEventListener('message', onReady);

      var existing = document.getElementById('gl-ext-page-extractor');
      if (existing) {
        setTimeout(finish, 50);
        return;
      }

      var script = document.createElement('script');
      script.id = 'gl-ext-page-extractor';
      script.src = chrome.runtime.getURL('page-extractor.js');
      script.onload = function() {
        // page-extractor.js 会主动 postMessage READY；这里加兜底，避免页面消息被浏览器扩展策略吞掉时永久等待。
        setTimeout(finish, 50);
      };
      script.onerror = function() {
        window.removeEventListener('message', onReady);
        pageExtractorPromise = null;
        resolve();
      };
      (document.head || document.documentElement).appendChild(script);
    });

    return pageExtractorPromise;
  }

  function requestSelectedFiles() {
    return injectPageExtractor().then(function() {
      return new Promise(function(resolve) {
        var requestId = 'gl-ext-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        var timer = setTimeout(function() {
          window.removeEventListener('message', onMessage);
          resolve({ files: [], diag: ['页面文件提取超时：page-extractor.js 未返回 GOODLINK_EXT_FILES'] });
        }, 5000);
        function onMessage(event) {
          if (event.source !== window) return;
          if (!event.data || event.data.type !== 'GOODLINK_EXT_FILES' || event.data.requestId !== requestId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(event.data.result || { files: [], diag: [] });
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'GOODLINK_EXT_EXTRACT_FILES', requestId: requestId }, '*');
      });
    });
  }

  function shouldFallbackToBackgroundDirectLinks(errorText) {
    if (!errorText) return true;
    if (errorText.indexOf('23018') >= 0) return false;
    if (errorText.indexOf('download file size limit') >= 0) return false;
    if (errorText.indexOf('Invalid CORS request') >= 0) return false;
    return true;
  }

  function fetchDirectLinksInPage(payload) {
    return injectPageExtractor().then(function() {
      return new Promise(function(resolve) {
        var requestId = 'gl-ext-direct-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        var timer = setTimeout(function() {
          window.removeEventListener('message', onMessage);
          resolve({ ok: false, error: '页面世界直链接口超时：未返回 GOODLINK_EXT_DIRECT_LINKS' });
        }, 15000);
        function onMessage(event) {
          if (event.source !== window) return;
          if (!event.data || event.data.type !== 'GOODLINK_EXT_DIRECT_LINKS' || event.data.requestId !== requestId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(event.data);
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'GOODLINK_EXT_FETCH_DIRECT_LINKS', requestId: requestId, payload: payload }, '*');
      });
    });
  }

  function ensurePanel() {
    var old = document.getElementById('gl-ext-panel');
    if (old) return old;

    var panel = document.createElement('div');
    panel.id = 'gl-ext-panel';
    panel.innerHTML = '' +
      '<style>' +
      '#gl-ext-panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:420px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;color:#202124;overflow:hidden}' +
      '#gl-ext-panel .gl-h{padding:14px 16px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;display:flex;justify-content:space-between;align-items:center;cursor:move}' +
      '#gl-ext-panel .gl-h h3{font-size:15px;font-weight:700;margin:0}' +
      '#gl-ext-panel .gl-close{font-size:20px;cursor:pointer;opacity:.85}' +
      '#gl-ext-panel .gl-body{padding:14px;max-height:580px;overflow-y:auto}' +
      '#gl-ext-panel .gl-status{padding:10px;background:#f8f9fa;border-radius:8px;margin-bottom:10px;font-size:12px;line-height:1.7}' +
      '#gl-ext-panel .gl-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}' +
      '#gl-ext-panel .gl-btn{padding:8px 12px;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}' +
      '#gl-ext-panel .gl-primary{background:#6c5ce7;color:#fff}' +
      '#gl-ext-panel .gl-accent{background:#00b894;color:#fff}' +
      '#gl-ext-panel .gl-secondary{background:#f0edff;color:#6c5ce7}' +
      '#gl-ext-panel .gl-btn:disabled{opacity:.55;cursor:not-allowed}' +
      '#gl-ext-panel .gl-account{font-size:12px;padding:8px;background:#fafafa;border-radius:8px;margin-bottom:8px}' +
      '#gl-ext-panel .gl-link{padding:10px;margin-bottom:6px;border-radius:8px;background:#f8f7ff;border:1px solid #e8e5ff;font-size:12px}' +
      '#gl-ext-panel .gl-link-name{font-weight:700;color:#6c5ce7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#gl-ext-panel .gl-link-url{display:block;color:#5f6368;font-size:11px;line-height:1.5;word-break:break-all;max-height:40px;overflow:hidden;padding:4px 6px;background:#fff;border-radius:4px;border:1px solid #eee;font-family:monospace}' +
      '#gl-ext-panel .gl-log{background:#1e1e2e;color:#a6adc8;padding:10px;border-radius:8px;font-family:monospace;font-size:11px;max-height:130px;overflow-y:auto;white-space:pre-wrap;line-height:1.6;margin-top:10px}' +
      '#gl-ext-panel .ok{color:#a6e3a1}#gl-ext-panel .err{color:#f38ba8}' +
      '</style>' +
      '<div class="gl-h"><h3>GoodLink 夸克直链助手</h3><span class="gl-close" id="gl-ext-close">&times;</span></div>' +
      '<div class="gl-body">' +
      '<div id="gl-ext-status" class="gl-status">正在读取 Cookie 状态...</div>' +
      '<div id="gl-ext-accounts" class="gl-account">账号池加载中...</div>' +
      '<div class="gl-row">' +
      '<button class="gl-btn gl-secondary" id="gl-ext-refresh-cookie">刷新 Cookie</button>' +
      '<button class="gl-btn gl-primary" id="gl-ext-get-links">获取直链</button>' +
      '<button class="gl-btn gl-accent" id="gl-ext-send-motrix">发送到 Motrix</button>' +
      '<button class="gl-btn gl-secondary" id="gl-ext-copy-links">复制直链</button>' +
      '<button class="gl-btn gl-secondary" id="gl-ext-config-rpc">更改 RPC 配置</button>' +
      '</div>' +
      '<div id="gl-ext-links"></div>' +
      '<div id="gl-ext-log" class="gl-log"></div>' +
      '</div>';
    document.body.appendChild(panel);

    var isDragging = false;
    var dx = 0;
    var dy = 0;
    var header = panel.querySelector('.gl-h');
    header.addEventListener('mousedown', function(e) {
      isDragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function() { isDragging = false; });
    panel.querySelector('#gl-ext-close').onclick = function() { panel.remove(); };

    bindPanelEvents(panel);
    return panel;
  }

  var logLines = [];
  function panelLog(msg, cls) {
    var el = document.getElementById('gl-ext-log');
    var text = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    logLines.push({ text: text, cls: cls || '' });
    if (logLines.length > 50) logLines.shift();
    if (el) {
      el.innerHTML = logLines.map(function(line) { return '<span class="' + line.cls + '">' + esc(line.text) + '</span>'; }).join('\n');
      el.scrollTop = el.scrollHeight;
    }
    log(msg);
  }

  function updateStatus(message, cls) {
    var el = document.getElementById('gl-ext-status');
    if (!el) return;
    el.innerHTML = message;
    el.style.background = cls === 'ok' ? '#f0fff7' : cls === 'err' ? '#fff5f5' : '#f8f9fa';
  }

  function renderAccounts() {
    var el = document.getElementById('gl-ext-accounts');
    if (!el) return;
    if (!state.accounts.length) {
      el.innerHTML = '无可用 Cookie。请先在无痕夸克页面登录，然后点“刷新 Cookie”。';
      return;
    }
    var options = state.accounts.map(function(account) {
      var label = account.account_name + ' · cookies=' + account.cookie_count + ' · httpOnly=' + (account.httpOnlyCount || 0);
      return '<option value="' + esc(account.id) + '" ' + (state.selectedAccountId === account.id ? 'selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    el.innerHTML = '<div style="margin-bottom:6px;font-weight:700">Cookie 账号池</div><select id="gl-ext-account-select" style="width:100%;padding:7px;border:1px solid #dadce0;border-radius:6px">' + options + '</select>';
    var sel = document.getElementById('gl-ext-account-select');
    if (sel) sel.onchange = function() { state.selectedAccountId = sel.value; };
  }

  function renderLinks() {
    var el = document.getElementById('gl-ext-links');
    if (!el) return;
    if (!state.links.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = state.links.map(function(link, idx) {
      return '<div class="gl-link">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><span class="gl-link-name">' + esc(link.name || '未命名') + '</span><span style="font-size:11px;color:#00b894;flex-shrink:0">' + esc(link.host || '') + '</span></div>' +
        '<div style="font-size:11px;color:#80868b;margin-bottom:4px">' + esc(formatSize(link.size)) + '</div>' +
        '<div class="gl-link-url" title="' + esc(link.url || '') + '">' + esc(link.url || '') + '</div>' +
        '<div style="margin-top:6px"><button class="gl-btn gl-secondary" data-copy-link="' + idx + '">复制</button></div>' +
      '</div>';
    }).join('');
    el.querySelectorAll('[data-copy-link]').forEach(function(btn) {
      btn.onclick = function() {
        var link = state.links[Number(btn.getAttribute('data-copy-link'))];
        if (!link) return;
        navigator.clipboard.writeText(link.url || '');
        btn.textContent = '已复制';
        setTimeout(function() { btn.textContent = '复制'; }, 1200);
      };
    });
  }

  async function loadAccounts() {
    var res = await send('GL_QUARK_GET_ACCOUNTS');
    if (!res.ok) {
      updateStatus('读取账号池失败：' + esc(res.error || '未知错误'), 'err');
      return;
    }
    state.accounts = res.accounts || [];
    state.rpcUrl = res.rpcUrl || state.rpcUrl;
    state.rpcSecret = res.rpcSecret == null ? '' : String(res.rpcSecret);
    state.hasSecret = !!state.rpcSecret;
    if (!state.selectedAccountId && state.accounts[0]) state.selectedAccountId = state.accounts[0].id;
    renderAccounts();
    updateStatus('账号池：' + state.accounts.length + ' 个；RPC：' + esc(state.rpcUrl) + (state.hasSecret ? '（已设置 Secret）' : '（无 Secret）'), state.accounts.length ? 'ok' : '');
  }

  async function refreshCookie() {
    if (!canCaptureCookies) {
      panelLog('当前是普通窗口：只支持获取直链和发送 Motrix；完整 Cookie 自动刷新请到无痕窗口登录夸克后使用。', 'err');
      updateStatus('普通窗口可抓直链；刷新完整 Cookie 请用无痕窗口。', 'err');
      return;
    }
    panelLog('开始刷新当前无痕窗口 Cookie...');
    var res = await send('GL_QUARK_REFRESH_COOKIES');
    if (!res.ok) {
      panelLog('Cookie 刷新失败：' + (res.error || '未知错误'), 'err');
      updateStatus('Cookie 刷新失败：' + esc(res.error || '未知错误'), 'err');
      return;
    }
    state.accounts = res.accounts || [];
    state.selectedAccountId = res.account && res.account.id || state.selectedAccountId;
    renderAccounts();
    updateStatus('Cookie 已刷新：' + esc(res.account.account_name) + '，共 ' + res.account.cookie_count + ' 个 Cookie。', 'ok');
    panelLog('Cookie 已刷新：' + res.account.account_name + ' cookies=' + res.account.cookie_count + ' httpOnly=' + (res.account.httpOnlyCount || 0), 'ok');
  }

  async function getLinks() {
    var btn = document.getElementById('gl-ext-get-links');
    if (btn) { btn.disabled = true; btn.textContent = '获取中...'; }
    try {
      var selected = await requestSelectedFiles();
      var files = (selected.files || []).filter(function(item) { return item && item.isFile !== false; });
      if (!files.length) {
        panelLog('未提取到选中文件，请选中文件后重试。' + ((selected.diag || []).length ? ' diag=' + selected.diag.join(' | ') : ''), 'err');
        return;
      }
      var payload = {
        files: files,
        pwdId: getPwdId(),
        stoken: files[0].stoken || '',
        isSharePage: isSharePage(),
      };
      panelLog('开始获取直链：文件数=' + files.length);
      var res = await fetchDirectLinksInPage(payload);
      if (!res.ok) {
        panelLog('页面直链获取失败：' + (res.error || '未知错误'), 'err');
        if (shouldFallbackToBackgroundDirectLinks(res.error)) {
          panelLog('尝试扩展后台账号池路径...', '');
          res = await send('GL_QUARK_GET_DIRECT_LINKS', { accountId: state.selectedAccountId, payload: payload });
        } else {
          panelLog('当前为页面身份/大小限制或扩展域 CORS 问题，不再尝试扩展后台直链路径，避免重复报错。', 'err');
        }
      }
      if (!res.ok) {
        panelLog('获取直链失败：' + (res.error || '未知错误'), 'err');
        updateStatus('获取直链失败：' + esc(res.error || '未知错误'), 'err');
        return;
      }
      state.links = res.links || [];
      renderLinks();
      updateStatus('已获取 ' + state.links.length + ' 个直链，可发送到 Motrix。', 'ok');
      panelLog('已获取 ' + state.links.length + ' 个直链，账号=' + (res.account && res.account.account_name || ''), 'ok');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '获取直链'; }
    }
  }

  async function sendMotrix() {
    if (!state.links.length) {
      panelLog('请先获取直链。', 'err');
      return;
    }
    var btn = document.getElementById('gl-ext-send-motrix');
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
    try {
      var res = await send('GL_QUARK_MOTRIX_SEND', { accountId: state.selectedAccountId, source: state.links[0] }, { timeoutMs: 15000 });
      if (!res.ok) {
        panelLog('发送到 Motrix 失败：' + (res.error || '未知错误'), 'err');
        panelLog('请确认 Motrix 已打开并开启 RPC；如果端口或密码改过，请点击“更改 RPC 配置”。', 'err');
        updateStatus('发送到 Motrix 失败：' + esc(res.error || '未知错误') + '<br>请检查 Motrix RPC，或点击“更改 RPC 配置”。', 'err');
        return;
      }
      panelLog('已发送到 Motrix，GID=' + (res.gid || '未知') + '，连接数=256', 'ok');
      updateStatus('已发送到 Motrix，GID=' + esc(res.gid || '未知') + '。', 'ok');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '发送到 Motrix'; }
    }
  }

  async function configureRpc() {
    var defaults = getRpcConfigPromptDefaults(state);
    var promptedUrl = prompt('Motrix/aria2 RPC URL', defaults.rpcUrl);
    var promptedSecret = promptedUrl === null ? null : prompt('Motrix/aria2 RPC Secret；没有密钥则留空', defaults.secret);
    var next = resolveRpcConfigPromptResult({
      currentUrl: defaults.rpcUrl,
      currentSecret: defaults.secret,
      promptedUrl: promptedUrl,
      promptedSecret: promptedSecret,
    });
    if (!next.shouldSave) {
      panelLog('已取消 RPC 配置修改，保留原 URL/Secret。');
      return;
    }
    var res = await send('GL_QUARK_SAVE_RPC_CONFIG', { rpcUrl: next.rpcUrl, secret: next.secret });
    state.rpcUrl = next.rpcUrl;
    state.rpcSecret = next.secret;
    state.hasSecret = !!next.secret;
    if (res.ok) panelLog('RPC 配置已保存并连接成功：aria2 ' + (res.version || 'unknown'), 'ok');
    else panelLog('RPC 配置已保存，但连接失败：' + (res.error || '未知错误'), 'err');
    await loadAccounts();
  }

  function copyLinks() {
    if (!state.links.length) {
      panelLog('没有直链可复制。', 'err');
      return;
    }
    navigator.clipboard.writeText(state.links.map(function(link) { return link.url; }).join('\n'));
    panelLog('已复制 ' + state.links.length + ' 个直链。', 'ok');
  }

  function bindPanelEvents(panel) {
    panel.querySelector('#gl-ext-refresh-cookie').onclick = refreshCookie;
    panel.querySelector('#gl-ext-get-links').onclick = getLinks;
    panel.querySelector('#gl-ext-send-motrix').onclick = sendMotrix;
    panel.querySelector('#gl-ext-copy-links').onclick = copyLinks;
    panel.querySelector('#gl-ext-config-rpc').onclick = configureRpc;
  }

  function injectFloatingButton() {
    if (document.getElementById('gl-ext-open')) return;
    var btn = document.createElement('button');
    btn.id = 'gl-ext-open';
    btn.textContent = '⚡ GoodLink 直链';
    btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483646;padding:12px 18px;border:none;border-radius:8px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(108,92,231,.35);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';
    btn.onclick = async function() {
      ensurePanel();
      await loadAccounts();
    };
    document.body.appendChild(btn);
  }

  async function init() {
    log((canCaptureCookies ? '无痕模式' : '普通模式') + '已注入: ' + location.href);
    injectPageExtractor();
    injectFloatingButton();
    if (canCaptureCookies) {
      // 仅无痕窗口自动刷新完整 Cookie；普通窗口保留面板用于抓直链和发送 Motrix。
      send('GL_QUARK_REFRESH_COOKIES').then(function(res) {
        if (res && res.ok) {
          state.accounts = res.accounts || [];
          state.selectedAccountId = res.account && res.account.id || state.selectedAccountId;
          panelLog('自动刷新 Cookie 成功：' + res.account.account_name, 'ok');
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
