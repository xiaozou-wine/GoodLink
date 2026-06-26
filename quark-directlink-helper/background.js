/**
 * GoodLink 夸克直链助手 — Background Service Worker
 *
 * 责任：
 * 1. 只服务无痕夸克页面传来的请求，抓取 chrome.cookies 可见的完整 Cookie。
 * 2. 维护扩展内账号池，并在夸克 Cookie 变化时自动刷新当前无痕账号。
 * 3. 代页面面板调用夸克直链 API 和 Motrix/aria2 RPC，页面脚本不直接接触本地 RPC 细节。
 */

const QUARK_PAN_URL = 'https://pan.quark.cn/';
const QUARK_DRIVE_URL = 'https://drive-pc.quark.cn/';
const QUARK_API = 'https://drive-pc.quark.cn/1/clouddrive';
const QUARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch';
const MOTRIX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const DEFAULT_RPC_URL = 'http://127.0.0.1:29100/jsonrpc';
const DEFAULT_RPC_SECRET = '';
const RPC_TIMEOUT_MS = 8000;

const STORAGE_ACCOUNTS = 'gl_quark_accounts';
const STORAGE_LEGACY_ACCOUNTS = 'gl_accounts';
const STORAGE_LAST_RESULT = 'gl_last_result';
const STORAGE_LAST_COOKIE_DATA = 'gl_last_cookie_data';
const STORAGE_STATE = 'gl_state';
const STORAGE_RPC_URL = 'gl_motrix_rpc_url';
const STORAGE_RPC_SECRET = 'gl_motrix_rpc_secret';

