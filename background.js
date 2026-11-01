// ---------- 下载命名兜底 ----------
// chrome.downloads.download 的 filename 参数只要浏览器里有任何一个扩展注册了
// downloads.onDeterminingFilename 监听，就会被整体忽略（Chromium bug 579563）。
// 丢了 filename 之后 Chrome 从 URL 反推名字，data: URL 反推出来就是「下载.zip」
// 「下载.json」，所以导出的压缩包不叫「私密笔记.zip」。
// 对策：我们自己注册 onDeterminingFilename，在自家下载上把名字再建议一次。
const pendingNameByFingerprint = new Map(); // 指纹 → 相对路径
const verifyById = new Map();               // downloadId → 期望的相对路径

// data URL 动辄几百 KB，不拿整串当键，取长度加首尾片段足够区分
function pathFingerprint(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  return `${url.length}|${url.slice(0, 96)}|${url.slice(-96)}`;
}

function rememberSuggestedName(url, path) {
  const key = pathFingerprint(url);
  if (!key) return;
  pendingNameByFingerprint.set(key, path);
  // 兜底清理：正常流程会在建议后立刻删除，这里防的是事件没触发导致键残留
  setTimeout(() => pendingNameByFingerprint.delete(key), 120000);
}

function notifyPanel(message) {
  try {
    chrome.runtime.sendMessage({ action: 'log', data: { message, type: 'warning' } }, () => {
      // 侧边栏没打开时这里会报 lastError，读一下消掉，不影响下载
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const key = pathFingerprint(item.url) || pathFingerprint(item.finalUrl);
    const wanted = key ? pendingNameByFingerprint.get(key) : undefined;
    if (wanted) {
      pendingNameByFingerprint.delete(key);
      suggest({ filename: wanted, conflictAction: 'overwrite' });
      return;
    }
    suggest(); // 不是我们发起的下载，不插手
  });
}

// 下载完成后核对落盘名，被别的扩展抢了命名时明确告诉用户原因
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== 'complete') return;
  const expected = verifyById.get(delta.id);
  if (!expected) return;
  verifyById.delete(delta.id);

  chrome.downloads.search({ id: delta.id }, (items) => {
    const item = items && items[0];
    if (!item || !item.filename) return;
    const actual = String(item.filename).split(/[\\/]/).pop();
    const want = String(expected).split('/').pop();
    if (actual !== want) {
      notifyPanel(`⚠️ 文件名被浏览器改成了「${actual}」，期望「${want}」。一般是有下载管理器类扩展（IDM、Chrono 等）在抢命名，临时禁用后重新导出即可。`);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkFileInHistory') {
    const { filename, imageFolderName } = message;
    const fullPath = `${imageFolderName}/${filename}`;
    
    chrome.downloads.search({
      filenameRegex: fullPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      state: 'complete'
    }, (items) => {
      sendResponse({ exists: items && items.length > 0 });
    });
    return true;
  } else if (message.action === 'openSidePanel') {
    // 查找当前活跃窗口的标签页
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length > 0) {
        await chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
  } else if (message.action === 'downloadFile') {
    const { url, filename, folder } = message;
    const path = folder ? `${folder}/${filename}` : filename;

    // filename 有可能被浏览器忽略，先登记期望名，交给 onDeterminingFilename 兜底
    rememberSuggestedName(url, path);

    chrome.downloads.download({
      url: url,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        verifyById.set(downloadId, path);
        sendResponse({ success: true, downloadId });
      }
    });
    return true; // 异步响应
  }
  return true;
});

// 点击插件图标时打开侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.includes('i.mi.com')) {
    // 侧边栏行为由 setPanelBehavior 控制
  } else {
    // 如果不在小米页面，提示用户
    console.log('请在小米笔记页面使用侧边栏功能');
  }
});

// 监听标签页更新，动态启用/禁用侧边栏
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  const url = new URL(tab.url);
  if (url.origin === 'https://i.mi.com') {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[小米笔记导出工具] 插件已安装');
  // 设置侧边栏在点击图标时打开
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});
