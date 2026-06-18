// ==UserScript==
// @name         GoodLink 百度直链助手
// @namespace    goodlink
// @version      1.0.0
// @description  百度网盘多账号 OAuth 直链获取 — 支持多 token 轮询、导出导入、自动授权
// @author       GoodLink
// @match        *://pan.baidu.com/*
// @match        *://yun.baidu.com/*
// @match        *://openapi.baidu.com/*
// @connect      baidu.com
// @connect      baidupcs.com
// @connect      d.pcs.baidu.com
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
'use strict';
if (typeof unsafeWindow === 'undefined') window.unsafeWindow = window;

// ==================== 配置 ====================
const BAIDU_CLIENT_ID = 'IlLqBbU3GjQ0t46TRwFateTprHWl39zF';
const BAIDU_OAUTH_URL = `https://openapi.baidu.com/oauth/2.0/authorize?client_id=${BAIDU_CLIENT_ID}&response_type=token&redirect_uri=oob&confirm_login=0&scope=basic,netdisk`;

// ==================== 日志系统 ====================
const LOGS = GM_getValue('gl_logs', []);
function glLog(msg, level = 'info') {
  const entry = { time: new Date().toLocaleTimeString(), level, msg };
  LOGS.push(entry);
  if (LOGS.length > 500) LOGS.splice(0, LOGS.length - 500);
  GM_setValue('gl_logs', LOGS);
  console[level === 'err' ? 'error' : 'log'](`[GoodLink] ${msg}`);
  // 如果面板打开了，更新日志显示
  const logEl = document.getElementById('gl-log-content');
  if (logEl) logEl.textContent = LOGS.map(l => `[${l.time}] ${l.level === 'err' ? '❌' : 'ℹ️'} ${l.msg}`).join('\n');
}

// ==================== 工具函数 ====================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function encodeBase(str) {
  try { str = encodeURIComponent(str) } catch {}
  try { str = unescape(str) } catch {}
  try { str = btoa(str) } catch {}
  return str;
}

function gmFetch(url, method, headers, body, anonymous) {
  return new Promise((resolve, reject) => {
    const opts = {
      url, method,
      headers: { ...headers },
      responseType: 'text',
      onload: res => {
        let text = res.responseText;
        try { resolve(JSON.parse(text)); return; } catch {}
        try { text = decodeURIComponent(unescape(atob(text))); resolve(JSON.parse(text)); return; } catch {}
        resolve(text);
      },
      onerror: err => reject(new Error(`网络请求失败: ${url.split('?')[0]} — ${err.statusText || '未知错误'}`)),
      ontimeout: () => reject(new Error(`请求超时: ${url.split('?')[0]}`)),
    };
    if (anonymous) { opts.anonymous = true; } else { opts.withCredentials = true; }
    if (body !== undefined) {
      if (body instanceof URLSearchParams) opts.data = body.toString();
      else if (typeof body === 'object') { opts.data = JSON.stringify(body); if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json'; }
      else opts.data = body;
    }
    GM_xmlhttpRequest(opts);
  });
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// ==================== 百度客户端协议签名 ====================
// 从 BaiduPCS-Go 移植 (baidupcs/netdisksign/)

// RC4 加密 (sign2.js)
function rc4Encrypt(key, data) {
  const a = [], p = [];
  const v = key.length;
  for (let q = 0; q < 256; q++) {
    a[q] = key.charCodeAt(q % v);
    p[q] = q;
  }
  for (let u = 0, q = 0; q < 256; q++) {
    u = (u + p[q] + a[q]) % 256;
    [p[q], p[u]] = [p[u], p[q]];
  }
  const result = new Uint8Array(data.length);
  for (let i = 0, u = 0, q = 0; q < data.length; q++) {
    i = (i + 1) % 256;
    u = (u + p[i]) % 256;
    [p[i], p[u]] = [p[u], p[i]];
    result[q] = data.charCodeAt(q) ^ p[(p[i] + p[u]) % 256];
  }
  return result;
}

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// SHA1 实现（Web Crypto 不支持 HMAC-SHA1 的同步方式，这里用纯 JS）
function sha1Hex(str) {
  // 简单 SHA1 — 输入 UTF-8 字符串，输出 hex
  const msg = new TextEncoder().encode(str);
  return sha1BytesHex(msg);
}

function sha1BytesHex(bytes) {
  // 基于 RFC 3174 的 SHA1 实现
  function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
  function toHex(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  const l = bytes.length;
  const bl = l * 8;
  // 添加填充
  const words = [];
  for (let i = 0; i < l; i += 4) {
    words.push((bytes[i] << 24) | ((bytes[i+1] || 0) << 16) | ((bytes[i+2] || 0) << 8) | (bytes[i+3] || 0));
  }
  // 填充
  const bitLen = l;
  words.push(0x80 << 24);
              // BDUSS 异常时覆盖健康状态显示
  while (words.length % 16 !== 14) words.push(0);
  words.push(Math.floor(bitLen * 8 / 0x100000000));
  words.push((bitLen * 8) >>> 0);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;

  for (let i = 0; i < words.length; i += 16) {
    const w = new Array(80);
    for (let t = 0; t < 16; t++) w[t] = words[i + t];
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t-3] ^ w[t-8] ^ w[t-14] ^ w[t-16], 1);

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20)      { f = (b & c) | (~b & d);          k = 0x5A827999; }
      else if (t < 40) { f = b ^ c ^ d;                    k = 0x6ED9EBA1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else              { f = b ^ c ^ d;                    k = 0xCA62C1D6; }
      const temp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

function md5Hex(str) {
  // 简易 MD5 — 输入字符串，输出 hex
  return md5BytesHex(new TextEncoder().encode(str));
}

function md5BytesHex(bytes) {
  function cmn(q,a,b,x,s,t) { a = (((a+q)>>>0)+((x+t)>>>0))>>>0; return ((a<<s)|(a>>>(32-s)))+b>>>0; }
  function ff(a,b,c,d,x,s,t) { return cmn((b&c)|((~b)&d),a,b,x,s,t); }
  function gg(a,b,c,d,x,s,t) { return cmn((b&d)|(c&(~d)),a,b,x,s,t); }
  function hh(a,b,c,d,x,s,t) { return cmn(b^c^d,a,b,x,s,t); }
  function ii(a,b,c,d,x,s,t) { return cmn(c^(b|(~d)),a,b,x,s,t); }

  const l = bytes.length;
  const words = [];
  for (let i = 0; i < l; i += 4) {
    words.push(bytes[i] | ((bytes[i+1]||0)<<8) | ((bytes[i+2]||0)<<16) | ((bytes[i+3]||0)<<24));
  }
  const bitLen = l;
  words.push(0x00000080);
  while (words.length % 16 !== 14) words.push(0);
  words.push((bitLen * 8) >>> 0);
  words.push(Math.floor(bitLen * 8 / 0x100000000));

  let a=0x67452301, b=0xEFCDAB89, c=0x98BADCFE, d=0x10325476;

  const S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;

  for (let i = 0; i < words.length; i += 16) {
    const x = words.slice(i, i+16);
    let oa=a,ob=b,oc=c,od=d;
    a=ff(a,b,c,d,x[0],S11,0xD76AA478);d=ff(d,a,b,c,x[1],S12,0xE8C7B756);c=ff(c,d,a,b,x[2],S13,0x242070DB);b=ff(b,c,d,a,x[3],S14,0xC1BDCEEE);
    a=ff(a,b,c,d,x[4],S11,0xF57C0FAF);d=ff(d,a,b,c,x[5],S12,0x4787C62A);c=ff(c,d,a,b,x[6],S13,0xA8304613);b=ff(b,c,d,a,x[7],S14,0xFD469501);
    a=ff(a,b,c,d,x[8],S11,0x698098D8);d=ff(d,a,b,c,x[9],S12,0x8B44F7AF);c=ff(c,d,a,b,x[10],S13,0xFFFF5BB1);b=ff(b,c,d,a,x[11],S14,0x895CD7BE);
    a=ff(a,b,c,d,x[12],S11,0x6B901122);d=ff(d,a,b,c,x[13],S12,0xFD987193);c=ff(c,d,a,b,x[14],S13,0xA679438E);b=ff(b,c,d,a,x[15],S14,0x49B40821);
    a=gg(a,b,c,d,x[1],S21,0xF61E2562);d=gg(d,a,b,c,x[6],S22,0xC040B340);c=gg(c,d,a,b,x[11],S23,0x265E5A51);b=gg(b,c,d,a,x[0],S24,0xE9B6C7AA);
    a=gg(a,b,c,d,x[5],S21,0xD62F105D);d=gg(d,a,b,c,x[10],S22,0x02441453);c=gg(c,d,a,b,x[15],S23,0xD8A1E681);b=gg(b,c,d,a,x[4],S24,0xE7D3FBC8);
    a=gg(a,b,c,d,x[9],S21,0x21E1CDE6);d=gg(d,a,b,c,x[14],S22,0xC33707D6);c=gg(c,d,a,b,x[3],S23,0xF4D50D87);b=gg(b,c,d,a,x[8],S24,0x455A14ED);
    a=gg(a,b,c,d,x[13],S21,0xA9E3E905);d=gg(d,a,b,c,x[2],S22,0xFCEFA3F8);c=gg(c,d,a,b,x[7],S23,0x676F02D9);b=gg(b,c,d,a,x[12],S24,0x8D2A4C8A);
    a=hh(a,b,c,d,x[5],S31,0xFFFA3942);d=hh(d,a,b,c,x[8],S32,0x8771F681);c=hh(c,d,a,b,x[11],S33,0x6D9D6122);b=hh(b,c,d,a,x[14],S34,0xFDE5380C);
    a=hh(a,b,c,d,x[1],S31,0xA4BEEA44);d=hh(d,a,b,c,x[4],S32,0x4BDECFA9);c=hh(c,d,a,b,x[7],S33,0xF6BB4B60);b=hh(b,c,d,a,x[10],S34,0xBEBFBC70);
    a=hh(a,b,c,d,x[13],S31,0x289B7EC6);d=hh(d,a,b,c,x[0],S32,0xEAA127FA);c=hh(c,d,a,b,x[3],S33,0xD4EF3085);b=hh(b,c,d,a,x[6],S34,0x04881D05);
    a=hh(a,b,c,d,x[9],S31,0xD9D4D039);d=hh(d,a,b,c,x[12],S32,0xE6DB99E5);c=hh(c,d,a,b,x[15],S33,0x1FA27CF8);b=hh(b,c,d,a,x[2],S34,0xC4AC5665);
    a=ii(a,b,c,d,x[0],S41,0xF4292244);d=ii(d,a,b,c,x[7],S42,0x432AFF97);c=ii(c,d,a,b,x[14],S43,0xAB9423A7);b=ii(b,c,d,a,x[5],S44,0xFC93A039);
    a=ii(a,b,c,d,x[12],S41,0x655B59C3);d=ii(d,a,b,c,x[3],S42,0x8F0CCC92);c=ii(c,d,a,b,x[10],S43,0xFFEFF47D);b=ii(b,c,d,a,x[1],S44,0x85845DD1);
    a=ii(a,b,c,d,x[8],S41,0x6FA87E4F);d=ii(d,a,b,c,x[15],S42,0xFE2CE6E0);c=ii(c,d,a,b,x[6],S43,0xA3014314);b=ii(b,c,d,a,x[13],S44,0x4E0811A1);
    a=ii(a,b,c,d,x[4],S41,0xF7537E82);d=ii(d,a,b,c,x[11],S42,0xBD3AF235);c=ii(c,d,a,b,x[2],S43,0x2AD7D2BB);b=ii(b,c,d,a,x[9],S44,0xEB86D391);
    a=(a+oa)>>>0;b=(b+ob)>>>0;c=(c+oc)>>>0;d=(d+od)>>>0;
  }
  function toHex(n){return ('00000000'+((n>>>0).toString(16))).match(/../g).reverse().join('');}
  return toHex(a)+toHex(b)+toHex(c)+toHex(d);
}

// DevUID: MD5(BDUSS) 大写 + "|0"
function makeDevUID(bduss) {
  return md5Hex(bduss).toUpperCase() + '|0';
}

// LocateDownloadSign: SHA1(SHA1(BDUSS_hex) + uid + secret + timestamp + devuid)
const LOCATE_DOWNLOAD_SECRET = 'ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF';

function makeLocateDownloadSign(bduss, uid) {
  const time = Math.floor(Date.now() / 1000);
  const devuid = makeDevUID(bduss);
  const bdussSha1Hex = sha1Hex(bduss);
  const rand = sha1Hex(bdussSha1Hex + uid + LOCATE_DOWNLOAD_SECRET + time + devuid);
  return { time, rand, devuid };
}

// 获取百度首页 sign1/sign3/timestamp（用于 Pan API 下载和 share/transfer）
let cachedHomeSign = null;
let homeSignExpiry = 0;

async function getHomeSign() {
  if (cachedHomeSign && Date.now() < homeSignExpiry) return cachedHomeSign;

  // 方案1: 尝试从当前页面的 unsafeWindow 获取 sign 数据
  try {
    const locals = unsafeWindow?.locals;
    if (locals && typeof locals === 'object') {
      const sign1 = locals?.sign1?.value || locals?.sign1;
      const sign3 = locals?.sign3?.value || locals?.sign3;
      const ts = locals?.timestamp?.value || locals?.timestamp;
      if (sign1 && sign3 && ts) {
        cachedHomeSign = { sign1, sign3, timestamp: String(ts) };
        homeSignExpiry = Date.now() + 3600 * 1000;
        glLog(`getHomeSign 从 unsafeWindow.locals 获取成功`);
        return cachedHomeSign;
      }
    }
  } catch (e) {
    glLog(`getHomeSign unsafeWindow 方式失败: ${e.message}`);
  }

  // 方案2: 用 gettemplatevariable API 尝试获取
  try {
    const tplRes = await gmFetch(
      'https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&fields=%5B%22sign1%22%2C%22sign3%22%2C%22timestamp%22%5D',
      'GET',
      { 'Referer': 'https://pan.baidu.com/disk/main' }
    );
    if (tplRes?.result?.sign1 && tplRes?.result?.sign3) {
      cachedHomeSign = {
        sign1: tplRes.result.sign1,
        sign3: tplRes.result.sign3,
        timestamp: tplRes.result.timestamp || String(Math.floor(Date.now() / 1000)),
      };
      homeSignExpiry = Date.now() + 3600 * 1000;
      glLog(`getHomeSign 从 gettemplatevariable API 获取成功`);
      return cachedHomeSign;
    }
  } catch (e) {
    glLog(`getHomeSign gettemplatevariable 方式失败: ${e.message}`);
  }

  // 方案3: 用桌面 UA 请求 /disk/home（可能返回非 SPA 页面）
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const urls = ['https://pan.baidu.com/disk/home', 'https://pan.baidu.com/disk/main'];

  for (const url of urls) {
    try {
      const res = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url,
          method: 'GET',
          headers: { 'User-Agent': desktopUA },
          responseType: 'text',
          withCredentials: true,
          onload: r => resolve(r),
          onerror: e => reject(e),
        });
      });

      const html = res.responseText || '';
      const sign1Match = html.match(/"sign1"\s*:\s*"([a-f0-9]{64,})"/);
      const sign3Match = html.match(/"sign3"\s*:\s*"([a-f0-9]{32,})"/);
      const tsMatch = html.match(/"timestamp"\s*:\s*(\d{10})/);

      if (sign1Match && sign3Match && tsMatch) {
        cachedHomeSign = { sign1: sign1Match[1], sign3: sign3Match[1], timestamp: tsMatch[1] };
        homeSignExpiry = Date.now() + 3600 * 1000;
        glLog(`getHomeSign 从 ${url.split('/').pop()} HTML 获取成功`);
        return cachedHomeSign;
      }
      glLog(`getHomeSign[${url.split('/').pop()}]: status=${res.status} htmlLen=${html.length} hasSign1=${html.includes('sign1')} hasSign3=${html.includes('sign3')}`);
    } catch (e) {
      glLog(`getHomeSign[${url.split('/').pop()}] 失败: ${e.message}`);
    }
  }

  throw new Error('首页签名获取失败 — 所有方案均不可用');
}

