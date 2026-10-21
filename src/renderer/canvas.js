let currentBoard = null;
let boardsList = [];
let selectedObjectIds = new Set();
let copiedObjectsBuffer = [];
let lastCopiedAt = 0;

// Undo / Redo History Stack per Board (up to 50 steps)
const MAX_HISTORY_STEPS = 50;
const boardHistoryMap = new Map(); // boardId -> { undoStack: [], redoStack: [] }

function getBoardHistory(boardId = currentBoard?.id) {
  if (!boardId) return { undoStack: [], redoStack: [] };
  if (!boardHistoryMap.has(boardId)) {
    boardHistoryMap.set(boardId, { undoStack: [], redoStack: [] });
  }
  return boardHistoryMap.get(boardId);
}

function createBoardSnapshot(actionLabel = '작업') {
  if (!currentBoard) return null;
  return {
    actionLabel,
    timestamp: Date.now(),
    objects: JSON.parse(JSON.stringify(currentBoard.objects || [])),
    connectors: JSON.parse(JSON.stringify(currentBoard.connectors || [])),
    strokes: JSON.parse(JSON.stringify(currentBoard.strokes || [])),
    selectedIds: Array.from(selectedObjectIds)
  };
}

function updateUndoRedoButtonsUI() {
  const hist = getBoardHistory();
  const undoBtn = document.getElementById('undoBoardBtn');
  const redoBtn = document.getElementById('redoBoardBtn');
  if (undoBtn) {
    const lastAct = hist.undoStack[hist.undoStack.length - 1];
    undoBtn.style.opacity = hist.undoStack.length > 0 ? '1' : '0.45';
    undoBtn.title = lastAct
      ? `실행 취소: ${lastAct.actionLabel} (Ctrl+Z)`
      : '실행 취소 (Ctrl+Z)';
  }
  if (redoBtn) {
    const nextAct = hist.redoStack[hist.redoStack.length - 1];
    redoBtn.style.opacity = hist.redoStack.length > 0 ? '1' : '0.45';
    redoBtn.title = nextAct
      ? `다시 실행: ${nextAct.actionLabel} (Ctrl+Y / Ctrl+Shift+Z)`
      : '다시 실행 (Ctrl+Y / Ctrl+Shift+Z)';
  }
}

function pushUndoSnapshot(actionLabel = '작업', explicitSnapshot = null) {
  if (!currentBoard) return;
  const hist = getBoardHistory(currentBoard.id);
  const snap = explicitSnapshot ? { ...explicitSnapshot, actionLabel } : createBoardSnapshot(actionLabel);
  if (!snap) return;
  hist.undoStack.push(snap);
  if (hist.undoStack.length > MAX_HISTORY_STEPS) {
    hist.undoStack.shift();
  }
  hist.redoStack = [];
  updateUndoRedoButtonsUI();
}

function applyBoardSnapshot(snap) {
  if (!currentBoard || !snap) return;
  currentBoard.objects = JSON.parse(JSON.stringify(snap.objects || []));
  currentBoard.connectors = JSON.parse(JSON.stringify(snap.connectors || []));
  currentBoard.strokes = JSON.parse(JSON.stringify(snap.strokes || []));
  selectedObjectIds = new Set(snap.selectedIds || []);
  renderAllObjects();
  renderAllConnectors();
  renderAllStrokes();
  syncSelectionUI();
  updateUndoRedoButtonsUI();
  scheduleSaveBoard();
}

function undoBoardAction() {
  if (!currentBoard) return;
  const hist = getBoardHistory(currentBoard.id);
  if (hist.undoStack.length === 0) {
    showToast('↩️ 되돌릴 이전 작업 내역이 없습니다');
    return;
  }
  const prevSnap = hist.undoStack.pop();
  const currentSnap = createBoardSnapshot(prevSnap.actionLabel || '작업');
  if (currentSnap) {
    hist.redoStack.push(currentSnap);
  }
  applyBoardSnapshot(prevSnap);
  showToast(`↩️ 실행 취소 완료: ${prevSnap.actionLabel || '이전 상태 복구'} (Ctrl+Z)`);
}

function redoBoardAction() {
  if (!currentBoard) return;
  const hist = getBoardHistory(currentBoard.id);
  if (hist.redoStack.length === 0) {
    showToast('↪️ 다시 실행할 작업 내역이 없습니다');
    return;
  }
  const nextSnap = hist.redoStack.pop();
  const currentSnap = createBoardSnapshot(nextSnap.actionLabel || '작업');
  if (currentSnap) {
    hist.undoStack.push(currentSnap);
  }
  applyBoardSnapshot(nextSnap);
  showToast(`↪️ 다시 실행 완료: ${nextSnap.actionLabel || '작업 복원'} (Ctrl+Y)`);
}

let activeTool = 'select'; // 'select' | 'pen'
let currentPenColor = '#0a84ff';
let autoShapeEnabled = true;
let arrowPenMode = false;

// Viewport Transform State
let panX = 80;
let panY = 60;
let zoom = 1;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let spacePressed = false;

// Interaction States
let draggingObjState = null;
let resizingObjState = null;
let rotatingObjState = null;
let marqueeState = null;
let connectingState = null;
let draggingConnectorEndpoint = null; // { conn, end: 'from' | 'to', origObjId, snapPreview, snapshotBefore }
let selectedConnectorId = null;
let drawingStroke = null;
let saveDebounceTimer = null;
let lastFocusedTableCell = null; // { obj, rIdx, cIdx }

// DOM Elements
const canvasViewport = document.getElementById('canvasViewport');
const canvasWorld = document.getElementById('canvasWorld');
const objectLayer = document.getElementById('objectLayer');
const connectorsGroup = document.getElementById('connectorsGroup');
const strokesGroup = document.getElementById('strokesGroup');
const tempConnectorPath = document.getElementById('tempConnectorPath');
const objectInspector = document.getElementById('objectInspector');
const penToolbar = document.getElementById('penToolbar');
const boardListContainer = document.getElementById('boardListContainer');
const activeBoardTitleInput = document.getElementById('activeBoardTitleInput');
const activeBoardEmoji = document.getElementById('activeBoardEmoji');
const zoomResetBtn = document.getElementById('zoomResetBtn');
const toastBox = document.getElementById('toastBox');
const selectionMarquee = document.getElementById('selectionMarquee');
const dropOverlay = document.getElementById('dropOverlay');
const contextMenu = document.getElementById('contextMenu');

let toastTimer = null;
function showToast(msg) {
  if (!toastBox) return;
  toastBox.textContent = msg;
  toastBox.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.classList.add('hidden');
  }, 2600);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyViewportTransform() {
  if (!canvasWorld) return;
  canvasWorld.style.transform = `translate3d(${Math.round(panX)}px, ${Math.round(panY)}px, 0) scale(${zoom.toFixed(3)})`;
  if (canvasViewport) {
    const gridSize = Math.max(4, Math.round(24 * zoom));
    canvasViewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    canvasViewport.style.backgroundPosition = `${Math.round(panX)}px ${Math.round(panY)}px`;
  }
  if (zoomResetBtn) {
    zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
  }
  if (currentBoard) {
    currentBoard.viewport = { panX, panY, zoom };
  }
}

function screenToWorld(clientX, clientY) {
  const rect = canvasViewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom
  };
}

function worldToScreen(worldX, worldY) {
  const rect = canvasViewport.getBoundingClientRect();
  return {
    x: rect.left + panX + worldX * zoom,
    y: rect.top + panY + worldY * zoom
  };
}

function getViewportCenterWorld() {
  const rect = canvasViewport.getBoundingClientRect();
  return {
    x: Math.round((rect.width / 2 - panX) / zoom),
    y: Math.round((rect.height / 2 - panY) / zoom)
  };
}

let lastLocalSaveAt = 0;
let isSavingBoard = false;

function updateSidebarActiveBoardMetaInPlace() {
  if (!currentBoard || !boardListContainer) return;
  const entry = boardsList.find((b) => b.id === currentBoard.id);
  const objCount = Array.isArray(currentBoard.objects) ? currentBoard.objects.length : 0;
  if (entry) {
    entry.title = currentBoard.title || '제목 없는 보드';
    entry.objectCount = objCount;
    entry.updatedAt = currentBoard.updatedAt || Date.now();
  }
  const activeItem = boardListContainer.querySelector('.board-item.active');
  if (activeItem) {
    const titleEl = activeItem.querySelector('.board-item-title');
    const metaEl = activeItem.querySelector('.board-item-meta');
    if (titleEl) titleEl.textContent = currentBoard.title || '제목 없는 보드';
    if (metaEl) metaEl.textContent = `객체 ${objCount}개`;
  }
}

function scheduleSaveBoard() {
  if (!currentBoard) return;
  const now = Date.now();
  currentBoard.updatedAt = now;
  lastLocalSaveAt = now;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    if (!currentBoard) return;
    isSavingBoard = true;
    const saveTs = Date.now();
    currentBoard.updatedAt = saveTs;
    lastLocalSaveAt = saveTs;
    try {
      const saved = await window.freeformAPI.saveBoard(currentBoard);
      const afterTs = Date.now();
      lastLocalSaveAt = afterTs;
      if (currentBoard) {
        currentBoard.updatedAt = Math.max(currentBoard.updatedAt || 0, saved?.updatedAt || afterTs);
      }
      updateSidebarActiveBoardMetaInPlace();
    } catch (err) {
      console.error('Failed to auto-save board:', err);
    } finally {
      isSavingBoard = false;
    }
  }, 260);
}

// ============================================================================
// Board Loading & Sidebar Management
// ============================================================================
async function refreshBoardsSidebarList() {
  boardsList = await window.freeformAPI.listBoards();
  renderSidebarBoards();
}

const SVG_ICONS = {
  board: `<svg class="ui-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>`,
  vectorize: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`,
  chkSquare: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="m8 12 3 3 5-6"></path></svg>`,
  chkCircle: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>`,
  chkToggle: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="6"></rect><circle cx="16" cy="12" r="3" fill="currentColor"></circle></svg>`,
  plus: `<svg class="ui-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  minus: `<svg class="ui-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  copy: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  check: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  cut: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>`,
  paste: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg>`,
  download: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  externalLink: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`,
  play: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`,
  fileDoc: `<svg class="ui-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>`,
  bookOpen: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`,
  fileIconMode: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  group: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="13" width="8" height="8" rx="1.5"></rect><path d="M14 7h3a2 2 0 0 1 2 2v1"></path><path d="M10 17H7a2 2 0 0 1-2-2v-1"></path></svg>`,
  undo: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg>`,
  redo: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"></path><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"></path></svg>`,
  trash: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  lock: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
  up: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"></polyline><line x1="12" y1="6" x2="12" y2="18"></line></svg>`,
  sticky: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"></path><path d="M14 3v4a2 2 0 0 0 2 2h4"></path></svg>`,
  table: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`,
  fit: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>`,
  resetWin: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 12h6"></path><path d="M12 9v6"></path></svg>`
};

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../../node_modules/pdfjs-dist/build/pdf.worker.min.js';
}
const pdfDocCache = new Map(); // filePath -> { pdfDoc, extractedText }

function isPdfObject(obj) {
  if (!obj) return false;
  if (obj.type !== 'file' && obj.type !== 'pdf') return false;
  const nameOrPath = String(obj.fileName || obj.title || obj.resolvedFilePath || '').toLowerCase();
  return nameOrPath.endsWith('.pdf');
}

async function getOrLoadPdfDocument(filePath) {
  if (!filePath || !window.pdfjsLib) return null;
  if (pdfDocCache.has(filePath)) return pdfDocCache.get(filePath);
  const res = await window.freeformAPI.readPdfBase64(filePath);
  if (!res || !res.ok || !res.base64) return null;
  const binary = atob(res.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
  const pdfDoc = await loadingTask.promise;

  // Extract full text across pages in background for the one-click Copy All button
  const pageTexts = [];
  for (let p = 1; p <= Math.min(pdfDoc.numPages, 80); p++) {
    try {
      const page = await pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      const pageStr = tc.items.map((it) => it.str).join(' ').trim();
      if (pageStr) pageTexts.push(`[${p}페이지]\n${pageStr}`);
    } catch (_) {}
  }
  const entry = { pdfDoc, extractedText: pageTexts.join('\n\n') };
  pdfDocCache.set(filePath, entry);
  return entry;
}

// ============================================================================
// Persistent Custom Swatches & Typography Stacks (Fallback to System Default)
// ============================================================================
const DEFAULT_OBJECT_SWATCHES = ['#ffe066', '#0a84ff', '#30d158', '#ff85a2', '#bf5af2', '#ff9f0a', '#242428', '#ffffff'];
const DEFAULT_PEN_SWATCHES = ['#0a84ff', '#ffd60a', '#30d158', '#ff453a', '#bf5af2', '#ffffff'];
const SWATCH_SLOT_BY_NAME = {
  yellow: 0,
  blue: 1,
  green: 2,
  pink: 3,
  purple: 4,
  orange: 5,
  dark: 6,
  light: 7
};

let customObjectSwatches = [...DEFAULT_OBJECT_SWATCHES];
let customPenSwatches = [...DEFAULT_PEN_SWATCHES];

const FONT_FAMILY_STACKS = {
  default: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Pretendard", "Malgun Gothic", "맑은 고딕", "Segoe UI", Roboto, sans-serif',
  'Malgun Gothic': '"Malgun Gothic", "맑은 고딕", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  Pretendard: '"Pretendard", "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Malgun Gothic", system-ui, sans-serif',
  NanumGothic: '"NanumGothic", "나눔고딕", "Malgun Gothic", -apple-system, system-ui, sans-serif',
  NanumSquare: '"NanumSquare", "나눔스퀘어", "Malgun Gothic", -apple-system, system-ui, sans-serif',
  NanumMyeongjo: '"NanumMyeongjo", "나눔명조", "Batang", "바탕", "Malgun Gothic", serif, sans-serif',
  Batang: '"Batang", "바탕", "BatangChe", "Gungsuh", "Malgun Gothic", serif, sans-serif',
  Gulim: '"Gulim", "굴림", "Dotum", "돋움", "Malgun Gothic", system-ui, sans-serif',
  Gungsuh: '"Gungsuh", "궁서", "궁서체", "Batang", "Malgun Gothic", serif, sans-serif',
  Consolas: '"D2Coding", "Consolas", "Cascadia Mono", "Courier New", "Malgun Gothic", monospace, sans-serif'
};

function getObjectTextStyle(obj) {
  const ts = obj?.textStyle || {};
  const defaultSize = obj?.type === 'label' ? 32 : 14;
  return {
    fontFamily: ts.fontFamily && FONT_FAMILY_STACKS[ts.fontFamily] ? ts.fontFamily : 'default',
    fontSize: Number(ts.fontSize) || defaultSize,
    bold: ts.bold !== undefined ? Boolean(ts.bold) : obj?.type === 'label',
    italic: Boolean(ts.italic),
    underline: Boolean(ts.underline),
    textAlign: ['left', 'center', 'right'].includes(ts.textAlign) ? ts.textAlign : 'left'
  };
}

const ART_STYLE_LIST = [
  { id: 'none', label: '기본 텍스트' },
  { id: 'game', label: '게임 타이틀' },
  { id: 'graffiti', label: '스트릿 그래피티' },
  { id: 'neon', label: '사이버 네온' },
  { id: 'retro3d', label: '레트로 3D' },
  { id: 'sticker', label: '팝 스티커' },
  { id: 'gold', label: '골드 엠블럼' },
  { id: 'stamp', label: '배지 스탬프' }
];

const LABEL_COLOR_MAP = {
  yellow: '#ffd60a',
  blue: '#2997ff',
  green: '#30d158',
  pink: '#ff85a2',
  purple: '#bf5af2',
  orange: '#ff9f0a',
  dark: '#242428',
  light: '#ffffff'
};

function getResolvedObjectColorHex(obj) {
  if (!obj) return '#ffffff';
  if (obj.customColor) return obj.customColor;
  if (obj.color && SWATCH_SLOT_BY_NAME[obj.color] !== undefined) {
    const slot = SWATCH_SLOT_BY_NAME[obj.color];
    const slotHex = customObjectSwatches[slot];
    if (slotHex && slotHex.toLowerCase() !== DEFAULT_OBJECT_SWATCHES[slot].toLowerCase()) {
      return slotHex;
    }
  }
  if (obj.type === 'label') {
    if (obj.color === 'dark') {
      return document.body.classList.contains('theme-light') ? '#1d1d1f' : '#f5f5f7';
    }
    return LABEL_COLOR_MAP[obj.color] || '#ffffff';
  }
  return LABEL_COLOR_MAP[obj.color] || '#ffffff';
}

// Tracks the exact focused title / line / checklist row / table cell for per-line & per-element alignment!
let lastActiveAlignTarget = null;

function syncAlignButtonsUI(align = 'left') {
  const norm = ['left', 'center', 'right'].includes(align) ? align : 'left';
  document.getElementById('inspAlignLeftBtn')?.classList.toggle('active-pill', norm === 'left');
  document.getElementById('inspAlignCenterBtn')?.classList.toggle('active-pill', norm === 'center');
  document.getElementById('inspAlignRightBtn')?.classList.toggle('active-pill', norm === 'right');
}

function applyObjectTypography(el, obj) {
  if (!el || !obj) return;
  const ts = getObjectTextStyle(obj);
  const familyStack = FONT_FAMILY_STACKS[ts.fontFamily] || FONT_FAMILY_STACKS.default;
  const sizePx = `${ts.fontSize}px`;
  const weight = ts.bold ? '800' : '400';
  const style = ts.italic ? 'italic' : 'normal';
  const titleAlign = ['left', 'center', 'right'].includes(obj.titleAlign) ? obj.titleAlign : 'left';

  el.style.fontFamily = familyStack;

  const titleEl = el.querySelector('.ff-obj-title');
  if (titleEl) {
    titleEl.style.fontFamily = familyStack;
    titleEl.style.fontSize = `${Math.min(18, Math.max(12, obj.type === 'label' ? 13 : ts.fontSize))}px`;
    titleEl.style.fontWeight = ts.bold ? '800' : '600';
    titleEl.style.fontStyle = style;
    titleEl.style.textDecoration = ts.underline ? 'underline' : 'none';
    titleEl.style.textAlign = titleAlign;
  }

  el.querySelectorAll(
    '.ff-sticky-textarea, .ff-note-memo-area, .ff-table th, .ff-table td, .ff-label-editor, .ff-link-title, .ff-link-desc, .ff-file-name'
  ).forEach((node) => {
    node.style.fontFamily = familyStack;
    node.style.fontSize = sizePx;
    node.style.fontWeight = obj.type === 'label' && (obj.artStyle || 'none') !== 'none' ? '900' : weight;
    node.style.fontStyle = style;
    if (!node.querySelector('[contenteditable="true"]') && !node.querySelector('.ff-text-line')) {
      node.style.textDecoration = ts.underline ? 'underline' : 'none';
    }
  });

  el.querySelectorAll('.ff-text-line').forEach((lineNode) => {
    const lineAlign = lineNode.dataset.align || 'left';
    lineNode.style.textAlign = lineAlign;
    lineNode.style.textDecoration = ts.underline ? 'underline' : 'none';
  });

  el.querySelectorAll('.ff-check-input, .ff-table td span[contenteditable="true"]').forEach((node) => {
    node.style.fontFamily = familyStack;
    node.style.fontSize = sizePx;
    node.style.fontWeight = weight;
    node.style.fontStyle = style;
    const checkRow = node.closest('.ff-check-row');
    if (checkRow) {
      node.style.textAlign = checkRow.dataset.align || 'left';
    }
    const isCheckedRow =
      node.closest('.ff-check-row.is-checked') ||
      node.closest('.ff-check-row.checked') ||
      node.parentElement?.querySelector('.ff-chk-widget.checked');
    if (isCheckedRow && ts.underline) {
      node.style.textDecoration = 'underline line-through';
    } else if (isCheckedRow) {
      node.style.textDecoration = 'line-through';
    } else {
      node.style.textDecoration = ts.underline ? 'underline' : 'none';
    }
  });

  if (obj.type === 'label' && obj.vectorized) {
    const wrapEl = el.querySelector('.ff-label-wrap');
    if (wrapEl) renderVectorizedLabelIntoWrap(wrapEl, obj);
  }
}

function parseHexToRgb(hexStr) {
  const clean = String(hexStr || '').replace('#', '').trim();
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16)
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16)
    };
  }
  return null;
}

function applyObjectCustomColorStyles(el, obj) {
  if (!el || !obj) return;
  if (obj.type === 'image') return;

  if (obj.type === 'stroke') {
    const resolvedHex = getResolvedObjectColorHex(obj);
    if (obj.strokeData) obj.strokeData.color = resolvedHex;
    const visPath = el.querySelector('.ff-stroke-vis-path');
    if (visPath) {
      visPath.setAttribute('stroke', resolvedHex);
      if (obj.strokeData?.hasArrow) {
        visPath.setAttribute('marker-end', getOrCreateArrowMarkerUrl(resolvedHex, 'strokeArrow'));
      } else {
        visPath.removeAttribute('marker-end');
      }
    }
    return;
  }

  if (obj.type === 'label') {
    const resolvedHex = getResolvedObjectColorHex(obj);
    el.style.setProperty('--label-color', resolvedHex);
    const editor = el.querySelector('.ff-label-editor');
    if (editor) {
      if (!obj.artStyle || obj.artStyle === 'none') {
        editor.style.color = resolvedHex;
      } else {
        editor.style.color = '';
      }
    }
    if (obj.vectorized) {
      const wrapEl = el.querySelector('.ff-label-wrap');
      if (wrapEl) renderVectorizedLabelIntoWrap(wrapEl, obj);
    }
    return;
  }

  let customHex = obj.customColor || null;
  if (!customHex && obj.color && SWATCH_SLOT_BY_NAME[obj.color] !== undefined) {
    const slot = SWATCH_SLOT_BY_NAME[obj.color];
    const slotHex = customObjectSwatches[slot];
    if (slotHex && slotHex.toLowerCase() !== DEFAULT_OBJECT_SWATCHES[slot].toLowerCase()) {
      customHex = slotHex;
    }
  } else if (!customHex && /^#[0-9a-f]{3,6}$/i.test(obj.color || '')) {
    customHex = obj.color;
  }

  if (!customHex) {
    el.style.background = '';
    el.style.color = '';
    el.style.borderColor = '';
    return;
  }

  const rgb = parseHexToRgb(customHex);
  if (!rgb) return;
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  const isLightBg = lum > 0.6;
  const r2 = Math.max(0, rgb.r - 18);
  const g2 = Math.max(0, rgb.g - 18);
  const b2 = Math.max(0, rgb.b - 18);

  el.style.background = `linear-gradient(145deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.95), rgba(${r2}, ${g2}, ${b2}, 0.95))`;
  el.style.color = isLightBg ? '#1d1d1f' : '#f5f5f7';
  el.style.borderColor = isLightBg ? 'rgba(0, 0, 0, 0.16)' : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)`;
}

// ============================================================================
// Vector Graphic Title / Label Mode (Unlimited Scalable SVG Vector Text)
// ============================================================================
let _vectorMeasureCtx = null;
function measureVectorTextWidth(text, fontSpec) {
  if (!_vectorMeasureCtx) {
    const c = document.createElement('canvas');
    _vectorMeasureCtx = c.getContext('2d');
  }
  _vectorMeasureCtx.font = fontSpec;
  return _vectorMeasureCtx.measureText(text || ' ').width;
}

function getLabelDisplayLines(obj) {
  const raw = (obj?.content || '').trim() ? String(obj.content) : String(obj?.title || '프로젝트 타이틀');
  return raw.split('\n');
}

function computeVectorLabelMetrics(obj) {
  const ts = getObjectTextStyle(obj);
  const artStyle = obj?.artStyle || 'none';
  const baseFs = 72;
  const fontCss = FONT_FAMILY_STACKS[ts.fontFamily] || FONT_FAMILY_STACKS.default;
  const fontWeight = artStyle !== 'none' || ts.bold ? '800' : '600';
  const fontStyle = ts.italic ? 'italic' : 'normal';
  const fontSpec = `${fontStyle} ${fontWeight} ${baseFs}px ${fontCss}`;
  const rawLines = getLabelDisplayLines(obj);

  const widths = rawLines.map((ln) => Math.max(baseFs * 0.65, measureVectorTextWidth(ln || ' ', fontSpec) * 1.07));
  const maxTextW = Math.max(...widths, baseFs * 1.6);
  const padX = artStyle === 'stamp' ? 56 : artStyle === 'graffiti' || artStyle === 'retro3d' ? 42 : 28;
  const padY = artStyle === 'stamp' ? 38 : 24;
  const lineH = Math.round(baseFs * 1.24);
  const vbW = Math.round(maxTextW + padX * 2);
  const vbH = Math.round(rawLines.length * lineH + padY * 2);
  const aspect = Number((vbW / Math.max(1, vbH)).toFixed(4));

  return {
    ts,
    artStyle,
    baseFs,
    fontCss,
    fontWeight,
    fontStyle,
    rawLines,
    padX,
    padY,
    lineH,
    vbW,
    vbH,
    aspect
  };
}

function renderVectorizedLabelIntoWrap(wrapEl, obj) {
  if (!wrapEl || !obj) return;
  const m = computeVectorLabelMetrics(obj);
  obj.vectorAspect = m.aspect;
  const resolvedColor = getResolvedObjectColorHex(obj);
  const safeId = String(obj.id || 'lbl').replace(/[^a-zA-Z0-9_-]/g, '');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ff-label-vector-svg');
  svg.setAttribute('viewBox', `0 0 ${m.vbW} ${m.vbH}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  if (m.artStyle === 'game') {
    defs.innerHTML = `
      <linearGradient id="grad_game_${safeId}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#fffdf0"/>
        <stop offset="36%" stop-color="#ffe066"/>
        <stop offset="68%" stop-color="#ff9f0a"/>
        <stop offset="100%" stop-color="#ff3b30"/>
      </linearGradient>
    `;
  } else if (m.artStyle === 'gold') {
    defs.innerHTML = `
      <linearGradient id="grad_gold_${safeId}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#fff8cc"/>
        <stop offset="26%" stop-color="#ffd700"/>
        <stop offset="50%" stop-color="#b8860b"/>
        <stop offset="74%" stop-color="#fff1a8"/>
        <stop offset="100%" stop-color="#cca12c"/>
      </linearGradient>
    `;
  }
  svg.appendChild(defs);

  const artGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  if (m.artStyle === 'stamp') {
    artGroup.setAttribute('transform', `rotate(-1.2 ${m.vbW / 2} ${m.vbH / 2})`);
    const outerRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outerRect.setAttribute('x', '14');
    outerRect.setAttribute('y', '12');
    outerRect.setAttribute('width', String(Math.max(20, m.vbW - 28)));
    outerRect.setAttribute('height', String(Math.max(20, m.vbH - 24)));
    outerRect.setAttribute('rx', '20');
    outerRect.setAttribute('fill', 'rgba(20, 20, 26, 0.78)');
    outerRect.setAttribute('stroke', resolvedColor);
    outerRect.setAttribute('stroke-width', '7');
    artGroup.appendChild(outerRect);

    const innerRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    innerRect.setAttribute('x', '23');
    innerRect.setAttribute('y', '21');
    innerRect.setAttribute('width', String(Math.max(10, m.vbW - 46)));
    innerRect.setAttribute('height', String(Math.max(10, m.vbH - 42)));
    innerRect.setAttribute('rx', '14');
    innerRect.setAttribute('fill', 'none');
    innerRect.setAttribute('stroke', 'rgba(255, 255, 255, 0.22)');
    innerRect.setAttribute('stroke-width', '2.5');
    artGroup.appendChild(innerRect);
  } else if (m.artStyle === 'graffiti') {
    artGroup.setAttribute(
      'transform',
      `translate(${m.vbW / 2}, ${m.vbH / 2}) rotate(-2) skewX(-6) translate(${-m.vbW / 2}, ${-m.vbH / 2})`
    );
  }

  const makeSvgTextNode = (str, x, y, attrs = {}) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.textContent = str;
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('font-family', m.fontCss);
    t.setAttribute('font-size', String(m.baseFs));
    t.setAttribute('font-weight', m.fontWeight);
    t.setAttribute('font-style', m.fontStyle);
    t.setAttribute('paint-order', 'stroke fill');
    t.setAttribute('stroke-linejoin', 'round');
    t.setAttribute('stroke-linecap', 'round');
    if (m.ts.underline) {
      t.setAttribute('text-decoration', 'underline');
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) t.setAttribute(k, String(v));
    }
    return t;
  };

  m.rawLines.forEach((lineStr, idx) => {
    const align = (Array.isArray(obj.lineAligns) && obj.lineAligns[idx]) || 'left';
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const xPos = align === 'center' ? Math.round(m.vbW / 2) : align === 'right' ? m.vbW - m.padX : m.padX;
    const yPos = Math.round(m.padY + idx * m.lineH + m.baseFs * 0.86);

    if (m.artStyle === 'game') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos + 9, {
          'text-anchor': anchor,
          fill: '#1a0300',
          stroke: '#1a0300',
          'stroke-width': 10
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos + 5, {
          'text-anchor': anchor,
          fill: '#4a0e00',
          stroke: '#4a0e00',
          'stroke-width': 8
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: `url(#grad_game_${safeId})`,
          stroke: '#2b0900',
          'stroke-width': 5
        })
      );
    } else if (m.artStyle === 'graffiti') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos + 12, yPos + 12, {
          'text-anchor': anchor,
          fill: '#111115',
          stroke: '#111115',
          'stroke-width': 8
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos + 8, yPos + 8, {
          'text-anchor': anchor,
          fill: '#00f5d4',
          stroke: '#111115',
          'stroke-width': 6
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos + 4, yPos + 4, {
          'text-anchor': anchor,
          fill: '#ff2d55',
          stroke: '#111115',
          'stroke-width': 6
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: resolvedColor,
          stroke: '#111115',
          'stroke-width': 7
        })
      );
    } else if (m.artStyle === 'neon') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: 'none',
          stroke: resolvedColor,
          'stroke-width': 18,
          opacity: 0.3,
          style: 'filter: blur(8px);'
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: 'none',
          stroke: resolvedColor,
          'stroke-width': 8,
          opacity: 0.72,
          style: 'filter: blur(2.5px);'
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: '#ffffff',
          stroke: resolvedColor,
          'stroke-width': 2.5
        })
      );
    } else if (m.artStyle === 'retro3d') {
      const extrudeSteps = [
        { d: 10, c: '#1d1d24' },
        { d: 8, c: '#7209b7' },
        { d: 6, c: '#7209b7' },
        { d: 4, c: '#e63946' },
        { d: 2, c: '#ff6b00' }
      ];
      extrudeSteps.forEach((st) => {
        artGroup.appendChild(
          makeSvgTextNode(lineStr, xPos + st.d, yPos + st.d, {
            'text-anchor': anchor,
            fill: st.c,
            stroke: '#16161c',
            'stroke-width': 3
          })
        );
      });
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: resolvedColor,
          stroke: '#16161c',
          'stroke-width': 4.5
        })
      );
    } else if (m.artStyle === 'sticker') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos + 5, {
          'text-anchor': anchor,
          fill: 'rgba(0,0,0,0.34)',
          stroke: 'rgba(0,0,0,0.34)',
          'stroke-width': 18
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: resolvedColor,
          stroke: '#ffffff',
          'stroke-width': 15
        })
      );
    } else if (m.artStyle === 'gold') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos + 6, {
          'text-anchor': anchor,
          fill: '#3a2800',
          stroke: '#3a2800',
          'stroke-width': 7
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: `url(#grad_gold_${safeId})`,
          stroke: '#4a3500',
          'stroke-width': 4
        })
      );
    } else if (m.artStyle === 'stamp') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: resolvedColor
        })
      );
    } else {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: resolvedColor,
          style: 'filter: drop-shadow(0 3px 10px rgba(0,0,0,0.32));'
        })
      );
    }
  });

  svg.appendChild(artGroup);
  wrapEl.innerHTML = '';
  wrapEl.appendChild(svg);
}

