let currentTab = null;
let folders = [];
let isExporting = false;

document.addEventListener('DOMContentLoaded', async () => {
  await initSidePanel();
  bindEvents();
  initTabs();
});

// 侧边栏标签切换（任务 / 设置 / 日志）
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      const paneId = `tab-${tab.dataset.tab}`;
      document.getElementById(paneId).classList.add('active');
    };
  });
}

// 初始化：绑定当前激活标签页（必须是 i.mi.com 笔记页）并加载配置/文件夹
async function initSidePanel() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0 || !tabs[0].url.includes('i.mi.com')) {
      updateStatus('offline', '请在小米笔记页面使用');
      document.getElementById('btn-start').disabled = true;
      addLog('侧边栏仅在小米笔记页面生效。', 'warning');
    } else {
      currentTab = tabs[0];
      updateStatus('online', '已连接');
      addLog('侧边栏已连接至小米笔记页面。', 'success');
      await loadSavedSettings(); // 加载已保存的设置
      await loadFolders();
    }
  } catch (err) {
    updateStatus('offline', '连接失败');
    addLog('连接失败: ' + err.message, 'error');
  }
}

function updateStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  dot.className = 'dot ' + state;
  statusText.textContent = text;
}

// 绑定 UI 事件：任务控制、文件夹操作、设置保存/重置、日志清空
function bindEvents() {
  document.getElementById('select-all').onclick = selectAllFolders;
  document.getElementById('deselect-all').onclick = deselectAllFolders;
  document.getElementById('refresh-folders').onclick = refreshPageAndFolders;
  document.getElementById('btn-start').onclick = startExport;
  document.getElementById('btn-pause').onclick = pauseExport;
  document.getElementById('btn-resume').onclick = resumeExport;
  document.getElementById('btn-stop').onclick = stopExport;
  document.getElementById('btn-save-config').onclick = saveConfig;
  document.getElementById('btn-reset-config').onclick = resetConfig;
  document.getElementById('btn-clear-cache').onclick = clearResumeCache;
  document.getElementById('btn-test-api').onclick = testCloudIndex;
  document.getElementById('clear-logs').onclick = () => {
    document.getElementById('log-container').innerHTML = '';
  };

  document.querySelectorAll('input[name="export-type"]').forEach(radio => {
    radio.onchange = (e) => {
      const options = document.getElementById('image-options');
      options.style.opacity = e.target.value === 'text-only' ? '0.5' : '1';
      options.style.pointerEvents = e.target.value === 'text-only' ? 'none' : 'auto';
    };
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 扩展更新后，页面里注入的是旧版脚本，消息发不进去（Receiving end does not exist）。
// 这时自动重载一次页面就等于用户按 F5，之后新脚本接管，不需要用户自己记得刷新。
let autoReloadedForStaleScript = false;
let lastSyncOk = null;
let isReloading = false;

async function loadFolders(opts = {}) {
  try {
    if (!opts.silent) updateStatus('busy', '同步中...');
    const response = await sendMessageToContent({ action: 'getFolders' });
    if (!(response && response.success && response.folders)) {
      throw new Error((response && response.error) || '获取失败');
    }
    folders = response.folders;
    const exported = await getExportedFolderSet();
    renderFolders(folders, exported);
    updateStatus('online', '已同步');
    updateSelectedCount();
    lastSyncOk = true;
    return true;
  } catch (err) {
    const stale = err && err.code === 'NO_RECEIVER';

    if (stale && !autoReloadedForStaleScript) {
      autoReloadedForStaleScript = true;
      addLog('页面里的脚本和扩展版本对不上（扩展刚更新时就是这样），正在自动重载页面…', 'warning');
      updateStatus('busy', '正在重载页面...');
      if (await reloadAndWaitSync()) return true;
    }

    lastSyncOk = false;

    // 侧边栏自己的上下文失效：只能重开侧边栏，重载页面也救不了
    if (err && err.code === 'CONTEXT_INVALID') {
      updateStatus('offline', '请重新打开侧边栏');
      addLog('扩展刚更新过，这个侧边栏的上下文已经失效。关掉侧边栏重新点图标打开就能恢复。', 'warning');
      return false;
    }

    updateStatus('offline', '同步失败');
    // 刷新过程中的尝试保持静默，避免日志里刷屏
    if (!isRefreshing && !opts.silent) {
      addLog(
        stale
          ? '页面还没就绪：点「刷新」会自动重载页面并重新同步，不用手动按 F5。'
          : '无法获取文件夹，请确保页面已加载并已登录。',
        'error'
      );
    }
    return false;
  }
}

// 重载小米笔记标签页，然后轮询等新的 content script 接管
async function reloadAndWaitSync(maxAttempts = 20) {
  let tab;
  try {
    tab = await getTargetTab();
  } catch (e) {
    addLog('找不到小米笔记标签页，请在 i.mi.com 打开笔记后重试。', 'error');
    return false;
  }

  isReloading = true;
  try {
    await chrome.tabs.reload(tab.id);
  } catch (e) {
    isReloading = false;
    addLog('重载页面的请求被拒绝：' + e.message, 'error');
    return false;
  }

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(800);
    try {
      const res = await sendMessageToContent({ action: 'getFolders' });
      if (res && res.success && res.folders) {
        folders = res.folders;
        const exported = await getExportedFolderSet();
        renderFolders(folders, exported);
        updateStatus('online', '已同步');
        updateSelectedCount();
        lastSyncOk = true;
        isReloading = false;
        addLog(`页面已重载，文件夹同步成功（${res.folders.length} 个）。`, 'success');
        return true;
      }
    } catch (e) {
      // 页面还在加载，继续等
    }
  }

  isReloading = false;
  lastSyncOk = false;
  updateStatus('offline', '同步超时');
  addLog('重载后仍然同步不上。确认页面已登录后点「刷新」再试一次。', 'error');
  return false;
}

// 读取“已导出文件夹”记录：用于默认不勾选已导出的文件夹
async function getExportedFolderSet() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['miNotesExportedFolders'], (result) => {
      const map = result.miNotesExportedFolders && typeof result.miNotesExportedFolders === 'object'
        ? result.miNotesExportedFolders
        : {};
      resolve(new Set(Object.keys(map)));
    });
  });
}

