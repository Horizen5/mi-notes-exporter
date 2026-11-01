// 内容脚本（运行在 i.mi.com/note/h5 页面内）：负责抓取目录/笔记、转换 Markdown、下载图片与导出文件
const MiNotesExporter = {
  isRunning: false,
  isPaused: false,
  isStopped: false,
  allNotes: [],
  downloadedImages: 0,
  failedImages: 0,
  currentFolderIndex: 0,
  currentNoteIndex: 0,
  folders: [],
  config: {
    selectedFolders: [],
    exportType: 'full',
    downloadImages: true,
    imageFolderName: 'images',
    noteLoadDelay: 1500,
    folderLoadDelay: 1000,
    maxImageSize: 10 * 1024 * 1024,
    minDelay: 1000,
    maxDelay: 3000,
    batchSize: 30,
    batchPause: 15000
  },
  batchCount: 0,

  // 初始化：注册来自侧边栏的消息监听
  init() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true;
    });
    console.log('[小米笔记导出] Content script 已加载');
  },

  // 消息分发：侧边栏通过 chrome.tabs.sendMessage 调用
  async handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'getFolders':
        const folders = await this.getFolders();
        sendResponse({ success: true, folders });
        break;
      
      case 'startExport':
        // 开始任务：以侧边栏传入的配置为准
        this.config = { ...this.config, ...request.config };
        this.startExport().then(result => {
          sendResponse(result);
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });
        break;

      case 'updateConfig':
        // 运行中配置热更新：保存设置后立即生效
        this.config = { ...this.config, ...request.config };
        sendResponse({ success: true });
        break;
      
      case 'pauseExport':
        // 暂停：仅暂停循环，不做断点续传持久化
        this.isPaused = true;
        this.sendProgress({ status: 'paused' });
        sendResponse({ success: true });
        break;
      
      case 'resumeExport':
        this.isPaused = false;
        this.sendProgress({ status: 'running' });
        sendResponse({ success: true });
        break;
      
      case 'stopExport':
        this.isStopped = true;
        // 不再立即清除状态，等待 startExport 循环结束
        this.sendProgress({ status: 'stopped' });
        sendResponse({ success: true });
        break;

      case 'switchToSidebar':
        // 现在使用 Chrome 原生侧边栏，不再通过 content script 注入
        chrome.runtime.sendMessage({ action: 'openSidePanel' });
        sendResponse({ success: true });
        break;
    }
  },

  // 获取左侧文件夹列表（用于侧边栏展示与选择）
  async getFolders() {
    await this.waitForElement('.sidebar-item-2LDWD, .sidebar-item-3IBBu', 5000);
    
    const items = document.querySelectorAll('.sidebar-item-2LDWD, .sidebar-item-3IBBu');
    const folders = [];
    
    // 不需要的文件夹列表
    const excludeFolders = ['已完成', '未完成', '最近删除', '我的文件夹'];
    
    for (const item of items) {
      const name = this.getFolderName(item);
      
      // 过滤掉不需要的文件夹
      if (!excludeFolders.includes(name)) {
        folders.push({ name, noteCount: '-' });
      }
    }
    
    return folders;
  },

  // 从侧边栏文件夹 DOM 节点中提取文件夹名称
  getFolderName(folder) {
    const textEl = folder.querySelector('.text-10cyJ');
    return textEl ? textEl.innerText.trim() : '未命名文件夹';
  },

  // 校验登录状态：导出前/批量过程中用于判断是否掉线
  async checkLoginStatus() {
    try {
      // 检查是否存在登录状态标志
      const userInfo = document.querySelector('.user-info, .avatar');
      if (!userInfo) {
        throw new Error('未检测到登录状态');
      }
      
      // 尝试获取用户信息，检查登录是否有效
      const response = await fetch('https://i.mi.com/api/user/profile', {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://i.mi.com/note/h5#/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive'
        },
        credentials: 'include'
      });
      
      if (response.status === 401 || response.status === 302) {
        throw new Error('登录已过期');
      }
      
      return true;
    } catch (err) {
      this.log(`登录状态检查失败: ${err.message}`, 'error');
      return false;
    }
  },

  // 心跳：导出休息间隔内保持会话活跃，降低 401/302 概率
  async sendHeartbeat() {
    try {
      // 发送轻量级请求保持登录状态
      const response = await fetch('https://i.mi.com/api/user/profile', {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://i.mi.com/note/h5#/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive'
        },
        credentials: 'include',
        timeout: 5000
      });
      
      if (response.ok) {
        this.log('心跳请求成功，登录状态保持活跃', 'info');
      }
    } catch (err) {
      this.log(`心跳请求失败: ${err.message}`, 'warning');
    }
  },

  // 主流程：按选中文件夹逐个提取 -> 每个文件夹提取完立即导出（MD+JSON）
  async startExport() {
    if (this.isRunning) {
      return { success: false, error: '导出任务正在进行中' };
    }

    // 检查登录状态
    const isLoggedIn = await this.checkLoginStatus();
    if (!isLoggedIn) {
      this.sendProgress({ status: 'error', message: '登录已过期，请重新登录' });
      return { success: false, error: '登录已过期，请重新登录' };
    }

    // 断点续传已移除：每次开始都从头执行
    this.isRunning = true;
    this.isPaused = false;
    this.isStopped = false;
    this.allNotes = [];
    this.downloadedImages = 0;
    this.failedImages = 0;
    this.currentFolderIndex = 0;
    this.currentNoteIndex = 0;

    this.sendProgress({ status: 'running', message: '开始导出...' });

    try {
      this.exportedFoldersInRun = new Set();
      const items = document.querySelectorAll('.sidebar-item-2LDWD, .sidebar-item-3IBBu');
      this.folders = Array.from(items).filter(item => {
        const name = this.getFolderName(item);
        return this.config.selectedFolders.includes(name);
      });

      if (this.folders.length === 0) {
        this.isRunning = false;
        return { success: false, error: '未选择任何文件夹' };
      }

      this.sendProgress({
        status: 'running',
        totalFolders: this.folders.length,
        message: `共选择 ${this.folders.length} 个文件夹`
      });

      for (let i = 0; i < this.folders.length; i++) {
        if (this.isStopped) break;
        
        while (this.isPaused) {
          await this.delay(500);
          if (this.isStopped) break;
        }
        if (this.isStopped) break;

        this.currentFolderIndex = i;
        const folder = this.folders[i];
        const folderName = this.getFolderName(folder);

        this.sendProgress({
          status: 'running',
          currentFolder: folderName,
          currentFolderIndex: i + 1,
          totalFolders: this.folders.length,
          message: `正在处理文件夹: ${folderName}`
        });

        try {
          folder.click();
          await this.delay(this.config.folderLoadDelay);
          
          const result = await this.extractNotesFromFolder(folderName);
          const notes = result.notes || [];
          const totalNotesInFolder = result.totalNotesInFolder || 0;
          this.allNotes.push(...notes);

          if (notes.length > 0) {
            const isPartialFolder = this.isStopped || (totalNotesInFolder > 0 && notes.length < totalNotesInFolder);
            await this.exportFolderNow(folderName, notes, isPartialFolder);
            this.exportedFoldersInRun.add(folderName);
          }
          
          this.sendProgress({
            status: 'running',
            notesCount: this.allNotes.length,
            imagesCount: this.downloadedImages
          });
        } catch (err) {
          this.log(`处理文件夹 "${folderName}" 时出错: ${err.message}`, 'error');
        }
      }

      await this.exportAnyUnexportedFolders();

      this.isRunning = false;
      this.sendProgress({
        status: this.isStopped ? 'stopped' : 'completed',
        message: this.isStopped ? '导出已手动停止。' : '导出完成！',
        notesCount: this.allNotes.length,
        imagesCount: this.downloadedImages,
        failedImages: this.failedImages
      });

      return {
        success: true,
        notesCount: this.allNotes.length,
        imagesCount: this.downloadedImages
      };
    } catch (err) {
      this.isRunning = false;
      this.sendProgress({ status: 'error', message: err.message });
      return { success: false, error: err.message };
    }
  },

  // 单文件夹导出：生成 Markdown/JSON 并触发浏览器下载
  exportFolderNow(folderName, notes, isPartial) {
    const suffix = isPartial ? '_未全部导出' : '';
    const folderMarkdown = this.generateFolderMarkdown(folderName, notes, isPartial);
    this.downloadFolderMarkdown(folderMarkdown, folderName, suffix);

    const folderExportData = {
      folder: folderName,
      total: notes.length,
      exportTime: new Date().toISOString(),
      notes: notes,
      isPartial: !!isPartial
    };
    this.downloadJSON(folderExportData, folderName, suffix);
    return this.markFolderExported(folderName, isPartial, notes.length);
  },

  // 兜底导出：若某文件夹未即时导出（异常/中断），这里补一次“部分导出”
  exportAnyUnexportedFolders() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['miNotesExportedFolders'], async (result) => {
        const exportedMap = result.miNotesExportedFolders && typeof result.miNotesExportedFolders === 'object'
          ? result.miNotesExportedFolders
          : {};
        const grouped = {};
        (this.allNotes || []).forEach(note => {
          if (!note || !note.folder) return;
          if (!grouped[note.folder]) grouped[note.folder] = [];
          grouped[note.folder].push(note);
        });

        for (const [folderName, notes] of Object.entries(grouped)) {
          if (this.exportedFoldersInRun && this.exportedFoldersInRun.has(folderName)) continue;
          if (exportedMap[folderName]) continue;
          if (!notes || notes.length === 0) continue;
          await this.exportFolderNow(folderName, notes, true);
        }
        resolve();
      });
    });
  },

  // 列表与滚动相关：用于保证“从第一条开始扫”并尽量等列表稳定
  async ensureListStartsFromTop(scrollContainer) {
    if (!scrollContainer) return;
    try { scrollContainer.scrollTop = 0; } catch (e) {}
    await this.delay(400);
    try { scrollContainer.scrollTop = 0; } catch (e) {}
    await this.delay(400);
  },

  // 获取当前可见的笔记列表项，并按可视位置从上到下排序
  getSortedNoteItems() {
    const items = Array.from(document.querySelectorAll('.note-item-3E9te, [class*="note-item"]'));
    items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return items;
  },

  // 生成“列表顶部快照”：用于判断切换文件夹/刷新后列表是否稳定
  getTopSnapshotKey() {
    const items = this.getSortedNoteItems().slice(0, 3);
    return items.map((el) => (el?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)).join('|');
  },

  // 等待列表稳定：顶部快照连续多次不变即视为稳定
  async waitForListStabilize(timeoutMs = 3000) {
    const start = Date.now();
    let last = null;
    let stableCount = 0;
    while (Date.now() - start < timeoutMs) {
      const now = this.getTopSnapshotKey();
      if (now && now === last) stableCount++;
      else stableCount = 0;
      if (stableCount >= 2) return;
      last = now;
      await this.delay(300);
    }
  },

  // 稳定键相关：若 DOM 没有暴露唯一 id，尝试从 React 内部 props/state 挖出候选 ID
  getReactInternals(el) {
    if (!el) return null;
    const names = [];
    try { names.push(...Object.getOwnPropertyNames(el)); } catch (e) {}
    try { names.push(...Reflect.ownKeys(el).map(k => String(k))); } catch (e) {}
    const unique = Array.from(new Set(names));
    for (const k of unique) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
      if (k.startsWith('__reactProps$')) return { memoizedProps: el[k] };
    }
    return null;
  },

  extractLikelyIdsFromObjects(roots) {
    const results = [];
    const queue = Array.isArray(roots) ? roots.filter(Boolean).map(v => ({ v, d: 0 })) : [];
    const seen = new Set();
    const maxNodes = 1500;
    const maxDepth = 8;
    let nodes = 0;

    const pushResult = (val) => {
      const s = String(val);
      if (!s || s.length < 4 || s.length > 80) return;
      if (results.includes(s)) return;
      results.push(s);
    };

    while (queue.length > 0 && nodes < maxNodes && results.length < 8) {
      const { v, d } = queue.shift();
      if (!v) continue;
      if (typeof v !== 'object') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      nodes++;
      if (d > maxDepth) continue;

      if (Array.isArray(v)) {
        for (const it of v) queue.push({ v: it, d: d + 1 });
        continue;
      }

      for (const [k, val] of Object.entries(v)) {
        const key = String(k || '').toLowerCase();
        if (val === null || val === undefined) continue;
        if (typeof val === 'string' || typeof val === 'number') {
          if (key === 'id' || key.endsWith('id') || (key.includes('note') && key.includes('id')) || key.includes('record') || key.includes('uuid') || key.includes('guid') || key.includes('mid')) {
            pushResult(val);
          }
        } else if (typeof val === 'object') {
          queue.push({ v: val, d: d + 1 });
        }
      }
    }

    return results;
  },

  getReactCandidateIds(el) {
    const internals = this.getReactInternals(el);
    if (!internals) return [];
    const roots = [];
    if (internals.memoizedProps) roots.push(internals.memoizedProps);
    if (internals.pendingProps) roots.push(internals.pendingProps);
    if (internals.memoizedState) roots.push(internals.memoizedState);
    if (internals.return?.memoizedProps) roots.push(internals.return.memoizedProps);
    if (internals.return?.pendingProps) roots.push(internals.return.pendingProps);
    if (internals.return?.memoizedState) roots.push(internals.return.memoizedState);
    return this.extractLikelyIdsFromObjects(roots);
  },

  // 简单哈希函数：对字符串生成32位哈希值
  simpleHash(str) {
    if (!str) return 0;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  },

  // 全特征哈希：对节点进行全面特征提取并生成唯一ID
  getElementStableKey(el, collisionIndex = 0) {
    if (!el) return `empty_${Date.now()}`;

    // 1. 尝试从 DOM 属性获取 ID
    const attrCandidates = ['data-id', 'data-note-id', 'data-noteid', 'data-mid', 'data-key', 'data-uuid'];
    for (const name of attrCandidates) {
      const v = el.getAttribute?.(name);
      if (v && String(v).trim()) return `${name}:${String(v).trim()}`;
    }

    // 2. 尝试从其他属性获取 ID
    const attributes = el.attributes ? Array.from(el.attributes) : [];
    for (const a of attributes) {
      const n = (a?.name || '').toLowerCase();
      const v = (a?.value || '').trim();
      if (!v) continue;
      if (n.startsWith('data-') && (n.includes('id') || n.includes('key') || n.includes('uuid'))) {
        return `${n}:${v}`;
      }
    }

    // 3. 挖掘 React 隐藏 ID
    const reactIds = this.getReactCandidateIds(el);
    if (reactIds.length > 0) return `react:${reactIds[0]}`;

    // 4. 全特征哈希方案
    const features = [];

    // 4.1 标题
    const titleEl = el.querySelector?.('.note-preview-title-eozvt, [class*="title"]');
    const title = titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
    features.push(`title:${title}`);

    // 4.2 时间
    const timeEl = el.querySelector?.('.note-modified-time-pfkfu, [class*="time"]');
    const time = timeEl ? (timeEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
    features.push(`time:${time}`);

    // 4.3 预览内容全文（不仅仅是前160字符）
    const previewEl = el.querySelector?.('.note-preview-3vEE2, [class*="preview"]');
    const preview = previewEl ? (previewEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
    features.push(`preview:${preview}`);

    // 4.4 内容长度加盐
    const fullText = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const textLength = fullText.length;
    features.push(`len:${textLength}`);

    // 4.5 innerHTML 哈希（包含 HTML 结构差异）
    const innerHTML = el.innerHTML || '';
    const htmlHash = Math.abs(this.simpleHash(innerHTML)).toString(16);
    features.push(`html:${htmlHash}`);

    // 4.6 图片数量
    const imgCount = el.querySelectorAll?.('img')?.length || 0;
    features.push(`img:${imgCount}`);

    // 4.7 子元素数量
    const childCount = el.children?.length || 0;
    features.push(`child:${childCount}`);

    // 4.8 DOM 路径深度
    const domDepth = this.getDomDepth(el);
    features.push(`depth:${domDepth}`);

    // 5. 组合所有特征并生成最终哈希
    const combinedFeatures = features.join('|');
    const finalHash = Math.abs(this.simpleHash(combinedFeatures)).toString(16).toUpperCase();

    // 6. 如果有碰撞索引，追加后缀
    if (collisionIndex > 0) {
      return `hash:${finalHash}_dup${collisionIndex}`;
    }

    return `hash:${finalHash}`;
  },

  // 获取 DOM 深度
  getDomDepth(el) {
    let depth = 0;
    let current = el;
    while (current && current !== document.body) {
      depth++;
      current = current.parentElement;
    }
    return depth;
  },

  // 碰撞检测和解决器：确保同一批次中 ID 唯一
  resolveIdCollisions(items, folderName) {
    const idMap = new Map(); // key: noteId, value: [item, index]
    const resolvedIds = new Map(); // key: item, value: final noteId

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const baseId = `${folderName}_${this.getElementStableKey(item)}`;
      
      if (!idMap.has(baseId)) {
        idMap.set(baseId, [[item, i]]);
        resolvedIds.set(item, baseId);
      } else {
        // 发现碰撞，追加后缀
        const collisionList = idMap.get(baseId);
        const collisionIndex = collisionList.length;
        collisionList.push([item, i]);
        
        // 为所有碰撞的项重新生成带后缀的 ID
        for (let j = 0; j < collisionList.length; j++) {
          const [collisionItem, collisionItemIndex] = collisionList[j];
          const newId = `${folderName}_${this.getElementStableKey(collisionItem, j + 1)}`;
          resolvedIds.set(collisionItem, newId);
        }
      }
    }

    return resolvedIds;
  },

  // 提取某个文件夹的全部笔记：循环滚动列表、逐条点击打开、抽取正文、可选下载图片
  async extractNotesFromFolder(folderName) {
    const notes = [];
    if (!this.processedNotesByFolder) this.processedNotesByFolder = {};
    if (!this.processedNotesByFolder[folderName]) this.processedNotesByFolder[folderName] = new Set();
    const processedNotes = this.processedNotesByFolder[folderName];
    
    await this.waitForElement('.note-item-3E9te, [class*="note-item"]', 5000);
    
    const noteCountEl = document.querySelector('.note-count-select-1nzNf');
    let totalNotesInFolder = 0;
    if (noteCountEl) {
      const match = noteCountEl.innerText.match(/共\s*(\d+)\s*条笔记/);
      if (match) totalNotesInFolder = parseInt(match[1]);
    }
    
    if (totalNotesInFolder === 0) {
      totalNotesInFolder = document.querySelectorAll('.note-item-3E9te, [class*="note-item"]').length;
    }

    this.log(`文件夹 "${folderName}" 预计有 ${totalNotesInFolder} 条笔记`);

    const firstItem = document.querySelector('.note-item-3E9te, [class*="note-item"]');
    const scrollContainer = firstItem ? 
      (firstItem.closest('.note-list-items-2ID3T') ||
       firstItem.closest('[class*="note-list-items"]') ||
       firstItem.closest('.note-list-1zNf') || 
       firstItem.closest('[class*="note-list"]') ||
       firstItem.closest('[class*="list-container"]') ||
       firstItem.closest('[class*="list"]') || 
       firstItem.closest('[class*="container"]') || 
       firstItem.parentElement) : null;

    await this.ensureListStartsFromTop(scrollContainer);
    await this.waitForListStabilize(3000);

    let idleRounds = 0;
    const maxIdleRounds = 15;
    let hasRefreshedListOnce = false;
    let lastScrollTop = 0;
    let scrollStuckCount = 0;
    let lastAnchorIds = [];
    let processedInThisBatch = [];

    const wakeUp = () => {
      const safeArea = document.querySelector('.sidebar-header, .user-info') || document.body;
      safeArea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      safeArea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      window.dispatchEvent(new Event('focus'));
    };

    const processNoteItem = async (item, resolvedIds) => {
      const itemText = item.innerText || '';
      if (itemText.includes('数据解析失败') || 
          itemText.includes('暂不支持此类型的笔记') ||
          item.classList.contains('skeleton') || 
          item.offsetHeight < 5) return false;

      const titleEl = item.querySelector('.note-preview-title-eozvt, [class*="title"]');
      const title = titleEl ? (titleEl.innerText || '').trim() : '无标题';
      const timeEl = item.querySelector('.note-modified-time-pfkfu, [class*="time"]');
      const time = timeEl ? (timeEl.innerText || '').trim() : '';
      const noteId = resolvedIds.get(item) || `${folderName}_${this.getElementStableKey(item)}`;

      if (processedNotes.has(noteId)) return false;

      processedNotes.add(noteId);

      try {
        item.scrollIntoView({ block: 'center', behavior: 'instant' });
        await this.delay(300);
        
        if (!document.contains(item)) {
          processedNotes.delete(noteId);
          return false;
        }

        item.click();
        
        let waitTime = 0;
        while (waitTime < 3000) {
          const contentEl = document.querySelector('.note-content-1u7XQ, [class*="note-content"]');
          if (contentEl && !contentEl.innerText.includes('正在加载') && contentEl.innerText.trim().length > 0) break;
          await this.delay(300);
          waitTime += 300;
        }

        const contentEl = document.querySelector('.note-content-1u7XQ, [class*="note-content"]');
        if (contentEl) {
          let images = [];
          let imageMap = {};
          if (this.config.exportType === 'full' && this.config.downloadImages) {
            const result = await this.processImages(contentEl, title, folderName, time, noteId);
            images = result.images;
            imageMap = result.imageMap;
          }

          const markdown = this.htmlToMarkdown(contentEl.innerHTML, imageMap);
          notes.push({ folder: folderName, title, time, text: contentEl.innerText, markdown, images, imageCount: images.length });

          this.log(`✓ [${notes.length}/${totalNotesInFolder}] 已提取: ${title}`, 'success');
          processedInThisBatch.push(noteId);
          this.currentNoteIndex = notes.length;
          this.sendProgress({ status: 'running', currentNote: title, currentNoteIndex: notes.length, totalNotesInFolder, notesCount: this.allNotes.length + notes.length, imagesCount: this.downloadedImages });
          await this.checkBatchPause();
          return true;
        }
      } catch (err) {
        this.log(`✗ 提取笔记 "${title}" 出错: ${err.message}`, 'error');
      }
      return false;
    };

    const checkViewportNodeCount = async () => {
      const visibleItems = this.getSortedNoteItems().filter(item => {
        const rect = item.getBoundingClientRect();
        const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        return rect.top < containerRect.bottom && rect.bottom > containerRect.top;
      });
      return visibleItems.length;
    };

    while (notes.length < totalNotesInFolder) {
      if (this.isStopped) break;
      while (this.isPaused) { await this.delay(500); if (this.isStopped) break; }

      // 每扫描一轮，尝试唤醒一次
      wakeUp();

      let currentItems = this.getSortedNoteItems();
      
      // 使用碰撞检测器预处理当前批次的笔记ID
      const resolvedIds = this.resolveIdCollisions(currentItems, folderName);

      // 滑动窗口同步：重叠对齐
      let itemsToProcess = currentItems;
      if (lastAnchorIds.length > 0) {
        const anchorIdsSet = new Set(lastAnchorIds);
        let foundAnchorIndex = -1;
        
        for (let i = 0; i < currentItems.length; i++) {
          const item = currentItems[i];
          const itemNoteId = resolvedIds.get(item) || `${folderName}_${this.getElementStableKey(item)}`;
          if (anchorIdsSet.has(itemNoteId)) {
            foundAnchorIndex = i;
          }
        }
        
        if (foundAnchorIndex >= 0) {
          // 跳过直到最后一个锚点的节点
          itemsToProcess = currentItems.slice(foundAnchorIndex + 1);
          this.log(`滑动窗口对齐：跳过 ${foundAnchorIndex + 1} 个重叠节点`, 'info');
        } else {
          // 完全找不到锚点，可能滚太快出现断层
          this.log(`⚠ 滑动窗口断层：未找到任何锚点ID，可能存在漏单风险`, 'warning');
        }
      }

      let foundNewInThisBatch = false;
      processedInThisBatch = [];

      for (const item of itemsToProcess) {
        if (this.isStopped) break;
        if (notes.length >= totalNotesInFolder) break;
        
        if (await processNoteItem(item, resolvedIds)) {
          foundNewInThisBatch = true;
        }
      }

      // 更新上一屏末尾锚点
      if (processedInThisBatch.length > 0) {
        // 保存最后3个成功导出的noteId
        lastAnchorIds = processedInThisBatch.slice(-3);
        this.log(`更新锚点：${lastAnchorIds.length} 个节点`, 'info');
      }

      if (notes.length >= totalNotesInFolder) break;

      if (foundNewInThisBatch) idleRounds = 0;
      else idleRounds++;

      if (scrollContainer) {
        const prev = scrollContainer.scrollTop;
        const conservativeStep = Math.min(300, Math.floor((scrollContainer.clientHeight || 600) * 0.5));
        scrollContainer.scrollTop = prev + conservativeStep;
        
        await this.delay(800);
        
        const viewportNodeCount = await checkViewportNodeCount();
        if (viewportNodeCount < 3) {
          this.log(`检测到视口节点数过少(${viewportNodeCount})，等待渲染...`, 'warning');
          await this.delay(800);
        }

        const currentScrollTop = scrollContainer.scrollTop;
        if (currentScrollTop === prev || currentScrollTop === lastScrollTop) {
          scrollStuckCount++;
          if (scrollStuckCount >= 3) {
            this.log(`滚动位置卡住，尝试激活动作...`, 'warning');
            scrollContainer.scrollTop = Math.max(0, currentScrollTop - 10);
            await this.delay(200);
            scrollContainer.scrollTop = currentScrollTop + conservativeStep;
            scrollStuckCount = 0;
          }
        } else {
          scrollStuckCount = 0;
        }
        lastScrollTop = currentScrollTop;

        this.log(`正在寻找更多笔记... [${notes.length}/${totalNotesInFolder}] (空闲轮次: ${idleRounds}/${maxIdleRounds})`, 'info');
      } else {
        window.scrollBy(0, 300);
      }
      
      await this.delay(1000); 

      if (idleRounds >= maxIdleRounds) {
        if (!hasRefreshedListOnce) {
          this.log(`重试多次未果，尝试刷新列表状态...`, 'warning');
          const activeFolder = document.querySelector('.sidebar-item-2LDWD.active, .sidebar-item-3IBBu.active');
          if (activeFolder) activeFolder.click();
          await this.delay(2000);
          await this.ensureListStartsFromTop(scrollContainer);
          await this.waitForListStabilize(3000);
          hasRefreshedListOnce = true;
          idleRounds = 0;
        } else {
          this.log(`确认无法加载更多，已提取: ${notes.length}/${totalNotesInFolder}`, 'warning');
          break;
        }
      }
    }

    // 扫尾回旋（Tail Sweep）：如果数量不够，极慢速度重新扫描
    if (notes.length < totalNotesInFolder && !this.isStopped) {
      this.log(`执行扫尾回旋，当前: ${notes.length}/${totalNotesInFolder}，尝试捕获遗漏...`, 'warning');
      
      await this.ensureListStartsFromTop(scrollContainer);
      await this.waitForListStabilize(2000);

      let tailSweepRounds = 0;
      const maxTailSweepRounds = 5;

      while (notes.length < totalNotesInFolder && tailSweepRounds < maxTailSweepRounds && !this.isStopped) {
        const currentItems = this.getSortedNoteItems();
        const resolvedIds = this.resolveIdCollisions(currentItems, folderName);
        
        let foundInSweep = false;
        for (const item of currentItems) {
          if (notes.length >= totalNotesInFolder) break;
          if (await processNoteItem(item, resolvedIds)) {
            foundInSweep = true;
          }
        }

        if (!foundInSweep && scrollContainer) {
          scrollContainer.scrollTop += 100;
          await this.delay(500);
        }

        tailSweepRounds++;
        this.log(`扫尾回旋第 ${tailSweepRounds} 轮，已捕获: ${notes.length}/${totalNotesInFolder}`, 'info');
      }
    }

    if (notes.length < totalNotesInFolder) {
      this.log(`⚠ 最终结果: ${notes.length}/${totalNotesInFolder}，可能存在遗漏`, 'warning');
    } else {
      this.log(`✅ 完美达成: ${notes.length}/${totalNotesInFolder}`, 'success');
    }

    return { notes, totalNotesInFolder };
  },

  // 清洗文件名：移除方括号、圆括号和空格
  cleanFilename(name) {
    return name.replace(/[\[\]【】\(\)（）\s]/g, '');
  },

  // 从时间字符串提取 YYMMDD 格式
  extractDateFromTime(timeStr) {
    if (!timeStr) return this.formatDateYYMMDD(new Date());
    
    // 尝试匹配各种日期格式
    // 格式1: "2026.3.31" 或 "2026.03.31"
    let match = timeStr.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (match) {
      const year = match[1].slice(2); // 取后两位
      const month = match[2].padStart(2, '0');
      const day = match[3].padStart(2, '0');
      return `${year}${month}${day}`;
    }
    
    // 格式2: "3月31日" 或 "03月31日"
    match = timeStr.match(/(\d{1,2})月(\d{1,2})日/);
    if (match) {
      const currentYear = new Date().getFullYear().toString().slice(2);
      const month = match[1].padStart(2, '0');
      const day = match[2].padStart(2, '0');
      return `${currentYear}${month}${day}`;
    }
    
    // 格式3: "昨天" "前天" 等
    if (timeStr.includes('昨天')) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return this.formatDateYYMMDD(yesterday);
    }
    if (timeStr.includes('前天')) {
      const dayBefore = new Date();
      dayBefore.setDate(dayBefore.getDate() - 2);
      return this.formatDateYYMMDD(dayBefore);
    }
    
    // 默认返回当前日期
    return this.formatDateYYMMDD(new Date());
  },

  // 格式化日期为 YYMMDD
  formatDateYYMMDD(date) {
    const year = date.getFullYear().toString().slice(2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}${month}${day}`;
  },

  // 从 noteId 提取末4位哈希
  extractNoteIdSuffix(noteId) {
    if (!noteId) return '0000';
    // 对 noteId 进行简单哈希
    let hash = 0;
    for (let i = 0; i < noteId.length; i++) {
      const char = noteId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    // 取绝对值并转为16进制，取后4位
    const hex = Math.abs(hash).toString(16).toUpperCase();
    return hex.slice(-4).padStart(4, '0');
  },

  // 处理正文中的图片：抓取图片链接并下载为本地文件，返回用于替换的映射表
  async processImages(contentEl, noteTitle, folderName, noteTime, noteId) {
    const images = [];
    const imgElements = contentEl.querySelectorAll('img, img.image-view__img');
    
    if (imgElements.length === 0) return { images, imageMap: {} };

    this.log(`发现 ${imgElements.length} 张图片，开始下载...`);
    
    // 清洗文件夹名
    const folderPrefix = this.cleanFilename(this.sanitizeFilename(folderName));
    // 提取日期 YYMMDD
    const dateStr = this.extractDateFromTime(noteTime);
    // 提取 NoteID 末4位
    const noteIdSuffix = this.extractNoteIdSuffix(noteId);

    for (let i = 0; i < imgElements.length; i++) {
      if (this.isStopped) break;
      
      const img = imgElements[i];
      // 使用getAttribute('src')获取原始src，然后构建完整URL
      const src = img.getAttribute('src') || img.src || '';
      
      if (!src || src.startsWith('data:')) continue;
      
      // 构建完整的URL
      const fullUrl = new URL(src, window.location.origin).href;

      // 新的文件名格式：文件夹名_YYMMDD_NoteID末4位_序号.jpg
      const filename = `${folderPrefix}_${dateStr}_${noteIdSuffix}_${i + 1}.jpg`;

      // 使用随机延迟下载图片
      const imageDelay = this.getRandomDelay(500, 1500);
      await this.delay(imageDelay);
      const downloadedName = await this.downloadImage(fullUrl, filename);

      if (downloadedName) {
        images.push({
          index: i,
          originalSrc: fullUrl,
          localPath: `./${this.config.imageFolderName}/${downloadedName}`,
          filename: downloadedName,
          alt: img.alt || `图片${i + 1}`
        });
      } else {
        images.push({
          index: i,
          originalSrc: fullUrl,
          localPath: fullUrl,
          filename: null,
          alt: img.alt || `图片${i + 1}`
        });
      }
    }

    const imageMap = {};
    images.forEach(img => {
      imageMap[img.originalSrc] = img.localPath;
    });

    return { images, imageMap };
  },

  async checkFileInHistory(filename) {
    return new Promise((resolve) => {
      // 构建完整的文件路径（相对于Downloads文件夹）
      const fullPath = `${this.config.imageFolderName}/${filename}`;
      
      chrome.runtime.sendMessage({
        action: 'checkFileInHistory',
        filename: filename,
        imageFolderName: this.config.imageFolderName
      }, (response) => {
        if (response && response.exists) {
          this.log(`[跳过] 检测到已存在: ${fullPath}`, 'info');
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  },

  // 下载单张图片：在 content script 中携带登录态 fetch -> blob -> base64 -> 交给后台保存
  async downloadImage(url, filename) {
    try {
      this.log(`正在抓取图片: ${filename}`, 'info');
      
      // 1. 在前端通过 fetch 抓取图片（利用当前登录会话）
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        mode: 'cors'
      });

      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

      // 2. 将图片转换为 Base64 数据流（并识别后缀名）
      const blob = await response.blob();
      const mimeType = blob.type; // 获取真实的 MIME 类型
      const extension = this.getExtensionFromMime(mimeType);
      const finalFilename = filename.replace(/\.png$/, extension);

      const base64data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // 3. 将 Base64 数据流发送给后台执行下载
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'downloadFile',
          url: base64data, 
          filename: finalFilename,
          folder: this.config.imageFolderName
        }, (res) => {
          if (res && res.success) {
            this.downloadedImages++;
            this.log(`✓ 下载成功: ${this.config.imageFolderName}/${finalFilename}`, 'success');
            resolve(finalFilename); // 返回真实的带后缀的文件名
          } else {
            throw new Error(res?.error || '下载请求失败');
          }
        });
      });
    } catch (err) {
      this.log(`✗ 下载失败: ${filename} - ${err.message}`, 'error');
      this.failedImages++;
      return null;
    }
  },

  // 辅助函数：根据 MIME 类型获取后缀
  getExtensionFromMime(mimeType) {
    const map = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg'
    };
    return map[mimeType] || '.jpg'; // 默认使用 .jpg
  },

  // HTML -> Markdown：并用 imageMap 把图片链接替换为本地 images 路径
  htmlToMarkdown(html, imageMap) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    // 移除字数统计元素
    temp.querySelectorAll('.text-count').forEach(el => {
      el.remove();
    });
    
    temp.querySelectorAll('img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || '';
      if (imageMap[src]) {
        const newImg = document.createElement('span');
        newImg.textContent = `![${img.alt || '图片'}](${imageMap[src]})`;
        img.parentNode.replaceChild(newImg, img);
      }
    });

    let text = temp.innerHTML;
    text = text
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<div[^>]*>(.*?)<\/div>/gi, '$1\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<[^>]+>/g, '');

    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    let result = textarea.value.trim();
    
    // 定义需要过滤掉的垃圾文本/系统占位符
    const junkTexts = [
      '数据解析失败，暂不支持此类型的笔记',
      '数据解析失败',
      '暂不支持此类型的笔记',
      '0字',
      '正在加载'
    ];

    junkTexts.forEach(junk => {
      const escapedJunk = junk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedJunk, 'g');
      result = result.replace(regex, '');
    });

    result = result.trim();
    
    // 移除多余的空行
    result = result.replace(/\n{3,}/g, '\n\n');
    
    return result;
  },

  async generateOutput(isPartial = false) {
    const suffix = isPartial ? '_未全部导出' : '';

    // 按文件夹分组导出
    const grouped = {};
    this.allNotes.forEach(note => {
      if (!grouped[note.folder]) grouped[note.folder] = [];
      grouped[note.folder].push(note);
    });

    for (const [folderName, notes] of Object.entries(grouped)) {
      // 导出 Markdown
      const folderMarkdown = this.generateFolderMarkdown(folderName, notes, isPartial);
      this.downloadFolderMarkdown(folderMarkdown, folderName, suffix);
      
      // 导出 JSON (每个文件夹独立一个)
      const folderExportData = {
        folder: folderName,
        total: notes.length,
        exportTime: new Date().toISOString(),
        notes: notes,
        isPartial
      };
      this.downloadJSON(folderExportData, folderName, suffix);
      await this.markFolderExported(folderName, isPartial, notes.length);
    }

    const logMessage = isPartial 
      ? `⏹️ 导出已停止，已保存 ${this.allNotes.length} 条笔记。`
      : `✅ 导出完成！笔记: ${this.allNotes.length}, 图片: ${this.downloadedImages}`;
    this.log(logMessage, isPartial ? 'warning' : 'success');
  },

  markFolderExported(folderName, isPartial, notesCount) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['miNotesExportedFolders'], (result) => {
        const map = result.miNotesExportedFolders && typeof result.miNotesExportedFolders === 'object'
          ? result.miNotesExportedFolders
          : {};
        map[folderName] = {
          exportTime: new Date().toISOString(),
          isPartial: !!isPartial,
          notesCount: notesCount || 0
        };
        chrome.storage.local.set({ 'miNotesExportedFolders': map }, () => resolve());
      });
    });
  },

  generateFolderMarkdown(folderName, notes, isPartial = false) {
    let markdown = `# 小米笔记导出 - ${folderName}${isPartial ? ' (部分)' : ''}\n\n`;
    markdown += `导出时间: ${new Date().toLocaleString()}\n`;
    markdown += `笔记数量: ${notes.length}\n`;
    if (isPartial) {
      markdown += `> **注意：这是一个部分导出的文件，可能包含未完成的数据。**\n\n`;
    }
    markdown += `> 请将下载的图片放入 ${this.config.imageFolderName} 文件夹\n\n---\n\n`;

    notes.forEach(note => {
      markdown += `## ${note.title}\n\n`;
      if (note.time) markdown += `> 创建时间: ${this.formatTime(note.time)}\n\n`;
      markdown += `${note.markdown || note.text}\n\n---\n\n`;
    });

    return markdown;
  },

  // 触发下载 Markdown 文件
  downloadFolderMarkdown(content, folderName, suffix = '') {
    const sanitizedFolderName = this.sanitizeFilename(folderName);
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizedFolderName}${suffix}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // 触发下载 JSON 文件（mi_note_文件夹名.json）
  downloadJSON(data, folderName, suffix = '') {
    const sanitizedName = this.sanitizeFilename(folderName);
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mi_note_${sanitizedName}${suffix}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  formatTime(timeString) {
    if (!timeString) return '';
    
    // 检查是否包含年份
    if (timeString.includes('年')) {
      return timeString;
    }
    
    // 如果没有年份，添加当前年份
    const currentYear = new Date().getFullYear();
    return timeString.replace(/^(\d+)月(\d+)日/, `${currentYear}年$1月$2日`);
  },

  sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  getRandomDelay(min, max) {
    min = min || this.config.minDelay;
    max = max || this.config.maxDelay;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },

  async checkBatchPause() {
    this.batchCount++;
    if (this.batchCount >= this.config.batchSize) {
      this.log(`已处理 ${this.config.batchSize} 条笔记，休息 ${this.config.batchPause / 1000} 秒...`, 'info');
      
      // 在休息期间发送心跳请求
      await this.sendHeartbeat();
      
      await this.delay(this.config.batchPause);
      this.batchCount = 0;
    }
  },

  // 等待某个选择器出现（用于页面异步渲染）
  waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
        } else {
          reject(new Error(`等待元素超时: ${selector}`));
        }
      }, timeout);
    });
  },

  // 向侧边栏发送进度事件
  sendProgress(data) {
    chrome.runtime.sendMessage({
      action: 'progress',
      data: {
        ...data,
        notesCount: data.notesCount ?? this.allNotes.length,
        imagesCount: data.imagesCount ?? this.downloadedImages
      }
    });
  },

  // 向侧边栏发送日志事件
  log(message, type = 'info') {
    console.log(`[小米笔记导出] ${message}`);
    chrome.runtime.sendMessage({
      action: 'log',
      data: { message, type }
    });
  },
};

MiNotesExporter.init();
