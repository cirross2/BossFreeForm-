const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  shell,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const driveSync = require('./driveSync');

let mainWindow = null;
let googleWebWindow = null;
let tray = null;
let boundsSaveTimer = null;

const DEFAULT_HOTKEY = 'Ctrl+Shift+Space';
const ICON_ICO_PATH = path.join(__dirname, '../../assets/icon.ico');
const ICON_PNG_PATH = path.join(__dirname, '../../assets/icon.png');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.boss.bossfreeform');
}

// Prevent Electron's intrusive native modal dialog on transient FSWatcher / Google Drive virtual mount errors
process.on('uncaughtException', (err) => {
  console.warn('[Main] Caught uncaughtException:', err?.stack || err?.message || err);
  if (err && /watch|FSWatcher|UNKNOWN|ENOENT|EPERM|EACCES|EBUSY/i.test(String(err.message || err.stack || ''))) {
    try {
      driveSync.startWatching();
    } catch (_) {}
  }
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Main] Caught unhandledRejection:', reason?.stack || reason?.message || reason);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function normalizeAcceleratorForElectron(hotkeyStr) {
  return String(hotkeyStr || DEFAULT_HOTKEY)
    .trim()
    .replace(/\bCtrl\b/gi, 'CommandOrControl')
    .replace(/\bControl\b/gi, 'CommandOrControl')
    .replace(/\bWin\b/gi, 'Super')
    .replace(/\s+/g, '');
}

function formatHotkeyDisplay(hotkeyStr) {
  return String(hotkeyStr || DEFAULT_HOTKEY)
    .trim()
    .replace(/\bCommandOrControl\b/gi, 'Ctrl')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\s+/g, '');
}

function toggleMainWindowVisibility() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    saveCurrentWindowBounds();
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function registerAppGlobalHotkey(requestedHotkey) {
  const prevHotkey = formatHotkeyDisplay(driveSync.config.hotkey || DEFAULT_HOTKEY);
  const displayHotkey = formatHotkeyDisplay(requestedHotkey || DEFAULT_HOTKEY);
  const electronAccel = normalizeAcceleratorForElectron(displayHotkey);

  try {
    globalShortcut.unregisterAll();
  } catch (_) {}

  try {
    const ok = globalShortcut.register(electronAccel, toggleMainWindowVisibility);
    if (!ok) {
      // Fallback to previous hotkey if registration failed
      try {
        globalShortcut.register(normalizeAcceleratorForElectron(prevHotkey), toggleMainWindowVisibility);
      } catch (_) {}
      return {
        success: false,
        hotkey: prevHotkey,
        error: `'${displayHotkey}' 단축키가 다른 프로그램에서 이미 사용 중이거나 지원되지 않습니다.`
      };
    }

    driveSync.saveConfig({ hotkey: displayHotkey });
    updateTrayMenu();
    return {
      success: true,
      hotkey: displayHotkey
    };
  } catch (err) {
    try {
      globalShortcut.register(normalizeAcceleratorForElectron(prevHotkey), toggleMainWindowVisibility);
    } catch (_) {}
    return {
      success: false,
      hotkey: prevHotkey,
      error: `단축키 등록 오류: ${err.message}`
    };
  }
}

function getWindowIcon() {
  if (fs.existsSync(ICON_ICO_PATH)) {
    const img = nativeImage.createFromPath(ICON_ICO_PATH);
    if (!img.isEmpty()) return img;
  }
  if (fs.existsSync(ICON_PNG_PATH)) {
    const img = nativeImage.createFromPath(ICON_PNG_PATH);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

function createTrayIcon() {
  if (fs.existsSync(ICON_PNG_PATH)) {
    const img = nativeImage.createFromPath(ICON_PNG_PATH);
    if (!img.isEmpty()) {
      return img.resize({ width: 24, height: 24, quality: 'best' });
    }
  }
  if (fs.existsSync(ICON_ICO_PATH)) {
    const img = nativeImage.createFromPath(ICON_ICO_PATH);
    if (!img.isEmpty()) {
      return img.resize({ width: 24, height: 24, quality: 'best' });
    }
  }
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - 16;
      const dy = y - 16;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 14) {
        buf[idx] = 255;     // B
        buf[idx + 1] = 132; // G
        buf[idx + 2] = 10;  // R (#0a84ff)
        buf[idx + 3] = 255;
      } else {
        buf[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function getDefaultWindowBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1520, primary.width - 80);
  const height = Math.min(940, primary.height - 80);
  const x = Math.round(primary.x + (primary.width - width) / 2);
  const y = Math.round(primary.y + (primary.height - height) / 2);
  return { x, y, width, height, isMaximized: false };
}

function getValidatedWindowBounds(saved) {
  const fallback = getDefaultWindowBounds();
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
    return fallback;
  }
  const width = Math.max(960, Math.round(saved.width));
  const height = Math.max(620, Math.round(saved.height));
  const x = typeof saved.x === 'number' ? Math.round(saved.x) : fallback.x;
  const y = typeof saved.y === 'number' ? Math.round(saved.y) : fallback.y;

  // Verify the saved position intersects at least one display workArea
  const displays = screen.getAllDisplays();
  const isVisible = displays.some((d) => {
    const wa = d.workArea;
    return (
      x + width > wa.x + 60 &&
      x < wa.x + wa.width - 60 &&
      y + height > wa.y + 40 &&
      y < wa.y + wa.height - 40
    );
  });

  if (!isVisible) return fallback;
  return { x, y, width, height, isMaximized: Boolean(saved.isMaximized) };
}

function saveCurrentWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMax = mainWindow.isMaximized();
    const prev = driveSync.config.windowBounds || getDefaultWindowBounds();
    const bounds = isMax ? prev : mainWindow.getBounds();
    driveSync.saveConfig({
      windowBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: isMax
      }
    });
  }, 250);
}