// 签名: RC4(sign3, sign1) → base64
function computeHomeSign(homeSign) {
  const encrypted = rc4Encrypt(homeSign.sign3, homeSign.sign1);
  return uint8ToBase64(encrypted);
}

// ==================== 客户端协议下载 API ====================

// PCS Locatedownload API — 按文件路径获取下载链接，无大小限制
async function clientLocateDownload(filePath, bduss, uid) {
  if (!uid && bduss) {
    uid = await getUidFromBduss(bduss);
    glLog(`locatedownload: 从 BDUSS 获取 UID=${uid}`);
  }
  if (!uid) throw new Error('locatedownload: 无法获取 UID，请检查 BDUSS');
  const sign = makeLocateDownloadSign(bduss, uid);
  const params = new URLSearchParams({
    ant: '1', check_blue: '1', es: '1', esl: '1',
    app_id: '250528', method: 'locatedownload',
    path: filePath, ver: '4.0', clienttype: '17',
    channel: '0', apn_id: '1_0', freeisp: '0', queryfree: '0', use: '0',
  });
  const url = `https://d.pcs.baidu.com/rest/2.0/pcs/file?${params.toString()}&time=${sign.time}&rand=${sign.rand}&devuid=${sign.devuid}&cuid=${sign.devuid}`;

  const headers = {
    'User-Agent': 'netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;',
  };
  if (bduss) headers['Cookie'] = `BDUSS=${bduss}`;
  const res = await gmFetch(url, 'POST', headers, undefined, true);
  if (res?.urls?.length) {
    return res.urls.filter(u => u.encrypt === 0).map(u => u.url);
  }
  throw new Error(`locatedownload 失败: ${JSON.stringify(res).slice(0, 200)}`);
}

// Pan API Download — 用首页签名获取下载链接
async function clientPanDownload(fsIds) {
  const homeSign = await getHomeSign();
  const sign = computeHomeSign(homeSign);

  const body = new URLSearchParams({
    sign: sign,
    timestamp: homeSign.timestamp,
    fidlist: JSON.stringify(fsIds),
  });

  const res = await gmFetch('https://pan.baidu.com/api/download', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://pan.baidu.com/disk/home',
  }, body);

  if (res?.dlink?.length) {
    return res.dlink.map(d => ({ fs_id: d.fs_id, dlink: d.dlink }));
  }
  throw new Error(`pan/api/download 失败: errno=${res?.errno} errmsg=${res?.errmsg || res?.show_msg || '-'}`);
}

// ==================== BDUSS 检测 ====================

let baiduUid = null; // 缓存百度 UID（用于 locatedownload 签名）

// 用 BDUSS 获取对应账号的 UID（用于 locatedownload 签名）
async function getUidFromBduss(bduss) {
  try {
    const res = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo', 'GET', {
      'Cookie': `BDUSS=${bduss}`,
    }, undefined, true);
    return res?.uk || res?.uid || 0;
  } catch { return 0; }
}



// ==================== Token 池管理 ====================
function getTokenPool() { return GM_getValue('baidu_token_pool', []); }
function saveTokenPool(pool) { GM_setValue('baidu_token_pool', pool); }

function addToken(token, name, bduss) {
  const pool = getTokenPool();
  // 去重（按 token 或 BDUSS）
  if (pool.some(t => t.token === token)) return null;
  // BDUSS 匹配 → 合并到已有条目（更新 token，补 BDUSS）
  if (bduss) {
    const existing = pool.find(t => t.bduss === bduss);
    if (existing) {
      const changes = {};
      if (existing.token !== token) changes.token = token;
      if (!existing.bduss) changes.bduss = bduss;
      if (name && !existing.name.startsWith('百度账号')) changes.name = name;
      if (Object.keys(changes).length) updateToken(existing.id, changes);
      return null;
    }
  }
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    token,
    bduss: bduss || '',
    name: name || `百度账号 ${pool.length + 1}`,
    addedAt: new Date().toISOString(),
    lastUsed: null,
    status: 'unknown', // unknown | valid | expired
  };
  pool.push(entry);
  saveTokenPool(pool);
  return entry;
}

function removeToken(id) {
  saveTokenPool(getTokenPool().filter(t => t.id !== id));
}

function updateToken(id, changes) {
  const pool = getTokenPool();
  const t = pool.find(t => t.id === id);
  if (t) { Object.assign(t, changes); saveTokenPool(pool); }
}

// ==================== 直链缓存管理 ====================
// 直链缓存：每个条目 { id, name, size, url, source, tokenName, createdAt }
function getLinkCache() { return GM_getValue('gl_link_cache', []); }
function saveLinkCache(cache) { GM_setValue('gl_link_cache', cache); }
function addLinkToCache(link) {
  const cache = getLinkCache();
  // 去重：同 url 不重复添加
  if (cache.some(l => l.url === link.url)) return;
  cache.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: link.name || '未命名',
    size: link.size || 0,
    url: link.url,
    source: link.source || 'unknown',
    tokenName: link.tokenName || '',
    accessToken: link.accessToken || '',     // 用于删除网盘文件
    drivePath: link.drivePath || '',         // 网盘文件路径（如 /03.mp4）
    createdAt: new Date().toISOString(),
  });
  saveLinkCache(cache);
}
function removeLinkFromCache(id) {
  saveLinkCache(getLinkCache().filter(l => l.id !== id));
}