function toggleLabelVectorized(obj) {
  if (!obj || obj.type !== 'label') return;
  draggingObjState = null;
  resizingObjState = null;

  // Sync any in-progress text from the live editor before switching
  const domEl = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"]`);
  const liveEditor = domEl?.querySelector('.ff-label-editor');
  if (liveEditor) {
    const lineDivs = Array.from(liveEditor.querySelectorAll('.ff-text-line'));
    if (lineDivs.length > 0) {
      obj.content = lineDivs.map((ln) => ln.textContent || '').join('\n');
      obj.lineAligns = lineDivs.map((ln) => ln.dataset.align || 'left');
    } else if (liveEditor.textContent) {
      obj.content = liveEditor.textContent;
    }
  }

  pushUndoSnapshot(obj.vectorized ? '벡터 이미지 해제 (텍스트 편집 전환)' : '텍스트 벡터 이미지화');
  obj.vectorized = !Boolean(obj.vectorized);

  if (obj.vectorized) {
    if (!(obj.content || '').trim()) {
      obj.content = (obj.title && obj.title !== '텍스트') ? obj.title : '프로젝트 타이틀';
    }
    const m = computeVectorLabelMetrics(obj);
    obj.vectorAspect = m.aspect;
    const baseW = Math.max(200, Math.round(obj.width || 380));
    obj.width = baseW;
    obj.height = Math.max(48, Math.round(baseW / Math.max(0.2, m.aspect)));
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }

  renderAllObjects();
  renderAllConnectors();
  selectObject(obj.id, { expandGroup: false });
  syncSelectionUI();
  scheduleSaveBoard();

  if (obj.vectorized) {
    showToast('✨ 벡터 이미지로 변환되었습니다! 우측 하단 모서리를 드래그해 원하는 크기로 크게 늘려보세요 (더블클릭 시 텍스트 편집)');
  } else {
    const nextEd = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"] .ff-label-editor`);
    nextEd?.focus();
    showToast('📝 일반 텍스트 편집 모드로 전환되었습니다');
  }
}

function getOrCreateArrowMarkerUrl(colorStr = '#0a84ff', prefix = 'dynArrow') {
  const svg = document.getElementById('connectorLayer');
  const defs = svg?.querySelector('defs');
  if (!defs) return 'url(#arrowHeadBlue)';
  const safeId = `${prefix}_${String(colorStr).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  let marker = defs.querySelector(`#${CSS.escape(safeId)}`);
  if (!marker) {
    marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', safeId);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('orient', 'auto');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M0,1 L9,5 L0,9 Z');
    p.setAttribute('fill', colorStr);
    marker.appendChild(p);
    defs.appendChild(marker);
  }
  return `url(#${safeId})`;
}

function getSelectedConnector() {
  if (!currentBoard || !selectedConnectorId) return null;
  return (currentBoard.connectors || []).find((c) => c.id === selectedConnectorId) || null;
}

function togglePdfObjectViewMode(obj) {
  if (!isPdfObject(obj)) return;
  // Cancel any in-progress drag state so the object's top-left (x, y) NEVER drifts or jumps!
  draggingObjState = null;
  resizingObjState = null;
  pushUndoSnapshot('PDF 보기 모드 전환');
  const fixedX = Math.round(obj.x || 0);
  const fixedY = Math.round(obj.y || 0);
  const curMode = obj.pdfViewMode || 'viewer';
  if (curMode === 'viewer') {
    obj.viewerWidth = obj.width || 480;
    obj.viewerHeight = obj.height || 580;
    obj.pdfViewMode = 'icon';
    obj.width = 330;
    obj.height = 135;
    showToast('아이콘 보기로 전환되었습니다');
  } else {
    obj.pdfViewMode = 'viewer';
    obj.width = Math.max(420, obj.viewerWidth || 480);
    obj.height = Math.max(500, obj.viewerHeight || 580);
    showToast('PDF 내용 보기로 전환되었습니다');
  }
  obj.x = fixedX;
  obj.y = fixedY;
  renderAllObjects();
  renderAllConnectors();
  scheduleSaveBoard();
}

async function copyEntireObjectContent(obj, copyBtnEl = null) {
  if (!obj) return;
  const flashSuccess = (toastMsg) => {
    if (copyBtnEl) {
      copyBtnEl.classList.add('copied');
      copyBtnEl.innerHTML = `${SVG_ICONS.check}<span>복사됨</span>`;
      setTimeout(() => {
        if (copyBtnEl.isConnected) {
          copyBtnEl.classList.remove('copied');
          copyBtnEl.innerHTML = `${SVG_ICONS.copy}<span>복사</span>`;
        }
      }, 1300);
    }
    showToast(toastMsg);
  };

  if (obj.type === 'sticky' || obj.type === 'label' || obj.type === 'stroke') {
    const txt = (obj.content || '').trim() || (obj.title || '');
    await window.freeformAPI.writeClipboardText(txt);
    flashSuccess(
      obj.type === 'label'
        ? '텍스트 내용이 클립보드에 복사되었습니다'
        : obj.type === 'stroke'
        ? '그리기 도형 정보가 복사되었습니다'
        : '포스트잇 내용이 클립보드에 모두 복사되었습니다'
    );
  } else if (obj.type === 'text') {
    const parsed = parseNoteLines(obj.content || '');
    const lines = parsed
      .map((it) => {
        if (it.isCheck) {
          if (!it.text.trim()) return '';
          return `${it.checked ? '☑' : '☐'} ${it.text}`;
        }
        return it.text;
      })
      .filter((l) => l !== '');
    const out = lines.join('\n') || obj.title || '';
    await window.freeformAPI.writeClipboardText(out);
    flashSuccess('체크리스트 및 메모 내용이 모두 복사되었습니다');
  } else if (obj.type === 'table') {
    const tsv = (obj.tableData || [])
      .map((r) =>
        r
          .map((c) =>
            String(c ?? '')
              .replace(/^\[(square|circle|toggle):1\]\s?/, '☑ ')
              .replace(/^\[(square|circle|toggle):0\]\s?/, '☐ ')
          )
          .join('\t')
      )
      .join('\n');
    await window.freeformAPI.writeClipboardText(tsv);
    flashSuccess('표 전체 내용이 복사되었습니다 (엑셀/시트에 바로 붙여넣기 가능)');
  } else if (obj.type === 'image') {
    const res = await window.freeformAPI.writeClipboardImage({
      filePath: obj.resolvedFilePath,
      dataUrl: obj.imageUrl
    });
    if (res && res.ok) {
      flashSuccess('이미지가 클립보드에 복사되었습니다 (Ctrl+V로 어디든 붙여넣기 가능)');
    } else {
      await window.freeformAPI.writeClipboardText(obj.resolvedFilePath || obj.title || '');
      flashSuccess('이미지 경로가 복사되었습니다');
    }
  } else if (obj.type === 'link') {
    const txt = obj.url || obj.title || '';
    await window.freeformAPI.writeClipboardText(txt);
    flashSuccess('링크 주소(URL)가 클립보드에 복사되었습니다');
  } else if (obj.type === 'file' || obj.type === 'pdf') {
    if (isPdfObject(obj) && obj.resolvedFilePath) {
      const entry = await getOrLoadPdfDocument(obj.resolvedFilePath);
      if (entry && entry.extractedText && entry.extractedText.trim()) {
        await window.freeformAPI.writeClipboardText(entry.extractedText);
        flashSuccess('PDF 문서 내 전체 텍스트가 클립보드에 복사되었습니다');
        return;
      }
    }
    await window.freeformAPI.writeClipboardText(obj.resolvedFilePath || obj.fileName || obj.title || '');
    flashSuccess('첨부 파일 정보/경로가 클립보드에 복사되었습니다');
  }
}

