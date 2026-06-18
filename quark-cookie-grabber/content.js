/**
 * GoodLink 夸克 Cookie 抓取器 — Content Script
 *
 * 仅在无痕模式下工作。普通浏览器窗口直接跳过。
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[GoodLink Quark]';
  function log(msg) { console.log(LOG_PREFIX + ' ' + msg); }

  // 避免在非目标页面运行
  if (!location.hostname.includes('quark.cn')) return;

  // ★ 核心：非无痕模式直接退出，不做任何事
  if (!chrome.extension.inIncognitoContext) {
    log('普通浏览器窗口，跳过');
    return;
  }

  log('无痕模式已注入: ' + location.href);

  // ==================== 登录检测 ====================

  /**
   * 方法 1: 调用夸克 API 检测登录
   * 最可靠 — 不依赖页面 DOM 结构
   */
  async function checkLoginViaAPI() {
    try {
      var resp = await fetch('https://drive-pc.quark.cn/1/clouddrive/account/info?pr=ucpro&fr=pc', {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!resp.ok) return { loggedIn: false, nickname: '' };
      var data = await resp.json();
      if (data.code === 0 && data.data) {
        return {
          loggedIn: true,
          nickname: data.data.nickname || data.data.account || ''
        };
      }
      return { loggedIn: false, nickname: '' };
    } catch (e) {
      return { loggedIn: false, nickname: '' };
    }
  }

  /**
   * 方法 2: 检查页面 DOM 判断登录状态
   * 降级方案 — 依赖页面结构
   */
  function checkLoginViaDOM() {
    // 夸克登录后，页面上会有头像/用户名元素
    var indicators = [
      '[class*="avatar"]',
      '[class*="nick"]',
      '[class*="user-info"]',
      '[class*="username"]',
      '.header-user'
    ];
    for (var i = 0; i < indicators.length; i++) {
      var el = document.querySelector(indicators[i]);
      if (el && el.offsetParent !== null) {
        return { loggedIn: true, nickname: el.textContent.trim().slice(0, 20) };
      }
    }
    // 检查是否有文件列表（登录后才有）
    var fileList = document.querySelector('[class*="file-list"], [class*="filelist"]');
    if (fileList) {
      return { loggedIn: true, nickname: '' };
    }
    return { loggedIn: false, nickname: '' };
  }

  /**
   * 综合检测：API 优先，DOM 降级
   */
  async function detectLogin() {
    var apiResult = await checkLoginViaAPI();
    if (apiResult.loggedIn) return apiResult;

    var domResult = checkLoginViaDOM();
    return domResult;
  }

  // ==================== 轮询登录状态 ====================

  var pollTimer = null;
  var pollCount = 0;
  var MAX_POLLS = 120; // 4 分钟 (120 × 2s)
  var loginDetected = false;

  function startPolling() {
    if (pollTimer) return; // 避免重复启动

    log('开始轮询登录状态...');
    pollTimer = setInterval(async function() {
      pollCount++;

      if (pollCount > MAX_POLLS) {
        log('轮询超时（' + MAX_POLLS * 2 + ' 秒），停止');
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }

      var result = await detectLogin();
      if (result.loggedIn && !loginDetected) {
        loginDetected = true;
        clearInterval(pollTimer);
        pollTimer = null;
        log('✅ 登录成功！nickname: ' + result.nickname);

        // 通知 background
        send({
          type: 'GL_QUARK_LOGIN_DETECTED',
          nickname: result.nickname
        });
      } else if (pollCount % 15 === 0) {
        log('等待登录... ' + pollCount + '/' + MAX_POLLS);
      }
    }, 2000);
  }

  // ==================== 页面 URL 变化监听 ====================
  // 夸克是 SPA，URL 可能通过 history.pushState 变化

  var lastUrl = location.href;

  function onUrlChange() {
    var currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      log('URL 变化: ' + lastUrl.slice(0, 50) + ' → ' + currentUrl.slice(0, 50));
      lastUrl = currentUrl;

      // 如果从登录页回到主页，可能是登录成功
      if (currentUrl.includes('pan.quark.cn') && !currentUrl.includes('login')) {
        setTimeout(async function() {
          var result = await detectLogin();
          if (result.loggedIn && !loginDetected) {
            loginDetected = true;
            log('✅ URL 变化检测到登录成功');
            send({ type: 'GL_QUARK_LOGIN_DETECTED', nickname: result.nickname });
          }
        }, 1500);
      }
    }
  }

  // 监听 popstate（浏览器前进/后退）
  window.addEventListener('popstate', onUrlChange);

  // 监听 pushState/replaceState（SPA 路由跳转）
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function() {
    origPush.apply(this, arguments);
    setTimeout(onUrlChange, 100);
  };
  history.replaceState = function() {
    origReplace.apply(this, arguments);
    setTimeout(onUrlChange, 100);
  };

  // ==================== 初始化 ====================

  function init() {
    log('初始化');

    // 如果当前已经在 pan.quark.cn 且不是登录页，可能已经登录了
    if (location.hostname.includes('pan.quark.cn') && !location.href.includes('login')) {
      setTimeout(async function() {
        var result = await detectLogin();
        if (result.loggedIn) {
          log('页面已登录（刷新/重进），nickname: ' + result.nickname);
          // 不自动通知 background（可能是用户刷新页面），只在 popup 请求时返回
          // 但如果 background 状态是 capturing，则通知
          try {
            chrome.storage.local.get('gl_state', function(data) {
              if (data.gl_state === 'capturing' && !loginDetected) {
                loginDetected = true;
                send({ type: 'GL_QUARK_LOGIN_DETECTED', nickname: result.nickname });
              }
            });
          } catch (e) {}
        } else {
          // 还没登录，开始轮询
          startPolling();
        }
      }, 2000);
    } else {
      // 在登录页或其他页面，开始轮询
      startPolling();
    }
  }

  // ==================== 工具函数 ====================

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      setTimeout(function() {
        try { chrome.runtime.sendMessage(msg); } catch (_) {}
      }, 500);
    }
  }

  // DOM ready 后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
