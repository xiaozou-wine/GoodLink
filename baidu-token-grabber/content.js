/**
 * GoodLink Content Script
 *
 * pan.baidu.com      → 关广告弹窗（不动登录面板）→ 自动点登录 → 轮询检测登录 → 跳 OAuth
 * openapi.baidu.com   → 捕获 access_token
 */
(function() {
  'use strict';

  var host = location.hostname;

  if (host === 'openapi.baidu.com') {
    handleOAuth();
  } else if (host === 'pan.baidu.com' || host === 'yun.baidu.com') {
    handlePan();
  }

  // ==================== OAuth Token 捕获 ====================
  function handleOAuth() {
    if (!tryCapture()) {
      var last = location.href;
      var obs = new MutationObserver(function() {
        if (location.href !== last) { last = location.href; tryCapture(); }
      });
      obs.observe(document, { subtree: true, childList: true });
      document.addEventListener('DOMContentLoaded', function() { tryCapture(); obs.disconnect(); });
    }
  }

  function tryCapture() {
    var frag = location.href.split('#')[1] || '';
    var qs = (location.href.split('?')[1] || '').split('#')[0];
    var str = frag || qs;
    if (!str) return false;
    var p = new URLSearchParams(str);
    var tok = p.get('access_token');
    if (!tok) return false;
    console.log('[GoodLink] Token 捕获成功:', tok.slice(0, 20) + '...');
    send({ type: 'GL_TOKEN_CAPTURED', token: { access_token: tok, expires_in: p.get('expires_in') || '', scope: p.get('scope') || '', refresh_token: p.get('refresh_token') || '' } });
    return true;
  }

  // ==================== pan.baidu.com 处理 ====================
  function handlePan() {
    console.log('[GoodLink] pan.baidu.com 加载');

    onReady(function() {
      // 第一步：只关广告/引导弹窗，不动登录面板
      dismissAdsOnly();

      // 第二步：如果页面上有「去登录」按钮，点它打开登录面板
      var clickDone = false;
      var clickTimer = setInterval(function() {
        if (clickDone) { clearInterval(clickTimer); return; }

        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length > 2) continue;
          var txt = el.textContent.trim();
          if (txt !== '去登录' && txt !== '立即登录') continue;
          if (!isVisible(el)) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width < 30 || rect.width > 300 || rect.height < 14 || rect.height > 80) continue;

          console.log('[GoodLink] ✅ 点击:', txt);
          el.click();
          clickDone = true;
          clearInterval(clickTimer);

          // 点击后 3 秒如果没跳转，直接导航到 passport
          setTimeout(function() {
            if (location.hostname === 'pan.baidu.com' || location.hostname === 'yun.baidu.com') {
              console.log('[GoodLink] 未跳转，直接导航到 passport');
              location.href = 'https://passport.baidu.com/v2/?login&u=https://pan.baidu.com/';
            }
          }, 3000);
          return;
        }
      }, 1000);

      // 第三步：轮询登录状态（不管是扫码还是密码，登录成功后 API 都会返回 errno=0）
      pollLogin();
    });
  }

  /**
   * 轮询检测登录状态。
   * 每 2 秒用 uinfo API 检查，登录成功后自动跳 OAuth。
   */
  function pollLogin() {
    var tries = 0;
    var MAX = 150; // 5 分钟

    var timer = setInterval(function() {
      tries++;
      if (tries > MAX) { clearInterval(timer); console.log('[GoodLink] 检测超时'); return; }

      checkLogin().then(function(ok) {
        if (ok) {
          clearInterval(timer);
          console.log('[GoodLink] ✅ 登录成功！通知 background 跳转 OAuth...');
          send({ type: 'GL_LOGIN_STATUS', status: 'logged_in' });
          // 不用 location.href（会带 Referer 导致百度报错）
          // 让 background 用 tabs.update 导航（不带 Referer）
          send({ type: 'GL_FORCE_OAUTH' });
        } else if (tries % 10 === 0) {
          console.log('[GoodLink] 等待登录... ' + tries + '/' + MAX);
        }
      });
    }, 2000);
  }

  /**
   * 用 uinfo API 检测登录状态。
   * fetch 从页面上下文发出，自动携带 Cookie。
   */
  async function checkLogin() {
    try {
      var resp = await fetch('https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo', {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!resp.ok) return false;
      var data = await resp.json();
      return data.errno === 0;
    } catch (e) {
      return false;
    }
  }

  // ==================== 工具 ====================
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function isVisible(el) {
    if (!el || el.offsetParent === null) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  /**
   * 只关广告/引导弹窗，不关登录面板。
   * 排除包含「登录」「扫码」「手机号」「密码」文字的弹窗。
   */
  function dismissAdsOnly() {
    // 关两次就够了
    doDismiss();
    setTimeout(doDismiss, 2000);

    function doDismiss() {
      // 按选择器找关闭按钮
      var sels = ['.activity-close', '.guide-close', '[class*="activity"] [class*="close"]', '[class*="guide"] [class*="close"]'];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && isVisible(el)) el.click();
      }

      // 按文本找「我知道了」「关闭」等按钮，但排除登录相关的弹窗
      var closeTexts = ['我知道了', '知道了', '以后再说'];
      var btns = document.querySelectorAll('button, a, span, div');
      for (var j = 0; j < btns.length; j++) {
        var t = btns[j].textContent.trim();
        if (closeTexts.indexOf(t) === -1) continue;
        if (!isVisible(btns[j])) continue;
        var r = btns[j].getBoundingClientRect();
        if (r.width < 30 || r.width > 200 || r.height < 14 || r.height > 60) continue;

        // 安全检查：如果这个按钮的父容器包含登录相关文字，跳过
        var parent = btns[j].closest('[class*="dialog"], [class*="modal"], [class*="popup"]');
        if (parent) {
          var ptxt = parent.textContent;
          if (ptxt.indexOf('登录') !== -1 || ptxt.indexOf('扫码') !== -1 ||
              ptxt.indexOf('手机号') !== -1 || ptxt.indexOf('密码') !== -1 ||
              ptxt.indexOf('二维码') !== -1) {
            continue; // 这是登录弹窗，不关
          }
        }
        console.log('[GoodLink] 关闭广告弹窗:', t);
        btns[j].click();
      }
    }
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {
      setTimeout(function() { try { chrome.runtime.sendMessage(msg); } catch (_) {} }, 500);
    }
  }
})();