function renderSidebarBoards() {
  if (!boardListContainer) return;
  const q = (document.getElementById('boardSearchInput')?.value || '').trim().toLowerCase();
  const filtered = q
    ? boardsList.filter((b) => (b.title || '').toLowerCase().includes(q))
    : boardsList;

  boardListContainer.innerHTML = '';
  filtered.forEach((b) => {
    const item = document.createElement('div');
    item.className = `board-item ${currentBoard && currentBoard.id === b.id ? 'active' : ''}`;
    item.innerHTML = `
      <div class="board-item-left">
        <span style="display:inline-flex;align-items:center;opacity:0.8;">${SVG_ICONS.board}</span>
        <div style="min-width:0;flex:1;">
          <div class="board-item-title">${escapeHtml(b.title)}</div>
          <div class="board-item-meta">객체 ${b.objectCount || 0}개</div>
        </div>
      </div>
      <button class="board-del-btn" title="보드 삭제">&times;</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.board-del-btn')) return;
      loadBoardById(b.id);
    });
    const delBtn = item.querySelector('.board-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`'${b.title}' 보드를 삭제하시겠습니까?`)) {
          const res = await window.freeformAPI.deleteBoard(b.id);
          await refreshBoardsSidebarList();
          if (res && res.nextBoardId) {
            await loadBoardById(res.nextBoardId);
          }
          showToast('보드가 삭제되었습니다');
        }
      });
    }
    boardListContainer.appendChild(item);
  });
}

async function loadBoardById(boardId) {
  const board = await window.freeformAPI.getBoard(boardId);
  if (!board) return;
  currentBoard = board;
  if (!Array.isArray(currentBoard.objects)) currentBoard.objects = [];
  if (!Array.isArray(currentBoard.connectors)) currentBoard.connectors = [];
  if (!Array.isArray(currentBoard.strokes)) currentBoard.strokes = [];

  // Automatically convert any legacy board.strokes into selectable/editable 'stroke' objects
  if (currentBoard.strokes.length > 0) {
    let migrated = false;
    currentBoard.strokes.forEach((legacyStroke) => {
      const strokeObj = buildStrokeObjectFromRawStroke(legacyStroke);
      if (strokeObj) {
        currentBoard.objects.push(strokeObj);
        migrated = true;
      }
    });
    currentBoard.strokes = [];
    if (migrated) scheduleSaveBoard();
  }

  panX = currentBoard.viewport?.panX ?? 80;
  panY = currentBoard.viewport?.panY ?? 60;
  zoom = currentBoard.viewport?.zoom ?? 1;

  if (activeBoardTitleInput) activeBoardTitleInput.value = currentBoard.title || '새 프리폼 보드';
  if (activeBoardEmoji) {
    activeBoardEmoji.innerHTML =
      '<img src="../../assets/icon.png" alt="FreeformDrive" class="board-brand-icon" draggable="false" />';
  }

  selectedConnectorId = null;
  clearSelection();
  applyViewportTransform();
  renderAllObjects();
  renderAllConnectors();
  renderAllStrokes();
  updateUndoRedoButtonsUI();
  await refreshBoardsSidebarList();
}

// ============================================================================
// Multi-Selection & Grouping Management
// ============================================================================
function getSelectedObjects() {
  if (!currentBoard) return [];
  return currentBoard.objects.filter((o) => selectedObjectIds.has(o.id));
}

function getPrimarySelectedObject() {
  const list = getSelectedObjects();
  return list.length > 0 ? list[list.length - 1] : null;
}

function clearSelection() {
  selectedObjectIds.clear();
  syncSelectionUI();
}

function selectObject(objId, { additive = false, expandGroup = true } = {}) {
  if (!objId) {
    clearSelection();
    return;
  }
  selectedConnectorId = null;
  if (!additive) {
    selectedObjectIds.clear();
  }
  const target = currentBoard?.objects.find((o) => o.id === objId);
  if (!target) {
    syncSelectionUI();
    return;
  }

  if (additive && selectedObjectIds.has(objId)) {
    selectedObjectIds.delete(objId);
    if (expandGroup && target.groupId) {
      currentBoard.objects
        .filter((o) => o.groupId === target.groupId)
        .forEach((o) => selectedObjectIds.delete(o.id));
    }
  } else {
    selectedObjectIds.add(objId);
    if (expandGroup && target.groupId) {
      currentBoard.objects
        .filter((o) => o.groupId === target.groupId)
        .forEach((o) => selectedObjectIds.add(o.id));
    }
  }
  syncSelectionUI();
}

function setSelectedObjectIds(ids, expandGroups = true) {
  selectedObjectIds.clear();
  if (!currentBoard) return;
  const idSet = new Set(ids);
  currentBoard.objects.forEach((o) => {
    if (idSet.has(o.id)) {
      selectedObjectIds.add(o.id);
      if (expandGroups && o.groupId) {
        currentBoard.objects
          .filter((g) => g.groupId === o.groupId)
          .forEach((g) => selectedObjectIds.add(g.id));
      }
    }
  });
  syncSelectionUI();
}

function syncSelectionUI() {
  document.querySelectorAll('.ff-object').forEach((el) => {
    el.classList.toggle('selected', selectedObjectIds.has(el.dataset.id));
  });
  const selected = getSelectedObjects();
  const selectedConn = getSelectedConnector();
  const hasSelection = selected.length > 0 || Boolean(selectedConn);

  if (objectInspector) {
    objectInspector.classList.toggle('hidden', !hasSelection);

    const objGroupEl = document.getElementById('inspObjOnlyGroup');
    const typoGroupEl = document.getElementById('inspTypoGroup');
    const connGroupEl = document.getElementById('inspConnOnlyGroup');
    const strokeGroupEl = document.getElementById('inspStrokeOnlyGroup');

    if (selectedConn && selected.length === 0) {
      objGroupEl?.classList.add('hidden');
      typoGroupEl?.classList.add('hidden');
      strokeGroupEl?.classList.add('hidden');
      connGroupEl?.classList.remove('hidden');

      const styleLbl = document.getElementById('inspConnStyleLabel');
      if (styleLbl) {
        styleLbl.textContent = selectedConn.style === 'dashed' ? '점선 화살표' : '실선 화살표';
      }
      document.querySelectorAll('#inspectorColors .swatch').forEach((sw) => {
        sw.classList.toggle(
          'active-swatch',
          (sw.dataset.hex || '').toLowerCase() === (selectedConn.color || '#0a84ff').toLowerCase()
        );
      });
    } else if (selected.length > 0) {
      const primary = selected[selected.length - 1];
      const allStrokes = selected.every((o) => o.type === 'stroke');
      const hasStrokes = selected.some((o) => o.type === 'stroke');

      objGroupEl?.classList.remove('hidden');
      typoGroupEl?.classList.toggle('hidden', allStrokes);
      strokeGroupEl?.classList.toggle('hidden', !hasStrokes);
      connGroupEl?.classList.add('hidden');

      if (hasStrokes) {
        const strokeObj = selected.find((o) => o.type === 'stroke') || primary;
        const sd = strokeObj.strokeData || {};
        const widthSel = document.getElementById('inspStrokeWidthSelect');
        if (widthSel) widthSel.value = String(sd.strokeWidth || 3.5);
        const dashLbl = document.getElementById('inspStrokeDashLabel');
        if (dashLbl) dashLbl.textContent = sd.dashed ? '점선' : '실선';
        const arrowLbl = document.getElementById('inspStrokeArrowLabel');
        if (arrowLbl) arrowLbl.textContent = sd.hasArrow ? '화살촉 ON' : '화살촉 OFF';
        document.getElementById('inspStrokeDashBtn')?.classList.toggle('active-pill', Boolean(sd.dashed));
        document.getElementById('inspStrokeArrowBtn')?.classList.toggle('active-pill', Boolean(sd.hasArrow));
      }
      const anyLocked = selected.some((o) => o.locked);
      const lockLabel = document.getElementById('inspLockBtnLabel');
      if (lockLabel) lockLabel.textContent = anyLocked ? '잠김' : '잠금';

      const groupLabel = document.getElementById('inspGroupBtnLabel');
      const allSameGroup =
        selected.length >= 1 &&
        selected[0].groupId &&
        selected.every((o) => o.groupId === selected[0].groupId);
      if (groupLabel) {
        groupLabel.textContent = allSameGroup ? '그룹 해제' : `그룹화 (${selected.length})`;
      }

      // Sync Typography UI controls to primary selected object
      const ts = getObjectTextStyle(primary);
      const famSel = document.getElementById('inspFontFamilySelect');
      const sizeSel = document.getElementById('inspFontSizeSelect');
      const artSel = document.getElementById('inspArtStyleSelect');
      const vecBtn = document.getElementById('inspVectorizeBtn');
      const vecLbl = document.getElementById('inspVectorizeBtnLabel');
      const hasLabel = selected.some((o) => o.type === 'label');
      if (famSel) famSel.value = ts.fontFamily;
      if (sizeSel) sizeSel.value = String(ts.fontSize);
      if (artSel) {
        artSel.classList.toggle('hidden', !hasLabel);
        if (hasLabel) {
          artSel.value = primary.artStyle || 'none';
        }
      }
      if (vecBtn) {
        vecBtn.classList.toggle('hidden', !hasLabel);
        const isVec = Boolean(primary.vectorized);
        vecBtn.classList.toggle('active-pill', isVec);
        if (vecLbl) vecLbl.textContent = isVec ? '텍스트 편집' : '벡터 이미지화';
      }
      document.getElementById('inspBoldBtn')?.classList.toggle('active-pill', ts.bold);
      document.getElementById('inspItalicBtn')?.classList.toggle('active-pill', ts.italic);
      document.getElementById('inspUnderlineBtn')?.classList.toggle('active-pill', ts.underline);

      let currentDisplayAlign = 'left';
      if (lastActiveAlignTarget && selectedObjectIds.has(lastActiveAlignTarget.obj?.id)) {
        if (lastActiveAlignTarget.kind === 'title') {
          currentDisplayAlign = lastActiveAlignTarget.obj.titleAlign || 'left';
        } else if (lastActiveAlignTarget.kind === 'check-row') {
          currentDisplayAlign = lastActiveAlignTarget.rowEl?.dataset?.align || 'left';
        } else if (lastActiveAlignTarget.kind === 'table-cell') {
          const ck = `${lastActiveAlignTarget.rIdx}_${lastActiveAlignTarget.cIdx}`;
          currentDisplayAlign = lastActiveAlignTarget.obj.cellAligns?.[ck] || 'left';
        } else if (lastActiveAlignTarget.kind === 'line-editor') {
          const lines = lastActiveAlignTarget.getTargetLines?.() || [];
          currentDisplayAlign = lines[0]?.dataset?.align || 'left';
        }
      } else if (Array.isArray(primary.lineAligns) && primary.lineAligns.length > 0) {
        currentDisplayAlign = primary.lineAligns[0] || 'left';
      }
      syncAlignButtonsUI(currentDisplayAlign);

      document.querySelectorAll('#inspectorColors .swatch').forEach((sw) => {
        const isMatch =
          primary.customColor
            ? (sw.dataset.hex || '').toLowerCase() === primary.customColor.toLowerCase()
            : sw.dataset.color === primary.color;
        sw.classList.toggle('active-swatch', isMatch);
      });
    }
  }
}

function toggleGroupSelectedObjects() {
  const selected = getSelectedObjects();
  if (selected.length === 0) return;

  const firstGroupId = selected[0].groupId;
  const allSameGroup = firstGroupId && selected.every((o) => o.groupId === firstGroupId);

  if (allSameGroup) {
    pushUndoSnapshot('그룹 해제');
    // Ungroup all members of this group
    currentBoard.objects.forEach((o) => {
      if (o.groupId === firstGroupId) delete o.groupId;
    });
    renderAllObjects();
    syncSelectionUI();
    scheduleSaveBoard();
    showToast('객체 그룹이 해제되었습니다');
  } else {
    if (selected.length < 2) {
      showToast('Shift+드래그 또는 Shift+클릭으로 2개 이상의 객체를 선택한 뒤 그룹화해 주세요');
      return;
    }
    pushUndoSnapshot(`객체 그룹화 (${selected.length}개)`);
    const newGroupId = `grp_${Date.now().toString().slice(-5)}`;
    selected.forEach((o) => {
      o.groupId = newGroupId;
    });
    renderAllObjects();
    syncSelectionUI();
    scheduleSaveBoard();
    showToast(`${selected.length}개 객체가 하나의 그룹으로 묶였습니다`);
  }
}

function rotateSelectedObjects(deltaDeg, absoluteDeg = null) {
  const selected = getSelectedObjects();
  if (selected.length === 0) return;
  pushUndoSnapshot('객체 회전');
  selected.forEach((obj) => {
    if (obj.locked) return;
    if (typeof absoluteDeg === 'number') {
      obj.rotation = absoluteDeg;
    } else {
      obj.rotation = Math.round(((obj.rotation || 0) + deltaDeg) % 360);
    }
    const el = objectLayer.querySelector(`.ff-object[data-id="${obj.id}"]`);
    if (el) {
      el.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : '';
    }
  });
  scheduleSaveBoard();
}

// ============================================================================
// 3-Style Interactive Checkbox Parser & Builder (Checklist Cards & Table Cells)
// ============================================================================
function parseNoteLines(rawContent) {
  const lines = String(rawContent ?? '').split('\n');
  return lines.map((line) => {
    let m = line.match(/^\[(square|circle|toggle):(0|1)(?::(left|center|right))?\]\s?(.*)$/);
    if (m) {
      return {
        isCheck: true,
        style: m[1],
        checked: m[2] === '1',
        align: m[3] || 'left',
        text: m[4]
      };
    }
    m = line.match(/^(?:-\s*\[\s*\]|☐)\s?(.*)$/);
    if (m) {
      return { isCheck: true, style: 'square', checked: false, align: 'left', text: m[1] };
    }
    m = line.match(/^(?:-\s*\[[xX]\]|☑)\s?(.*)$/);
    if (m) {
      return { isCheck: true, style: 'square', checked: true, align: 'left', text: m[1] };
    }
    return { isCheck: false, text: line };
  });
}

function serializeNoteLines(items) {
  return items
    .map((item) => {
      if (item.isCheck) {
        const st = item.style || 'square';
        const ck = item.checked ? '1' : '0';
        const al = item.align && item.align !== 'left' ? `:${item.align}` : '';
        return `[${st}:${ck}${al}] ${item.text || ''}`;
      }
      return item.text || '';
    })
    .join('\n');
}

// ============================================================================
// Per-Line Multiline Editor (Independent Left / Center / Right per line!)
// ============================================================================
function createLineDivElement(text = '', align = 'left') {
  const normAlign = ['left', 'center', 'right'].includes(align) ? align : 'left';
  const div = document.createElement('div');
  div.className = 'ff-text-line';
  div.dataset.align = normAlign;
  div.style.textAlign = normAlign;
  if (text && text.length > 0) {
    div.textContent = text;
  } else {
    div.innerHTML = '<br>';
  }
  return div;
}

function setLineDivText(lineDiv, text = '') {
  if (!lineDiv) return;
  if (text && text.length > 0) {
    lineDiv.textContent = text;
  } else {
    lineDiv.innerHTML = '<br>';
  }
}

function getCaretOffsetInLine(lineDiv) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return (lineDiv.textContent || '').length;
  const range = sel.getRangeAt(0);
  if (!lineDiv.contains(range.startContainer)) return (lineDiv.textContent || '').length;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(lineDiv);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function setCaretOffsetInLine(lineDiv, charOffset = 0) {
  if (!lineDiv) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const textNode = Array.from(lineDiv.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
  if (!textNode) {
    range.setStart(lineDiv, 0);
    range.collapse(true);
  } else {
    const clamped = Math.max(0, Math.min(charOffset, textNode.nodeValue.length));
    range.setStart(textNode, clamped);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function setupPerLineEditor(editorEl, { obj, initialText = '', initialAligns = [], placeholder = '', onSync }) {
  editorEl.contentEditable = 'true';
  editorEl.spellcheck = false;
  editorEl.dataset.placeholder = placeholder;
  editorEl.innerHTML = '';

  const rawLines = String(initialText ?? '').split('\n');
  rawLines.forEach((lineStr, idx) => {
    const al = initialAligns[idx] || 'left';
    editorEl.appendChild(createLineDivElement(lineStr, al));
  });

  let lastFocusedLineDiv = editorEl.querySelector('.ff-text-line');
  let isComposing = false;

  const updatePlaceholderState = () => {
    const allLines = Array.from(editorEl.querySelectorAll('.ff-text-line'));
    const isEmpty = allLines.length === 1 && (allLines[0].textContent || '') === '';
    editorEl.classList.toggle('is-empty', isEmpty);
    const firstAlign = allLines[0]?.dataset.align || 'left';
    editorEl.dataset.emptyAlign = firstAlign;
  };

  const normalizeStructure = (allowDomMutation = true) => {
    let lines = Array.from(editorEl.querySelectorAll('.ff-text-line'));
    if (!allowDomMutation) {
      return lines;
    }
    if (lines.length === 0) {
      const fallbackText = editorEl.textContent || '';
      editorEl.innerHTML = '';
      const firstDiv = createLineDivElement(fallbackText, 'left');
      editorEl.appendChild(firstDiv);
      setCaretOffsetInLine(firstDiv, fallbackText.length);
      lines = [firstDiv];
    } else {
      lines.forEach((ln) => {
        if ((ln.textContent || '') === '' && !ln.querySelector('br')) {
          ln.innerHTML = '<br>';
        }
      });
    }
    return lines;
  };

  const syncToModel = (fromInputEvent = false) => {
    const lines = normalizeStructure(!isComposing && !fromInputEvent);
    if (lines.length === 0) {
      const raw = editorEl.textContent || '';
      onSync(raw, ['left']);
      return;
    }
    const texts = lines.map((ln) => ln.textContent || '');
    const aligns = lines.map((ln) => ln.dataset.align || 'left');
    updatePlaceholderState();
    onSync(texts.join('\n'), aligns);
  };

  const getSelectedLineDivs = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editorEl.contains(range.commonAncestorContainer)) {
        const allLines = Array.from(editorEl.querySelectorAll('.ff-text-line'));
        if (!sel.isCollapsed) {
          const hit = allLines.filter((ln) => {
            try {
              return sel.containsNode(ln, true);
            } catch (_) {
              return false;
            }
          });
          if (hit.length > 0) {
            lastFocusedLineDiv = hit[hit.length - 1];
            return hit;
          }
        }
        const anchorEl =
          sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
        const anchorLine = anchorEl?.closest?.('.ff-text-line');
        if (anchorLine && editorEl.contains(anchorLine)) {
          lastFocusedLineDiv = anchorLine;
          return [anchorLine];
        }
      }
    }
    if (lastFocusedLineDiv && editorEl.contains(lastFocusedLineDiv)) {
      return [lastFocusedLineDiv];
    }
    const first = editorEl.querySelector('.ff-text-line');
    return first ? [first] : [];
  };

  const registerFocusContext = () => {
    const lines = getSelectedLineDivs();
    const curAlign = lines[0]?.dataset.align || 'left';
    lastActiveAlignTarget = {
      kind: 'line-editor',
      obj,
      editorEl,
      getTargetLines: getSelectedLineDivs,
      syncFn: syncToModel
    };
    syncAlignButtonsUI(curAlign);
  };

  editorEl.addEventListener('focus', registerFocusContext);
  editorEl.addEventListener('mouseup', registerFocusContext);
  editorEl.addEventListener('keyup', registerFocusContext);

  editorEl.addEventListener('compositionstart', () => {
    isComposing = true;
  });

  editorEl.addEventListener('compositionend', () => {
    isComposing = false;
    syncToModel(false);
  });

  editorEl.addEventListener('input', (e) => {
    if (e.isComposing || isComposing) {
      syncToModel(true);
    } else {
      syncToModel(false);
    }
  });

  editorEl.addEventListener('keydown', (e) => {
    if (
      e.key === 'Backspace' ||
      e.key === 'Delete' ||
      e.key === 'Enter' ||
      e.code === 'Space' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      e.stopPropagation();
    }

    if (e.isComposing || e.keyCode === 229) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.deleteFromDocument();
      }
      normalizeStructure();
      const curLine = getSelectedLineDivs()[0] || editorEl.querySelector('.ff-text-line');
      if (!curLine) return;
      const offset = getCaretOffsetInLine(curLine);
      const full = curLine.textContent || '';
      const before = full.slice(0, offset);
      const after = full.slice(offset);
      const curAlign = curLine.dataset.align || 'left';

      setLineDivText(curLine, before);
      const nextLine = createLineDivElement(after, curAlign);
      curLine.after(nextLine);
      setCaretOffsetInLine(nextLine, 0);
      lastFocusedLineDiv = nextLine;
      syncToModel();
      registerFocusContext();
      return;
    }

    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        const curLine = getSelectedLineDivs()[0];
        if (curLine) {
          const offset = getCaretOffsetInLine(curLine);
          const full = curLine.textContent || '';
          if (offset === 0) {
            e.preventDefault();
            const prevLine = curLine.previousElementSibling;
            if (prevLine && prevLine.classList.contains('ff-text-line')) {
              const prevText = prevLine.textContent || '';
              const joinPos = prevText.length;
              setLineDivText(prevLine, prevText + full);
              curLine.remove();
              setCaretOffsetInLine(prevLine, joinPos);
              lastFocusedLineDiv = prevLine;
              syncToModel();
              registerFocusContext();
            }
            return;
          }
          if (offset === 1 && full.length === 1) {
            e.preventDefault();
            setLineDivText(curLine, '');
            setCaretOffsetInLine(curLine, 0);
            syncToModel();
            return;
          }
        }
      }
      return;
    }

    if (e.key === 'Delete') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        const curLine = getSelectedLineDivs()[0];
        if (curLine) {
          const offset = getCaretOffsetInLine(curLine);
          const full = curLine.textContent || '';
          if (offset >= full.length) {
            const nextLine = curLine.nextElementSibling;
            if (nextLine && nextLine.classList.contains('ff-text-line')) {
              e.preventDefault();
              const nextText = nextLine.textContent || '';
              setLineDivText(curLine, full + nextText);
              nextLine.remove();
              setCaretOffsetInLine(curLine, full.length);
              syncToModel();
              return;
            }
          }
        }
      }
    }
  });

  editorEl.addEventListener('paste', (e) => {
    const pastedText = e.clipboardData?.getData('text/plain');
    if (typeof pastedText !== 'string') return;
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      sel.deleteFromDocument();
    }
    normalizeStructure();
    const curLine = getSelectedLineDivs()[0] || editorEl.querySelector('.ff-text-line');
    if (!curLine) return;
    const offset = getCaretOffsetInLine(curLine);
    const full = curLine.textContent || '';
    const before = full.slice(0, offset);
    const after = full.slice(offset);
    const curAlign = curLine.dataset.align || 'left';
    const parts = pastedText.replace(/\r\n/g, '\n').split('\n');

    if (parts.length === 1) {
      setLineDivText(curLine, before + parts[0] + after);
      setCaretOffsetInLine(curLine, (before + parts[0]).length);
    } else {
      setLineDivText(curLine, before + parts[0]);
      let anchor = curLine;
      for (let i = 1; i < parts.length - 1; i++) {
        const midLine = createLineDivElement(parts[i], curAlign);
        anchor.after(midLine);
        anchor = midLine;
      }
      const lastPart = parts[parts.length - 1];
      const endLine = createLineDivElement(lastPart + after, curAlign);
      anchor.after(endLine);
      setCaretOffsetInLine(endLine, lastPart.length);
      lastFocusedLineDiv = endLine;
    }
    syncToModel();
    registerFocusContext();
  });

  updatePlaceholderState();
  return { syncToModel, getSelectedLineDivs };
}

function appendCheckItemToNote(obj, style = 'square', labelText = '') {
  pushUndoSnapshot('체크박스 항목 추가');
  // If called on a sticky note, upgrade it to a checklist ('text') card or append check line
  if (obj.type === 'sticky') {
    obj.type = 'text';
  }
  const items = parseNoteLines(obj.content || '');
  if (items.length === 1 && !items[0].isCheck && !items[0].text.trim()) {
    items[0] = { isCheck: true, style, checked: false, text: labelText };
  } else {
    items.push({ isCheck: true, style, checked: false, text: labelText });
  }
  obj.content = serializeNoteLines(items);
  renderAllObjects();
  scheduleSaveBoard();
}

// ============================================================================
// Render Objects on Infinite Canvas
// ============================================================================
function renderAllObjects() {
  if (!objectLayer || !currentBoard) return;
  objectLayer.innerHTML = '';
  currentBoard.objects.forEach((obj) => {
    try {
      const el = createObjectDOM(obj);
      objectLayer.appendChild(el);
    } catch (err) {
      console.error('Failed to render object:', obj?.id, err);
    }
  });
}

function createObjectDOM(obj) {
  const el = document.createElement('div');
  const isSelected = selectedObjectIds.has(obj.id);
  const isPdf = isPdfObject(obj);
  const artClass = obj.type === 'label' ? `art-${obj.artStyle || 'none'} ${obj.vectorized ? 'is-vectorized' : ''}` : '';
  el.className = `ff-object type-${obj.type || 'sticky'} ${isPdf ? 'is-pdf' : ''} ${artClass} color-${obj.color || 'dark'} ${isSelected ? 'selected' : ''}`;
  el.dataset.id = obj.id;
  el.style.left = `${Math.round(obj.x || 0)}px`;
  el.style.top = `${Math.round(obj.y || 0)}px`;
  el.style.width = `${Math.round(obj.width || 300)}px`;
  el.style.height = `${Math.round(obj.height || 200)}px`;
  el.style.zIndex = String(obj.zIndex || 1);
  if (obj.rotation) {
    el.style.transform = `rotate(${obj.rotation}deg)`;
  }

  // Rotation Handle (Top Center)
  const rotHandle = document.createElement('div');
  rotHandle.className = 'ff-rotate-handle';
  rotHandle.title = '드래그하여 객체 회전 (더블클릭 시 0° 초기화)';
  rotHandle.textContent = '↻';
  rotHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || obj.locked) return;
    e.stopPropagation();
    if (!selectedObjectIds.has(obj.id)) selectObject(obj.id);
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const startAngle = (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;
    rotatingObjState = {
      obj,
      el,
      centerX,
      centerY,
      startAngle,
      origRotation: obj.rotation || 0,
      snapshotBefore: createBoardSnapshot('객체 회전')
    };
  });
  rotHandle.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    pushUndoSnapshot('객체 회전 초기화');
    obj.rotation = 0;
    el.style.transform = '';
    scheduleSaveBoard();
  });
  el.appendChild(rotHandle);

  // Header (Title + PDF View Toggle + Art Style Badge + Group Badge + Right-end Copy All Button)
  const header = document.createElement('div');
  header.className = 'ff-obj-header';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'ff-obj-title';
  titleInput.value = obj.title || '';
  titleInput.style.textAlign = obj.titleAlign || 'left';
  titleInput.placeholder =
    obj.type === 'sticky' ? '📌 포스트잇 메모' : obj.type === 'label' ? '텍스트' : '제목 입력...';
  const registerTitleAlignTarget = () => {
    lastActiveAlignTarget = {
      kind: 'title',
      obj,
      el: titleInput
    };
    syncAlignButtonsUI(obj.titleAlign || 'left');
  };
  titleInput.addEventListener('focus', registerTitleAlignTarget);
  titleInput.addEventListener('mouseup', registerTitleAlignTarget);
  titleInput.addEventListener('keyup', registerTitleAlignTarget);
  titleInput.addEventListener('input', () => {
    obj.title = titleInput.value;
    scheduleSaveBoard();
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.code === 'Space') {
      e.stopPropagation();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstField = el.querySelector('.ff-sticky-textarea, .ff-label-editor, .ff-check-input, .ff-note-memo-area');
      firstField?.focus();
    }
  });
  header.appendChild(titleInput);

  const headerActions = document.createElement('div');
  headerActions.className = 'ff-header-actions';

  if (obj.groupId) {
    const grpBadge = document.createElement('span');
    grpBadge.className = 'ff-group-badge';
    grpBadge.innerHTML = `${SVG_ICONS.group} <span>그룹</span>`;
    grpBadge.title = '그룹화된 객체입니다 (클릭 시 그룹 전체 선택)';
    headerActions.appendChild(grpBadge);
  }

  // Vectorize Button & Graphic Art Style Cycle Button for 'label' (텍스트·타이틀) objects
  if (obj.type === 'label') {
    const vectorizeBtn = document.createElement('button');
    vectorizeBtn.className = `ff-pdf-mode-toggle ff-vectorize-btn ${obj.vectorized ? 'is-active' : ''}`;
    vectorizeBtn.innerHTML = `${SVG_ICONS.vectorize}<span>${obj.vectorized ? '텍스트 편집' : '벡터 이미지화'}</span>`;
    vectorizeBtn.title = obj.vectorized
      ? '벡터 이미지 모드 활성 중 (우측 하단 모서리를 드래그해 크기 자유 조절 · 클릭 또는 더블클릭 시 텍스트 편집 전환)'
      : '텍스트를 벡터 이미지로 변환 (폰트 사이즈 한계 없이 객체 크기를 늘려 초대형 타이틀·구역 구분 가능)';
    vectorizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLabelVectorized(obj);
    });
    headerActions.appendChild(vectorizeBtn);

    const curArt = ART_STYLE_LIST.find((a) => a.id === (obj.artStyle || 'none')) || ART_STYLE_LIST[0];
    const artCycleBtn = document.createElement('button');
    artCycleBtn.className = 'ff-pdf-mode-toggle ff-art-cycle-btn';
    artCycleBtn.innerHTML = `<span>✨ ${curArt.label}</span>`;
    artCycleBtn.title = '클릭하여 그래픽 텍스트 디자인 스타일 전환 (상단 도구바에서도 선택 가능)';
    artCycleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndoSnapshot('텍스트 그래픽 스타일 변경');
      const curIdx = ART_STYLE_LIST.findIndex((a) => a.id === (obj.artStyle || 'none'));
      const nextArt = ART_STYLE_LIST[(curIdx + 1) % ART_STYLE_LIST.length];
      obj.artStyle = nextArt.id;
      renderAllObjects();
      syncSelectionUI();
      scheduleSaveBoard();
      showToast(`✨ 텍스트 그래픽 스타일: ${nextArt.label}`);
    });
    headerActions.appendChild(artCycleBtn);
  }

  // PDF View Mode Toggle Button right next to Title ("내용보기" <-> "아이콘보기")
  if (isPdf) {
    const curMode = obj.pdfViewMode || 'viewer';
    const pdfModeBtn = document.createElement('button');
    pdfModeBtn.className = 'ff-pdf-mode-toggle';
    if (curMode === 'viewer') {
      pdfModeBtn.innerHTML = `${SVG_ICONS.fileIconMode}<span>아이콘보기</span>`;
      pdfModeBtn.title = '클릭하여 심플한 아이콘 카드로 접기';
    } else {
      pdfModeBtn.innerHTML = `${SVG_ICONS.bookOpen}<span>내용보기</span>`;
      pdfModeBtn.title = '클릭하여 PDF 문서 내용을 뷰어로 바로 펼치기';
    }
    pdfModeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePdfObjectViewMode(obj);
    });
    headerActions.appendChild(pdfModeBtn);
  }

  // Copy All Content Button at the far right end of the title bar
  const copyAllBtn = document.createElement('button');
  copyAllBtn.className = 'ff-header-copy-btn';
  copyAllBtn.title = '이 객체의 내용을 한 번에 모두 복사';
  copyAllBtn.innerHTML = `${SVG_ICONS.copy}<span>복사</span>`;
  copyAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyEntireObjectContent(obj, copyAllBtn);
  });
  headerActions.appendChild(copyAllBtn);

  header.appendChild(headerActions);
  el.appendChild(header);

  // Body by Object Type
  const body = document.createElement('div');
  body.className = 'ff-obj-body';

  if (obj.type === 'sticky') {
    // ========================================================================
    // 1. STICKY NOTE (포스트잇): Per-Line Alignment + Seamless Multiline Memo Pad
    // ========================================================================
    const stickyEditor = document.createElement('div');
    stickyEditor.className = 'ff-sticky-textarea';
    setupPerLineEditor(stickyEditor, {
      obj,
      initialText: obj.content || '',
      initialAligns: Array.isArray(obj.lineAligns) ? obj.lineAligns : [],
      placeholder: '자유롭게 메모를 입력하세요 (Enter로 줄바꿈, 줄별 정렬 가능)...',
      onSync: (nextText, nextAligns) => {
        obj.content = nextText;
        obj.lineAligns = nextAligns;
        scheduleSaveBoard();
      }
    });
    body.appendChild(stickyEditor);
  } else if (obj.type === 'label') {
    // ========================================================================
    // 1-B. BORDERLESS CANVAS TEXT / GRAPHIC TITLE (텍스트 객체):
    //      Transparent borderless display text with Per-Line Alignment, Graphic Art styles & Vector Image Mode!
    // ========================================================================
    const labelWrap = document.createElement('div');
    labelWrap.className = 'ff-label-wrap';

    if (obj.vectorized) {
      renderVectorizedLabelIntoWrap(labelWrap, obj);
      labelWrap.title = '드래그: 이동 · 우측 하단 모서리 드래그: 크기 자유 확대/축소 (Shift+드래그: 비율 자유 변형) · 더블클릭: 텍스트 편집 전환';
      labelWrap.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleLabelVectorized(obj);
      });
    } else {
      const editor = document.createElement('div');
      editor.className = `ff-label-editor art-style-${obj.artStyle || 'none'}`;
      setupPerLineEditor(editor, {
        obj,
        initialText: obj.content || '',
        initialAligns: Array.isArray(obj.lineAligns) ? obj.lineAligns : [],
        placeholder: '프로젝트 제목이나 텍스트 입력...',
        onSync: (nextText, nextAligns) => {
          obj.content = nextText;
          obj.lineAligns = nextAligns;
          scheduleSaveBoard();
        }
      });
      labelWrap.appendChild(editor);
    }

    body.appendChild(labelWrap);
  } else if (obj.type === 'stroke') {
    // ========================================================================
    // 1-C. PEN-DRAWN STROKE / SHAPE OBJECT (펜으로 그린 선·도형·화살표 객체):
    //      Selectable, movable, resizable, rotatable, and editable (color, width, dash, arrow)!
    // ========================================================================
    const sd = obj.strokeData || {};
    const vBox = sd.viewBox || { x: 0, y: 0, w: Math.max(40, obj.width || 120), h: Math.max(40, obj.height || 120) };
    const resolvedColor = getResolvedObjectColorHex(obj);
    const strokeW = Number(sd.strokeWidth) || 3.5;

    const svgWrap = document.createElement('div');
    svgWrap.className = 'ff-stroke-wrap';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ff-stroke-svg');
    svg.setAttribute('viewBox', `${vBox.x} ${vBox.y} ${vBox.w} ${vBox.h}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('class', 'ff-stroke-hit-path');
    hitPath.setAttribute('d', sd.pathD || '');
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', String(Math.max(18, strokeW + 14)));
    hitPath.setAttribute('stroke-linecap', 'round');
    hitPath.setAttribute('stroke-linejoin', 'round');
    hitPath.setAttribute('vector-effect', 'non-scaling-stroke');

    const visPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visPath.setAttribute('class', 'ff-stroke-vis-path');
    visPath.setAttribute('d', sd.pathD || '');
    visPath.setAttribute('fill', 'none');
    visPath.setAttribute('stroke', resolvedColor);
    visPath.setAttribute('stroke-width', String(strokeW));
    visPath.setAttribute('stroke-linecap', 'round');
    visPath.setAttribute('stroke-linejoin', 'round');
    visPath.setAttribute('vector-effect', 'non-scaling-stroke');
    if (sd.dashed) {
      visPath.setAttribute('stroke-dasharray', `${strokeW * 2.5} ${strokeW * 1.8}`);
    }
    if (sd.hasArrow) {
      visPath.setAttribute('marker-end', getOrCreateArrowMarkerUrl(resolvedColor, 'strokeArrow'));
    }

    svg.appendChild(hitPath);
    svg.appendChild(visPath);
    svgWrap.appendChild(svg);
    body.appendChild(svgWrap);
  } else if (obj.type === 'text') {
    // ========================================================================
    // 2. CHECKLIST & STRUCTURED NOTE CARD (체크리스트): Clean Single Empty Start!
    // ========================================================================
    const noteBar = document.createElement('div');
    noteBar.className = 'ff-note-toolbar';
    noteBar.innerHTML = `
      <button class="ff-chk-Insert-btn" data-chk="square" title="네모 체크박스 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkSquare}<span>네모체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="circle" title="원형 체크박스 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkCircle}<span>원형체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="toggle" title="슬라이드 토글 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkToggle}<span>슬라이드</span></button>
      <button class="ff-chk-Insert-btn" data-chk="memo" title="하단 자유 메모 입력란으로 포커스 이동">${SVG_ICONS.plus}<span>자유메모</span></button>
    `;
    el.appendChild(noteBar);

    // Automatically strip old hardcoded 3-line sample text if untouched
    if (
      obj.content === '[square:0] 네모 V 체크박스 항목\n[circle:0] 원형 채움 체크박스 항목\n[toggle:1] 슬라이드 토글 스위치 항목' ||
      obj.content === '[square:0] 할 일 항목 1\n[circle:0] 할 일 항목 2\n[toggle:1] 진행 상태 스위치'
    ) {
      obj.content = '[square:0] ';
    }

    const parsed = parseNoteLines(obj.content || '');
    const initialChecks = parsed.filter((it) => it.isCheck);
    const initialMemoLines = parsed.filter((it) => !it.isCheck).map((it) => it.text);

    // If completely new/empty checklist, start with 1 clean empty checkbox row
    if (initialChecks.length === 0 && initialMemoLines.every((l) => !l.trim())) {
      initialChecks.push({ isCheck: true, style: 'square', checked: false, text: '' });
      initialMemoLines.length = 0;
    }

    const checklistContainer = document.createElement('div');
    checklistContainer.className = 'ff-checklist-list';
    body.appendChild(checklistContainer);

    const memoArea = document.createElement('div');
    memoArea.className = 'ff-note-memo-area';

    let lastFocusedCheckRow = null;
    let currentMemoText = initialMemoLines.join('\n');

    const syncChecklistAndMemoToObj = () => {
      const serializedLines = [];
      checklistContainer.querySelectorAll('.ff-check-row').forEach((r) => {
        const st = r.dataset.style || 'square';
        const ck = r.dataset.checked === '1' ? '1' : '0';
        const al = r.dataset.align && r.dataset.align !== 'left' ? `:${r.dataset.align}` : '';
        const val = r.querySelector('.ff-check-input')?.value || '';
        serializedLines.push(`[${st}:${ck}${al}] ${val}`);
      });
      if (currentMemoText) {
        serializedLines.push(...currentMemoText.split('\n'));
      }
      obj.content = serializedLines.join('\n');
      scheduleSaveBoard();
    };

    const applyRowStyle = (row, nextStyle) => {
      const widget = row.querySelector('.ff-chk-widget');
      if (!widget) return;
      const curStyle = row.dataset.style || 'square';
      widget.classList.remove(`style-${curStyle}`);
      widget.classList.add(`style-${nextStyle}`);
      row.dataset.style = nextStyle;
      syncChecklistAndMemoToObj();
    };

    const createCheckRowDOM = ({ style = 'square', checked = false, align = 'left', text = '' }) => {
      const normAlign = ['left', 'center', 'right'].includes(align) ? align : 'left';
      const row = document.createElement('div');
      row.className = `ff-check-row ${checked ? 'checked' : ''}`;
      row.dataset.style = style;
      row.dataset.checked = checked ? '1' : '0';
      row.dataset.align = normAlign;

      const widget = document.createElement('span');
      widget.className = `ff-chk-widget style-${style} ${checked ? 'checked' : ''}`;
      widget.title = '클릭: 체크 토글 · 우클릭: 체크박스 모양 변경(네모/원형/슬라이드)';

      widget.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextChecked = row.dataset.checked !== '1';
        row.dataset.checked = nextChecked ? '1' : '0';
        row.classList.toggle('checked', nextChecked);
        widget.classList.toggle('checked', nextChecked);
        syncChecklistAndMemoToObj();
      });

      widget.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const order = ['square', 'circle', 'toggle'];
        const curStyle = row.dataset.style || 'square';
        const nextStyle = order[(order.indexOf(curStyle) + 1) % order.length];
        applyRowStyle(row, nextStyle);
      });

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ff-check-input';
      input.value = text || '';
      input.style.textAlign = normAlign;
      input.placeholder = '할 일 입력 (Enter: 줄 추가, 우클릭/상단버튼: 모양 변경)...';
      input.spellcheck = false;

      const registerCheckRowAlignTarget = () => {
        lastFocusedCheckRow = row;
        lastActiveAlignTarget = {
          kind: 'check-row',
          obj,
          rowEl: row,
          inputEl: input,
          syncFn: syncChecklistAndMemoToObj
        };
        syncAlignButtonsUI(row.dataset.align || 'left');
      };

      input.addEventListener('focus', registerCheckRowAlignTarget);
      input.addEventListener('mouseup', registerCheckRowAlignTarget);
      input.addEventListener('keyup', registerCheckRowAlignTarget);

      input.addEventListener('input', () => {
        syncChecklistAndMemoToObj();
      });

      input.addEventListener('keydown', (e) => {
        if (
          e.key === 'Backspace' ||
          e.key === 'Delete' ||
          e.key === 'Enter' ||
          e.code === 'Space' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown'
        ) {
          e.stopPropagation();
        }

        if (e.key === 'Enter') {
          e.preventDefault();
          const pos = input.selectionStart ?? input.value.length;
          const beforeText = input.value.slice(0, pos);
          const afterText = input.value.slice(pos);
          input.value = beforeText;

          const newRow = createCheckRowDOM({
            style: row.dataset.style || 'square',
            checked: false,
            align: row.dataset.align || 'left',
            text: afterText
          });
          row.after(newRow);
          syncChecklistAndMemoToObj();
          const newInput = newRow.querySelector('.ff-check-input');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(0, 0);
          }
        } else if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
          const allRows = Array.from(checklistContainer.querySelectorAll('.ff-check-row'));
          const idx = allRows.indexOf(row);
          if (idx > 0) {
            e.preventDefault();
            const prevRow = allRows[idx - 1];
            const prevInput = prevRow.querySelector('.ff-check-input');
            const prevLen = prevInput.value.length;
            prevInput.value += input.value;
            row.remove();
            syncChecklistAndMemoToObj();
            prevInput.focus();
            prevInput.setSelectionRange(prevLen, prevLen);
          } else if (input.value === '') {
            e.preventDefault();
            if (allRows.length > 1) {
              const nextInput = allRows[1].querySelector('.ff-check-input');
              row.remove();
              syncChecklistAndMemoToObj();
              nextInput?.focus();
            } else {
              row.remove();
              syncChecklistAndMemoToObj();
              memoArea.focus();
            }
          }
        } else if (e.key === 'ArrowUp') {
          const allInputs = Array.from(checklistContainer.querySelectorAll('.ff-check-input'));
          const idx = allInputs.indexOf(input);
          if (idx > 0) {
            e.preventDefault();
            allInputs[idx - 1].focus();
          }
        } else if (e.key === 'ArrowDown') {
          const allInputs = Array.from(checklistContainer.querySelectorAll('.ff-check-input'));
          const idx = allInputs.indexOf(input);
          if (idx >= 0 && idx < allInputs.length - 1) {
            e.preventDefault();
            allInputs[idx + 1].focus();
          } else {
            e.preventDefault();
            memoArea.focus();
          }
        }
      });

      const delRowBtn = document.createElement('button');
      delRowBtn.className = 'ff-check-del-row-btn';
      delRowBtn.title = '체크 항목 지우기';
      delRowBtn.innerHTML = '&times;';
      delRowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        row.remove();
        syncChecklistAndMemoToObj();
      });

      row.appendChild(widget);
      row.appendChild(input);
      row.appendChild(delRowBtn);
      return row;
    };

    initialChecks.forEach((chk) => {
      checklistContainer.appendChild(createCheckRowDOM(chk));
    });

    setupPerLineEditor(memoArea, {
      obj,
      initialText: currentMemoText,
      initialAligns: Array.isArray(obj.memoLineAligns) ? obj.memoLineAligns : [],
      placeholder: '하단 자유 메모 입력 (Enter로 줄바꿈, 줄별 정렬 가능)...',
      onSync: (nextMemoText, nextMemoAligns) => {
        currentMemoText = nextMemoText;
        obj.memoLineAligns = nextMemoAligns;
        syncChecklistAndMemoToObj();
      }
    });
    body.appendChild(memoArea);

    noteBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.ff-chk-Insert-btn');
      if (!btn) return;
      e.stopPropagation();
      const kind = btn.dataset.chk;
      if (kind === 'memo') {
        memoArea.focus();
      } else {
        // If the currently focused row (or the last row) is empty, convert its style in-place instead of piling up empty rows!
        const allRows = Array.from(checklistContainer.querySelectorAll('.ff-check-row'));
        const candidateRow =
          (lastFocusedCheckRow && lastFocusedCheckRow.isConnected ? lastFocusedCheckRow : null) ||
          allRows[allRows.length - 1] ||
          null;
        const candidateInput = candidateRow?.querySelector('.ff-check-input');
        if (candidateRow && candidateInput && candidateInput.value.trim() === '') {
          applyRowStyle(candidateRow, kind);
          candidateInput.focus();
          return;
        }
        pushUndoSnapshot('체크박스 항목 추가');
        const newRow = createCheckRowDOM({ style: kind, checked: false, text: '' });
        checklistContainer.appendChild(newRow);
        syncChecklistAndMemoToObj();
        newRow.querySelector('.ff-check-input')?.focus();
      }
    });
  } else if (obj.type === 'table') {
    if (!Array.isArray(obj.tableData) || obj.tableData.length === 0) {
      obj.tableData = [
        ['', '', '', ''],
        ['', '', '', ''],
        ['', '', '', '']
      ];
    }

    const tBar = document.createElement('div');
    tBar.className = 'ff-table-toolbar';
    tBar.style.flexWrap = 'wrap';
    tBar.innerHTML = `
      <button class="ff-table-btn" data-act="add-row">${SVG_ICONS.plus}<span>행</span></button>
      <button class="ff-table-btn" data-act="del-row">${SVG_ICONS.minus}<span>행</span></button>
      <button class="ff-table-btn" data-act="add-col">${SVG_ICONS.plus}<span>열</span></button>
      <button class="ff-table-btn" data-act="del-col">${SVG_ICONS.minus}<span>열</span></button>
      <button class="ff-table-btn" data-act="chk-square" title="선택된 셀에 네모 체크박스 넣기">${SVG_ICONS.chkSquare}<span>네모</span></button>
      <button class="ff-table-btn" data-act="chk-circle" title="선택된 셀에 원형 체크박스 넣기">${SVG_ICONS.chkCircle}<span>원형</span></button>
      <button class="ff-table-btn" data-act="chk-toggle" title="선택된 셀에 슬라이드 버튼 넣기">${SVG_ICONS.chkToggle}<span>슬라이드</span></button>
      <button class="ff-table-btn" data-act="copy-tsv" title="구글 시트나 엑셀에 바로 붙여넣을 수 있도록 복사">${SVG_ICONS.copy}<span>시트복사</span></button>
      <button class="ff-table-btn" data-act="export-csv" title="엑셀 CSV 파일로 저장">${SVG_ICONS.download}<span>엑셀저장</span></button>
    `;
    el.appendChild(tBar);

    const wrap = document.createElement('div');
    wrap.className = 'ff-table-wrap';

    const renderTableGrid = () => {
      const table = document.createElement('table');
      table.className = 'ff-table';
      obj.tableData.forEach((row, rIdx) => {
        const tr = document.createElement('tr');
        row.forEach((cellVal, cIdx) => {
          const td = document.createElement('td');
          const cellKey = `${rIdx}_${cIdx}`;
          const cellAlign = obj.cellAligns?.[cellKey] || 'left';
          td.style.textAlign = cellAlign;
          const rawStr = String(cellVal ?? '');
          const chkMatch = rawStr.match(/^\[(square|circle|toggle):(0|1)\]\s?(.*)$/);

          const registerCellAlignTarget = () => {
            lastFocusedTableCell = { obj, rIdx, cIdx, renderTableGrid };
            lastActiveAlignTarget = {
              kind: 'table-cell',
              obj,
              rIdx,
              cIdx,
              tdEl: td
            };
            syncAlignButtonsUI(obj.cellAligns?.[cellKey] || 'left');
          };

          if (chkMatch) {
            const cStyle = chkMatch[1];
            const isChecked = chkMatch[2] === '1';
            const labelStr = chkMatch[3] || '';

            const cellFlex = document.createElement('div');
            cellFlex.style.display = 'flex';
            cellFlex.style.alignItems = 'center';
            cellFlex.style.gap = '6px';

            const w = document.createElement('span');
            w.className = `ff-chk-widget style-${cStyle} ${isChecked ? 'checked' : ''}`;
            w.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const nextCk = isChecked ? '0' : '1';
              obj.tableData[rIdx][cIdx] = `[${cStyle}:${nextCk}] ${txtSpan.textContent}`;
              renderTableGrid();
              scheduleSaveBoard();
            });

            const txtSpan = document.createElement('span');
            txtSpan.contentEditable = 'true';
            txtSpan.style.flex = '1';
            txtSpan.style.outline = 'none';
            txtSpan.style.textAlign = cellAlign;
            if (isChecked) {
              txtSpan.style.opacity = '0.6';
              txtSpan.style.textDecoration = 'line-through';
            }
            txtSpan.textContent = labelStr;
            txtSpan.addEventListener('focus', registerCellAlignTarget);
            txtSpan.addEventListener('mouseup', registerCellAlignTarget);
            txtSpan.addEventListener('keyup', registerCellAlignTarget);
            txtSpan.addEventListener('input', () => {
              obj.tableData[rIdx][cIdx] = `[${cStyle}:${isChecked ? '1' : '0'}] ${txtSpan.textContent}`;
              scheduleSaveBoard();
            });
            txtSpan.addEventListener('keydown', (ev) => {
              if (ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter' || ev.code === 'Space') {
                ev.stopPropagation();
              }
            });

            cellFlex.appendChild(w);
            cellFlex.appendChild(txtSpan);
            td.appendChild(cellFlex);
          } else {
            td.contentEditable = 'true';
            td.textContent = rawStr;
            td.addEventListener('focus', registerCellAlignTarget);
            td.addEventListener('mouseup', registerCellAlignTarget);
            td.addEventListener('keyup', registerCellAlignTarget);
            td.addEventListener('input', () => {
              obj.tableData[rIdx][cIdx] = td.textContent;
              scheduleSaveBoard();
            });
            td.addEventListener('keydown', (ev) => {
              if (ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter' || ev.code === 'Space') {
                ev.stopPropagation();
              }
            });
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      wrap.innerHTML = '';
      wrap.appendChild(table);
      applyObjectTypography(el, obj);
    };
    renderTableGrid();

    tBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ff-table-btn');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      const cols = obj.tableData[0]?.length || 3;
      if (act === 'add-row') {
        pushUndoSnapshot('표 행 추가');
        obj.tableData.push(new Array(cols).fill(''));
        renderTableGrid();
        scheduleSaveBoard();
      } else if (act === 'del-row' && obj.tableData.length > 1) {
        pushUndoSnapshot('표 행 삭제');
        obj.tableData.pop();
        renderTableGrid();
        scheduleSaveBoard();
      } else if (act === 'add-col') {
        pushUndoSnapshot('표 열 추가');
        obj.tableData.forEach((r) => r.push(''));
        renderTableGrid();
        scheduleSaveBoard();
      } else if (act === 'del-col' && cols > 1) {
        pushUndoSnapshot('표 열 삭제');
        obj.tableData.forEach((r) => r.pop());
        renderTableGrid();
        scheduleSaveBoard();
      } else if (act === 'chk-square' || act === 'chk-circle' || act === 'chk-toggle') {
        pushUndoSnapshot('표 체크박스 설정');
        const styleName = act.replace('chk-', '');
        const targetR = lastFocusedTableCell && lastFocusedTableCell.obj.id === obj.id ? lastFocusedTableCell.rIdx : Math.min(1, obj.tableData.length - 1);
        const targetC = lastFocusedTableCell && lastFocusedTableCell.obj.id === obj.id ? lastFocusedTableCell.cIdx : 0;
        const curVal = String(obj.tableData[targetR]?.[targetC] ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '');
        obj.tableData[targetR][targetC] = `[${styleName}:0] ${curVal}`;
        renderTableGrid();
        scheduleSaveBoard();
      } else if (act === 'copy-tsv') {
        const tsv = obj.tableData
          .map((r) => r.map((c) => String(c ?? '').replace(/^\[(square|circle|toggle):1\]\s?/, '☑ ').replace(/^\[(square|circle|toggle):0\]\s?/, '☐ ')).join('\t'))
          .join('\n');
        await window.freeformAPI.writeClipboardText(tsv);
        showToast('표가 복사되었습니다! 구글 시트나 엑셀에 Ctrl+V로 바로 붙여넣으세요.');
      } else if (act === 'export-csv') {
        const res = await window.freeformAPI.exportTableCsv({ title: obj.title, tableData: obj.tableData });
        if (res && res.success) showToast(`엑셀 CSV 저장 완료: ${res.filePath}`);
      }
    });

    body.style.padding = '0';
    body.appendChild(wrap);
  } else if (obj.type === 'image') {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'ff-image-wrap';
    const img = document.createElement('img');
    const imgSrc = obj.resolvedFileUrl || obj.imageUrl || '';
    img.src = imgSrc;
    imgWrap.appendChild(img);
    imgWrap.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const lb = document.getElementById('lightboxModal');
      const lbImg = document.getElementById('lightboxImage');
      if (lb && lbImg && imgSrc) {
        lbImg.src = imgSrc;
        lb.classList.remove('hidden');
      }
    });
    body.appendChild(imgWrap);
  } else if (obj.type === 'link') {
    const card = document.createElement('div');
    card.className = 'ff-link-card';

    // Check if YouTube / Vimeo / Direct Video URL
    const ytMatch = (obj.url || '').match(/(?:youtube\.com\/watch\?[^#\s]*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i);
    const youtubeId = obj.youtubeId || (ytMatch ? ytMatch[1] : null);
    const isDirectVideo = /\.(mp4|webm|mov|ogg)(\?.*)?$/i.test(obj.url || '');

    let mediaHtml = '';
    if (youtubeId) {
      mediaHtml = `<iframe class="ff-video-iframe" src="https://www.youtube.com/embed/${escapeHtml(youtubeId)}?rel=0&playsinline=1" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
    } else if (isDirectVideo) {
      mediaHtml = `<video class="ff-video-native" src="${escapeHtml(obj.url)}" controls preload="metadata"></video>`;
    } else if (obj.thumbnail) {
      mediaHtml = `<img class="ff-link-thumb" src="${escapeHtml(obj.thumbnail)}" alt="" />`;
    }

    card.innerHTML = `
      ${mediaHtml}
      <div class="ff-link-meta">
        ${obj.favicon ? `<img src="${escapeHtml(obj.favicon)}" width="14" height="14" style="border-radius:3px;" />` : SVG_ICONS.externalLink}
        <span>${escapeHtml(obj.domain || obj.url || '')}</span>
      </div>
      ${!youtubeId && !isDirectVideo ? `<div class="ff-link-desc">${escapeHtml(obj.description || obj.url || '')}</div>` : ''}
      <button class="ff-link-open-btn">${youtubeId ? `${SVG_ICONS.play}<span>브라우저에서 유튜브 열기</span>` : `${SVG_ICONS.externalLink}<span>링크 열기</span>`}</button>
    `;
    const openBtn = card.querySelector('.ff-link-open-btn');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (obj.url) window.freeformAPI.openExternal(obj.url);
      });
    }
    body.appendChild(card);
  } else if (obj.type === 'file' || obj.type === 'pdf') {
    const sizeKb = obj.fileSize ? `${Math.max(1, Math.round(obj.fileSize / 1024))} KB` : '첨부 문서';
    if (isPdf && (obj.pdfViewMode || 'viewer') === 'viewer') {
      // ======================================================================
      // INLINE PDF VIEWER MODE (내용 보기: 창크기 맞춤 기본, 휠 스크롤, Ctrl+휠 확대/축소, 기본앱 '열기')
      // ======================================================================
      body.style.padding = '0';
      body.style.overflow = 'hidden';

      const pdfWrap = document.createElement('div');
      pdfWrap.className = 'ff-pdf-viewer-wrap';

      // Default zoom = 1.0 (100% Fit to Card/Window Width)
      let currentPdfZoom = obj.pdfZoom && obj.pdfZoom !== 1.15 ? obj.pdfZoom : 1.0;

      const pdfBar = document.createElement('div');
      pdfBar.className = 'ff-pdf-toolbar';
      pdfBar.innerHTML = `
        <div class="ff-pdf-nav-group">
          <button class="ff-pdf-btn" data-pdf-act="prev" title="이전 페이지로 이동">◀</button>
          <span class="ff-pdf-page-indicator" data-pdf-pages>로딩 중...</span>
          <button class="ff-pdf-btn" data-pdf-act="next" title="다음 페이지로 이동">▶</button>
        </div>
        <div class="ff-pdf-nav-group">
          <button class="ff-pdf-btn" data-pdf-act="zoom-out" title="축소 (Ctrl + 마우스 휠 아래로)">${SVG_ICONS.minus}</button>
          <button class="ff-pdf-btn" data-pdf-act="zoom-reset" data-pdf-zoom title="클릭 시 창크기에 맞춤 (100%)">${Math.round(currentPdfZoom * 100)}%</button>
          <button class="ff-pdf-btn" data-pdf-act="zoom-in" title="확대 (Ctrl + 마우스 휠 위로)">${SVG_ICONS.plus}</button>
          <button class="ff-pdf-btn" data-pdf-act="open-default" title="윈도우에 설정된 기본 PDF 프로그램으로 열기">${SVG_ICONS.externalLink}<span>열기</span></button>
        </div>
      `;

      const pagesContainer = document.createElement('div');
      pagesContainer.className = 'ff-pdf-pages-container';
      pagesContainer.innerHTML = `<div class="ff-pdf-loading">PDF 문서를 불러오는 중...</div>`;

      pdfWrap.appendChild(pdfBar);
      pdfWrap.appendChild(pagesContainer);
      body.appendChild(pdfWrap);

      const pageIndicatorEl = pdfBar.querySelector('[data-pdf-pages]');
      const zoomIndicatorEl = pdfBar.querySelector('[data-pdf-zoom]');

      let loadedPdfDoc = null;
      let currentVisiblePage = 1;
      let renderTicket = 0;

      const renderPdfPages = async () => {
        const myTicket = ++renderTicket;
        if (!obj.resolvedFilePath) {
          pagesContainer.innerHTML = `<div class="ff-pdf-loading">PDF 파일 경로를 찾을 수 없습니다.</div>`;
          return;
        }
        try {
          const entry = await getOrLoadPdfDocument(obj.resolvedFilePath);
          if (myTicket !== renderTicket) return;
          if (!entry || !entry.pdfDoc) {
            pagesContainer.innerHTML = `<div class="ff-pdf-loading">PDF를 불러올 수 없습니다.</div>`;
            return;
          }
          loadedPdfDoc = entry.pdfDoc;
          const total = loadedPdfDoc.numPages;
          if (pageIndicatorEl) pageIndicatorEl.textContent = `${currentVisiblePage} / ${total} p`;
          if (zoomIndicatorEl) zoomIndicatorEl.textContent = `${Math.round(currentPdfZoom * 100)}%`;

          const prevScrollRatio =
            pagesContainer.scrollHeight > 0 ? pagesContainer.scrollTop / pagesContainer.scrollHeight : 0;

          pagesContainer.innerHTML = '';
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          // Fit cleanly to the inner width of the PDF viewer window
          const innerWidth = pagesContainer.clientWidth || (obj.width || 480) - 24;
          const targetContainerWidth = Math.max(200, innerWidth - 20);

          for (let pageNum = 1; pageNum <= total; pageNum++) {
            if (myTicket !== renderTicket) return;
            const page = await loadedPdfDoc.getPage(pageNum);
            const unscaledVp = page.getViewport({ scale: 1 });
            const fitScale = (targetContainerWidth / unscaledVp.width) * currentPdfZoom;
            const vp = page.getViewport({ scale: fitScale * dpr });

            const pageCard = document.createElement('div');
            pageCard.className = 'ff-pdf-page-card';
            pageCard.dataset.pageNumber = String(pageNum);

            const canvas = document.createElement('canvas');
            canvas.className = 'ff-pdf-page-canvas';
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
            canvas.style.height = `${Math.floor(vp.height / dpr)}px`;

            const badge = document.createElement('span');
            badge.className = 'ff-pdf-page-badge';
            badge.textContent = `${pageNum} / ${total}`;

            pageCard.appendChild(canvas);
            pageCard.appendChild(badge);
            pagesContainer.appendChild(pageCard);

            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          }

          if (prevScrollRatio > 0 && pagesContainer.scrollHeight > 0) {
            pagesContainer.scrollTop = Math.round(prevScrollRatio * pagesContainer.scrollHeight);
          }
        } catch (err) {
          console.error('PDF inline render error:', err);
          pagesContainer.innerHTML = `<div class="ff-pdf-loading">PDF 렌더링 오류: ${escapeHtml(err.message)}</div>`;
        }
      };

      requestAnimationFrame(() => renderPdfPages());

      // Natural Wheel Scroll for Pages & Ctrl+Wheel for PDF Zoom
      pagesContainer.addEventListener(
        'wheel',
        (e) => {
          e.stopPropagation();
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const step = e.deltaY < 0 ? 0.15 : -0.15;
            currentPdfZoom = Math.min(3.0, Math.max(0.5, Number((currentPdfZoom + step).toFixed(2))));
            obj.pdfZoom = currentPdfZoom;
            if (zoomIndicatorEl) zoomIndicatorEl.textContent = `${Math.round(currentPdfZoom * 100)}%`;
            renderPdfPages();
            scheduleSaveBoard();
          }
          // When Ctrl is NOT pressed, native scrolling inside pagesContainer smoothly scrolls through all pages!
        },
        { passive: false }
      );

      pagesContainer.addEventListener('scroll', () => {
        if (!loadedPdfDoc) return;
        const cards = Array.from(pagesContainer.querySelectorAll('.ff-pdf-page-card'));
        const scrollMid = pagesContainer.scrollTop + pagesContainer.clientHeight / 3;
        for (const c of cards) {
          if (c.offsetTop + c.offsetHeight >= scrollMid) {
            currentVisiblePage = Number(c.dataset.pageNumber) || 1;
            break;
          }
        }
        if (pageIndicatorEl) {
          pageIndicatorEl.textContent = `${currentVisiblePage} / ${loadedPdfDoc.numPages} p`;
        }
      });

      pdfBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pdf-act]');
        if (!btn) return;
        e.stopPropagation();
        const act = btn.dataset.pdfAct;
        if (act === 'prev' && loadedPdfDoc) {
          const targetP = Math.max(1, currentVisiblePage - 1);
          const card = pagesContainer.querySelector(`.ff-pdf-page-card[data-page-number="${targetP}"]`);
          card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (act === 'next' && loadedPdfDoc) {
          const targetP = Math.min(loadedPdfDoc.numPages, currentVisiblePage + 1);
          const card = pagesContainer.querySelector(`.ff-pdf-page-card[data-page-number="${targetP}"]`);
          card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (act === 'zoom-in') {
          currentPdfZoom = Math.min(3.0, Number((currentPdfZoom + 0.15).toFixed(2)));
          obj.pdfZoom = currentPdfZoom;
          renderPdfPages();
          scheduleSaveBoard();
        } else if (act === 'zoom-out') {
          currentPdfZoom = Math.max(0.5, Number((currentPdfZoom - 0.15).toFixed(2)));
          obj.pdfZoom = currentPdfZoom;
          renderPdfPages();
          scheduleSaveBoard();
        } else if (act === 'zoom-reset') {
          currentPdfZoom = 1.0;
          obj.pdfZoom = 1.0;
          renderPdfPages();
          scheduleSaveBoard();
          showToast('PDF 배율이 창크기에 맞춤(100%)으로 설정되었습니다');
        } else if (act === 'open-default') {
          if (obj.resolvedFilePath) {
            window.freeformAPI.openPath(obj.resolvedFilePath);
          }
        }
      });
    } else if (isPdf) {
      // ======================================================================
      // COMPACT PDF ICON MODE (아이콘 보기: 버튼 없이 클릭 시 바로 내용보기로 전환, 좌상단 고정!)
      // ======================================================================
      const box = document.createElement('div');
      box.className = 'ff-file-box';
      box.style.cursor = 'pointer';
      box.title = '클릭하여 PDF 문서 내용 보기';
      box.innerHTML = `
        <div class="ff-file-icon" style="display:flex;align-items:center;justify-content:center;color:#ff453a;">${SVG_ICONS.fileDoc}</div>
        <div class="ff-file-info">
          <div class="ff-file-name">${escapeHtml(obj.fileName || obj.title || 'PDF 문서')}</div>
          <div class="ff-file-size">${escapeHtml(sizeKb)} · 클릭하여 내용 보기</div>
        </div>
      `;
      let downPos = null;
      box.addEventListener('pointerdown', (e) => {
        if (e.button === 0) downPos = { x: e.clientX, y: e.clientY };
      });
      box.addEventListener('pointerup', (e) => {
        if (e.button === 0 && downPos) {
          const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
          downPos = null;
          if (dist < 5) {
            draggingObjState = null;
            togglePdfObjectViewMode(obj);
          }
        }
      });
      body.appendChild(box);
    } else {
      // ======================================================================
      // GENERAL NON-PDF FILE ATTACHMENT
      // ======================================================================
      const box = document.createElement('div');
      box.className = 'ff-file-box';
      box.innerHTML = `
        <div class="ff-file-icon" style="display:flex;align-items:center;justify-content:center;color:var(--apple-bright-blue);">${SVG_ICONS.fileDoc}</div>
        <div class="ff-file-info">
          <div class="ff-file-name">${escapeHtml(obj.fileName || obj.title || '파일')}</div>
          <div class="ff-file-size">${escapeHtml(sizeKb)}</div>
        </div>
        <button class="ff-link-open-btn" data-file-act="open">${SVG_ICONS.externalLink}<span>열기</span></button>
      `;
      box.querySelector('[data-file-act="open"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (obj.resolvedFilePath) window.freeformAPI.openPath(obj.resolvedFilePath);
      });
      box.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (obj.resolvedFilePath) window.freeformAPI.openPath(obj.resolvedFilePath);
      });
      body.appendChild(box);
    }
  }

  el.appendChild(body);

  // Resize Handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'ff-resize-handle';
  resizeHandle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  el.appendChild(resizeHandle);

  // 4-Side Connector Anchor Handles (Top, Right, Bottom, Left)
  ['top', 'right', 'bottom', 'left'].forEach((side) => {
    const connectHandle = document.createElement('div');
    connectHandle.className = `ff-connect-handle side-${side}`;
    connectHandle.dataset.side = side;
    connectHandle.title = '드래그하여 다른 객체의 원하는 면/위치에 화살표 연결';
    connectHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const pt = getAnchorWorldPoint(obj, side, 0.5);
      connectingState = {
        fromId: obj.id,
        fromSide: side,
        fromOffset: 0.5,
        startX: pt.x,
        startY: pt.y,
        startNx: pt.nx,
        startNy: pt.ny,
        snapTarget: null
      };
      if (tempConnectorPath) {
        tempConnectorPath.classList.remove('hidden');
        tempConnectorPath.setAttribute(
          'd',
          computeSideBezierPath(pt, { x: pt.x, y: pt.y, nx: -pt.nx, ny: -pt.ny })
        );
      }
    });
    el.appendChild(connectHandle);
  });

  // Object Selection & Multi-Object Dragging
  el.addEventListener('pointerdown', (e) => {
    if (activeTool === 'pen' || e.button !== 0) return;
    e.stopPropagation();
    selectedConnectorId = null;
    if (e.shiftKey) {
      selectObject(obj.id, { additive: true });
    } else if (!selectedObjectIds.has(obj.id)) {
      selectObject(obj.id, { additive: false });
    }
    renderAllConnectors();
  });

  el.addEventListener('focusin', () => {
    if (!selectedObjectIds.has(obj.id)) {
      selectedConnectorId = null;
      selectObject(obj.id, { additive: false });
      renderAllConnectors();
    }
  });

  const startDrag = (e) => {
    if (e.button !== 0 || activeTool === 'pen' || obj.locked) return;
    if (e.target.closest('button, input, textarea, [contenteditable="true"], .ff-chk-widget')) return;
    e.stopPropagation();

    selectedConnectorId = null;
    if (e.shiftKey) {
      selectObject(obj.id, { additive: true });
    } else if (!selectedObjectIds.has(obj.id)) {
      selectObject(obj.id, { additive: false });
    }

    const startWorld = screenToWorld(e.clientX, e.clientY);
    const movingItems = getSelectedObjects()
      .filter((o) => !o.locked)
      .map((o) => ({
        obj: o,
        el: objectLayer.querySelector(`.ff-object[data-id="${o.id}"]`),
        origX: o.x,
        origY: o.y
      }));

    draggingObjState = {
      startWorldX: startWorld.x,
      startWorldY: startWorld.y,
      items: movingItems,
      snapshotBefore: createBoardSnapshot('객체 이동')
    };
    document.body.classList.add('is-dragging-object');
  };

  header.addEventListener('pointerdown', startDrag);
  if (
    obj.type === 'image' ||
    obj.type === 'label' ||
    obj.type === 'stroke' ||
    (obj.type === 'file' && !(isPdf && (obj.pdfViewMode || 'viewer') === 'viewer'))
  ) {
    body.addEventListener('pointerdown', startDrag);
  }

  // Resize Object
  resizeHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || obj.locked) return;
    e.stopPropagation();
    if (!selectedObjectIds.has(obj.id)) selectObject(obj.id);
    const startWorld = screenToWorld(e.clientX, e.clientY);
    resizingObjState = {
      obj,
      el,
      startWorldX: startWorld.x,
      startWorldY: startWorld.y,
      origW: obj.width,
      origH: obj.height,
      snapshotBefore: createBoardSnapshot('객체 크기 조절')
    };
  });

  applyObjectCustomColorStyles(el, obj);
  applyObjectTypography(el, obj);

  return el;
}

// ============================================================================
// 4-Side Free-Position Connector Anchors & Draggable Start/End Handles
// ============================================================================
function clampAnchorOffset(val) {
  const num = typeof val === 'number' && !Number.isNaN(val) ? val : 0.5;
  return Math.max(0.04, Math.min(0.96, Number(num.toFixed(4))));
}

function getAnchorWorldPoint(obj, side = 'right', offset = 0.5) {
  const t = clampAnchorOffset(offset);
  const x = obj.x || 0;
  const y = obj.y || 0;
  const w = obj.width || 300;
  const h = obj.height || 200;

  if (side === 'top') {
    return { x: Math.round(x + w * t), y: Math.round(y), nx: 0, ny: -1, side: 'top', offset: t };
  }
  if (side === 'bottom') {
    return { x: Math.round(x + w * t), y: Math.round(y + h), nx: 0, ny: 1, side: 'bottom', offset: t };
  }
  if (side === 'left') {
    return { x: Math.round(x), y: Math.round(y + h * t), nx: -1, ny: 0, side: 'left', offset: t };
  }
  return { x: Math.round(x + w), y: Math.round(y + h * t), nx: 1, ny: 0, side: 'right', offset: t };
}

function getClosestEdgeAnchorOnObject(obj, worldX, worldY) {
  const x = obj.x || 0;
  const y = obj.y || 0;
  const w = Math.max(40, obj.width || 300);
  const h = Math.max(40, obj.height || 200);

  const tx = clampAnchorOffset((worldX - x) / w);
  const ty = clampAnchorOffset((worldY - y) / h);

  const candidates = [
    { side: 'top', offset: tx, px: x + w * tx, py: y, nx: 0, ny: -1 },
    { side: 'bottom', offset: tx, px: x + w * tx, py: y + h, nx: 0, ny: 1 },
    { side: 'left', offset: ty, px: x, py: y + h * ty, nx: -1, ny: 0 },
    { side: 'right', offset: ty, px: x + w, py: y + h * ty, nx: 1, ny: 0 }
  ];

  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(worldX - c.px, worldY - c.py);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  return {
    objId: obj.id,
    side: best.side,
    offset: best.offset,
    x: Math.round(best.px),
    y: Math.round(best.py),
    nx: best.nx,
    ny: best.ny,
    distance: bestDist
  };
}

function findBestObjectAnchorAtPoint(worldX, worldY, excludeObjId = null, fallbackObjId = null) {
  if (!currentBoard || !Array.isArray(currentBoard.objects)) return null;
  const margin = 44;
  const sorted = [...currentBoard.objects].sort((a, b) => (b.zIndex || 1) - (a.zIndex || 1));

  // 1. Check if cursor is inside or within 44px of any object's bounding box
  let bestCandidate = null;
  for (const obj of sorted) {
    if (excludeObjId && obj.id === excludeObjId) continue;
    const x = obj.x || 0;
    const y = obj.y || 0;
    const w = obj.width || 300;
    const h = obj.height || 200;
    if (
      worldX >= x - margin &&
      worldX <= x + w + margin &&
      worldY >= y - margin &&
      worldY <= y + h + margin
    ) {
      const anchor = getClosestEdgeAnchorOnObject(obj, worldX, worldY);
      const isInside = worldX >= x && worldX <= x + w && worldY >= y && worldY <= y + h;
      if (isInside) {
        return anchor;
      }
      if (!bestCandidate || anchor.distance < bestCandidate.distance) {
        bestCandidate = anchor;
      }
    }
  }
  if (bestCandidate) return bestCandidate;

  // 2. Fallback: project onto fallbackObjId's closest edge & offset so dragging wide around the connected object slides smoothly around its 4 sides
  if (fallbackObjId) {
    const fallbackObj = currentBoard.objects.find((o) => o.id === fallbackObjId);
    if (fallbackObj && fallbackObj.id !== excludeObjId) {
      return getClosestEdgeAnchorOnObject(fallbackObj, worldX, worldY);
    }
  }
  return null;
}

function autoPickBestSides(fromObj, toObj) {
  const fromCx = fromObj.x + fromObj.width / 2;
  const fromCy = fromObj.y + fromObj.height / 2;
  const toCx = toObj.x + toObj.width / 2;
  const toCy = toObj.y + toObj.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;

  if (Math.abs(dy) > Math.abs(dx) * 0.95) {
    return dy >= 0
      ? { fromSide: 'bottom', toSide: 'top' }
      : { fromSide: 'top', toSide: 'bottom' };
  }
  return dx >= 0
    ? { fromSide: 'right', toSide: 'left' }
    : { fromSide: 'left', toSide: 'right' };
}

function computeSideBezierPath(p1, p2) {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const ctrl = Math.min(180, Math.max(42, dist * 0.44));
  const c1x = Math.round(p1.x + (p1.nx ?? 1) * ctrl);
  const c1y = Math.round(p1.y + (p1.ny ?? 0) * ctrl);
  const c2x = Math.round(p2.x + (p2.nx ?? -1) * ctrl);
  const c2y = Math.round(p2.y + (p2.ny ?? 0) * ctrl);
  return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
}

function computeBezierPath(x1, y1, x2, y2, vertical = false) {
  if (vertical) {
    return computeSideBezierPath(
      { x: x1, y: y1, nx: 0, ny: y2 >= y1 ? 1 : -1 },
      { x: x2, y: y2, nx: 0, ny: y2 >= y1 ? -1 : 1 }
    );
  }
  return computeSideBezierPath(
    { x: x1, y: y1, nx: x2 >= x1 ? 1 : -1, ny: 0 },
    { x: x2, y: y2, nx: x2 >= x1 ? -1 : 1, ny: 0 }
  );
}

function renderAllConnectors() {
  if (!connectorsGroup || !currentBoard) return;
  connectorsGroup.innerHTML = '';
  const objMap = new Map(currentBoard.objects.map((o) => [o.id, o]));

  currentBoard.connectors.forEach((conn) => {
    const fromObj = objMap.get(conn.fromId);
    const toObj = objMap.get(conn.toId);
    if (!fromObj || !toObj) return;

    const autoSides = autoPickBestSides(fromObj, toObj);
    const fromSide = conn.fromSide || autoSides.fromSide;
    const toSide = conn.toSide || autoSides.toSide;
    const fromOffset = typeof conn.fromOffset === 'number' ? conn.fromOffset : 0.5;
    const toOffset = typeof conn.toOffset === 'number' ? conn.toOffset : 0.5;

    const p1 = getAnchorWorldPoint(fromObj, fromSide, fromOffset);
    const p2 = getAnchorWorldPoint(toObj, toSide, toOffset);
    const dPath = computeSideBezierPath(p1, p2);
    const strokeColor = conn.color || '#0a84ff';
    const isSelected = selectedConnectorId === conn.id || (draggingConnectorEndpoint && draggingConnectorEndpoint.conn.id === conn.id);

    const itemGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    itemGroup.setAttribute('class', `connector-item-group ${isSelected ? 'selected' : ''}`);
    itemGroup.dataset.connId = conn.id;

    // 1. Wide invisible hit path for easy clicking / hovering
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('class', 'connector-hit-path');
    hitPath.setAttribute('d', dPath);

    // 2. Visible Bezier arrow path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'connector-path');
    path.setAttribute('d', dPath);
    path.setAttribute('stroke', strokeColor);
    if (conn.style === 'dashed') {
      path.setAttribute('stroke-dasharray', '7 5');
    }
    path.setAttribute('marker-end', getOrCreateArrowMarkerUrl(strokeColor, 'connArrow'));

    const onSelectConnector = (e) => {
      if (spacePressed || activeTool === 'pen' || e.button !== 0) return;
      e.stopPropagation();
      selectedConnectorId = conn.id;
      clearSelection();
      renderAllConnectors();
    };

    const onDeleteConnector = (e) => {
      e.stopPropagation();
      pushUndoSnapshot('연결선 삭제');
      currentBoard.connectors = currentBoard.connectors.filter((c) => c.id !== conn.id);
      if (selectedConnectorId === conn.id) selectedConnectorId = null;
      syncSelectionUI();
      renderAllConnectors();
      scheduleSaveBoard();
      showToast('연결선이 삭제되었습니다 (Ctrl+Z로 복구 가능)');
    };

    hitPath.addEventListener('pointerdown', onSelectConnector);
    path.addEventListener('pointerdown', onSelectConnector);
    hitPath.addEventListener('dblclick', onDeleteConnector);
    path.addEventListener('dblclick', onDeleteConnector);

    itemGroup.appendChild(hitPath);
    itemGroup.appendChild(path);

    // 3. Draggable Start Endpoint Handle (시작점 핸들)
    const startHandle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    startHandle.setAttribute('class', 'connector-endpoint-handle endpoint-from');
    startHandle.setAttribute('cx', String(p1.x));
    startHandle.setAttribute('cy', String(p1.y));
    startHandle.setAttribute('r', '6.5');
    startHandle.setAttribute('stroke', strokeColor);
    startHandle.innerHTML = `<title>화살표 시작점: 드래그하여 상하좌우 4면 원하는 위치나 다른 객체로 이동 (더블클릭 시 선 삭제)</title>`;
    startHandle.addEventListener('pointerdown', (e) => {
      if (spacePressed || activeTool === 'pen' || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      selectedConnectorId = conn.id;
      clearSelection();
      conn.fromSide = fromSide;
      conn.fromOffset = fromOffset;
      conn.toSide = toSide;
      conn.toOffset = toOffset;
      draggingConnectorEndpoint = {
        conn,
        end: 'from',
        origObjId: conn.fromId,
        snapPreview: p1,
        snapshotBefore: createBoardSnapshot('화살표 시작 위치 변경')
      };
      renderAllConnectors();
    });

    // 4. Draggable End Endpoint Handle (끝점 핸들)
    const endHandle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    endHandle.setAttribute('class', 'connector-endpoint-handle endpoint-to');
    endHandle.setAttribute('cx', String(p2.x));
    endHandle.setAttribute('cy', String(p2.y));
    endHandle.setAttribute('r', '6.5');
    endHandle.setAttribute('fill', strokeColor);
    endHandle.innerHTML = `<title>화살표 끝점: 드래그하여 상하좌우 4면 원하는 위치나 다른 객체로 이동 (더블클릭 시 선 삭제)</title>`;
    endHandle.addEventListener('pointerdown', (e) => {
      if (spacePressed || activeTool === 'pen' || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      selectedConnectorId = conn.id;
      clearSelection();
      conn.fromSide = fromSide;
      conn.fromOffset = fromOffset;
      conn.toSide = toSide;
      conn.toOffset = toOffset;
      draggingConnectorEndpoint = {
        conn,
        end: 'to',
        origObjId: conn.toId,
        snapPreview: p2,
        snapshotBefore: createBoardSnapshot('화살표 끝 위치 변경')
      };
      renderAllConnectors();
    });

    itemGroup.appendChild(startHandle);
    itemGroup.appendChild(endHandle);
    connectorsGroup.appendChild(itemGroup);
  });

  // Live Snap Ring Indicator while dragging a connector endpoint or creating a new connector
  const activeSnap =
    (draggingConnectorEndpoint && draggingConnectorEndpoint.snapPreview) ||
    (connectingState && connectingState.snapTarget);
  if (activeSnap) {
    const snapRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    snapRing.setAttribute('class', 'connector-snap-ring');
    snapRing.setAttribute('cx', String(activeSnap.x));
    snapRing.setAttribute('cy', String(activeSnap.y));
    snapRing.setAttribute('r', '11');
    connectorsGroup.appendChild(snapRing);
  }
}

// ============================================================================
// Smart Shape Recognition Engine (Circle, Ellipse, Triangle, Rectangle, Arrow, Smooth Curve, Straight Line)
// ============================================================================
function perpendicularDistance(pt, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return Math.hypot(pt[0] - lineStart[0], pt[1] - lineStart[1]);
  return Math.abs(dy * pt[0] - dx * pt[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / mag;
}

function simplifyRDP(points, epsilon) {
  if (points.length < 3) return points;
  let dmax = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }
  if (dmax > epsilon) {
    const rec1 = simplifyRDP(points.slice(0, index + 1), epsilon);
    const rec2 = simplifyRDP(points.slice(index), epsilon);
    return rec1.slice(0, -1).concat(rec2);
  }
  return [points[0], points[end]];
}

function buildSmoothCurveSvgPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = Math.round((pts[i][0] + pts[i + 1][0]) / 2);
    const yc = Math.round((pts[i][1] + pts[i + 1][1]) / 2);
    d += ` Q ${pts[i][0]} ${pts[i][1]}, ${xc} ${yc}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function recognizeAndBeautifyStroke(stroke, { forceLine = false, forceSmoothCurve = false } = {}) {
  const pts = stroke.points;
  if (!pts || pts.length < 3) return stroke;

  const first = pts[0];
  const last = pts[pts.length - 1];

  // 1. Forced Straight Line (Ctrl or Shift held)
  if (forceLine) {
    stroke.svgPath = `M ${first[0]} ${first[1]} L ${last[0]} ${last[1]}`;
    stroke.hasArrow = arrowPenMode;
    stroke.shapeType = 'line';
    return stroke;
  }

  // 2. Forced Smooth Curve (Alt held)
  if (forceSmoothCurve) {
    const decimated = pts.filter((_, idx) => idx % 3 === 0 || idx === pts.length - 1);
    stroke.svgPath = buildSmoothCurveSvgPath(decimated);
    stroke.hasArrow = arrowPenMode;
    stroke.shapeType = 'curve';
    return stroke;
  }

  if (!autoShapeEnabled) {
    if (arrowPenMode) stroke.hasArrow = true;
    return stroke;
  }

  // Bounding Box & Path Length
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let pathLength = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (i > 0) pathLength += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
  }

  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const diag = Math.hypot(boxW, boxH);
  if (diag < 24) return stroke;

  const startEndDist = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const isClosed = startEndDist < Math.max(48, diag * 0.34) && pathLength > diag * 1.6;

  // 3. Open Stroke: Check Straight Line or Arrow Hook
  if (!isClosed) {
    const directDist = startEndDist;
    const straightness = directDist / Math.max(1, pathLength);

    // Check if the user drew a quick arrowhead hook at the end of a line
    const tailIdx = Math.max(1, Math.floor(pts.length * 0.78));
    const pivot = pts[tailIdx];
    const mainVecX = pivot[0] - first[0];
    const mainVecY = pivot[1] - first[1];
    const tailVecX = last[0] - pivot[0];
    const tailVecY = last[1] - pivot[1];
    const dot = mainVecX * tailVecX + mainVecY * tailVecY;
    const hasArrowHook = dot < 0 && Math.hypot(tailVecX, tailVecY) < diag * 0.35 && Math.hypot(mainVecX, mainVecY) > 40;

    if (straightness > 0.91) {
      stroke.svgPath = `M ${first[0]} ${first[1]} L ${last[0]} ${last[1]}`;
      stroke.hasArrow = arrowPenMode;
      stroke.shapeType = 'line';
      return stroke;
    }

    if (hasArrowHook || arrowPenMode) {
      const endPt = hasArrowHook ? pivot : last;
      const midPt = pts[Math.floor(tailIdx / 2)];
      const lineDist = perpendicularDistance(midPt, first, endPt);
      if (lineDist < diag * 0.08) {
        stroke.svgPath = `M ${first[0]} ${first[1]} L ${endPt[0]} ${endPt[1]}`;
      } else {
        stroke.svgPath = `M ${first[0]} ${first[1]} Q ${midPt[0]} ${midPt[1]}, ${endPt[0]} ${endPt[1]}`;
      }
      stroke.hasArrow = true;
      stroke.shapeType = 'arrow';
      showToast('✨ 화살표 도형으로 자동 보정되었습니다');
      return stroke;
    }

    return stroke;
  }

  // 4. Closed Loop: Recognize Circle, Ellipse, Triangle, or Rectangle!
  const closedPts = [...pts, first];
  const simplified = simplifyRDP(closedPts, diag * 0.065);
  // Count distinct corners (excluding the duplicate closing vertex)
  const vertices = simplified.slice(0, -1);

  // Compute radial variance from center to test Circle / Ellipse
  const cx = Math.round(minX + boxW / 2);
  const cy = Math.round(minY + boxH / 2);
  const rx = Math.max(12, Math.round(boxW / 2));
  const ry = Math.max(12, Math.round(boxH / 2));

  let normRadialErr = 0;
  for (const [px, py] of pts) {
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    const r = Math.hypot(nx, ny);
    normRadialErr += Math.abs(r - 1);
  }
  normRadialErr /= pts.length;

  // Triangle check (3 vertices)
  if (vertices.length === 3 && normRadialErr > 0.13) {
    const [p1, p2, p3] = vertices;
    stroke.svgPath = `M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} L ${p3[0]} ${p3[1]} Z`;
    stroke.shapeType = 'triangle';
    showToast('📐 삼각형으로 자동 보정되었습니다');
    return stroke;
  }

  // Rectangle check (4 vertices or low radial fit with ~4 corners)
  if (vertices.length === 4 && normRadialErr > 0.14) {
    const x = Math.round(minX);
    const y = Math.round(minY);
    const w = Math.round(boxW);
    const h = Math.round(boxH);
    stroke.svgPath = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    stroke.shapeType = 'rectangle';
    showToast('▭ 사각형으로 자동 보정되었습니다');
    return stroke;
  }

  // Circle vs Ellipse check
  if (normRadialErr < 0.24 || vertices.length >= 5) {
    const aspect = boxW / Math.max(1, boxH);
    if (aspect >= 0.80 && aspect <= 1.25) {
      const r = Math.round((rx + ry) / 2);
      stroke.svgPath = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 -${r * 2} 0`;
      stroke.shapeType = 'circle';
      stroke.bbox = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
      showToast('⭕ 정원(동그라미)으로 자동 보정되었습니다');
    } else {
      stroke.svgPath = `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 -${rx * 2} 0`;
      stroke.shapeType = 'ellipse';
      stroke.bbox = { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
      showToast('⬭ 타원형으로 자동 보정되었습니다');
    }
    return stroke;
  }

  // Fallback if 4-5 vertices polygon looks like a rectangle
  if (vertices.length >= 4 && vertices.length <= 5) {
    const x = Math.round(minX);
    const y = Math.round(minY);
    const w = Math.round(boxW);
    const h = Math.round(boxH);
    stroke.svgPath = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    stroke.shapeType = 'rectangle';
    showToast('▭ 사각형으로 자동 보정되었습니다');
  }

  return stroke;
}

const SHAPE_TYPE_LABELS = {
  circle: '정원 도형',
  ellipse: '타원 도형',
  triangle: '삼각형 도형',
  rectangle: '사각형 도형',
  arrow: '펜 화살표',
  line: '직선',
  curve: '곡선',
  freehand: '펜 자유선'
};

function buildStrokeObjectFromRawStroke(rawStroke) {
  if (!rawStroke) return null;
  const pts = Array.isArray(rawStroke.points) ? rawStroke.points : [];
  if (pts.length < 1 && !rawStroke.svgPath) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  if (rawStroke.bbox) {
    minX = rawStroke.bbox.minX;
    minY = rawStroke.bbox.minY;
    maxX = rawStroke.bbox.maxX;
    maxY = rawStroke.bbox.maxY;
  } else {
    pts.forEach(([px, py]) => {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    });
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 120;
    maxY = 120;
  }

  const pad = 18;
  const x = Math.round(minX - pad);
  const y = Math.round(minY - pad);
  const width = Math.max(44, Math.round(maxX - minX + pad * 2));
  const height = Math.max(44, Math.round(maxY - minY + pad * 2));

  let pathD = rawStroke.svgPath || '';
  if (!pathD) {
    if (pts.length === 1) {
      pathD = `M ${pts[0][0]} ${pts[0][1]} L ${pts[0][0] + 1} ${pts[0][1] + 1}`;
    } else {
      pathD = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt[0]} ${pt[1]}`).join(' ');
    }
  }

  const shapeType = rawStroke.shapeType || (rawStroke.hasArrow ? 'arrow' : 'freehand');
  const titleLabel = SHAPE_TYPE_LABELS[shapeType] || '펜 드로잉';
  const strokeHex = rawStroke.color || '#0a84ff';

  return {
    id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'stroke',
    title: titleLabel,
    content: titleLabel,
    x,
    y,
    width,
    height,
    rotation: 0,
    color: 'blue',
    customColor: strokeHex,
    strokeData: {
      pathD,
      viewBox: { x, y, w: width, h: height },
      strokeWidth: Number(rawStroke.width) || 3.5,
      hasArrow: Boolean(rawStroke.hasArrow),
      dashed: Boolean(rawStroke.dashed),
      shapeType
    },
    zIndex: getNextZIndex(),
    createdAt: Date.now()
  };
}

function renderAllStrokes() {
  if (!strokesGroup) return;
  strokesGroup.innerHTML = '';
  // Live preview of the stroke currently being drawn with the pen
  const activeList = [...(currentBoard?.strokes || [])];
  if (drawingStroke && !activeList.includes(drawingStroke)) {
    activeList.push(drawingStroke);
  }
  activeList.forEach((s) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (s.svgPath) {
      path.setAttribute('d', s.svgPath);
    } else {
      if (!Array.isArray(s.points) || s.points.length < 2) return;
      const d = s.points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt[0]} ${pt[1]}`).join(' ');
      path.setAttribute('d', d);
    }
    path.setAttribute('fill', 'none');
    const color = s.color || '#0a84ff';
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(s.width || 3.5));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (s.hasArrow) {
      path.setAttribute('marker-end', getOrCreateArrowMarkerUrl(color, 'strokeArrow'));
    }
    strokesGroup.appendChild(path);
  });
}

// ============================================================================
// Add / Duplicate / Copy / Paste Objects Helper
// ============================================================================
function getNextZIndex() {
  if (!currentBoard || !currentBoard.objects.length) return 1;
  return Math.max(...currentBoard.objects.map((o) => o.zIndex || 1)) + 1;
}

function addObjectToBoard(partial, panToNew = false, recordUndo = true) {
  if (!currentBoard) return null;
  if (recordUndo) {
    pushUndoSnapshot(`객체 추가 (${partial.title || partial.type || '새 객체'})`);
  }
  const center = getViewportCenterWorld();
  const w = partial.width || 340;
  const h = partial.height || 220;
  const jitter = Math.round((Math.random() - 0.5) * 32);
  const newObj = {
    id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: partial.type || 'sticky',
    x: partial.x ?? center.x - Math.round(w / 2) + jitter,
    y: partial.y ?? center.y - Math.round(h / 2) + jitter,
    width: w,
    height: h,
    rotation: partial.rotation || 0,
    groupId: partial.groupId || undefined,
    color: partial.color || (partial.type === 'sticky' ? 'yellow' : partial.type === 'label' ? 'light' : 'dark'),
    customColor: partial.customColor || null,
    textStyle: partial.textStyle ? { ...partial.textStyle } : null,
    titleAlign: partial.titleAlign || 'left',
    lineAligns: Array.isArray(partial.lineAligns) ? [...partial.lineAligns] : undefined,
    memoLineAligns: Array.isArray(partial.memoLineAligns) ? [...partial.memoLineAligns] : undefined,
    cellAligns: partial.cellAligns ? { ...partial.cellAligns } : undefined,
    artStyle: partial.artStyle || undefined,
    vectorized: Boolean(partial.vectorized) || undefined,
    vectorAspect: partial.vectorAspect || undefined,
    strokeData: partial.strokeData ? JSON.parse(JSON.stringify(partial.strokeData)) : undefined,
    pdfViewMode: partial.pdfViewMode || undefined,
    title: partial.title || '',
    content: partial.content || '',
    tableData: partial.tableData || null,
    url: partial.url || null,
    domain: partial.domain || null,
    description: partial.description || null,
    favicon: partial.favicon || null,
    thumbnail: partial.thumbnail || null,
    youtubeId: partial.youtubeId || null,
    assetFileName: partial.assetFileName || null,
    resolvedFilePath: partial.resolvedFilePath || null,
    resolvedFileUrl: partial.resolvedFileUrl || null,
    fileName: partial.fileName || null,
    fileSize: partial.fileSize || null,
    zIndex: getNextZIndex(),
    createdAt: Date.now()
  };

  currentBoard.objects.push(newObj);
  if (panToNew) {
    const rect = canvasViewport.getBoundingClientRect();
    panX = Math.round(rect.width / 2 - (newObj.x + newObj.width / 2) * zoom);
    panY = Math.round(rect.height / 2 - (newObj.y + newObj.height / 2) * zoom);
    applyViewportTransform();
  }
  renderAllObjects();
  selectObject(newObj.id, { expandGroup: false });
  scheduleSaveBoard();
  return newObj;
}

function copySelectedObjectsToBuffer(cut = false) {
  const selected = getSelectedObjects();
  if (selected.length === 0) return;
  copiedObjectsBuffer = JSON.parse(JSON.stringify(selected));
  lastCopiedAt = Date.now();

  // Also write readable text to system clipboard
  const textSummary = selected
    .map((o) =>
      o.tableData
        ? o.tableData.map((r) => r.join('\t')).join('\n')
        : o.content || o.url || o.title || ''
    )
    .filter(Boolean)
    .join('\n\n');
  if (textSummary) {
    window.freeformAPI.writeClipboardText(textSummary);
  }

  if (cut) {
    deleteSelectedObjects();
    showToast(`✂️ ${copiedObjectsBuffer.length}개 객체를 잘라냈습니다 (Ctrl+Z로 복구 가능)`);
  } else {
    showToast(`📋 ${copiedObjectsBuffer.length}개 객체가 복사되었습니다 (Ctrl+V로 붙여넣기)`);
  }
}

function pasteCopiedObjectsFromBuffer(atWorldPos = null) {
  if (!copiedObjectsBuffer.length || !currentBoard) return false;
  pushUndoSnapshot(`객체 붙여넣기 (${copiedObjectsBuffer.length}개)`);
  const minX = Math.min(...copiedObjectsBuffer.map((o) => o.x));
  const minY = Math.min(...copiedObjectsBuffer.map((o) => o.y));
  const targetOrigin = atWorldPos || { x: minX + 34, y: minY + 34 };
  const dx = targetOrigin.x - minX;
  const dy = targetOrigin.y - minY;

  const groupMap = new Map();
  const newIds = [];

  copiedObjectsBuffer.forEach((orig) => {
    const clone = JSON.parse(JSON.stringify(orig));
    delete clone.id;
    clone.x = Math.round(orig.x + dx);
    clone.y = Math.round(orig.y + dy);
    if (orig.groupId) {
      if (!groupMap.has(orig.groupId)) {
        groupMap.set(orig.groupId, `grp_${Date.now().toString().slice(-5)}_${Math.random().toString(36).slice(2, 4)}`);
      }
      clone.groupId = groupMap.get(orig.groupId);
    }
    const created = addObjectToBoard(clone, false, false);
    if (created) newIds.push(created.id);
  });

  setSelectedObjectIds(newIds);
  showToast(`📌 ${newIds.length}개 객체가 보드에 붙여넣어졌습니다`);
  return true;
}

// Smart Paste (Ctrl+V or Paste Button or Context Menu)
async function handleSmartPaste(atWorldPos = null, preferObjectBuffer = false) {
  if (preferObjectBuffer && copiedObjectsBuffer.length > 0) {
    pasteCopiedObjectsFromBuffer(atWorldPos);
    return;
  }

  const clip = await window.freeformAPI.readClipboardSmart();
  if (!clip || clip.kind === 'empty') {
    if (copiedObjectsBuffer.length > 0) {
      pasteCopiedObjectsFromBuffer(atWorldPos);
      return;
    }
    showToast('클립보드가 비어 있습니다');
    return;
  }

  const pos = atWorldPos || getViewportCenterWorld();

  if (clip.kind === 'image') {
    const ratio = clip.height && clip.width ? clip.height / clip.width : 0.75;
    const w = Math.min(460, Math.max(240, clip.width || 360));
    const h = Math.min(460, Math.max(180, Math.round(w * ratio) + 46));
    addObjectToBoard({
      type: 'image',
      title: clip.asset.name || '클립보드 이미지',
      x: pos.x - Math.round(w / 2),
      y: pos.y - Math.round(h / 2),
      width: w,
      height: h,
      color: 'dark',
      assetFileName: clip.asset.assetFileName,
      resolvedFilePath: clip.asset.resolvedFilePath,
      resolvedFileUrl: clip.asset.resolvedFileUrl
    });
    showToast('🖼️ 클립보드 이미지가 이미지 객체로 추가되었습니다');
  } else if (clip.kind === 'table') {
    addObjectToBoard({
      type: 'table',
      title: '📊 붙여넣은 표 데이터',
      x: pos.x - 230,
      y: pos.y - 130,
      width: 480,
      height: 260,
      color: 'blue',
      tableData: clip.tableData
    });
    showToast('📊 클립보드 표 데이터가 스프레드시트 객체로 추가되었습니다');
  } else if (clip.kind === 'url') {
    showToast('🔗 링크 및 동영상 메타데이터 분석 중...');
    const meta = await window.freeformAPI.fetchUrlMetadata(clip.url);
    const isVideo = Boolean(meta.youtubeId || clip.youtubeId || meta.isVideo || clip.isVideo);
    addObjectToBoard({
      type: 'link',
      title: meta.title || clip.url,
      url: meta.url || clip.url,
      domain: meta.domain,
      description: meta.description,
      favicon: meta.favicon,
      thumbnail: meta.thumbnail,
      youtubeId: meta.youtubeId || clip.youtubeId || null,
      x: pos.x - 200,
      y: pos.y - 130,
      width: isVideo ? 420 : 390,
      height: isVideo ? 290 : (meta.thumbnail ? 275 : 175),
      color: 'dark'
    });
    showToast(isVideo ? '🎬 유튜브/동영상 플레이어 카드가 추가되었습니다' : '🔗 하이퍼링크 북마크 카드가 추가되었습니다');
  } else if (clip.kind === 'text') {
    // If the user just copied an internal object within the last 10 seconds and its text matches, paste the object clone
    if (copiedObjectsBuffer.length > 0 && Date.now() - lastCopiedAt < 10000) {
      pasteCopiedObjectsFromBuffer(pos);
      return;
    }
    addObjectToBoard({
      type: 'text',
      title: '📝 붙여넣은 노트',
      content: clip.text,
      x: pos.x - 170,
      y: pos.y - 110,
      width: 350,
      height: 220,
      color: 'dark'
    });
    showToast('📝 클립보드 텍스트가 노트 객체로 생성되었습니다');
  }
}

// ============================================================================
// Middle-Mouse-Click+Drag Pan (Anywhere), Empty Canvas Pan, Shift+Drag Marquee, Smart Pen
// ============================================================================
// Prevent Windows default auto-scroll circle on middle mouse button click
window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  },
  true
);

// Capture-phase pointerdown on canvasViewport so Middle-Click (Wheel Click) Pan works EVEN when objects fill the screen!
canvasViewport.addEventListener(
  'pointerdown',
  (e) => {
    hideContextMenu();

    // 1. Middle Mouse Button (Wheel Click + Drag, button === 1) -> Pan anywhere on the canvas or over objects!
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      isPanning = true;
      panStartX = e.clientX - panX;
      panStartY = e.clientY - panY;
      canvasViewport.classList.add('canvas-panning-active');
      return;
    }

    // 2. Shift + Left-Click Drag on empty canvas -> Multi-selection Marquee Box!
    const isEmptyCanvasTarget =
      e.target === canvasViewport ||
      e.target === canvasWorld ||
      e.target === objectLayer ||
      e.target.id === 'connectorLayer';

    if (e.shiftKey && e.button === 0 && isEmptyCanvasTarget && activeTool === 'select') {
      e.preventDefault();
      e.stopPropagation();
      marqueeState = {
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY
      };
      if (selectionMarquee) {
        selectionMarquee.classList.remove('hidden');
        selectionMarquee.style.left = `${e.clientX}px`;
        selectionMarquee.style.top = `${e.clientY}px`;
        selectionMarquee.style.width = '0px';
        selectionMarquee.style.height = '0px';
      }
      return;
    }

    // 3. Pen Tool Drawing (works on empty canvas AND over existing pen stroke objects)
    if (activeTool === 'pen' && e.button === 0 && (isEmptyCanvasTarget || e.target.closest('.ff-object.type-stroke'))) {
      e.preventDefault();
      e.stopPropagation();
      const pt = screenToWorld(e.clientX, e.clientY);
      drawingStroke = {
        color: currentPenColor,
        width: 3.5,
        points: [[Math.round(pt.x), Math.round(pt.y)]]
      };
      renderAllStrokes();
      return;
    }

    if (!isEmptyCanvasTarget) return;

    // 4. Empty Canvas Left-Click Drag -> Pan (Hand cursor -> Grabbing Hand cursor)
    if (e.button === 0) {
      if (selectedConnectorId) {
        selectedConnectorId = null;
        renderAllConnectors();
      }
      clearSelection();
      isPanning = true;
      panStartX = e.clientX - panX;
      panStartY = e.clientY - panY;
      canvasViewport.classList.add('canvas-panning-active');
    }
  },
  true
);

window.addEventListener('pointermove', (e) => {
  if (draggingConnectorEndpoint) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const conn = draggingConnectorEndpoint.conn;
    const otherObjId = draggingConnectorEndpoint.end === 'from' ? conn.toId : conn.fromId;
    const snap = findBestObjectAnchorAtPoint(
      cur.x,
      cur.y,
      otherObjId,
      draggingConnectorEndpoint.origObjId
    );
    if (snap) {
      if (draggingConnectorEndpoint.end === 'from') {
        conn.fromId = snap.objId;
        conn.fromSide = snap.side;
        conn.fromOffset = snap.offset;
      } else {
        conn.toId = snap.objId;
        conn.toSide = snap.side;
        conn.toOffset = snap.offset;
      }
      draggingConnectorEndpoint.snapPreview = snap;
      renderAllConnectors();
    }
    return;
  }

  if (drawingStroke) {
    const pt = screenToWorld(e.clientX, e.clientY);
    const startPt = drawingStroke.points[0];

    // Live Straight Line Preview while holding Ctrl or Shift
    if (e.ctrlKey || e.shiftKey) {
      let tx = Math.round(pt.x);
      let ty = Math.round(pt.y);
      if (e.shiftKey) {
        // 15-degree angle snap
        const angle = Math.atan2(ty - startPt[1], tx - startPt[0]);
        const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const dist = Math.hypot(tx - startPt[0], ty - startPt[1]);
        tx = Math.round(startPt[0] + Math.cos(snapped) * dist);
        ty = Math.round(startPt[1] + Math.sin(snapped) * dist);
      }
      drawingStroke.points = [startPt, [tx, ty]];
      drawingStroke.svgPath = `M ${startPt[0]} ${startPt[1]} L ${tx} ${ty}`;
      drawingStroke.hasArrow = arrowPenMode;
    } else {
      delete drawingStroke.svgPath;
      drawingStroke.points.push([Math.round(pt.x), Math.round(pt.y)]);
    }
    renderAllStrokes();
    return;
  }

  if (marqueeState) {
    marqueeState.curX = e.clientX;
    marqueeState.curY = e.clientY;
    const left = Math.min(marqueeState.startX, marqueeState.curX);
    const top = Math.min(marqueeState.startY, marqueeState.curY);
    const width = Math.abs(marqueeState.curX - marqueeState.startX);
    const height = Math.abs(marqueeState.curY - marqueeState.startY);
    if (selectionMarquee) {
      selectionMarquee.style.left = `${left}px`;
      selectionMarquee.style.top = `${top}px`;
      selectionMarquee.style.width = `${width}px`;
      selectionMarquee.style.height = `${height}px`;
    }
    return;
  }

  if (isPanning) {
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    applyViewportTransform();
    return;
  }

  if (rotatingObjState) {
    const curAngle =
      (Math.atan2(e.clientY - rotatingObjState.centerY, e.clientX - rotatingObjState.centerX) * 180) / Math.PI;
    let nextRot = Math.round(rotatingObjState.origRotation + (curAngle - rotatingObjState.startAngle));
    if (e.shiftKey) {
      nextRot = Math.round(nextRot / 15) * 15;
    }
    rotatingObjState.obj.rotation = nextRot;
    rotatingObjState.el.style.transform = `rotate(${nextRot}deg)`;
    return;
  }

  if (draggingObjState) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const dx = cur.x - draggingObjState.startWorldX;
    const dy = cur.y - draggingObjState.startWorldY;
    draggingObjState.items.forEach((item) => {
      item.obj.x = Math.round(item.origX + dx);
      item.obj.y = Math.round(item.origY + dy);
      if (item.el) {
        item.el.style.left = `${item.obj.x}px`;
        item.el.style.top = `${item.obj.y}px`;
      }
    });
    renderAllConnectors();
    return;
  }

  if (resizingObjState) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const dw = cur.x - resizingObjState.startWorldX;
    const dh = cur.y - resizingObjState.startWorldY;
    if (resizingObjState.obj.type === 'label' && resizingObjState.obj.vectorized) {
      const minW = 60;
      const minH = 28;
      if (e.shiftKey) {
        // Shift + Drag: Free non-proportional stretch (wide banner or tall title)
        resizingObjState.obj.width = Math.max(minW, Math.round(resizingObjState.origW + dw));
        resizingObjState.obj.height = Math.max(minH, Math.round(resizingObjState.origH + dh));
      } else {
        // Default Drag: Proportional vector scaling in one smooth drag!
        const aspect =
          resizingObjState.obj.vectorAspect ||
          resizingObjState.origW / Math.max(1, resizingObjState.origH);
        const scaleX = (resizingObjState.origW + dw) / Math.max(1, resizingObjState.origW);
        const scaleY = (resizingObjState.origH + dh) / Math.max(1, resizingObjState.origH);
        const scale = Math.abs(dw) >= Math.abs(dh) ? scaleX : scaleY;
        const nextW = Math.max(minW, Math.round(resizingObjState.origW * scale));
        const nextH = Math.max(minH, Math.round(nextW / Math.max(0.15, aspect)));
        resizingObjState.obj.width = nextW;
        resizingObjState.obj.height = nextH;
      }
    } else {
      const minW = resizingObjState.obj.type === 'stroke' ? 36 : 180;
      const minH = resizingObjState.obj.type === 'stroke' ? 36 : 120;
      resizingObjState.obj.width = Math.max(minW, Math.round(resizingObjState.origW + dw));
      resizingObjState.obj.height = Math.max(minH, Math.round(resizingObjState.origH + dh));
    }
    resizingObjState.el.style.width = `${resizingObjState.obj.width}px`;
    resizingObjState.el.style.height = `${resizingObjState.obj.height}px`;
    renderAllConnectors();
    return;
  }

  if (connectingState && tempConnectorPath) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const snap = findBestObjectAnchorAtPoint(cur.x, cur.y, connectingState.fromId, null);
    connectingState.snapTarget = snap;
    const startPt = {
      x: connectingState.startX,
      y: connectingState.startY,
      nx: connectingState.startNx ?? 1,
      ny: connectingState.startNy ?? 0
    };
    if (snap) {
      tempConnectorPath.setAttribute('d', computeSideBezierPath(startPt, snap));
    } else {
      tempConnectorPath.setAttribute(
        'd',
        computeSideBezierPath(startPt, {
          x: Math.round(cur.x),
          y: Math.round(cur.y),
          nx: -(startPt.nx || 1),
          ny: -(startPt.ny || 0)
        })
      );
    }
    renderAllConnectors();
  }
});

window.addEventListener('pointerup', (e) => {
  if (draggingConnectorEndpoint) {
    if (draggingConnectorEndpoint.snapshotBefore) {
      pushUndoSnapshot('화살표 연결 위치 변경', draggingConnectorEndpoint.snapshotBefore);
    }
    draggingConnectorEndpoint = null;
    renderAllConnectors();
    scheduleSaveBoard();
    showToast('화살표 연결 위치가 이동되었습니다');
  }

  if (drawingStroke) {
    recognizeAndBeautifyStroke(drawingStroke, {
      forceLine: e.ctrlKey || e.shiftKey,
      forceSmoothCurve: e.altKey
    });
    const strokeObj = buildStrokeObjectFromRawStroke(drawingStroke);
    drawingStroke = null;
    renderAllStrokes();
    if (strokeObj && currentBoard) {
      pushUndoSnapshot(`펜 드로잉 (${strokeObj.title || '선/도형'})`);
      currentBoard.objects.push(strokeObj);
      renderAllObjects();
      scheduleSaveBoard();
    }
  }

  if (marqueeState) {
    const p1 = screenToWorld(
      Math.min(marqueeState.startX, marqueeState.curX),
      Math.min(marqueeState.startY, marqueeState.curY)
    );
    const p2 = screenToWorld(
      Math.max(marqueeState.startX, marqueeState.curX),
      Math.max(marqueeState.startY, marqueeState.curY)
    );
    const matchedIds = (currentBoard?.objects || [])
      .filter((o) => o.x + o.width >= p1.x && o.x <= p2.x && o.y + o.height >= p1.y && o.y <= p2.y)
      .map((o) => o.id);
    setSelectedObjectIds(matchedIds);
    if (matchedIds.length > 0) {
      showToast(`✨ ${selectedObjectIds.size}개 객체가 다중 선택되었습니다 (Ctrl+G로 그룹화 가능)`);
    }
    marqueeState = null;
    selectionMarquee?.classList.add('hidden');
  }

  if (isPanning) {
    isPanning = false;
    canvasViewport?.classList.remove('canvas-panning-active');
    scheduleSaveBoard();
  }
  if (rotatingObjState) {
    if (rotatingObjState.obj.rotation !== rotatingObjState.origRotation && rotatingObjState.snapshotBefore) {
      pushUndoSnapshot('객체 회전', rotatingObjState.snapshotBefore);
    }
    rotatingObjState = null;
    scheduleSaveBoard();
  }
  if (draggingObjState) {
    document.body.classList.remove('is-dragging-object');
    const moved = draggingObjState.items.some((item) => item.obj.x !== item.origX || item.obj.y !== item.origY);
    if (moved && draggingObjState.snapshotBefore) {
      pushUndoSnapshot('객체 이동', draggingObjState.snapshotBefore);
    }
    draggingObjState = null;
    scheduleSaveBoard();
  }
  if (resizingObjState) {
    const resized =
      resizingObjState.obj.width !== resizingObjState.origW ||
      resizingObjState.obj.height !== resizingObjState.origH;
    const resizedObj = resizingObjState.obj;
    if (resized && resizingObjState.snapshotBefore) {
      pushUndoSnapshot('객체 크기 조절', resizingObjState.snapshotBefore);
    }
    resizingObjState = null;
    if (resized && isPdfObject(resizedObj) && (resizedObj.pdfViewMode || 'viewer') === 'viewer') {
      renderAllObjects();
    }
    scheduleSaveBoard();
  }
  if (connectingState) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const snap = connectingState.snapTarget || findBestObjectAnchorAtPoint(cur.x, cur.y, connectingState.fromId, null);
    if (snap && snap.objId && snap.objId !== connectingState.fromId) {
      pushUndoSnapshot('화살표 연결선 추가');
      const newConnId = `conn_${Date.now()}`;
      currentBoard.connectors.push({
        id: newConnId,
        fromId: connectingState.fromId,
        fromSide: connectingState.fromSide || 'right',
        fromOffset: connectingState.fromOffset ?? 0.5,
        toId: snap.objId,
        toSide: snap.side,
        toOffset: snap.offset,
        color: '#0a84ff',
        style: 'solid'
      });
      selectedConnectorId = newConnId;
      scheduleSaveBoard();
      showToast('두 객체가 화살표로 연결되었습니다 (시작점/끝점을 잡고 4면 원하는 위치로 이동 가능)');
    }
    connectingState = null;
    if (tempConnectorPath) tempConnectorPath.classList.add('hidden');
    renderAllConnectors();
  }
});

// Smooth Zoom on Mouse Wheel
canvasViewport.addEventListener(
  'wheel',
  (e) => {
    if (e.target.closest('.ff-obj-body, .ff-table-wrap, .ff-pdf-pages-container')) {
      if (!e.ctrlKey) return;
    }
    e.preventDefault();
    const rect = canvasViewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - panX) / zoom;
    const worldY = (mouseY - panY) / zoom;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoom = Math.min(3.5, Math.max(0.1, zoom * factor));
    panX = mouseX - worldX * zoom;
    panY = mouseY - worldY * zoom;
    applyViewportTransform();
    scheduleSaveBoard();
  },
  { passive: false }
);

// ============================================================================
// Universal Drag & Drop (Explorer Files, Images, PDF, CSV, Chrome Links, YouTube, Text)
// ============================================================================
let dragCounter = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay?.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) {
    dropOverlay?.classList.add('hidden');
  }
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  dropOverlay?.classList.add('hidden');

  const dropPos = screenToWorld(e.clientX, e.clientY);
  const dt = e.dataTransfer;
  if (!dt) return;

  // 1. Dropped Local Files (Images, PDF Documents, CSV/TSV, etc.)
  if (dt.files && dt.files.length > 0) {
    let offset = 0;
    for (const file of dt.files) {
      try {
        const nativePath = window.freeformAPI.getPathForFile(file);
        let saved = null;
        if (nativePath) {
          saved = await window.freeformAPI.saveAssetFromPath(nativePath, file.name);
        } else {
          const ab = await file.arrayBuffer();
          const extMatch = (file.name || '').match(/(\.[A-Za-z0-9]+)$/);
          saved = await window.freeformAPI.saveAssetFromBuffer({
            buffer: ab,
            ext: extMatch ? extMatch[1] : '.bin',
            name: file.name || 'dropped_file'
          });
        }

        // If CSV/TSV file dropped, also offer/create a Table card!
        if (/\.(csv|tsv)$/i.test(file.name)) {
          const textContent = await file.text();
          const sep = file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
          const rows = textContent
            .trim()
            .split(/\r?\n/)
            .slice(0, 60)
            .map((line) => line.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()));
          if (rows.length >= 1) {
            addObjectToBoard({
              type: 'table',
              title: file.name,
              x: dropPos.x - 220 + offset,
              y: dropPos.y - 120 + offset,
              width: 480,
              height: 260,
              color: 'blue',
              tableData: rows
            });
            offset += 28;
            continue;
          }
        }

        const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name) || (file.type && file.type.startsWith('image/'));
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        addObjectToBoard({
          type: isImg ? 'image' : 'file',
          title: file.name,
          fileName: file.name,
          fileSize: saved.size || file.size,
          pdfViewMode: isPdf ? 'viewer' : undefined,
          x: dropPos.x - (isPdf ? 240 : 160) + offset,
          y: dropPos.y - (isPdf ? 280 : 110) + offset,
          width: isImg ? 360 : isPdf ? 480 : 330,
          height: isImg ? 270 : isPdf ? 580 : 135,
          color: 'dark',
          assetFileName: saved.assetFileName,
          resolvedFilePath: saved.resolvedFilePath,
          resolvedFileUrl: saved.resolvedFileUrl
        });
        offset += 28;
      } catch (err) {
        console.error('File drop error:', err);
      }
    }
    showToast('드래그한 파일이 프리폼 보드에 추가되었습니다');
    return;
  }

  // 2. Dropped URL / Link from Chrome or Web Browser
  const uriList = (dt.getData('text/uri-list') || '').trim();
  const plainText = (dt.getData('text/plain') || '').trim();
  const htmlData = dt.getData('text/html') || '';

  let extractedUrl = '';
  if (uriList) {
    extractedUrl = uriList.split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '';
  } else if (/^https?:\/\/\S+$/i.test(plainText)) {
    extractedUrl = plainText;
  } else if (htmlData) {
    const hrefMatch = htmlData.match(/href=["'](https?:\/\/[^"']+)["']/i);
    if (hrefMatch) extractedUrl = hrefMatch[1];
  }

  if (extractedUrl) {
    showToast('드롭한 웹 링크 분석 중...');
    const meta = await window.freeformAPI.fetchUrlMetadata(extractedUrl);
    const isVideo = Boolean(meta.youtubeId || meta.isVideo);
    addObjectToBoard({
      type: 'link',
      title: meta.title || extractedUrl,
      url: meta.url || extractedUrl,
      domain: meta.domain,
      description: meta.description,
      favicon: meta.favicon,
      thumbnail: meta.thumbnail,
      youtubeId: meta.youtubeId || null,
      x: dropPos.x - 195,
      y: dropPos.y - 120,
      width: isVideo ? 420 : 390,
      height: isVideo ? 290 : (meta.thumbnail ? 275 : 175),
      color: 'dark'
    });
    showToast(isVideo ? '유튜브/동영상 카드가 추가되었습니다' : '크롬 웹 링크가 북마크 카드로 추가되었습니다');
    return;
  }

  // 3. Dropped Plain Text
  if (plainText) {
    addObjectToBoard({
      type: 'sticky',
      title: '📌 드롭한 메모',
      content: plainText,
      x: dropPos.x - 170,
      y: dropPos.y - 105,
      width: 320,
      height: 220,
      color: 'yellow'
    });
    showToast('드래그한 텍스트가 메모로 추가되었습니다');
  }
});

// ============================================================================
// Custom Right-Click Context Menu
// ============================================================================
function hideContextMenu() {
  contextMenu?.classList.add('hidden');
}

window.addEventListener('contextmenu', (e) => {
  if (e.target.closest('#inspectorColors .swatch, #penToolbar .pen-color')) {
    return;
  }
  e.preventDefault();
  if (!contextMenu) return;

  const worldPos = screenToWorld(e.clientX, e.clientY);
  const objEl = e.target.closest('.ff-object');
  const isTextTarget = Boolean(e.target.closest('input, textarea, [contenteditable="true"]'));
  const selectedText = window.getSelection()?.toString() || '';

  if (objEl && objEl.dataset.id) {
    const objId = objEl.dataset.id;
    if (!selectedObjectIds.has(objId)) {
      selectObject(objId, { additive: false });
    }
  }

  const selected = getSelectedObjects();
  const primary = getPrimarySelectedObject();

  let html = '';

  // Text editing quick actions
  if (isTextTarget || selectedText) {
    html += `
      <button class="ctx-item" data-ctx="text-copy"><span class="ctx-item-left">${SVG_ICONS.copy}<span>선택 텍스트 복사</span></span><span class="ctx-kbd">Ctrl+C</span></button>
      <button class="ctx-item" data-ctx="text-cut"><span class="ctx-item-left">${SVG_ICONS.cut}<span>텍스트 잘라내기</span></span><span class="ctx-kbd">Ctrl+X</span></button>
      <button class="ctx-item" data-ctx="text-paste"><span class="ctx-item-left">${SVG_ICONS.paste}<span>텍스트 붙여넣기</span></span><span class="ctx-kbd">Ctrl+V</span></button>
      <div class="ctx-divider"></div>
    `;
  }

  if (selected.length > 0 && primary) {
    const allSameGroup =
      selected[0].groupId && selected.every((o) => o.groupId === selected[0].groupId);

    html += `
      <button class="ctx-item" data-ctx="obj-copy-content"><span class="ctx-item-left">${SVG_ICONS.copy}<span>이 객체의 내용 모두 복사</span></span></button>
      <button class="ctx-item" data-ctx="obj-copy"><span class="ctx-item-left">${SVG_ICONS.copy}<span>객체 복사 (${selected.length}개)</span></span><span class="ctx-kbd">Ctrl+C</span></button>
      <button class="ctx-item" data-ctx="obj-cut"><span class="ctx-item-left">${SVG_ICONS.cut}<span>객체 잘라내기</span></span><span class="ctx-kbd">Ctrl+X</span></button>
      <button class="ctx-item" data-ctx="obj-dup"><span class="ctx-item-left">${SVG_ICONS.plus}<span>객체 복제</span></span><span class="ctx-kbd">Ctrl+D</span></button>
      <div class="ctx-divider"></div>
      <div class="ctx-submenu-row">
        <button class="ctx-mini-btn" data-ctx="rot--45" title="-45도 회전">-45°</button>
        <button class="ctx-mini-btn" data-ctx="rot--15" title="-15도 회전">-15°</button>
        <button class="ctx-mini-btn" data-ctx="rot-0" title="회전 초기화">0°</button>
        <button class="ctx-mini-btn" data-ctx="rot-15" title="+15도 회전">+15°</button>
        <button class="ctx-mini-btn" data-ctx="rot-45" title="+45도 회전">+45°</button>
      </div>
    `;

    if (isPdfObject(primary)) {
      const curMode = primary.pdfViewMode || 'viewer';
      html += `
        <div class="ctx-divider"></div>
        <button class="ctx-item" data-ctx="pdf-toggle-view"><span class="ctx-item-left">${curMode === 'viewer' ? SVG_ICONS.fileIconMode : SVG_ICONS.bookOpen}<span>${curMode === 'viewer' ? 'PDF 아이콘으로 보기 전환' : 'PDF 내용 보기(뷰어) 전환'}</span></span></button>
        <button class="ctx-item" data-ctx="pdf-open-default"><span class="ctx-item-left">${SVG_ICONS.externalLink}<span>열기 (기본 PDF 프로그램)</span></span></button>
      `;
    }

    if (primary.type === 'label') {
      html += `
        <div class="ctx-divider"></div>
        <button class="ctx-item" data-ctx="label-toggle-vector"><span class="ctx-item-left">${SVG_ICONS.vectorize}<span>${primary.vectorized ? '일반 텍스트 편집 모드로 전환' : '텍스트 벡터 이미지화 (자유 크기 확대)'}</span></span></button>
        <div class="ctx-submenu-row" style="flex-wrap:wrap;gap:4px;">
          <button class="ctx-mini-btn" data-ctx="art-none" title="기본 깔끔한 텍스트">기본</button>
          <button class="ctx-mini-btn" data-ctx="art-game" title="게임 타이틀 (골드&크림슨)">⚔️게임</button>
          <button class="ctx-mini-btn" data-ctx="art-graffiti" title="스트릿 그래피티">🎨그래피티</button>
          <button class="ctx-mini-btn" data-ctx="art-neon" title="사이버 네온 사인">⚡네온</button>
          <button class="ctx-mini-btn" data-ctx="art-retro3d" title="레트로 3D 아케이드">🕹️3D</button>
          <button class="ctx-mini-btn" data-ctx="art-sticker" title="귀여운 팝 스티커">☁️스티커</button>
          <button class="ctx-mini-btn" data-ctx="art-gold" title="로얄 골드 엠블럼">👑골드</button>
          <button class="ctx-mini-btn" data-ctx="art-stamp" title="프로젝트 배지 스탬프">🔖배지</button>
        </div>
      `;
    }

    if (primary.type === 'text' || primary.type === 'sticky' || primary.type === 'table') {
      html += `
        <div class="ctx-divider"></div>
        <button class="ctx-item" data-ctx="insert-chk-square"><span class="ctx-item-left">${SVG_ICONS.chkSquare}<span>네모 V 체크박스 추가</span></span></button>
        <button class="ctx-item" data-ctx="insert-chk-circle"><span class="ctx-item-left">${SVG_ICONS.chkCircle}<span>원형 채움 체크박스 추가</span></span></button>
        <button class="ctx-item" data-ctx="insert-chk-toggle"><span class="ctx-item-left">${SVG_ICONS.chkToggle}<span>슬라이드 토글 버튼 추가</span></span></button>
      `;
    }

    html += `
      <div class="ctx-divider"></div>
      <button class="ctx-item" data-ctx="obj-group"><span class="ctx-item-left">${SVG_ICONS.group}<span>${allSameGroup ? '그룹 해제' : `선택 객체 그룹화 (${selected.length}개)`}</span></span><span class="ctx-kbd">Ctrl+G</span></button>
      <button class="ctx-item" data-ctx="obj-front"><span class="ctx-item-left">${SVG_ICONS.up}<span>맨 앞으로 가져오기</span></span></button>
      <button class="ctx-item" data-ctx="obj-lock"><span class="ctx-item-left">${SVG_ICONS.lock}<span>${primary.locked ? '잠금 해제' : '객체 위치 잠금'}</span></span></button>
      <div class="ctx-divider"></div>
      <button class="ctx-item" data-ctx="board-undo"><span class="ctx-item-left">${SVG_ICONS.undo}<span>실행 취소</span></span><span class="ctx-kbd">Ctrl+Z</span></button>
      <button class="ctx-item" data-ctx="board-redo"><span class="ctx-item-left">${SVG_ICONS.redo}<span>다시 실행</span></span><span class="ctx-kbd">Ctrl+Y</span></button>
      <div class="ctx-divider"></div>
      <button class="ctx-item danger" data-ctx="obj-delete"><span class="ctx-item-left">${SVG_ICONS.trash}<span>객체 삭제</span></span><span class="ctx-kbd">Del</span></button>
    `;
  } else {
    html += `
      <button class="ctx-item" data-ctx="board-undo"><span class="ctx-item-left">${SVG_ICONS.undo}<span>실행 취소 (방금 지운 객체·작업 복구)</span></span><span class="ctx-kbd">Ctrl+Z</span></button>
      <button class="ctx-item" data-ctx="board-redo"><span class="ctx-item-left">${SVG_ICONS.redo}<span>다시 실행</span></span><span class="ctx-kbd">Ctrl+Y</span></button>
      <div class="ctx-divider"></div>
      <button class="ctx-item" data-ctx="smart-paste"><span class="ctx-item-left">${SVG_ICONS.paste}<span>스마트 붙여넣기 (노트/표/이미지/링크/유튜브)</span></span><span class="ctx-kbd">Ctrl+V</span></button>
      ${copiedObjectsBuffer.length ? `<button class="ctx-item" data-ctx="paste-obj-buffer"><span class="ctx-item-left">${SVG_ICONS.copy}<span>복사한 객체 여기에 붙여넣기 (${copiedObjectsBuffer.length}개)</span></span></button>` : ''}
      <div class="ctx-divider"></div>
      <button class="ctx-item" data-ctx="new-label"><span class="ctx-item-left">${SVG_ICONS.sticky}<span>여기에 텍스트(배경없는 타이틀·그래픽) 생성</span></span></button>
      <button class="ctx-item" data-ctx="new-sticky"><span class="ctx-item-left">${SVG_ICONS.sticky}<span>여기에 포스트잇 생성</span></span></button>
      <button class="ctx-item" data-ctx="new-text"><span class="ctx-item-left">${SVG_ICONS.chkSquare}<span>여기에 체크리스트 생성</span></span></button>
      <button class="ctx-item" data-ctx="new-table"><span class="ctx-item-left">${SVG_ICONS.table}<span>여기에 스프레드시트 표 생성</span></span></button>
      <div class="ctx-divider"></div>
      <button class="ctx-item" data-ctx="fit-view"><span class="ctx-item-left">${SVG_ICONS.fit}<span>모든 객체 한눈에 맞춤</span></span></button>
      <button class="ctx-item" data-ctx="reset-win"><span class="ctx-item-left">${SVG_ICONS.resetWin}<span>메인 창 위치/크기 초기화</span></span></button>
    `;
  }

  contextMenu.innerHTML = html;
  contextMenu.classList.remove('hidden');

  const menuW = 245;
  const menuH = contextMenu.offsetHeight || 280;
  const left = Math.min(window.innerWidth - menuW - 10, e.clientX);
  const top = Math.min(window.innerHeight - menuH - 10, e.clientY);
  contextMenu.style.left = `${Math.max(8, left)}px`;
  contextMenu.style.top = `${Math.max(8, top)}px`;

  contextMenu.onclick = async (ev) => {
    const btn = ev.target.closest('[data-ctx]');
    if (!btn) return;
    const act = btn.dataset.ctx;
    hideContextMenu();

    if (act === 'board-undo') {
      undoBoardAction();
    } else if (act === 'board-redo') {
      redoBoardAction();
    } else if (act === 'text-copy') {
      document.execCommand('copy');
    } else if (act === 'text-cut') {
      document.execCommand('cut');
    } else if (act === 'text-paste') {
      const clip = await window.freeformAPI.readClipboardSmart();
      if (clip && clip.text) document.execCommand('insertText', false, clip.text);
    } else if (act === 'obj-copy-content') {
      if (primary) copyEntireObjectContent(primary);
    } else if (act === 'obj-copy') {
      copySelectedObjectsToBuffer(false);
    } else if (act === 'obj-cut') {
      copySelectedObjectsToBuffer(true);
    } else if (act === 'obj-dup') {
      duplicateSelectedObjects();
    } else if (act === 'pdf-toggle-view') {
      if (primary) togglePdfObjectViewMode(primary);
    } else if (act === 'pdf-open-default') {
      if (primary && primary.resolvedFilePath) {
        await window.freeformAPI.openPath(primary.resolvedFilePath);
        showToast('기본 PDF 프로그램으로 문서를 열었습니다');
      }
    } else if (act === 'label-toggle-vector') {
      if (primary && primary.type === 'label') {
        toggleLabelVectorized(primary);
      }
    } else if (act.startsWith('art-')) {
      const styleId = act.replace('art-', '');
      const selected = getSelectedObjects().filter((o) => o.type === 'label');
      if (selected.length > 0) {
        pushUndoSnapshot('텍스트 그래픽 스타일 변경');
        selected.forEach((o) => (o.artStyle = styleId));
        renderAllObjects();
        syncSelectionUI();
        scheduleSaveBoard();
        const found = ART_STYLE_LIST.find((a) => a.id === styleId);
        showToast(`✨ 텍스트 그래픽 스타일: ${found ? found.label : styleId}`);
      }
    } else if (act.startsWith('rot-')) {
      const deg = Number(act.replace('rot-', ''));
      if (deg === 0) rotateSelectedObjects(0, 0);
      else rotateSelectedObjects(deg);
    } else if (act.startsWith('insert-chk-')) {
      const style = act.replace('insert-chk-', '');
      if (primary && (primary.type === 'text' || primary.type === 'sticky')) {
        appendCheckItemToNote(primary, style, '');
      } else if (primary && primary.type === 'table') {
        pushUndoSnapshot('표 체크박스 추가');
        const r = lastFocusedTableCell && lastFocusedTableCell.obj.id === primary.id ? lastFocusedTableCell.rIdx : 1;
        const c = lastFocusedTableCell && lastFocusedTableCell.obj.id === primary.id ? lastFocusedTableCell.cIdx : 0;
        if (primary.tableData[r]) {
          const clean = String(primary.tableData[r][c] ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '');
          primary.tableData[r][c] = `[${style}:0] ${clean}`;
          renderAllObjects();
          scheduleSaveBoard();
        }
      }
    } else if (act === 'obj-group') {
      toggleGroupSelectedObjects();
    } else if (act === 'obj-front') {
      pushUndoSnapshot('맨 앞으로 가져오기');
      getSelectedObjects().forEach((o) => (o.zIndex = getNextZIndex()));
      renderAllObjects();
      scheduleSaveBoard();
    } else if (act === 'obj-lock') {
      const nextLock = !primary.locked;
      getSelectedObjects().forEach((o) => (o.locked = nextLock));
      syncSelectionUI();
      scheduleSaveBoard();
    } else if (act === 'obj-delete') {
      deleteSelectedObjects();
    } else if (act === 'smart-paste') {
      handleSmartPaste(worldPos, false);
    } else if (act === 'paste-obj-buffer') {
      pasteCopiedObjectsFromBuffer(worldPos);
    } else if (act === 'new-label') {
      const created = addObjectToBoard({
        type: 'label',
        title: '텍스트',
        content: '프로젝트 타이틀',
        x: worldPos.x - 190,
        y: worldPos.y - 60,
        width: 380,
        height: 120,
        color: 'light',
        artStyle: 'none',
        textStyle: { fontFamily: 'default', fontSize: 32, bold: true, italic: false, underline: false }
      });
      if (created) {
        const el = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-label-editor`);
        el?.focus();
      }
    } else if (act === 'new-sticky') {
      addObjectToBoard({ type: 'sticky', title: '📌 포스트잇 메모', x: worldPos.x - 140, y: worldPos.y - 110, width: 280, height: 220, color: 'yellow' });
    } else if (act === 'new-text') {
      const created = addObjectToBoard({ type: 'text', title: '체크리스트 & 노트', content: '[square:0] ', x: worldPos.x - 175, y: worldPos.y - 110, width: 360, height: 240, color: 'dark' });
      if (created) {
        const el = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-check-input`);
        el?.focus();
      }
    } else if (act === 'new-table') {
      const created = addObjectToBoard({
        type: 'table',
        title: '데이터 표',
        x: worldPos.x - 230,
        y: worldPos.y - 125,
        width: 460,
        height: 250,
        color: 'blue',
        tableData: [
          ['', '', '', ''],
          ['', '', '', ''],
          ['', '', '', '']
        ]
      });
      if (created) {
        const firstTd = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-table td`);
        firstTd?.focus();
      }
    } else if (act === 'fit-view') {
      document.getElementById('fitViewBtn')?.click();
    } else if (act === 'reset-win') {
      await window.freeformAPI.resetWindowBounds();
      showToast('창 크기 및 위치가 화면 중앙으로 초기화되었습니다');
    }
  };
});