let isRefreshing = false;
async function refreshPageAndFolders() {
  if (isRefreshing) return;
  isRefreshing = true;

  updateStatus('busy', '正在刷新...');
  addLog('正在刷新页面并重新同步数据...', 'info');

  try {
    // 没有小米笔记标签页就先开一个；有就重载它
    const tabs = await chrome.tabs.query({ url: "*://i.mi.com/note/*" });
    if (tabs.length === 0) {
      currentTab = await chrome.tabs.create({ url: 'https://i.mi.com/note/h5#/' });
      await sleep(2500);
    }
    // 重载成功会写日志并把状态更新成「已同步」
    await reloadAndWaitSync();
  } catch (err) {
    addLog('刷新操作失败: ' + err.message, 'error');
    updateStatus('offline', '同步失败');
  } finally {
    isRefreshing = false;
  }
}

function renderFolders(list, exported = new Set()) {
  const container = document.getElementById('folder-list');
  const exclude = ['全部笔记', '私密笔记', '最近删除', '未完成'];
  container.innerHTML = list.map(f => `
    <label class="folder-item">
      <input type="checkbox" data-folder="${f.name}" ${(!exclude.includes(f.name) && !exported.has(f.name)) ? 'checked' : ''}>
      <span class="folder-name">${f.name}</span>
    </label>
  `).join('');
  container.querySelectorAll('input').forEach(i => i.onchange = updateSelectedCount);
}

function updateSelectedCount() {
  const count = document.querySelectorAll('#folder-list input:checked').length;
  document.getElementById('selected-count').textContent = count;
  document.getElementById('btn-start').disabled = count === 0;
}

function selectAllFolders() {
  document.querySelectorAll('#folder-list input').forEach(i => i.checked = true);
  updateSelectedCount();
}

function deselectAllFolders() {
  document.querySelectorAll('#folder-list input').forEach(i => i.checked = false);
  updateSelectedCount();
}