function log(msg) { console.log(`[GoodLink Quark] ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizeCookieDomain(domain) {
  return String(domain || '').replace(/^\./, '').toLowerCase();
}

function isQuarkCookie(cookie) {
  const domain = normalizeCookieDomain(cookie?.domain || '');
  return domain === 'quark.cn' || domain.endsWith('.quark.cn');
}

async function getCookieStoreIdForTab(tabId) {
  if (!tabId) return '';
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(item => Array.isArray(item.tabIds) && item.tabIds.includes(tabId));
  return store?.id || '';
}

async function getAllQuarkCookies(storeId = '') {
  const allCookies = new Map();
  const stores = storeId
    ? [{ id: storeId }]
    : await chrome.cookies.getAllCookieStores();

  async function collect(query) {
    try {
      const cookies = await chrome.cookies.getAll(query);
      for (const c of cookies) {
        if (!isQuarkCookie(c)) continue;
        const key = `${c.name}`;
        const existing = allCookies.get(key);
        // 同名 Cookie 保留值更长或更贴近 quark.cn 的版本，避免拼接多个同名字段导致服务端解析不稳定。
        const cDomain = normalizeCookieDomain(c.domain);
        const eDomain = normalizeCookieDomain(existing?.domain);
        const preferCurrent = !existing
          || String(c.value || '').length > String(existing.value || '').length
          || (cDomain === 'quark.cn' && eDomain !== 'quark.cn');
        if (preferCurrent) {
          allCookies.set(key, {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate,
            storeId: c.storeId,
          });
        }
      }
    } catch (e) {
      log(`Cookie 查询失败: ${e.message}`);
    }
  }

  for (const store of stores) {
    const base = store.id ? { storeId: store.id } : {};
    await collect({ ...base, domain: 'quark.cn' });
    await collect({ ...base, url: QUARK_PAN_URL });
    await collect({ ...base, url: QUARK_DRIVE_URL });
  }

  return Object.fromEntries(allCookies.entries());
}

function buildCookieString(cookieMap) {
  const cookies = Object.values(cookieMap || {});
  cookies.sort((a, b) => {
    const ai = cookiePriority(a.name);
    const bi = cookiePriority(b.name);
    if (ai !== bi) return ai - bi;
    return String(a.name).localeCompare(String(b.name));
  });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function cookiePriority(name) {
  const order = ['__sdid', 'b-user-id', '_UP_A4A_11_', '_c_WBKFRo', '__pus', '__kp', '__kps', '__ktd', '__uid', 'xlly_s', '__puus', 'isg', 'tfstk', 'ctoken'];
  const idx = order.indexOf(name);
  if (idx >= 0) return idx;
  if (String(name).startsWith('_UP_')) return 100;
  return 200;
}

function categorizeCookies(cookieMap) {
  const values = Object.values(cookieMap || {});
  return {
    __puus: cookieMap.__puus || null,
    __pus: cookieMap.__pus || null,
    tfstk: cookieMap.tfstk || null,
    upCookies: values.filter(c => String(c.name).startsWith('_UP_')),
    httpOnlyCount: values.filter(c => c.httpOnly).length,
  };
}

function parseCookieNames(cookieString) {
  return String(cookieString || '')
    .split(';')
    .map(part => part.trim().split('=')[0])
    .filter(Boolean);
}

async function checkLoginViaAPI(cookieString) {
  if (!cookieString) return { loggedIn: false, nickname: '' };
  try {
    const resp = await fetch(`${QUARK_API}/account/info?pr=ucpro&fr=pc`, {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'Referer': 'https://pan.quark.cn/',
        'User-Agent': QUARK_UA,
        'Accept': 'application/json, text/plain, */*',
      },
    });
    if (!resp.ok) return { loggedIn: false, nickname: '' };
    const data = await resp.json();
    if (data.code === 0 && data.data) {
      return { loggedIn: true, nickname: data.data.nickname || data.data.account || '' };
    }
    return { loggedIn: false, nickname: '', code: data.code, message: data.message || data.msg || '' };
  } catch (e) {
    return { loggedIn: false, nickname: '', error: e.message };
  }
}

async function getAccounts() {
  const data = await chrome.storage.local.get(STORAGE_ACCOUNTS);
  return Array.isArray(data[STORAGE_ACCOUNTS]) ? data[STORAGE_ACCOUNTS] : [];
}

async function saveAccounts(accounts) {
  const legacy = accounts.map(account => ({
    account_name: account.account_name,
    quark_nickname: account.quark_nickname,
    puus: account.puus,
    has_puus: !!account.puus,
    has_tfstk: !!account.has_tfstk,
    cookie_count: account.cookie_count,
    captured_at: account.captured_at,
  }));
  await chrome.storage.local.set({
    [STORAGE_ACCOUNTS]: accounts,
    [STORAGE_LEGACY_ACCOUNTS]: legacy,
  });
}

function buildAccountEntry({ cookieMap, cookieString, nickname, storeId, existingName = '' }) {
  const categorized = categorizeCookies(cookieMap);
  const puus = cookieMap.__puus?.value || '';
  const cookieNames = parseCookieNames(cookieString);
  const capturedAt = new Date().toISOString();
  return {
    id: puus || `cookie-${Date.now()}`,
    account_name: existingName || nickname || `夸克账号_${capturedAt.slice(0, 10)}`,
    quark_nickname: nickname || '',
    cookie_string: cookieString,
    cookie_names: cookieNames,
    cookie_count: cookieNames.length,
    puus,
    has_puus: !!puus,
    has_tfstk: !!cookieMap.tfstk,
    _UP_count: categorized.upCookies.length,
    httpOnlyCount: categorized.httpOnlyCount,
    storeId,
    captured_at: capturedAt,
  };
}

async function handleCookieCapture(tabId, reason = 'manual') {
  let tab = null;
  if (tabId) {
    try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; }
  }
  if (tab && !tab.incognito) {
    return { ok: false, error: '扩展只在无痕模式抓取 Cookie，请在无痕夸克页面使用。' };
  }

  const storeId = await getCookieStoreIdForTab(tabId);
  const cookieMap = await getAllQuarkCookies(storeId);
  const cookieString = buildCookieString(cookieMap);
  const categorized = categorizeCookies(cookieMap);
  if (!cookieString || !categorized.__puus) {
    return { ok: false, error: '未抓到完整夸克 Cookie，请确认无痕窗口已登录夸克网盘。', cookie_count: Object.keys(cookieMap).length };
  }

  const login = await checkLoginViaAPI(cookieString);
  const accounts = await getAccounts();
  const existingIndex = categorized.__puus?.value
    ? accounts.findIndex(account => account.puus === categorized.__puus.value)
    : -1;
  const existingName = existingIndex >= 0 ? accounts[existingIndex].account_name : '';
  const entry = buildAccountEntry({
    cookieMap,
    cookieString,
    nickname: login.nickname,
    storeId,
    existingName,
  });

  if (existingIndex >= 0) accounts[existingIndex] = entry;
  else accounts.push(entry);
  await saveAccounts(accounts);

  const result = {
    account_name: entry.account_name,
    quark_nickname: entry.quark_nickname,
    cookie_count: entry.cookie_count,
    has_puus: entry.has_puus,
    has_puus_value: entry.puus ? `${entry.puus.slice(0, 20)}...` : '',
    has_tfstk: entry.has_tfstk,
    _UP_count: entry._UP_count,
    httpOnlyCount: entry.httpOnlyCount,
    cookie_string_length: entry.cookie_string.length,
    captured_at: entry.captured_at,
    reason,
  };

  await chrome.storage.local.set({
    [STORAGE_STATE]: 'done',
    [STORAGE_LAST_RESULT]: result,
    [STORAGE_LAST_COOKIE_DATA]: {
      full_string: entry.cookie_string,
      __puus: entry.puus,
      tfstk: cookieMap.tfstk?.value || '',
      _UP_names: entry.cookie_names.filter(name => name.startsWith('_UP_')),
      total_count: entry.cookie_count,
      string_length: entry.cookie_string.length,
    },
  });

  log(`Cookie 已刷新: ${entry.account_name} count=${entry.cookie_count} httpOnly=${entry.httpOnlyCount} reason=${reason}`);
  return { ok: true, account: publicAccount(entry), accounts: accounts.map(publicAccount), result };
}

function publicAccount(account) {
  return {
    id: account.id,
    account_name: account.account_name,
    quark_nickname: account.quark_nickname,
    cookie_count: account.cookie_count,
    has_puus: account.has_puus,
    has_tfstk: account.has_tfstk,
    _UP_count: account._UP_count,
    httpOnlyCount: account.httpOnlyCount,
    captured_at: account.captured_at,
  };
}

async function getEphemeralAccountFromTab(tabId) {
  if (!tabId) return null;
  const storeId = await getCookieStoreIdForTab(tabId);
  const cookieMap = await getAllQuarkCookies(storeId);
  const cookieString = buildCookieString(cookieMap);
  if (!cookieString || !cookieMap.__puus) return null;
  const login = await checkLoginViaAPI(cookieString);
  const entry = buildAccountEntry({
    cookieMap,
    cookieString,
    nickname: login.nickname || '当前浏览器账号',
    storeId,
    existingName: '当前浏览器账号（临时）',
  });
  entry.id = `ephemeral-${tabId}`;
  entry.ephemeral = true;
  return entry;
}

async function getBestAccount(accountId = '', tabId = 0, { allowEphemeral = false } = {}) {
  let accounts = await getAccounts();
  if (accountId) {
    const account = accounts.find(item => item.id === accountId);
    if (account) return account;
  }
  if (!accounts.length && allowEphemeral && tabId) {
    return await getEphemeralAccountFromTab(tabId);
  }
  return accounts.slice().sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))[0] || null;
}

function buildShareDetailUrl(pwdId, stoken) {
  const url = new URL(`${QUARK_API}/share/sharepage/detail`);
  url.searchParams.set('pr', 'ucpro');
  url.searchParams.set('fr', 'pc');
  url.searchParams.set('pwd_id', pwdId);
  url.searchParams.set('stoken', stoken);
  url.searchParams.set('pdir_fid', '0');
  url.searchParams.set('force', '0');
  url.searchParams.set('_page', '1');
  url.searchParams.set('_size', '200');
  url.searchParams.set('_sort', 'file_type:asc,updated_at:desc');
  return url.toString();
}

function extractLinkHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function collectUrlLikeValues(value, out = []) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) {
      try { out.push(new URL(text).toString()); } catch (e) {}
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectUrlLikeValues(item, out));
    return out;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(item => collectUrlLikeValues(item, out));
  return Array.from(new Set(out));
}

function isLikelyDownloadHost(host) {
  if (!host || !/\.drive\.quark\.cn$/i.test(host)) return false;
  if (/thumb/i.test(host)) return false;
  return /(^|\.)dl-/.test(host) || /(^|\.)c-[^.]+-u\.drive\.quark\.cn$/i.test(host);
}

function collectUrlLikeEntries(value) {
  const urls = collectUrlLikeValues(value);
  const entries = [];
  const seen = new Set();
  for (const url of urls) {
    const host = extractLinkHost(url);
    if (!host || seen.has(host) || !isLikelyDownloadHost(host)) continue;
    seen.add(host);
    entries.push({ host, urls: urls.filter(item => extractLinkHost(item) === host) });
  }
  return entries;
}

function mapDownloadEntry(item) {
  const rawUrls = collectUrlLikeValues(item);
  const downloadEntries = collectUrlLikeEntries(item);
  const urlsByHost = {};
  for (const entry of downloadEntries) urlsByHost[entry.host] = entry.urls;
  return {
    name: item.file_name || item.name || 'download.bin',
    size: item.size || 0,
    url: item.download_url,
    fid: item.fid,
    host: extractLinkHost(item.download_url),
    rawUrls,
    rawHosts: Array.from(new Set(rawUrls.map(extractLinkHost).filter(Boolean))),
    downloadHosts: downloadEntries.map(entry => entry.host),
    urlsByHost,
  };
}

async function quarkFetchJson(url, method, cookieString, body) {
  const resp = await fetch(url, {
    method,
    headers: {
      'Cookie': cookieString,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://pan.quark.cn/',
      'User-Agent': QUARK_UA,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 160)}`);
  if (!json) throw new Error(`夸克接口返回非 JSON: ${text.slice(0, 160)}`);
  return json;
}