window.addEventListener('click', () => hideContextMenu());

// ============================================================================
// Toolbar & Inspector Button Wiring
// ============================================================================
document.getElementById('winCloseBtn')?.addEventListener('click', () => window.freeformAPI.closeWindow());
document.getElementById('winMinBtn')?.addEventListener('click', () => window.freeformAPI.minimizeWindow());
document.getElementById('winMaxBtn')?.addEventListener('click', () => window.freeformAPI.maximizeWindow());

document.getElementById('undoBoardBtn')?.addEventListener('click', () => undoBoardAction());
document.getElementById('redoBoardBtn')?.addEventListener('click', () => redoBoardAction());

const resetWinHandler = async () => {
  await window.freeformAPI.resetWindowBounds();
  showToast('창 크기 및 위치가 기본값(화면 중앙)으로 초기화되었습니다');
};
document.getElementById('resetWindowPosBtn')?.addEventListener('click', resetWinHandler);
document.getElementById('modalResetWindowBoundsBtn')?.addEventListener('click', resetWinHandler);

document.getElementById('toggleSidebarBtn')?.addEventListener('click', () => {
  document.getElementById('boardsSidebar')?.classList.toggle('collapsed');
});

activeBoardTitleInput?.addEventListener('input', () => {
  if (!currentBoard) return;
  currentBoard.title = activeBoardTitleInput.value;
  scheduleSaveBoard();
});