function resetMainWindowBounds() {
  const def = getDefaultWindowBounds();
  driveSync.saveConfig({ windowBounds: def });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setBounds({ x: def.x, y: def.y, width: def.width, height: def.height }, true);
    mainWindow.show();
    mainWindow.focus();
  }
  return { success: true, bounds: def };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (fs.existsSync(ICON_ICO_PATH) && typeof mainWindow.setIcon === 'function') {
    try {
      mainWindow.setIcon(ICON_ICO_PATH);
    } catch (_) {}
  }
  mainWindow.show();
  mainWindow.focus();
  triggerEventDrivenCloudSync();
}

function createMainWindow() {
  const cfg = driveSync.config;
  const initial = getValidatedWindowBounds(cfg.windowBounds);
  const iconTarget = fs.existsSync(ICON_ICO_PATH) ? ICON_ICO_PATH : getWindowIcon();

  mainWindow = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: '#121214',
    title: 'BossFreeForm — Infinite Canvas x Google Drive',
    icon: iconTarget,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (iconTarget && typeof mainWindow.setIcon === 'function') {
    try {
      mainWindow.setIcon(iconTarget);
    } catch (_) {}
  }

  // Prevent browser navigation when dragging & dropping links/files from Chrome/Explorer
  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    if (initial.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('moved', saveCurrentWindowBounds);
  mainWindow.on('resized', saveCurrentWindowBounds);
  mainWindow.on('maximize', saveCurrentWindowBounds);
  mainWindow.on('unmaximize', saveCurrentWindowBounds);
  mainWindow.on('focus', () => triggerEventDrivenCloudSync());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      saveCurrentWindowBounds();
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function openGoogleWebDriveWindow() {
  if (googleWebWindow && !googleWebWindow.isDestroyed()) {
    googleWebWindow.show();
    googleWebWindow.focus();
    return;
  }

  googleWebWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    title: 'Google Drive 계정 로그인 및 클라우드 관리',
    icon: getWindowIcon() || ICON_ICO_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:bossfreeform-google-session',
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  googleWebWindow.loadURL('https://drive.google.com');
  googleWebWindow.on('closed', () => {
    googleWebWindow = null;
  });
}

function parseVideoInfoFromUrl(rawUrl) {
  const url = (rawUrl || '').trim();
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?[^#\s]*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i
  );
  if (ytMatch) {
    return {
      isVideo: true,
      videoType: 'youtube',
      youtubeId: ytMatch[1],
      embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}`,
      thumbnail: `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`
    };
  }
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/i);
  if (vimeoMatch) {
    return {
      isVideo: true,
      videoType: 'vimeo',
      vimeoId: vimeoMatch[1],
      embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}`
    };
  }
  if (/\.(mp4|webm|mov|ogg)(\?.*)?$/i.test(url)) {
    return {
      isVideo: true,
      videoType: 'direct',
      videoUrl: url
    };
  }
  return { isVideo: false };
}

// Fetch URL OpenGraph / Title Metadata & Detect YouTube/Video (Guaranteed non-blocking resolution)
function fetchUrlMetadata(rawUrl, redirectDepth = 0) {
  return new Promise((resolve) => {
    let targetUrl = (rawUrl || '').trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (_) {
      return resolve({
        url: rawUrl,
        title: rawUrl,
        description: '',
        domain: '',
        favicon: ''
      });
    }

    const domain = parsedUrl.hostname.replace(/^www\./, '');
    const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const videoInfo = parseVideoInfoFromUrl(targetUrl);
    const youtubeId = videoInfo.youtubeId || null;

    let settled = false;
    let html = '';
    let req = null;

    const decodeEntities = (str) =>
      String(str || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .trim();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        if (req) req.destroy();
      } catch (_) {}

      const extractMeta = (prop) => {
        const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
        const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
        const m = html.match(r1) || html.match(r2);
        return m ? decodeEntities(m[1]) : '';
      };
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title =
        extractMeta('og:title') ||
        extractMeta('twitter:title') ||
        (titleTag ? decodeEntities(titleTag[1].replace(/\s+/g, ' ')) : '') ||
        (youtubeId ? `YouTube 동영상 (${youtubeId})` : domain);
      const description =
        extractMeta('og:description') ||
        extractMeta('description') ||
        extractMeta('twitter:description') ||
        targetUrl;
      const thumbnail =
        extractMeta('og:image') ||
        videoInfo.thumbnail ||
        '';

      resolve({
        url: targetUrl,
        title: title.slice(0, 140),
        description: description.slice(0, 240),
        domain,
        favicon,
        ...videoInfo,
        thumbnail
      });
    };

    const hardTimer = setTimeout(() => {
      finish();
    }, 3000);

    try {
      const client = parsedUrl.protocol === 'https:' ? https : http;
      req = client.get(
        targetUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml'
          },
          timeout: 2800
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const loc = res.headers.location;
            res.destroy();
            if (redirectDepth < 2) {
              settled = true;
              clearTimeout(hardTimer);
              let nextUrl = loc;
              try {
                nextUrl = new URL(loc, targetUrl).toString();
              } catch (_) {}
              return fetchUrlMetadata(nextUrl, redirectDepth + 1).then(resolve);
            }
            return finish();
          }

          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            html += chunk;
            if (html.length > 65000) {
              finish();
              try { res.destroy(); } catch (_) {}
            }
          });
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', finish);
        }
      );

      req.on('error', finish);
      req.on('timeout', finish);
    } catch (_) {
      finish();
    }
  });
}