function getConfig() {
  return {
    selectedFolders: Array.from(document.querySelectorAll('#folder-list input:checked')).map(i => i.dataset.folder),
    exportType: document.querySelector('input[name="export-type"]:checked').value,
    downloadImages: document.getElementById('download-images').checked,
    imageFolderName: document.getElementById('image-folder').value || 'images',
    minDelay: parseInt(document.getElementById('min-delay').value) || 1000,
    maxDelay: parseInt(document.getElementById('max-delay').value) || 3000,
    batchSize: parseInt(document.getElementById('batch-size').value) || 30,
    batchPause: (parseInt(document.getElementById('batch-pause').value) || 15) * 1000,
    outputDir: (document.getElementById('output-dir').value || '').trim(),
    imageConcurrency: Math.min(8, Math.max(1, parseInt(document.getElementById('image-concurrency').value) || 4)),
    imageThrottleMs: Math.max(0, parseInt(document.getElementById('image-throttle').value) || 0),
    packMode: document.getElementById('pack-mode').value,
    titleStyle: document.getElementById('title-style').value,
    resume: document.getElementById('resume-export').checked,
    useCloudIndex: document.getElementById('cloud-index').checked,
    noteLoadDelay: 1500,
    folderLoadDelay: 1000
  };
}

// 测试接口通不通：只发一次清单请求，不做导出
async function testCloudIndex() {
  const logsTab = document.querySelector('.tab-btn[data-tab="logs"]');
  if (logsTab) logsTab.click();
  addLog('正在测试接口...', 'info');
  try {
    const res = await sendMessageToContent({ action: 'testCloudIndex' });
    if (res?.success) {
      addLog(`✅ 接口可用：${res.folders} 个文件夹 / ${res.notes} 条笔记（翻页 ${res.pages} 次）`, 'success');
    } else {
      addLog('❌ 接口不可用：' + (res?.error || '未知原因'), 'error');
    }
  } catch (err) {
    addLog('❌ 测试失败：' + err.message, 'error');
  }
}

// 清空断点续传记录
async function clearResumeCache() {
  try {
    await sendMessageToContent({ action: 'clearCache' });
    addLog('断点记录已清除，下次导出会重新抓取全部笔记。', 'warning');
  } catch (err) {
    addLog('清除失败: ' + err.message, 'error');
  }
}

// 开始导出：把当前配置发送给 content script 执行
async function startExport() {
  const config = getConfig();
  
  // 自动跳转到日志标签页
  const logsTab = document.querySelector('.tab-btn[data-tab="logs"]');
  if (logsTab) logsTab.click();

  updateUIState('running');
  addLog('🚀 任务启动...', 'info');
  try {
    const res = await sendMessageToContent({ action: 'startExport', config });
    if (res?.success) addLog(`✅ 导出成功！共 ${res.notesCount} 条。`, 'success');
    else addLog('❌ 任务中断: ' + (res?.error || '未知错误'), 'error');
  } catch (err) { addLog('❌ 异常: ' + err.message, 'error'); }
  updateUIState('ready');
}

async function pauseExport() {
  await sendMessageToContent({ action: 'pauseExport' });
  updateUIState('paused');
  addLog('⏸️ 任务已暂停', 'warning');
}

// 继续导出：用于“暂停/继续”流程（不包含断点续传）
async function resumeExport() {
  await sendMessageToContent({ action: 'resumeExport' });
  updateUIState('running');
  addLog('▶️ 任务继续', 'info');
}

async function stopExport() {
  await sendMessageToContent({ action: 'stopExport' });
  updateUIState('ready');
  addLog('⏹️ 任务已停止', 'warning');
}

function updateUIState(state) {
  const ids = ['btn-start', 'btn-pause', 'btn-resume', 'btn-stop', 'progress-section'];
  const mapping = {
    running: [0, 1, 0, 1, 1],
    paused: [0, 0, 1, 1, 1],
    ready: [1, 0, 0, 0, 0]
  };
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (mapping[state][i]) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });
}