document.getElementById('createNewBoardBtn')?.addEventListener('click', async () => {
  const created = await window.freeformAPI.createBoard({ title: '새 프리폼 보드', icon: '' });
  await loadBoardById(created.id);
  showToast('새 프리폼 보드가 생성되었습니다');
});

document.getElementById('boardSearchInput')?.addEventListener('input', renderSidebarBoards);

// Object Creation Buttons
document.getElementById('addStickyBtn')?.addEventListener('click', () => {
  const created = addObjectToBoard({
    type: 'sticky',
    title: '📌 포스트잇 메모',
    content: '',
    width: 280,
    height: 220,
    color: 'yellow'
  });
  if (created) {
    const el = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-sticky-textarea`);
    el?.focus();
  }
});

document.getElementById('addLabelBtn')?.addEventListener('click', () => {
  const created = addObjectToBoard({
    type: 'label',
    title: '텍스트',
    content: '',
    width: 380,
    height: 125,
    color: 'light',
    artStyle: 'none',
    textStyle: { fontFamily: 'default', fontSize: 32, bold: true, italic: false, underline: false }
  });
  if (created) {
    const el = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-label-editor`);
    el?.focus();
  }
});

document.getElementById('addTextBtn')?.addEventListener('click', () => {
  const created = addObjectToBoard({
    type: 'text',
    title: '체크리스트 & 노트',
    content: '[square:0] ',
    width: 360,
    height: 240,
    color: 'dark'
  });
  if (created) {
    const el = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-check-input`);
    el?.focus();
  }
});

document.getElementById('addTableBtn')?.addEventListener('click', () => {
  const created = addObjectToBoard({
    type: 'table',
    title: '데이터 표',
    width: 480,
    height: 260,
    color: 'blue',
    tableData: [
      ['', '', '', ''],
      ['', '', '', ''],
      ['', '', '', '']
    ]
  });
  if (created) {
    const firstTd = objectLayer.querySelector(`.ff-object[data-id="${created.id}"] .ff-table td`);
    firstTd?.focus();
  }
});

document.getElementById('addImageBtn')?.addEventListener('click', async () => {
  const assets = await window.freeformAPI.pickFiles({ imagesOnly: true });
  assets.forEach((a) => {
    addObjectToBoard({
      type: 'image',
      title: a.name,
      width: 360,
      height: 270,
      color: 'dark',
      assetFileName: a.assetFileName,
      resolvedFilePath: a.resolvedFilePath,
      resolvedFileUrl: a.resolvedFileUrl
    });
  });
});

document.getElementById('captureScreenBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.captureScreenToAsset();
  if (res && res.asset) {
    addObjectToBoard({
      type: 'image',
      title: res.asset.name,
      width: 440,
      height: 290,
      color: 'dark',
      assetFileName: res.asset.assetFileName,
      resolvedFilePath: res.asset.resolvedFilePath,
      resolvedFileUrl: res.asset.resolvedFileUrl
    });
    showToast('현재 화면이 캡처되어 보드에 추가되었습니다');
  }
});

document.getElementById('addFileBtn')?.addEventListener('click', async () => {
  const assets = await window.freeformAPI.pickFiles({ imagesOnly: false });
  assets.forEach((a) => {
    const isPdf = /\.pdf$/i.test(a.name || a.resolvedFilePath || '');
    addObjectToBoard({
      type: 'file',
      title: a.name,
      fileName: a.name,
      fileSize: a.size,
      pdfViewMode: isPdf ? 'viewer' : undefined,
      width: isPdf ? 480 : 330,
      height: isPdf ? 580 : 135,
      color: 'dark',
      assetFileName: a.assetFileName,
      resolvedFilePath: a.resolvedFilePath,
      resolvedFileUrl: a.resolvedFileUrl
    });
  });
});

// Link Modal
const linkModal = document.getElementById('linkModal');
const linkUrlInput = document.getElementById('linkUrlInput');
const linkTitleInput = document.getElementById('linkTitleInput');

document.getElementById('addLinkBtn')?.addEventListener('click', () => {
  linkModal?.classList.remove('hidden');
  setTimeout(() => linkUrlInput?.focus(), 30);
});
document.getElementById('closeLinkModalBtn')?.addEventListener('click', () => linkModal?.classList.add('hidden'));
document.getElementById('cancelLinkModalBtn')?.addEventListener('click', () => linkModal?.classList.add('hidden'));

async function submitLinkModal() {
  const rawUrl = linkUrlInput?.value.trim();
  const customTitle = linkTitleInput?.value.trim();
  if (!rawUrl) {
    showToast('추가할 URL 주소를 입력해 주세요');
    linkUrlInput?.focus();
    return;
  }
  linkModal?.classList.add('hidden');
  if (linkUrlInput) linkUrlInput.value = '';
  if (linkTitleInput) linkTitleInput.value = '';

  showToast('웹페이지 및 동영상 정보 불러오는 중...');
  let meta = null;
  try {
    meta = await window.freeformAPI.fetchUrlMetadata(rawUrl);
  } catch (err) {
    console.warn('fetchUrlMetadata error:', err);
  }
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const isVideo = Boolean(meta?.youtubeId || meta?.isVideo);
  addObjectToBoard({
    type: 'link',
    title: customTitle || meta?.title || normalizedUrl,
    url: meta?.url || normalizedUrl,
    domain: meta?.domain || '',
    description: meta?.description || '',
    favicon: meta?.favicon || '',
    thumbnail: meta?.thumbnail || '',
    youtubeId: meta?.youtubeId || null,
    width: isVideo ? 420 : 390,
    height: isVideo ? 290 : (meta?.thumbnail ? 275 : 175),
    color: 'dark'
  });
  showToast(isVideo ? '유튜브/동영상 카드가 추가되었습니다' : '웹 링크 북마크 카드가 추가되었습니다');
}

document.getElementById('confirmLinkModalBtn')?.addEventListener('click', submitLinkModal);
linkUrlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLinkModal();
  }
});
linkTitleInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLinkModal();
  }
});

// Tool Mode Switching (Select vs Smart Pen)
function setToolMode(mode) {
  activeTool = mode;
  document.getElementById('toolSelectBtn')?.classList.toggle('active', mode === 'select');
  document.getElementById('toolPenBtn')?.classList.toggle('active', mode === 'pen');
  canvasViewport?.classList.toggle('pen-mode', mode === 'pen');
  penToolbar?.classList.toggle('hidden', mode !== 'pen');
  if (mode === 'pen') clearSelection();
}
document.getElementById('toolSelectBtn')?.addEventListener('click', () => setToolMode('select'));
document.getElementById('toolPenBtn')?.addEventListener('click', () => setToolMode(activeTool === 'pen' ? 'select' : 'pen'));
document.getElementById('exitPenModeBtn')?.addEventListener('click', () => setToolMode('select'));

const toggleAutoShapeBtn = document.getElementById('toggleAutoShapeBtn');
toggleAutoShapeBtn?.addEventListener('click', () => {
  autoShapeEnabled = !autoShapeEnabled;
  toggleAutoShapeBtn.classList.toggle('active-pill', autoShapeEnabled);
  const lbl = document.getElementById('toggleAutoShapeLabel');
  if (lbl) lbl.textContent = autoShapeEnabled ? '도형·화살표 자동완성 ON' : '도형·화살표 자동완성 OFF';
});

const toggleArrowPenBtn = document.getElementById('toggleArrowPenBtn');
toggleArrowPenBtn?.addEventListener('click', () => {
  arrowPenMode = !arrowPenMode;
  toggleArrowPenBtn.classList.toggle('active-pill', arrowPenMode);
  const lbl = document.getElementById('toggleArrowPenLabel');
  if (lbl) lbl.textContent = arrowPenMode ? '화살표 모드 ON' : '화살표 모드 OFF';
});

document.getElementById('undoStrokeBtn')?.addEventListener('click', () => {
  undoBoardAction();
});

document.getElementById('clearStrokesBtn')?.addEventListener('click', () => {
  if (!currentBoard) return;
  const hasStrokeObjects = (currentBoard.objects || []).some((o) => o.type === 'stroke');
  const hasRawStrokes = (currentBoard.strokes || []).length > 0;
  if (!hasStrokeObjects && !hasRawStrokes) {
    showToast('지울 펜 판서 객체가 없습니다');
    return;
  }
  pushUndoSnapshot('펜 판서 전체 지우기');
  const strokeIds = new Set(
    (currentBoard.objects || []).filter((o) => o.type === 'stroke').map((o) => o.id)
  );
  currentBoard.objects = (currentBoard.objects || []).filter((o) => o.type !== 'stroke');
  currentBoard.connectors = (currentBoard.connectors || []).filter(
    (c) => !strokeIds.has(c.fromId) && !strokeIds.has(c.toId)
  );
  currentBoard.strokes = [];
  clearSelection();
  renderAllObjects();
  renderAllConnectors();
  renderAllStrokes();
  scheduleSaveBoard();
  showToast('펜으로 그린 모든 선·도형이 삭제되었습니다 (Ctrl+Z로 복구 가능)');
});

// ============================================================================
// Persistent Swatch Color Picker (Right-Click on Object & Pen Swatches)
// ============================================================================
const swatchColorPickerInput = document.getElementById('swatchColorPickerInput');
let activeColorPickerTarget = null; // { kind: 'object' | 'pen', slot: number, btn: HTMLElement }

function applyCustomSwatchesToDOM() {
  document.querySelectorAll('#inspectorColors .swatch').forEach((sw, idx) => {
    const slot = Number(sw.dataset.slot ?? idx);
    const hex = customObjectSwatches[slot] || DEFAULT_OBJECT_SWATCHES[slot] || '#0a84ff';
    sw.dataset.hex = hex;
    sw.style.background = hex;
  });

  document.querySelectorAll('#penToolbar .pen-color').forEach((btn, idx) => {
    const slot = Number(btn.dataset.penSlot ?? idx);
    const hex = customPenSwatches[slot] || DEFAULT_PEN_SWATCHES[slot] || '#0a84ff';
    btn.dataset.stroke = hex;
    btn.style.background = hex;
    if (btn.classList.contains('active')) {
      currentPenColor = hex;
    }
  });
}

async function persistCustomSwatches() {
  try {
    await window.freeformAPI.saveConfig({
      customObjectSwatches,
      customPenSwatches
    });
  } catch (err) {
    console.warn('persistCustomSwatches error:', err);
  }
}

function openSwatchColorPicker(kind, slot, btn, clientX, clientY) {
  if (!swatchColorPickerInput) return;
  hideContextMenu();
  activeColorPickerTarget = { kind, slot, btn };
  const currentHex =
    kind === 'object'
      ? customObjectSwatches[slot] || DEFAULT_OBJECT_SWATCHES[slot] || '#0a84ff'
      : customPenSwatches[slot] || DEFAULT_PEN_SWATCHES[slot] || '#0a84ff';

  swatchColorPickerInput.value = /^#[0-9a-fA-F]{6}$/.test(currentHex) ? currentHex : '#0a84ff';
  swatchColorPickerInput.style.left = `${Math.min(window.innerWidth - 40, Math.max(10, clientX))}px`;
  swatchColorPickerInput.style.top = `${Math.min(window.innerHeight - 40, Math.max(10, clientY))}px`;
  setTimeout(() => {
    swatchColorPickerInput.focus();
    swatchColorPickerInput.click();
  }, 10);
}

function applyPickedColorToTarget(hex, recordUndo = false) {
  if (!activeColorPickerTarget || !hex) return;
  const { kind, slot, btn } = activeColorPickerTarget;

  if (kind === 'object') {
    customObjectSwatches[slot] = hex;
    btn.dataset.hex = hex;
    btn.style.background = hex;

    const selectedConn = getSelectedConnector();
    const selectedObjs = getSelectedObjects();
    if (selectedConn) {
      if (recordUndo) pushUndoSnapshot('화살표 색상 변경');
      selectedConn.color = hex;
      renderAllConnectors();
      syncSelectionUI();
      scheduleSaveBoard();
    } else if (selectedObjs.length > 0) {
      if (recordUndo) pushUndoSnapshot('객체 커스텀 색상 변경');
      const presetName = btn.dataset.color || 'dark';
      const defaultHex = (DEFAULT_OBJECT_SWATCHES[slot] || '').toLowerCase();
      selectedObjs.forEach((o) => {
        o.color = presetName;
        o.customColor = hex.toLowerCase() !== defaultHex ? hex : null;
      });
      renderAllObjects();
      syncSelectionUI();
      scheduleSaveBoard();
    }
  } else if (kind === 'pen') {
    customPenSwatches[slot] = hex;
    btn.dataset.stroke = hex;
    btn.style.background = hex;
    document.querySelectorAll('.pen-color').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentPenColor = hex;
  }
}

swatchColorPickerInput?.addEventListener('input', (e) => {
  applyPickedColorToTarget(e.target.value, false);
});

swatchColorPickerInput?.addEventListener('change', async (e) => {
  applyPickedColorToTarget(e.target.value, true);
  await persistCustomSwatches();
  showToast(`🎨 선택한 슬롯의 색상이 ${e.target.value.toUpperCase()}로 저장되었습니다`);
});

document.querySelectorAll('.pen-color').forEach((btn, idx) => {
  const slot = Number(btn.dataset.penSlot ?? idx);
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pen-color').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentPenColor = btn.dataset.stroke || '#0a84ff';
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSwatchColorPicker('pen', slot, btn, e.clientX, e.clientY);
  });
});

// Inspector Actions (Supports Both Objects AND Connector Arrows!)
document.querySelectorAll('#inspectorColors .swatch').forEach((sw, idx) => {
  const slot = Number(sw.dataset.slot ?? idx);
  sw.addEventListener('click', () => {
    const selectedConn = getSelectedConnector();
    const slotHex = sw.dataset.hex || customObjectSwatches[slot] || DEFAULT_OBJECT_SWATCHES[slot] || '#0a84ff';

    if (selectedConn) {
      pushUndoSnapshot('화살표 색상 변경');
      selectedConn.color = slotHex;
      renderAllConnectors();
      syncSelectionUI();
      scheduleSaveBoard();
      return;
    }

    const selected = getSelectedObjects();
    if (!selected.length) return;
    pushUndoSnapshot('객체 색상 변경');
    const presetName = sw.dataset.color || 'dark';
    const defaultHex = (DEFAULT_OBJECT_SWATCHES[slot] || '').toLowerCase();
    const isCustomized = slotHex.toLowerCase() !== defaultHex;
    selected.forEach((o) => {
      o.color = presetName;
      o.customColor = isCustomized ? slotHex : null;
    });
    renderAllObjects();
    syncSelectionUI();
    scheduleSaveBoard();
  });

  sw.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSwatchColorPicker('object', slot, sw, e.clientX, e.clientY);
  });
});

// Connector Line Style Toggle (Solid <-> Dashed)
document.getElementById('inspConnStyleBtn')?.addEventListener('click', () => {
  const conn = getSelectedConnector();
  if (!conn) return;
  pushUndoSnapshot('화살표 선 스타일 변경');
  conn.style = conn.style === 'dashed' ? 'solid' : 'dashed';
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
});

// Typography Controls (Font Family, Font Size, Bold, Italic, Underline)
function updateSelectedObjectsTextStyle(mutator, actionLabel = '텍스트 서식 변경') {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot(actionLabel);
  selected.forEach((obj) => {
    const cur = getObjectTextStyle(obj);
    const next = mutator({ ...cur }, obj);
    obj.textStyle = next;
    const domEl = objectLayer.querySelector(`.ff-object[data-id="${obj.id}"]`);
    if (domEl) applyObjectTypography(domEl, obj);
  });
  syncSelectionUI();
  scheduleSaveBoard();
}

document.getElementById('inspFontFamilySelect')?.addEventListener('change', (e) => {
  const fontFamily = e.target.value || 'system';
  updateSelectedObjectsTextStyle((st) => ({ ...st, fontFamily }), '폰트 변경');
});

document.getElementById('inspFontSizeSelect')?.addEventListener('change', (e) => {
  const fontSize = Number(e.target.value) || 14;
  updateSelectedObjectsTextStyle((st) => ({ ...st, fontSize }), '폰트 크기 변경');
});

document.getElementById('inspArtStyleSelect')?.addEventListener('change', (e) => {
  const styleId = e.target.value || 'none';
  const selected = getSelectedObjects().filter((o) => o.type === 'label');
  if (!selected.length) return;
  pushUndoSnapshot('텍스트 그래픽 스타일 변경');
  selected.forEach((o) => {
    o.artStyle = styleId;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
  const found = ART_STYLE_LIST.find((a) => a.id === styleId);
  showToast(`✨ 텍스트 그래픽 스타일: ${found ? found.label : styleId}`);
});

document.getElementById('inspVectorizeBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects().filter((o) => o.type === 'label');
  if (!selected.length) return;
  if (selected.length === 1) {
    toggleLabelVectorized(selected[0]);
    return;
  }
  const nextVec = !Boolean(selected[0].vectorized);
  pushUndoSnapshot(nextVec ? '텍스트 벡터 이미지화' : '벡터 이미지 해제');
  selected.forEach((o) => {
    o.vectorized = nextVec;
    if (nextVec) {
      if (!(o.content || '').trim()) {
        o.content = (o.title && o.title !== '텍스트') ? o.title : '프로젝트 타이틀';
      }
      const m = computeVectorLabelMetrics(o);
      o.vectorAspect = m.aspect;
      const baseW = Math.max(200, Math.round(o.width || 380));
      o.width = baseW;
      o.height = Math.max(48, Math.round(baseW / Math.max(0.2, m.aspect)));
    }
  });
  renderAllObjects();
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(
    nextVec
      ? '✨ 선택된 텍스트 객체가 벡터 이미지로 변환되었습니다!'
      : '📝 일반 텍스트 편집 모드로 전환되었습니다'
  );
});

// Stroke Object Inspector Controls (Thickness, Dashed Line, Arrowhead)
document.getElementById('inspStrokeWidthSelect')?.addEventListener('change', (e) => {
  const nextWidth = Number(e.target.value) || 3.5;
  const selected = getSelectedObjects().filter((o) => o.type === 'stroke');
  if (!selected.length) return;
  pushUndoSnapshot('펜 드로잉 굵기 변경');
  selected.forEach((o) => {
    if (!o.strokeData) o.strokeData = {};
    o.strokeData.strokeWidth = nextWidth;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
});

document.getElementById('inspStrokeDashBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects().filter((o) => o.type === 'stroke');
  if (!selected.length) return;
  pushUndoSnapshot('펜 드로잉 점선/실선 변경');
  const nextDashed = !Boolean(selected[0].strokeData?.dashed);
  selected.forEach((o) => {
    if (!o.strokeData) o.strokeData = {};
    o.strokeData.dashed = nextDashed;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
});

document.getElementById('inspStrokeArrowBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects().filter((o) => o.type === 'stroke');
  if (!selected.length) return;
  pushUndoSnapshot('펜 드로잉 화살표 토글');
  const nextArrow = !Boolean(selected[0].strokeData?.hasArrow);
  selected.forEach((o) => {
    if (!o.strokeData) o.strokeData = {};
    o.strokeData.hasArrow = nextArrow;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
});

function toggleSelectedObjectsBold() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getObjectTextStyle(selected[0]).bold;
  updateSelectedObjectsTextStyle((st) => ({ ...st, bold: nextVal }), '굵게 서식 변경');
}

function toggleSelectedObjectsItalic() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getObjectTextStyle(selected[0]).italic;
  updateSelectedObjectsTextStyle((st) => ({ ...st, italic: nextVal }), '기울임 서식 변경');
}

function toggleSelectedObjectsUnderline() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getObjectTextStyle(selected[0]).underline;
  updateSelectedObjectsTextStyle((st) => ({ ...st, underline: nextVal }), '밑줄 서식 변경');
}

['inspBoldBtn', 'inspItalicBtn', 'inspUnderlineBtn', 'inspAlignLeftBtn', 'inspAlignCenterBtn', 'inspAlignRightBtn'].forEach(
  (btnId) => {
    document.getElementById(btnId)?.addEventListener('mousedown', (e) => {
      // Prevent toolbar button click from stealing focus/selection from the active line, row, cell, or title!
      e.preventDefault();
    });
  }
);

document.getElementById('inspBoldBtn')?.addEventListener('click', toggleSelectedObjectsBold);
document.getElementById('inspItalicBtn')?.addEventListener('click', toggleSelectedObjectsItalic);
document.getElementById('inspUnderlineBtn')?.addEventListener('click', toggleSelectedObjectsUnderline);

function setSelectedObjectsTextAlign(align) {
  if (!['left', 'center', 'right'].includes(align)) return;
  const labelMap = { left: '좌측 정렬', center: '중앙 정렬', right: '우측 정렬' };

  // 1. If a specific title / line / checklist row / table cell is focused inside a selected object, align ONLY that target!
  if (lastActiveAlignTarget && lastActiveAlignTarget.obj && selectedObjectIds.has(lastActiveAlignTarget.obj.id)) {
    const t = lastActiveAlignTarget;

    if (t.kind === 'title' && t.el?.isConnected) {
      pushUndoSnapshot(`제목 ${labelMap[align]}`);
      t.obj.titleAlign = align;
      t.el.style.textAlign = align;
      syncAlignButtonsUI(align);
      scheduleSaveBoard();
      return;
    }

    if (t.kind === 'check-row' && t.rowEl?.isConnected) {
      pushUndoSnapshot(`체크 항목 ${labelMap[align]}`);
      t.rowEl.dataset.align = align;
      if (t.inputEl) t.inputEl.style.textAlign = align;
      t.syncFn?.();
      syncAlignButtonsUI(align);
      return;
    }

    if (t.kind === 'table-cell' && t.tdEl?.isConnected) {
      pushUndoSnapshot(`표 셀 ${labelMap[align]}`);
      if (!t.obj.cellAligns) t.obj.cellAligns = {};
      t.obj.cellAligns[`${t.rIdx}_${t.cIdx}`] = align;
      t.tdEl.style.textAlign = align;
      const spanEl = t.tdEl.querySelector('span[contenteditable="true"]');
      if (spanEl) spanEl.style.textAlign = align;
      syncAlignButtonsUI(align);
      scheduleSaveBoard();
      return;
    }

    if (t.kind === 'line-editor' && t.editorEl?.isConnected) {
      pushUndoSnapshot(`줄 ${labelMap[align]}`);
      const targetLines = t.getTargetLines?.() || [];
      targetLines.forEach((ln) => {
        ln.dataset.align = align;
        ln.style.textAlign = align;
      });
      t.syncFn?.();
      syncAlignButtonsUI(align);
      return;
    }
  }

  // 2. Fallback: When an object is selected on canvas without a specific line focused, align body lines (never the title!)
  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot(`텍스트 ${labelMap[align]}`);
  selected.forEach((obj) => {
    const domEl = objectLayer.querySelector(`.ff-object[data-id="${obj.id}"]`);
    if (!domEl) return;
    if (obj.type === 'label' && obj.vectorized) {
      const rawLines = getLabelDisplayLines(obj);
      obj.lineAligns = rawLines.map(() => align);
      const wrapEl = domEl.querySelector('.ff-label-wrap');
      if (wrapEl) renderVectorizedLabelIntoWrap(wrapEl, obj);
    } else if (obj.type === 'sticky' || obj.type === 'label') {
      const lines = Array.from(domEl.querySelectorAll('.ff-text-line'));
      lines.forEach((ln) => {
        ln.dataset.align = align;
        ln.style.textAlign = align;
      });
      obj.lineAligns = lines.map(() => align);
    } else if (obj.type === 'text') {
      domEl.querySelectorAll('.ff-check-row').forEach((row) => {
        row.dataset.align = align;
        const inp = row.querySelector('.ff-check-input');
        if (inp) inp.style.textAlign = align;
      });
      const memoLines = Array.from(domEl.querySelectorAll('.ff-note-memo-area .ff-text-line'));
      memoLines.forEach((ln) => {
        ln.dataset.align = align;
        ln.style.textAlign = align;
      });
      obj.memoLineAligns = memoLines.map(() => align);
      const parsed = parseNoteLines(obj.content || '');
      parsed.forEach((item) => {
        if (item.isCheck) item.align = align;
      });
      obj.content = serializeNoteLines(parsed);
    } else if (obj.type === 'table') {
      if (!obj.cellAligns) obj.cellAligns = {};
      domEl.querySelectorAll('.ff-table tr').forEach((tr, rIdx) => {
        tr.querySelectorAll('td').forEach((td, cIdx) => {
          obj.cellAligns[`${rIdx}_${cIdx}`] = align;
          td.style.textAlign = align;
          const sp = td.querySelector('span[contenteditable="true"]');
          if (sp) sp.style.textAlign = align;
        });
      });
    }
  });
  syncAlignButtonsUI(align);
  scheduleSaveBoard();
}

document.getElementById('inspAlignLeftBtn')?.addEventListener('click', () => setSelectedObjectsTextAlign('left'));
document.getElementById('inspAlignCenterBtn')?.addEventListener('click', () => setSelectedObjectsTextAlign('center'));
document.getElementById('inspAlignRightBtn')?.addEventListener('click', () => setSelectedObjectsTextAlign('right'));

document.getElementById('inspRotLeftBtn')?.addEventListener('click', () => rotateSelectedObjects(-15));
document.getElementById('inspRotResetBtn')?.addEventListener('click', () => rotateSelectedObjects(0, 0));
document.getElementById('inspRotRightBtn')?.addEventListener('click', () => rotateSelectedObjects(15));
document.getElementById('inspGroupBtn')?.addEventListener('click', () => toggleGroupSelectedObjects());

document.getElementById('inspBringFrontBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot('맨 앞으로 가져오기');
  selected.forEach((o) => (o.zIndex = getNextZIndex()));
  renderAllObjects();
  scheduleSaveBoard();
});

function duplicateSelectedObjects() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const prevBuffer = copiedObjectsBuffer;
  copiedObjectsBuffer = JSON.parse(JSON.stringify(selected));
  pasteCopiedObjectsFromBuffer();
  copiedObjectsBuffer = prevBuffer;
}
document.getElementById('inspDuplicateBtn')?.addEventListener('click', duplicateSelectedObjects);

document.getElementById('inspCopyTextBtn')?.addEventListener('click', () => {
  copySelectedObjectsToBuffer(false);
});

document.getElementById('inspLockBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextLock = !selected.some((o) => o.locked);
  selected.forEach((o) => (o.locked = nextLock));
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(nextLock ? '선택 객체 위치가 잠겼습니다' : '선택 객체 잠금이 해제되었습니다');
});

function deleteSelectedObjects() {
  if (selectedConnectorId && currentBoard) {
    pushUndoSnapshot('연결선 삭제');
    currentBoard.connectors = currentBoard.connectors.filter((c) => c.id !== selectedConnectorId);
    selectedConnectorId = null;
    renderAllConnectors();
    syncSelectionUI();
    scheduleSaveBoard();
    showToast('연결선이 삭제되었습니다 (Ctrl+Z로 복구 가능)');
    return;
  }

  const selected = getSelectedObjects();
  if (!selected.length || !currentBoard) return;
  const count = selected.length;
  const titleHint = selected[0]?.title ? `'${selected[0].title}'` : '객체';
  pushUndoSnapshot(count > 1 ? `객체 ${count}개 삭제` : `${titleHint} 삭제`);

  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  const delIds = new Set(selected.map((o) => o.id));
  currentBoard.objects = currentBoard.objects.filter((o) => !delIds.has(o.id));
  currentBoard.connectors = currentBoard.connectors.filter((c) => !delIds.has(c.fromId) && !delIds.has(c.toId));
  clearSelection();
  renderAllObjects();
  renderAllConnectors();
  scheduleSaveBoard();
  showToast(`${count}개 객체가 삭제되었습니다 (Ctrl+Z로 즉시 복구 가능)`);
}
document.getElementById('inspDeleteBtn')?.addEventListener('click', deleteSelectedObjects);

// Paste Button & Keyboard Shortcuts
document.getElementById('pasteClipboardBtn')?.addEventListener('click', () => handleSmartPaste());

window.addEventListener('keydown', (e) => {
  const isEditingText = Boolean(
    e.target.closest('input, textarea, [contenteditable="true"]') ||
      (document.activeElement && document.activeElement.closest('input, textarea, [contenteditable="true"]'))
  );

  // Typography shortcuts (Ctrl+B, Ctrl+I, Ctrl+U) work whether editing inside an object or having an object selected!
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && selectedObjectIds.size > 0) {
    const k = e.key.toLowerCase();
    if (k === 'b') {
      e.preventDefault();
      toggleSelectedObjectsBold();
      return;
    }
    if (k === 'i') {
      e.preventDefault();
      toggleSelectedObjectsItalic();
      return;
    }
    if (k === 'u') {
      e.preventDefault();
      toggleSelectedObjectsUnderline();
      return;
    }
  }

  // Board-level Undo (Ctrl+Z) & Redo (Ctrl+Y or Ctrl+Shift+Z)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !isEditingText) {
    e.preventDefault();
    undoBoardAction();
    return;
  }
  if (
    (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) &&
    !isEditingText
  ) {
    e.preventDefault();
    redoBoardAction();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !isEditingText) {
    e.preventDefault();
    handleSmartPaste();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !isEditingText && selectedObjectIds.size > 0) {
    e.preventDefault();
    copySelectedObjectsToBuffer(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && !isEditingText && selectedObjectIds.size > 0) {
    e.preventDefault();
    copySelectedObjectsToBuffer(true);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && !isEditingText) {
    e.preventDefault();
    duplicateSelectedObjects();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && !isEditingText) {
    e.preventDefault();
    toggleGroupSelectedObjects();
  } else if (e.key === 'Delete' && !isEditingText && selectedConnectorId && currentBoard) {
    e.preventDefault();
    deleteSelectedObjects();
  } else if (e.key === 'Delete' && !isEditingText && selectedObjectIds.size > 0) {
    // Only Delete key deletes objects on canvas! Backspace is strictly for text editing so memos are never accidentally deleted.
    e.preventDefault();
    deleteSelectedObjects();
  } else if (e.key === 'Escape') {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    hideContextMenu();
    document.getElementById('linkModal')?.classList.add('hidden');
    document.getElementById('syncModal')?.classList.add('hidden');
    document.getElementById('lightboxModal')?.classList.add('hidden');
    if (activeTool === 'pen' && selectedObjectIds.size === 0 && !selectedConnectorId) {
      setToolMode('select');
    }
    selectedConnectorId = null;
    clearSelection();
    renderAllConnectors();
    return;
  }

  // Top Toolbar Single-Key Shortcuts (Strictly active ONLY when NO object/connector is selected and NOT editing text)
  const isModalOpen =
    !document.getElementById('linkModal')?.classList.contains('hidden') ||
    !document.getElementById('syncModal')?.classList.contains('hidden') ||
    !document.getElementById('lightboxModal')?.classList.contains('hidden');

  if (
    !isEditingText &&
    !isModalOpen &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    selectedObjectIds.size === 0 &&
    !selectedConnectorId
  ) {
    const code = e.code;
    const key = (e.key || '').toLowerCase();

    if (code === 'KeyA' || key === 'a' || code === 'KeyV' || key === 'v') {
      e.preventDefault();
      setToolMode('select');
      showToast('선택 도구 (A)');
    } else if (code === 'KeyD' || key === 'd' || code === 'KeyP' || key === 'p') {
      e.preventDefault();
      setToolMode(activeTool === 'pen' ? 'select' : 'pen');
      showToast(activeTool === 'pen' ? '✏️ 펜 그리기 모드 (D)' : '선택 도구 (A)');
    } else if (code === 'KeyS' || key === 's') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addStickyBtn')?.click();
    } else if (code === 'KeyT' || key === 't' || code === 'KeyF' || key === 'f') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addLabelBtn')?.click();
    } else if (code === 'KeyC' || key === 'c') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addTextBtn')?.click();
    } else if (code === 'KeyG' || key === 'g' || code === 'KeyR' || key === 'r') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addTableBtn')?.click();
    } else if (code === 'KeyX' || key === 'x') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('captureScreenBtn')?.click();
    } else if (code === 'KeyQ' || key === 'q') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addImageBtn')?.click();
    } else if (code === 'KeyW' || key === 'w') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addLinkBtn')?.click();
    } else if (code === 'KeyE' || key === 'e') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addFileBtn')?.click();
    }
  }
});

document.getElementById('lightboxModal')?.addEventListener('click', () => {
  document.getElementById('lightboxModal')?.classList.add('hidden');
});

// ============================================================================
// Zoom & View HUD Controls
// ============================================================================
document.getElementById('zoomInBtn')?.addEventListener('click', () => {
  zoom = Math.min(3.5, zoom * 1.18);
  applyViewportTransform();
  scheduleSaveBoard();
});
document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
  zoom = Math.max(0.1, zoom / 1.18);
  applyViewportTransform();
  scheduleSaveBoard();
});
document.getElementById('zoomResetBtn')?.addEventListener('click', () => {
  zoom = 1;
  panX = 80;
  panY = 60;
  applyViewportTransform();
  scheduleSaveBoard();
});
document.getElementById('fitViewBtn')?.addEventListener('click', () => {
  if (!currentBoard || !currentBoard.objects.length) return;
  const minX = Math.min(...currentBoard.objects.map((o) => o.x));
  const minY = Math.min(...currentBoard.objects.map((o) => o.y));
  const maxX = Math.max(...currentBoard.objects.map((o) => o.x + o.width));
  const maxY = Math.max(...currentBoard.objects.map((o) => o.y + o.height));
  const rect = canvasViewport.getBoundingClientRect();
  const contentW = Math.max(400, maxX - minX + 120);
  const contentH = Math.max(300, maxY - minY + 120);
  zoom = Math.min(1.4, Math.max(0.1, Math.min(rect.width / contentW, rect.height / contentH)));
  panX = Math.round((rect.width - (maxX - minX) * zoom) / 2 - minX * zoom);
  panY = Math.round((rect.height - (maxY - minY) * zoom) / 2 - minY * zoom);
  applyViewportTransform();
  scheduleSaveBoard();
});

const GRID_MODES = ['grid-dots', 'grid-lines', 'grid-none'];
let currentGridIdx = 0;
document.getElementById('toggleGridBtn')?.addEventListener('click', () => {
  canvasViewport.classList.remove(...GRID_MODES);
  currentGridIdx = (currentGridIdx + 1) % GRID_MODES.length;
  canvasViewport.classList.add(GRID_MODES[currentGridIdx]);
  const labels = ['도트', '격자', '무지'];
  const lbl = document.getElementById('toggleGridLabel');
  if (lbl) lbl.textContent = labels[currentGridIdx];
});

document.getElementById('toggleThemeBtn')?.addEventListener('click', () => {
  const isLight = document.body.classList.toggle('theme-light');
  const lbl = document.getElementById('toggleThemeLabel');
  if (lbl) lbl.textContent = isLight ? '라이트' : '다크';
});

// Export / Import Board JSON
document.getElementById('exportBoardBtn')?.addEventListener('click', async () => {
  if (!currentBoard) return;
  const res = await window.freeformAPI.exportBoardJson(currentBoard);
  if (res && res.success) showToast('보드 백업 파일(.json)이 저장되었습니다');
});

document.getElementById('importBoardBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.importBoardJson();
  if (res && res.success && res.board) {
    await loadBoardById(res.board.id);
    showToast('보드 파일을 성공적으로 불러왔습니다');
  }
});

// ============================================================================
// Google Drive Sync Modal & Status
// ============================================================================
const syncModal = document.getElementById('syncModal');

async function refreshSyncUI() {
  const st = await window.freeformAPI.getSyncStatus();
  const pathText = document.getElementById('sidebarDrivePathText');
  const modalPathInput = document.getElementById('syncFolderPathDisplay');
  const syncLabel = document.getElementById('syncStatusLabel');
  const syncBtn = document.getElementById('openSyncModalBtn');
  const oauthStatusText = document.getElementById('oauthStatusText');
  const cidInput = document.getElementById('oauthClientIdInput');
  const hotkeyInput = document.getElementById('hotkeyRecorderInput');

  if (pathText) pathText.textContent = st.syncFolderPath || '';
  if (modalPathInput) modalPathInput.value = st.syncFolderPath || '';
  if (cidInput && st.oauthClientId && !cidInput.value) cidInput.value = st.oauthClientId;
  if (hotkeyInput && st.hotkey) hotkeyInput.value = st.hotkey;
  if (syncBtn) {
    syncBtn.title = `Google Drive 동기화 및 호출 단축키 설정 (현재 호출키: ${st.hotkey || 'Ctrl+Shift+Space'})`;
  }

  if (syncLabel) {
    if (st.isOAuthConnected) {
      syncLabel.textContent = `${st.cloudAccountEmail || 'Google Cloud 동기화됨'}`;
    } else if (st.isDesktopDriveActive) {
      syncLabel.textContent = 'Google Drive (PC 폴더 연동됨)';
    } else {
      syncLabel.textContent = '로컬 동기화 중 (Google Drive 연결 가능)';
    }
  }

  if (oauthStatusText) {
    oauthStatusText.textContent = st.isOAuthConnected
      ? `✅ 연결됨 (${st.cloudAccountEmail || 'Google Drive API'})`
      : '구글 드라이브 웹 로그인 또는 OAuth2 API로 클라우드와 직접 연결할 수 있습니다.';
  }
}

// Interactive Global Hotkey Recorder & Save/Reset Handlers
const hotkeyRecorderInput = document.getElementById('hotkeyRecorderInput');
if (hotkeyRecorderInput) {
  hotkeyRecorderInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Tab') return;
    e.preventDefault();

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      return;
    }

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let mainKey = '';
    if (e.code === 'Space' || e.key === ' ') {
      mainKey = 'Space';
    } else if (/^Key([A-Z])$/.test(e.code)) {
      mainKey = e.code.replace('Key', '');
    } else if (/^Digit([0-9])$/.test(e.code)) {
      mainKey = e.code.replace('Digit', '');
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) {
      mainKey = e.key.toUpperCase();
    } else if (e.key && e.key.length === 1) {
      mainKey = e.key.toUpperCase();
    } else if (['Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'].includes(e.code)) {
      const codeMap = {
        Backquote: '`',
        Minus: '-',
        Equal: '=',
        BracketLeft: '[',
        BracketRight: ']',
        Backslash: '\\',
        Semicolon: ';',
        Quote: "'",
        Comma: ',',
        Period: '.',
        Slash: '/'
      };
      mainKey = codeMap[e.code] || e.key;
    } else {
      mainKey = e.key;
    }

    if (parts.length === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(mainKey)) {
      showToast('단축키는 Ctrl, Alt, Shift 중 하나 이상과 함께 눌러주세요 (예: Ctrl+Shift+Space)');
      return;
    }

    parts.push(mainKey);
    hotkeyRecorderInput.value = parts.join('+');
  });
}

