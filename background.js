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
    
    chrome.downloads.download({
      url: url,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
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