// Parse HTML <table> or Markdown Table or TSV into 2D array if present (for smart clipboard paste)
function tryParseTableFromHtml(html) {
  if (!html || !/<table[\s>]/i.test(html)) return null;
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!trMatches || trMatches.length < 1) return null;
  const rows = [];
  for (const tr of trMatches) {
    const cellMatches = tr.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi);
    if (!cellMatches || !cellMatches.length) continue;
    const row = cellMatches.map((cellHtml) =>
      cellHtml
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .trim()
    );
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows.length >= 1 && (rows.length >= 2 || rows[0].length >= 2) ? rows : null;
}

function tryParseTableFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 1) return null;

  // 1. Check TSV (Excel / Google Sheets copy-paste)
  if (lines.length >= 2 && lines[0].includes('\t') && lines[1].includes('\t')) {
    return lines.map((l) => l.split('\t').map((c) => c.trim()));
  }
  if (lines.length === 1 && (lines[0].match(/\t/g) || []).length >= 2) {
    return [lines[0].split('\t').map((c) => c.trim())];
  }

  // 2. Check Markdown Table
  const mdTableLines = lines.filter((l) => l.trim().startsWith('|') && l.trim().endsWith('|'));
  if (mdTableLines.length >= 2) {
    const rows = [];
    for (const line of mdTableLines) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      rows.push(cells);
    }
    if (rows.length >= 2) return rows;
  }

  return null;
}