document.getElementById('saveHotkeyBtn')?.addEventListener('click', async () => {
  const rawVal = document.getElementById('hotkeyRecorderInput')?.value.trim() || 'Ctrl+Shift+Space';
  const res = await window.freeformAPI.setGlobalHotkey(rawVal);
  if (res && res.success) {
    await refreshSyncUI();
    showToast(`✅ 글로벌 호출 단축키가 [${res.hotkey}]로 변경되었습니다!`);
  } else {
    if (hotkeyRecorderInput && res?.hotkey) hotkeyRecorderInput.value = res.hotkey;
    showToast(res?.error || '단축키 변경에 실패했습니다.');
  }
});

document.getElementById('resetHotkeyBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.setGlobalHotkey('Ctrl+Shift+Space');
  if (res && res.success) {
    if (hotkeyRecorderInput) hotkeyRecorderInput.value = res.hotkey;
    await refreshSyncUI();
    showToast('✅ 기본 호출 단축키(Ctrl+Shift+Space)로 복원되었습니다!');
  }
});

document.getElementById('openSyncModalBtn')?.addEventListener('click', () => {
  refreshSyncUI();
  syncModal?.classList.remove('hidden');
});
document.getElementById('closeSyncModalBtn')?.addEventListener('click', () => syncModal?.classList.add('hidden'));
document.getElementById('doneSyncModalBtn')?.addEventListener('click', () => syncModal?.classList.add('hidden'));
document.getElementById('sidebarDriveBox')?.addEventListener('click', () => window.freeformAPI.openSyncFolder());
document.getElementById('openCurrentSyncFolderBtn')?.addEventListener('click', () => window.freeformAPI.openSyncFolder());

