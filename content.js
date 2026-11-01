// 内容脚本（运行在 i.mi.com/note/h5 页面内）：负责抓取目录/笔记、转换 Markdown、下载图片与导出文件

// ---------- 通用工具：并发池 ----------
// 按固定并发度跑一批异步任务，结果按原顺序返回。串行 await 是图片下载慢的主因。
async function runWithConcurrency(items, limit, worker) {
  const total = items.length;
  const results = new Array(total);
  if (total === 0) return results;
  const size = Math.max(1, Math.min(parseInt(limit, 10) || 1, total));
  let cursor = 0;
  const runners = [];
  for (let n = 0; n < size; n++) {
    runners.push((async () => {
      for (;;) {
        const i = cursor++;
        if (i >= total) return;
        results[i] = await worker(items[i], i);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

// ---------- 通用工具：ZIP 打包（仅存储不压缩，图片本就是压缩格式） ----------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 极简 ZIP 写入器：只支持"存储"方式和 UTF-8 文件名，够用且没有第三方依赖
function createZipWriter() {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralRecords = [];
  let offset = 0;

  const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  async function add(name, blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const now = new Date();
    const time = dosTime(now);
    const date = dosDate(now);

    const header = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);   // 本地文件头签名
    hv.setUint16(4, 20, true);           // 解压所需版本
    hv.setUint16(6, 0x0800, true);       // bit 11：文件名为 UTF-8
    hv.setUint16(8, 0, true);            // 压缩方式：0 = 存储
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true);
    hv.setUint32(22, data.length, true);
    hv.setUint16(26, nameBytes.length, true);
    hv.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    localParts.push(header, data);
    centralRecords.push({ nameBytes, crc, size: data.length, offset, time, date });
    offset += header.length + data.length;
  }

  function finish() {
    const cdParts = [];
    const cdOffset = offset;
    let cdSize = 0;

    for (const rec of centralRecords) {
      const h = new Uint8Array(46 + rec.nameBytes.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);  // 中央目录签名
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, rec.time, true);
      v.setUint16(14, rec.date, true);
      v.setUint32(16, rec.crc, true);
      v.setUint32(20, rec.size, true);
      v.setUint32(24, rec.size, true);
      v.setUint16(28, rec.nameBytes.length, true);
      v.setUint32(42, rec.offset, true);
      h.set(rec.nameBytes, 46);
      cdParts.push(h);
      cdSize += h.length;
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);   // 目录结束记录
    ev.setUint16(8, centralRecords.length, true);
    ev.setUint16(10, centralRecords.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);

    return new Blob([...localParts, ...cdParts, end], { type: 'application/zip' });
  }

  return { add, finish, get count() { return centralRecords.length; } };
}

const MiNotesExporter = {
  isRunning: false,
  isPaused: false,
  isStopped: false,
  allNotes: [],
  downloadedImages: 0,
  skippedImages: 0,
  failedImages: 0,
  reusedNotes: 0,
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
    batchPause: 15000,
    // 输出根目录（相对浏览器下载目录，留空则直接放下载目录根）
    outputDir: '',
    // 图片并发数：串行下载是慢的主因，4 左右既快又不容易触发风控
    imageConcurrency: 4,
    // 图片请求之间的最小间隔（毫秒），限制的是发起频率而非串行等待
    imageThrottleMs: 120,
    // 断点续传：命中缓存时直接复用上次的提取结果，不再点开笔记、不再下图片
    resume: true,
    // 打包方式：files = 逐个文件（可直接进 Obsidian），zip = 每个文件夹打成一个压缩包
    packMode: 'files',
    // 云端清单：用接口拿文件夹与笔记的权威元数据（条数、修改时间）。
    // 只读元数据，正文仍然走页面 DOM，所以转换质量不变。接口不可用时自动退回纯 DOM 模式。
    useCloudIndex: true
  },
  batchCount: 0,
  lastImageSlot: 0,
  noteCache: {},
  zipBuffer: {},
  _cacheTimer: null,
  // 接口清单缓存（5 分钟内复用，避免重复翻页）
  cloudIndex: null,
  // 上次各文件夹的导出时间，用于判断"云端有更新但被断点续传跳过"
  exportedFoldersMap: {},
  // 本次强制重新抓取的文件夹（检测到云端有更新时设置）
  _forceRefreshFolder: null,

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

      case 'clearCache':
        // 清空断点续传记录，下次从头导出
        await this.clearNoteCache();
        this.log('断点记录已清空，下次将重新导出全部笔记。', 'warning');
        sendResponse({ success: true });
        break;

      case 'getCacheStats':
        sendResponse({
          success: true,
          stats: Object.fromEntries(
            Object.entries(this.noteCache || {}).map(([f, b]) => [f, Object.keys(b || {}).length])
          )
        });
        break;

      case 'testCloudIndex': {
        // 侧边栏"测试接口"用：只看接口通不通，不做任何导出
        const idx = await this.fetchCloudIndex();
        if (idx.ok) {
          this.cloudIndex = idx;
          this.log(`接口正常：${idx.pages} 次翻页，${idx.folders.length} 个文件夹 / ${idx.notes.length} 条笔记`, 'success');
          idx.folders.forEach(f => this.log(`   · ${f.name}：${f.count} 条`, 'info'));
          sendResponse({ success: true, folders: idx.folders.length, notes: idx.notes.length, pages: idx.pages });
        } else {
          const why = this.describeCloudFailure(idx);
          this.log('接口不可用：' + why, 'error');
          sendResponse({ success: false, error: why });
        }
        break;
      }
    }
  },

  // 获取左侧文件夹列表（用于侧边栏展示与选择）
  // 优先走接口：自带真实条数，且不受侧边栏类名改版影响；接口不可用再退回读 DOM
  async getFolders() {
    // 只排除虚拟分类，不排除真实文件夹。
    // 「最近删除」是回收站，「全部笔记」是所有文件夹的并集（留下来会把每条笔记导两遍），
    // 「已完成 / 未完成」是待办的虚拟视图。
    // 特别注意：不要排除「私密笔记」——它是用户真实存在的文件夹，
    // v1.11.0 曾把它写进这张表，结果侧边栏里明明看得见、导出时却选不到。
    const excludeFolders = ['已完成', '未完成', '最近删除', '我的文件夹', '全部笔记'];

    const normName = (s) => String(s || '')
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .toLowerCase();

    // 读侧边栏里的文件夹名，失败返回空数组（接口可用时这一步只是补充，不能让它拖垮整体）
    const readDomFolders = async (timeout) => {
      try {
        await this.waitForElement('.sidebar-item-2LDWD, .sidebar-item-3IBBu', timeout);
      } catch (e) {
        return [];
      }
      return Array.from(document.querySelectorAll('.sidebar-item-2LDWD, .sidebar-item-3IBBu'))
        .map(el => this.getFolderName(el))
        .filter(name => name && name !== '未命名文件夹' && !excludeFolders.includes(name));
    };

    const index = await this.ensureCloudIndex();
    if (index.ok) {
      const fromApi = index.folders
        .filter(f => f.name && !excludeFolders.includes(f.name))
        .map(f => ({ name: f.name, noteCount: String(f.count) }));

      if (fromApi.length > 0) {
        // 接口没返回的文件夹用页面列表补上。私密笔记就是典型：
        // 它的内容不进 /note/full/page/，所以接口的 folders 里根本没有它。
        const domNames = await readDomFolders(1500);
        const known = new Set(fromApi.map(f => normName(f.name)));
        const extra = domNames.filter(n => !known.has(normName(n)));

        if (extra.length > 0) {
          extra.forEach(name => fromApi.push({ name, noteCount: '-' }));
          this.log(`接口未返回、已从页面补上 ${extra.length} 个文件夹：${extra.join('、')}`, 'info');
        }
        this.log(`文件夹列表：${fromApi.length} 个，共 ${index.notes.length} 条笔记`, 'info');
        return fromApi;
      }
    } else if (index.reason !== 'disabled') {
      this.log(this.describeCloudFailure(index) + '，改用页面解析', 'warning');
    }

    const domFolders = await readDomFolders(5000);
    return domFolders.map(name => ({ name, noteCount: '-' }));
  },

  // 从侧边栏文件夹 DOM 节点中提取文件夹名称
  // 注意：小米前端每次发版都会重编 CSS Module 哈希（.text-xxxxx 这类后缀必然变），
  // 所以这里必须三级兜底，不能只认一个写死的类名，否则改版后所有文件夹名会一起退化成"未命名文件夹"
  getFolderName(folder) {
    const textEl =
      folder.querySelector('.text-10cyJ') ||
      folder.querySelector('[class*="text-"]') ||
      folder.querySelector('[class*="name"]') ||
      folder.querySelector('span, div');

    const name = textEl ? (textEl.innerText || '').trim() : '';
    return name || '未命名文件夹';
  },

  // ---------- 云端清单：接口只读元数据 ----------
  // 目的：拿到权威的「文件夹有哪些、每个文件夹多少条、每条何时改过」。
  // 正文仍然从页面 DOM 取，所以 Markdown 转换质量与原来一致；这里只补上原来靠猜的三件事。
  // 任何一步失败都返回 { ok:false }，调用方退回原来的 DOM 解析，不影响已能用的流程。

  async fetchCloudIndex(options = {}) {
    const limit = 200;
    const maxPages = 200;                    // 4 万条上限，同时防止 syncTag 不前进导致死循环
    const timeoutMs = options.timeout || 15000;
    const notes = [];
    const folderNames = new Map();           // folderId -> 名称
    let syncTag = '';
    let pages = 0;

    const fetchPage = async (tag) => {
      const url = 'https://i.mi.com/note/full/page/?ts=' + Date.now() +
        '&limit=' + limit + '&syncTag=' + encodeURIComponent(tag || '');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const resp = await fetch(url, {
          method: 'GET',
          // 同源请求，登录态由浏览器自动附带，不需要手工填 cookie
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' },
          signal: controller ? controller.signal : undefined
        });
        if (resp.status === 401 || resp.status === 403) {
          return { ok: false, reason: 'auth', status: resp.status };
        }
        if (!resp.ok) {
          return { ok: false, reason: 'http', status: resp.status };
        }
        const body = await resp.json();
        // 小米的响应有两种外壳：{data:{...}} 和 {R,S,D}，都兼容一下
        const payload = body && (body.data || body.D);
        if (!payload || (!payload.entries && !payload.list)) {
          return { ok: false, reason: 'shape' };
        }
        return { ok: true, payload };
      } catch (err) {
        const aborted = err && err.name === 'AbortError';
        return { ok: false, reason: aborted ? 'timeout' : 'network', message: err && err.message };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    while (pages < maxPages) {
      const page = await fetchPage(syncTag);
      if (!page.ok) {
        // 第一页就失败说明这条路整体走不通，直接告诉调用方降级
        if (pages === 0) return page;
        break;
      }

      const p = page.payload;
      (p.folders || []).forEach(f => {
        if (f == null || f.id == null) return;
        const name = String(f.subject || '').trim();
        if (name) folderNames.set(String(f.id), name);
      });

      const list = p.entries || p.list || [];
      list.forEach(e => {
        if (!e || e.id == null) return;
        notes.push({
          id: String(e.id),
          folderId: String(e.folderId == null ? 0 : e.folderId),
          modifyDate: Number(e.modifyDate || 0),
          createDate: Number(e.createDate || 0),
          snippet: String(e.snippet || '')
        });
      });

      pages++;
      if (p.lastPage) break;
      const nextTag = p.syncTag;
      if (!nextTag || nextTag === syncTag) break;
      syncTag = nextTag;
    }

    if (notes.length === 0) {
      return { ok: false, reason: 'empty' };
    }

    // 按文件夹归并，顺便把没有名字的 folderId 标出来（大概率是接口新增的虚拟分类）
    const countByFolder = {};
    const byFolder = {};
    const unknownFolderIds = new Set();

    notes.forEach(n => {
      countByFolder[n.folderId] = (countByFolder[n.folderId] || 0) + 1;
      const name = folderNames.get(n.folderId);
      if (!name) {
        unknownFolderIds.add(n.folderId);
        return;
      }
      if (!byFolder[name]) byFolder[name] = [];
      byFolder[name].push(n);
    });

    const folders = Array.from(folderNames, ([id, name]) => ({
      id,
      name,
      count: countByFolder[id] || 0
    }));

    return {
      ok: true,
      fetchedAt: Date.now(),
      pages,
      notes,
      byFolder,
      folders,
      unknownFolderIds: Array.from(unknownFolderIds)
    };
  },

  // 取清单：默认 5 分钟内复用，force=true 强制重取
  async ensureCloudIndex(force = false) {
    if (!this.config.useCloudIndex) {
      return { ok: false, reason: 'disabled' };
    }
    if (!force && this.cloudIndex && Date.now() - this.cloudIndex.fetchedAt < 5 * 60 * 1000) {
      return this.cloudIndex;
    }
    const res = await this.fetchCloudIndex();
    if (res.ok) this.cloudIndex = res;
    return res;
  },

  // 把接口失败原因翻译成人话，日志里直接能看懂
  describeCloudFailure(res) {
    const map = {
      disabled: '云端清单已在设置里关闭',
      auth: '接口返回未登录，按 DOM 模式继续',
      http: `接口返回异常状态 ${res.status || ''}`.trim(),
      timeout: '接口请求超时',
      network: '接口请求失败',
      shape: '接口返回结构不认识（可能改版了）',
      empty: '接口返回空清单'
    };
    return map[res.reason] || ('接口不可用: ' + (res.message || res.reason || '未知原因'));
  },

  // 某个文件夹自上次导出后有没有云端更新
  // 依据：接口给的 modifyDate 与上次导出时间比较。用来解决"改了内容但断点续传直接跳过"的问题。
  getFolderChangeInfo(folderName) {
    const cloud = this.cloudIndex && this.cloudIndex.byFolder ? this.cloudIndex.byFolder[folderName] : null;
    if (!cloud || cloud.length === 0) return null;

    const last = this.exportedFoldersMap ? this.exportedFoldersMap[folderName] : null;
    const lastTs = last && last.exportTime ? Date.parse(last.exportTime) : 0;
    const updated = lastTs > 0 ? cloud.filter(n => (n.modifyDate || 0) > lastTs).length : 0;

    return {
      cloudTotal: cloud.length,
      lastExport: lastTs,
      updated,
      lastCachedCount: last && typeof last.notesCount === 'number' ? last.notesCount : null
    };
  },

  // 导出后核对：用接口的正文摘要去对本地导出的笔记，找出"云端有、本地没抓到"的
  // 只是提示，不阻断流程——摘要可能带富文本标签，比对本身存在误报
  verifyFolderAgainstCloud(folderName, notes) {
    const cloud = this.cloudIndex && this.cloudIndex.byFolder ? this.cloudIndex.byFolder[folderName] : null;
    if (!cloud || cloud.length === 0) return null;

    const normalize = (s) => String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, '')
      .toLowerCase();

    const localHeads = (notes || []).map(n => normalize((n.markdown || n.text || '').slice(0, 300)));

    const missing = [];
    cloud.forEach(c => {
      const head = normalize(c.snippet).slice(0, 12);
      if (head.length < 4) return;                 // 摘要太短，没法定
      const hit = localHeads.some(h => h.includes(head));
      if (!hit) missing.push({
        id: c.id,
        modifyDate: c.modifyDate,
        // 这里保留原文（只去标签），日志里读起来是人话
        head: String(c.snippet || '').replace(/<[^>]+>/g, '').trim().slice(0, 30)
      });
    });

    return {
      cloudTotal: cloud.length,
      localTotal: (notes || []).length,
      missing
    };
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

    this.isRunning = true;
    this.isPaused = false;
    this.isStopped = false;
    this.allNotes = [];
    this.downloadedImages = 0;
    this.skippedImages = 0;
    this.failedImages = 0;
    this.reusedNotes = 0;
    this.currentFolderIndex = 0;
    this.currentNoteIndex = 0;
    this.zipBuffer = {};
    this.lastImageSlot = 0;
    this.processedNotesByFolder = {};

    // 断点续传：把上次的提取结果读进来，命中就整条跳过
    await this.loadNoteCache();
    // 上次各文件夹的导出时间：用来判断"云端改过、但被断点续传跳过了"
    await this.loadExportedFolders();

    if (this.config.packMode === 'zip') {
      this.log('打包模式：为保证压缩包内图片完整，本次忽略断点记录、全部重新抓取', 'info');
    } else if (this.config.resume) {
      const buckets = Object.values(this.noteCache);
      const noteTotal = buckets.reduce((sum, b) => sum + Object.keys(b || {}).length, 0);
      if (noteTotal > 0) {
        this.log(`断点记录已就绪：${buckets.length} 个文件夹 / ${noteTotal} 条笔记，本次会跳过这部分`, 'info');
      }
    } else {
      this.log('断点续传已关闭，本次全部重新导出', 'warning');
    }

    // 云端清单：拿到权威条数与修改时间。失败就整体降级成原来的 DOM 模式，不阻断导出。
    if (this.config.useCloudIndex) {
      this.log('正在获取云端笔记清单...', 'info');
      const index = await this.ensureCloudIndex(true);
      if (index.ok) {
        this.log(`云端清单已就绪：${index.folders.length} 个文件夹 / ${index.notes.length} 条笔记`, 'success');
      } else {
        this.log(this.describeCloudFailure(index) + '，本次按页面解析的条数走', 'warning');
      }
    }

    this.sendProgress({ status: 'running', message: '开始导出...' });

    try {
      this.exportedFoldersInRun = new Set();

      // 按用户选择的名字去侧边栏里定位元素。
      // 接口返回的文件夹名和 DOM 里显示的可能差一个空格、半个括号，所以做两级兜底匹配，
      // 匹配不到再报警——这一步失败会表现为"未选择任何文件夹"，必须显式提示。
      const items = Array.from(document.querySelectorAll('.sidebar-item-2LDWD, .sidebar-item-3IBBu'));
      const normName = (s) => String(s || '')
        .replace(/[\s\u00a0]+/g, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .toLowerCase();
      const pool = items.map(el => ({ el, name: this.getFolderName(el), norm: normName(this.getFolderName(el)) }));

      this.folders = [];
      this.config.selectedFolders.forEach(want => {
        const wantNorm = normName(want);
        let hit = pool.find(r => r.name === want);
        if (!hit) hit = pool.find(r => r.norm === wantNorm);
        if (!hit) hit = pool.find(r => r.norm && wantNorm && (r.norm.includes(wantNorm) || wantNorm.includes(r.norm)));

        if (hit) {
          this.folders.push({ element: hit.el, name: want });
        } else {
          this.log(`⚠ 侧边栏里找不到文件夹 "${want}"，已跳过`, 'warning');
        }
      });

      if (this.folders.length === 0) {
        this.isRunning = false;
        return { success: false, error: '未选择任何文件夹（侧边栏里没找到对应条目，请先点一次"刷新文件夹列表"）' };
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
        const folderName = folder.name;

        this.sendProgress({
          status: 'running',
          currentFolder: folderName,
          currentFolderIndex: i + 1,
          totalFolders: this.folders.length,
          message: `正在处理文件夹: ${folderName}`
        });

        // 云端改动检测：这个文件夹上次导出之后如果又改过，本次强制重抓，
        // 否则断点续传会把改过的笔记当成"已导出"直接跳掉，用户永远拿不到新内容
        this._forceRefreshFolder = null;
        const change = this.getFolderChangeInfo(folderName);
        if (change && change.updated > 0 && this.config.resume) {
          this._forceRefreshFolder = folderName;
          this.log(
            `文件夹 "${folderName}" 距上次导出后云端有 ${change.updated} 条修改，本次强制重新抓取该文件夹`,
            'warning'
          );
        } else if (change && change.lastCachedCount != null && change.lastCachedCount > change.cloudTotal) {
          this.log(
            `文件夹 "${folderName}"：云端现有 ${change.cloudTotal} 条，上次导出记录是 ${change.lastCachedCount} 条，可能有笔记被删除`,
            'warning'
          );
        }

        try {
          folder.element.click();
          await this.delay(this.config.folderLoadDelay);
          
          const result = await this.extractNotesFromFolder(folderName);
          const notes = result.notes || [];
          const totalNotesInFolder = result.totalNotesInFolder || 0;
          this.allNotes.push(...notes);

          // 导出后用云端摘要核对一遍，把疑似漏掉的笔记列出来（只提示，不阻断）
          const check = this.verifyFolderAgainstCloud(folderName, notes);
          if (check) {
            if (check.missing.length === 0) {
              this.log(`核对通过：云端 ${check.cloudTotal} 条，本地 ${check.localTotal} 条`, 'success');
            } else {
              this.log(
                `⚠ 核对不完整：云端 ${check.cloudTotal} 条，本地 ${check.localTotal} 条，${check.missing.length} 条疑似漏抓`,
                'warning'
              );
              check.missing.slice(0, 5).forEach(m => {
                this.log(`   · 疑似遗漏：${m.head || m.id}${m.head ? '...' : ''}`, 'warning');
              });
              if (check.missing.length > 5) {
                this.log(`   · 其余 ${check.missing.length - 5} 条未逐一列出`, 'warning');
              }
            }
          }

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

      this._forceRefreshFolder = null;

      await this.exportAnyUnexportedFolders();
      await this.flushNoteCache();

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

  // 单文件夹导出：生成 Markdown / JSON / ZIP 并触发下载
  async exportFolderNow(folderName, notes, isPartial) {
    const suffix = isPartial ? '_未全部导出' : '';
    const folderMarkdown = this.generateFolderMarkdown(folderName, notes, isPartial);

    const folderExportData = {
      folder: folderName,
      total: notes.length,
      exportTime: new Date().toISOString(),
      notes: notes,
      isPartial: !!isPartial
    };

    if (this.config.packMode === 'zip') {
      await this.downloadFolderZip(folderName, suffix, folderMarkdown, folderExportData);
    } else {
      await this.downloadFolderMarkdown(folderMarkdown, folderName, suffix);
      await this.downloadJSON(folderExportData, folderName, suffix);
    }
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
    
    try {
      await this.waitForElement('.note-item-3E9te, [class*="note-item"]', 5000);
    } catch (e) {
      // 私密笔记锁着的时候，列表根本不渲染，5 秒后只会抛"等待元素超时"，
      // 那个报错看不出该怎么处理，这里换成一句能照着做的提示。
      this.log(
        `文件夹 "${folderName}"：5 秒内没出现任何笔记列表。` +
        `如果这是「私密笔记」，请先在页面上输入密码解锁，再点开始导出`,
        'warning'
      );
      return { notes, totalNotesInFolder: 0 };
    }
    
    const noteCountEl = document.querySelector('.note-count-select-1nzNf');
    let domCount = 0;
    if (noteCountEl) {
      const match = noteCountEl.innerText.match(/共\s*(\d+)\s*条笔记/);
      if (match) domCount = parseInt(match[1]);
    }
    
    if (domCount === 0) {
      domCount = document.querySelectorAll('.note-item-3E9te, [class*="note-item"]').length;
    }

    // 分母优先用接口给的真实条数：页面那句"共 N 条笔记"改版就没了，接口的数是准的。
    // 取两者较大的那个，避免接口少算（比如私密笔记不返回）导致循环提前退出、静默漏单。
    const cloudNotes = this.cloudIndex && this.cloudIndex.byFolder
      ? this.cloudIndex.byFolder[folderName]
      : null;
    const cloudCount = cloudNotes ? cloudNotes.length : 0;
    let totalNotesInFolder = Math.max(domCount, cloudCount);

    if (cloudCount > 0) {
      this.log(`文件夹 "${folderName}"：云端 ${cloudCount} 条 / 页面显示 ${domCount} 条，按 ${totalNotesInFolder} 条处理`, 'info');
    } else {
      this.log(`文件夹 "${folderName}" 预计有 ${totalNotesInFolder} 条笔记`);
    }

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

      // 断点续传：命中缓存就直接复用上次结果，不点开、不下载、不等待
      const cached = this.getCachedNote(folderName, noteId);
      if (cached) {
        processedNotes.add(noteId);
        notes.push(cached);
        processedInThisBatch.push(noteId);
        this.reusedNotes++;
        this.currentNoteIndex = notes.length;
        this.log(`⏭ [${notes.length}/${totalNotesInFolder}] 上次已导出，跳过: ${cached.title || '无标题'}`, 'info');
        this.sendProgress({
          status: 'running',
          currentNote: cached.title,
          currentNoteIndex: notes.length,
          totalNotesInFolder,
          notesCount: this.allNotes.length + notes.length,
          imagesCount: this.downloadedImages
        });
        return true;
      }

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
          const note = {
            folder: folderName,
            title,
            time,
            text: contentEl.innerText,
            markdown,
            images,
            imageCount: images.length
          };
          notes.push(note);
          // 落一份缓存：下次跑的时候这条笔记整条跳过（正文用 markdown，不存纯文本，省空间）
          this.cacheNote(folderName, noteId, {
            folder: folderName,
            title,
            time,
            markdown,
            images,
            imageCount: images.length
          });

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

  // 从 noteId 生成 8 位哈希后缀
  // 原来只取 4 位：同文件夹、同一天的两条笔记一旦撞车，图片会互相覆盖（下载用的是 overwrite，静默覆盖）
  extractNoteIdSuffix(noteId) {
    if (!noteId) return '00000000';
    // 对 noteId 进行简单哈希
    let hash = 0;
    for (let i = 0; i < noteId.length; i++) {
      const char = noteId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    // 取绝对值并转为16进制，取后8位
    const hex = Math.abs(hash).toString(16).toUpperCase();
    return hex.slice(-8).padStart(8, '0');
  },

  // 处理正文中的图片：并发抓取 -> 全部缓存 -> 统一提交，返回用于替换的映射表
  // 旧实现是"抓一张睡 1 秒再抓下一张"，一篇 10 张图的笔记要等十几秒，这是慢的主因
  async processImages(contentEl, noteTitle, folderName, noteTime, noteId) {
    const images = [];
    const imageMap = {};
    const blobs = [];

    // 1. 先收集正文里所有有效图片地址，保留出现顺序
    const tasks = [];
    Array.from(contentEl.querySelectorAll('img')).forEach((img, i) => {
      const src = img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:')) return;
      let fullUrl;
      try {
        fullUrl = new URL(src, window.location.origin).href;
      } catch (e) {
        return;
      }
      tasks.push({ index: i, url: fullUrl, alt: img.alt || `图片${i + 1}` });
    });

    if (tasks.length === 0) return { images, imageMap, blobs };

    const folderPrefix = this.cleanFilename(this.sanitizeFilename(folderName));
    const dateStr = this.extractDateFromTime(noteTime);
    const noteIdSuffix = this.extractNoteIdSuffix(noteId);
    const useZip = this.config.packMode === 'zip';

    // 2. 同一篇笔记里重复出现的同一张图，只抓一次、只存一份
    const byUrl = new Map();
    const unique = [];
    for (const t of tasks) {
      if (!byUrl.has(t.url)) {
        const base = `${folderPrefix}_${dateStr}_${noteIdSuffix}_${t.index + 1}.jpg`;
        byUrl.set(t.url, { url: t.url, baseName: base });
        unique.push(byUrl.get(t.url));
      }
    }

    this.log(
      `发现 ${tasks.length} 张图片${unique.length < tasks.length ? `（去重后 ${unique.length}）` : ''}，` +
      `并发 ${this.config.imageConcurrency} 开始抓取...`
    );

    // 3. 并发抓取（受全局节流控制），失败的自动重试一次
    const fetched = await runWithConcurrency(unique, this.config.imageConcurrency, async (item) => {
      if (this.isStopped) return null;
      return this.fetchImage(item.url, item.baseName);
    });

    // 4. 汇总抓到的 Blob
    const nameByUrl = new Map();
    unique.forEach((item, i) => {
      const res = fetched[i];
      if (res && res.blob) {
        nameByUrl.set(item.url, res.filename);
        blobs.push({ name: res.filename, blob: res.blob });
      }
    });

    // 5. 落地：逐文件模式并发交给下载器；打包模式先攒着，等整个文件夹处理完再打一个包
    if (useZip) {
      if (!this.zipBuffer[folderName]) this.zipBuffer[folderName] = [];
      this.zipBuffer[folderName].push(...blobs);
      this.downloadedImages += blobs.length;
      this.log(`已缓存 ${blobs.length} 张图片，文件夹处理完后统一打包`, 'info');
    } else {
      await runWithConcurrency(blobs, 3, async (b) => {
        await this.saveBlob(b.blob, b.name);
      });
    }

    // 6. 按正文顺序回填结果，保证 Markdown 里的图片顺序不乱
    for (const t of tasks) {
      const finalName = nameByUrl.get(t.url) || null;
      const localPath = finalName ? `./${this.config.imageFolderName}/${finalName}` : t.url;
      images.push({
        index: t.index,
        originalSrc: t.url,
        localPath,
        filename: finalName,
        alt: t.alt
      });
      imageMap[t.url] = localPath;
    }

    return { images, imageMap, blobs };
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

  // 抓取单张图片：复用登录态，带节流、体积上限与一次重试
  // 约定：无论成功失败都返回结果，绝不挂起
  async fetchImage(url, baseName) {
    const maxSize = this.config.maxImageSize || 10 * 1024 * 1024;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.isStopped) return null;
      try {
        await this.waitImageSlot();
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          mode: 'cors'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();

        if (blob.size > maxSize) {
          this.skippedImages++;
          this.log(
            `⏭ 跳过超大图片: ${baseName} ` +
            `(${(blob.size / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB)`,
            'warning'
          );
          return null;
        }

        // 按真实 MIME 决定后缀，不再一律存成 .jpg
        const filename = baseName.replace(/\.[A-Za-z0-9]+$/, '') + this.getExtensionFromMime(blob.type);
        return { blob, filename };
      } catch (err) {
        if (attempt === 0) {
          await this.delay(400);
          continue;
        }
        this.failedImages++;
        this.log(`✗ 抓取失败: ${baseName} - ${err.message}`, 'error');
        return null;
      }
    }
    return null;
  },

  // 令牌节流：控制"发起请求的频率"，而不是让每张图都白白等一秒
  async waitImageSlot() {
    const gap = Math.max(0, parseInt(this.config.imageThrottleMs, 10) || 0);
    if (!gap) return;
    const now = Date.now();
    const target = Math.max(now, (this.lastImageSlot || 0) + gap);
    this.lastImageSlot = target;
    const wait = target - now;
    if (wait > 0) await this.delay(wait);
  },

  // 把抓到的 Blob 交给后台写盘（走 chrome.downloads，支持子目录）
  async saveBlob(blob, filename) {
    const base64data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const folder = this.joinPath(this.config.outputDir, this.config.imageFolderName);

    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      timer = setTimeout(() => {
        this.failedImages++;
        this.log(`✗ 保存超时(30s): ${filename}`, 'error');
        finish(null);
      }, 30000);

      chrome.runtime.sendMessage({
        action: 'downloadFile',
        url: base64data,
        filename,
        folder
      }, (res) => {
        if (res && res.success) {
          this.downloadedImages++;
          this.log(`✓ 已保存: ${this.joinPath(folder, filename)}`, 'success');
          finish(filename);
        } else {
          this.failedImages++;
          this.log(`✗ 保存失败: ${filename} - ${res?.error || '后台无响应'}`, 'error');
          finish(null);
        }
      });
    });
  },

  // 拼接下载路径（相对浏览器下载目录），过滤空段、非法字符与多余斜杠
  joinPath(...parts) {
    return parts
      .filter(p => p !== undefined && p !== null && String(p).trim() !== '')
      .map(p => String(p).trim()
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/^[\/\\]+|[\/\\]+$/g, ''))
      .filter(Boolean)
      .join('/');
  },

  // ---------- 断点续传：按 文件夹 + noteId 缓存已提取的笔记 ----------
  loadNoteCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['miNotesCache'], (res) => {
        const cached = res && res.miNotesCache;
        this.noteCache = (cached && typeof cached === 'object') ? cached : {};
        resolve(this.noteCache);
      });
    });
  },

  // 上次各文件夹的导出时间与条数，用于云端改动检测
  loadExportedFolders() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['miNotesExportedFolders'], (res) => {
        const map = res && res.miNotesExportedFolders;
        this.exportedFoldersMap = (map && typeof map === 'object') ? map : {};
        resolve(this.exportedFoldersMap);
      });
    });
  },

  getCachedNote(folderName, noteId) {
    if (!this.config.resume) return null;
    // 打包模式下图片只存在于上一次运行的内存里，复用缓存会导致 zip 里缺图，
    // 所以打包模式一律重新抓取，保证产物完整
    if (this.config.packMode === 'zip') return null;
    // 检测到云端有新修改时，整个文件夹强制重抓，避免"改了内容却被缓存跳过"
    if (this._forceRefreshFolder && this._forceRefreshFolder === folderName) return null;
    const bucket = this.noteCache[folderName];
    return bucket ? bucket[noteId] || null : null;
  },

  cacheNote(folderName, noteId, payload) {
    if (!this.noteCache[folderName]) this.noteCache[folderName] = {};
    this.noteCache[folderName][noteId] = { ...payload, at: new Date().toISOString() };
    this.scheduleCacheFlush();
  },

  // 每 2 秒最多落盘一次，避免每条笔记都写一次 storage
  scheduleCacheFlush() {
    if (this._cacheTimer) return;
    this._cacheTimer = setTimeout(() => {
      this._cacheTimer = null;
      this.flushNoteCache();
    }, 2000);
  },

  flushNoteCache() {
    if (this._cacheTimer) {
      clearTimeout(this._cacheTimer);
      this._cacheTimer = null;
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ miNotesCache: this.noteCache }, () => resolve());
    });
  },

  async clearNoteCache() {
    this.noteCache = {};
    return new Promise((resolve) => {
      chrome.storage.local.remove(['miNotesCache'], (res) => resolve(res));
    });
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
      const folderMarkdown = this.generateFolderMarkdown(folderName, notes, isPartial);

      const folderExportData = {
        folder: folderName,
        total: notes.length,
        exportTime: new Date().toISOString(),
        notes: notes,
        isPartial
      };

      if (this.config.packMode === 'zip') {
        // 打包模式：md + json + 全部图片合成一个 zip，全程只有一次下载动作
        await this.downloadFolderZip(folderName, suffix, folderMarkdown, folderExportData);
      } else {
        await this.downloadFolderMarkdown(folderMarkdown, folderName, suffix);
        await this.downloadJSON(folderExportData, folderName, suffix);
      }

      await this.markFolderExported(folderName, isPartial, notes.length);
    }

    // 收尾：缓存与待打包数据都要刷干净
    await this.flushNoteCache();
    this.zipBuffer = {};

    let logMessage = isPartial
      ? `⏹️ 导出已停止，已保存 ${this.allNotes.length} 条笔记。`
      : `✅ 导出完成！笔记: ${this.allNotes.length}, 图片: ${this.downloadedImages}`;
    if (this.reusedNotes) logMessage += `，复用上次结果: ${this.reusedNotes} 条`;
    if (this.failedImages) logMessage += `，失败图片: ${this.failedImages} 张`;
    this.log(logMessage, isPartial ? 'warning' : 'success');
  },

  // 文件夹打包：md + json + 图片合成单个 zip，只需要一次下载动作
  async downloadFolderZip(folderName, suffix, markdownText, jsonData) {
    const sanitized = this.sanitizeFilename(folderName);
    const images = this.zipBuffer[folderName] || [];
    const zipName = `${sanitized}${suffix}.zip`;
    const startedAt = Date.now();

    this.log(`正在打包 "${folderName}"：${images.length} 张图片...`, 'info');

    const zip = createZipWriter();
    await zip.add(`${sanitized}${suffix}.md`, new Blob([markdownText], { type: 'text/markdown' }));
    await zip.add(`mi_note_${sanitized}${suffix}.json`, new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' }));
    for (const img of images) {
      if (this.isStopped) break;
      await zip.add(`${this.config.imageFolderName}/${img.name}`, img.blob);
    }

    const blob = zip.finish();
    this.zipBuffer[folderName] = [];

    const ok = await this.saveFileBlob(blob, zipName, true);
    if (ok) {
      this.log(
        `✅ 已打包: ${zipName}（${(blob.size / 1048576).toFixed(1)}MB，${zip.count} 个文件，` +
        `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
        'success'
      );
    } else {
      this.log(`✗ 打包失败: ${zipName}`, 'error');
    }
  },

  // 保存任意 Blob 到输出目录。
  // base64 走消息通道有体积上限，超过 40MB 的包退回页面内 <a download>（会落到下载目录根，浏览器限制）
  async saveFileBlob(blob, filename, allowFallback = false) {
    const LIMIT = 40 * 1024 * 1024;

    if (allowFallback && blob.size > LIMIT) {
      this.log(`文件较大（${(blob.size / 1048576).toFixed(0)}MB），改由浏览器直接保存，会落在下载目录根`, 'warning');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    }

    const base64data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'downloadFile',
        url: base64data,
        filename,
        folder: this.config.outputDir || ''
      }, (res) => resolve(!!(res && res.success)));
    });
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
        // 同步回内存，避免同一次运行里再判断时用的是旧快照
        this.exportedFoldersMap = map;
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

  // 保存 Markdown 到输出目录（必须走后台下载，页面内 a 标签无法写入子目录）
  async downloadFolderMarkdown(content, folderName, suffix = '') {
    const sanitizedFolderName = this.sanitizeFilename(folderName);
    const name = `${sanitizedFolderName}${suffix}.md`;
    const blob = new Blob([content], { type: 'text/markdown' });
    const ok = await this.saveFileBlob(blob, name);
    if (ok) this.log(`✓ 已保存 Markdown: ${this.joinPath(this.config.outputDir, name)}`, 'success');
  },

  // 保存 JSON（mi_note_文件夹名.json）
  async downloadJSON(data, folderName, suffix = '') {
    const sanitizedName = this.sanitizeFilename(folderName);
    const name = `mi_note_${sanitizedName}${suffix}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const ok = await this.saveFileBlob(blob, name);
    if (ok) this.log(`✓ 已保存 JSON: ${this.joinPath(this.config.outputDir, name)}`, 'success');
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