async function fetchDirectLinks({ files, pwdId, stoken, isSharePage }, account) {
  const dataFiles = (files || []).filter(item => item && item.isFile !== false && item.fid);
  if (!dataFiles.length) throw new Error('未找到可下载文件，请先在页面选中文件。');

  let body;
  if (isSharePage) {
    if (!pwdId) throw new Error('未识别分享 ID，请确认当前是夸克分享页。');
    if (!stoken) throw new Error('未识别分享 stoken，请刷新页面后重试。');
    body = {
      fids: dataFiles.map(item => item.fid),
      fids_token: dataFiles.map(item => item.share_fid_token || ''),
      pwd_id: pwdId,
      stoken,
    };
  } else {
    body = { fids: dataFiles.map(item => item.fid) };
  }

  const json = await quarkFetchJson(`${QUARK_API}/file/download?entry=ft&fr=pc&pr=ucpro`, 'POST', account.cookie_string, body);
  if (json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error(`直链接口失败 code=${json.code} ${json.message || json.msg || ''}`);
  }
  return json.data.map(mapDownloadEntry).filter(item => item.url);
}

async function getRpcConfig() {
  const data = await chrome.storage.local.get([STORAGE_RPC_URL, STORAGE_RPC_SECRET]);
  return {
    rpcUrl: data[STORAGE_RPC_URL] || DEFAULT_RPC_URL,
    secret: data[STORAGE_RPC_SECRET] ?? DEFAULT_RPC_SECRET,
  };
}