document.getElementById('autoDetectDriveBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.useDetectedGoogleDriveFolder();
  if (res && res.success) {
    await refreshSyncUI();
    await refreshBoardsSidebarList();
    showToast('✅ PC에 설치된 Google Drive 폴더와 연동되었습니다!');
  } else {
    showToast(res?.error || 'Google Drive 데스크톱 폴더를 찾지 못했습니다.');
  }
});

document.getElementById('pickSyncFolderBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.pickSyncFolder();
  if (res && res.success) {
    await refreshSyncUI();
    await refreshBoardsSidebarList();
    showToast('✅ 선택한 폴더로 실시간 보드 동기화 경로가 설정되었습니다!');
  }
});

document.getElementById('openGoogleWebLoginBtn')?.addEventListener('click', async () => {
  await window.freeformAPI.openGoogleWebLogin();
  showToast('🌐 내장 Google Drive 창이 열렸습니다. 로그인 후 자유롭게 이용하세요!');
});

document.getElementById('startOAuthLoginBtn')?.addEventListener('click', async () => {
  const clientId = document.getElementById('oauthClientIdInput')?.value.trim();
  const clientSecret = document.getElementById('oauthClientSecretInput')?.value.trim();
  try {
    showToast('🌐 브라우저에서 Google 계정 로그인을 진행해 주세요...');
    await window.freeformAPI.startGoogleOAuth({ clientId, clientSecret });
    await refreshSyncUI();
    showToast('✅ Google Drive Cloud API 연동 및 동기화 완료!');
  } catch (err) {
    showToast(`OAuth 연동 실패: ${err.message}`);
  }
});

