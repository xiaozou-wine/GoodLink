(function() {
  'use strict';

  function getSelectedFilesFromPage() {
    var files = [];
    var diag = [];
    function pushDiag(msg) { diag.push(String(msg)); }

    try {
      var selectors = ['.file-list', '[class*="file-list"]', '[class*="filelist"]', '[class*="FileList"]', '[class*="file_list"]'];
      var candidates = [];
      selectors.forEach(function(sel) {
        var found = document.querySelectorAll(sel);
        if (found.length) {
          pushDiag(sel + ' → ' + found.length);
          candidates.push.apply(candidates, Array.prototype.slice.call(found));
        }
      });
      candidates = Array.prototype.slice.call(new Set(candidates));

      if (!candidates.length) {
        var divs = document.querySelectorAll('div');
        for (var d = 0; d < divs.length; d++) {
          var div = divs[d];
          var fk = Object.keys(div).find(function(k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
          if (!fk) continue;
          var fiber = div[fk] && div[fk].return;
          var steps = 0;
          while (fiber && steps < 12) {
            steps++;
            if (typeof fiber.type === 'string') { fiber = fiber.return; continue; }
            var props = (fiber.stateNode && fiber.stateNode.props) || fiber.memoizedProps || {};
            if (props.list && Array.isArray(props.list) && props.list.length) {
              candidates.push(div);
              pushDiag('扫描到 React list[' + props.list.length + ']');
              break;
            }
            fiber = fiber.return;
          }
          if (candidates.length) break;
        }
      }

      for (var i = 0; i < candidates.length && !files.length; i++) {
        var el = candidates[i];
        var fiberKey = Object.keys(el).find(function(k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
        if (!fiberKey) continue;
        var compFiber = el[fiberKey] && el[fiberKey].return;
        var upSteps = 0;
        while (compFiber && upSteps < 30) {
          upSteps++;
          if (typeof compFiber.type === 'string') { compFiber = compFiber.return; continue; }
          var props2 = (compFiber.stateNode && compFiber.stateNode.props) || compFiber.memoizedProps || {};
          if (props2.list && Array.isArray(props2.list)) {
            var selectedKeys = props2.selectedRowKeys || props2.selectedKeys || [];
            var stoken = props2.stoken || '';
            pushDiag('React list[' + props2.list.length + '] selected=' + selectedKeys.length + ' stoken=' + (stoken ? 'yes' : 'no'));
            props2.list.forEach(function(item) {
              var fid = item.fid || item.file_id;
              if (!fid) return;
              if (selectedKeys.length && selectedKeys.indexOf(fid) < 0) return;
              files.push({
                fid: fid,
                name: item.file_name || item.name || '未命名',
                size: item.size || 0,
                isFile: item.file !== false,
                share_fid_token: item.share_fid_token || '',
                stoken: stoken,
              });
            });
            if (files.length) break;
          }
          compFiber = compFiber.return;
        }
      }
    } catch (e) {
      pushDiag('React 提取异常: ' + e.message);
    }

    if (!files.length) pushDiag('未找到 React 选中文件');
    return { files: files, diag: diag };
  }

  function extractLinkHost(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  function collectUrlLikeValues(value, out) {
    out = out || [];
    if (typeof value === 'string') {
      var text = value.trim();
      if (/^https?:\/\//i.test(text)) {
        try { out.push(new URL(text).toString()); } catch (e) {}
      }
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach(function(item) { collectUrlLikeValues(item, out); });
      return out;
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(function(key) { collectUrlLikeValues(value[key], out); });
    }
    return Array.from(new Set(out));
  }

  function isLikelyDownloadHost(host) {
    if (!host || !/\.drive\.quark\.cn$/i.test(host)) return false;
    if (/thumb/i.test(host)) return false;
    return /(^|\.)dl-/.test(host) || /(^|\.)c-[^.]+-u\.drive\.quark\.cn$/i.test(host);
  }

  function collectUrlLikeEntries(value) {
    var urls = collectUrlLikeValues(value);
    var entries = [];
    var seen = new Set();
    urls.forEach(function(url) {
      var host = extractLinkHost(url);
      if (!host || seen.has(host) || !isLikelyDownloadHost(host)) return;
      seen.add(host);
      entries.push({ host: host, urls: urls.filter(function(item) { return extractLinkHost(item) === host; }) });
    });
    return entries;
  }

  function mapDownloadEntry(item) {
    var rawUrls = collectUrlLikeValues(item);
    var downloadEntries = collectUrlLikeEntries(item);
    var urlsByHost = {};
    downloadEntries.forEach(function(entry) { urlsByHost[entry.host] = entry.urls; });
    return {
      name: item.file_name || item.name || 'download.bin',
      size: item.size || 0,
      url: item.download_url,
      fid: item.fid,
      host: extractLinkHost(item.download_url),
      rawUrls: rawUrls,
      rawHosts: Array.from(new Set(rawUrls.map(extractLinkHost).filter(Boolean))),
      downloadHosts: downloadEntries.map(function(entry) { return entry.host; }),
      urlsByHost: urlsByHost
    };
  }

  async function fetchDirectLinksInPage(payload) {
    var files = (payload.files || []).filter(function(item) { return item && item.isFile !== false && item.fid; });
    if (!files.length) throw new Error('页面世界未收到可下载文件，请重新选中文件。');

    var body;
    if (payload.isSharePage) {
      if (!payload.pwdId) throw new Error('未识别分享 ID，请确认当前是夸克分享页。');
      if (!payload.stoken) throw new Error('未识别分享 stoken，请刷新页面后重试。');
      body = {
        fids: files.map(function(item) { return item.fid; }),
        fids_token: files.map(function(item) { return item.share_fid_token || ''; }),
        pwd_id: payload.pwdId,
        stoken: payload.stoken
      };
    } else {
      body = { fids: files.map(function(item) { return item.fid; }) };
    }

    var resp = await fetch('https://drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*'
      },
      body: JSON.stringify(body)
    });
    var text = await resp.text();
    var json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('夸克接口返回非 JSON: ' + text.slice(0, 160)); }
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 160));
    if (json.code !== 0 || !Array.isArray(json.data)) {
      throw new Error('直链接口失败 code=' + json.code + ' ' + (json.message || json.msg || ''));
    }
    return json.data.map(mapDownloadEntry).filter(function(item) { return item.url; });
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'GOODLINK_EXT_EXTRACT_FILES') return;
    window.postMessage({
      type: 'GOODLINK_EXT_FILES',
      requestId: event.data.requestId,
      result: getSelectedFilesFromPage()
    }, '*');
  });

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'GOODLINK_EXT_FETCH_DIRECT_LINKS') return;
    fetchDirectLinksInPage(event.data.payload || {})
      .then(function(links) {
        window.postMessage({ type: 'GOODLINK_EXT_DIRECT_LINKS', requestId: event.data.requestId, ok: true, links: links }, '*');
      })
      .catch(function(error) {
        window.postMessage({ type: 'GOODLINK_EXT_DIRECT_LINKS', requestId: event.data.requestId, ok: false, error: error.message || String(error) }, '*');
      });
  });

  window.postMessage({ type: 'GOODLINK_EXT_EXTRACTOR_READY' }, '*');
})();