// Setup IPC Handlers
function setupIpc() {
  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveCurrentWindowBounds();
      mainWindow.hide();
    }
  });

  ipcMain.handle('window:reset-bounds', () => {
    return resetMainWindowBounds();
  });

  ipcMain.handle('board:list', () => driveSync.listBoards());
  ipcMain.handle('board:get', (_, boardId) => driveSync.getBoard(boardId));
  ipcMain.handle('board:save', (_, board) => {
    const res = driveSync.saveBoard(board);
    pushBoardToVercelCloudRelay(board);
    return res;
  });
  ipcMain.handle('board:create', (_, opts) => {
    const res = driveSync.createNewBoard(opts);
    pushBoardToVercelCloudRelay(res);
    return res;
  });
  ipcMain.handle('board:delete', (_, boardId) => {
    const res = driveSync.deleteBoard(boardId);
    deleteBoardFromVercelCloudRelay(boardId);
    return res;
  });

  ipcMain.handle('asset:save-path', (_, { filePath, name }) => {
    const saved = driveSync.saveAssetFromPath(filePath, name);
    if (saved?.assetFileName) pushAssetToVercelCloudRelay(saved.assetFileName);
    return saved;
  });

  ipcMain.handle('asset:save-buffer', (_, { buffer, ext, name }) => {
    const buf = Buffer.from(buffer);
    const saved = driveSync.saveAssetFromBuffer(buf, ext || '.bin', name || 'dropped_file');
    if (saved?.assetFileName) pushAssetToVercelCloudRelay(saved.assetFileName);
    return {
      ...saved,
      size: buf.length
    };
  });

  ipcMain.handle('asset:download-file', async (_, { filePath, assetFileName, fileName } = {}) => {
    try {
      const assetsDir = driveSync.getAssetsDir();
      const safeAssetName = path.basename(String(assetFileName || filePath || ''));
      let srcPath = '';
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        srcPath = filePath;
      } else if (safeAssetName) {
        const candidate = path.join(assetsDir, safeAssetName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          srcPath = candidate;
        }
      }

      // If not yet downloaded locally from Cloud Relay / Google Drive, fetch on demand
      if (!srcPath && safeAssetName) {
        const fetchedPath = await fetchAssetFromVercelCloudRelayAsync(safeAssetName);
        if (fetchedPath && fs.existsSync(fetchedPath)) {
          srcPath = fetchedPath;
        } else if (driveSync.isOAuthConnected()) {
          await driveSync.syncToGoogleCloud().catch(() => {});
          const candidateAfterSync = path.join(assetsDir, safeAssetName);
          if (fs.existsSync(candidateAfterSync)) {
            srcPath = candidateAfterSync;
          }
        }
      }

      if (!srcPath || !fs.existsSync(srcPath)) {
        return { success: false, error: '원본 파일을 찾을 수 없습니다.' };
      }

      const fallbackName = safeAssetName.replace(/^\d{10,14}_/, '') || 'downloaded_file';
      const cleanFileName = String(fileName || fallbackName)
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim() || fallbackName;
      const ext = path.extname(cleanFileName).replace(/^\./, '').toLowerCase();
      let defaultDir = app.getPath('downloads');
      try {
        if (!defaultDir || !fs.existsSync(defaultDir)) defaultDir = app.getPath('desktop');
      } catch (_) {
        defaultDir = os.homedir();
      }

      const filters = ext
        ? [
            { name: `${ext.toUpperCase()} 파일 (*.${ext})`, extensions: [ext] },
            { name: '모든 파일 (*.*)', extensions: ['*'] }
          ]
        : [{ name: '모든 파일 (*.*)', extensions: ['*'] }];

      const res = await dialog.showSaveDialog(mainWindow, {
        title: '구글 드라이브 첨부 파일 다운로드 (다른 이름으로 저장)',
        defaultPath: path.join(defaultDir, cleanFileName),
        filters
      });
      if (res.canceled || !res.filePath) {
        return { canceled: true };
      }
      if (ext === 'csv' || path.extname(res.filePath).toLowerCase() === '.csv') {
        const rawBuf = fs.readFileSync(srcPath);
        const hasBom = rawBuf.length >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf;
        const outBuf = hasBom ? rawBuf : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawBuf]);
        fs.writeFileSync(res.filePath, outBuf);
      } else {
        fs.copyFileSync(srcPath, res.filePath);
      }
      return {
        success: true,
        savedPath: res.filePath,
        fileName: path.basename(res.filePath)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dialog:pick-files', async (_, opts = {}) => {
    const filters = opts.imagesOnly
      ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
      : [{ name: 'All Files', extensions: ['*'] }];
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters
    });
    if (res.canceled || !res.filePaths.length) return [];
    return res.filePaths.map((fp) => {
      const saved = driveSync.saveAssetFromPath(fp);
      if (saved?.assetFileName) pushAssetToVercelCloudRelay(saved.assetFileName);
      return saved;
    });
  });

  ipcMain.handle('clipboard:read-smart', () => {
    try {
      const fnBuf = clipboard.readBuffer('FileNameW');
      if (fnBuf && fnBuf.length > 2) {
        const copiedPath = fnBuf.toString('utf16le').replace(/\0.*$/, '').trim();
        if (copiedPath && fs.existsSync(copiedPath) && fs.statSync(copiedPath).isFile()) {
          const saved = driveSync.saveAssetFromPath(copiedPath, path.basename(copiedPath));
          if (saved?.assetFileName) pushAssetToVercelCloudRelay(saved.assetFileName);
          return {
            kind: 'file',
            asset: saved
          };
        }
      }
    } catch (_) {}

    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const pngBuf = img.toPNG();
      const size = img.getSize();
      const saved = driveSync.saveAssetFromBuffer(pngBuf, '.png', 'clipboard_img');
      if (saved?.assetFileName) pushAssetToVercelCloudRelay(saved.assetFileName);
      return {
        kind: 'image',
        asset: saved,
        width: size.width,
        height: size.height
      };
    }

    const html = clipboard.readHTML() || '';
    const htmlTable = tryParseTableFromHtml(html);
    if (htmlTable) {
      return {
        kind: 'table',
        tableData: htmlTable,
        rawText: clipboard.readText() || ''
      };
    }

    const text = (clipboard.readText() || '').trim();
    if (!text) return { kind: 'empty' };

    const tableData = tryParseTableFromText(text);
    if (tableData) {
      return {
        kind: 'table',
        tableData,
        rawText: text
      };
    }

    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
      const normalizedUrl = /^https?:\/\//i.test(text) ? text : `https://${text}`;
      const videoInfo = parseVideoInfoFromUrl(normalizedUrl);
      return {
        kind: 'url',
        url: normalizedUrl,
        ...videoInfo
      };
    }

    return {
      kind: 'text',
      text
    };
  });

  ipcMain.handle('clipboard:write-text', (_, text) => {
    clipboard.writeText(text || '');
    return true;
  });

  ipcMain.handle('clipboard:write-image', (_, { filePath, dataUrl } = {}) => {
    try {
      let nImg = null;
      if (filePath && fs.existsSync(filePath)) {
        nImg = nativeImage.createFromPath(filePath);
      } else if (dataUrl && dataUrl.startsWith('data:image/')) {
        nImg = nativeImage.createFromDataURL(dataUrl);
      }
      if (nImg && !nImg.isEmpty()) {
        clipboard.writeImage(nImg);
        return { ok: true };
      }
      return { ok: false, error: '이미지 데이터를 읽을 수 없습니다' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pdf:read-base64', (_, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'PDF 파일을 찾을 수 없습니다' };
      }
      const buf = fs.readFileSync(filePath);
      return { ok: true, base64: buf.toString('base64'), size: buf.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('screen:capture-asset', async () => {
    const wasVisible = mainWindow && mainWindow.isVisible();
    if (wasVisible) mainWindow.hide();
    await new Promise((r) => setTimeout(r, 220));

    const tempPath = path.join(os.tmpdir(), `bossfreeform_cap_${Date.now()}.png`);
    const psScript = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bitmap.Save('${tempPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose();`;

    const result = await new Promise((resolve) => {
      exec(`powershell -NoProfile -Command "${psScript}"`, (err) => {
        if (err || !fs.existsSync(tempPath)) {
          resolve({ error: err ? err.message : '화면 캡처 실패' });
        } else {
          const asset = driveSync.saveAssetFromPath(tempPath, `화면캡처_${Date.now().toString().slice(-4)}.png`);
          try { fs.unlinkSync(tempPath); } catch (_) {}
          resolve({ asset });
        }
      });
    });

    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    if (result?.asset?.assetFileName) {
      pushAssetToVercelCloudRelay(result.asset.assetFileName);
    }
    return result;
  });

  ipcMain.handle('url:fetch-metadata', (_, url) => fetchUrlMetadata(url));
  ipcMain.handle('shell:open-external', (_, url) => shell.openExternal(url));
  ipcMain.handle('shell:open-path', async (_, p) => {
    if (!p) return '';
    let targetPath = p;
    if (!fs.existsSync(targetPath)) {
      const safeName = path.basename(String(p));
      const candidate = path.join(driveSync.getAssetsDir(), safeName);
      if (fs.existsSync(candidate)) {
        targetPath = candidate;
      } else {
        const fetched = await fetchAssetFromVercelCloudRelayAsync(safeName);
        if (fetched && fs.existsSync(fetched)) targetPath = fetched;
      }
    }
    return shell.openPath(targetPath);
  });

  ipcMain.handle('export:table-csv', async (_, { title, tableData }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '표(Table)를 Excel CSV 파일로 내보내기',
      defaultPath: `${(title || 'BossFreeForm_Table').replace(/[\\/:*?"<>|]/g, '_')}.csv`,
      filters: [{ name: 'CSV Spreadsheet (*.csv)', extensions: ['csv'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const csvLines = (tableData || []).map((row) =>
      row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    );
    fs.writeFileSync(res.filePath, '\uFEFF' + csvLines.join('\r\n'), 'utf-8');
    return { success: true, filePath: res.filePath };
  });

  ipcMain.handle('asset:read-text', async (_, { filePath, assetFileName } = {}) => {
    try {
      let srcPath = '';
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        srcPath = filePath;
      } else {
        const safeName = path.basename(String(assetFileName || filePath || ''));
        if (safeName) {
          const candidate = path.join(driveSync.getAssetsDir(), safeName);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            srcPath = candidate;
          } else {
            const fetched = await fetchAssetFromVercelCloudRelayAsync(safeName);
            if (fetched && fs.existsSync(fetched)) srcPath = fetched;
          }
        }
      }
      if (!srcPath || !fs.existsSync(srcPath)) {
        return { ok: false, error: '파일을 찾을 수 없습니다.' };
      }
      const text = fs.readFileSync(srcPath, 'utf-8').replace(/^\uFEFF/, '');
      return { ok: true, text, filePath: srcPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:markdown-md', async (_, { title, content } = {}) => {
    const safeTitle = String(title || 'BossFreeForm_Doc')
      .replace(/\.md$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'BossFreeForm_Doc';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '마크다운(MD) 파일로 저장',
      defaultPath: `${safeTitle}.md`,
      filters: [
        { name: 'Markdown 문서 (*.md)', extensions: ['md', 'markdown'] },
        { name: '텍스트 파일 (*.txt)', extensions: ['txt'] }
      ]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, String(content ?? ''), 'utf-8');
    return { success: true, filePath: res.filePath };
  });

  ipcMain.handle('export:markdown-pdf', async (_, { title, htmlContent } = {}) => {
    const safeTitle = String(title || 'BossFreeForm_Doc')
      .replace(/\.(md|pdf)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'BossFreeForm_Doc';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '마크다운(MD) 문서를 PDF 파일로 변환 저장',
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF 문서 (*.pdf)', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };

    const tempHtmlPath = path.join(os.tmpdir(), `bossfreeform_md_pdf_${Date.now()}.html`);
    let pdfWin = null;
    try {
      fs.writeFileSync(tempHtmlPath, String(htmlContent || ''), 'utf-8');
      pdfWin = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: {
          sandbox: false,
          webSecurity: false
        }
      });
      await pdfWin.loadFile(tempHtmlPath);
      await new Promise((r) => setTimeout(r, 350));
      const pdfBuffer = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.45, bottom: 0.45, left: 0.45, right: 0.45 }
      });
      fs.writeFileSync(res.filePath, pdfBuffer);
      return { success: true, filePath: res.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      try {
        if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
      } catch (_) {}
      try {
        if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
      } catch (_) {}
    }
  });

  ipcMain.handle('export:board-json', async (_, board) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '프리폼 보드 백업 파일(.json) 저장',
      defaultPath: `${(board?.title || 'BossFreeForm_Board').replace(/[\\/:*?"<>|]/g, '_')}.freeform.json`,
      filters: [{ name: 'BossFreeForm Board (*.json)', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(board, null, 2), 'utf-8');
    return { success: true, filePath: res.filePath };
  });

  ipcMain.handle('import:board-json', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '프리폼 보드 파일(.json) 불러오기',
      properties: ['openFile'],
      filters: [{ name: 'BossFreeForm Board (*.json)', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
    raw.id = `board_${Date.now()}`;
    const saved = driveSync.saveBoard(raw);
    return { success: true, board: saved };
  });

  // Google Drive Sync Handlers & Global Hotkey Config
  ipcMain.handle('sync:get-status', () => driveSync.getSyncStatus());

  ipcMain.handle('sync:pick-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '구글 드라이브(내 드라이브) 또는 보드 동기화 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const chosen = res.filePaths[0];
    const targetFolder = path.basename(chosen).toLowerCase().includes('freeform')
      ? chosen
      : path.join(chosen, 'BossFreeForm');
    const status = driveSync.setSyncFolder(targetFolder, 'desktop-drive', true);
    return { success: true, status };
  });

  ipcMain.handle('sync:use-detected-drive', () => {
    const detected = driveSync.detectGoogleDriveDesktopPath();
    if (!detected) {
      return { success: false, error: 'PC에 설치된 Google Drive(내 드라이브) 경로를 자동으로 찾지 못했습니다. 폴더 직접 선택을 이용해 주세요.' };
    }
    const status = driveSync.setSyncFolder(detected, 'desktop-drive', true);
    return { success: true, status };
  });

  ipcMain.handle('sync:open-folder', () => {
    shell.openPath(driveSync.getActiveStorageRoot());
    return true;
  });

  ipcMain.handle('sync:start-oauth', async (_, creds) => {
    return await driveSync.startGoogleOAuthFlow({
      ...creds,
      openExternal: (url) => shell.openExternal(url)
    });
  });

  ipcMain.handle('sync:cloud-now', async () => {
    syncWithVercelCloudRelay();
    return await driveSync.syncToGoogleCloud();
  });

  ipcMain.handle('sync:disconnect-oauth', () => {
    return driveSync.disconnectOAuth();
  });

  ipcMain.handle('sync:open-google-web', () => {
    openGoogleWebDriveWindow();
    return { success: true };
  });

  ipcMain.handle('config:get', () => driveSync.config);
  ipcMain.handle('config:save', (_, partial) => driveSync.saveConfig(partial || {}));
  ipcMain.handle('config:set-hotkey', (_, newHotkey) => {
    return registerAppGlobalHotkey(newHotkey);
  });
}

// ============================================================================
// SpotlightAgent & Web Version <-> BossFreeForm Local HTTP Bridge (127.0.0.1:18089 / 18090)
// + Vercel Cloud Relay Real-Time Sync
// ============================================================================
const BRIDGE_PORT = 18089;
let bridgeServer = null;
const VERCEL_CLOUD_SYNC_URL = 'https://boss-freeform-web.vercel.app/api/cloud-sync';
let cloudRelaySyncInFlight = false;
let lastEventCloudSyncAt = 0;

function triggerEventDrivenCloudSync(force = false) {
  const now = Date.now();
  if (!force && now - lastEventCloudSyncAt < 10000) return;
  lastEventCloudSyncAt = now;
  syncWithVercelCloudRelay();
}

function readAllRawBoardsFromDisk() {
  const boardsDir = driveSync.getBoardsDir();
  const boards = [];
  try {
    if (fs.existsSync(boardsDir)) {
      for (const f of fs.readdirSync(boardsDir).filter((x) => x.endsWith('.json'))) {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(boardsDir, f), 'utf-8'));
          if (b && b.id) boards.push(b);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return boards;
}

function pushBoardToVercelCloudRelay(board) {
  if (!board || !board.id) return;
  try {
    const payload = JSON.stringify({ board });
    const urlObj = new URL(VERCEL_CLOUD_SYNC_URL);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 4000
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

function deleteBoardFromVercelCloudRelay(boardId) {
  if (!boardId) return;
  try {
    const payload = JSON.stringify({ action: 'delete', boardId, deletedAt: Date.now() });
    const urlObj = new URL(VERCEL_CLOUD_SYNC_URL);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 4000
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

async function pushAssetToVercelCloudRelay(assetFileName) {
  if (!assetFileName) return;
  try {
    const safeName = path.basename(assetFileName);
    const assetPath = path.join(driveSync.getAssetsDir(), safeName);
    const stat = await fs.promises.stat(assetPath).catch(() => null);
    if (!stat || !stat.isFile()) return;
    const buf = await fs.promises.readFile(assetPath);
    const payload = JSON.stringify({
      asset: {
        assetFileName: safeName,
        base64: buf.toString('base64')
      }
    });
    const urlObj = new URL(VERCEL_CLOUD_SYNC_URL);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 15000
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

function fetchAssetFromVercelCloudRelayAsync(assetFileName) {
  return new Promise((resolve) => {
    if (!assetFileName) return resolve(null);
    try {
      const safeName = path.basename(assetFileName);
      const destPath = path.join(driveSync.getAssetsDir(), safeName);
      if (fs.existsSync(destPath)) return resolve(destPath);
      const urlObj = new URL(`${VERCEL_CLOUD_SYNC_URL}?asset=${encodeURIComponent(safeName)}`);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          timeout: 15000
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve(null);
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              if (buf.length > 0) {
                fs.mkdirSync(driveSync.getAssetsDir(), { recursive: true });
                fs.writeFileSync(destPath, buf);
                return resolve(destPath);
              }
            } catch (_) {}
            resolve(null);
          });
        }
      );
      req.on('error', () => resolve(null));
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

function downloadAssetFromVercelCloudRelay(assetFileName) {
  fetchAssetFromVercelCloudRelayAsync(assetFileName).then((savedPath) => {
    if (savedPath && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('board:external-update', driveSync.config.lastActiveBoardId);
    }
  });
}

function syncWithVercelCloudRelay() {
  if (cloudRelaySyncInFlight) return;
  cloudRelaySyncInFlight = true;
  try {
    const localBoards = readAllRawBoardsFromDisk();
    const payload = JSON.stringify({ boards: localBoards });
    const urlObj = new URL(VERCEL_CLOUD_SYNC_URL);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
      },
      (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          cloudRelaySyncInFlight = false;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
            if (!data || !Array.isArray(data.boards)) return;
            const localMap = new Map(localBoards.map((b) => [b.id, b]));
            const boardsDir = driveSync.getBoardsDir();
            for (const remoteBoard of data.boards) {
              if (!remoteBoard || !remoteBoard.id) continue;
              const localBoard = localMap.get(remoteBoard.id);
              if (!localBoard || (remoteBoard.updatedAt || 0) > (localBoard.updatedAt || 0) + 500) {
                fs.mkdirSync(boardsDir, { recursive: true });
                fs.writeFileSync(
                  path.join(boardsDir, `${remoteBoard.id}.json`),
                  JSON.stringify(remoteBoard, null, 2),
                  'utf-8'
                );
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('board:external-update', remoteBoard.id);
                }
              }
            }

            // Bidirectional Asset File Sync (G:\내 드라이브\BossFreeForm\assets <-> Cloud Relay)
            const remoteAssetSet = new Set(Array.isArray(data.assetNames) ? data.assetNames : []);
            const assetsDir = driveSync.getAssetsDir();
            if (fs.existsSync(assetsDir)) {
              const localAssetFiles = fs.readdirSync(assetsDir);
              const localAssetSet = new Set(localAssetFiles);
              // 1) Download any new assets created on Web into G:\내 드라이브\BossFreeForm\assets
              for (const rName of remoteAssetSet) {
                if (!localAssetSet.has(rName)) {
                  downloadAssetFromVercelCloudRelay(rName);
                }
              }
              // 2) Upload any local assets missing from Cloud Relay (up to 2 per cycle to avoid congestion)
              let uploadedCount = 0;
              for (const lName of localAssetFiles) {
                if (!remoteAssetSet.has(lName) && uploadedCount < 2) {
                  pushAssetToVercelCloudRelay(lName);
                  uploadedCount++;
                }
              }
            }
          } catch (_) {}
        });
      }
    );
    req.on('error', () => {
      cloudRelaySyncInFlight = false;
    });
    req.on('timeout', () => {
      cloudRelaySyncInFlight = false;
      try { req.destroy(); } catch (_) {}
    });
    req.write(payload);
    req.end();
  } catch (_) {
    cloudRelaySyncInFlight = false;
  }
}

const BRIDGE_MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8'
};

function startBridgeServer() {
  bridgeServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && reqUrl === '/api/status') {
      const boards = driveSync.listBoards();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          app: 'BossFreeForm',
          activeBoardId: driveSync.config.lastActiveBoardId,
          boardCount: boards.length,
          syncStatus: driveSync.getSyncStatus()
        })
      );
      return;
    }

    if (req.method === 'POST' && (reqUrl === '/api/window/toggle' || reqUrl === '/api/window/show')) {
      if (
        reqUrl === '/api/window/toggle' &&
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        mainWindow.isFocused()
      ) {
        mainWindow.hide();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, visible: false }));
      } else {
        showMainWindow();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, visible: true }));
      }
      return;
    }

    if (req.method === 'POST' && reqUrl === '/api/board/add-object') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          showMainWindow();

          if (Array.isArray(payload.objects) && payload.objects.length > 0) {
            const objectsToPush = payload.objects.map((item, idx) => {
              const rawContent = item.content || item.markdown || '';
              const parsedTable =
                item.forceType === 'text'
                  ? null
                  : item.tableData || tryParseTableFromText(rawContent);
              return {
                type: item.forceType || item.type || (parsedTable ? 'table' : 'text'),
                title: item.title || `✨ Spotlight AI #${idx + 1}`,
                content: rawContent,
                tableData: parsedTable || null,
                url: item.url || null,
                color: item.color || (parsedTable ? 'blue' : 'dark')
              };
            });

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('bridge:add-object', {
                objects: objectsToPush
              });
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, count: objectsToPush.length }));
            return;
          }

          const rawContent = payload.content || payload.markdown || '';
          const parsedTable =
            payload.forceType === 'text'
              ? null
              : payload.tableData || tryParseTableFromText(rawContent);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:add-object', {
              type: payload.forceType || payload.type || (parsedTable ? 'table' : 'text'),
              title: payload.title || '✨ Spotlight AI 답변',
              content: rawContent,
              tableData: parsedTable || null,
              url: payload.url || null,
              color: payload.color || (parsedTable ? 'blue' : 'dark')
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && reqUrl === '/api/local-drive/boards') {
      const boards = readAllRawBoardsFromDisk();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          localDriveActive: true,
          driveRoot: driveSync.getActiveStorageRoot(),
          activeBoardId: driveSync.config.lastActiveBoardId,
          boards
        })
      );
      return;
    }

    if (req.method === 'POST' && reqUrl === '/api/local-drive/save-board') {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          const board = body?.board;
          if (board && board.id) {
            const boardsDir = driveSync.getBoardsDir();
            fs.mkdirSync(boardsDir, { recursive: true });
            fs.writeFileSync(path.join(boardsDir, `${board.id}.json`), JSON.stringify(board, null, 2), 'utf-8');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('board:external-update', board.id);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && reqUrl === '/api/local-drive/delete-board') {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          if (body?.boardId) {
            driveSync.deleteBoard(body.boardId);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('board:external-update', body.boardId);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && reqUrl === '/api/local-drive/save-asset') {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          if (body?.assetFileName && body?.base64) {
            const assetsDir = driveSync.getAssetsDir();
            fs.mkdirSync(assetsDir, { recursive: true });
            fs.writeFileSync(path.join(assetsDir, body.assetFileName), Buffer.from(body.base64, 'base64'));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && reqUrl.startsWith('/seed_drive/assets/')) {
      const fileName = decodeURIComponent(reqUrl.replace('/seed_drive/assets/', ''));
      const assetPath = path.join(driveSync.getAssetsDir(), fileName);
      if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        const ext = path.extname(assetPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': BRIDGE_MIME_MAP[ext] || 'application/octet-stream' });
        fs.createReadStream(assetPath).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  let triedFallbackPort = false;
  bridgeServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !triedFallbackPort) {
      triedFallbackPort = true;
      bridgeServer.listen(18090, '127.0.0.1');
      return;
    }
    console.warn('[BridgeServer] Port warning:', err.message);
  });

  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[BossFreeForm] Spotlight & Web Bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });

  // Event-driven sync only (once at startup + on window open/focus or board save, NO constant 2.5s Vercel polling)
  setTimeout(() => triggerEventDrivenCloudSync(true), 1000);
}

