/**
 * GoodLink 夸克网盘 Cookie 抓取器 — Background Service Worker
 *
 * 流程：打开 pan.quark.cn → 用户登录 → 抓取全部 Cookie → 导出 → 关窗口
 *
 * 夸克 API 需要完整 Cookie 字串，不是单独的某个字段。
 * 关键 Cookie：__puus、__pus、_UP_*、tfstk、以及登录会话 Cookie。
 * 单独传 __puus 会被拒绝，必须传完整 document.cookie。
 */

const QUARK_PAN_URL = 'https://pan.quark.cn/';
const QUARK_DRIVE_URL = 'https://drive-pc.quark.cn/';

function log(msg) { console.log(`[GoodLink Quark] ${msg}`); }

// ==================== 从 chrome.cookies API 抓取所有 quark.cn Cookie ====================
async function getAllQuarkCookies() {
  const allCookies = {};

  // 遍历所有 cookie store（无痕窗口有独立 store）
  const stores = await chrome.cookies.getAllCookieStores();

  for (const store of stores) {
    // quark.cn 域名下的全部 Cookie
    const cookies = await chrome.cookies.getAll({
      domain: 'quark.cn',
      storeId: store.id
    });

    // pan.quark.cn 域名下的（有些 Cookie 可能限定子域名）
    const panCookies = await chrome.cookies.getAll({
      url: QUARK_PAN_URL,
      storeId: store.id
    });

    // drive-pc.quark.cn 域名下的
    const driveCookies = await chrome.cookies.getAll({
      url: QUARK_DRIVE_URL,
      storeId: store.id
    });

    // 合并去重（以 name 为 key，保留最完整的）
    for (const c of [...cookies, ...panCookies, ...driveCookies]) {
      const existing = allCookies[c.name];
      // 优先保留 value 更长的（更完整）
      if (!existing || c.value.length > existing.value.length) {
        allCookies[c.name] = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate
        };
      }
    }
  }

  return allCookies;
}

// ==================== 从 content script 获取 document.cookie ====================
async function getDocumentCookie(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.cookie
    });
    return result?.result || '';
  } catch (e) {
    log(`获取 document.cookie 失败: ${e.message}`);
    return '';
  }
}

// ==================== 从 content script 获取页面登录状态和用户信息 ====================
async function getPageInfo(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        // 尝试用 API 检测登录状态
        try {
          const resp = await fetch('https://drive-pc.quark.cn/1/clouddrive/account/info?pr=ucpro&fr=pc', {
            credentials: 'include',
            cache: 'no-store'
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.code === 0 && data.data) {
              return {
                loggedIn: true,
                nickname: data.data.nickname || data.data.account || '',
                avatar: data.data.avatar || ''
              };
            }
          }
        } catch (e) {}

        // 降级：检查页面元素
        try {
          // 夸克网盘登录后，页面上会有用户头像或昵称
          const nickEl = document.querySelector('[class*="nick"], [class*="user-name"], [class*="username"]');
          if (nickEl && nickEl.textContent.trim()) {
            return { loggedIn: true, nickname: nickEl.textContent.trim(), avatar: '' };
          }
        } catch (e) {}

        return { loggedIn: false, nickname: '', avatar: '' };
      }
    });
    return result?.result || { loggedIn: false, nickname: '', avatar: '' };
  } catch (e) {
    log(`获取页面信息失败: ${e.message}`);
    return { loggedIn: false, nickname: '', avatar: '' };
  }
}

// ==================== 检测登录状态（从 background 发请求） ====================
async function checkLoginViaAPI(cookieString) {
  try {
    const resp = await fetch(
      `${QUARK_DRIVE_URL}1/clouddrive/account/info?pr=ucpro&fr=pc`,
      {
        headers: {
          'Cookie': cookieString,
          'Referer': 'https://pan.quark.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch'
        }
      }
    );
    if (!resp.ok) return { loggedIn: false, nickname: '' };
    const data = await resp.json();
    if (data.code === 0 && data.data) {
      return { loggedIn: true, nickname: data.data.nickname || data.data.account || '' };
    }
    return { loggedIn: false, nickname: '' };
  } catch (e) {
    return { loggedIn: false, nickname: '' };
  }
}