document.getElementById('syncCloudNowBtn')?.addEventListener('click', async () => {
  const res = await window.freeformAPI.syncCloudNow();
  if (res && res.success) {
    await refreshSyncUI();
    showToast(`☁️ Google Drive 클라우드 동기화 완료 (${res.count}개 보드)`);
  } else {
    showToast(res?.error || '먼저 Google 계정을 연결해 주세요.');
  }
});

document.getElementById('disconnectOAuthBtn')?.addEventListener('click', async () => {
  await window.freeformAPI.disconnectOAuth();
  await refreshSyncUI();
  showToast('Google Cloud OAuth 연결이 해제되었습니다');
});

// ============================================================================
// External Sync Update & SpotlightAgent Bridge Listener
// ============================================================================
window.freeformAPI.onBoardExternallyUpdated(async (changedBoardId) => {
  if (isSavingBoard || Date.now() - lastLocalSaveAt < 3500) {
    return;
  }
  const activeEl = document.activeElement;
  const isActivelyTyping = Boolean(
    activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.closest?.('[contenteditable="true"]'))
  );
  if (isActivelyTyping) {
    return;
  }
  await refreshBoardsSidebarList();
  if (currentBoard && currentBoard.id === changedBoardId && !draggingObjState && !resizingObjState && !rotatingObjState) {
    const fresh = await window.freeformAPI.getBoard(changedBoardId);
    if (fresh && fresh.updatedAt > (currentBoard.updatedAt || 0) + 500) {
      currentBoard = fresh;
      renderAllObjects();
      renderAllConnectors();
      renderAllStrokes();
    }
  }
});

// Initialize on startup
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const cfg = await window.freeformAPI.getConfig();
    if (cfg && Array.isArray(cfg.customObjectSwatches) && cfg.customObjectSwatches.length > 0) {
      customObjectSwatches = DEFAULT_OBJECT_SWATCHES.map((def, i) => cfg.customObjectSwatches[i] || def);
    }
    if (cfg && Array.isArray(cfg.customPenSwatches) && cfg.customPenSwatches.length > 0) {
      customPenSwatches = DEFAULT_PEN_SWATCHES.map((def, i) => cfg.customPenSwatches[i] || def);
    }
  } catch (err) {
    console.warn('getConfig error:', err);
  }
  applyCustomSwatchesToDOM();
  await refreshSyncUI();
  await refreshBoardsSidebarList();
  const initialId = boardsList[0]?.id || 'board_welcome';
  await loadBoardById(initialId);
});

