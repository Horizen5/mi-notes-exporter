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

async function loadFolders() {
  try {
    updateStatus('busy', '同步中...');
    const response = await sendMessageToContent({ action: 'getFolders' });
    if (response && response.success && response.folders) {
      folders = response.folders;
      const exported = await getExportedFolderSet();
      renderFolders(folders, exported);
      updateStatus('online', '已同步');
      updateSelectedCount();
    } else throw new Error('获取失败');
  } catch (err) {
    updateStatus('offline', '同步失败');
    // 如果是刷新过程中的尝试，不直接报错日志，保持静默重试
    if (!isRefreshing) {
      addLog('无法获取文件夹，请确保页面已加载。', 'error');
    }
  }
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
    // 1. 寻找小米笔记标签页
    const tabs = await chrome.tabs.query({ url: "*://i.mi.com/note/*" });
    
    if (tabs.length > 0) {
      // 刷新现有标签页并激活
      const targetTab = tabs[0];
      await chrome.tabs.reload(targetTab.id);
      await chrome.tabs.update(targetTab.id, { active: true });
      currentTab = targetTab;
    } else {
      // 没找到则新建
      currentTab = await chrome.tabs.create({ url: 'https://i.mi.com/note/h5#/' });
    }

    // 2. 轮询尝试重新同步，直到页面加载完成
    let attempts = 0;
    const maxAttempts = 15;
    
    const pollSync = async () => {
      if (attempts >= maxAttempts) {
        isRefreshing = false;
        updateStatus('offline', '同步超时');
        addLog('同步超时，请确保页面已完全加载并登录。', 'error');
        return;
      }
      
      attempts++;
      try {
        // 确保获取最新的标签页状态
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs.length > 0 && activeTabs[0].url.includes('i.mi.com')) {
          currentTab = activeTabs[0];
          const response = await sendMessageToContent({ action: 'getFolders' });
          if (response && response.success) {
            folders = response.folders;
            const exported = await getExportedFolderSet();
            renderFolders(folders, exported);
            updateStatus('online', '已同步');
            updateSelectedCount();
            addLog('页面已刷新，数据同步成功。', 'success');
            isRefreshing = false;
            return;
          }
        }
      } catch (e) {}
      
      // 每 1.5 秒重试一次
      setTimeout(pollSync, 1500);
    };

    // 延迟 2 秒开始轮询，给浏览器刷新留出启动时间
    setTimeout(pollSync, 2000);

  } catch (err) {
    isRefreshing = false;
    addLog('刷新操作失败: ' + err.message, 'error');
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
    noteLoadDelay: 1500,
    folderLoadDelay: 1000
  };
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

// 给 content script 发消息（在当前 i.mi.com 标签页里）
async function sendMessageToContent(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(currentTab.id, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error('通信失败'));
      else resolve(res);
    });
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
    batchPause: config.batchPause / 1000 // 转回秒保存
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
    batchPause: 15
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

  chrome.storage.local.remove(['miNotesSettings'], () => {
    addLog('🔄 已重置为默认设置。', 'info');
    applyConfigToContent();
  });
}