// ==================== 拼接完整 Cookie 字符串 ====================
function buildCookieString(cookieMap) {
  // chrome.cookies 获取的所有 Cookie 拼成一行
  // 排除 httpOnly=false 且 secure 的优先
  const cookies = Object.values(cookieMap);
  // 按 domain 和 name 排序，保持稳定输出
  cookies.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ==================== 标记重要 Cookie ====================
function categorizeCookies(cookieMap) {
  const important = {
    __puus: cookieMap['__puus'] || null,
    __pus: cookieMap['__pus'] || null,
    tfstk: cookieMap['tfstk'] || null,
    _UP_cookies: [],
    others: []
  };

  for (const c of Object.values(cookieMap)) {
    if (c.name.startsWith('_UP_')) {
      important._UP_cookies.push(c);
    } else if (c.name !== '__puus' && c.name !== '__pus' && c.name !== 'tfstk') {
      important.others.push(c);
    }
  }

  return important;
}

// ==================== 导出文件 ====================
async function exportToFile(data) {
  const { gl_export_path = '' } = await chrome.storage.local.get('gl_export_path');
  const dir = gl_export_path || 'GoodLink_quark_cookies';
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
  try {
    await chrome.downloads.download({
      url,
      filename: `${dir}/${data.account_name}.json`,
      saveAs: false
    });
    return true;
  } catch (e) {
    log(`导出失败: ${e.message}`);
    return false;
  }
}

// ==================== 核心：抓取并处理 ====================
async function handleCookieCapture(tabId) {
  log('=== 开始抓取 Cookie ===');

  // 1. 获取 chrome.cookies API 的所有 Cookie
  const cookieMap = await getAllQuarkCookies();
  const cookieCount = Object.keys(cookieMap).length;
  log(`chrome.cookies 获取到 ${cookieCount} 个 Cookie`);

  if (cookieCount === 0) {
    log('警告：未获取到任何 Cookie，用户可能未登录');
  }

  // 2. 获取 content script 注入的 document.cookie（作为补充）
  const documentCookie = await getDocumentCookie(tabId);
  log(`document.cookie 长度: ${documentCookie.length}`);

  // 3. 拼接完整 Cookie 字符串
  const fullCookieString = buildCookieString(cookieMap);

  // 4. 分类重要 Cookie
  const categorized = categorizeCookies(cookieMap);

  // 5. 尝试获取用户信息（先用 content script，失败则用 background fetch）
  let pageInfo = await getPageInfo(tabId);
  if (!pageInfo.loggedIn && fullCookieString) {
    pageInfo = await checkLoginViaAPI(fullCookieString);
  }

  const nickname = pageInfo.nickname || 'unknown';
  const count = (await chrome.storage.local.get('gl_accounts')).gl_accounts?.length || 0;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const accountName = `夸克账号${count + 1}_${date}`;

  // 6. 构建导出数据
  const exportData = {
    account_name: accountName,
    quark_nickname: nickname,
    // 完整 Cookie 字符串（直接可用于 API 调用）
    cookie_string: fullCookieString,
    // content script 的 document.cookie（httpOnly Cookie 不在这里）
    document_cookie: documentCookie,
    // 逐个 Cookie 详情
    cookies: {
      // 核心认证
      __puus: cookieMap['__puus']?.value || '',
      __pus: cookieMap['__pus']?.value || '',
      // 会话标识
      _UP_all: categorized._UP_cookies.map(c => ({ name: c.name, value: c.value })),
      tfstk: cookieMap['tfstk']?.value || '',
      // 全部列表
      total_count: cookieCount,
      all_names: Object.keys(cookieMap).sort()
    },
    // 便捷字段：直接复制到 GoodLink 使用
    for_goodlink: {
      drive_type: 'quark',
      cookie: fullCookieString,
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch',
      referer: 'https://pan.quark.cn/'
    },
    captured_at: new Date().toISOString(),
    source: 'GoodLink Quark Cookie Grabber'
  };

  // 7. 导出文件
  const exported = await exportToFile(exportData);

  // 8. 存储到 chrome.storage（popup 用 + cookie 复制用）
  const { gl_accounts = [] } = await chrome.storage.local.get('gl_accounts');

  // 去重：同一 __puus 只保留最新
  const puus = cookieMap['__puus']?.value || '';
  const existingIdx = puus ? gl_accounts.findIndex(a => a.has_puus && a.puus === puus) : -1;
  const accountEntry = {
    account_name: existingIdx >= 0 ? gl_accounts[existingIdx].account_name : accountName,
    quark_nickname: nickname,
    puus,
    has_puus: !!cookieMap['__puus'],
    has_tfstk: !!cookieMap['tfstk'],
    cookie_count: cookieCount,
    captured_at: exportData.captured_at
  };
  if (existingIdx >= 0) {
    gl_accounts[existingIdx] = accountEntry;
    log(`去重：已更新已有账号 ${accountEntry.account_name}`);
  } else {
    gl_accounts.push(accountEntry);
  }

  await chrome.storage.local.set({
    gl_accounts,
    gl_state: 'done',
    gl_last_result: {
      account_name: accountName,
      quark_nickname: nickname,
      cookie_count: cookieCount,
      has_puus: !!cookieMap['__puus'],
      has_puus_value: cookieMap['__puus'] ? cookieMap['__puus'].value.slice(0, 20) + '...' : '',
      has_tfstk: !!cookieMap['tfstk'],
      _UP_count: categorized._UP_cookies.length,
      cookie_string_length: fullCookieString.length,
      exported,
      captured_at: exportData.captured_at
    },
    // 存储完整 cookie 数据供 popup 复制
    gl_last_cookie_data: {
      full_string: fullCookieString,
      __puus: cookieMap['__puus']?.value || '',
      tfstk: cookieMap['tfstk']?.value || '',
      _UP_names: categorized._UP_cookies.map(c => c.name),
      total_count: cookieCount,
      string_length: fullCookieString.length
    }
  });

  // 9. 关闭无痕窗口
  const { gl_incognito_window_id } = await chrome.storage.local.get('gl_incognito_window_id');
  if (gl_incognito_window_id) {
    try { await chrome.windows.remove(gl_incognito_window_id); } catch (e) {}
  }

  log(`=== 完成 === ${accountName} (${cookieCount} cookies, __puus: ${!!cookieMap['__puus']})`);
}

// ==================== 启动：打开 pan.quark.cn ====================
async function startCapture() {
  await chrome.storage.local.set({ gl_state: 'capturing', gl_last_result: null });
  try {
    const win = await chrome.windows.create({
      url: QUARK_PAN_URL,
      incognito: true,
      focused: true,
      type: 'normal',
      width: 900,
      height: 700
    });
    await chrome.storage.local.set({ gl_incognito_window_id: win.id });
    log(`无痕窗口已打开 (id: ${win.id})`);
  } catch (e) {
    log(`打开窗口失败: ${e.message}`);
    await chrome.storage.local.set({ gl_state: 'error' });
  }
}

// ==================== webNavigation：检测登录成功 ====================
// 记录哪些 tab 访问过登录页
const loginPageVisited = new Set();

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { gl_state } = await chrome.storage.local.get('gl_state');
  if (gl_state !== 'capturing') return;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (!tab || !tab.incognito) return;
    const url = details.url;

    // 夸克登录页
    if (url.includes('passport.quark.cn') || url.includes('i.quark.cn') || url.includes('login')) {
      loginPageVisited.add(details.tabId);
      log(`tab ${details.tabId} → 登录页: ${url.slice(0, 60)}`);
      return;
    }

    // 回到 pan.quark.cn = 可能登录成功
    if (url.includes('pan.quark.cn') && loginPageVisited.has(details.tabId)) {
      loginPageVisited.delete(details.tabId);
      log(`tab ${details.tabId} 回到 pan.quark.cn，检测登录状态...`);

      // 等待页面加载完毕后抓取
      setTimeout(async () => {
        // 通过 content script 检测登录
        const pageInfo = await getPageInfo(details.tabId);
        if (pageInfo.loggedIn) {
          log('登录成功，开始抓取 Cookie');
          await handleCookieCapture(details.tabId);
        } else {
          // 再等几秒，页面可能还没加载完
          setTimeout(async () => {
            const retryInfo = await getPageInfo(details.tabId);
            if (retryInfo.loggedIn) {
              log('登录成功（重试），开始抓取 Cookie');
              await handleCookieCapture(details.tabId);
            } else {
              log('登录检测：未确认登录，请手动点击「确认登录并抓取」');
            }
          }, 3000);
        }
      }, 2000);
    }
  } catch (e) {
    log(`导航检测异常: ${e.message}`);
  }
}, {
  url: [
    { hostContains: 'pan.quark.cn' },
    { hostContains: 'passport.quark.cn' },
    { hostContains: 'i.quark.cn' }
  ]
});