function updateProgress(data) {
  if (data.currentFolder) document.getElementById('progress-folder').textContent = data.currentFolder;
  if (data.currentNote) document.getElementById('current-note-title').textContent = data.currentNote;
  if (data.notesCount !== undefined) document.getElementById('progress-notes').textContent = data.notesCount;
  if (data.imagesCount !== undefined) document.getElementById('progress-images').textContent = data.imagesCount;

  let p = 0;
  if (data.currentNoteIndex && data.totalNotesInFolder) p = Math.round((data.currentNoteIndex / data.totalNotesInFolder) * 100);
  else if (data.currentFolderIndex && data.totalFolders) p = Math.round((data.currentFolderIndex / data.totalFolders) * 100);
  
  document.getElementById('progress-fill').style.width = p + '%';
  document.getElementById('progress-percent').textContent = p + '%';

  if (['completed', 'stopped', 'error'].includes(data.status)) updateUIState('ready');
}

// 写入一条日志到面板
function addLog(msg, type = 'info') {
  const box = document.getElementById('log-container');
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// 取当前小米笔记标签页。每次都重新取，避免侧边栏开久了拿着过期的 tabId。
async function getTargetTab() {
  try {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    const hit = active.find(t => t.url && t.url.includes('i.mi.com'));
    if (hit) {
      currentTab = hit;
      return hit;
    }
  } catch (e) {}

  if (currentTab && currentTab.id != null) return currentTab;

  const tabs = await chrome.tabs.query({ url: "*://i.mi.com/*" });
  if (tabs.length > 0) {
    currentTab = tabs[0];
    return tabs[0];
  }
  throw new Error('当前标签不是小米笔记页面');
}

// 给 content script 发消息。
// 关键：把「页面里没有接收端」和「其它失败」区分开——前者说明脚本没注入或已因扩展更新失效，
// 上层据此决定要不要自动重载页面，而不是干巴巴报一句"同步失败"。
async function sendMessageToContent(msg) {
  const tab = await getTargetTab();
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tab.id, msg, (res) => {
        if (chrome.runtime.lastError) {
          const text = chrome.runtime.lastError.message || '';
          const err = new Error(text || '通信失败');
          err.code = /Receiving end|Could not establish|message port closed before/i.test(text)
            ? 'NO_RECEIVER'
            : 'FAILED';
          reject(err);
          return;
        }
        resolve(res);
      });
    } catch (e) {
      // 扩展被更新或重载时，侧边栏自身的上下文会失效，Chrome 直接抛异常
      const err = new Error(e.message || '扩展上下文已失效');
      err.code = /context invalidated/i.test(String(e.message)) ? 'CONTEXT_INVALID' : 'FAILED';
      reject(err);
    }
  });
}

// 设置保存后，把配置立即同步给正在运行的任务
async function applyConfigToContent() {
  try {
    const config = getConfig();
    await sendMessageToContent({ action: 'updateConfig', config });
    addLog('⚙️ 设置已同步至当前任务。', 'info');
  } catch (err) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') updateProgress(msg.data);
  else if (msg.action === 'log') addLog(msg.data.message, msg.data.type);
});

// 页面加载完成时自动补一次同步。
// 覆盖两种情形：用户自己按了 F5（面板不用再点刷新）；扩展更新后页面被重载。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !tab.url.includes('i.mi.com')) return;
  if (isRefreshing || isReloading) return;   // 刷新流程自己会轮询，别插一脚
  if (lastSyncOk === true) return;           // 已经同步好的不打扰
  loadFolders({ silent: true });
});

// 保存配置到本地存储
async function saveConfig() {
  const config = getConfig();
  // 不保存已选文件夹，只保存通用配置
  const settingsToSave = {
    exportType: config.exportType,
    downloadImages: config.downloadImages,
    imageFolderName: config.imageFolderName,
    minDelay: config.minDelay,
    maxDelay: config.maxDelay,
    batchSize: config.batchSize,
    batchPause: config.batchPause / 1000, // 转回秒保存
    outputDir: config.outputDir,
    imageConcurrency: config.imageConcurrency,
    imageThrottleMs: config.imageThrottleMs,
    packMode: config.packMode,
    titleStyle: config.titleStyle,
    resume: config.resume,
    useCloudIndex: config.useCloudIndex,
    // 配置结构版本：v2 起 zip 成为默认打包方式，见 loadSavedSettings 的一次性迁移
    defaultsVersion: 2
  };

  chrome.storage.local.set({ 'miNotesSettings': settingsToSave }, () => {
    addLog('✅ 设置已保存至本地。', 'success');
    applyConfigToContent();
  });
}