function updateTrayMenu() {
  if (!tray) return;
  const hk = formatHotkeyDisplay(driveSync.config.hotkey || DEFAULT_HOTKEY);
  tray.setToolTip(`BossFreeForm — Infinite Canvas x Google Drive (${hk})`);
  const menu = Menu.buildFromTemplate([
    { label: `🎨 BossFreeForm 보드 열기 (${hk})`, click: () => showMainWindow() },
    { label: '🔄 창 크기 및 위치 초기화 (화면 중앙)', click: () => resetMainWindowBounds() },
    { type: 'separator' },
    { label: '☁️ 구글 드라이브 동기화 폴더 열기', click: () => shell.openPath(driveSync.getActiveStorageRoot()) },
    { label: '🌐 구글 드라이브 웹 로그인 창 열기', click: () => openGoogleWebDriveWindow() },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        saveCurrentWindowBounds();
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  tray = new Tray(createTrayIcon());
  updateTrayMenu();
  tray.on('click', () => showMainWindow());
}

app.whenReady().then(() => {
  // Fix YouTube embed "플레이어 구성 오류 (Error 153)" inside file:// Electron renderer by ensuring a valid HTTPS Referer/Origin
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      {
        urls: [
          '*://*.youtube.com/*',
          '*://*.youtube-nocookie.com/*',
          '*://*.googlevideo.com/*',
          '*://*.ytimg.com/*'
        ]
      },
      (details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        const curRef = requestHeaders['Referer'] || requestHeaders['referer'] || '';
        if (!curRef || curRef.startsWith('file:')) {
          requestHeaders['Referer'] = 'https://www.youtube.com/';
          delete requestHeaders['referer'];
        }
        const curOrigin = requestHeaders['Origin'] || requestHeaders['origin'] || '';
        if (!curOrigin || curOrigin === 'null' || curOrigin.startsWith('file:')) {
          requestHeaders['Origin'] = 'https://www.youtube.com';
          delete requestHeaders['origin'];
        }
        callback({ requestHeaders });
      }
    );
  } catch (err) {
    console.warn('[YouTube Embed Header Fix] warning:', err.message);
  }

  setupIpc();
  createMainWindow();
  setupTray();
  startBridgeServer();

  driveSync.startWatching((changedBoardId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('board:external-update', changedBoardId);
    }
  });

  registerAppGlobalHotkey(driveSync.config.hotkey || DEFAULT_HOTKEY);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
});

app.on('window-all-closed', () => {
  // Keep alive in system tray
});