// ==================== content script 消息 ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GL_QUARK_LOGIN_DETECTED':
      // content script 检测到登录成功
      log('content script 报告登录成功');
      if (sender.tab) {
        handleCookieCapture(sender.tab.id);
      }
      break;

    case 'GL_QUARK_START_CAPTURE':
      startCapture();
      break;

    case 'GL_QUARK_MANUAL_CAPTURE':
      // 用户手动触发抓取（在当前 tab）
      if (sender.tab) {
        handleCookieCapture(sender.tab.id);
      }
      break;

    case 'GL_QUARK_GRAB_NOW':
      // popup 按钮：立即抓取当前无痕 tab
      (async () => {
        const { gl_incognito_window_id } = await chrome.storage.local.get('gl_incognito_window_id');
        let tabId = null;
        if (gl_incognito_window_id) {
          try {
            const tabs = await chrome.tabs.query({ windowId: gl_incognito_window_id });
            if (tabs.length > 0) tabId = tabs[0].id;
          } catch (e) {}
        }
        if (!tabId) {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tabs.length > 0) tabId = tabs[0].id;
        }
        if (tabId) {
          await handleCookieCapture(tabId);
        } else {
          log('找不到可抓取的 tab');
        }
      })();
      break;

    case 'GL_QUARK_RESET':
      chrome.storage.local.set({ gl_state: 'idle', gl_last_result: null });
      break;
  }
  sendResponse({ ok: true });
  return true;
});

// 窗口关闭 → 重置
chrome.windows.onRemoved.addListener(async (winId) => {
  const s = await chrome.storage.local.get(['gl_incognito_window_id', 'gl_state']);
  if (winId === s.gl_incognito_window_id && s.gl_state === 'capturing') {
    await chrome.storage.local.set({ gl_state: 'idle' });
    loginPageVisited.clear();
  }
});

log('已启动');