// ==================== 百度 OAuth ====================
// 在 openapi.baidu.com 页面上自动捕获 token（OAuth 回调）
try {
  if (location.hostname === 'openapi.baidu.com') {
    const url = location.href;
    const hash = location.hash;
    const fragment = hash ? hash.slice(1) : '';

    // 检查是否有 access_token（最终步骤）
    const tokenMatch = fragment.match(/access_token=([^&]+)/) || url.match(/[?&]access_token=([^&]+)/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      const entry = addToken(token);
      if (entry) {
        glLog(`✅ 百度 OAuth token 已自动捕获: ${token.slice(0, 20)}...`);
        GM_setClipboard(token);
      } else {
        glLog(`token 已存在，跳过保存`);
      }
    }
    // 检查是否是 nu_token（中间步骤，已登录但未授权）
    else if (url.includes('nu_token=') || url.includes('errmsg=Auth')) {
      glLog('检测到百度登录成功，等待授权...');
      // 自动点击授权按钮
      const observer = new MutationObserver(() => {
        const btn = document.querySelector('button#auth-allow, input[type="submit"], .pass-button-submit, button[class*="submit"]');
        if (btn) {
          btn.click();
          glLog('自动点击授权按钮');
          observer.disconnect();
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 10000);
    }
  }
} catch (e) { glLog(`OAuth 捕获错误: ${e.message}`, 'err'); }

// ==================== React 工具 ====================
function findReact(dom, traverseUp = 0) {
  const key = Object.keys(dom).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  const fiber = dom[key]; if (!fiber) return null;
  const getParent = f => { let p = f.return; while (typeof p.type === 'string') p = p.return; return p; };
  let comp = getParent(fiber);
  for (let i = 0; i < traverseUp; i++) comp = getParent(comp);
  return comp.stateNode || comp;
}

// ==================== 百度文件提取 ====================
function extractBaiduFiles(url) {
  const result = { files: [], shareInfo: {}, pageType: 'home' };
  const w = unsafeWindow;
  const isShare = /\/s\//.test(url) || /\/share\//.test(url);
  result.pageType = isShare ? 'share' : 'home';

  try {
    let list = [];
    // 策略 1: Vue allFileList
    const fileListEl = document.querySelector('.file-list');
    if (fileListEl?.__vue__?.allFileList?.[0]) {
      list = fileListEl.__vue__.allFileList.filter(i => !!i.selected);
    }
    // 策略 2: Vue selectedList
    if (!list.length) {
      const wpCore = document.querySelector('.wp-s-core-pan');
      if (wpCore?.__vue__?.selectedList?.[0]) list = wpCore.__vue__.selectedList;
    }
    // 策略 3: system-core
    if (!list.length) {
      try {
        const context = w.require?.('system-core:context/context.js');
        if (context?.instanceForSystem?.list?.getSelected?.()?.[0]) list = context.instanceForSystem.list.getSelected();
      } catch {}
    }

    for (const item of list) {
      result.files.push({
        fs_id: item.fs_id,
        name: item.server_filename || item.filename || '未命名',
        size: item.size || 0,
        isDir: item.isdir === 1,
      });
    }

    // 分享页参数
    if (isShare) {
      const surl = url.match(/s\/([\w-]+)/)?.[1]?.replace(/^1(.{22})$/, '$1') || '';
      const locals = w.locals?.dump?.() || w.locals;
      const html = document.documentElement.innerHTML;

      // share_uk: 多层 fallback
      let share_uk = locals?.share_uk?.value || '';
      if (!share_uk) {
        // React fiber / window 变量
        share_uk = html.match(/share_uk['"]?\s*:\s*\{[^}]*value['"]?\s*:\s*['"](\d+)['"]/i)?.[1]
          || html.match(/['"]share[_]?uk['"][:\s=]+['"]?(\d{10,25})['"]?/i)?.[1]
          // 新版页面可能直接存为数字
          || html.match(/share_uk[^}]*?(\d{10,25})/i)?.[1]
          // window 全局变量
          || (typeof w.share_uk !== 'undefined' ? String(w.share_uk) : '')
          || '';
      }

      // share_id: 多层 fallback
      let share_id = locals?.shareid?.value || '';
      if (!share_id) {
        // 尝试从 React fiber 读取
        try {
          const rootEl = document.getElementById('app') || document.getElementById('root') || document.querySelector('[id^="__"]');
          if (rootEl?._reactRootContainer) {
            const fiber = rootEl._reactRootContainer._internalRoot?.current;
            // 遍历 fiber 树找 shareid
            let node = fiber;
            for (let i = 0; i < 50 && node; i++) {
              const state = node.memoizedState;
              if (state?.shareid) { share_id = String(state.shareid); break; }
              if (node.memoizedProps?.shareid) { share_id = String(node.memoizedProps.shareid); break; }
              node = node.child || node.sibling || node.return?.sibling;
            }
          }
        } catch {}
      }
      if (!share_id) {
        share_id = html.match(/shareid['"]?\s*:\s*\{[^}]*value['"]?\s*:\s*['"](\d+)['"]/i)?.[1]
          || html.match(/['"]share[_]?id['"][:\s=]+['"]?(\d{5,25})['"]?/i)?.[1]
          || html.match(/shareid[^}]*?(\d{5,25})/i)?.[1]
          || (typeof w.shareid !== 'undefined' ? String(w.shareid) : '')
          || '';
      }

      // bdstoken: 多层 fallback
      let bdstoken = locals?.bdstoken?.value || '';
      if (!bdstoken) {
        bdstoken = html.match(/bdstoken['"]?\s*:\s*\{[^}]*value['"]?\s*:\s*['"]([a-f0-9]+)['"]/i)?.[1]
          || html.match(/bdstoken['"]?\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/i)?.[1]
          || (typeof w.bdstoken !== 'undefined' ? w.bdstoken : '')
          || '';
      }

      result.shareInfo = {
        surl,
        share_uk,
        share_id,
        bdstoken,
        baidu_id: document.cookie.split('BAIDUID=')[1]?.split(';')[0] || '',
        js_token: w.jsToken
          || document.cookie.match(/jsToken=([a-f0-9]+)/)?.[1]
          || html.match(/jsToken['"]?\s*[:=]\s*['"]([a-f0-9]{32,})['"]/i)?.[1] || '',
        se_key: w.currentSekey || w.cache?.list?.config?.params?.sekey || '',
      };
      glLog(`提取参数: uk=${share_uk||'空'} id=${share_id||'空'} bdstoken=${bdstoken ? bdstoken.slice(0,8)+'...' : '空'} jsToken=${result.shareInfo.js_token?.slice(0,12)||'空'}... sekey=${result.shareInfo.se_key ? '有' : '无'}`);
      if (!share_uk || !share_id) glLog('⚠️ share_uk 或 share_id 为空，尝试从页面其他位置提取...');

      // 调试：dump 所有可能的 share 变量
      try {
        const debugVars = {};
        for (const key of ['shareid', 'share_id', 'share_uk', 'shareUK', 'shareId', 'fileList', 'yunData', 'pageData']) {
          if (typeof w[key] !== 'undefined') debugVars[key] = typeof w[key] === 'object' ? JSON.stringify(w[key]).slice(0,100) : String(w[key]).slice(0,50);
        }
        glLog(`页面变量: ${JSON.stringify(debugVars)}`);
      } catch {}
    }
  } catch (e) {
    glLog(`文件提取错误: ${e.message}`, 'err');
  }

  return result;
}

// ==================== 百度保存到网盘 + 从个人网盘拿直链 ====================

// 保存分享文件到自己的网盘
// 保存分享文件到网盘 V2 — 支持 OAuth、BDUSS、浏览器 BDUSS 三种方式
async function saveShareToDriveV2(file, shareInfo, accessToken, tokenBduss) {
  if (!file?.fs_id) throw new Error('缺少 fs_id');
  if (!shareInfo?.share_id || !shareInfo?.share_uk) throw new Error('缺少 share_id 或 share_uk');

  const sekey = shareInfo.se_key || '';
  const shareUrl = `https://pan.baidu.com/share/s/1${shareInfo.surl || ''}`;
  const transferParams = new URLSearchParams({
    shareid: String(shareInfo.share_id),
    from: String(shareInfo.share_uk),
  });
  if (sekey) transferParams.set('sekey', sekey);
  const body = `fsidlist=${encodeURIComponent(JSON.stringify([file.fs_id]))}&path=${encodeURIComponent('/')}`;

  // 方案1: xpan/share transfer（OAuth 方式 — 保存到 token 对应的账号网盘）
  if (accessToken) {
    try {
      const xpanUrl = `https://pan.baidu.com/rest/2.0/xpan/share?method=transfer&access_token=${accessToken}`;
      const xpanBody = new URLSearchParams({
        fsid_list: JSON.stringify([file.fs_id]),
        path: '/',
        shareid: String(shareInfo.share_id),
        from: String(shareInfo.share_uk),
      });
      if (sekey) xpanBody.set('sekey', sekey);

      glLog(`xpan/share transfer: fsid=${file.fs_id}`);
      const res = await gmFetch(xpanUrl, 'POST', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://pan.baidu.com/',
      }, xpanBody);

      if (res?.errno === 0 && res?.list?.[0]) {
        glLog(`xpan 保存成功! path=${res.list[0].path}`);
        return res.list[0];
      }
      if (res?.errno === 4) {
        return { path: '/' + (file.name || 'unknown'), alreadyExists: true };
      }
      glLog(`xpan 失败 (errno=${res?.errno})`);
    } catch (e) {
      glLog(`xpan 异常: ${e.message}`);
    }
  }

  // 方案2: share/transfer 用指定 BDUSS（GM_xmlhttpRequest 发送 Cookie）
  if (tokenBduss) {
    try {
      const url = `https://pan.baidu.com/share/transfer?${transferParams.toString()}`;
      glLog(`share/transfer 指定BDUSS(${tokenBduss.slice(0,10)}...): from=${shareInfo.share_uk} sekey=${sekey ? '有' : '无'} anonymous=true`);
      const res = await gmFetch(url, 'POST', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `BDUSS=${tokenBduss}`,
        'Referer': shareUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      }, body, true);  // anonymous=true 不发浏览器 cookies

      glLog(`BDUSS share/transfer 响应: errno=${res?.errno}`);
      const saved = res?.info?.[0] || res?.list?.[0];
      if (res?.errno === 0 && saved) {
        if (saved.fsid && !saved.fs_id) saved.fs_id = saved.fsid;
        glLog(`BDUSS 保存成功! path=${saved.path} fs_id=${saved.fs_id || '无'}`);
        return saved;
      }
      if (res?.errno === 4) {
        // 文件已存在，返回路径即可，fs_id 由 getPersonalDriveLink 通过 OAuth search 查找
        const existPath = '/' + (file.name || 'unknown');
        glLog(`文件已存在(errno=4), path=${existPath}, fs_id 由后续 OAuth search 查找`);
        return { path: existPath, alreadyExists: true };
      }
    } catch (e) {
      glLog(`BDUSS share/transfer 异常: ${e.message}`);
    }
  }

  // 方案3: 仅当 token 没有 BDUSS 时，才用浏览器 BDUSS 兜底
  // 有 BDUSS 但保存失败（如 errno=-6）说明是权限问题，不该存到浏览器账号里
  if (!tokenBduss) {
    const url = `https://pan.baidu.com/share/transfer?${transferParams.toString()}`;
    try {
      glLog(`token 无 BDUSS，尝试用浏览器 BDUSS 保存...`);
      const resp = await unsafeWindow.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: body,
      });
      const res = await resp.json();
      const saved = res?.info?.[0] || res?.list?.[0];
      if (res?.errno === 0 && saved) {
        glLog(`浏览器BDUSS 保存成功! path=${saved.path}`);
        return saved;
      }
      if (res?.errno === 4) {
        return { path: '/' + (file.name || 'unknown'), alreadyExists: true };
      }
    } catch (e) {
      glLog(`浏览器BDUSS 失败: ${e.message}`);
    }
  }

  throw new Error('保存到网盘失败 — 所有方案均不可用');
}

// 检查文件是否已在个人网盘中
async function checkFileInDrive(fileName, accessToken, bduss) {
  try {
    const headers = {};
    // 优先用 OAuth（从分享页调用 file.list 更可靠）
    const url = accessToken
      ? `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent('/')}&access_token=${accessToken}&order=time&desc=1&page=1&num=100`
      : `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent('/')}&order=time&desc=1&page=1&num=100`;
    if (!accessToken && bduss) headers['Cookie'] = `BDUSS=${bduss}`;
    // OAuth 用 anonymous=true 不发浏览器 cookies，避免浏览器 BDUSS 干扰
    // BDUSS 用 withCredentials=true 保留浏览器 cookie 兜底
    const res = await gmFetch(url, 'GET', headers, undefined, !!accessToken);
    glLog(`checkFileInDrive: 用${accessToken ? 'OAuth' : 'BDUSS'}查询, 返回${res?.list?.length || 0}个文件, errno=${res?.errno}`);
    if (res?.list) {
      const match = res.list.find(f => f.server_filename === fileName);
      if (match) return { path: match.path, fs_id: match.fs_id, name: match.server_filename };
    }
  } catch (e) {
    glLog(`checkFileInDrive 失败: ${e.message}`);
  }
  return null;
}

// 从个人网盘获取直链（filemetas API）
// 流程：1) 确认文件在 OAuth 可见的个人网盘中 2) 用 OAuth file.list 拿到正确的 fs_id 3) filemetas 获取 dlink
async function getPersonalDriveLink(savedFile, accessToken, tokenBduss) {
  const fileName = savedFile.path ? savedFile.path.split('/').pop() : '';
  const dirPath = savedFile.path ? (savedFile.path.substring(0, savedFile.path.lastIndexOf('/')) || '/') : '/';

  // 不管 savedFile 有没有 fs_id，都重新查找正确的个人网盘 fs_id
  // 因为 share/transfer 返回的 fs_id 是分享源的，不是个人网盘里的
  let fsId = null;

  // 方案1: OAuth 搜索 API（全盘搜，不受目录限制，最可靠）
  if (accessToken && fileName) {
    glLog(`用 OAuth search 搜索文件: ${fileName}`);
    try {
      const searchUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=search&key=${encodeURIComponent(fileName)}&rec=1&order=time&desc=1&access_token=${accessToken}`;
      const searchRes = await gmFetch(searchUrl, 'GET', { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' }, undefined, true);
      glLog(`OAuth search: 返回${searchRes?.list?.length || 0}个结果, errno=${searchRes?.errno}`);
      if (searchRes?.list) {
        // 精确匹配文件名（search 已按时间倒序，第一个就是最新的）
        const candidates = searchRes.list.filter(f => f.server_filename === fileName);
        if (candidates.length > 1) {
          glLog(`发现 ${candidates.length} 个同名文件，优先匹配 size=${savedFile.size || '未知'}`);
        }
        // 优先匹配 size（如果有），否则取最新的第一个
        const match = savedFile.size
          ? (candidates.find(f => f.size === savedFile.size) || candidates[0])
          : candidates[0];
        if (match) {
          fsId = match.fs_id;
          glLog(`OAuth search 找到: fs_id=${fsId} path=${match.path} size=${match.size}`);
        }
      }
    } catch (e) {
      glLog(`OAuth search 失败: ${e.message}`);
    }
  }

  // 方案2: OAuth file.list（查根目录，作为 search 的补充）
  if (!fsId && accessToken && fileName) {
    glLog(`search 未找到，尝试 OAuth file.list: dir=${dirPath}`);
    try {
      const listUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(dirPath)}&access_token=${accessToken}&order=time&desc=1&page=1&num=100`;
      const listRes = await gmFetch(listUrl, 'GET', { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' }, undefined, true);
      glLog(`OAuth file.list: 返回${listRes?.list?.length || 0}个文件, errno=${listRes?.errno}`);
      if (listRes?.list) {
        const match = listRes.list.find(f => f.server_filename === fileName || f.path === savedFile.path);
        if (match) {
          fsId = match.fs_id;
          glLog(`OAuth file.list 找到: fs_id=${fsId} (path=${match.path})`);
        }
      }
    } catch (e) {
      glLog(`OAuth file.list 失败: ${e.message}`);
    }
  }

  // 注意：BDUSS file.list 从分享页调用必然 errno=-6，已移除

  // 最后手段：用 savedFile 的 fs_id（可能不准确，但总比报错好）
  if (!fsId) {
    fsId = savedFile.fs_id;
    if (!fsId) {
      throw new Error(
        `找不到文件 fs_id: ${fileName}\n` +
        `可能原因：文件保存到了不同账号的网盘（浏览器 BDUSS ≠ token 的 OAuth）\n` +
        `建议：检查该账号的 BDUSS 是否与 OAuth 同一账号`
      );
    }
    glLog(`搜索和 file.list 都未找到文件，使用 transfer 返回的 fs_id: ${fsId}（注意：这是分享源 fs_id，可能不准确）`);
  }

  const fsids = JSON.stringify([fsId]);
  glLog(`调用 filemetas: fs_id=${fsId}`);

  // OAuth filemetas 获取 dlink（anonymous=true 不发浏览器 cookies，避免 BDUSS 冲突）
  const res = await gmFetch(
    `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=${encodeURIComponent(fsids)}&access_token=${accessToken}`,
    'GET',
    { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' },
    undefined,
    true
  );
  glLog(`filemetas 响应: errno=${res?.errno} list长度=${res?.list?.length || 0} dlink=${res?.list?.[0]?.dlink ? '有' : '无'}`);

  if (res?.list?.[0]?.dlink) {
    let dlink = res.list[0].dlink;
    // dlink 需要带 access_token 才能下载
    try { const u = new URL(dlink); u.searchParams.set('access_token', accessToken); dlink = u.toString(); } catch {}
    glLog(`直链获取成功: ${dlink.slice(0, 60)}...`);
    return dlink;
  }

  // filemetas 失败时给详细错误
  if (res?.errno === 9019) {
    throw new Error('获取直链失败: OAuth access_token 已过期，请重新授权');
  }
  const errMsg = res?.show_msg || res?.errmsg || `errno=${res?.errno}`;
  glLog(`filemetas 无 dlink: errno=${res?.errno} errmsg=${res?.errmsg || '-'} show_msg=${res?.show_msg || '-'}`, 'err');
  throw new Error(`获取直链失败: ${errMsg}`);
}

// 从个人网盘删除文件（filemanager API）
// 认证：OAuth access_token（URL 参数）
// 参数：filePaths — 文件路径数组，如 ["/test.mp4", "/test2.mp4"]
async function deleteFilesFromDrive(filePaths, accessToken) {
  if (!filePaths?.length) throw new Error('没有要删除的文件');
  if (!accessToken) throw new Error('缺少 OAuth access_token');

  const filelist = JSON.stringify(filePaths);
  glLog(`删除文件: ${filePaths.length} 个, 路径: ${filePaths.join(', ')}`);

  const res = await gmFetch(
    `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${accessToken}`,
    'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' },
    `filelist=${encodeURIComponent(filelist)}`
  );

  glLog(`删除响应: errno=${res?.errno} info=${JSON.stringify(res?.info || res?.errmsg || res)}`);
  if (res?.errno === 0) {
    glLog(`删除成功: ${filePaths.length} 个文件`);
    return res;
  }
  throw new Error(`删除失败: errno=${res?.errno} ${res?.errmsg || res?.show_msg || ''}`);
}

// ==================== 百度直链获取 ====================
async function getBaiduLinks(files, pageInfo, accessToken) {
  const results = [];
  const batch = files.filter(f => !f.isDir);

  if (pageInfo.pageType === 'share') {
    const sData = pageInfo.shareInfo;
    const logid = encodeBase(sData.baidu_id || '');

    // 1. 获取 sign/timestamp
    const signUrl = `https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&surl=1${sData.surl}$bdstoken=${sData.bdstoken || ''}&logid=${logid}`;
    try {
      const signRes = await gmFetch(signUrl, 'GET', { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' });
      if (signRes?.data?.sign) {
        sData.sign = signRes.data.sign;
        sData.timestamp = signRes.data.timestamp;
      } else {
        throw new Error(`sign 获取失败: code=${signRes?.errno}, msg=${signRes?.show_msg || signRes?.errmsg || '未知'}`);
      }
    } catch (e) {
      throw new Error(`获取 sign 失败 — ${e.message}\n可能原因：\n- 分享链接已失效\n- 百度 session 过期\n- 网络连接问题`);
    }

    // 2. 逐文件获取 dlink
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const apiUrl = `https://pan.baidu.com/api/sharedownload?channel=chunlei&clienttype=0&web=1&app_id=250528&sign=${sData.sign || ''}&timestamp=${sData.timestamp || ''}&bdstoken=${sData.bdstoken || ''}&logid=${logid}&jsToken=${sData.js_token || ''}`;
      const body = new URLSearchParams({ encrypt: 0, product: 'share', uk: sData.share_uk, primaryid: sData.share_id, fid_list: JSON.stringify([item.fs_id]) });
      // 恢复 sekey（LinkSwift 原版逻辑：有 sekey 就传）
      if (sData.se_key) body.set('extra', JSON.stringify({ sekey: sData.se_key }));
      glLog(`请求 sharedownload: sign=${sData.sign?.slice(0,8)}... uk=${sData.share_uk} id=${sData.share_id} js=${sData.js_token?.slice(0,8)}... sekey=${sData.se_key ? '有' : '无'}`);

      try {
        let res;
        for (let retry = 0; retry < 3; retry++) {
          res = await gmFetch(apiUrl, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': '*/*', 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' }, body);
          glLog(`sharedownload 响应: errno=${res?.errno} list=${Array.isArray(res?.list) ? '数组(' + res.list.length + ')' : typeof res?.list === 'string' ? '加密(' + res.list.length + '字符)' : '空'}`);
          if (res?.errno !== -20) break;
          if (retry < 2) {
            const wait = (retry + 1) * 3000;
            glLog(`errno=-20 验证码，${wait/1000}秒后重试 (${retry+1}/3)...`);
            await sleep(wait);
          }
        }
        if (Array.isArray(res?.list) && res.list[0]?.dlink) {
          // 正常返回：list 是数组，包含 dlink
          let dlink = res.list[0].dlink;
          if (accessToken) {
            try { const u = new URL(dlink); u.searchParams.set('access_token', accessToken); dlink = u.toString(); } catch {}
          }
          results.push({ name: item.name, size: item.size, url: dlink });
        } else if (res?.errno === 0 && !Array.isArray(res?.list)) {
          // errno=0 但 list 不是数组 → 文件过大，需保存到网盘
          results.push({ name: item.name, size: item.size, url: null, error: '此文件过大，需要保存到网盘后于网盘中下载' });
        } else {
          const errno = res?.errno;
          const errmsg = res?.show_msg || res?.errmsg || '未知';
          // 详细错误映射
          const errorMap = {
            '-20': '验证码错误 — 百度要求人机验证，请在页面上点击下载触发验证码后重试',
            '112': '页面已过期 — 请刷新分享页面后重新获取',
            '118': '违规操作 — 可能需要重新 OAuth 授权',
            '9019': 'Token 过期 — 请重新 OAuth 登录获取新 token',
          };
          const hint = errorMap[String(errno)] || `未知错误`;
          results.push({ name: item.name, size: item.size, url: null, error: `[${errno}] ${hint} — ${errmsg}` });
        }
      } catch (e) {
        results.push({ name: item.name, size: item.size, url: null, error: `请求失败: ${e.message}` });
      }
      if (i < batch.length - 1) await sleep(2000);
    }
  } else {
    // 个人网盘 filemetas
    if (!accessToken) throw new Error('个人网盘需要 OAuth access_token，请先添加百度账号并授权');
    const fsids = JSON.stringify(batch.map(f => f.fs_id));
    try {
      const res = await gmFetch(`https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=${encodeURIComponent(fsids)}&access_token=${accessToken}`, 'GET', { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' }, undefined, true);
      if (res?.list) {
        res.list.forEach(item => {
          if (item.dlink) {
            let dlink = item.dlink;
            try { const u = new URL(dlink); u.searchParams.set('access_token', accessToken); dlink = u.toString(); } catch {}
            results.push({ name: item.server_filename, size: item.size, url: dlink });
          }
        });
      } else {
        const errno = res?.errno;
        const errorMap = {
          '112': '页面已过期，请刷新后重试',
          '9019': 'Token 过期，请重新 OAuth 登录',
          '-6': '无权限访问该文件',
        };
        throw new Error(`filemetas 错误 [${errno}]: ${errorMap[String(errno)] || res?.errmsg || '未知'}`);
      }
    } catch (e) {
      if (e.message.includes('filemetas')) throw e;
      throw new Error(`获取直链失败: ${e.message}`);
    }
  }

  return results;
}

// ==================== CSS ====================
const CSS = `
#gl-btn{position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 20px;border:none;border-radius:8px;background:linear-gradient(135deg,#306cff,#2b4eff);color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(48,108,255,.35);display:flex;align-items:center;gap:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;user-select:none;white-space:nowrap}
#gl-btn:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(48,108,255,.45)}
#gl-btn.loading{background:#306cff;cursor:wait;opacity:.85}
#gl-spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:gl-spin .6s linear infinite;flex-shrink:0}
@keyframes gl-spin{to{transform:rotate(360deg)}}
#gl-panel{position:fixed;right:24px;bottom:80px;z-index:2147483646;width:440px;max-height:75vh;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;font-size:13px;color:#202124;display:flex;flex-direction:column;overflow:hidden;animation:gl-in .25s ease}
@keyframes gl-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.gl-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg,#306cff,#2b4eff);color:#fff;cursor:move;user-select:none;flex-shrink:0}
.gl-hdr h3{font-size:15px;font-weight:600;margin:0}
.gl-close{font-size:22px;cursor:pointer;opacity:.8;line-height:1}.gl-close:hover{opacity:1}
.gl-body{overflow-y:auto;flex:1;padding:0}
.gl-sec{padding:14px 16px;border-bottom:1px solid #e8eaed}
.gl-sec h4{font-size:13px;font-weight:600;margin:0 0 10px;color:#202124;display:flex;align-items:center;gap:6px}
.gl-sec h4 .badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#e8f0fe;color:#306cff;font-weight:500}
.gl-btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;font-family:inherit}
.gl-btn-primary{background:#306cff;color:#fff}.gl-btn-primary:hover{background:#2050d0}
.gl-btn-secondary{background:#f0f4ff;color:#306cff}.gl-btn-secondary:hover{background:#dde4ff}
.gl-btn-danger{background:#fef0f0;color:#d93025}.gl-btn-danger:hover{background:#fcd9d7}
.gl-btn-sm{padding:5px 12px;font-size:12px}
.gl-btn:disabled{opacity:.5;cursor:not-allowed}
.gl-token{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f3f4;font-size:12px}
.gl-token:last-child{border-bottom:none}
.gl-token-name{flex:1;font-weight:500;font-size:13px}
.gl-token-status{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.gl-token-status.valid{background:#e6f4ea;color:#137333}.gl-token-status.expired{background:#fce8e6;color:#d93025}.gl-token-status.unknown{background:#f1f3f4;color:#5f6368}
.gl-token-time{color:#80868b;font-size:11px}
.gl-token-del{color:#d93025;cursor:pointer;font-size:15px;opacity:.5}.gl-token-del:hover{opacity:1}
.gl-token-edit{color:#1a73e8;cursor:pointer;font-size:13px;opacity:.6;margin-left:4px}.gl-token-edit:hover{opacity:1}
.gl-token-info{color:#5f6368;cursor:pointer;font-size:13px;opacity:.6;margin-left:4px}.gl-token-info:hover{opacity:1}
.gl-edit-form{margin:8px 0;padding:10px;background:#f8f9fa;border-radius:6px;font-size:12px}
.gl-edit-form input{width:100%;padding:4px 6px;border:1px solid #dadce0;border-radius:4px;font-size:11px;font-family:monospace;margin:2px 0 6px;box-sizing:border-box}
.gl-edit-form .gl-edit-row{margin-bottom:6px}
.gl-edit-form label{font-size:11px;color:#5f6368;font-weight:500}
.gl-actions{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #e8eaed;flex-shrink:0}
.gl-link{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;margin-bottom:4px;border-radius:8px;background:#f8f9fa;flex-wrap:wrap}
.gl-link-ok{background:#e6f4ea}.gl-link-err{background:#fce8e6}
.gl-link-status{flex-shrink:0;font-size:14px}
.gl-link-name{font-weight:500;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-link-size{color:#5f6368;font-size:12px;flex-shrink:0}
.gl-link-url{width:100%;font-size:11px;color:#5f6368;word-break:break-all;line-height:1.4}
.gl-link-err-text{width:100%;font-size:12px;color:#d93025;line-height:1.4;white-space:pre-wrap}
.gl-link-copy{padding:2px 10px;border:1px solid #dadce0;border-radius:4px;background:#fff;color:#306cff;font-size:12px;cursor:pointer;flex-shrink:0;margin-left:auto}.gl-link-copy:hover{background:#f0f4ff}
.gl-notif{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:14px 28px;border-radius:10px;font-size:14px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.2);max-width:600px;min-width:200px;text-align:center;animation:gl-ni .3s ease;line-height:1.5;white-space:pre-wrap}
@keyframes gl-ni{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.gl-notif-info{background:#306cff;color:#fff}.gl-notif-ok{background:#34a853;color:#fff}.gl-notif-err{background:#d93025;color:#fff}
.gl-notif-close{position:absolute;top:8px;right:12px;cursor:pointer;font-size:18px;opacity:.7}.gl-notif-close:hover{opacity:1}
.gl-empty{text-align:center;color:#80868b;padding:20px;font-size:13px;font-style:italic}
.gl-hint{font-size:11px;color:#80868b;line-height:1.5;margin-top:6px}
.gl-progress{height:4px;background:#e8eaed;border-radius:2px;overflow:hidden;margin:8px 0}
.gl-progress-bar{height:100%;background:linear-gradient(90deg,#306cff,#2b4eff);transition:width .3s;border-radius:2px}
.gl-token-card{display:flex;align-items:flex-start;gap:10px;padding:12px;margin-bottom:8px;border:1px solid #e8eaed;border-radius:10px;background:#fff;transition:all .15s}
.gl-token-card:hover{border-color:#306cff;box-shadow:0 2px 8px rgba(48,108,255,.1)}
.gl-token-card.selected{border-color:#306cff;background:#f0f4ff}
.gl-token-cb{margin-top:3px;flex-shrink:0;accent-color:#306cff;width:16px;height:16px;cursor:pointer}
.gl-token-main{flex:1;min-width:0}
.gl-token-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.gl-token-card-name{font-weight:600;font-size:13px;color:#202124}
.gl-health-badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.gl-health-ok{background:#e6f4ea;color:#137333}
.gl-health-banned{background:#fce8e6;color:#d93025}
.gl-health-expired{background:#fef7e0;color:#b06000}
.gl-health-unknown{background:#f1f3f4;color:#5f6368}
.gl-token-meta{font-size:11px;color:#80868b;line-height:1.6}
.gl-token-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.gl-select-bar{display:flex;align-items:center;gap:8px;padding:10px 0;flex-wrap:wrap}
.gl-select-bar label{font-size:12px;color:#5f6368;cursor:pointer;display:flex;align-items:center;gap:4px}
.gl-select-bar label input{accent-color:#306cff}
.gl-token-run{color:#34a853;cursor:pointer;font-size:13px;opacity:.6;margin-left:4px}.gl-token-run:hover{opacity:1}
/* 管理面板 */
#gl-mgr-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;animation:gl-fade-in .2s ease}
@keyframes gl-fade-in{from{opacity:0}to{opacity:1}}
#gl-mgr-panel{width:90vw;max-width:900px;height:85vh;background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
.gl-mgr-header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:linear-gradient(135deg,#306cff,#2b4eff);color:#fff;flex-shrink:0}
.gl-mgr-header h2{font-size:18px;font-weight:700;margin:0}
.gl-mgr-close{font-size:26px;cursor:pointer;opacity:.8;line-height:1}.gl-mgr-close:hover{opacity:1}
.gl-mgr-tabs{display:flex;gap:0;border-bottom:2px solid #e8eaed;flex-shrink:0;background:#f8f9fa}
.gl-mgr-tab{padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;color:#5f6368;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s}
.gl-mgr-tab:hover{color:#306cff}
.gl-mgr-tab.active{color:#306cff;border-bottom-color:#306cff;background:#fff}
.gl-mgr-body{flex:1;overflow-y:auto;padding:20px 24px}
.gl-mgr-section{display:none}.gl-mgr-section.active{display:block}
.gl-link-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e8eaed;border-radius:8px;margin-bottom:6px;background:#fff}
.gl-link-row:hover{border-color:#306cff}
.gl-link-row-name{font-weight:500;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-link-row-size{font-size:12px;color:#80868b;flex-shrink:0}
.gl-link-row-source{font-size:10px;padding:2px 6px;border-radius:4px;background:#e8f0fe;color:#306cff;flex-shrink:0}
.gl-link-row-time{font-size:11px;color:#80868b;flex-shrink:0}
.gl-link-row-actions{display:flex;gap:4px;flex-shrink:0}
.gl-mgr-empty{text-align:center;color:#80868b;padding:40px;font-size:14px;font-style:italic}
.gl-mgr-tools{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.gl-mgr-tools input[type=text]{padding:8px 12px;border:1px solid #dadce0;border-radius:8px;font-size:13px;flex:1;min-width:200px}
`;  // CSS 结束

// ==================== UI ====================
let panel = null;
let isDownloading = false;
// 本次下载会话中保存到网盘的文件列表（用于"清理网盘"功能）
let lastSavedFiles = [];  // [{fs_id, path, name, accessToken}]
// 多选用：选中的 token id 集合
const selectedTokens = new Set();

function injectStyles() { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

function notif(text, type = 'info', duration = 6000) {
  const old = document.getElementById('gl-notif'); if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'gl-notif'; el.className = `gl-notif gl-notif-${type}`; el.textContent = text;
  const close = document.createElement('span'); close.className = 'gl-notif-close'; close.innerHTML = '&times;'; close.onclick = () => el.remove();
  el.appendChild(close); document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
}

function copyText(text) { GM_setClipboard(text); notif('已复制到剪贴板', 'ok', 2000); }

// ==================== 主面板 ====================
function createPanel() {
  if (panel) { panel.remove(); panel = null; return; }
  if (!/pan\.baidu\.com/.test(location.href)) { notif('请在百度网盘页面使用', 'err'); return; }

  panel = document.createElement('div');
  panel.id = 'gl-panel';
  document.body.appendChild(panel); // 先加到 DOM
  renderPanel(); // 再渲染和绑定事件
  enableDrag(panel, panel.querySelector('.gl-hdr'));
}

function renderPanel() {
  const pool = getTokenPool();
  const isShare = /\/s\//.test(location.href) || /\/share\//.test(location.href);

  panel.innerHTML = `
    <div class="gl-hdr">
      <h3>GoodLink 百度直链助手</h3>
      <span class="gl-close" id="gl-close">&times;</span>
    </div>
    <div class="gl-body">
      <div class="gl-sec">
        <h4>百度账号 <span class="badge">${pool.length}</span></h4>
        ${pool.length > 0 ? `
        <div class="gl-select-bar">
          <label><input type="checkbox" id="gl-select-all"> 全选</label>
          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-health-check">健康检测</button>
          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-open-mgr">管理面板</button>
        </div>` : ''}
        <div id="gl-token-list">
          ${pool.length === 0 ? '<div class="gl-empty">还没有添加账号，请点击下方"添加百度账号"开始</div>' :
            pool.map(t => {
              const healthLabel = { ok: '正常', banned: '封禁', expired: '过期', unknown: '未知' };
              const h = t.health || 'unknown';
              const hDisplay = (h === 'ok' && (t.bdussStatus === 'invalid' || t.bdussStatus === 'mismatch')) ? '异常' : healthLabel[h];
              const hCls = (h === 'ok' && (t.bdussStatus === 'invalid' || t.bdussStatus === 'mismatch')) ? 'gl-health-expired' : ('gl-health-' + h);
              return `
              <div class="gl-token-card ${selectedTokens.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
                <input type="checkbox" class="gl-token-cb" data-id="${t.id}" ${selectedTokens.has(t.id) ? 'checked' : ''}>
                <div class="gl-token-main">
                  <div class="gl-token-header">
                    <span class="gl-token-card-name">${esc(t.name)}</span>
                    <span class="gl-health-badge ${hCls}">${hDisplay}</span>
                  </div>
                  <div class="gl-token-meta">
                    <span>${t.token.slice(0, 12)}...</span>
                    ${t.bduss ? '<span class="gl-token-status valid" style="font-size:9px">BDUSS</span>' : ''}
                    ${t.status === 'valid' ? '<span class="gl-token-status valid">OAuth</span>' : ''}
                    ${t.bdussStatus === 'valid' ? '<span class="gl-health-badge gl-health-ok">BDUSS OK</span>' : t.bdussStatus === 'invalid' ? '<span class="gl-health-badge gl-health-banned">BDUSS 无效</span>' : t.bdussStatus === 'mismatch' ? '<span class="gl-health-badge gl-health-expired">BDUSS 不匹配</span>' : ''}
                  </div>
                  <div class="gl-token-actions">
                    <span class="gl-token-info" data-id="${t.id}" title="查看账号信息">ℹ</span>
                    <span class="gl-token-edit" data-id="${t.id}" title="编辑">✏</span>
                    <span class="gl-token-del" data-id="${t.id}" title="删除">&times;</span>
                  </div>
                </div>
              </div>
              <div class="gl-edit-area" data-edit-id="${t.id}" style="display:none"></div>
              `;
            }).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          <button class="gl-btn gl-btn-primary gl-btn-sm" id="gl-add-token">+ 添加百度账号</button>
          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-export">导出 Token</button>
          <label class="gl-btn gl-btn-secondary gl-btn-sm" style="cursor:pointer;margin:0">
            导入
            <input type="file" id="gl-import" accept=".json" multiple style="display:none">
          </label>
        </div>
        <div id="gl-add-area" style="display:none;margin-top:10px;padding:12px;background:#f8f9fa;border-radius:8px">
          <div style="font-size:12px;color:#5f6368;margin-bottom:8px">1. 复制下方链接，在任意浏览器打开并授权：</div>
          <div style="display:flex;gap:4px;margin-bottom:8px">
            <input id="gl-oauth-url" type="text" readonly style="flex:1;padding:6px 8px;border:1px solid #dadce0;border-radius:4px;font-size:11px;font-family:monospace;background:#fff">
            <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-copy-link">复制</button>
            <button class="gl-btn gl-btn-primary gl-btn-sm" id="gl-open-link">打开</button>
          </div>
          <div style="font-size:12px;color:#5f6368;margin-bottom:4px">2. 授权后页面会显示 access_token，粘贴到下方：</div>
          <div style="display:flex;gap:4px">
            <input id="gl-token-input" type="text" placeholder="粘贴 access_token 或整段 OAuth URL（自动提取）" style="flex:1;padding:6px 8px;border:1px solid #dadce0;border-radius:4px;font-size:12px;font-family:monospace">
            <button class="gl-btn gl-btn-primary gl-btn-sm" id="gl-save-token">保存</button>
          </div>
          <div style="font-size:12px;color:#5f6368;margin:8px 0 4px">3.（可选）粘贴该账号的 BDUSS — 大文件多源下载需要：</div>
          <div style="display:flex;gap:4px">
            <input id="gl-bduss-input" type="text" placeholder="粘贴 BDUSS（可选，F12 → Application → Cookies → BDUSS）" style="flex:1;padding:6px 8px;border:1px solid #dadce0;border-radius:4px;font-size:12px;font-family:monospace">
          </div>
          <div class="gl-hint">支持任意浏览器，不需要安装脚本。授权页面会直接显示 token。<br>BDUSS 可选：有 BDUSS 才能独立保存文件到该账号网盘（大文件多源下载必须）。</div>
        </div>
        <div class="gl-hint">点击"添加"获取 OAuth 授权链接 → 在任意浏览器授权 → 粘贴 token。<br>支持多个账号，获取直链时依次尝试每个 token。</div>
      </div>



      <div class="gl-sec">
        <h4>当前页面</h4>
        <div style="font-size:12px;color:#5f6368;margin-bottom:8px">
          ${isShare ? '📁 分享页' : '📂 个人网盘'} — ${location.pathname.slice(0, 50)}
        </div>
        <button class="gl-btn gl-btn-primary" id="gl-download" style="width:100%" ${selectedTokens.size > 0 ? "" : "disabled"}>
          ${selectedTokens.size > 0 ? "获取直链 (" + selectedTokens.size + " 个选中)" : "请先勾选要使用的账号"}
        </button>
        <div class="gl-hint">${pool.length === 0 ? '⚠️ 请先添加百度账号' : isShare ? '将依次尝试每个 token 获取分享文件直链' : '将用 token 调用 filemetas API 获取直链'}</div>
      </div>

      <div class="gl-sec" id="gl-result-sec" style="display:none">
        <h4>直链结果</h4>
        <div id="gl-link-list"></div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-copy-all" disabled>全部复制</button>

          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-clean-drive" style="display:none;color:#d93025">清理网盘</button>
        </div>
        <div id="gl-clean-area" style="display:none;margin-top:8px"></div>
      </div>

      <div class="gl-sec">
        <h4>运行日志</h4>
        <pre id="gl-log-content" style="font-size:11px;color:#5f6368;background:#f8f9fa;padding:8px;border-radius:6px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0">${LOGS.length ? LOGS.map(l => '[' + l.time + '] ' + (l.level === 'err' ? '❌' : 'ℹ️') + ' ' + l.msg).join('\n') : '暂无日志'}</pre>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="gl-btn gl-btn-secondary gl-btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('gl-log-content').textContent)">复制日志</button>
          <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-export-log">导出日志</button>
          <button class="gl-btn gl-btn-secondary gl-btn-sm" onclick="document.getElementById('gl-log-content').textContent='已清空'">清空</button>
        </div>
      </div>


    </div>
  `;

  // 事件绑定（每个单独 try-catch 防止一个失败影响其他的）
  const bind = (id, event, handler) => {
    const el = panel.querySelector(`#${id}`);
    if (!el) { glLog(`元素 #${id} 不存在，跳过绑定`, 'err'); return; }
    el[event] = handler;
  };
  bind('gl-close', 'onclick', () => { panel.remove(); panel = null; });
  bind('gl-add-token', 'onclick', doAddToken);
  bind('gl-export', 'onclick', doExport);
  bind('gl-import', 'onchange', doImport);
  bind('gl-download', 'onclick', () => {
    const pool = getTokenPool();
    const indices = Array.from(selectedTokens).map(id => pool.findIndex(t => t.id === id)).filter(i => i >= 0);
    if (!indices.length) { notif('请先勾选要使用的账号', 'err'); return; }
    doDownload(indices);
  });



  bind('gl-export-log', 'onclick', () => {
    const text = LOGS.map(l => `[${l.time}] [${l.level}] ${l.msg}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `goodlink_log_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`; a.click();
  });
panel.querySelectorAll('.gl-token-del').forEach(el => {
    el.onclick = () => { removeToken(el.dataset.id); renderPanel(); notif('已删除', 'info', 2000); };
  });
  // 编辑按钮
  panel.querySelectorAll('.gl-token-edit').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.id;
      const editArea = panel.querySelector(`.gl-edit-area[data-edit-id="${id}"]`);
      if (!editArea) return;
      if (editArea.style.display !== 'none') { editArea.style.display = 'none'; return; }
      const t = getTokenPool().find(t => t.id === id);
      if (!t) return;
      editArea.innerHTML = `
        <div class="gl-edit-form">
          <div class="gl-edit-row"><label>名称</label><input class="gl-ed-name" value="${esc(t.name)}"></div>
          <div class="gl-edit-row"><label>OAuth Token</label><input class="gl-ed-token" value="${esc(t.token)}"></div>
          <div class="gl-edit-row"><label>BDUSS</label><input class="gl-ed-bduss" value="${esc(t.bduss || '')}" placeholder="留空表示无 BDUSS"></div>
          <div style="display:flex;gap:6px">
            <button class="gl-btn gl-btn-primary gl-btn-sm gl-ed-save" data-id="${id}">保存</button>
            <button class="gl-btn gl-btn-secondary gl-btn-sm gl-ed-cancel" data-id="${id}">取消</button>
          </div>
        </div>`;
      editArea.style.display = 'block';
      editArea.querySelector('.gl-ed-cancel').onclick = () => { editArea.style.display = 'none'; };
      editArea.querySelector('.gl-ed-save').onclick = () => {
        const newName = editArea.querySelector('.gl-ed-name').value.trim();
        const newToken = editArea.querySelector('.gl-ed-token').value.trim();
        const newBduss = editArea.querySelector('.gl-ed-bduss').value.trim();
        if (!newToken) { notif('OAuth Token 不能为空', 'err'); return; }
        const changes = {};
        if (newName && newName !== t.name) changes.name = newName;
        if (newToken !== t.token) { changes.token = newToken; changes.status = 'unknown'; }
        if (newBduss !== (t.bduss || '')) changes.bduss = newBduss;
        if (Object.keys(changes).length > 0) {
          updateToken(id, changes);
          notif('已保存', 'ok', 2000);
        }
        renderPanel();
      };
    };
  });
  // 查看账号信息按钮
  panel.querySelectorAll('.gl-token-info').forEach(el => {
    el.onclick = async () => {
      const id = el.dataset.id;
      const t = getTokenPool().find(t => t.id === id);
      if (!t) return;
      const editArea = panel.querySelector(`.gl-edit-area[data-edit-id="${id}"]`);
      if (!editArea) return;
      if (editArea.style.display !== 'none') { editArea.style.display = 'none'; return; }
      editArea.innerHTML = '<div class="gl-edit-form">查询中...</div>';
      editArea.style.display = 'block';
      try {
        const res = await gmFetch(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${t.token}`, 'GET', {});
        const info = res?.errno === 0 || res?.uk
          ? `<b>${res.baidu_name || '未知'}</b> (uk=${res.uk})<br>VIP类型: ${res.vip_type === 0 ? '普通' : 'VIP'}<br>已用: ${formatSize(res.used)} / 总: ${formatSize(res.total)}`
          : `OAuth 无效 (errno=${res?.errno})`;
        editArea.innerHTML = `<div class="gl-edit-form">${info}<br><span style="font-size:10px;color:#80868b">Token: ${t.token.slice(0, 20)}...<br>BDUSS: ${t.bduss ? t.bduss.slice(0, 20) + '...' : '无'}</span></div>`;
      } catch (e) {
        editArea.innerHTML = `<div class="gl-edit-form" style="color:#d93025">查询失败: ${e.message}</div>`;
      }
    };
  });

  // === 新增事件绑定：多选和批量操作 ===
  // 全选复选框
  const selectAllCb = panel.querySelector('#gl-select-all');
  if (selectAllCb) {
    selectAllCb.onchange = () => {
      const checked = selectAllCb.checked;
      panel.querySelectorAll('.gl-token-cb').forEach(cb => {
        cb.checked = checked;
        const id = cb.dataset.id;
        const card = cb.closest('.gl-token-card');
        if (checked) {
          selectedTokens.add(id);
          if (card) card.classList.add('selected');
        } else {
          selectedTokens.delete(id);
          if (card) card.classList.remove('selected');
        }
      });
    };
  }
  // 单个复选框
  panel.querySelectorAll('.gl-token-cb').forEach(cb => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      const card = cb.closest('.gl-token-card');
      if (cb.checked) {
        selectedTokens.add(id);
        if (card) card.classList.add('selected');
      } else {
        selectedTokens.delete(id);
        if (card) card.classList.remove('selected');
      }
      // 同步更新下载按钮状态
      const dlBtn = panel.querySelector('#gl-download');
      if (dlBtn) {
        dlBtn.disabled = selectedTokens.size === 0;
        dlBtn.textContent = selectedTokens.size > 0 ? `获取直链 (${selectedTokens.size} 个选中)` : '请先勾选要使用的账号';
      }
    };
  });
  // 健康检测按钮
  const healthCheckBtn = panel.querySelector('#gl-health-check');
  if (healthCheckBtn) {
    healthCheckBtn.onclick = async () => { await doHealthCheck(); renderPanel(); };
  }
  // 管理面板按钮
  const openMgrBtn = panel.querySelector('#gl-open-mgr');
  if (openMgrBtn) {
    openMgrBtn.onclick = () => { if (typeof openManager === 'function') openManager(); };
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function enableDrag(el, handle) {
  let dragging = false, sx, sy, sl, st;
  handle.addEventListener('mousedown', e => {
    if (e.target.classList.contains('gl-close')) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); sl = r.left; st = r.top; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    el.style.left = `${sl + e.clientX - sx}px`; el.style.top = `${st + e.clientY - sy}px`;
    el.style.right = 'auto'; el.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => dragging = false);
}

// ==================== 清理网盘 ====================
function showCleanDriveUI() {
  const area = document.getElementById('gl-clean-area');
  if (!area) return;
  if (area.style.display !== 'none') { area.style.display = 'none'; return; }

  if (!lastSavedFiles.length) { area.innerHTML = '<div style="color:#80868b;font-size:12px">没有需要清理的文件</div>'; area.style.display = 'block'; return; }

  // 去重（同 fs_id 只显示一次）
  const seen = new Set();
  const unique = lastSavedFiles.filter(f => { if (seen.has(f.fs_id)) return false; seen.add(f.fs_id); return true; });

  area.innerHTML = `
    <div style="background:#fff8e1;border:1px solid #ffcc02;border-radius:8px;padding:10px">
      <div style="font-size:12px;font-weight:600;color:#e65100;margin-bottom:6px">⚠️ 确认删除以下 ${unique.length} 个文件？</div>
      <div style="font-size:11px;color:#5f6368;margin-bottom:8px;max-height:120px;overflow-y:auto">
        ${unique.map(f => `<div style="padding:2px 0">• ${esc(f.name)} <span style="color:#80868b">(fs_id=${f.fs_id})</span></div>`).join('')}
      </div>
      <div style="font-size:11px;color:#d93025;margin-bottom:8px">删除后无法恢复，需重新保存才能获取直链！</div>
      <div style="display:flex;gap:6px">
        <button class="gl-btn gl-btn-primary gl-btn-sm" id="gl-clean-confirm" style="background:#d93025;border-color:#d93025">确认删除</button>
        <button class="gl-btn gl-btn-secondary gl-btn-sm" id="gl-clean-cancel">取消</button>
      </div>
      <div id="gl-clean-status" style="font-size:11px;margin-top:6px"></div>
    </div>`;
  area.style.display = 'block';

  document.getElementById('gl-clean-cancel').onclick = () => { area.style.display = 'none'; };
  document.getElementById('gl-clean-confirm').onclick = async () => {
    const statusEl = document.getElementById('gl-clean-status');
    const confirmBtn = document.getElementById('gl-clean-confirm');
    confirmBtn.disabled = true; confirmBtn.textContent = '删除中...';

    try {
      // 按 accessToken 分组删除（每个 token 独立调 API）
      const groups = {};
      for (const f of unique) {
        const key = f.accessToken || '';
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
      }

      let totalDeleted = 0;
      for (const [token, files] of Object.entries(groups)) {
        if (!token) { glLog(`跳过无 token 的文件组 (${files.length} 个)`); continue; }
        const paths = files.map(f => f.path).filter(p => p);
        if (!paths.length) continue;
        try {
          glLog(`清理网盘: token=${token.slice(0,10)}... 文件=${paths.length} 个`);
          statusEl.textContent = `正在删除 ${paths.length} 个文件...`;
          await deleteFilesFromDrive(paths, token);
          totalDeleted += paths.length;
          statusEl.textContent = `已删除 ${totalDeleted}/${unique.length} 个文件`;
        } catch (e) {
          glLog(`清理失败: ${e.message}`, 'err');
          statusEl.textContent = `删除出错: ${e.message}`;
        }
      }

      if (totalDeleted > 0) {
        statusEl.innerHTML = `<span style="color:#137333">✅ 已删除 ${totalDeleted} 个文件</span>`;
        glLog(`清理完成: ${totalDeleted} 个文件已从网盘删除`);
        lastSavedFiles = [];
        const cleanBtn = document.getElementById('gl-clean-drive');
        if (cleanBtn) cleanBtn.style.display = 'none';
        // 2秒后自动收起确认面板
        setTimeout(() => { const a = document.getElementById('gl-clean-area'); if (a) a.style.display = 'none'; }, 2000);
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:#d93025">删除失败: ${e.message}</span>`;
      glLog(`清理网盘异常: ${e.message}`, 'err');
    }
  };
}

// Motrix 相关代码已删除 — 用户改为手动复制直链到下载器



// ==================== 操作 ====================

async function doAddToken() {
  const area = document.getElementById('gl-add-area');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
  document.getElementById('gl-oauth-url').value = BAIDU_OAUTH_URL;

  // 复制链接
  document.getElementById('gl-copy-link').onclick = () => {
    copyText(BAIDU_OAUTH_URL);
  };
  // 打开链接（脚本会自动在 openapi.baidu.com 上捕获 token）
  document.getElementById('gl-open-link').onclick = () => {
    window.open(BAIDU_OAUTH_URL, '_blank');
    notif('请在新标签页中登录百度并授权\n脚本会自动捕获 token', 'info', 8000);
  };
  // 手动粘贴 token 或完整 URL（自动提取）
  document.getElementById('gl-save-token').onclick = () => {
    let raw = document.getElementById('gl-token-input').value.trim();
    if (!raw) { notif('请粘贴 access_token 或完整 URL', 'err'); return; }

    // 自动从 URL 中提取 access_token
    let token = '';
    try {
      // 检查 fragment（#后面的部分）和 query 参数
      const fragment = raw.includes('#') ? raw.split('#')[1] : raw;
      const match = fragment.match(/access_token=([^&]+)/);
      if (match) {
        token = match[1];
        glLog(`从 URL fragment 中提取到 token: ${token.slice(0, 20)}...`);
      } else {
        // 也检查 query 参数
        const queryMatch = raw.match(/[?&]access_token=([^&]+)/);
        if (queryMatch) {
          token = queryMatch[1];
          glLog(`从 URL query 中提取到 token: ${token.slice(0, 20)}...`);
        }
      }
    } catch (e) { glLog(`URL 解析错误: ${e.message}`, 'err'); }

    // 如果没有找到 access_token，检查是否有 nu_token（中间步骤）
    if (!token) {
      const nuMatch = raw.match(/nu_token=([^&]+)/);
      if (nuMatch) {
        glLog(`检测到 nu_token（中间步骤），需要继续授权`, 'err');
        notif('检测到 nu_token（中间步骤），不是最终 token\n\n请在页面上点击"授权"按钮后，复制最终的 access_token', 'err', 10000);
        return;
      }
      // 直接当作原始 token 使用
      token = raw;
      glLog(`未在 URL 中找到 access_token，直接使用粘贴内容`);
    }

    if (token.length < 20) { notif(`token 格式不对（长度 ${token.length}，期望 32+）\n\n粘贴内容: ${raw.slice(0, 100)}`, 'err', 8000); return; }

    // 读取 BDUSS（可选）
    const bdussInput = document.getElementById('gl-bduss-input');
    const bduss = bdussInput ? bdussInput.value.trim() : '';

    const entry = addToken(token, undefined, bduss);
    if (entry) {
      glLog(`token 已保存: ${entry.name} (${token.slice(0, 20)}...) BDUSS=${bduss ? '有' : '无'}`);
      notif(`✅ 已保存: ${entry.name}\ntoken: ${token.slice(0, 20)}...${bduss ? '\nBDUSS: 已配置' : ''}`, 'ok');
      document.getElementById('gl-token-input').value = '';
      if (bdussInput) bdussInput.value = '';
      area.style.display = 'none';
      renderPanel();
    } else {
      notif('该 token 已存在', 'info');
    }
  };
}

// 统一健康检测：uinfo 验活 + filemetas 检测封禁/过期
async function doHealthCheck() {
  const pool = getTokenPool();
  if (!pool.length) { notif('没有账号可检测', 'err'); return; }
  glLog(`开始健康检测: ${pool.length} 个账号`);
  notif(`正在检测 ${pool.length} 个账号...`, 'info', 15000);

  let ok = 0, banned = 0, expired = 0, failed = 0, bdussBad = 0;
  const probeFsId = '99999999999999999';

  for (let i = 0; i < pool.length; i++) {
    const t = pool[i];
    try {
      // 第一步：uinfo 验活（检查 OAuth token 是否有效）
      const uinfo = await gmFetch(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${t.token}`, 'GET', {}, undefined, true);
      const uOk = uinfo?.errno === 0 || uinfo?.uk;
      if (!uOk) {
        // uinfo 失败 → token 过期
        updateToken(t.id, { status: 'expired', health: 'expired' });
        expired++;
        glLog(`健康检测 ${t.name}: Token 过期 (uinfo errno=${uinfo?.errno})`, 'err');
        continue;
      }
      // uinfo 成功 → 更新 OAuth 状态
      updateToken(t.id, { status: 'valid', lastUsed: new Date().toISOString() });

      // 检查 BDUSS 有效性
      if (t.bduss) {
        try {
          const buinfo = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo', 'GET', {'Cookie': `BDUSS=${t.bduss}`}, undefined, true);
          if (buinfo?.uk && buinfo.uk !== 0) {
            const bdussOk = (String(buinfo.uk) === String(uinfo.uk));
            updateToken(t.id, { bdussStatus: bdussOk ? 'valid' : 'mismatch' });
            glLog(`健康检测 ${t.name}: BDUSS ${bdussOk ? '有效' : '不匹配(bduss=' + buinfo.uk + ',oauth=' + uinfo.uk + ')'}`);
          } else {
            updateToken(t.id, { bdussStatus: 'invalid' });
            glLog(`健康检测 ${t.name}: BDUSS 无效 (uk=${buinfo?.uk})`, 'err');
          }
        } catch(e) {
          updateToken(t.id, { bdussStatus: 'unknown' });
        }
      }

      // 第二步：filemetas 试探（检测 9013 封禁）
      const res = await gmFetch(
        `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=${encodeURIComponent(JSON.stringify([probeFsId]))}&access_token=${t.token}`,
        'GET', { 'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/' }, undefined, true
      );
      const errno = res?.errno;
      if (errno === 0 || errno === -6 || errno === 2) {
        // BDUSS 异常时标记为"异常"而非"正常"
        const currentBduss = getTokenPool().find(x => x.id === t.id)?.bdussStatus;
        if (currentBduss === 'invalid' || currentBduss === 'mismatch') {
          updateToken(t.id, { health: 'ok' }); // filemetas 正常但 BDUSS 有问题
          bdussBad++;
          glLog(`健康检测 ${t.name}: BDUSS 异常 (filemetas 正常, bduss=${currentBduss})`, 'err');
        } else {
          updateToken(t.id, { health: 'ok' });
          ok++;
          glLog(`健康检测 ${t.name}: 正常 (filemetas errno=${errno})`);
        }
      } else if (errno === 9013) {
        updateToken(t.id, { health: 'banned' });
        banned++;
        glLog(`健康检测 ${t.name}: 被封禁 (errno=9013 hit black uid)`, 'err');
      } else if (errno === 9019) {
        updateToken(t.id, { health: 'expired' });
        expired++;
        glLog(`健康检测 ${t.name}: Token 过期 (filemetas errno=9019)`, 'err');
      } else {
        updateToken(t.id, { health: 'unknown' });
        failed++;
        glLog(`健康检测 ${t.name}: 未知状态 errno=${errno}`);
      }
    } catch (e) {
      updateToken(t.id, { status: 'unknown', health: 'unknown' });
      failed++;
      glLog(`健康检测 ${t.name}: 请求失败 ${e.message}`, 'err');
    }
    await sleep(500);
  }
  renderPanel();
  notif(`检测完成: ${ok} 正常, ${bdussBad} BDUSS异常, ${banned} 被封, ${expired} 过期`, (banned > 0 || bdussBad > 0) ? 'err' : 'ok', 8000);
}

function doExport() {
  const pool = getTokenPool();
  if (!pool.length) { notif('没有可导出的 token', 'err'); return; }
  const data = pool.map(t => ({ name: t.name, token: t.token, bduss: t.bduss || '', addedAt: t.addedAt }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `goodlink_baidu_tokens_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  glLog(`已导出 ${pool.length} 个 token`);
  notif(`已导出 ${pool.length} 个 token`, 'ok');
}

function doImport(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  let totalCount = 0, totalDup = 0, totalSkip = 0;
  let filesProcessed = 0;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          const token = item.token || item.access_token || '';
          const name = item.name || item.account_name || item.baidu_username || '';
          const bduss = item.bduss || '';
          if (!token) { totalSkip++; continue; }
          const entry = addToken(token, name || undefined, bduss);
          if (entry) totalCount++; else totalDup++;
        }
      } catch (err) {
        totalSkip++;
      }
      filesProcessed++;
      if (filesProcessed === files.length) {
        renderPanel();
        const parts = [`${totalCount} 新增`];
        if (totalDup) parts.push(`${totalDup} 重复跳过`);
        if (totalSkip) parts.push(`${totalSkip} 无效`);
        notif(`导入完成 (${files.length} 个文件): ${parts.join(', ')}`, 'ok');
      }
    };
    reader.readAsText(file);
  }
  e.target.value = '';
}

// tokenFilter: undefined=全部, number=单个index, number[]=多个index
async function doDownload(tokenFilter) {
  const pool = getTokenPool();
  let tokensToTry;
  if (Array.isArray(tokenFilter)) {
    tokensToTry = tokenFilter.map(i => pool[i]).filter(Boolean);
  } else if (typeof tokenFilter === 'number') {
    tokensToTry = [pool[tokenFilter]];
  } else {
    tokensToTry = pool;
  }
  const label = tokensToTry.length === 1 ? `单账号: ${tokensToTry[0]?.name}` :
    tokenFilter === undefined ? `${pool.length} 个 token 全部` : `${tokensToTry.length} 个选中 token`;
  glLog(`开始下载: ${label}`);
  if (!pool.length) { notif('请先添加百度账号\n\n点"添加百度账号"获取 OAuth 链接', 'err', 10000); return; }
  if (!tokensToTry.length) { notif('没有选中的账号', 'err'); return; }
  if (isDownloading) return;
  isDownloading = true;

  // 重置已保存文件列表
  lastSavedFiles = [];
  const cleanBtn2 = document.getElementById('gl-clean-drive');
  if (cleanBtn2) cleanBtn2.style.display = 'none';
  const cleanArea2 = document.getElementById('gl-clean-area');
  if (cleanArea2) cleanArea2.style.display = 'none';

  const btn = document.getElementById('gl-download');
  if (!btn) { isDownloading = false; return; }
  btn.disabled = true; btn.innerHTML = '<span id="gl-spinner"></span> 正在提取文件...';

  try {
    // 1. 提取文件
    const info = extractBaiduFiles(location.href);
    glLog(`提取: ${info.files.length} 文件, 类型: ${info.pageType}`);
    if (!info.files.length) {
      throw new Error(`未找到可下载的文件\n\n调试信息：\n- 页面类型: ${info.pageType}\n- URL: ${location.pathname}\n\n请确保：\n- 页面已加载完成\n- 已勾选要下载的文件`);
    }
    const downloadable = info.files.filter(f => !f.isDir);
    if (!downloadable.length) {
      throw new Error(`找到 ${info.files.length} 个文件，但全部是文件夹\n\n请勾选具体的文件（不是文件夹）`);
    }

    // 2. 显示结果区域
    const resultSec = document.getElementById('gl-result-sec');
    resultSec.style.display = 'block';
    const linkList = document.getElementById('gl-link-list');
    linkList.innerHTML = '';

    // 3. 逐 token 尝试获取直链
    const allLinks = [];
    let lastError = '';

    for (let ti = 0; ti < tokensToTry.length; ti++) {
      const token = tokensToTry[ti];
      btn.innerHTML = `<span id="gl-spinner"></span> ${tokensToTry.length > 1 ? `token ${ti + 1}/${tokensToTry.length}: ` : ''}${token.name}...`;

      // 验证 OAuth 账号信息
      try {
        const uinfo = await gmFetch(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token.token}`, 'GET', {});
        glLog(`token ${ti+1} OAuth 账号: uk=${uinfo?.uk} name=${uinfo?.baidu_name} errno=${uinfo?.errno}`);
        // 如果有 BDUSS，也验证 BDUSS 账号
        if (token.bduss) {
          const buinfo = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo', 'GET', {'Cookie': `BDUSS=${token.bduss}`}, undefined, true);
          glLog(`token ${ti+1} BDUSS 账号: uk=${buinfo?.uk} name=${buinfo?.baidu_name} 匹配=${buinfo?.uk === uinfo?.uk ? '是' : '否'}`);
        }
      } catch (e) {
        glLog(`token ${ti+1} uinfo 失败: ${e.message}`);
      }

      const item = document.createElement('div');
      item.className = 'gl-link';
      item.innerHTML = `<span class="gl-link-status">⏳</span><span class="gl-link-name">${esc(token.name)}</span><span style="font-size:11px;color:#80868b">获取中...</span>`;
      linkList.appendChild(item);

      try {
        glLog(`尝试 token ${ti+1}/${tokensToTry.length}: ${token.name} (${token.token.slice(0,10)}...)`);
        btn.innerHTML = `<span id="gl-spinner"></span> ${token.name}: 获取中...`;

        let okLinks = [];
        const errLinks = [];

        if (info.pageType === 'share') {
          // 分享页：sharedownload 直接拿直链
          glLog(`分享页模式：sharedownload 获取直链`);
          btn.innerHTML = `<span id="gl-spinner"></span> ${token.name}: 获取直链...`;

          try {
            const links = await getBaiduLinks(info.files, info, token.token);
            for (const link of links) {
              if (link.url) {
                okLinks.push(link);
                addLinkToCache({ name: link.name, size: link.size, url: link.url, source: 'sharedownload', tokenName: token.name });
              } else if (link.error?.includes('过大')) {
                // 大文件：尝试客户端协议获取直链
                const origFile = info.files.find(f => f.name === link.name);
                glLog(`大文件 ${link.name}，尝试客户端协议...`);
                btn.innerHTML = `<span id="gl-spinner"></span> ${token.name}: 大文件，尝试客户端协议...`;

                // 方案A: Pan API download — 已禁用（errno=0 但不返回 dlink，每次白费调用）
                // try {
                //   if (origFile?.fs_id) {
                //     glLog(`尝试 Pan API download: fs_id=${origFile.fs_id}`);
                //     const panLinks = await clientPanDownload([origFile.fs_id]);
                //     if (panLinks?.[0]?.dlink) {
                //       glLog('Pan API 获取直链成功!');
                //       okLinks.push({ name: link.name, size: link.size, url: panLinks[0].dlink });
                //       addLinkToCache({ name: link.name, size: link.size, url: panLinks[0].dlink, source: 'pan_api', tokenName: token.name });
                //       continue;
                //     }
                //   }
                // } catch (panErr) {
                //   glLog(`Pan API download 失败: ${panErr.message}`);
                // }

                // 方案B: 先检查网盘是否已有文件 → 保存到网盘 → filemetas 获取直链
                try {
                  // 预检查：文件是否已在该账号网盘中
                  let savedFile = null;
                  const checkName = origFile?.name || link.name;
                  glLog(`检查网盘是否已有: ${checkName}`);
                  const existing = await checkFileInDrive(checkName, token.token, token.bduss);
                  if (existing) {
                    glLog(`文件已存在于网盘: ${existing.path} fs_id=${existing.fs_id}`);
                    savedFile = existing;
                  } else {
                    glLog(`文件不在网盘中，尝试保存...`);
                    btn.innerHTML = `<span id="gl-spinner"></span> ${token.name}: 保存到网盘...`;
                    savedFile = await saveShareToDriveV2(origFile, info.shareInfo, token.token, token.bduss);
                  }
                    if (savedFile?.path) {
                    btn.innerHTML = `<span id="gl-spinner"></span> ${token.name}: 获取直链...`;
                    let dlink = null;
                    // 优先用 OAuth + filemetas 获取直链（稳定可靠）
                    dlink = await getPersonalDriveLink(savedFile, token.token, token.bduss);
                    // 降级：locatedownload（BDUSS 签名，目前签名有问题）
                    if (!dlink && token.bduss) {
                      try {
                        const urls = await clientLocateDownload(savedFile.path, token.bduss, 0);
                        if (urls?.length) {
                          dlink = urls[0];
                          glLog(`locatedownload(BDUSS) 获取直链成功!`);
                        }
                      } catch (e) {
                        glLog(`locatedownload 失败: ${e.message}`);
                      }
                    }
                      if (dlink) {
                      okLinks.push({ name: link.name, size: link.size, url: dlink, bduss: token.bduss || '' });
                      addLinkToCache({ name: link.name, size: link.size, url: dlink, source: "filemetas", tokenName: token.name, accessToken: token.token, drivePath: savedFile.path });
                      // 记录已保存到网盘的文件（用于后续"清理网盘"）
                      if (savedFile?.fs_id) {
                        lastSavedFiles.push({ fs_id: savedFile.fs_id, path: savedFile.path, name: link.name, accessToken: token.token });
                        glLog(`记录待清理文件: ${link.name} fs_id=${savedFile.fs_id} path=${savedFile.path}`);
                      }
                      continue;
                    }

                  }
                } catch (saveErr) {
                  glLog(`保存到网盘失败: ${saveErr.message}`);
                }

                // 所有方案失败
                errLinks.push({ name: link.name, error: '大文件直链获取失败 — 可手动保存到网盘后到个人网盘页面获取' });
              } else {
                let hint = link.error || '未知错误';
                if (hint.includes('[-20]')) hint += '\n  → 等待几分钟后重试';
                errLinks.push({ name: link.name, error: hint });
              }
            }
          } catch (linkErr) {
            glLog(`❌ sharedownload 失败: ${linkErr.message}`, 'err');
            errLinks.push({ name: 'sharedownload', error: linkErr.message });
          }
        } else {
          // 个人网盘：直接用 filemetas API
          glLog(`个人网盘模式：filemetas 直接获取直链`);
          try {
            const links = await getBaiduLinks(info.files, info, token.token);
            okLinks = links.filter(l => l.url);
            errLinks.push(...links.filter(l => !l.url));
          } catch (linkErr) {
            glLog(`❌ filemetas 失败: ${linkErr.message}`, 'err');
            errLinks.push({ name: 'filemetas', error: linkErr.message });
          }
        }

        glLog(`token ${ti+1} 结果: ${okLinks.length} 成功, ${errLinks.length} 失败`);

        if (okLinks.length) {
          allLinks.push(...okLinks);
          updateToken(token.id, { status: 'valid', lastUsed: new Date().toISOString() });
          item.className = 'gl-link gl-link-ok';
          item.innerHTML = `<span class="gl-link-status">✅</span><span class="gl-link-name">${esc(token.name)}</span>` +
            okLinks.map(l => `
              <div class="gl-link-url">${esc(l.url)}</div>
              <button class="gl-link-copy" onclick="navigator.clipboard.writeText('${esc(l.url)}')">复制</button>
            `).join('') +
            (errLinks.length ? `<div class="gl-link-err-text">${errLinks.map(l => `⚠️ ${esc(l.name)}: ${esc(l.error)}`).join('\n')}</div>` : '');
        } else {
          lastError = errLinks[0]?.error || '未知错误';
          item.className = 'gl-link gl-link-err';
          item.innerHTML = `<span class="gl-link-status">❌</span><span class="gl-link-name">${esc(token.name)}</span><div class="gl-link-err-text">${esc(lastError)}</div>`;
        }
      } catch (e) {
        lastError = e.message;
        item.className = 'gl-link gl-link-err';
        item.innerHTML = `<span class="gl-link-status">❌</span><span class="gl-link-name">${esc(token.name)}</span><div class="gl-link-err-text">${esc(e.message)}</div>`;
      }

      if (ti < tokensToTry.length - 1) await sleep(3000);
    }

    // 4. 汇总
    if (allLinks.length) {
      const linkStr = allLinks.map(l => l.url).join('\n');
      const fileName = allLinks[0].name;
      const fileSize = allLinks[0].size || 0;

      // 多源 Metalink 生成
      const metalinkXml = `<?xml version="1.0" encoding="UTF-8"?>
<metalink version="4.0" xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="${fileName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}">
    ${fileSize ? `<size>${fileSize}</size>` : ''}
    ${allLinks.map(l => `<url priority="1">${l.url.replace(/&/g,'&amp;')}</url>`).join('\n    ')}
  </file>
</metalink>`;
      glLog(`生成 Metalink: ${allLinks.length} 个源, 文件: ${fileName}`);

      glLog(`获取完成: ${allLinks.length} 个直链，请手动复制到下载器`);

      document.getElementById('gl-copy-all').disabled = false;
      document.getElementById('gl-copy-all').onclick = () => copyText(linkStr);

      // 绑定"清理网盘"按钮事件，直链获取成功后立即显示
      document.getElementById('gl-clean-drive').onclick = () => showCleanDriveUI();
      if (lastSavedFiles.length > 0) {
        const cleanBtn4 = document.getElementById('gl-clean-drive');
        if (cleanBtn4) { cleanBtn4.style.display = 'inline-block'; cleanBtn4.textContent = `清理网盘 (${lastSavedFiles.length} 个文件)`; }
        glLog(`有 ${lastSavedFiles.length} 个文件保存在网盘中，下载完成后可清理`);
      }
    } else {
      throw new Error(`所有 ${tokensToTry.length} 个 token 均获取失败\n\n最后一个错误: ${lastError}`);
    }
  } catch (e) {
    notif(e.message, 'err', 15000);
  } finally {
    isDownloading = false;
    btn.disabled = false; btn.textContent = '获取直链并下载';
  }
}


// ==================== 管理面板 (openManager) ====================
// 全屏 overlay 管理面板，包含 3 个标签页：直链管理、账号管理、日志

// 来源 badge 颜色映射
const SOURCE_BADGE_COLORS = {
  sharedownload: { bg: '#e8f0fe', color: '#306cff' },  // 蓝色
  pan_api: { bg: '#e6f4ea', color: '#137333' },        // 绿色
  filemetas: { bg: '#f3e8fd', color: '#7c3aed' },      // 紫色
  unknown: { bg: '#f1f3f4', color: '#5f6368' },        // 灰色
};

// 直链管理标签页 - 搜索、复制、删除、清空
function renderLinksTab(container) {
  const cache = getLinkCache();

  // 构建链接行 HTML
  let rowsHtml = '';
  if (cache.length === 0) {
    rowsHtml = '<div class="gl-mgr-empty">暂无缓存直链</div>';
  } else {
    for (const link of cache) {
      const badge = SOURCE_BADGE_COLORS[link.source] || SOURCE_BADGE_COLORS.unknown;
      const timeStr = link.createdAt ? new Date(link.createdAt).toLocaleString() : '-';
      rowsHtml += `
        <div class="gl-link-row" data-id="${link.id}" data-name="${esc(link.name).toLowerCase()}" data-source="${link.source}">
          <span class="gl-link-row-name" title="${esc(link.name)}">${esc(link.name)}</span>
          <span class="gl-link-row-size">${formatSize(link.size)}</span>
          <span class="gl-link-row-source" style="background:${badge.bg};color:${badge.color}">${esc(link.source)}</span>
          ${link.tokenName ? '<span class="gl-link-row-source" style="background:#e8f0fe;color:#306cff">' + esc(link.tokenName) + '</span>' : ''}
          <span class="gl-link-row-time">${timeStr}</span>
          <div class="gl-link-row-actions">
            <button class="gl-btn gl-btn-secondary gl-btn-sm gl-mgr-link-copy" data-url="${esc(link.url)}">复制</button>
            ${link.drivePath && link.accessToken ? '<button class="gl-btn gl-btn-danger gl-btn-sm gl-mgr-link-del-file" data-path="' + esc(link.drivePath) + '" data-token="' + esc(link.accessToken) + '" data-id="' + link.id + '">删文件</button>' : ''}
            <button class="gl-btn gl-btn-danger gl-btn-sm gl-mgr-link-del" data-id="${link.id}">删缓存</button>
          </div>
        </div>`;
    }
  }

  // 工具栏 + 链接列表
  container.innerHTML = `
    <div class="gl-mgr-tools">
      <input type="text" class="gl-mgr-link-search" placeholder="搜索文件名或来源...">
      <button class="gl-btn gl-btn-primary gl-btn-sm gl-mgr-copy-all">全部复制</button>
      <button class="gl-btn gl-btn-danger gl-btn-sm gl-mgr-clear-cache">清空缓存</button>
    </div>
    <div class="gl-mgr-link-list">${rowsHtml}</div>`;

  // 搜索过滤
  const searchInput = container.querySelector('.gl-mgr-link-search');
  if (searchInput) {
    searchInput.oninput = function() {
      const keyword = searchInput.value.trim().toLowerCase();
      container.querySelectorAll('.gl-link-row').forEach(function(row) {
        const name = row.getAttribute('data-name') || '';
        const source = row.getAttribute('data-source') || '';
        row.style.display = (!keyword || name.indexOf(keyword) >= 0 || source.indexOf(keyword) >= 0) ? '' : 'none';
      });
    };
  }

  // 全部复制按钮
  const copyAllBtn = container.querySelector('.gl-mgr-copy-all');
  if (copyAllBtn) {
    copyAllBtn.onclick = function() {
      const urls = cache.map(function(l) { return l.url; }).join('\n');
      if (!urls) { notif('没有可复制的直链', 'err'); return; }
      copyText(urls);
    };
  }

  // 清空缓存按钮
  const clearBtn = container.querySelector('.gl-mgr-clear-cache');
  if (clearBtn) {
    clearBtn.onclick = function() {
      if (!confirm('确定清空所有缓存直链？此操作不可撤销。')) return;
      saveLinkCache([]);
      glLog('已清空直链缓存');
      notif('已清空直链缓存', 'ok', 2000);
      renderLinksTab(container);
    };
  }

  // 单个复制按钮
  container.querySelectorAll('.gl-mgr-link-copy').forEach(function(btn) {
    btn.onclick = function() { copyText(btn.getAttribute('data-url')); };
  });

  // 单个删缓存按钮
  container.querySelectorAll('.gl-mgr-link-del').forEach(function(btn) {
    btn.onclick = function() {
      removeLinkFromCache(btn.getAttribute('data-id'));
      renderLinksTab(container);
    };
  });

  // 删网盘文件按钮
  container.querySelectorAll('.gl-mgr-link-del-file').forEach(function(btn) {
    btn.onclick = async function() {
      const filePath = btn.getAttribute('data-path');
      const accessToken = btn.getAttribute('data-token');
      const linkId = btn.getAttribute('data-id');
      if (!confirm('确定从网盘删除 ' + filePath + '？\n此操作不可撤销。')) return;
      try {
        btn.disabled = true; btn.textContent = '删除中...';
        await deleteFilesFromDrive([filePath], accessToken);
        notif('已从网盘删除: ' + filePath, 'ok');
        // 同时删除缓存记录
        removeLinkFromCache(linkId);
        renderLinksTab(container);
      } catch(e) {
        notif('删除失败: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = '删文件';
      }
    };
  });
}

// 账号管理标签页 - 账号卡片、编辑、删除、健康检测、导入导出
function renderAccountsTab(container) {
  const pool = getTokenPool();
  const healthLabel = { ok: '正常', banned: '封禁', expired: '过期', unknown: '未知' };

  // 构建账号卡片 HTML
  let cardsHtml = '';
  if (pool.length === 0) {
    cardsHtml = '<div class="gl-mgr-empty">暂无账号，请点击"添加账号"开始</div>';
  } else {
    for (const t of pool) {
      const h = t.health || 'unknown';
      const hDisplay = (h === 'ok' && (t.bdussStatus === 'invalid' || t.bdussStatus === 'mismatch')) ? '异常' : (healthLabel[h] || '未知');
      const hCls = (h === 'ok' && (t.bdussStatus === 'invalid' || t.bdussStatus === 'mismatch')) ? 'gl-health-expired' : ('gl-health-' + h);
      const addedStr = t.addedAt ? new Date(t.addedAt).toLocaleString() : '-';
      const bdussStatus = t.bduss
        ? '<span class="gl-token-status valid">已配置</span>'
        : '<span class="gl-token-status unknown">未配置</span>';
      let oauthStatus = '<span class="gl-token-status unknown">未知</span>';
      if (t.status === 'valid') oauthStatus = '<span class="gl-token-status valid">有效</span>';
      else if (t.status === 'expired') oauthStatus = '<span class="gl-token-status expired">过期</span>';

      cardsHtml += `
        <div class="gl-token-card" data-id="${t.id}">
          <div class="gl-token-main">
            <div class="gl-token-header">
              <span class="gl-token-card-name">${esc(t.name)}</span>
              <span class="gl-health-badge ${hCls}">${hDisplay}</span>
            </div>
            <div class="gl-token-meta">
              <div>Token: ${esc(t.token.slice(0, 16))}...</div>
              <div>BDUSS: ${bdussStatus} ${t.bdussStatus === 'valid' ? '<span class="gl-health-badge gl-health-ok">BDUSS OK</span>' : t.bdussStatus === 'invalid' ? '<span class="gl-health-badge gl-health-banned">BDUSS 无效</span>' : t.bdussStatus === 'mismatch' ? '<span class="gl-health-badge gl-health-expired">BDUSS 不匹配</span>' : ''}</div>
              <div>OAuth: ${oauthStatus}</div>
              <div>添加时间: ${addedStr}</div>
            </div>
            <div class="gl-token-actions">
              <span class="gl-token-info gl-mgr-acc-info" data-id="${t.id}" title="查看账号信息">信息</span>
              <span class="gl-token-edit gl-mgr-acc-edit" data-id="${t.id}" title="编辑">编辑</span>
              <span class="gl-token-run gl-mgr-acc-health" data-id="${t.id}" title="单个健康检测">检测</span>
              <span class="gl-token-run gl-mgr-acc-files" data-id="${t.id}" data-token="${esc(t.token)}" title="查看网盘文件">文件</span>
              <span class="gl-token-del gl-mgr-acc-del" data-id="${t.id}" title="删除">删除</span>
            </div>
          </div>
        </div>
        <div class="gl-edit-area gl-mgr-edit-area" data-edit-id="${t.id}" style="display:none"></div>
        <div class="gl-edit-area gl-mgr-files-area" data-files-id="${t.id}" style="display:none"></div>`;
    }
  }

  container.innerHTML = `
    <div class="gl-mgr-tools">
      <button class="gl-btn gl-btn-primary gl-btn-sm gl-mgr-add-account">+ 添加账号</button>
      <button class="gl-btn gl-btn-secondary gl-btn-sm gl-mgr-export-accounts">导出</button>
      <label class="gl-btn gl-btn-secondary gl-btn-sm" style="cursor:pointer;margin:0">
        导入<input type="file" class="gl-mgr-import-accounts" accept=".json" style="display:none">
      </label>
      <button class="gl-btn gl-btn-secondary gl-btn-sm gl-mgr-health-all">全部健康检测</button>
    </div>
    <div class="gl-mgr-account-list">${cardsHtml}</div>`;

  // 添加账号按钮（关闭管理面板，打开主面板的添加区域）
  const addBtn = container.querySelector('.gl-mgr-add-account');
  if (addBtn) {
    addBtn.onclick = function() {
      const overlay = document.getElementById('gl-mgr-overlay');
      if (overlay) overlay.remove();
      if (!panel) createPanel();
      doAddToken();
    };
  }

  // 导出按钮
  const exportBtn = container.querySelector('.gl-mgr-export-accounts');
  if (exportBtn) { exportBtn.onclick = function() { doExport(); }; }

  // 导入按钮
  const importInput = container.querySelector('.gl-mgr-import-accounts');
  if (importInput) {
    importInput.onchange = function(e) {
      doImport(e);
      renderAccountsTab(container);
    };
  }

  // 全部健康检测
  const healthAllBtn = container.querySelector('.gl-mgr-health-all');
  if (healthAllBtn) {
    healthAllBtn.onclick = async function() {
      await doHealthCheck();
      renderAccountsTab(container);
    };
  }

  // 编辑按钮
  container.querySelectorAll('.gl-mgr-acc-edit').forEach(function(el) {
    el.onclick = function() {
      const id = el.getAttribute('data-id');
      const editArea = container.querySelector('.gl-mgr-edit-area[data-edit-id="' + id + '"]');
      if (!editArea) return;
      if (editArea.style.display !== 'none') { editArea.style.display = 'none'; return; }
      const t = getTokenPool().find(function(tp) { return tp.id === id; });
      if (!t) return;
      editArea.innerHTML = `
        <div class="gl-edit-form">
          <div class="gl-edit-row"><label>名称</label><input class="gl-ed-name" value="${esc(t.name)}"></div>
          <div class="gl-edit-row"><label>OAuth Token</label><input class="gl-ed-token" value="${esc(t.token)}"></div>
          <div class="gl-edit-row"><label>BDUSS</label><input class="gl-ed-bduss" value="${esc(t.bduss || '')}" placeholder="留空表示无 BDUSS"></div>
          <div style="display:flex;gap:6px">
            <button class="gl-btn gl-btn-primary gl-btn-sm gl-mgr-ed-save" data-id="${id}">保存</button>
            <button class="gl-btn gl-btn-secondary gl-btn-sm gl-mgr-ed-cancel" data-id="${id}">取消</button>
          </div>
        </div>`;
      editArea.style.display = 'block';
      editArea.querySelector('.gl-mgr-ed-cancel').onclick = function() { editArea.style.display = 'none'; };
      editArea.querySelector('.gl-mgr-ed-save').onclick = function() {
        const newName = editArea.querySelector('.gl-ed-name').value.trim();
        const newToken = editArea.querySelector('.gl-ed-token').value.trim();
        const newBduss = editArea.querySelector('.gl-ed-bduss').value.trim();
        if (!newToken) { notif('OAuth Token 不能为空', 'err'); return; }
        const changes = {};
        if (newName && newName !== t.name) changes.name = newName;
        if (newToken !== t.token) { changes.token = newToken; changes.status = 'unknown'; }
        if (newBduss !== (t.bduss || '')) changes.bduss = newBduss;
        if (Object.keys(changes).length > 0) {
          updateToken(id, changes);
          notif('已保存', 'ok', 2000);
        }
        renderAccountsTab(container);
      };
    };
  });

  // 删除按钮
  container.querySelectorAll('.gl-mgr-acc-del').forEach(function(el) {
    el.onclick = function() {
      if (!confirm('确定删除此账号？')) return;
      removeToken(el.getAttribute('data-id'));
      notif('已删除', 'info', 2000);
      renderAccountsTab(container);
    };
  });

  // 单个健康检测（与 doHealthCheck 同逻辑：uinfo + filemetas + BDUSS）
  container.querySelectorAll('.gl-mgr-acc-health').forEach(function(el) {
    el.onclick = async function() {
      const id = el.getAttribute('data-id');
      const t = getTokenPool().find(function(tp) { return tp.id === id; });
      if (!t) return;
      notif('正在检测 ' + t.name + '...', 'info', 5000);
      try {
        // uinfo 验活
        const uinfo = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=' + t.token, 'GET', {}, undefined, true);
        if (!uinfo?.errno && !uinfo?.uk) {
          updateToken(t.id, { status: 'expired', health: 'expired' });
          glLog('健康检测 ' + t.name + ': Token 过期', 'err');
          renderAccountsTab(container);
          return;
        }
        updateToken(t.id, { status: 'valid', lastUsed: new Date().toISOString() });
        // BDUSS 检查
        if (t.bduss) {
          try {
            const buinfo = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo', 'GET', {'Cookie': 'BDUSS=' + t.bduss}, undefined, true);
            if (buinfo?.uk && buinfo.uk !== 0) {
              const bdussOk = (String(buinfo.uk) === String(uinfo.uk));
              updateToken(t.id, { bdussStatus: bdussOk ? 'valid' : 'mismatch' });
            } else {
              updateToken(t.id, { bdussStatus: 'invalid' });
            }
          } catch(e) { updateToken(t.id, { bdussStatus: 'unknown' }); }
        }
        // filemetas 试探
        const probeFsId = '99999999999999999';
        const res = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=' + encodeURIComponent(JSON.stringify([probeFsId])) + '&access_token=' + t.token, 'GET', {'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/'}, undefined, true);
        const errno = res && res.errno;
        if (errno === 0 || errno === -6 || errno === 2) {
          updateToken(t.id, { health: 'ok' });
          glLog('健康检测 ' + t.name + ': 正常');
        } else if (errno === 9013) {
          updateToken(t.id, { health: 'banned' });
          glLog('健康检测 ' + t.name + ': 被封禁 (9013)', 'err');
        } else if (errno === 9019) {
          updateToken(t.id, { health: 'expired' });
          glLog('健康检测 ' + t.name + ': 过期 (9019)', 'err');
        } else {
          updateToken(t.id, { health: 'unknown' });
          glLog('健康检测 ' + t.name + ': 未知 errno=' + errno);
        }
      } catch (e) {
        updateToken(t.id, { health: 'unknown' });
        glLog('健康检测 ' + t.name + ' 失败: ' + e.message, 'err');
      }
      renderAccountsTab(container);
    };
  });

  // 查看账号信息
  container.querySelectorAll('.gl-mgr-acc-info').forEach(function(el) {
    el.onclick = async function() {
      const id = el.getAttribute('data-id');
      const editArea = container.querySelector('.gl-mgr-edit-area[data-edit-id="' + id + '"]');
      if (!editArea) return;
      if (editArea.style.display !== 'none') { editArea.style.display = 'none'; return; }
      const t = getTokenPool().find(function(tp) { return tp.id === id; });
      if (!t) return;
      editArea.innerHTML = '<div class="gl-edit-form">查询中...</div>';
      editArea.style.display = 'block';
      try {
        const res = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=' + t.token, 'GET', {});
        const info = (res && (res.errno === 0 || res.uk))
          ? '<b>' + esc(res.baidu_name || '未知') + '</b> (uk=' + res.uk + ')<br>VIP类型: ' + (res.vip_type === 0 ? '普通' : 'VIP') + '<br>已用: ' + formatSize(res.used) + ' / 总: ' + formatSize(res.total)
          : 'OAuth 无效 (errno=' + (res && res.errno) + ')';
        editArea.innerHTML = '<div class="gl-edit-form">' + info + '<br><span style="font-size:10px;color:#80868b">Token: ' + esc(t.token.slice(0, 20)) + '...<br>BDUSS: ' + (t.bduss ? esc(t.bduss.slice(0, 20)) + '...' : '无') + '</span></div>';
      } catch (e) {
        editArea.innerHTML = '<div class="gl-edit-form" style="color:#d93025">查询失败: ' + esc(e.message) + '</div>';
      }
    };
  });

  // 网盘文件按钮
  container.querySelectorAll('.gl-mgr-acc-files').forEach(function(el) {
    el.onclick = async function() {
      const id = el.getAttribute('data-id');
      const accessToken = el.getAttribute('data-token');
      const filesArea = container.querySelector('.gl-mgr-files-area[data-files-id="' + id + '"]');
      if (!filesArea) return;
      if (filesArea.style.display !== 'none') { filesArea.style.display = 'none'; return; }
      filesArea.innerHTML = '<div class="gl-edit-form">加载中...</div>';
      filesArea.style.display = 'block';
      try {
        const res = await gmFetch('https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=' + encodeURIComponent('/') + '&access_token=' + accessToken + '&order=time&desc=1&page=1&num=50', 'GET', {'Origin': 'https://pan.baidu.com', 'Referer': 'https://pan.baidu.com/'}, undefined, true);
        if (res?.list && res.list.length > 0) {
          let html = '<div class="gl-edit-form"><b>根目录文件 (' + res.list.length + ')</b><div style="margin-top:8px">';
          for (const f of res.list) {
            const isDir = f.isdir === 1;
            html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #eee">' +
              '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (isDir ? '📁' : '📄') + ' ' + esc(f.server_filename) + '</span>' +
              '<span style="font-size:11px;color:#80868b;flex-shrink:0">' + (isDir ? '' : formatSize(f.size)) + '</span>' +
              (isDir ? '' : '<button class="gl-btn gl-btn-danger gl-btn-sm gl-mgr-del-file" data-path="' + esc(f.path) + '" data-token="' + accessToken + '" data-area-id="' + id + '">删除</button>') +
              '</div>';
          }
          html += '</div></div>';
          filesArea.innerHTML = html;
          // 删除文件按钮事件
          filesArea.querySelectorAll('.gl-mgr-del-file').forEach(function(btn) {
            btn.onclick = async function() {
              const filePath = btn.getAttribute('data-path');
              const tk = btn.getAttribute('data-token');
              const areaId = btn.getAttribute('data-area-id');
              if (!confirm('确定删除 ' + filePath + '？')) return;
              try {
                await deleteFilesFromDrive([filePath], tk);
                notif('已删除: ' + filePath, 'ok');
                // 重新加载文件列表
                const area = container.querySelector('.gl-mgr-files-area[data-files-id="' + areaId + '"]');
                if (area) { area.style.display = 'none'; }
                el.click(); // 触发重新加载
              } catch(e) {
                notif('删除失败: ' + e.message, 'err');
              }
            };
          });
        } else {
          filesArea.innerHTML = '<div class="gl-edit-form">根目录为空</div>';
        }
      } catch(e) {
        filesArea.innerHTML = '<div class="gl-edit-form" style="color:#d93025">加载失败: ' + esc(e.message) + '</div>';
      }
    };
  });
}

// 日志标签页 - 显示全部日志、复制、导出、清空
function renderLogsTab(container) {
  // 构建日志行 HTML
  let logHtml = '';
  if (LOGS.length === 0) {
    logHtml = '<div class="gl-mgr-empty">暂无日志</div>';
  } else {
    for (const l of LOGS) {
      const levelBadge = l.level === 'err'
        ? '<span style="background:#fce8e6;color:#d93025;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-right:4px">ERR</span>'
        : '<span style="background:#e8f0fe;color:#306cff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-right:4px">INFO</span>';
      logHtml += '<div style="padding:2px 0"><span style="color:#80868b;margin-right:6px">[' + esc(l.time) + ']</span>' + levelBadge + esc(l.msg) + '</div>';
    }
  }

  container.innerHTML = `
    <div class="gl-mgr-tools">
      <button class="gl-btn gl-btn-primary gl-btn-sm gl-mgr-log-copy">复制日志</button>
      <button class="gl-btn gl-btn-secondary gl-btn-sm gl-mgr-log-export">导出日志</button>
      <button class="gl-btn gl-btn-danger gl-btn-sm gl-mgr-log-clear">清空日志</button>
    </div>
    <div class="gl-mgr-log-area" style="background:#f8f9fa;border-radius:8px;padding:12px;font-size:12px;font-family:Consolas,Monaco,monospace;max-height:calc(85vh - 200px);overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.6">
      ${logHtml}
    </div>`;

  // 自动滚动到底部
  const logArea = container.querySelector('.gl-mgr-log-area');
  if (logArea) logArea.scrollTop = logArea.scrollHeight;

  // 复制日志
  const copyBtn = container.querySelector('.gl-mgr-log-copy');
  if (copyBtn) {
    copyBtn.onclick = function() {
      const text = LOGS.map(function(l) { return '[' + l.time + '] [' + l.level + '] ' + l.msg; }).join('\n');
      copyText(text || '暂无日志');
    };
  }

  // 导出日志
  const exportBtn = container.querySelector('.gl-mgr-log-export');
  if (exportBtn) {
    exportBtn.onclick = function() {
      const text = LOGS.map(function(l) { return '[' + l.time + '] [' + l.level + '] ' + l.msg; }).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'goodlink_log_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
      a.click();
    };
  }

  // 清空日志
  const clearBtn = container.querySelector('.gl-mgr-log-clear');
  if (clearBtn) {
    clearBtn.onclick = function() {
      if (!confirm('确定清空所有日志？')) return;
      LOGS.length = 0;
      GM_setValue('gl_logs', []);
      glLog('日志已清空');
      renderLogsTab(container);
      notif('日志已清空', 'ok', 2000);
    };
  }
}

// 根据 tab 名称渲染对应内容
function renderTabContent(tabName, section) {
  if (!section) return;
  switch (tabName) {
    case 'links': renderLinksTab(section); break;
    case 'accounts': renderAccountsTab(section); break;
    case 'logs': renderLogsTab(section); break;
  }
}

// 主函数：打开/关闭管理面板
function openManager() {
  // 切换：如果 overlay 已存在则移除（关闭）
  const existing = document.getElementById('gl-mgr-overlay');
  if (existing) { existing.remove(); return; }

  // 创建 overlay 容器
  const overlay = document.createElement('div');
  overlay.id = 'gl-mgr-overlay';

  // 创建 panel
  const mgrPanel = document.createElement('div');
  mgrPanel.id = 'gl-mgr-panel';
  mgrPanel.innerHTML = `
    <div class="gl-mgr-header">
      <h2>GoodLink 管理面板</h2>
      <span class="gl-mgr-close" id="gl-mgr-close-btn">&times;</span>
    </div>
    <div class="gl-mgr-tabs">
      <div class="gl-mgr-tab active" data-tab="links">直链管理</div>
      <div class="gl-mgr-tab" data-tab="accounts">账号管理</div>
      <div class="gl-mgr-tab" data-tab="logs">日志</div>
    </div>
    <div class="gl-mgr-body">
      <div class="gl-mgr-section active" data-section="links"></div>
      <div class="gl-mgr-section" data-section="accounts"></div>
      <div class="gl-mgr-section" data-section="logs"></div>
    </div>`;

  overlay.appendChild(mgrPanel);
  document.body.appendChild(overlay);

  // 关闭按钮
  document.getElementById('gl-mgr-close-btn').onclick = function() { overlay.remove(); };

  // 点击 overlay 背景关闭
  overlay.onclick = function(e) {
    if (e.target === overlay) overlay.remove();
  };

  // Tab 切换逻辑
  const tabs = mgrPanel.querySelectorAll('.gl-mgr-tab');
  const sections = mgrPanel.querySelectorAll('.gl-mgr-section');

  tabs.forEach(function(tab) {
    tab.onclick = function() {
      // 移除所有 active
      tabs.forEach(function(t) { t.classList.remove('active'); });
      sections.forEach(function(s) { s.classList.remove('active'); });
      // 激活当前 tab 和对应 section
      tab.classList.add('active');
      const targetSection = mgrPanel.querySelector('.gl-mgr-section[data-section="' + tab.getAttribute('data-tab') + '"]');
      if (targetSection) targetSection.classList.add('active');
      // 渲染对应标签页内容
      renderTabContent(tab.getAttribute('data-tab'), targetSection);
    };
  });

  // 渲染默认标签页（直链管理）
  const defaultSection = mgrPanel.querySelector('.gl-mgr-section[data-section="links"]');
  if (defaultSection) renderLinksTab(defaultSection);
}

// 暴露到全局作用域，供主面板按钮通过 typeof openManager 检测
window.openManager = openManager;

// ==================== 初始化 ====================
function init() {
  injectStyles();

  const btn = document.createElement('button');
  btn.id = 'gl-btn';
  const pool = getTokenPool();
  btn.innerHTML = pool.length > 0
    ? `⚡ GoodLink (${pool.length} token)`
    : `⚡ GoodLink`;
  btn.onclick = () => {
    try { createPanel(); } catch (e) {
      glLog(`面板创建失败: ${e.message}`, 'err');
      notif(`面板创建失败: ${e.message}`, 'err', 10000);
    }
  };
  document.body.appendChild(btn);

  GM_registerMenuCommand('打开 GoodLink 面板', createPanel);
  glLog(`脚本已加载: ${location.hostname}`);
}

// 确保 init 在 DOM 就绪后执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