// 加载已保存的配置
async function loadSavedSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['miNotesSettings'], (result) => {
      if (result.miNotesSettings) {
        const s = result.miNotesSettings;
        // 更新 UI
        if (s.exportType) {
          const radio = document.querySelector(`input[name="export-type"][value="${s.exportType}"]`);
          if (radio) {
            radio.checked = true;
            // 触发一次 change 事件以更新图片选项状态
            radio.dispatchEvent(new Event('change'));
          }
        }
        if (s.downloadImages !== undefined) document.getElementById('download-images').checked = s.downloadImages;
        if (s.imageFolderName) document.getElementById('image-folder').value = s.imageFolderName;
        if (s.minDelay) document.getElementById('min-delay').value = s.minDelay;
        if (s.maxDelay) document.getElementById('max-delay').value = s.maxDelay;
        if (s.batchSize) document.getElementById('batch-size').value = s.batchSize;
        if (s.batchPause) document.getElementById('batch-pause').value = s.batchPause;
        if (s.outputDir !== undefined) document.getElementById('output-dir').value = s.outputDir;
        if (s.imageConcurrency) document.getElementById('image-concurrency').value = s.imageConcurrency;
        if (s.imageThrottleMs !== undefined) document.getElementById('image-throttle').value = s.imageThrottleMs;
        // 打包方式默认值在 v1.11.4 从「逐个文件」改成「zip」。
        // 老配置里存的 files 只是旧默认值，不代表用户选择，所以迁移一次；
        // 迁移后写入 defaultsVersion，用户之后自己改的选择不会再被覆盖。
        if (!s.defaultsVersion) {
          document.getElementById('pack-mode').value = 'zip';
          chrome.storage.local.set({
            miNotesSettings: Object.assign({}, s, { packMode: 'zip', defaultsVersion: 2 })
          });
        } else if (s.packMode) {
          document.getElementById('pack-mode').value = s.packMode;
        }
        if (s.titleStyle) document.getElementById('title-style').value = s.titleStyle;
        if (s.resume !== undefined) document.getElementById('resume-export').checked = s.resume;
        if (s.useCloudIndex !== undefined) document.getElementById('cloud-index').checked = s.useCloudIndex;
        
        addLog('📥 已加载上次保存的配置。', 'info');
      }
      resolve();
    });
  });
}

// 重置为默认配置
function resetConfig() {
  const defaults = {
    exportType: 'full',
    downloadImages: true,
    imageFolderName: 'images',
    minDelay: 1000,
    maxDelay: 3000,
    batchSize: 30,
    batchPause: 15,
    outputDir: '',
    imageConcurrency: 4,
    imageThrottleMs: 120,
    packMode: 'zip',
    titleStyle: 'placeholder',
    resume: true,
    useCloudIndex: true
  };

  // 更新 UI
  const fullRadio = document.querySelector('input[name="export-type"][value="full"]');
  if (fullRadio) {
    fullRadio.checked = true;
    fullRadio.dispatchEvent(new Event('change'));
  }
  document.getElementById('download-images').checked = defaults.downloadImages;
  document.getElementById('image-folder').value = defaults.imageFolderName;
  document.getElementById('min-delay').value = defaults.minDelay;
  document.getElementById('max-delay').value = defaults.maxDelay;
  document.getElementById('batch-size').value = defaults.batchSize;
  document.getElementById('batch-pause').value = defaults.batchPause;
  document.getElementById('output-dir').value = defaults.outputDir;
  document.getElementById('image-concurrency').value = defaults.imageConcurrency;
  document.getElementById('image-throttle').value = defaults.imageThrottleMs;
  document.getElementById('pack-mode').value = defaults.packMode;
  document.getElementById('title-style').value = defaults.titleStyle;
  document.getElementById('resume-export').checked = defaults.resume;
  document.getElementById('cloud-index').checked = defaults.useCloudIndex;

  chrome.storage.local.remove(['miNotesSettings'], () => {
    addLog('🔄 已重置为默认设置。', 'info');
    applyConfigToContent();
  });
}
