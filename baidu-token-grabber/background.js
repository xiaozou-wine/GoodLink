/**
 * GoodLink Background Service Worker
 *
 * 流程：打开 pan.baidu.com → 用户登录 → 跳转 OAuth → 捕获 token → 导出 → 关窗口
 */

const BAIDU_CLIENT_ID = 'IlLqBbU3GjQ0t46TRwFateTprHWl39zF';
const BAIDU_OAUTH_URL = `https://openapi.baidu.com/oauth/2.0/authorize?client_id=${BAIDU_CLIENT_ID}&response_type=token&redirect_uri=oob&confirm_login=0&scope=basic,netdisk`;

function log(msg) { console.log(`[GoodLink BG] ${msg}`); }

// 记录哪些 tab 访问过 passport（用于区分首次加载和登录回跳）
const passportVisited = new Set();

// ==================== 获取 BDUSS ====================
async function getBDUSS() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    for (const store of stores) {
      const cookies = await chrome.cookies.getAll({ url: 'https://pan.baidu.com/', name: 'BDUSS', storeId: store.id });
      if (cookies.length > 0) { log(`BDUSS 找到 (store: ${store.id})`); return cookies[0].value; }
    }
  } catch (e) { log(`BDUSS 失败: ${e.message}`); }
  return '';
}

// ==================== 获取用户名 ====================
async function getBaiduUsername(token) {
  try {
    const r = await fetch(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token}`);
    const d = await r.json();
    if (d.baidu_name || d.netdisk_name) return d.baidu_name || d.netdisk_name;
  } catch (e) {}
  return 'unknown';
}

// ==================== 导出 ====================
async function exportToFile(data) {
  const { gl_export_path = '' } = await chrome.storage.local.get('gl_export_path');
  const dir = gl_export_path || 'GoodLink_tokens';
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
  try {
    await chrome.downloads.download({ url, filename: `${dir}/${data.account_name}.json`, saveAs: false });
    return true;
  } catch (e) { log(`导出失败: ${e.message}`); return false; }
}

// ==================== Token 处理 ====================
async function handleTokenCapture(tokenData) {
  log('=== Token 处理 ===');
  const bduss = await getBDUSS();
  const username = await getBaiduUsername(tokenData.access_token);
  const { gl_accounts = [] } = await chrome.storage.local.get('gl_accounts');
  const count = gl_accounts.length + 1;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `百度账号${count}_${date}`;

  const data = {
    account_name: name, baidu_username: username,
    access_token: tokenData.access_token, expires_in: tokenData.expires_in || '',
    scope: tokenData.scope || '', refresh_token: tokenData.refresh_token || '',
    bduss, captured_at: new Date().toISOString(), source: 'GoodLink Token Grabber'
  };

  const exported = await exportToFile(data);
  gl_accounts.push({ account_name: name, baidu_username: username, access_token: tokenData.access_token, bduss, captured_at: data.captured_at });
  await chrome.storage.local.set({
    gl_accounts, gl_state: 'done',
    gl_last_result: { account_name: name, baidu_username: username, has_bduss: !!bduss, exported, captured_at: data.captured_at }
  });

  const { gl_incognito_window_id } = await chrome.storage.local.get('gl_incognito_window_id');
  if (gl_incognito_window_id) { try { await chrome.windows.remove(gl_incognito_window_id); } catch (e) {} }
  log('=== 完成 ===');
}

// ==================== 启动：打开 pan.baidu.com ====================
async function startCapture() {
  await chrome.storage.local.set({ gl_state: 'capturing', gl_last_result: null });
  try {
    const win = await chrome.windows.create({ url: 'https://pan.baidu.com/', incognito: true, focused: true, type: 'normal', width: 900, height: 700 });
    await chrome.storage.local.set({ gl_incognito_window_id: win.id });
    log(`无痕窗口已打开 (id: ${win.id})`);
  } catch (e) { log(`失败: ${e.message}`); await chrome.storage.local.set({ gl_state: 'error' }); }
}

// ==================== 跳转 OAuth（手动/自动） ====================
async function goToOAuth() {
  const { gl_incognito_window_id } = await chrome.storage.local.get('gl_incognito_window_id');
  let tabId = null;

  if (gl_incognito_window_id) {
    try {
      const tabs = await chrome.tabs.query({ windowId: gl_incognito_window_id });
      if (tabs.length > 0) tabId = tabs[0].id;
    } catch (e) {}
  }
  if (!tabId) {
    try {
      const tabs = await chrome.tabs.query({ incognito: true });
      if (tabs.length > 0) tabId = tabs[0].id;
    } catch (e) {}
  }
  if (tabId) {
    await chrome.tabs.update(tabId, { url: BAIDU_OAUTH_URL });
    log('已跳转 OAuth');
  } else {
    log('找不到无痕 tab');
  }
}

// ==================== webNavigation：passport → pan 自动跳 OAuth ====================
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { gl_state } = await chrome.storage.local.get('gl_state');
  if (gl_state !== 'capturing') return;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (!tab || !tab.incognito) return;
    const url = details.url;

    // 记录访问过 passport 的 tab
    if (url.includes('passport.baidu.com')) {
      passportVisited.add(details.tabId);
      log(`tab ${details.tabId} → passport 登录页`);
      return;
    }

    // 从 passport 回到 pan.baidu.com = 登录成功
    if (url.includes('pan.baidu.com') && passportVisited.has(details.tabId)) {
      passportVisited.delete(details.tabId);
      log(`tab ${details.tabId} 从 passport 回来，登录成功 → 自动跳 OAuth`);
      setTimeout(() => goToOAuth(), 2000);
    }
  } catch (e) {}
}, {
  url: [{ hostContains: 'pan.baidu.com' }, { hostContains: 'passport.baidu.com' }]
});

// ==================== 消息 ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GL_TOKEN_CAPTURED':
      // 只处理来自无痕窗口的 token（普通窗口的忽略）
      if (sender.tab && sender.tab.incognito) {
        handleTokenCapture(msg.token);
      } else {
        log(`忽略非无痕窗口的 token (tab: ${sender.tab?.id})`);
      }
      break;
    case 'GL_START_CAPTURE': startCapture(); break;
    case 'GL_FORCE_OAUTH': goToOAuth(); break;
    case 'GL_RESET': chrome.storage.local.set({ gl_state: 'idle', gl_last_result: null }); break;
  }
  sendResponse({ ok: true });
  return true;
});

// 窗口关闭 → 重置
chrome.windows.onRemoved.addListener(async (winId) => {
  const s = await chrome.storage.local.get(['gl_incognito_window_id', 'gl_state']);
  if (winId === s.gl_incognito_window_id && s.gl_state === 'capturing') {
    await chrome.storage.local.set({ gl_state: 'idle' });
  }
});

log('已启动');