function buildAria2Payload(method, params, secret) {
  return {
    jsonrpc: '2.0',
    id: `goodlink-${Date.now()}`,
    method,
    params: [secret ? `token:${secret}` : undefined, ...params].filter(item => item !== undefined),
  };
}

async function aria2Rpc(method, params, config) {
  const payload = buildAria2Payload(method, params, config.secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const resp = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, */*' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!resp.ok) throw new Error(`RPC HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 160)}`);
    if (json?.error) throw new Error(`RPC error code=${json.error.code} ${json.error.message || ''}`);
    return json || text;
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`RPC 请求超时 ${RPC_TIMEOUT_MS}ms，可能是 Motrix 未打开、RPC 端口填错，或本地防火墙拦截。`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function buildMotrixOptions(source, cookieString) {
  return {
    out: source.name || 'download.bin',
    dir: 'C:\\Users\\xiaozou\\Downloads',
    referer: 'https://pan.quark.cn/',
    'user-agent': MOTRIX_UA,
    header: [`Cookie: ${cookieString}`],
    // 当前成品版默认用 256 连接；后续多账号测试时每个账号仍独立控制连接数，避免单账号直接怼到 512/1280。
    split: 256,
    maxConnectionPerServer: 256,
    'max-connection-per-server': '256',
    'min-split-size': '1048576',
    'allow-overwrite': 'false',
    'auto-file-renaming': 'true',
  };
}

async function sendToMotrix({ source, accountId }, tabId) {
  if (!source?.url) throw new Error('没有可发送的直链，请先获取直链。');
  const account = await getBestAccount(accountId, tabId, { allowEphemeral: true });
  if (!account) throw new Error('没有可用 Cookie，请先刷新 Cookie。');
  const config = await getRpcConfig();
  await aria2Rpc('aria2.getVersion', [], config);
  const options = buildMotrixOptions(source, account.cookie_string);
  const result = await aria2Rpc('aria2.addUri', [[source.url], options], config);
  return { ok: true, gid: result?.result || '', options: { split: 256, maxConnectionPerServer: 256 } };
}

function explainRpcError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/timeout|超时|AbortError/i.test(message)) return 'Motrix RPC 连接超时：请确认 Motrix 未打开时先打开；已打开则检查 RPC 端口和本地防火墙。';
  if (/network|fetch|refused|ECONNREFUSED|Failed to fetch/i.test(message)) return '连接不上 Motrix：通常是 Motrix 未打开、RPC 未启用，或端口填错。';
  if (/token|secret|unauthorized|forbidden|401|403|code=1|Unauthorized/i.test(message)) return 'Motrix RPC 认证失败：请检查 Secret/密码是否和 Motrix 设置一致；没有密码就留空。';
  return `${message}。请检查 Motrix 是否已打开、RPC 端口是否正确、Secret 是否正确。`;
}

async function saveRpcConfig({ rpcUrl, secret }) {
  const nextUrl = String(rpcUrl || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
  const nextSecret = secret == null ? DEFAULT_RPC_SECRET : String(secret);
  await chrome.storage.local.set({ [STORAGE_RPC_URL]: nextUrl, [STORAGE_RPC_SECRET]: nextSecret });
  try {
    const version = await aria2Rpc('aria2.getVersion', [], { rpcUrl: nextUrl, secret: nextSecret });
    return { ok: true, version: version?.result?.version || 'unknown' };
  } catch (e) {
    return { ok: false, error: explainRpcError(e) };
  }
}

const refreshTimers = new Map();
function scheduleAutoCookieRefresh(storeId, reason = 'cookie-change') {
  if (!storeId) return;
  if (refreshTimers.has(storeId)) clearTimeout(refreshTimers.get(storeId));
  const timer = setTimeout(async () => {
    refreshTimers.delete(storeId);
    try {
      const stores = await chrome.cookies.getAllCookieStores();
      const store = stores.find(item => item.id === storeId);
      const tabIds = store?.tabIds || [];
      for (const tabId of tabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.incognito && /quark\.cn/i.test(tab.url || '')) {
            await handleCookieCapture(tabId, reason);
            return;
          }
        } catch (e) {}
      }
    } catch (e) {
      log(`自动刷新 Cookie 失败: ${e.message}`);
    }
  }, 1200);
  refreshTimers.set(storeId, timer);
}

chrome.cookies.onChanged.addListener(changeInfo => {
  if (!isQuarkCookie(changeInfo.cookie)) return;
  scheduleAutoCookieRefresh(changeInfo.cookie.storeId, `cookie-${changeInfo.cause || 'changed'}`);
});

async function startCapture() {
  await chrome.storage.local.set({ [STORAGE_STATE]: 'capturing', [STORAGE_LAST_RESULT]: null });
  const win = await chrome.windows.create({
    url: QUARK_PAN_URL,
    incognito: true,
    focused: true,
    type: 'normal',
    width: 980,
    height: 760,
  });
  await chrome.storage.local.set({ gl_incognito_window_id: win.id });
}

async function captureActiveOrStoredTab() {
  const data = await chrome.storage.local.get('gl_incognito_window_id');
  if (data.gl_incognito_window_id) {
    try {
      const tabs = await chrome.tabs.query({ windowId: data.gl_incognito_window_id });
      const tab = tabs.find(item => item.incognito && /quark\.cn/i.test(item.url || '')) || tabs[0];
      if (tab?.id) return handleCookieCapture(tab.id, 'popup-grab');
    } catch (e) {}
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return { ok: false, error: '找不到当前标签页。' };
  return handleCookieCapture(tab.id, 'popup-grab');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GL_QUARK_LOGIN_DETECTED':
        case 'GL_QUARK_REFRESH_COOKIES': {
          const tabId = sender.tab?.id || msg.tabId;
          const result = await handleCookieCapture(tabId, msg.type === 'GL_QUARK_LOGIN_DETECTED' ? 'login-detected' : 'manual-refresh');
          sendResponse(result);
          return;
        }
        case 'GL_QUARK_GET_ACCOUNTS': {
          const accounts = await getAccounts();
          const rpc = await getRpcConfig();
          sendResponse({ ok: true, accounts: accounts.map(publicAccount), rpcUrl: rpc.rpcUrl, rpcSecret: rpc.secret, hasSecret: !!rpc.secret });
          return;
        }
        case 'GL_QUARK_GET_DIRECT_LINKS': {
          const directPayload = msg.payload?.payload || msg.payload || {};
          const accountId = msg.payload?.accountId || msg.accountId || '';
          const account = await getBestAccount(accountId, sender.tab?.id, { allowEphemeral: true });
          if (!account) throw new Error('没有可用 Cookie，请先点击“刷新 Cookie”。');
          const links = await fetchDirectLinks(directPayload, account);
          sendResponse({ ok: true, links, account: publicAccount(account) });
          return;
        }
        case 'GL_QUARK_MOTRIX_SEND': {
          try {
            const result = await sendToMotrix(msg.payload || {}, sender.tab?.id);
            sendResponse(result);
          } catch (e) {
            sendResponse({ ok: false, error: explainRpcError(e) });
          }
          return;
        }
        case 'GL_QUARK_SAVE_RPC_CONFIG': {
          const result = await saveRpcConfig(msg.payload || {});
          sendResponse(result);
          return;
        }
        case 'GL_QUARK_START_CAPTURE': {
          await startCapture();
          sendResponse({ ok: true });
          return;
        }
        case 'GL_QUARK_GRAB_NOW': {
          const result = await captureActiveOrStoredTab();
          sendResponse(result);
          return;
        }
        case 'GL_QUARK_RESET': {
          await chrome.storage.local.set({ [STORAGE_STATE]: 'idle', [STORAGE_LAST_RESULT]: null });
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `未知消息: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

chrome.webNavigation.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId).then(async tab => {
    if (tab?.incognito && /quark\.cn/i.test(tab.url || '')) {
      const storeId = await getCookieStoreIdForTab(details.tabId);
      scheduleAutoCookieRefresh(storeId, 'navigation-completed');
    }
  }).catch(() => {});
}, {
  url: [
    { hostContains: 'pan.quark.cn' },
    { hostContains: 'drive-pc.quark.cn' },
    { hostContains: 'drive.quark.cn' },
  ],
});

const RULE_ID_DIRECT_DOWNLOAD_UA = 1;

async function ensureQuarkDownloadUARule() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const exists = rules.some(rule => rule.id === RULE_ID_DIRECT_DOWNLOAD_UA);
    if (exists) return;
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: RULE_ID_DIRECT_DOWNLOAD_UA,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'User-Agent',
            operation: 'set',
            value: QUARK_UA,
          }],
        },
        condition: {
          urlFilter: '||drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro',
          resourceTypes: ['xmlhttprequest'],
        },
      }],
      removeRuleIds: [],
    });
    log('已安装 Quark 下载 UA 规则，确保页面世界直链请求使用桌面客户端 UA');
  } catch (e) {
    log(`安装 Quark 下载 UA 规则失败: ${e.message}`);
  }
}

ensureQuarkDownloadUARule();

log('已启动');
