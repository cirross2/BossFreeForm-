const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function resolveWritableDataRoot() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(process.env.PORTABLE_EXECUTABLE_DIR);
  }
  const execBase = path.basename(process.execPath || '').toLowerCase();
  const isPackagedExe = execBase.startsWith('bossfreeform') || __dirname.toLowerCase().includes('resources');
  if (isPackagedExe) {
    const exeDir = path.dirname(process.execPath);
    if (!/program files/i.test(exeDir)) {
      candidates.push(exeDir);
    }
    candidates.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BossFreeForm'));
  } else {
    candidates.push(PROJECT_ROOT);
  }

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const testFile = path.join(dir, `.write_test_${process.pid}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      return dir;
    } catch (_) {}
  }
  const fallback = path.join(os.homedir(), '.bossfreeform');
  try {
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  } catch (_) {}
  return fallback;
}

const DATA_ROOT = resolveWritableDataRoot();
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const OAUTH_TOKEN_PATH = path.join(DATA_ROOT, 'oauth_tokens.json');
const DEFAULT_LOCAL_STORAGE = path.join(DATA_ROOT, 'boards_local');

class DriveSyncManager {
  constructor() {
    this.config = this.loadConfig();
    this.oauthTokens = this.loadOAuthTokens();
    this.watcher = null;
    this.onExternalChange = null;
    this.selfWriteTimestamps = new Map();
    this.ensureStorageDirectories();
  }

  // Auto-detect installed Google Drive for Desktop path on Windows (e.g. G:\내 드라이브, G:\My Drive)
  detectGoogleDriveDesktopPath() {
    const candidates = [];
    const home = os.homedir();

    // Check common drive letters G: through Z:, plus C:, D:, E:, F:
    const letters = ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'D', 'E', 'F', 'C'];
    const subNames = ['내 드라이브', 'My Drive', 'Google Drive', 'Google 드라이브'];

    for (const letter of letters) {
      for (const sub of subNames) {
        candidates.push(`${letter}:\\${sub}`);
      }
    }

    // Also check inside User Profile
    for (const sub of ['Google Drive', 'My Drive', '내 드라이브', 'GoogleDrive']) {
      candidates.push(path.join(home, sub));
      candidates.push(path.join(home, sub, '내 드라이브'));
      candidates.push(path.join(home, sub, 'My Drive'));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return path.join(candidate, 'BossFreeForm');
        }
      } catch (_) {}
    }

    return null;
  }

  migrateLegacyFreeformDriveFolder(targetBossFreeFormDir) {
    if (!targetBossFreeFormDir) return;
    try {
      const parentDir = path.dirname(targetBossFreeFormDir);
      const legacyDir = path.join(parentDir, 'FreeformDrive');
      if (!fs.existsSync(legacyDir) || legacyDir === targetBossFreeFormDir) return;

      const targetBoards = path.join(targetBossFreeFormDir, 'boards');
      const targetAssets = path.join(targetBossFreeFormDir, 'assets');
      fs.mkdirSync(targetBoards, { recursive: true });
      fs.mkdirSync(targetAssets, { recursive: true });

      const legacyBoards = path.join(legacyDir, 'boards');
      if (fs.existsSync(legacyBoards)) {
        for (const f of fs.readdirSync(legacyBoards)) {
          if (!f.endsWith('.json')) continue;
          const src = path.join(legacyBoards, f);
          const dst = path.join(targetBoards, f);
          if (!fs.existsSync(dst)) {
            fs.copyFileSync(src, dst);
          } else {
            try {
              const sObj = JSON.parse(fs.readFileSync(src, 'utf-8'));
              const dObj = JSON.parse(fs.readFileSync(dst, 'utf-8'));
              if ((Number(sObj.updatedAt) || 0) > (Number(dObj.updatedAt) || 0)) {
                fs.copyFileSync(src, dst);
              }
            } catch (_) {}
          }
        }
      }

      const legacyAssets = path.join(legacyDir, 'assets');
      if (fs.existsSync(legacyAssets)) {
        for (const f of fs.readdirSync(legacyAssets)) {
          const src = path.join(legacyAssets, f);
          const dst = path.join(targetAssets, f);
          try {
            if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
              fs.copyFileSync(src, dst);
            }
          } catch (_) {}
        }
      }

      // Remove duplicate legacy FreeformDrive folder after safe migration
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch (_) {}
    } catch (_) {}
  }

  getDefaultConfig() {
    const detectedDrivePath = this.detectGoogleDriveDesktopPath();
    return {
      hotkey: 'Ctrl+Shift+Space',
      theme: 'dark',
      gridStyle: 'dots', // 'dots' | 'lines' | 'none'
      syncMode: detectedDrivePath ? 'desktop-drive' : 'local', // 'desktop-drive' | 'cloud-oauth' | 'local'
      syncFolderPath: detectedDrivePath || DEFAULT_LOCAL_STORAGE,
      googleDesktopDetectedPath: detectedDrivePath || null,
      autoSyncCloud: true,
      oauthClientId: '',
      oauthClientSecret: '',
      cloudFolderId: null,
      cloudAccountEmail: null,
      lastCloudSyncAt: null,
      lastActiveBoardId: 'board_welcome',
      windowBounds: {
        width: 1480,
        height: 920,
        x: null,
        y: null
      }
    };
  }

  loadConfig() {
    const defaults = this.getDefaultConfig();
    const detected = this.detectGoogleDriveDesktopPath();
    if (detected) {
      this.migrateLegacyFreeformDriveFolder(detected);
    }
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        const merged = { ...defaults, ...raw };
        if (
          !raw.hotkey ||
          /^(Shift\+Alt\+F|Alt\+Shift\+F|Ctrl\+Shift\+F|CommandOrControl\+Shift\+F)$/i.test(String(raw.hotkey).trim())
        ) {
          merged.hotkey = 'Ctrl+Shift+Space';
          try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
          } catch (_) {}
        }
        merged.googleDesktopDetectedPath = detected;
        // Unify any legacy FreeformDrive path or default local path to BossFreeForm
        if (
          detected &&
          (!raw.syncFolderPath ||
            raw.syncFolderPath === DEFAULT_LOCAL_STORAGE ||
            /[\\/]FreeformDrive$/i.test(String(raw.syncFolderPath)))
        ) {
          merged.syncFolderPath = detected;
          merged.syncMode = 'desktop-drive';
          try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
          } catch (_) {}
        }
        return merged;
      }
    } catch (err) {
      console.warn('[DriveSync] Failed to load config:', err.message);
    }
    this.saveConfig(defaults);
    return defaults;
  }

  saveConfig(partial) {
    this.config = { ...this.config, ...partial };
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DriveSync] Failed to save config:', err.message);
    }
    this.ensureStorageDirectories();
    return this.config;
  }

  getActiveStorageRoot() {
    const customPath = this.config?.syncFolderPath;
    if (customPath) {
      try {
        if (!fs.existsSync(customPath)) {
          fs.mkdirSync(customPath, { recursive: true });
        }
        return customPath;
      } catch (_) {}
    }
    if (!fs.existsSync(DEFAULT_LOCAL_STORAGE)) {
      fs.mkdirSync(DEFAULT_LOCAL_STORAGE, { recursive: true });
    }
    return DEFAULT_LOCAL_STORAGE;
  }

  getBoardsDir() {
    return path.join(this.getActiveStorageRoot(), 'boards');
  }

  getAssetsDir() {
    return path.join(this.getActiveStorageRoot(), 'assets');
  }

  ensureStorageDirectories() {
    const activeRoot = this.getActiveStorageRoot();
    const boardsDir = path.join(activeRoot, 'boards');
    const assetsDir = path.join(activeRoot, 'assets');
    if (
      this._ensuredStorageRoot === activeRoot &&
      fs.existsSync(boardsDir) &&
      fs.existsSync(assetsDir)
    ) {
      return;
    }
    if (!fs.existsSync(boardsDir)) fs.mkdirSync(boardsDir, { recursive: true });
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    // Create initial starter board if no boards exist yet
    const files = fs.readdirSync(boardsDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
      const welcomeBoard = this.createWelcomeBoard();
      const welcomePath = path.join(boardsDir, `${welcomeBoard.id}.json`);
      fs.writeFileSync(welcomePath, JSON.stringify(welcomeBoard, null, 2), 'utf-8');
    }
    this._ensuredStorageRoot = activeRoot;
  }

  createWelcomeBoard() {
    const now = Date.now();
    return {
      id: 'board_welcome',
      title: '✨ BossFreeForm 메인 보드',
      icon: '🎨',
      folder: '기본 보드',
      createdAt: now,
      updatedAt: now,
      viewport: {
        panX: 80,
        panY: 60,
        zoom: 1
      },
      objects: [
        {
          id: 'obj_welcome_note',
          type: 'sticky',
          x: 60,
          y: 60,
          width: 310,
          height: 240,
          color: 'yellow',
          title: '👋 BossFreeForm x Google Drive',
          content:
            '보스, 환영합니다!\n\n• 빈 공간 드래그 또는 마우스 휠클릭+드래그: 캔버스 이동\n• 마우스 휠: 부드러운 확대/축소\n• Ctrl+Shift+Space: 언제든 보드 호출/숨기기 (단축키 변경 가능)\n• Ctrl+V: 이미지, 표(엑셀/구글시트), 링크, 텍스트 즉시 붙여넣기\n• 왼손 단축키: A(선택), D(펜), S(포스트잇), T/F(텍스트), C(체크리스트), G(표)',
          zIndex: 1,
          createdAt: now
        },
        {
          id: 'obj_welcome_table',
          type: 'table',
          x: 420,
          y: 60,
          width: 480,
          height: 250,
          title: '📊 프로젝트 & 업무 관리 표 (구글 시트 호환)',
          color: 'blue',
          tableData: [
            ['구분', '주요 항목', '상태', '비고'],
            ['구글 드라이브 연동', 'PC 드라이브 폴더 & 클라우드 API', '[circle:1] 완료', '실시간 자동 저장'],
            ['글로벌 단축키 호출', 'Ctrl+Shift+Space (변경 가능)', '[toggle:1] 작동 중', '원클릭 보드 토글'],
            ['자유 객체 편집', '펜 객체 · 그래픽 텍스트 · 표 · 링크 · 이미지', '[square:1] 준비됨', '줄별 개별 정렬 지원']
          ],
          zIndex: 2,
          createdAt: now
        },
        {
          id: 'obj_welcome_text',
          type: 'text',
          x: 60,
          y: 340,
          width: 380,
          height: 225,
          color: 'dark',
          title: '📝 3종 체크리스트 & 줄별 정렬 노트',
          content:
            '체크박스를 클릭하거나 우클릭해 모양을 바꿔보세요:\n[square:1] 네모 V 체크박스 (Square)\n[circle:1] 원형 채움 체크박스 (Circle)\n[toggle:1] 슬라이드 토글 스위치 (Slide)\n[circle:0] 제목과 각 줄마다 좌/중/우 개별 정렬 지원',
          zIndex: 3,
          createdAt: now
        },
        {
          id: 'obj_welcome_link',
          type: 'link',
          x: 490,
          y: 340,
          width: 410,
          height: 170,
          url: 'https://drive.google.com',
          title: 'Google Drive - 클라우드 저장소',
          description: '보드의 모든 객체(이미지, 표, 링크, 텍스트, 펜 드로잉)가 구글 드라이브 폴더 및 클라우드와 안전하게 동기화됩니다.',
          domain: 'drive.google.com',
          favicon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png',
          zIndex: 4,
          createdAt: now
        }
      ],
      connectors: [
        {
          id: 'conn_welcome_1',
          fromId: 'obj_welcome_note',
          toId: 'obj_welcome_table',
          color: '#0a84ff',
          style: 'solid',
          label: '실시간 동기화'
        },
        {
          id: 'conn_welcome_2',
          fromId: 'obj_welcome_table',
          toId: 'obj_welcome_link',
          color: '#30d158',
          style: 'dashed',
          label: '클라우드 백업'
        }
      ],
      strokes: []
    };
  }

  // List all boards sorted by updatedAt descending
  listBoards() {
    this.ensureStorageDirectories();
    const boardsDir = this.getBoardsDir();
    const files = fs.readdirSync(boardsDir).filter((f) => f.endsWith('.json'));
    const list = [];

    for (const file of files) {
      try {
        const fullPath = path.join(boardsDir, file);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        list.push({
          id: data.id || path.basename(file, '.json'),
          title: data.title || '제목 없는 보드',
          icon: data.icon || '📋',
          folder: data.folder || '기본 보드',
          objectCount: Array.isArray(data.objects) ? data.objects.length : 0,
          updatedAt: data.updatedAt || fs.statSync(fullPath).mtimeMs,
          createdAt: data.createdAt || fs.statSync(fullPath).birthtimeMs
        });
      } catch (_) {}
    }

    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  getBoard(boardId) {
    this.ensureStorageDirectories();
    const boardsDir = this.getBoardsDir();
    const targetId = boardId || this.config.lastActiveBoardId || 'board_welcome';
    const filePath = path.join(boardsDir, `${targetId}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const board = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return this.resolveBoardAssetUrls(board);
      } catch (err) {
        console.error('[DriveSync] Error reading board:', err.message);
      }
    }

    const all = this.listBoards();
    if (all.length > 0) {
      const fallbackPath = path.join(boardsDir, `${all[0].id}.json`);
      return this.resolveBoardAssetUrls(JSON.parse(fs.readFileSync(fallbackPath, 'utf-8')));
    }

    const welcome = this.createWelcomeBoard();
    this.saveBoard(welcome);
    return welcome;
  }

  resolveBoardAssetUrls(board) {
    if (!board || !Array.isArray(board.objects)) return board;
    const assetsDir = this.getAssetsDir();
    board.objects = board.objects.map((obj) => {
      if (obj.assetFileName) {
        const absPath = path.join(assetsDir, obj.assetFileName);
        if (fs.existsSync(absPath)) {
          obj.resolvedFilePath = absPath;
          obj.resolvedFileUrl = `file:///${absPath.replace(/\\/g, '/')}`;
        }
      }
      return obj;
    });
    return board;
  }

  saveBoard(board, { skipCloud = false } = {}) {
    if (!board || !board.id) {
      throw new Error('유효하지 않은 보드 데이터입니다.');
    }
    this.ensureStorageDirectories();
    const now = Date.now();
    board.updatedAt = now;
    if (!this.selfWriteTimestamps) this.selfWriteTimestamps = new Map();
    this.selfWriteTimestamps.set(board.id, now);
    const filePath = path.join(this.getBoardsDir(), `${board.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(board, null, 2), 'utf-8');
    this.selfWriteTimestamps.set(board.id, Date.now());

    if (this.config.lastActiveBoardId !== board.id) {
      this.saveConfig({ lastActiveBoardId: board.id });
    }

    // Trigger asynchronous Google Drive Cloud API sync if OAuth is connected
    if (!skipCloud && this.config.autoSyncCloud && this.isOAuthConnected()) {
      this.syncToGoogleCloud().catch((err) => {
        console.warn('[DriveSync] Background cloud sync warning:', err.message);
      });
    }

    return this.resolveBoardAssetUrls(board);
  }

  createNewBoard({ title = '새 프리폼 보드', icon = '🎨', folder = '기본 보드' } = {}) {
    const now = Date.now();
    const id = `board_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const newBoard = {
      id,
      title,
      icon,
      folder,
      createdAt: now,
      updatedAt: now,
      viewport: { panX: 100, panY: 80, zoom: 1 },
      objects: [],
      connectors: [],
      strokes: []
    };
    return this.saveBoard(newBoard);
  }

  deleteBoard(boardId) {
    if (!boardId) return { success: false };
    const filePath = path.join(this.getBoardsDir(), `${boardId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const remaining = this.listBoards();
    if (remaining.length === 0) {
      const welcome = this.createWelcomeBoard();
      this.saveBoard(welcome);
      return { success: true, nextBoardId: welcome.id };
    }
    return { success: true, nextBoardId: remaining[0].id };
  }

  // Save an image or attachment file into the synced `assets/` folder
  saveAssetFromPath(sourcePath, originalName = null) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('원본 파일을 찾을 수 없습니다.');
    }
    this.ensureStorageDirectories();
    const ext = path.extname(originalName || sourcePath) || '.png';
    const base = path
      .basename(originalName || sourcePath, ext)
      .replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
      .slice(0, 40);
    const fileName = `${Date.now()}_${base}${ext}`;
    const destPath = path.join(this.getAssetsDir(), fileName);
    if (ext.toLowerCase() === '.csv') {
      const rawBuf = fs.readFileSync(sourcePath);
      const hasBom = rawBuf.length >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf;
      const outBuf = hasBom ? rawBuf : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawBuf]);
      fs.writeFileSync(destPath, outBuf);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
    const stat = fs.statSync(destPath);
    if (this.config.autoSyncCloud && this.isOAuthConnected()) {
      this.syncToGoogleCloud().catch(() => {});
    }
    return {
      assetFileName: fileName,
      name: originalName || path.basename(sourcePath),
      size: stat.size,
      resolvedFilePath: destPath,
      resolvedFileUrl: `file:///${destPath.replace(/\\/g, '/')}`
    };
  }

  saveAssetFromBuffer(buffer, ext = '.png', label = 'clipboard') {
    this.ensureStorageDirectories();
    const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
    const baseLabel = path
      .basename(label || 'clipboard', path.extname(label || ''))
      .replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
      .slice(0, 40);
    const fileName = `${Date.now()}_${baseLabel}${cleanExt}`;
    const destPath = path.join(this.getAssetsDir(), fileName);
    let outBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (cleanExt.toLowerCase() === '.csv') {
      const hasBom = outBuf.length >= 3 && outBuf[0] === 0xef && outBuf[1] === 0xbb && outBuf[2] === 0xbf;
      if (!hasBom) {
        outBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), outBuf]);
      }
    }
    fs.writeFileSync(destPath, outBuf);
    if (this.config.autoSyncCloud && this.isOAuthConnected()) {
      this.syncToGoogleCloud().catch(() => {});
    }
    return {
      assetFileName: fileName,
      name: label || fileName,
      size: outBuf.length,
      resolvedFilePath: destPath,
      resolvedFileUrl: `file:///${destPath.replace(/\\/g, '/')}`
    };
  }

  // Switch sync folder (e.g. to Google Drive for Desktop folder or custom path) and optionally migrate existing boards
  setSyncFolder(newFolderPath, mode = 'desktop-drive', migrateExisting = true) {
    if (!newFolderPath) throw new Error('폴더 경로가 비어 있습니다.');
    const oldBoardsDir = this.getBoardsDir();
    const oldAssetsDir = this.getAssetsDir();

    if (!fs.existsSync(newFolderPath)) {
      fs.mkdirSync(newFolderPath, { recursive: true });
    }

    const newBoardsDir = path.join(newFolderPath, 'boards');
    const newAssetsDir = path.join(newFolderPath, 'assets');
    if (!fs.existsSync(newBoardsDir)) fs.mkdirSync(newBoardsDir, { recursive: true });
    if (!fs.existsSync(newAssetsDir)) fs.mkdirSync(newAssetsDir, { recursive: true });

    if (migrateExisting && oldBoardsDir !== newBoardsDir) {
      try {
        if (fs.existsSync(oldBoardsDir)) {
          for (const f of fs.readdirSync(oldBoardsDir)) {
            const src = path.join(oldBoardsDir, f);
            const dest = path.join(newBoardsDir, f);
            if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
          }
        }
        if (fs.existsSync(oldAssetsDir)) {
          for (const f of fs.readdirSync(oldAssetsDir)) {
            const src = path.join(oldAssetsDir, f);
            const dest = path.join(newAssetsDir, f);
            if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
          }
        }
      } catch (err) {
        console.warn('[DriveSync] Migration copy warning:', err.message);
      }
    }

    this.saveConfig({
      syncFolderPath: newFolderPath,
      syncMode: mode
    });

    this.startWatching();
    return this.getSyncStatus();
  }

  startWatching(onChangeCallback) {
    if (onChangeCallback) {
      this.onExternalChange = onChangeCallback;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (_) {}
      this.watcher = null;
    }
    try {
      const boardsDir = this.getBoardsDir();
      let debounceTimer = null;
      this.watcher = fs.watch(boardsDir, (eventType, filename) => {
        if (filename && filename.endsWith('.json')) {
          const boardId = filename.replace(/\.json$/, '');
          const lastSelfWrite = this.selfWriteTimestamps?.get(boardId) || 0;
          if (Date.now() - lastSelfWrite < 3000) {
            return;
          }
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const recentSelfWrite = this.selfWriteTimestamps?.get(boardId) || 0;
            if (Date.now() - recentSelfWrite < 3000) {
              return;
            }
            if (this.onExternalChange) {
              this.onExternalChange(boardId);
            }
          }, 350);
        }
      });
    } catch (_) {}
  }

  // ============================================================================
  // Google Drive Cloud OAuth2 API Integration (Google Drive API v3)
  // ============================================================================
  loadOAuthTokens() {
    try {
      if (fs.existsSync(OAUTH_TOKEN_PATH)) {
        return JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, 'utf-8'));
      }
    } catch (_) {}
    return null;
  }

  saveOAuthTokens(tokens) {
    this.oauthTokens = tokens;
    try {
      if (tokens) {
        fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
      } else if (fs.existsSync(OAUTH_TOKEN_PATH)) {
        fs.unlinkSync(OAUTH_TOKEN_PATH);
      }
    } catch (_) {}
  }

  isOAuthConnected() {
    return Boolean(this.oauthTokens && (this.oauthTokens.refresh_token || this.oauthTokens.access_token));
  }

  disconnectOAuth() {
    this.saveOAuthTokens(null);
    this.saveConfig({
      cloudAccountEmail: null,
      cloudFolderId: null,
      syncMode: this.detectGoogleDriveDesktopPath() ? 'desktop-drive' : 'local'
    });
    return this.getSyncStatus();
  }

  // Start Loopback OAuth2 Flow for Google Drive API v3 (file scope)
  async startGoogleOAuthFlow({ clientId, clientSecret, openExternal }) {
    const cid = (clientId || this.config.oauthClientId || '').trim();
    const csecret = (clientSecret || this.config.oauthClientSecret || '').trim();
    if (!cid || !csecret) {
      throw new Error('Google Cloud OAuth 클라이언트 ID와 보안 비밀(Secret)을 입력해 주세요.');
    }

    this.saveConfig({ oauthClientId: cid, oauthClientSecret: csecret });

    return new Promise((resolve, reject) => {
      const redirectPort = 18092;
      const redirectUri = `http://127.0.0.1:${redirectPort}/oauth2callback`;
      const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email');
      const state = crypto.randomBytes(12).toString('hex');

      const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(cid)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${scope}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&state=${state}`;

      const server = http.createServer(async (req, res) => {
        try {
          const urlObj = new URL(req.url, `http://127.0.0.1:${redirectPort}`);
          if (urlObj.pathname !== '/oauth2callback') {
            res.writeHead(404);
            res.end();
            return;
          }
          const code = urlObj.searchParams.get('code');
          const err = urlObj.searchParams.get('error');
          if (err || !code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>❌ 구글 로그인이 취소되었거나 실패했습니다. 이 창을 닫아주세요.</h2>');
            server.close();
            return reject(new Error(err || '인증 코드 수신 실패'));
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body style="background:#000;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;background:#1c1c1e;padding:36px 48px;border-radius:18px;border:1px solid rgba(255,255,255,0.15);">
                  <h2 style="margin:0 0 10px 0;color:#30d158;">✅ Google Drive 연결 완료!</h2>
                  <p style="color:rgba(255,255,255,0.7);margin:0;">BossFreeForm 앱으로 돌아가시면 자동으로 동기화가 시작됩니다. 이 브라우저 탭을 닫으셔도 됩니다.</p>
                </div>
              </body>
            </html>
          `);
          server.close();

          const tokenData = await this.exchangeCodeForTokens({
            code,
            clientId: cid,
            clientSecret: csecret,
            redirectUri
          });
          this.saveOAuthTokens({
            ...tokenData,
            expiry_date: Date.now() + (tokenData.expires_in || 3500) * 1000
          });

          const userInfo = await this.fetchGoogleUserInfo();
          this.saveConfig({
            cloudAccountEmail: userInfo?.email || 'Google 계정 연결됨',
            syncMode: 'cloud-oauth'
          });

          await this.syncToGoogleCloud();
          resolve(this.getSyncStatus());
        } catch (ex) {
          try { server.close(); } catch (_) {}
          reject(ex);
        }
      });

      server.listen(redirectPort, '127.0.0.1', () => {
        if (openExternal) {
          openExternal(authUrl);
        }
      });

      setTimeout(() => {
        try { server.close(); } catch (_) {}
      }, 180000);
    });
  }

  exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
    const postData = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.error) {
                return reject(new Error(parsed.error_description || parsed.error));
              }
              resolve(parsed);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async getValidAccessToken() {
    if (!this.oauthTokens) throw new Error('구글 계정이 연결되어 있지 않습니다.');
    if (this.oauthTokens.access_token && this.oauthTokens.expiry_date && Date.now() < this.oauthTokens.expiry_date - 60000) {
      return this.oauthTokens.access_token;
    }
    if (!this.oauthTokens.refresh_token) {
      return this.oauthTokens.access_token;
    }

    const postData = new URLSearchParams({
      client_id: this.config.oauthClientId,
      client_secret: this.config.oauthClientSecret,
      refresh_token: this.oauthTokens.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const refreshed = await new Promise((resolve, reject) => {
      const req = https.request(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.error) return reject(new Error(parsed.error_description || parsed.error));
              resolve(parsed);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    this.saveOAuthTokens({
      ...this.oauthTokens,
      access_token: refreshed.access_token,
      expiry_date: Date.now() + (refreshed.expires_in || 3500) * 1000
    });
    return refreshed.access_token;
  }

  async googleApiRequest(urlStr, options = {}) {
    const token = await this.getValidAccessToken();
    return new Promise((resolve, reject) => {
      const urlObj = new URL(urlStr);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (options.responseType === 'buffer') {
              return resolve(buf);
            }
            const body = buf.toString('utf-8');
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch (_) {
              resolve(body);
            }
          });
        }
      );
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  getMimeTypeForExtension(extInput = '') {
    const ext = String(extInput || '').toLowerCase();
    const map = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.csv': 'text/csv',
      '.tsv': 'text/tab-separated-values',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.zip': 'application/zip',
      '.7z': 'application/x-7z-compressed',
      '.rar': 'application/vnd.rar',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.tgz': 'application/gzip',
      '.exe': 'application/x-msdownload',
      '.msi': 'application/x-msi',
      '.dmg': 'application/x-apple-diskimage',
      '.apk': 'application/vnd.android.package-archive',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm'
    };
    return map[ext] || 'application/octet-stream';
  }

  async fetchGoogleUserInfo() {
    try {
      return await this.googleApiRequest('https://www.googleapis.com/oauth2/v2/userinfo');
    } catch (_) {
      return null;
    }
  }

  async findOrCreateCloudSubfolder(name, parentId = null) {
    const parentClause = parentId ? ` and '${parentId}' in parents` : '';
    const q = encodeURIComponent(
      `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`
    );
    const listRes = await this.googleApiRequest(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    if (listRes?.files?.length > 0) {
      return listRes.files[0].id;
    }
    const createRes = await this.googleApiRequest('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {})
      })
    });
    if (createRes?.id) return createRes.id;
    throw new Error('Google Drive 폴더 생성 실패');
  }

  async ensureCloudFolderId() {
    if (this.config.cloudFolderId && this.config.cloudBoardsFolderId && this.config.cloudAssetsFolderId) {
      return {
        rootId: this.config.cloudFolderId,
        boardsFolderId: this.config.cloudBoardsFolderId,
        assetsFolderId: this.config.cloudAssetsFolderId
      };
    }
    const rootId = await this.findOrCreateCloudSubfolder('BossFreeForm');
    const boardsFolderId = await this.findOrCreateCloudSubfolder('boards', rootId);
    const assetsFolderId = await this.findOrCreateCloudSubfolder('assets', rootId);
    this.saveConfig({
      cloudFolderId: rootId,
      cloudBoardsFolderId: boardsFolderId,
      cloudAssetsFolderId: assetsFolderId
    });
    return { rootId, boardsFolderId, assetsFolderId };
  }

  async syncToGoogleCloud() {
    if (!this.isOAuthConnected()) {
      return { success: false, error: 'Google 계정이 연결되어 있지 않습니다.' };
    }
    const { boardsFolderId, assetsFolderId } = await this.ensureCloudFolderId();

    // 1. Sync Boards (BossFreeForm/boards)
    const q = encodeURIComponent(`'${boardsFolderId}' in parents and trashed = false`);
    const remoteList = await this.googleApiRequest(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`);
    const remoteFiles = new Map((remoteList?.files || []).map((f) => [f.name, f]));

    const boardsDir = this.getBoardsDir();
    const localFiles = fs.readdirSync(boardsDir).filter((f) => f.endsWith('.json'));

    for (const fileName of localFiles) {
      const localPath = path.join(boardsDir, fileName);
      const content = fs.readFileSync(localPath, 'utf-8');
      const existing = remoteFiles.get(fileName);

      if (existing) {
        await this.googleApiRequest(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: content
        });
      } else {
        const boundary = '-------BossFreeFormBoundary' + Date.now();
        const metadata = JSON.stringify({ name: fileName, parents: [boardsFolderId], mimeType: 'application/json' });
        const multipartBody =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
          `--${boundary}--`;

        await this.googleApiRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBody
        });
      }
    }

    for (const [remoteName, remoteMeta] of remoteFiles.entries()) {
      if (remoteName.endsWith('.json') && !localFiles.includes(remoteName)) {
        try {
          const downloaded = await this.googleApiRequest(`https://www.googleapis.com/drive/v3/files/${remoteMeta.id}?alt=media`);
          if (downloaded && typeof downloaded === 'object' && downloaded.id) {
            fs.writeFileSync(path.join(boardsDir, remoteName), JSON.stringify(downloaded, null, 2), 'utf-8');
          }
        } catch (_) {}
      }
    }

    // 2. Sync Assets (BossFreeForm/assets) so added images/PDFs/executables/archives are always backed up to & restored from Google Drive Cloud
    try {
      const aq = encodeURIComponent(`'${assetsFolderId}' in parents and trashed = false`);
      const remoteAssetList = await this.googleApiRequest(`https://www.googleapis.com/drive/v3/files?q=${aq}&fields=files(id,name)&pageSize=200`);
      const remoteAssets = new Map((remoteAssetList?.files || []).map((f) => [f.name, f]));
      const assetsDir = this.getAssetsDir();
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }
      const localAssets = fs.readdirSync(assetsDir);
      const localAssetSet = new Set(localAssets);

      // Upload local assets missing on Google Drive Cloud
      for (const assetName of localAssets) {
        if (remoteAssets.has(assetName)) continue;
        const assetPath = path.join(assetsDir, assetName);
        if (!fs.statSync(assetPath).isFile()) continue;
        const buf = fs.readFileSync(assetPath);
        const ext = path.extname(assetName).toLowerCase();
        const mime = this.getMimeTypeForExtension(ext);
        const boundary = '-------BossAssetBoundary' + Date.now();
        const metadata = JSON.stringify({ name: assetName, parents: [assetsFolderId], mimeType: mime });
        const headerBuf = Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
          'utf-8'
        );
        const footerBuf = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
        const multipartBuf = Buffer.concat([headerBuf, buf, footerBuf]);
        await this.googleApiRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBuf
        });
      }

      // Download remote assets from Google Drive Cloud that are missing locally
      for (const [remoteAssetName, remoteMeta] of remoteAssets.entries()) {
        if (localAssetSet.has(remoteAssetName) || !remoteMeta?.id) continue;
        try {
          const downloadedBuf = await this.googleApiRequest(
            `https://www.googleapis.com/drive/v3/files/${remoteMeta.id}?alt=media`,
            { responseType: 'buffer' }
          );
          if (Buffer.isBuffer(downloadedBuf) && downloadedBuf.length > 0) {
            fs.writeFileSync(path.join(assetsDir, path.basename(remoteAssetName)), downloadedBuf);
          }
        } catch (_) {}
      }
    } catch (_) {}

    const now = Date.now();
    this.saveConfig({ lastCloudSyncAt: now });
    return { success: true, syncedAt: now, count: localFiles.length };
  }

  getSyncStatus() {
    const detectedDesktop = this.detectGoogleDriveDesktopPath();
    const activeRoot = this.getActiveStorageRoot();
    const isDesktopDriveActive = Boolean(
      activeRoot &&
      (/내 드라이브|My Drive|Google Drive/i.test(activeRoot) || (detectedDesktop && activeRoot === detectedDesktop))
    );

    return {
      syncMode: this.config.syncMode,
      syncFolderPath: activeRoot,
      isDesktopDriveDetected: Boolean(detectedDesktop),
      detectedDesktopPath: detectedDesktop,
      isDesktopDriveActive,
      isOAuthConnected: this.isOAuthConnected(),
      cloudAccountEmail: this.config.cloudAccountEmail || null,
      lastCloudSyncAt: this.config.lastCloudSyncAt || null,
      oauthClientId: this.config.oauthClientId || '',
      hotkey: this.config.hotkey || 'Ctrl+Shift+Space'
    };
  }
}

module.exports = new DriveSyncManager();
