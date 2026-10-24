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
    groupNames: JSON.parse(JSON.stringify(currentBoard.groupNames || {})),
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
  currentBoard.groupNames = JSON.parse(JSON.stringify(snap.groupNames || {}));
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
let viewportAnimFrame = null;
let lastCanvasMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

// Grid & Dot Snap / Spacing Configuration
const PX_PER_CM = 37.7952755906;
const PX_PER_M = 3779.52755906;
let gridConfig = {
  mode: 'grid-dots', // 'grid-dots' | 'grid-lines' | 'grid-none'
  unit: 'px', // 'px' | 'cm' | 'm'
  spacingValue: 24,
  snapObjects: false,
  snapDrawing: false
};

function getGridSpacingWorldPx() {
  const val = Number(gridConfig.spacingValue);
  if (gridConfig.unit === 'cm') {
    const cm = Number.isFinite(val) && val > 0 ? val : 1;
    return Math.max(6, Math.min(2000, Math.round(cm * PX_PER_CM)));
  }
  if (gridConfig.unit === 'm') {
    const m = Number.isFinite(val) && val > 0 ? val : 0.05;
    return Math.max(10, Math.min(5000, Math.round(m * PX_PER_M)));
  }
  const px = Number.isFinite(val) && val > 0 ? val : 24;
  return Math.max(6, Math.min(1000, Math.round(px)));
}

function snapWorldVal(val, enabled = false) {
  if (!enabled) return Math.round(val);
  const step = getGridSpacingWorldPx();
  if (!step || step < 2) return Math.round(val);
  return Math.round(val / step) * step;
}

function cancelViewportAnimation() {
  if (viewportAnimFrame) {
    cancelAnimationFrame(viewportAnimFrame);
    viewportAnimFrame = null;
  }
}

function animateViewportTo(targetPanX, targetPanY, targetZoom, durationMs = 420) {
  cancelViewportAnimation();
  const startPanX = panX;
  const startPanY = panY;
  const startZoom = zoom;
  const clampedTargetZoom = Math.min(3.5, Math.max(0.1, targetZoom));
  const startTime = performance.now();

  const step = (now) => {
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / Math.max(1, durationMs));
    // Cubic ease-out for natural, fluid deceleration
    const ease = 1 - Math.pow(1 - t, 3);
    zoom = startZoom + (clampedTargetZoom - startZoom) * ease;
    panX = startPanX + (targetPanX - startPanX) * ease;
    panY = startPanY + (targetPanY - startPanY) * ease;
    applyViewportTransform();

    if (t < 1) {
      viewportAnimFrame = requestAnimationFrame(step);
    } else {
      viewportAnimFrame = null;
      zoom = clampedTargetZoom;
      panX = Math.round(targetPanX);
      panY = Math.round(targetPanY);
      applyViewportTransform();
      scheduleSaveBoard();
    }
  };
  viewportAnimFrame = requestAnimationFrame(step);
}

function zoomAtScreenPoint(targetZoom, clientX = null, clientY = null) {
  cancelViewportAnimation();
  if (!canvasViewport) return;
  const rect = canvasViewport.getBoundingClientRect();
  const sx = clientX !== null ? clientX : lastCanvasMousePos.x || rect.left + rect.width / 2;
  const sy = clientY !== null ? clientY : lastCanvasMousePos.y || rect.top + rect.height / 2;
  const mouseX = Math.max(0, Math.min(rect.width, sx - rect.left));
  const mouseY = Math.max(0, Math.min(rect.height, sy - rect.top));
  const worldX = (mouseX - panX) / zoom;
  const worldY = (mouseY - panY) / zoom;

  zoom = Math.min(3.5, Math.max(0.1, targetZoom));
  panX = mouseX - worldX * zoom;
  panY = mouseY - worldY * zoom;
  applyViewportTransform();
  scheduleSaveBoard();
}

// Interaction States
let draggingObjState = null;
let resizingObjState = null;
let rotatingObjState = null;
let marqueeState = null;
let connectingState = null;
let draggingConnectorEndpoint = null; // { conn, end: 'from' | 'to', origObjId, snapPreview, snapshotBefore }
let selectedConnectorId = null;
let drawingStroke = null;
let drawingShapeState = null; // { startX, startY, curX, curY }
let shapeToolConfig = {
  shapeType: 'rect', // 'rect' | 'triangle' | 'circle' | 'ellipse' | 'polygon'
  polygonSides: 5,
  cornerEnabled: true,
  cornerRadius: 18,
  fillEnabled: true,
  fillColor: '#0a84ff',
  fillOpacity: 0.25,
  borderStyle: 'solid', // 'solid' | 'dashed' | 'dotted' | 'double' | 'none'
  borderWidth: 3.5,
  strokeColor: '#0a84ff'
};
let saveDebounceTimer = null;
let lastFocusedTableCell = null; // { obj, rIdx, cIdx }
let activeTableCellSelection = {
  objId: null,
  anchor: null, // { rIdx, cIdx }
  cells: new Set() // Set of "${rIdx}_${cIdx}"
};
let tableCellDragState = null; // { obj, tableEl, startR, startC, isMultiDrag }

function clearTableCellSelection(exceptObjId = null) {
  if (exceptObjId && activeTableCellSelection.objId === exceptObjId) return;
  activeTableCellSelection.objId = null;
  activeTableCellSelection.anchor = null;
  activeTableCellSelection.cells.clear();
  document.querySelectorAll('.ff-table td.ff-cell-selected').forEach((td) => td.classList.remove('ff-cell-selected'));
  document.querySelectorAll('.ff-table.is-selecting-cells').forEach((tb) => tb.classList.remove('is-selecting-cells'));
  document.querySelectorAll('.ff-table-sel-badge').forEach((b) => b.classList.add('hidden'));
}

function updateTableCellSelectionDOM(objId) {
  const domEl = objectLayer?.querySelector(`.ff-object[data-id="${objId}"]`);
  if (!domEl) return;
  const isTargetObj = activeTableCellSelection.objId === objId;
  const selSet = isTargetObj ? activeTableCellSelection.cells : new Set();
  domEl.querySelectorAll('.ff-table td[data-cell-key]').forEach((td) => {
    td.classList.toggle('ff-cell-selected', selSet.size > 1 && selSet.has(td.dataset.cellKey));
  });
  const badge = domEl.querySelector('.ff-table-sel-badge');
  if (badge) {
    if (selSet.size > 1) {
      badge.textContent = `${selSet.size}셀 선택됨`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

// DOM Elements
const canvasViewport = document.getElementById('canvasViewport');
const canvasWorld = document.getElementById('canvasWorld');
const objectLayer = document.getElementById('objectLayer');
const connectorsGroup = document.getElementById('connectorsGroup');
const strokesGroup = document.getElementById('strokesGroup');
const tempConnectorPath = document.getElementById('tempConnectorPath');
const objectInspector = document.getElementById('objectInspector');
const penToolbar = document.getElementById('penToolbar');
const shapeToolbar = document.getElementById('shapeToolbar');
const shapeDrawPreview = document.getElementById('shapeDrawPreview');
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

// "https://www.naver.com/blog/some/very/long/path?x=1" -> "https://www.naver.com/blog/some/ve..."
function shortenDisplayUrl(url, maxLen = 38) {
  let s = String(url || '').trim();
  if (!s) return '';
  try {
    s = decodeURI(s);
  } catch (_) {}
  s = s.replace(/\/+$/, '');
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function applyViewportTransform() {
  if (!canvasWorld) return;
  canvasWorld.style.transform = `translate3d(${Math.round(panX)}px, ${Math.round(panY)}px, 0) scale(${zoom.toFixed(3)})`;
  if (canvasViewport) {
    const baseWorldStep = getGridSpacingWorldPx();
    const gridSize = Math.max(4, Math.min(1200, Math.round(baseWorldStep * zoom)));
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
  down: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"></polyline><line x1="12" y1="18" x2="12" y2="6"></line></svg>`,
  wrapText: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><path d="M3 12h15a3 3 0 1 1 0 6h-4"></path><polyline points="16 16 14 18 16 20"></polyline><line x1="3" y1="18" x2="10" y2="18"></line></svg>`,
  aspectRatio: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h3v3"></path><path d="M17 15h-3v-3"></path></svg>`,
  borderFrame: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="4 2"></rect></svg>`,
  bgLayer: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5" stroke-dasharray="3 2"></rect><path d="M8 10h8v4H8z"></path></svg>`,
  sparkle: `<svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z"></path></svg>`,
  sticky: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"></path><path d="M14 3v4a2 2 0 0 0 2 2h4"></path></svg>`,
  table: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`,
  fit: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>`,
  resetWin: `<svg class="ui-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 12h6"></path><path d="M12 9v6"></path></svg>`,
  copyUnchecked: `<span class="ff-chk-copy-combo"><svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect></svg><svg class="ui-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span>`,
  copyChecked: `<span class="ff-chk-copy-combo"><svg class="ui-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="m7.5 12 3 3 6-6.5"></path></svg><svg class="ui-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span>`
};

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../../node_modules/pdfjs-dist/build/pdf.worker.min.js';
}
const pdfDocCache = new Map(); // filePath -> { pdfDoc, extractedText, pageAspect, pageTextsByPage, pageTextItems }

function isPdfObject(obj) {
  if (!obj) return false;
  if (obj.type !== 'file' && obj.type !== 'pdf') return false;
  const nameOrPath = String(obj.fileName || obj.title || obj.resolvedFilePath || '').toLowerCase();
  return nameOrPath.endsWith('.pdf');
}

function hasBorderFrameSupport(obj) {
  if (!obj) return false;
  return obj.type === 'image' || obj.type === 'sticker' || isPdfObject(obj);
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

  // Extract first-page aspect ratio (portrait or landscape) + full text & item coordinates across pages
  let pageAspect = 595.28 / 841.89;
  try {
    const firstPage = await pdfDoc.getPage(1);
    const vp1 = firstPage.getViewport({ scale: 1 });
    if (vp1 && vp1.width > 0 && vp1.height > 0) {
      pageAspect = vp1.width / vp1.height;
    }
  } catch (_) {}

  const pageTexts = [];
  const pageTextsByPage = {};
  const pageTextItems = {};
  for (let p = 1; p <= Math.min(pdfDoc.numPages, 80); p++) {
    try {
      const page = await pdfDoc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const pageStr = tc.items.map((it) => it.str).join(' ').trim();
      pageTextsByPage[p] = pageStr;
      if (pageStr) pageTexts.push(`[${p}페이지]\n${pageStr}`);
      const pw = Math.max(1, vp.width);
      const ph = Math.max(1, vp.height);
      pageTextItems[p] = (tc.items || [])
        .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '')
        .map((it) => {
          const tr = it.transform || [1, 0, 0, 1, 0, 0];
          const fontH = Math.max(8, Math.hypot(tr[2] || 0, tr[3] || 12));
          const x = Number(tr[4]) || 0;
          const yBottom = Number(tr[5]) || 0;
          const yTop = ph - yBottom - fontH * 0.88;
          const w = Math.max(fontH * 0.5, Number(it.width) || it.str.length * fontH * 0.55);
          return {
            str: it.str,
            xRatio: Math.max(0, Math.min(0.98, x / pw)),
            yRatio: Math.max(0, Math.min(0.98, yTop / ph)),
            wRatio: Math.max(0.01, Math.min(1, w / pw)),
            hRatio: Math.max(0.012, Math.min(0.25, (fontH * 1.18) / ph))
          };
        });
    } catch (_) {}
  }
  const entry = { pdfDoc, extractedText: pageTexts.join('\n\n'), pageAspect, pageTextsByPage, pageTextItems };
  pdfDocCache.set(filePath, entry);
  return entry;
}

const PDF_DEFAULT_CHROME_W = 0;
const PDF_DEFAULT_CHROME_H = 0;

function syncPdfViewerAspectSize(obj, pageAspectInput = null, options = {}) {
  if (!isPdfObject(obj)) return false;
  const aspect = Number(pageAspectInput || obj.pdfPageAspect) || (595.28 / 841.89);
  obj.pdfPageAspect = aspect;
  obj.pdfChromeW = 0;
  obj.pdfChromeH = 0;
  const isLandscape = aspect > 1.02;
  const minPageW = isLandscape ? 260 : 200;

  let targetW = Number(options.width || obj.width || obj.viewerWidth || 0);
  if (!obj.pdfAspectFitted && isLandscape && (!targetW || targetW === 480)) {
    targetW = 620;
  }
  if (!targetW || targetW < minPageW) {
    targetW = isLandscape ? 620 : 480;
  }
  targetW = Math.max(minPageW, Math.round(targetW));
  const targetH = Math.round(targetW / Math.max(0.15, aspect));

  const changed = obj.width !== targetW || obj.height !== targetH || !obj.pdfAspectFitted;
  if ((obj.pdfViewMode || 'viewer') === 'viewer') {
    obj.width = targetW;
    obj.height = targetH;
  }
  obj.viewerWidth = targetW;
  obj.viewerHeight = targetH;
  obj.pdfAspectFitted = true;
  return changed;
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

function getCellEffectiveTextStyle(obj, cellKey) {
  const base = getObjectTextStyle(obj);
  const cs = obj?.cellStyles?.[cellKey];
  if (!cs || typeof cs !== 'object') return base;
  return {
    fontFamily: cs.fontFamily && FONT_FAMILY_STACKS[cs.fontFamily] ? cs.fontFamily : base.fontFamily,
    fontSize: Number(cs.fontSize) || base.fontSize,
    bold: cs.bold !== undefined ? Boolean(cs.bold) : base.bold,
    italic: cs.italic !== undefined ? Boolean(cs.italic) : base.italic,
    underline: cs.underline !== undefined ? Boolean(cs.underline) : base.underline,
    textAlign: obj?.cellAligns?.[cellKey] || base.textAlign
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
    if (node.tagName === 'TD' && node.dataset.cellKey) {
      const ck = node.dataset.cellKey;
      const cts = getCellEffectiveTextStyle(obj, ck);
      const cFam = FONT_FAMILY_STACKS[cts.fontFamily] || familyStack;
      const hasCustomBold = obj?.cellStyles?.[ck]?.bold !== undefined;
      const isHeaderRow = node.dataset.rIdx === '0';
      const cWeight = cts.bold ? '800' : !hasCustomBold && isHeaderRow ? '700' : '400';
      node.style.fontFamily = cFam;
      node.style.fontSize = `${cts.fontSize}px`;
      node.style.fontWeight = cWeight;
      node.style.fontStyle = cts.italic ? 'italic' : 'normal';
      if (!node.querySelector('[contenteditable="true"]')) {
        node.style.textDecoration = cts.underline ? 'underline' : 'none';
      }
      return;
    }
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
    const parentTd = node.closest('td[data-cell-key]');
    if (parentTd) {
      const ck = parentTd.dataset.cellKey;
      const cts = getCellEffectiveTextStyle(obj, ck);
      const hasCustomBold = obj?.cellStyles?.[ck]?.bold !== undefined;
      const isHeaderRow = parentTd.dataset.rIdx === '0';
      node.style.fontFamily = FONT_FAMILY_STACKS[cts.fontFamily] || familyStack;
      node.style.fontSize = `${cts.fontSize}px`;
      node.style.fontWeight = cts.bold ? '800' : !hasCustomBold && isHeaderRow ? '700' : '400';
      node.style.fontStyle = cts.italic ? 'italic' : 'normal';
      const isCheckedCell = Boolean(node.parentElement?.querySelector('.ff-chk-widget.checked'));
      if (isCheckedCell && cts.underline) {
        node.style.textDecoration = 'underline line-through';
      } else if (isCheckedCell) {
        node.style.textDecoration = 'line-through';
      } else {
        node.style.textDecoration = cts.underline ? 'underline' : 'none';
      }
      return;
    }
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

  if (obj.vectorized) {
    if (obj.type === 'label') {
      const wrapEl = el.querySelector('.ff-label-wrap');
      if (wrapEl) renderVectorizedLabelIntoWrap(wrapEl, obj);
    } else {
      const uWrap = el.querySelector('.ff-universal-vector-wrap');
      if (uWrap) renderUniversalVectorizedObjectInto(uWrap, obj);
    }
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
  if (obj.type === 'image' || obj.type === 'sticker' || isPdfObject(obj)) {
    const targetEl =
      obj.type === 'image'
        ? el.querySelector('.ff-image-wrap img')
        : obj.type === 'sticker'
        ? el.querySelector('.ff-sticker-wrap')
        : el.querySelector('.ff-pdf-viewer-wrap') || el;
    if (obj.borderEnabled) {
      const bWidth = Number(obj.borderWidth) || 4;
      const bStyle = obj.borderStyle || 'solid';
      const bColor = obj.borderColor || obj.customColor || getResolvedObjectColorHex(obj) || '#0a84ff';
      el.classList.add('has-custom-border');
      if (targetEl) {
        targetEl.style.border = `${bWidth}px ${bStyle} ${bColor}`;
        targetEl.style.borderRadius = '10px';
        targetEl.style.boxSizing = 'border-box';
      }
    } else {
      el.classList.remove('has-custom-border');
      if (targetEl) {
        targetEl.style.border = 'none';
      }
    }
    if (obj.type === 'image' || obj.type === 'sticker' || (isPdfObject(obj) && (obj.pdfViewMode || 'viewer') === 'viewer')) {
      return;
    }
  }

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

  if (obj.type === 'shape') {
    const shapeWrap = el.querySelector('.ff-shape-wrap');
    if (shapeWrap) {
      renderShapeObjectInto(shapeWrap, obj);
    }
    return;
  }

  if (obj.type === 'label') {
    const resolvedHex = getResolvedObjectColorHex(obj);
    el.style.setProperty('--label-color', resolvedHex);
    const fillEnabled = true; // Text glyphs are always filled (text color = swatch color)
    const fillColor = obj.labelFillColor || resolvedHex;
    const strokeEnabled = Boolean(obj.labelStrokeEnabled);
    const strokeColor = obj.labelStrokeColor || '#111115';
    const strokeWidth = Number(obj.labelStrokeWidth) || 6;

    // Box Background Fill (텍스트를 제외한 박스 배경 채우기)
    if (obj.labelBgEnabled) {
      const bgRgb = parseHexToRgb(obj.labelBgColor || '#1c1c22') || { r: 28, g: 28, b: 34 };
      const bgOp = obj.opaque ? 1 : obj.labelBgOpacity !== undefined ? Number(obj.labelBgOpacity) : 0.85;
      el.style.setProperty('background', `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${bgOp})`, 'important');
      el.style.setProperty('border-radius', `${Math.max(0, Number(obj.labelBgRadius ?? 14))}px`);
      el.classList.add('has-label-bg');
    } else {
      el.style.removeProperty('background');
      el.classList.remove('has-label-bg');
    }

    // Box Border (텍스트·타이틀 박스 테두리)
    if (obj.labelBoxBorderEnabled) {
      const bw = Math.max(1, Number(obj.labelBoxBorderWidth) || 2);
      const bs = obj.labelBoxBorderStyle || 'solid';
      const bc = obj.labelBoxBorderColor || '#0a84ff';
      el.style.setProperty('border', `${bw}px ${bs} ${bc}`, 'important');
      el.style.setProperty('border-radius', `${Math.max(0, Number(obj.labelBgRadius ?? 14))}px`);
      el.classList.add('has-label-box-border');
    } else {
      el.style.removeProperty('border');
      el.classList.remove('has-label-box-border');
    }
    if (!obj.labelBgEnabled && !obj.labelBoxBorderEnabled) {
      el.style.removeProperty('border-radius');
    }

    const editor = el.querySelector('.ff-label-editor');
    if (editor) {
      if (!obj.artStyle || obj.artStyle === 'none') {
        editor.style.color = fillEnabled ? fillColor : 'transparent';
        editor.style.webkitTextFillColor = fillEnabled ? fillColor : 'transparent';
        editor.style.webkitTextStroke = strokeEnabled
          ? `${Math.max(1, Math.round(strokeWidth * 0.45))}px ${strokeColor}`
          : '';
        editor.style.paintOrder = 'stroke fill';
      } else {
        editor.style.color = '';
        editor.style.webkitTextFillColor = '';
        editor.style.webkitTextStroke = '';
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

  if (obj.vectorized) {
    el.style.background = 'transparent';
    el.style.borderColor = 'transparent';
    const uWrap = el.querySelector('.ff-universal-vector-wrap');
    if (uWrap) renderUniversalVectorizedObjectInto(uWrap, obj);
    return;
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
  const extraStrokePad = obj?.labelStrokeEnabled ? Math.ceil((Number(obj.labelStrokeWidth) || 6) * 1.4) : 0;
  const padX = (artStyle === 'stamp' ? 56 : artStyle === 'graffiti' || artStyle === 'retro3d' ? 42 : 28) + extraStrokePad;
  const padY = (artStyle === 'stamp' ? 38 : 24) + extraStrokePad;
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
  const fillEnabled = true;
  const fillHex = obj.labelFillColor || resolvedColor;
  const customStrokeEnabled = Boolean(obj.labelStrokeEnabled);
  const customStrokeHex = obj.labelStrokeColor || '#111115';
  const customStrokeW = Math.max(1, Math.round((Number(obj.labelStrokeWidth) || 6) * 1.55));
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
    outerRect.setAttribute('stroke', customStrokeEnabled ? customStrokeHex : fillHex);
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
    t.setAttribute('dominant-baseline', 'central');
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

  const totalLines = m.rawLines.length;
  const blockCenterY = m.vbH / 2;

  m.rawLines.forEach((lineStr, idx) => {
    // Vectorized label defaults to horizontal & vertical center alignment unless explicitly aligned left/right
    const align = (Array.isArray(obj.lineAligns) && obj.lineAligns[idx]) || 'center';
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const xPos = align === 'left' ? m.padX : align === 'right' ? m.vbW - m.padX : Math.round(m.vbW / 2);
    const yPos = Math.round(blockCenterY + (idx - (totalLines - 1) / 2) * m.lineH);

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
          fill: fillEnabled ? (obj.labelFillColor ? fillHex : `url(#grad_game_${safeId})`) : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : '#2b0900',
          'stroke-width': customStrokeEnabled ? customStrokeW : 5
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
          fill: fillEnabled ? fillHex : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : '#111115',
          'stroke-width': customStrokeEnabled ? customStrokeW : 7
        })
      );
    } else if (m.artStyle === 'neon') {
      const neonStroke = customStrokeEnabled ? customStrokeHex : fillHex;
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: 'none',
          stroke: neonStroke,
          'stroke-width': 18,
          opacity: 0.3,
          style: 'filter: blur(8px);'
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: 'none',
          stroke: neonStroke,
          'stroke-width': 8,
          opacity: 0.72,
          style: 'filter: blur(2.5px);'
        })
      );
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: fillEnabled ? (obj.labelFillColor || '#ffffff') : 'none',
          stroke: neonStroke,
          'stroke-width': customStrokeEnabled ? customStrokeW : 2.5
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
          fill: fillEnabled ? fillHex : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : '#16161c',
          'stroke-width': customStrokeEnabled ? customStrokeW : 4.5
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
          fill: fillEnabled ? fillHex : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : '#ffffff',
          'stroke-width': customStrokeEnabled ? customStrokeW : 15
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
          fill: fillEnabled ? (obj.labelFillColor ? fillHex : `url(#grad_gold_${safeId})`) : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : '#4a3500',
          'stroke-width': customStrokeEnabled ? customStrokeW : 4
        })
      );
    } else if (m.artStyle === 'stamp') {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: fillEnabled ? fillHex : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : undefined,
          'stroke-width': customStrokeEnabled ? customStrokeW : undefined
        })
      );
    } else {
      artGroup.appendChild(
        makeSvgTextNode(lineStr, xPos, yPos, {
          'text-anchor': anchor,
          fill: fillEnabled ? fillHex : 'none',
          stroke: customStrokeEnabled ? customStrokeHex : undefined,
          'stroke-width': customStrokeEnabled ? customStrokeW : undefined,
          style: 'filter: drop-shadow(0 3px 10px rgba(0,0,0,0.32));'
        })
      );
    }
  });

  svg.appendChild(artGroup);
  wrapEl.innerHTML = '';
  wrapEl.appendChild(svg);
}

// ============================================================================
// Dedicated Shape Object SVG Renderer (rect, triangle, circle, ellipse, polygon)
// ============================================================================
function buildRoundedPolygonPath(pts, radius) {
  if (!Array.isArray(pts) || pts.length < 3) return '';
  const r = Math.max(0, Number(radius) || 0);
  if (r <= 0.5) {
    return (
      pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z'
    );
  }
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y) || 1;
    const len2 = Math.hypot(v2x, v2y) || 1;
    const cut = Math.min(r, len1 * 0.46, len2 * 0.46);
    const pA = {
      x: curr.x + (v1x / len1) * cut,
      y: curr.y + (v1y / len1) * cut
    };
    const pB = {
      x: curr.x + (v2x / len2) * cut,
      y: curr.y + (v2y / len2) * cut
    };
    if (i === 0) {
      d += `M ${pA.x.toFixed(1)} ${pA.y.toFixed(1)}`;
    } else {
      d += ` L ${pA.x.toFixed(1)} ${pA.y.toFixed(1)}`;
    }
    d += ` Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${pB.x.toFixed(1)} ${pB.y.toFixed(1)}`;
  }
  return d + ' Z';
}

function renderShapeObjectInto(wrapEl, obj) {
  if (!wrapEl || !obj) return;
  const w = Math.max(40, Math.round(obj.width || 240));
  const h = Math.max(40, Math.round(obj.height || 180));
  const shapeType = obj.shapeType || 'rect';
  const sides = Math.max(3, Math.min(24, Math.round(Number(obj.polygonSides) || 5)));
  const cornerEnabled = shapeType !== 'circle' && obj.cornerEnabled !== false;
  const cornerRadius = cornerEnabled ? Math.max(0, Number(obj.cornerRadius ?? 18)) : 0;

  const resolvedHex = getResolvedObjectColorHex(obj) || '#0a84ff';
  const fillEnabled = obj.fillEnabled !== false;
  const fillColor = obj.fillColor || resolvedHex;
  const fillOpacity = obj.opaque ? 1 : obj.fillOpacity !== undefined ? Number(obj.fillOpacity) : 0.25;
  const borderStyle = obj.borderStyle || 'solid';
  const rawBorderWidth = Number(obj.borderWidth ?? 3.5);
  const borderWidth = borderStyle === 'none' ? 0 : Math.max(1, rawBorderWidth);
  const strokeColor = obj.strokeColor || resolvedHex;

  const pad = Math.max(4, Math.ceil((borderStyle === 'double' ? borderWidth * 2.2 : borderWidth) / 2) + 3);
  const rw = Math.max(10, w - pad * 2);
  const rh = Math.max(10, h - pad * 2);
  const cx = w / 2;
  const cy = h / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ff-shape-svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const createShapeGeoElement = () => {
    if (shapeType === 'circle') {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const r = Math.max(4, Math.min(rw, rh) / 2);
      el.setAttribute('cx', String(cx));
      el.setAttribute('cy', String(cy));
      el.setAttribute('r', String(r));
      return el;
    }
    if (shapeType === 'ellipse') {
      if (cornerEnabled && cornerRadius > 0) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        el.setAttribute('x', String(pad));
        el.setAttribute('y', String(pad));
        el.setAttribute('width', String(rw));
        el.setAttribute('height', String(rh));
        const maxRx = rw / 2;
        const maxRy = rh / 2;
        const factor = Math.max(0.15, Math.min(1, 1 - cornerRadius / 160));
        el.setAttribute('rx', String(Math.max(4, Math.round(maxRx * factor))));
        el.setAttribute('ry', String(Math.max(4, Math.round(maxRy * factor))));
        return el;
      }
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      el.setAttribute('cx', String(cx));
      el.setAttribute('cy', String(cy));
      el.setAttribute('rx', String(rw / 2));
      el.setAttribute('ry', String(rh / 2));
      return el;
    }
    if (shapeType === 'triangle') {
      const pts = [
        { x: cx, y: pad },
        { x: w - pad, y: h - pad },
        { x: pad, y: h - pad }
      ];
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', buildRoundedPolygonPath(pts, cornerRadius));
      return el;
    }
    if (shapeType === 'polygon') {
      const pts = [];
      const rx = rw / 2;
      const ry = rh / 2;
      for (let i = 0; i < sides; i++) {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
        pts.push({
          x: cx + rx * Math.cos(ang),
          y: cy + ry * Math.sin(ang)
        });
      }
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', buildRoundedPolygonPath(pts, cornerRadius));
      return el;
    }
    // Default: 'rect'
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.setAttribute('x', String(pad));
    el.setAttribute('y', String(pad));
    el.setAttribute('width', String(rw));
    el.setAttribute('height', String(rh));
    const rx = Math.min(cornerRadius, rw / 2, rh / 2);
    el.setAttribute('rx', String(rx));
    el.setAttribute('ry', String(rx));
    return el;
  };

  const mainGeo = createShapeGeoElement();
  mainGeo.setAttribute('fill', fillEnabled ? fillColor : 'none');
  if (fillEnabled) {
    mainGeo.setAttribute('fill-opacity', String(fillOpacity));
  }
  if (borderStyle === 'none' || borderWidth <= 0) {
    mainGeo.setAttribute('stroke', 'none');
  } else {
    mainGeo.setAttribute('stroke', strokeColor);
    mainGeo.setAttribute('stroke-width', String(borderStyle === 'double' ? borderWidth * 2.2 : borderWidth));
    mainGeo.setAttribute('stroke-linejoin', 'round');
    mainGeo.setAttribute('stroke-linecap', 'round');
    if (borderStyle === 'dashed') {
      mainGeo.setAttribute('stroke-dasharray', `${borderWidth * 2.6} ${borderWidth * 1.7}`);
    } else if (borderStyle === 'dotted') {
      mainGeo.setAttribute('stroke-dasharray', `${Math.max(1, borderWidth * 0.25)} ${borderWidth * 2.1}`);
    }
  }
  svg.appendChild(mainGeo);

  if (borderStyle === 'double' && borderWidth > 0) {
    const innerGeo = createShapeGeoElement();
    innerGeo.setAttribute('fill', 'none');
    innerGeo.setAttribute(
      'stroke',
      document.body.classList.contains('theme-light') ? 'rgba(245, 245, 247, 0.92)' : 'rgba(18, 18, 24, 0.92)'
    );
    innerGeo.setAttribute('stroke-width', String(Math.max(1.2, borderWidth * 0.7)));
    innerGeo.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(innerGeo);
  }

  wrapEl.innerHTML = '';
  wrapEl.appendChild(svg);
}

function isVectorizableObject(obj) {
  if (!obj) return false;
  return ['label', 'sticky', 'text', 'table', 'link', 'file'].includes(obj.type);
}

function getCardVectorThemePalette(obj) {
  let hex = obj.customColor || null;
  if (!hex && obj.color && SWATCH_SLOT_BY_NAME[obj.color] !== undefined) {
    const slot = SWATCH_SLOT_BY_NAME[obj.color];
    hex = customObjectSwatches[slot] || DEFAULT_OBJECT_SWATCHES[slot];
  }
  const presetPalettes = {
    yellow: { bg1: '#ffe66d', bg2: '#f7d147', text: '#1d1d1f', sub: 'rgba(29,29,31,0.68)', border: 'rgba(0,0,0,0.16)' },
    blue: { bg1: '#1c355e', bg2: '#132542', text: '#f5f5f7', sub: 'rgba(245,245,247,0.7)', border: 'rgba(10,132,255,0.48)' },
    green: { bg1: '#193d29', bg2: '#112a1c', text: '#f5f5f7', sub: 'rgba(245,245,247,0.7)', border: 'rgba(48,209,88,0.48)' },
    pink: { bg1: '#4a1f33', bg2: '#331523', text: '#f5f5f7', sub: 'rgba(245,245,247,0.7)', border: 'rgba(255,133,162,0.48)' },
    purple: { bg1: '#371f4a', bg2: '#251433', text: '#f5f5f7', sub: 'rgba(245,245,247,0.7)', border: 'rgba(191,90,242,0.48)' },
    orange: { bg1: '#4a2c11', bg2: '#331e0b', text: '#f5f5f7', sub: 'rgba(245,245,247,0.7)', border: 'rgba(255,159,10,0.48)' },
    dark: { bg1: '#232328', bg2: '#1a1a1f', text: '#f5f5f7', sub: 'rgba(245,245,247,0.68)', border: 'rgba(255,255,255,0.16)' },
    light: { bg1: '#ffffff', bg2: '#f2f2f7', text: '#1d1d1f', sub: 'rgba(29,29,31,0.65)', border: 'rgba(0,0,0,0.16)' }
  };

  if (obj.customColor) {
    const rgb = parseHexToRgb(obj.customColor);
    if (rgb) {
      const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
      const isLight = lum > 0.6;
      const r2 = Math.max(0, rgb.r - 22);
      const g2 = Math.max(0, rgb.g - 22);
      const b2 = Math.max(0, rgb.b - 22);
      return {
        bg1: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
        bg2: `rgb(${r2}, ${g2}, ${b2})`,
        text: isLight ? '#1d1d1f' : '#f5f5f7',
        sub: isLight ? 'rgba(29,29,31,0.68)' : 'rgba(245,245,247,0.72)',
        border: isLight ? 'rgba(0,0,0,0.2)' : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.65)`
      };
    }
  }
  return presetPalettes[obj.color] || presetPalettes.dark;
}

function renderUniversalVectorizedObjectInto(wrapEl, obj) {
  if (!wrapEl || !obj) return;
  if (obj.type === 'label') {
    renderVectorizedLabelIntoWrap(wrapEl, obj);
    return;
  }

  const ts = getObjectTextStyle(obj);
  const fontCss = FONT_FAMILY_STACKS[ts.fontFamily] || FONT_FAMILY_STACKS.default;
  const fontWeight = ts.bold ? '800' : '500';
  const fontStyle = ts.italic ? 'italic' : 'normal';
  const pal = getCardVectorThemePalette(obj);
  const safeId = String(obj.id || 'vec').replace(/[^a-zA-Z0-9_-]/g, '');

  const padX = 28;
  const headerH = 54;
  let vbW = 520;
  let vbH = 320;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ff-universal-vector-svg');
  svg.setAttribute('preserveAspectRatio', 'none');

  const contentGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  const addText = (str, x, y, size, opts = {}) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.textContent = str;
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('font-family', fontCss);
    t.setAttribute('font-size', String(size));
    t.setAttribute('font-weight', opts.weight || fontWeight);
    t.setAttribute('font-style', opts.style || fontStyle);
    t.setAttribute('fill', opts.fill || pal.text);
    if (opts.anchor) t.setAttribute('text-anchor', opts.anchor);
    if (opts.decoration || ts.underline) {
      t.setAttribute('text-decoration', opts.decoration || 'underline');
    }
    if (opts.opacity) t.setAttribute('opacity', String(opts.opacity));
    contentGroup.appendChild(t);
    return t;
  };

  const baseFs = 24;
  const lineH = 34;
  const fontSpec = `${fontStyle} ${fontWeight} ${baseFs}px ${fontCss}`;

  if (obj.type === 'sticky') {
    const rawLines = String(obj.content || '').split('\n');
    const lines = rawLines.length > 0 && rawLines.some((l) => l.trim()) ? rawLines : [obj.title || '포스트잇 메모'];
    const maxLineW = Math.max(
      260,
      ...lines.map((l) => measureVectorTextWidth(l || ' ', fontSpec) * 1.08),
      measureVectorTextWidth(obj.title || '📌 포스트잇 메모', `700 22px ${fontCss}`) * 1.15
    );
    vbW = Math.round(Math.max(380, maxLineW + padX * 2 + 24));
    vbH = Math.round(Math.max(220, headerH + lines.length * lineH + 42));

    lines.forEach((ln, idx) => {
      const al = (Array.isArray(obj.lineAligns) && obj.lineAligns[idx]) || 'left';
      const anchor = al === 'center' ? 'middle' : al === 'right' ? 'end' : 'start';
      const xPos = al === 'center' ? Math.round(vbW / 2) : al === 'right' ? vbW - padX : padX;
      const yPos = headerH + 34 + idx * lineH;
      addText(ln, xPos, yPos, baseFs, { anchor });
    });
  } else if (obj.type === 'text') {
    const parsed = parseNoteLines(obj.content || '');
    const checks = parsed.filter((it) => it.isCheck);
    const memos = parsed.filter((it) => !it.isCheck && (it.text || '').trim().length > 0);
    const allTexts = [
      ...checks.map((c) => c.text || '할 일 항목'),
      ...memos.map((m) => m.text || '')
    ];
    const maxLineW = Math.max(
      300,
      ...allTexts.map((l) => measureVectorTextWidth(l, fontSpec) * 1.08 + 44),
      measureVectorTextWidth(obj.title || '체크리스트', `700 22px ${fontCss}`) * 1.15
    );
    const totalRows = Math.max(1, checks.length + memos.length);
    vbW = Math.round(Math.max(420, maxLineW + padX * 2 + 24));
    vbH = Math.round(Math.max(220, headerH + totalRows * (lineH + 4) + 44));

    let curY = headerH + 34;
    checks.forEach((chk) => {
      const boxY = curY - 20;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(padX));
      rect.setAttribute('y', String(boxY));
      rect.setAttribute('width', chk.style === 'toggle' ? '34' : '22');
      rect.setAttribute('height', '22');
      rect.setAttribute('rx', chk.style === 'circle' || chk.style === 'toggle' ? '11' : '6');
      rect.setAttribute('fill', chk.checked ? '#0a84ff' : 'rgba(255,255,255,0.12)');
      rect.setAttribute('stroke', chk.checked ? '#0a84ff' : pal.sub);
      rect.setAttribute('stroke-width', '2');
      contentGroup.appendChild(rect);

      if (chk.checked) {
        addText('✓', padX + (chk.style === 'toggle' ? 17 : 11), curY - 3, 16, {
          anchor: 'middle',
          fill: '#ffffff',
          weight: '800',
          decoration: 'none'
        });
      }
      const textX = padX + (chk.style === 'toggle' ? 46 : 34);
      addText(chk.text || '', textX, curY, baseFs, {
        fill: pal.text,
        opacity: chk.checked ? 0.6 : 1,
        decoration: chk.checked ? 'line-through' : ts.underline ? 'underline' : undefined
      });
      curY += lineH + 4;
    });

    memos.forEach((m, idx) => {
      const al = (Array.isArray(obj.memoLineAligns) && obj.memoLineAligns[idx]) || 'left';
      const anchor = al === 'center' ? 'middle' : al === 'right' ? 'end' : 'start';
      const xPos = al === 'center' ? Math.round(vbW / 2) : al === 'right' ? vbW - padX : padX;
      addText(m.text || '', xPos, curY, baseFs - 1, { anchor, fill: pal.sub });
      curY += lineH;
    });
  } else if (obj.type === 'table') {
    const rows = Array.isArray(obj.tableData) && obj.tableData.length ? obj.tableData : [['', ''], ['', '']];
    const numRows = rows.length;
    const numCols = Math.max(1, rows[0]?.length || 1);
    const colWidths = new Array(numCols).fill(110);
    rows.forEach((r) => {
      r.forEach((cell, cIdx) => {
        const clean = String(cell ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '☑ ');
        const w = measureVectorTextWidth(clean || ' ', `600 20px ${fontCss}`) + 36;
        if (w > colWidths[cIdx]) colWidths[cIdx] = Math.min(340, Math.round(w));
      });
    });
    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const rowH = 44;
    const tableH = numRows * rowH;
    vbW = Math.max(420, tableW + padX * 2);
    vbH = Math.max(220, headerH + tableH + 36);

    const scaleCol = (vbW - padX * 2) / Math.max(1, tableW);
    let accX = padX;
    for (let rIdx = 0; rIdx < numRows; rIdx++) {
      accX = padX;
      const cellY = headerH + 14 + rIdx * rowH;
      for (let cIdx = 0; cIdx < numCols; cIdx++) {
        const cw = Math.round(colWidths[cIdx] * scaleCol);
        const cellRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        cellRect.setAttribute('x', String(accX));
        cellRect.setAttribute('y', String(cellY));
        cellRect.setAttribute('width', String(cw));
        cellRect.setAttribute('height', String(rowH));
        cellRect.setAttribute('fill', rIdx === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)');
        cellRect.setAttribute('stroke', pal.border);
        cellRect.setAttribute('stroke-width', '1.5');
        contentGroup.appendChild(cellRect);

        const rawStr = String(rows[rIdx]?.[cIdx] ?? '')
          .replace(/^\[(square|circle|toggle):1\]\s?/, '☑ ')
          .replace(/^\[(square|circle|toggle):0\]\s?/, '☐ ');
        const cellKey = `${rIdx}_${cIdx}`;
        const cAlign = obj.cellAligns?.[cellKey] || 'left';
        const anchor = cAlign === 'center' ? 'middle' : cAlign === 'right' ? 'end' : 'start';
        const tx = cAlign === 'center' ? accX + Math.round(cw / 2) : cAlign === 'right' ? accX + cw - 12 : accX + 12;
        addText(rawStr, tx, cellY + 29, 20, { anchor, weight: rIdx === 0 ? '700' : fontWeight });
        accX += cw;
      }
    }
  } else {
    // 'link' or 'file'
    vbW = 480;
    vbH = 190;
    const mainLine = obj.type === 'link' ? (obj.domain || obj.url || '웹 링크') : (obj.fileName || obj.title || '첨부 파일');
    const subLine = obj.type === 'link' ? (obj.description || obj.url || '') : (obj.fileSize ? `${Math.max(1, Math.round(obj.fileSize / 1024))} KB` : '문서 객체');
    addText(mainLine, padX, headerH + 46, 24, { weight: '700' });
    addText(String(subLine).slice(0, 55), padX, headerH + 86, 18, { fill: pal.sub });
  }

  svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
  obj.vectorAspect = Number((vbW / Math.max(1, vbH)).toFixed(4));

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="uvec_bg_${safeId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${pal.bg1}"/>
      <stop offset="100%" stop-color="${pal.bg2}"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('x', '2');
  bgRect.setAttribute('y', '2');
  bgRect.setAttribute('width', String(vbW - 4));
  bgRect.setAttribute('height', String(vbH - 4));
  bgRect.setAttribute('rx', '20');
  bgRect.setAttribute('fill', `url(#uvec_bg_${safeId})`);
  bgRect.setAttribute('stroke', pal.border);
  bgRect.setAttribute('stroke-width', '3');
  svg.appendChild(bgRect);

  // Header separator & title
  const hdrLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  hdrLine.setAttribute('x1', '18');
  hdrLine.setAttribute('y1', String(headerH));
  hdrLine.setAttribute('x2', String(vbW - 18));
  hdrLine.setAttribute('y2', String(headerH));
  hdrLine.setAttribute('stroke', pal.border);
  hdrLine.setAttribute('stroke-width', '1.5');
  svg.appendChild(hdrLine);

  const titleAlign = ['left', 'center', 'right'].includes(obj.titleAlign) ? obj.titleAlign : 'left';
  const tAnchor = titleAlign === 'center' ? 'middle' : titleAlign === 'right' ? 'end' : 'start';
  const titleX = titleAlign === 'center' ? Math.round(vbW / 2) : titleAlign === 'right' ? vbW - padX : padX;
  const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  titleText.textContent = obj.title || (obj.type === 'sticky' ? '📌 포스트잇 메모' : obj.type === 'text' ? '체크리스트 & 노트' : obj.type === 'table' ? '데이터 표' : '객체');
  titleText.setAttribute('x', String(titleX));
  titleText.setAttribute('y', '36');
  titleText.setAttribute('font-family', fontCss);
  titleText.setAttribute('font-size', '21');
  titleText.setAttribute('font-weight', '800');
  titleText.setAttribute('fill', pal.text);
  titleText.setAttribute('text-anchor', tAnchor);
  svg.appendChild(titleText);

  svg.appendChild(contentGroup);
  wrapEl.innerHTML = '';
  wrapEl.appendChild(svg);
}

function toggleObjectVectorized(obj) {
  if (!isVectorizableObject(obj)) return;
  draggingObjState = null;
  resizingObjState = null;

  const domEl = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"]`);
  if (obj.type === 'label') {
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
  } else if (obj.type === 'sticky') {
    const stickyEd = domEl?.querySelector('.ff-sticky-textarea');
    if (stickyEd) {
      const lineDivs = Array.from(stickyEd.querySelectorAll('.ff-text-line'));
      if (lineDivs.length > 0) {
        obj.content = lineDivs.map((ln) => ln.textContent || '').join('\n');
        obj.lineAligns = lineDivs.map((ln) => ln.dataset.align || 'left');
      }
    }
  }

  pushUndoSnapshot(obj.vectorized ? '벡터 이미지 해제 (편집 모드 전환)' : '객체 벡터 이미지화');
  obj.vectorized = !Boolean(obj.vectorized);

  if (obj.vectorized) {
    if (obj.type === 'label') {
      if (!(obj.content || '').trim()) {
        obj.content = obj.title && obj.title !== '텍스트' ? obj.title : '프로젝트 타이틀';
      }
      obj.lineAligns = getLabelDisplayLines(obj).map(() => 'center');
      const m = computeVectorLabelMetrics(obj);
      obj.vectorAspect = m.aspect;
      const baseW = Math.max(200, Math.round(obj.width || 380));
      obj.width = baseW;
      obj.height = Math.max(48, Math.round(baseW / Math.max(0.2, m.aspect)));
    } else {
      const tempWrap = document.createElement('div');
      renderUniversalVectorizedObjectInto(tempWrap, obj);
      const aspect = obj.vectorAspect || (obj.width || 340) / Math.max(1, obj.height || 220);
      const baseW = Math.max(180, Math.round(obj.width || 340));
      obj.width = baseW;
      obj.height = Math.max(90, Math.round(baseW / Math.max(0.2, aspect)));
    }
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
    showToast('✨ 벡터 이미지로 변환되었습니다! 우측 하단 모서리를 드래그해 빈 여백 없이 자유롭게 확대/축소해 보세요 (더블클릭 시 편집 모드)');
  } else {
    const nextEd = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"] .ff-label-editor, .ff-object[data-id="${obj.id}"] .ff-sticky-textarea, .ff-object[data-id="${obj.id}"] .ff-check-input`);
    nextEd?.focus();
    showToast('📝 일반 편집 모드로 전환되었습니다');
  }
}

function toggleLabelVectorized(obj) {
  return toggleObjectVectorized(obj);
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
    const defaultW = (obj.pdfPageAspect || 0) > 1.02 ? 620 : 480;
    const restoredW = Math.max(320, obj.viewerWidth || defaultW);
    syncPdfViewerAspectSize(obj, obj.pdfPageAspect, { width: restoredW });
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
  } else if (obj.type === 'image' || obj.type === 'sticker') {
    const res = await window.freeformAPI.writeClipboardImage({
      filePath: obj.resolvedFilePath,
      dataUrl: obj.stickerSvgUrl || obj.resolvedFileUrl || obj.imageUrl
    });
    if (res && res.ok) {
      flashSuccess(
        obj.type === 'sticker'
          ? '스티커가 클립보드에 복사되었습니다 (Ctrl+V로 붙여넣기 가능)'
          : '이미지가 클립보드에 복사되었습니다 (Ctrl+V로 어디든 붙여넣기 가능)'
      );
    } else {
      await window.freeformAPI.writeClipboardText(obj.resolvedFilePath || obj.title || '');
      flashSuccess(obj.type === 'sticker' ? '스티커 정보가 복사되었습니다' : '이미지 경로가 복사되었습니다');
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

async function copyChecklistFilteredItems(obj, checkedOnly = false, btnEl = null) {
  if (!obj) return;
  const parsed = parseNoteLines(obj.content || '');
  const matched = parsed.filter(
    (it) => it.isCheck && Boolean(it.checked) === Boolean(checkedOnly) && String(it.text || '').trim() !== ''
  );
  if (matched.length === 0) {
    showToast(checkedOnly ? '☑ 복사할 체크 완료 항목이 없습니다' : '☐ 복사할 미체크 항목이 없습니다');
    return;
  }
  const out = matched.map((it) => `${checkedOnly ? '☑' : '☐'} ${it.text.trim()}`).join('\n');
  await window.freeformAPI.writeClipboardText(out);
  if (btnEl) {
    const origHtml = btnEl.innerHTML;
    btnEl.classList.add('copied');
    btnEl.innerHTML = `${SVG_ICONS.check}`;
    setTimeout(() => {
      if (btnEl.isConnected) {
        btnEl.classList.remove('copied');
        btnEl.innerHTML = origHtml;
      }
    }, 1200);
  }
  showToast(
    checkedOnly
      ? `☑ 체크된 항목 ${matched.length}개가 클립보드에 복사되었습니다`
      : `☐ 체크 안 된 항목 ${matched.length}개가 클립보드에 복사되었습니다`
  );
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
  if (!currentBoard.groupNames || typeof currentBoard.groupNames !== 'object') {
    currentBoard.groupNames = {};
  }
  currentBoard.objects.forEach((o) => {
    if (o.groupId && o.groupName && !currentBoard.groupNames[o.groupId]) {
      currentBoard.groupNames[o.groupId] = o.groupName;
    }
  });

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
      '<img src="../../assets/icon.png" alt="BossFreeForm" class="board-brand-icon" draggable="false" />';
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
  clearTableCellSelection();
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
    clearTableCellSelection(objId);
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
  const activeGroupIds = new Set(selected.map((o) => o.groupId).filter(Boolean));
  document.querySelectorAll('.ff-group-frame').forEach((gEl) => {
    gEl.classList.toggle('is-group-selected', activeGroupIds.has(gEl.dataset.groupId));
  });
  const selectedConn = getSelectedConnector();
  const hasSelection = selected.length > 0 || Boolean(selectedConn);

  if (objectInspector) {
    objectInspector.classList.toggle('hidden', !hasSelection);

    const objGroupEl = document.getElementById('inspObjOnlyGroup');
    const typoGroupEl = document.getElementById('inspTypoGroup');
    const connGroupEl = document.getElementById('inspConnOnlyGroup');
    const strokeGroupEl = document.getElementById('inspStrokeOnlyGroup');
    const imgGroupEl = document.getElementById('inspImageOnlyGroup');

    if (selectedConn && selected.length === 0) {
      objGroupEl?.classList.add('hidden');
      typoGroupEl?.classList.add('hidden');
      strokeGroupEl?.classList.add('hidden');
      imgGroupEl?.classList.add('hidden');
      document.getElementById('inspShapeOnlyGroup')?.classList.add('hidden');
      connGroupEl?.classList.remove('hidden');

      const styleLbl = document.getElementById('inspConnStyleLabel');
      if (styleLbl) {
        styleLbl.textContent = selectedConn.style === 'dashed' ? '점선 화살표' : '실선 화살표';
      }
      document.querySelectorAll('#inspectorColors .swatch:not(.random-swatch)').forEach((sw) => {
        sw.classList.toggle(
          'active-swatch',
          (sw.dataset.hex || '').toLowerCase() === (selectedConn.color || '#0a84ff').toLowerCase()
        );
      });
    } else if (selected.length > 0) {
      const primary = selected[selected.length - 1];
      const allStrokes = selected.every((o) => o.type === 'stroke');
      const allImagesOrStickers = selected.every((o) => o.type === 'image' || o.type === 'sticker' || isPdfObject(o));
      const allShapes = selected.every((o) => o.type === 'shape');
      const hasStrokes = selected.some((o) => o.type === 'stroke');
      const hasBorderTargets = selected.some((o) => hasBorderFrameSupport(o));
      const hasAspectTargets = selected.some((o) => o.type === 'image' || o.type === 'sticker');
      const hasShapes = selected.some((o) => o.type === 'shape');
      const hasLabels = selected.some((o) => o.type === 'label');

      objGroupEl?.classList.remove('hidden');
      typoGroupEl?.classList.toggle('hidden', allStrokes || allImagesOrStickers || allShapes);
      strokeGroupEl?.classList.toggle('hidden', !hasStrokes);
      imgGroupEl?.classList.toggle('hidden', !hasBorderTargets);
      connGroupEl?.classList.add('hidden');

      const shapeGroupEl = document.getElementById('inspShapeOnlyGroup');
      shapeGroupEl?.classList.toggle('hidden', !hasShapes);
      if (hasShapes) {
        syncShapeInspectorUI(selected.find((o) => o.type === 'shape') || primary);
      }
      const labelSubEl = document.getElementById('inspLabelStyleSubGroup');
      labelSubEl?.classList.toggle('hidden', !hasLabels);
      if (hasLabels) {
        syncLabelStyleInspectorUI(selected.find((o) => o.type === 'label') || primary);
      }

      if (hasBorderTargets) {
        const borderObj = selected.find((o) => hasBorderFrameSupport(o)) || primary;
        const keepAsp = borderObj.keepAspect !== false;
        const aspBtn = document.getElementById('inspImgAspectBtn');
        const aspLbl = document.getElementById('inspImgAspectLabel');
        if (aspBtn) {
          aspBtn.classList.toggle('hidden', !hasAspectTargets);
          aspBtn.classList.toggle('active-pill', keepAsp);
        }
        if (aspLbl) aspLbl.textContent = keepAsp ? '비율유지 ON' : '비율유지 OFF';

        const bEnabled = Boolean(borderObj.borderEnabled);
        const bBtn = document.getElementById('inspImgBorderToggleBtn');
        const bLbl = document.getElementById('inspImgBorderToggleLabel');
        const bSub = document.getElementById('inspImgBorderSubControls');
        const bWidthSel = document.getElementById('inspImgBorderWidthSelect');
        const bStyleSel = document.getElementById('inspImgBorderStyleSelect');

        if (bBtn) bBtn.classList.toggle('active-pill', bEnabled);
        if (bLbl) bLbl.textContent = bEnabled ? '테두리 ON' : '테두리 OFF';
        if (bSub) bSub.classList.toggle('hidden', !bEnabled);
        if (bWidthSel) bWidthSel.value = String(borderObj.borderWidth || 4);
        if (bStyleSel) bStyleSel.value = borderObj.borderStyle || 'solid';
      }

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

      const allOpaque = selected.every((o) => o.opaque);
      document.getElementById('inspOpacityBtn')?.classList.toggle('active-pill', allOpaque);
      const opLbl = document.getElementById('inspOpacityBtnLabel');
      if (opLbl) opLbl.textContent = allOpaque ? '불투명 ON (클릭: 기본 투명도로)' : '불투명으로 전환';

      const groupLabel = document.getElementById('inspGroupBtnLabel');
      const allSameGroup =
        selected.length >= 1 &&
        selected[0].groupId &&
        selected.every((o) => o.groupId === selected[0].groupId);
      if (groupLabel) {
        groupLabel.textContent = allSameGroup ? '그룹 해제' : `그룹화 (${selected.length})`;
      }
      const groupNameWrap = document.getElementById('inspGroupNameWrap');
      const groupNameInput = document.getElementById('inspGroupNameInput');
      if (groupNameWrap) {
        groupNameWrap.classList.toggle('hidden', !allSameGroup);
      }
      if (groupNameInput && allSameGroup && document.activeElement !== groupNameInput) {
        groupNameInput.value = getGroupName(selected[0].groupId);
      }

      // Sync Typography UI controls to primary selected object (or selected table cell(s))
      const hasActiveTableCells =
        primary.type === 'table' &&
        activeTableCellSelection.objId === primary.id &&
        activeTableCellSelection.cells.size > 0;
      const activeCellKey = hasActiveTableCells
        ? activeTableCellSelection.anchor
          ? `${activeTableCellSelection.anchor.rIdx}_${activeTableCellSelection.anchor.cIdx}`
          : Array.from(activeTableCellSelection.cells)[0]
        : null;
      const ts =
        hasActiveTableCells && activeCellKey
          ? getCellEffectiveTextStyle(primary, activeCellKey)
          : getObjectTextStyle(primary);
      const famSel = document.getElementById('inspFontFamilySelect');
      const sizeSel = document.getElementById('inspFontSizeSelect');
      const artSel = document.getElementById('inspArtStyleSelect');
      const vecBtn = document.getElementById('inspVectorizeBtn');
      const vecLbl = document.getElementById('inspVectorizeBtnLabel');
      const hasLabel = selected.some((o) => o.type === 'label');
      const hasVectorizable = selected.some((o) => isVectorizableObject(o));
      if (famSel) famSel.value = ts.fontFamily;
      if (sizeSel) sizeSel.value = String(ts.fontSize);
      if (artSel) {
        artSel.classList.toggle('hidden', !hasLabel);
        if (hasLabel) {
          artSel.value = primary.artStyle || 'none';
        }
      }
      if (vecBtn) {
        vecBtn.classList.toggle('hidden', !hasVectorizable);
        const isVec = Boolean(primary.vectorized);
        vecBtn.classList.toggle('active-pill', isVec);
        if (vecLbl) vecLbl.textContent = isVec ? '편집 모드 전환' : '벡터 이미지화';
      }
      document.getElementById('inspBoldBtn')?.classList.toggle('active-pill', ts.bold);
      document.getElementById('inspItalicBtn')?.classList.toggle('active-pill', ts.italic);
      document.getElementById('inspUnderlineBtn')?.classList.toggle('active-pill', ts.underline);

      let currentDisplayAlign = 'left';
      if (hasActiveTableCells && activeCellKey) {
        currentDisplayAlign = primary.cellAligns?.[activeCellKey] || 'left';
      } else if (lastActiveAlignTarget && selectedObjectIds.has(lastActiveAlignTarget.obj?.id)) {
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

      document.querySelectorAll('#inspectorColors .swatch:not(.random-swatch)').forEach((sw) => {
        const isMatch =
          hasBorderFrameSupport(primary) && primary.borderEnabled && primary.borderColor
            ? (sw.dataset.hex || '').toLowerCase() === primary.borderColor.toLowerCase()
            : primary.customColor
            ? (sw.dataset.hex || '').toLowerCase() === primary.customColor.toLowerCase()
            : sw.dataset.color === primary.color;
        sw.classList.toggle('active-swatch', isMatch);
      });
    }
  }
}

function syncShapeInspectorUI(shapeObj) {
  if (!shapeObj) return;
  const st = shapeObj.shapeType || 'rect';
  const typeSel = document.getElementById('inspShapeTypeSelect');
  if (typeSel) typeSel.value = st;
  document.getElementById('inspShapePolySidesWrap')?.classList.toggle('hidden', st !== 'polygon');
  const sidesInp = document.getElementById('inspShapePolySidesInput');
  if (sidesInp) sidesInp.value = String(shapeObj.polygonSides || 5);
  const cornerWrap = document.getElementById('inspShapeCornerWrap');
  cornerWrap?.classList.toggle('hidden', st === 'circle');
  const cornerOn = shapeObj.cornerEnabled !== false;
  document.getElementById('inspShapeCornerToggleBtn')?.classList.toggle('active-pill', cornerOn);
  const cornerLbl = document.getElementById('inspShapeCornerToggleLabel');
  if (cornerLbl) cornerLbl.textContent = cornerOn ? '곡률 ON' : '곡률 OFF';
  const cornerInp = document.getElementById('inspShapeCornerRadiusInput');
  if (cornerInp) {
    cornerInp.value = String(shapeObj.cornerRadius ?? 18);
    cornerInp.disabled = !cornerOn;
  }
  const fillOn = shapeObj.fillEnabled !== false;
  document.getElementById('inspShapeFillToggleBtn')?.classList.toggle('active-pill', fillOn);
  const fillLbl = document.getElementById('inspShapeFillToggleLabel');
  if (fillLbl) fillLbl.textContent = fillOn ? '채우기 ON' : '채우기 OFF';
  const resolved = getResolvedObjectColorHex(shapeObj);
  const fillColorInp = document.getElementById('inspShapeFillColorInput');
  if (fillColorInp) {
    fillColorInp.value = /^#[0-9a-f]{6}$/i.test(shapeObj.fillColor || resolved) ? shapeObj.fillColor || resolved : '#0a84ff';
    fillColorInp.classList.toggle('hidden', !fillOn);
  }
  const fillOpSel = document.getElementById('inspShapeFillOpacitySelect');
  if (fillOpSel) {
    fillOpSel.value = String(shapeObj.fillOpacity ?? 0.25);
    fillOpSel.classList.toggle('hidden', !fillOn);
  }
  const bStyleSel = document.getElementById('inspShapeBorderStyleSelect');
  if (bStyleSel) bStyleSel.value = shapeObj.borderStyle || 'solid';
  const bWidthSel = document.getElementById('inspShapeBorderWidthSelect');
  if (bWidthSel) bWidthSel.value = String(shapeObj.borderWidth ?? 3.5);
  const strokeColorInp = document.getElementById('inspShapeStrokeColorInput');
  if (strokeColorInp) {
    strokeColorInp.value = /^#[0-9a-f]{6}$/i.test(shapeObj.strokeColor || resolved) ? shapeObj.strokeColor || resolved : '#0a84ff';
  }
  const isBg = Boolean(shapeObj.shapeBackground);
  document.getElementById('inspShapeBgBtn')?.classList.toggle('active-pill', isBg);
  const bgLbl = document.getElementById('inspShapeBgLabel');
  if (bgLbl) bgLbl.textContent = isBg ? '배경화 ON' : '배경화 OFF';
}

function syncLabelStyleInspectorUI(labelObj) {
  if (!labelObj) return;
  const resolved = getResolvedObjectColorHex(labelObj);
  const bgOn = Boolean(labelObj.labelBgEnabled);
  document.getElementById('inspLabelFillToggleBtn')?.classList.toggle('active-pill', bgOn);
  const fillLbl = document.getElementById('inspLabelFillToggleLabel');
  if (fillLbl) fillLbl.textContent = bgOn ? '박스 채우기 ON' : '박스 채우기 OFF';
  const fillInp = document.getElementById('inspLabelFillColorInput');
  if (fillInp) {
    const hex = labelObj.labelBgColor || '#1c1c22';
    fillInp.value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#1c1c22';
    fillInp.classList.toggle('hidden', !bgOn);
  }
  const bgOpSel = document.getElementById('inspLabelBgOpacitySelect');
  if (bgOpSel) {
    bgOpSel.value = String(labelObj.labelBgOpacity ?? 0.85);
    bgOpSel.classList.toggle('hidden', !bgOn);
  }
  const boxOn = Boolean(labelObj.labelBoxBorderEnabled);
  document.getElementById('inspLabelBoxBorderToggleBtn')?.classList.toggle('active-pill', boxOn);
  const boxLbl = document.getElementById('inspLabelBoxBorderToggleLabel');
  if (boxLbl) boxLbl.textContent = boxOn ? '박스 테두리 ON' : '박스 테두리 OFF';
  const boxColorInp = document.getElementById('inspLabelBoxBorderColorInput');
  if (boxColorInp) {
    const bc = labelObj.labelBoxBorderColor || '#0a84ff';
    boxColorInp.value = /^#[0-9a-f]{6}$/i.test(bc) ? bc : '#0a84ff';
    boxColorInp.classList.toggle('hidden', !boxOn);
  }
  const boxWSel = document.getElementById('inspLabelBoxBorderWidthSelect');
  if (boxWSel) {
    boxWSel.value = String(labelObj.labelBoxBorderWidth || 2);
    boxWSel.classList.toggle('hidden', !boxOn);
  }
  const boxSSel = document.getElementById('inspLabelBoxBorderStyleSelect');
  if (boxSSel) {
    boxSSel.value = labelObj.labelBoxBorderStyle || 'solid';
    boxSSel.classList.toggle('hidden', !boxOn);
  }
  void resolved;
  const strokeOn = Boolean(labelObj.labelStrokeEnabled);
  document.getElementById('inspLabelStrokeToggleBtn')?.classList.toggle('active-pill', strokeOn);
  const strokeLbl = document.getElementById('inspLabelStrokeToggleLabel');
  if (strokeLbl) strokeLbl.textContent = strokeOn ? '외곽선 ON' : '외곽선 OFF';
  const strokeInp = document.getElementById('inspLabelStrokeColorInput');
  if (strokeInp) {
    strokeInp.value = /^#[0-9a-f]{6}$/i.test(labelObj.labelStrokeColor || '') ? labelObj.labelStrokeColor : '#111115';
    strokeInp.classList.toggle('hidden', !strokeOn);
  }
  const strokeWSel = document.getElementById('inspLabelStrokeWidthSelect');
  if (strokeWSel) {
    strokeWSel.value = String(labelObj.labelStrokeWidth || 6);
    strokeWSel.classList.toggle('hidden', !strokeOn);
  }
}

function toggleShapeBackgroundMode(obj) {
  if (!obj || obj.type !== 'shape') return;
  pushUndoSnapshot(obj.shapeBackground ? '도형 배경화 해제' : '도형 배경화');
  obj.shapeBackground = !Boolean(obj.shapeBackground);
  draggingObjState = null;
  resizingObjState = null;
  if (obj.shapeBackground) {
    selectedObjectIds.delete(obj.id);
  }
  renderAllObjects();
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(
    obj.shapeBackground
      ? '🧱 도형이 배경화되었습니다 (도형 상단에 마우스를 올리면 나타나는 배경화 버튼으로만 해제 가능)'
      : '도형 배경화가 해제되어 다시 선택·이동·편집할 수 있습니다'
  );
}

function getGroupName(groupId) {
  if (!groupId || !currentBoard) return '그룹';
  if (currentBoard.groupNames && currentBoard.groupNames[groupId]) {
    return currentBoard.groupNames[groupId];
  }
  const member = (currentBoard.objects || []).find((o) => o.groupId === groupId && o.groupName);
  return member?.groupName || '그룹';
}

function setGroupName(groupId, newName) {
  if (!groupId || !currentBoard) return;
  if (!currentBoard.groupNames || typeof currentBoard.groupNames !== 'object') {
    currentBoard.groupNames = {};
  }
  const clean = String(newName || '').trim() || '그룹';
  currentBoard.groupNames[groupId] = clean;
  (currentBoard.objects || []).forEach((o) => {
    if (o.groupId === groupId) o.groupName = clean;
  });
  document.querySelectorAll(`.ff-object .ff-group-badge[data-group-id="${groupId}"] span`).forEach((sp) => {
    sp.textContent = clean;
  });
  const frameInp = objectLayer?.querySelector(`.ff-group-frame[data-group-id="${groupId}"] .ff-group-name-input`);
  if (frameInp && document.activeElement !== frameInp) {
    frameInp.value = clean;
  }
  const inspInp = document.getElementById('inspGroupNameInput');
  if (inspInp && document.activeElement !== inspInp) {
    const sel = getSelectedObjects();
    if (sel.length > 0 && sel[0].groupId === groupId) {
      inspInp.value = clean;
    }
  }
}

function updateGroupFramesDOM() {
  if (!objectLayer || !currentBoard) return;
  const groupsMap = new Map();
  (currentBoard.objects || []).forEach((o) => {
    if (!o.groupId) return;
    if (!groupsMap.has(o.groupId)) groupsMap.set(o.groupId, []);
    groupsMap.get(o.groupId).push(o);
  });

  objectLayer.querySelectorAll('.ff-group-frame').forEach((frameEl) => {
    const gid = frameEl.dataset.groupId;
    const members = groupsMap.get(gid);
    if (!members || members.length === 0) {
      frameEl.remove();
      return;
    }
    const minX = Math.min(...members.map((m) => m.x || 0)) - 14;
    const minY = Math.min(...members.map((m) => m.y || 0)) - 22;
    const maxX = Math.max(...members.map((m) => (m.x || 0) + (m.width || 300))) + 14;
    const maxY = Math.max(...members.map((m) => (m.y || 0) + (m.height || 200))) + 14;
    frameEl.style.left = `${Math.round(minX)}px`;
    frameEl.style.top = `${Math.round(minY)}px`;
    frameEl.style.width = `${Math.max(120, Math.round(maxX - minX))}px`;
    frameEl.style.height = `${Math.max(80, Math.round(maxY - minY))}px`;
  });
}

function renderGroupFrames() {
  if (!objectLayer || !currentBoard) return;
  objectLayer.querySelectorAll('.ff-group-frame').forEach((el) => el.remove());

  const groupsMap = new Map();
  (currentBoard.objects || []).forEach((o) => {
    if (!o.groupId) return;
    if (!groupsMap.has(o.groupId)) groupsMap.set(o.groupId, []);
    groupsMap.get(o.groupId).push(o);
  });

  const activeGroupIds = new Set(getSelectedObjects().map((o) => o.groupId).filter(Boolean));

  groupsMap.forEach((members, gid) => {
    if (!members.length) return;
    const minX = Math.min(...members.map((m) => m.x || 0)) - 14;
    const minY = Math.min(...members.map((m) => m.y || 0)) - 22;
    const maxX = Math.max(...members.map((m) => (m.x || 0) + (m.width || 300))) + 14;
    const maxY = Math.max(...members.map((m) => (m.y || 0) + (m.height || 200))) + 14;

    const frameEl = document.createElement('div');
    frameEl.className = `ff-group-frame ${activeGroupIds.has(gid) ? 'is-group-selected' : ''}`;
    frameEl.dataset.groupId = gid;
    frameEl.style.left = `${Math.round(minX)}px`;
    frameEl.style.top = `${Math.round(minY)}px`;
    frameEl.style.width = `${Math.max(120, Math.round(maxX - minX))}px`;
    frameEl.style.height = `${Math.max(80, Math.round(maxY - minY))}px`;

    const nameBar = document.createElement('div');
    nameBar.className = 'ff-group-name-bar';
    nameBar.title = '드래그하여 그룹 전체 이동 · 그룹 이름을 클릭하여 수정';

    const iconSpan = document.createElement('span');
    iconSpan.style.display = 'inline-flex';
    iconSpan.innerHTML = SVG_ICONS.group;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ff-group-name-input';
    nameInput.value = getGroupName(gid);
    nameInput.placeholder = '그룹 이름...';
    nameInput.spellcheck = false;

    nameInput.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelectedObjectIds(members.map((m) => m.id));
    });
    nameInput.addEventListener('input', () => {
      setGroupName(gid, nameInput.value);
      scheduleSaveBoard();
      if (isCanvasSearchOpen()) performCanvasUnifiedSearch(getCanvasSearchQuery(), { preserveIndex: true });
    });
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        nameInput.blur();
      }
    });

    const countTag = document.createElement('span');
    countTag.className = 'ff-group-count-tag';
    countTag.textContent = `(${members.length})`;

    nameBar.appendChild(iconSpan);
    nameBar.appendChild(nameInput);
    nameBar.appendChild(countTag);

    nameBar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === nameInput) return;
      e.stopPropagation();
      setSelectedObjectIds(members.map((m) => m.id));
      const startWorld = screenToWorld(e.clientX, e.clientY);
      const dragItems = members
        .filter((m) => !m.locked)
        .map((m) => ({
          obj: m,
          el: objectLayer.querySelector(`.ff-object[data-id="${m.id}"]`),
          origX: m.x,
          origY: m.y
        }));
      if (dragItems.length > 0) {
        document.body.classList.add('is-dragging-object');
        draggingObjState = {
          startWorldX: startWorld.x,
          startWorldY: startWorld.y,
          items: dragItems,
          snapshotBefore: createBoardSnapshot('그룹 이동')
        };
      }
    });

    frameEl.appendChild(nameBar);
    objectLayer.prepend(frameEl);
  });
}

function toggleGroupSelectedObjects() {
  const selected = getSelectedObjects();
  if (selected.length === 0) return;

  const firstGroupId = selected[0].groupId;
  const allSameGroup = firstGroupId && selected.every((o) => o.groupId === firstGroupId);

  if (allSameGroup) {
    pushUndoSnapshot('그룹 해제');
    if (currentBoard.groupNames) {
      delete currentBoard.groupNames[firstGroupId];
    }
    currentBoard.objects.forEach((o) => {
      if (o.groupId === firstGroupId) {
        delete o.groupId;
        delete o.groupName;
      }
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
    const existingGroupIds = new Set((currentBoard.objects || []).map((o) => o.groupId).filter(Boolean));
    const defaultGroupName = `그룹 ${existingGroupIds.size + 1}`;
    selected.forEach((o) => {
      o.groupId = newGroupId;
      o.groupName = defaultGroupName;
    });
    setGroupName(newGroupId, defaultGroupName);
    renderAllObjects();
    syncSelectionUI();
    scheduleSaveBoard();
    showToast(`📁 '${defaultGroupName}'(${selected.length}개 객체)이 생성되었습니다! 상단에서 그룹 이름을 변경할 수 있습니다.`);
    setTimeout(() => {
      const frameInp = objectLayer?.querySelector(`.ff-group-frame[data-group-id="${newGroupId}"] .ff-group-name-input`);
      if (frameInp) {
        frameInp.focus();
        frameInp.select();
      }
    }, 40);
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
  // Strip Windows CR characters (pasted text) so "[square:0] text\r" is still recognized as a checklist line
  const lines = String(rawContent ?? '').replace(/\r/g, '').split('\n');
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

// Converts the block-selected lines (split ONLY by real Enter line breaks, never by visual auto-wrap)
// inside a sticky note or a checklist's bottom free-memo area into checklist items of the given style.
// Returns true when a conversion actually happened.
function convertSelectedLinesToChecklist(obj, style = 'square', savedRange = null) {
  if (!obj || (obj.type !== 'sticky' && obj.type !== 'text')) return false;
  const domEl = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"]`);
  if (!domEl) return false;

  let range = savedRange;
  if (!range) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) range = sel.getRangeAt(0);
  }
  if (!range || range.collapsed) return false;

  const editor =
    obj.type === 'sticky' ? domEl.querySelector('.ff-sticky-textarea') : domEl.querySelector('.ff-note-memo-area');
  if (!editor || !editor.contains(range.commonAncestorContainer)) return false;

  const lines = Array.from(editor.querySelectorAll('.ff-text-line'));
  if (!lines.length) return false;

  let picked = lines.filter((ln) => {
    try {
      return range.intersectsNode(ln);
    } catch (_) {
      return false;
    }
  });
  // Ignore a trailing line where the selection merely ends at its very first character
  if (picked.length > 1) {
    const lastLn = picked[picked.length - 1];
    try {
      const probe = document.createRange();
      probe.selectNodeContents(lastLn);
      probe.setEnd(range.endContainer, range.endOffset);
      if (!probe.toString()) picked = picked.slice(0, -1);
    } catch (_) {}
  }
  if (!picked.length) return false;

  const cleanText = (ln) => String(ln.textContent || '').replace(/[\u200b\r]/g, '');
  const pickedSet = new Set(picked);
  // A single line element can still contain real line breaks (e.g. pasted text) -> split them into separate items
  const newChecks = [];
  picked.forEach((ln) => {
    cleanText(ln)
      .split('\n')
      .forEach((part) => {
        if (part.trim() !== '') {
          newChecks.push({ isCheck: true, style, checked: false, align: ln.dataset.align || 'left', text: part });
        }
      });
  });
  if (!newChecks.length) return false;

  const remaining = lines.filter((ln) => !pickedSet.has(ln));
  let remainingTexts = [];
  let remainingAligns = [];
  remaining.forEach((ln) => {
    cleanText(ln)
      .split('\n')
      .forEach((part) => {
        remainingTexts.push(part);
        remainingAligns.push(ln.dataset.align || 'left');
      });
  });
  while (remainingTexts.length && !remainingTexts[remainingTexts.length - 1].trim()) {
    remainingTexts.pop();
    remainingAligns.pop();
  }

  pushUndoSnapshot(`선택 텍스트 ${newChecks.length}줄 체크리스트화`);

  const existingChecks =
    obj.type === 'text'
      ? parseNoteLines(obj.content || '').filter((it) => it.isCheck && String(it.text || '').trim() !== '')
      : [];

  if (obj.type === 'sticky') {
    obj.type = 'text';
    if (!obj.title || obj.title === '📌 포스트잇 메모') obj.title = '체크리스트 & 노트';
    delete obj.lineAligns;
  }

  const items = [
    ...existingChecks,
    ...newChecks,
    ...remainingTexts.map((t) => ({ isCheck: false, text: t }))
  ];
  obj.content = serializeNoteLines(items);
  obj.memoLineAligns = remainingAligns;

  window.getSelection()?.removeAllRanges();
  renderAllObjects();
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(`☑ 선택한 ${newChecks.length}줄을 체크리스트 항목으로 변환했습니다`);
  return true;
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
      if (obj.opaque) applyOpaqueModeToElement(el);
    } catch (err) {
      console.error('Failed to render object:', obj?.id, err);
    }
  });
  renderGroupFrames();
  if (typeof isCanvasSearchOpen === 'function' && isCanvasSearchOpen()) {
    applyCanvasSearchHighlights();
  }
}

// Converts every translucent rgba() in the card's computed background into a solid rgb() (alpha=1).
// Fully transparent layers (alpha≈0) are left untouched so borderless objects never turn black.
function toOpaqueColorString(str) {
  return String(str || '').replace(
    /rgba\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*([\d.]+)\s*\)/g,
    (m, r, g, b, a) => (Number(a) < 0.02 ? m : `rgb(${r}, ${g}, ${b})`)
  );
}

function applyOpaqueModeToElement(el) {
  if (!el || !el.isConnected) return;
  el.classList.add('is-opaque');
  const cs = getComputedStyle(el);
  const bgImg = cs.backgroundImage;
  const bgColor = cs.backgroundColor;
  if (bgImg && bgImg !== 'none' && /rgba\(/.test(bgImg)) {
    el.style.setProperty('background-image', toOpaqueColorString(bgImg), 'important');
  }
  if (bgColor && /rgba\(/.test(bgColor)) {
    el.style.setProperty('background-color', toOpaqueColorString(bgColor), 'important');
  }
}

function toggleSelectedObjectsOpacity() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const next = !selected.every((o) => o.opaque);
  pushUndoSnapshot(next ? '객체 불투명 전환' : '객체 기본 투명도 전환');
  selected.forEach((o) => {
    o.opaque = next;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(next ? '◼ 선택 객체를 불투명으로 전환했습니다' : '◻ 선택 객체를 기본 투명도로 되돌렸습니다');
}

function createObjectDOM(obj) {
  const el = document.createElement('div');
  const isSelected = selectedObjectIds.has(obj.id);
  const isPdf = isPdfObject(obj);
  const pdfViewerClass = isPdf && (obj.pdfViewMode || 'viewer') === 'viewer' ? 'is-pdf-viewer' : '';
  const artClass = obj.type === 'label' ? `art-${obj.artStyle || 'none'}` : '';
  const vecClass = obj.vectorized ? 'is-vectorized' : '';
  const bgShapeClass = obj.type === 'shape' && obj.shapeBackground ? 'is-background-shape' : '';
  el.className = `ff-object type-${obj.type || 'sticky'} ${isPdf ? 'is-pdf' : ''} ${pdfViewerClass} ${artClass} ${vecClass} ${bgShapeClass} color-${obj.color || 'dark'} ${isSelected ? 'selected' : ''}`;
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
    obj.type === 'sticky' ? '📌 포스트잇 메모' : obj.type === 'label' ? '텍스트' : obj.type === 'sticker' ? '스티커' : '제목 입력...';
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
    if (typeof isCanvasSearchOpen === 'function' && isCanvasSearchOpen()) {
      performCanvasUnifiedSearch(document.getElementById('canvasSearchInput')?.value || '', { preserveIndex: true });
    }
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
    const grpName = getGroupName(obj.groupId);
    const grpBadge = document.createElement('span');
    grpBadge.className = 'ff-group-badge';
    grpBadge.dataset.groupId = obj.groupId;
    grpBadge.innerHTML = `${SVG_ICONS.group} <span>${escapeHtml(grpName)}</span>`;
    grpBadge.title = `그룹 "${grpName}" (클릭 시 그룹 전체 선택)`;
    grpBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      selectObject(obj.id, { additive: false });
      renderAllConnectors();
    });
    headerActions.appendChild(grpBadge);
  }

  // Universal Vectorize Icon Button (SVG + hover tooltip) for all vectorizable objects
  if (isVectorizableObject(obj)) {
    const vectorizeBtn = document.createElement('button');
    vectorizeBtn.className = `ff-obj-icon-btn ff-vectorize-btn ${obj.vectorized ? 'is-active' : ''}`;
    vectorizeBtn.innerHTML = `${SVG_ICONS.vectorize}<span>${obj.vectorized ? '편집 모드 전환' : '벡터 이미지화'}</span>`;
    vectorizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleObjectVectorized(obj);
    });
    headerActions.appendChild(vectorizeBtn);
  }

  // Graphic Art Style Cycle Button for 'label' (텍스트·타이틀) objects
  if (obj.type === 'label') {
    const curArt = ART_STYLE_LIST.find((a) => a.id === (obj.artStyle || 'none')) || ART_STYLE_LIST[0];
    const artCycleBtn = document.createElement('button');
    artCycleBtn.className = `ff-obj-icon-btn ff-art-cycle-btn ${(obj.artStyle || 'none') !== 'none' ? 'is-active' : ''}`;
    artCycleBtn.innerHTML = `${SVG_ICONS.sparkle}<span>스타일: ${curArt.label}</span>`;
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

  // Shape Background-Mode Toggle Button (the ONLY interactive element while a shape is backgrounded)
  if (obj.type === 'shape') {
    const bgBtn = document.createElement('button');
    bgBtn.className = `ff-obj-icon-btn ff-shape-bg-btn ${obj.shapeBackground ? 'is-active' : ''}`;
    bgBtn.innerHTML = `${SVG_ICONS.bgLayer}<span>${obj.shapeBackground ? '배경화 해제' : '배경화 (내부 상호작용 끄기)'}</span>`;
    bgBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    bgBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleShapeBackgroundMode(obj);
    });
    headerActions.appendChild(bgBtn);
  }

  // Image & Sticker Aspect Ratio Lock Toggle Button in Header
  if (obj.type === 'image' || obj.type === 'sticker') {
    const keepAsp = obj.keepAspect !== false;
    const aspectBtn = document.createElement('button');
    aspectBtn.className = `ff-obj-icon-btn ${keepAsp ? 'is-active' : ''}`;
    aspectBtn.innerHTML = `${SVG_ICONS.aspectRatio}<span>${keepAsp ? '비율유지 ON' : '비율유지 OFF (자유비율)'}</span>`;
    aspectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndoSnapshot('비율유지 토글');
      obj.keepAspect = obj.keepAspect === false ? true : false;
      if (obj.keepAspect && obj.imageAspect) {
        obj.height = Math.max(48, Math.round(obj.width / obj.imageAspect));
      }
      renderAllObjects();
      renderAllConnectors();
      syncSelectionUI();
      scheduleSaveBoard();
      showToast(obj.keepAspect ? '📐 비율유지 ON (원본 비율대로 크기 조절)' : '↔️ 비율유지 OFF (자유 비율로 크기 조절)');
    });
    headerActions.appendChild(aspectBtn);
  }

  // Border / Outline Toggle Button for Image, Sticker, and PDF Objects
  if (hasBorderFrameSupport(obj)) {
    const borderBtn = document.createElement('button');
    borderBtn.className = `ff-obj-icon-btn ${obj.borderEnabled ? 'is-active' : ''}`;
    borderBtn.innerHTML = `${SVG_ICONS.borderFrame}<span>${obj.borderEnabled ? '외곽선 ON' : '외곽선 OFF'}</span>`;
    borderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndoSnapshot('외곽선 토글');
      obj.borderEnabled = !Boolean(obj.borderEnabled);
      if (obj.borderEnabled && !obj.borderColor) {
        obj.borderColor = obj.customColor || '#0a84ff';
      }
      renderAllObjects();
      syncSelectionUI();
      scheduleSaveBoard();
      showToast(obj.borderEnabled ? '🖼️ 외곽선(테두리) ON' : '외곽선(테두리) OFF');
    });
    headerActions.appendChild(borderBtn);
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

  // Checklist Filtered Copy Buttons (Unchecked-only copy & Checked-only copy) in Header
  if (obj.type === 'text') {
    const copyUncheckedBtn = document.createElement('button');
    copyUncheckedBtn.className = 'ff-header-copy-btn ff-chk-copy-filter-btn';
    copyUncheckedBtn.title = '체크 안 된(미완료) 항목만 복사';
    copyUncheckedBtn.innerHTML = `${SVG_ICONS.copyUnchecked}<span>미체크</span>`;
    copyUncheckedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyChecklistFilteredItems(obj, false, copyUncheckedBtn);
    });
    headerActions.appendChild(copyUncheckedBtn);

    const copyCheckedBtn = document.createElement('button');
    copyCheckedBtn.className = 'ff-header-copy-btn ff-chk-copy-filter-btn';
    copyCheckedBtn.title = '체크된(완료) 항목만 복사';
    copyCheckedBtn.innerHTML = `${SVG_ICONS.copyChecked}<span>체크됨</span>`;
    copyCheckedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyChecklistFilteredItems(obj, true, copyCheckedBtn);
    });
    headerActions.appendChild(copyCheckedBtn);
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

  if (obj.vectorized && obj.type !== 'label') {
    const uWrap = document.createElement('div');
    uWrap.className = 'ff-universal-vector-wrap';
    renderUniversalVectorizedObjectInto(uWrap, obj);
    uWrap.title = '드래그: 이동 · 우측 하단 모서리 드래그: 크기 자유 확대/축소 (Shift+드래그: 비율 자유 변형) · 더블클릭: 편집 모드 전환';
    uWrap.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      toggleObjectVectorized(obj);
    });
    body.appendChild(uWrap);
  } else if (obj.type === 'sticky') {
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

    // Compact checklist bar (shown only while selected): converts block-selected lines into checklist items
    const stickyBar = document.createElement('div');
    stickyBar.className = 'ff-note-toolbar ff-sticky-chk-bar';
    stickyBar.innerHTML = `
      <button class="ff-chk-Insert-btn" data-chk="square" title="선택한 줄을 네모 체크리스트로 변환 (선택 없으면 체크 항목 추가)">${SVG_ICONS.chkSquare}<span>네모체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="circle" title="선택한 줄을 원형 체크리스트로 변환 (선택 없으면 체크 항목 추가)">${SVG_ICONS.chkCircle}<span>원형체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="toggle" title="선택한 줄을 슬라이드 토글로 변환 (선택 없으면 토글 항목 추가)">${SVG_ICONS.chkToggle}<span>슬라이드</span></button>
    `;
    stickyBar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ff-chk-Insert-btn')) e.preventDefault();
    });
    stickyBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.ff-chk-Insert-btn');
      if (!btn) return;
      e.stopPropagation();
      const kind = btn.dataset.chk || 'square';
      if (!convertSelectedLinesToChecklist(obj, kind)) {
        appendCheckItemToNote(obj, kind, '');
      }
    });
    el.appendChild(stickyBar);
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
        toggleObjectVectorized(obj);
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
  } else if (obj.type === 'shape') {
    // ========================================================================
    // 1-D. DEDICATED SHAPE OBJECT (도형: 사각형/삼각형/원형/타원형/다각형)
    // ========================================================================
    const shapeWrap = document.createElement('div');
    shapeWrap.className = 'ff-shape-wrap';
    renderShapeObjectInto(shapeWrap, obj);
    body.appendChild(shapeWrap);
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
    // 2. CHECKLIST & STRUCTURED NOTE CARD (체크리스트): Auto-Wrap + Font Size Persistence
    // ========================================================================
    const isAutoWrap = obj.checkAutoWrap !== false;
    const noteBar = document.createElement('div');
    noteBar.className = 'ff-note-toolbar';
    noteBar.innerHTML = `
      <button class="ff-chk-Insert-btn" data-chk="square" title="네모 체크박스 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkSquare}<span>네모체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="circle" title="원형 체크박스 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkCircle}<span>원형체크</span></button>
      <button class="ff-chk-Insert-btn" data-chk="toggle" title="슬라이드 토글 항목 추가 (빈 줄에선 모양 변경)">${SVG_ICONS.chkToggle}<span>슬라이드</span></button>
      <button class="ff-chk-Insert-btn" data-chk="memo" title="하단 자유 메모 입력란으로 포커스 이동">${SVG_ICONS.plus}<span>자유메모</span></button>
      <button class="ff-chk-Insert-btn ${isAutoWrap ? 'is-active' : ''}" data-chk="autowrap" title="체크리스트 자동줄바꿈 ON/OFF (긴 문장을 다음 항목으로 분리하지 않고 줄바꿈 표시)">${SVG_ICONS.wrapText}<span>자동줄바꿈</span></button>
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

    const getCheckRowText = (inputEl) => {
      if (!inputEl) return '';
      if (typeof inputEl.value === 'string') return inputEl.value;
      return String(inputEl.textContent || '').replace(/\r?\n/g, ' ');
    };

    const setCheckRowText = (inputEl, val = '') => {
      if (!inputEl) return;
      const clean = String(val ?? '').replace(/\r?\n/g, ' ');
      if (typeof inputEl.value === 'string') {
        inputEl.value = clean;
      } else {
        inputEl.textContent = clean;
      }
    };

    const syncChecklistAndMemoToObj = () => {
      const serializedLines = [];
      checklistContainer.querySelectorAll('.ff-check-row').forEach((r) => {
        const st = r.dataset.style || 'square';
        const ck = r.dataset.checked === '1' ? '1' : '0';
        const al = r.dataset.align && r.dataset.align !== 'left' ? `:${r.dataset.align}` : '';
        const val = getCheckRowText(r.querySelector('.ff-check-input'));
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
        applyObjectTypography(el, obj);
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

      const input = document.createElement('div');
      input.contentEditable = 'true';
      input.className = `ff-check-input ${obj.checkAutoWrap === false ? 'nowrap-mode' : ''}`;
      setCheckRowText(input, text || '');
      input.style.textAlign = normAlign;
      input.dataset.placeholder = '할 일 입력 (Enter: 항목 추가, 자동줄바꿈 지원)...';
      input.spellcheck = false;

      // Immediately apply current object typography so newly created rows always inherit font size & family!
      const curTs = getObjectTextStyle(obj);
      input.style.fontFamily = FONT_FAMILY_STACKS[curTs.fontFamily] || FONT_FAMILY_STACKS.default;
      input.style.fontSize = `${curTs.fontSize}px`;
      input.style.fontWeight = curTs.bold ? '800' : '400';
      input.style.fontStyle = curTs.italic ? 'italic' : 'normal';
      input.style.textDecoration = checked
        ? curTs.underline
          ? 'underline line-through'
          : 'line-through'
        : curTs.underline
        ? 'underline'
        : 'none';

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

      input.addEventListener('paste', (e) => {
        const pasted = e.clipboardData?.getData('text/plain');
        if (typeof pasted !== 'string') return;
        e.preventDefault();
        e.stopPropagation();
        const singleLine = pasted.replace(/\r?\n/g, ' ');
        document.execCommand('insertText', false, singleLine);
        syncChecklistAndMemoToObj();
      });

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
          const fullStr = getCheckRowText(input);
          const pos = getCaretOffsetInLine(input);
          const beforeText = fullStr.slice(0, pos);
          const afterText = fullStr.slice(pos);
          setCheckRowText(input, beforeText);

          const newRow = createCheckRowDOM({
            style: row.dataset.style || 'square',
            checked: false,
            align: row.dataset.align || 'left',
            text: afterText
          });
          row.after(newRow);
          applyObjectTypography(el, obj);
          syncChecklistAndMemoToObj();
          const newInput = newRow.querySelector('.ff-check-input');
          if (newInput) {
            newInput.focus();
            setCaretOffsetInLine(newInput, 0);
          }
        } else if (e.key === 'Backspace') {
          const sel = window.getSelection();
          const caretPos = getCaretOffsetInLine(input);
          if (sel && sel.isCollapsed && caretPos === 0) {
            const allRows = Array.from(checklistContainer.querySelectorAll('.ff-check-row'));
            const idx = allRows.indexOf(row);
            const curVal = getCheckRowText(input);
            if (idx > 0) {
              e.preventDefault();
              const prevRow = allRows[idx - 1];
              const prevInput = prevRow.querySelector('.ff-check-input');
              const prevVal = getCheckRowText(prevInput);
              const prevLen = prevVal.length;
              setCheckRowText(prevInput, prevVal + curVal);
              row.remove();
              syncChecklistAndMemoToObj();
              prevInput.focus();
              setCaretOffsetInLine(prevInput, prevLen);
            } else if (curVal === '') {
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

    // Keep the block selection in the free-memo area alive while pressing checklist buttons
    noteBar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ff-chk-Insert-btn')) e.preventDefault();
    });

    noteBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.ff-chk-Insert-btn');
      if (!btn) return;
      e.stopPropagation();
      const kind = btn.dataset.chk;
      if (['square', 'circle', 'toggle'].includes(kind) && convertSelectedLinesToChecklist(obj, kind)) {
        return;
      }
      if (kind === 'autowrap') {
        obj.checkAutoWrap = obj.checkAutoWrap === false ? true : false;
        const wrapOn = obj.checkAutoWrap !== false;
        btn.classList.toggle('is-active', wrapOn);
        checklistContainer.querySelectorAll('.ff-check-input').forEach((inp) => {
          inp.classList.toggle('nowrap-mode', !wrapOn);
        });
        scheduleSaveBoard();
        showToast(wrapOn ? '↩️ 체크리스트 자동줄바꿈 ON (항목 분리 없이 줄바꿈 표시)' : '➡️ 체크리스트 자동줄바꿈 OFF (한 줄 표시)');
        return;
      }
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
        if (candidateRow && candidateInput && getCheckRowText(candidateInput).trim() === '') {
          applyRowStyle(candidateRow, kind);
          candidateInput.focus();
          return;
        }
        pushUndoSnapshot('체크박스 항목 추가');
        const newRow = createCheckRowDOM({ style: kind, checked: false, text: '' });
        checklistContainer.appendChild(newRow);
        applyObjectTypography(el, obj);
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
      <button class="ff-table-btn" data-act="sel-all" title="표의 모든 셀 일괄 선택 (드래그 또는 Shift+클릭으로도 범위 선택 가능)">${SVG_ICONS.check}<span>전체선택</span></button>
      <button class="ff-table-btn" data-act="chk-square" title="선택된 셀에 네모 체크박스 넣기">${SVG_ICONS.chkSquare}<span>네모</span></button>
      <button class="ff-table-btn" data-act="chk-circle" title="선택된 셀에 원형 체크박스 넣기">${SVG_ICONS.chkCircle}<span>원형</span></button>
      <button class="ff-table-btn" data-act="chk-toggle" title="선택된 셀에 슬라이드 버튼 넣기">${SVG_ICONS.chkToggle}<span>슬라이드</span></button>
      <button class="ff-table-btn" data-act="copy-tsv" title="구글 시트나 엑셀에 바로 붙여넣을 수 있도록 복사">${SVG_ICONS.copy}<span>시트복사</span></button>
      <button class="ff-table-btn" data-act="export-csv" title="엑셀 CSV 파일로 저장">${SVG_ICONS.download}<span>엑셀저장</span></button>
      <span class="ff-table-sel-badge hidden"></span>
    `;
    tBar.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.ff-table-btn')) ev.preventDefault();
    });
    el.appendChild(tBar);

    const wrap = document.createElement('div');
    wrap.className = 'ff-table-wrap';

    const selectCellRange = (r1, c1, r2, c2, keepAnchor = true) => {
      const minR = Math.max(0, Math.min(r1, r2));
      const maxR = Math.min(obj.tableData.length - 1, Math.max(r1, r2));
      const maxCols = (obj.tableData[0]?.length || 1) - 1;
      const minC = Math.max(0, Math.min(c1, c2));
      const maxC = Math.min(maxCols, Math.max(c1, c2));
      activeTableCellSelection.objId = obj.id;
      if (!keepAnchor || !activeTableCellSelection.anchor) {
        activeTableCellSelection.anchor = { rIdx: r1, cIdx: c1 };
      }
      activeTableCellSelection.cells.clear();
      for (let rr = minR; rr <= maxR; rr++) {
        for (let cc = minC; cc <= maxC; cc++) {
          activeTableCellSelection.cells.add(`${rr}_${cc}`);
        }
      }
      updateTableCellSelectionDOM(obj.id);
      syncSelectionUI();
    };

    const renderTableGrid = () => {
      const table = document.createElement('table');
      table.className = 'ff-table';
      obj.tableData.forEach((row, rIdx) => {
        const tr = document.createElement('tr');
        row.forEach((cellVal, cIdx) => {
          const td = document.createElement('td');
          const cellKey = `${rIdx}_${cIdx}`;
          td.dataset.cellKey = cellKey;
          td.dataset.rIdx = String(rIdx);
          td.dataset.cIdx = String(cIdx);
          const cellAlign = obj.cellAligns?.[cellKey] || 'left';
          td.style.textAlign = cellAlign;
          const rawStr = String(cellVal ?? '');
          const chkMatch = rawStr.match(/^\[(square|circle|toggle):(0|1)\]\s?(.*)$/);

          const registerCellAlignTarget = (ev = null) => {
            lastFocusedTableCell = { obj, rIdx, cIdx, renderTableGrid };
            lastActiveAlignTarget = {
              kind: 'table-cell',
              obj,
              rIdx,
              cIdx,
              tdEl: td
            };
            // Never wipe out an active multi-cell selection on mouseup/focus/keyup!
            // Single-cell click reset is already handled in pointerdown.
            if (activeTableCellSelection.objId !== obj.id || activeTableCellSelection.cells.size <= 1) {
              if (!ev?.shiftKey && !ev?.altKey && !(tableCellDragState && tableCellDragState.isMultiDrag)) {
                activeTableCellSelection.objId = obj.id;
                activeTableCellSelection.anchor = { rIdx, cIdx };
                activeTableCellSelection.cells.clear();
                activeTableCellSelection.cells.add(cellKey);
                updateTableCellSelectionDOM(obj.id);
              }
            }
            syncSelectionUI();
          };

          // Multi-cell drag & Shift/Alt range selection
          td.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 || ev.ctrlKey) return;
            if (!selectedObjectIds.has(obj.id)) {
              selectObject(obj.id, { additive: false });
            }
            if (ev.shiftKey) {
              ev.preventDefault();
              ev.stopPropagation();
              const anc =
                activeTableCellSelection.objId === obj.id && activeTableCellSelection.anchor
                  ? activeTableCellSelection.anchor
                  : lastFocusedTableCell && lastFocusedTableCell.obj.id === obj.id
                  ? { rIdx: lastFocusedTableCell.rIdx, cIdx: lastFocusedTableCell.cIdx }
                  : { rIdx: 0, cIdx: 0 };
              activeTableCellSelection.anchor = anc;
              window.getSelection()?.removeAllRanges();
              selectCellRange(anc.rIdx, anc.cIdx, rIdx, cIdx, true);
              return;
            }
            if (ev.altKey) {
              ev.preventDefault();
              ev.stopPropagation();
              if (activeTableCellSelection.objId !== obj.id) {
                activeTableCellSelection.objId = obj.id;
                activeTableCellSelection.cells.clear();
              }
              activeTableCellSelection.anchor = { rIdx, cIdx };
              if (activeTableCellSelection.cells.has(cellKey)) {
                activeTableCellSelection.cells.delete(cellKey);
              } else {
                activeTableCellSelection.cells.add(cellKey);
              }
              window.getSelection()?.removeAllRanges();
              updateTableCellSelectionDOM(obj.id);
              syncSelectionUI();
              return;
            }
            activeTableCellSelection.objId = obj.id;
            activeTableCellSelection.anchor = { rIdx, cIdx };
            activeTableCellSelection.cells.clear();
            activeTableCellSelection.cells.add(cellKey);
            updateTableCellSelectionDOM(obj.id);
            tableCellDragState = {
              obj,
              tableEl: table,
              startR: rIdx,
              startC: cIdx,
              isMultiDrag: false,
              selectCellRange
            };
          });

          td.addEventListener('pointerenter', () => {
            if (!tableCellDragState || tableCellDragState.obj.id !== obj.id) return;
            if (rIdx !== tableCellDragState.startR || cIdx !== tableCellDragState.startC) {
              tableCellDragState.isMultiDrag = true;
              table.classList.add('is-selecting-cells');
              window.getSelection()?.removeAllRanges();
            }
            if (tableCellDragState.isMultiDrag) {
              selectCellRange(tableCellDragState.startR, tableCellDragState.startC, rIdx, cIdx, true);
            }
          });

          const handleCellKeydown = (ev) => {
            // Ctrl+A inside table -> select all cells in this table!
            if ((ev.ctrlKey || ev.metaKey) && (ev.code === 'KeyA' || (ev.key || '').toLowerCase() === 'a')) {
              if (activeTableCellSelection.objId === obj.id && activeTableCellSelection.cells.size > 1) {
                ev.preventDefault();
                ev.stopPropagation();
                selectCellRange(0, 0, obj.tableData.length - 1, (obj.tableData[0]?.length || 1) - 1, false);
                showToast(`📊 표 전체 셀(${activeTableCellSelection.cells.size}개)이 선택되었습니다`);
                return;
              }
            }
            // Delete or Backspace when multiple cells are selected -> clear all selected cells!
            if (
              (ev.key === 'Backspace' || ev.key === 'Delete') &&
              activeTableCellSelection.objId === obj.id &&
              activeTableCellSelection.cells.size > 1
            ) {
              ev.preventDefault();
              ev.stopPropagation();
              pushUndoSnapshot(`표 선택 셀(${activeTableCellSelection.cells.size}개) 내용 지우기`);
              activeTableCellSelection.cells.forEach((ck) => {
                const [rr, cc] = ck.split('_').map(Number);
                if (obj.tableData[rr] && obj.tableData[rr][cc] !== undefined) {
                  obj.tableData[rr][cc] = '';
                }
              });
              renderTableGrid();
              scheduleSaveBoard();
              return;
            }
            if (ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter' || ev.code === 'Space') {
              ev.stopPropagation();
            }
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
            txtSpan.addEventListener('focus', (ev) => registerCellAlignTarget(ev));
            txtSpan.addEventListener('mouseup', (ev) => registerCellAlignTarget(ev));
            txtSpan.addEventListener('keyup', (ev) => registerCellAlignTarget(ev));
            txtSpan.addEventListener('input', () => {
              obj.tableData[rIdx][cIdx] = `[${cStyle}:${isChecked ? '1' : '0'}] ${txtSpan.textContent}`;
              scheduleSaveBoard();
            });
            txtSpan.addEventListener('keydown', handleCellKeydown);

            cellFlex.appendChild(w);
            cellFlex.appendChild(txtSpan);
            td.appendChild(cellFlex);
          } else {
            td.contentEditable = 'true';
            td.textContent = rawStr;
            td.addEventListener('focus', (ev) => registerCellAlignTarget(ev));
            td.addEventListener('mouseup', (ev) => registerCellAlignTarget(ev));
            td.addEventListener('keyup', (ev) => registerCellAlignTarget(ev));
            td.addEventListener('input', () => {
              obj.tableData[rIdx][cIdx] = td.textContent;
              scheduleSaveBoard();
            });
            td.addEventListener('keydown', handleCellKeydown);
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      wrap.innerHTML = '';
      wrap.appendChild(table);
      applyObjectTypography(el, obj);
      updateTableCellSelectionDOM(obj.id);
    };
    renderTableGrid();

    tBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ff-table-btn');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      const cols = obj.tableData[0]?.length || 3;
      if (act === 'sel-all') {
        if (!selectedObjectIds.has(obj.id)) selectObject(obj.id, { additive: false });
        const totalR = obj.tableData.length;
        const totalC = obj.tableData[0]?.length || 1;
        const allSelected =
          activeTableCellSelection.objId === obj.id && activeTableCellSelection.cells.size === totalR * totalC;
        if (allSelected) {
          clearTableCellSelection();
          showToast('표 셀 전체선택이 해제되었습니다');
        } else {
          selectCellRange(0, 0, totalR - 1, totalC - 1, false);
          showToast(`📊 표의 모든 셀(${activeTableCellSelection.cells.size}개)이 선택되었습니다 — 상단 툴바에서 정렬·폰트를 한 번에 변경하세요!`);
        }
      } else if (act === 'add-row') {
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
        if (activeTableCellSelection.objId === obj.id && activeTableCellSelection.cells.size > 0) {
          activeTableCellSelection.cells.forEach((ck) => {
            const [rr, cc] = ck.split('_').map(Number);
            if (obj.tableData[rr] && obj.tableData[rr][cc] !== undefined) {
              const curVal = String(obj.tableData[rr][cc] ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '');
              obj.tableData[rr][cc] = `[${styleName}:0] ${curVal}`;
            }
          });
        } else {
          const targetR = lastFocusedTableCell && lastFocusedTableCell.obj.id === obj.id ? lastFocusedTableCell.rIdx : Math.min(1, obj.tableData.length - 1);
          const targetC = lastFocusedTableCell && lastFocusedTableCell.obj.id === obj.id ? lastFocusedTableCell.cIdx : 0;
          const curVal = String(obj.tableData[targetR]?.[targetC] ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '');
          obj.tableData[targetR][targetC] = `[${styleName}:0] ${curVal}`;
        }
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
    img.draggable = false;
    img.addEventListener('load', () => {
      const natW = img.naturalWidth || 1;
      const natH = img.naturalHeight || 1;
      const ratio = Number((natW / Math.max(1, natH)).toFixed(4));
      obj.imageAspect = ratio;
      if (obj.keepAspect !== false && !obj._aspectFitted) {
        obj._aspectFitted = true;
        obj.height = Math.max(48, Math.round((obj.width || 360) / Math.max(0.1, ratio)));
        el.style.height = `${obj.height}px`;
        renderAllConnectors();
      }
    });
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
  } else if (obj.type === 'sticker') {
    const stickerWrap = document.createElement('div');
    stickerWrap.className = 'ff-sticker-wrap';
    const img = document.createElement('img');
    const rawStickerSrc = obj.stickerSvgUrl || obj.resolvedFileUrl || obj.imageUrl || '';
    const stickerSrc = typeof ensureStretchableStickerUrl === 'function' ? ensureStretchableStickerUrl(rawStickerSrc) : rawStickerSrc;
    if (stickerSrc && obj.stickerSvgUrl && stickerSrc !== obj.stickerSvgUrl) {
      obj.stickerSvgUrl = stickerSrc;
    }
    img.src = stickerSrc;
    img.draggable = false;
    img.addEventListener('load', () => {
      if (!obj.imageAspect) {
        const natW = img.naturalWidth || 200;
        const natH = img.naturalHeight || 200;
        obj.imageAspect = Number((natW / Math.max(1, natH)).toFixed(4));
      }
      const ratio = obj.imageAspect || 1;
      if (obj.keepAspect !== false && !obj._aspectFitted) {
        obj._aspectFitted = true;
        obj.height = Math.max(48, Math.round((obj.width || 180) / Math.max(0.1, ratio)));
        el.style.height = `${obj.height}px`;
        renderAllConnectors();
      }
      if (!obj.stickerSvgUrl && stickerSrc && !stickerSrc.startsWith('data:image/svg+xml') && typeof vectorizePngDataUrlToSvg === 'function') {
        vectorizePngDataUrlToSvg(stickerSrc)
          .then((vecRes) => {
            if (vecRes && vecRes.svgDataUrl) {
              const stretchSvg = typeof ensureStretchableStickerUrl === 'function' ? ensureStretchableStickerUrl(vecRes.svgDataUrl) : vecRes.svgDataUrl;
              obj.stickerSvgUrl = stretchSvg;
              if (vecRes.aspect) obj.imageAspect = vecRes.aspect;
              img.src = stretchSvg;
              scheduleSaveBoard();
            }
          })
          .catch(() => {});
      }
    });
    stickerWrap.appendChild(img);
    stickerWrap.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const lb = document.getElementById('lightboxModal');
      const lbImg = document.getElementById('lightboxImage');
      const currentSrc = obj.stickerSvgUrl || stickerSrc;
      if (lb && lbImg && currentSrc) {
        lbImg.src = currentSrc;
        lb.classList.remove('hidden');
      }
    });
    body.appendChild(stickerWrap);
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

    const shortUrl = shortenDisplayUrl(obj.url || '');
    const pageTitle = obj.pageTitle || (obj.title && obj.title !== obj.url ? obj.title : '') || obj.domain || shortUrl || '웹 링크';
    const faviconHtml = obj.favicon
      ? `<img class="ff-link-favicon" src="${escapeHtml(obj.favicon)}" width="14" height="14" alt="" />`
      : `<span class="ff-link-favicon-fallback">${SVG_ICONS.externalLink}</span>`;

    if (youtubeId || isDirectVideo) {
      card.classList.add('is-video');
      card.innerHTML = `
        ${mediaHtml}
        <div class="ff-link-info" data-link-open title="클릭하여 기본 브라우저로 열기">
          <div class="ff-link-page-title">${escapeHtml(pageTitle)}</div>
          <div class="ff-link-url-row">${faviconHtml}<span class="ff-link-url-text">${escapeHtml(shortUrl)}</span></div>
        </div>
      `;
    } else {
      card.classList.add('is-page');
      card.dataset.linkOpen = '1';
      card.title = `클릭하여 기본 브라우저로 열기\n${obj.url || ''}`;
      card.innerHTML = `
        ${obj.thumbnail
          ? `<div class="ff-link-preview"><img class="ff-link-thumb" src="${escapeHtml(obj.thumbnail)}" alt="" draggable="false" /></div>`
          : `<div class="ff-link-preview is-empty"><div class="ff-link-preview-domain">${faviconHtml}<span>${escapeHtml(obj.domain || shortUrl)}</span></div></div>`}
        <div class="ff-link-info">
          <div class="ff-link-page-title">${escapeHtml(pageTitle)}</div>
          ${obj.description ? `<div class="ff-link-page-desc">${escapeHtml(obj.description)}</div>` : ''}
          <div class="ff-link-url-row">${faviconHtml}<span class="ff-link-url-text">${escapeHtml(shortUrl)}</span></div>
        </div>
      `;
      card.querySelector('.ff-link-thumb')?.addEventListener('error', (ev) => {
        const prev = ev.target.closest('.ff-link-preview');
        if (prev) {
          prev.classList.add('is-empty');
          prev.innerHTML = `<div class="ff-link-preview-domain">${faviconHtml}<span>${escapeHtml(obj.domain || shortUrl)}</span></div>`;
        }
      });
    }

    // Click (NOT drag) on the card -> open with the OS default browser
    let linkDownPos = null;
    card.addEventListener('pointerdown', (e) => {
      linkDownPos = e.button === 0 && !e.ctrlKey && !e.shiftKey ? { x: e.clientX, y: e.clientY } : null;
    });
    card.addEventListener('pointerup', (e) => {
      if (!linkDownPos || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - linkDownPos.x, e.clientY - linkDownPos.y);
      linkDownPos = null;
      if (moved > 5) return;
      if (!e.target.closest('[data-link-open]')) return;
      if (obj.url) window.freeformAPI.openExternal(obj.url);
    });

    // Legacy link objects that only stored the bare URL: fetch title / preview once in the background
    if (obj.url && !obj._metaRefreshTried && !obj.thumbnail && (!obj.title || obj.title === obj.url) && !youtubeId) {
      obj._metaRefreshTried = true;
      window.freeformAPI
        .fetchUrlMetadata(obj.url)
        .then((meta) => {
          if (!meta) return;
          let changed = false;
          if (meta.title && (!obj.title || obj.title === obj.url)) {
            obj.title = meta.title;
            changed = true;
          }
          ['description', 'thumbnail', 'favicon', 'domain'].forEach((k) => {
            if (meta[k] && !obj[k]) {
              obj[k] = meta[k];
              changed = true;
            }
          });
          if (changed) {
            renderAllObjects();
            scheduleSaveBoard();
          }
        })
        .catch(() => {});
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

          // Ensure deterministic scrollbar state before measuring single-page container geometry
          pagesContainer.style.overflowY = total > 1 || currentPdfZoom > 1 ? 'scroll' : 'hidden';
          pagesContainer.style.overflowX = currentPdfZoom > 1 ? 'auto' : 'hidden';

          const firstPageForAspect = await loadedPdfDoc.getPage(1);
          if (myTicket !== renderTicket) return;
          const vp1 = firstPageForAspect.getViewport({ scale: 1 });
          const docAspect =
            vp1 && vp1.width > 0 && vp1.height > 0
              ? vp1.width / vp1.height
              : entry.pageAspect || 595.28 / 841.89;
          entry.pageAspect = docAspect;

          obj.pdfChromeW = 0;
          obj.pdfChromeH = 0;
          const sizeChanged = syncPdfViewerAspectSize(obj, docAspect, { width: obj.width });
          el.style.width = `${obj.width}px`;
          el.style.height = `${obj.height}px`;
          if (sizeChanged) {
            renderAllConnectors();
            scheduleSaveBoard();
          }

          const prevScrollRatio =
            pagesContainer.scrollHeight > 0 ? pagesContainer.scrollTop / pagesContainer.scrollHeight : 0;

          pagesContainer.innerHTML = '';
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          // Fit cleanly to 1 full page inside the PDF viewer window
          const innerWidth = pagesContainer.clientWidth || obj.width || 480;
          const targetContainerWidth = Math.max(180, innerWidth);

          for (let pageNum = 1; pageNum <= total; pageNum++) {
            if (myTicket !== renderTicket) return;
            const page = pageNum === 1 ? firstPageForAspect : await loadedPdfDoc.getPage(pageNum);
            const unscaledVp = page.getViewport({ scale: 1 });
            const pageAspect = unscaledVp.width / Math.max(1, unscaledVp.height);
            const fitScale = (targetContainerWidth / unscaledVp.width) * currentPdfZoom;
            const vp = page.getViewport({ scale: fitScale * dpr });

            const pageCard = document.createElement('div');
            pageCard.className = 'ff-pdf-page-card';
            pageCard.dataset.pageNumber = String(pageNum);

            const canvas = document.createElement('canvas');
            canvas.className = 'ff-pdf-page-canvas';
            canvas.dataset.pageAspect = String(pageAspect);
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            canvas.style.width = `${Math.round(vp.width / dpr)}px`;
            canvas.style.height = `${Math.round(vp.height / dpr)}px`;

            const badge = document.createElement('span');
            badge.className = 'ff-pdf-page-badge';
            badge.textContent = `${pageNum} / ${total}`;

            pageCard.appendChild(canvas);
            pageCard.appendChild(badge);
            pagesContainer.appendChild(pageCard);

            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            if (typeof renderPdfPageSearchHighlights === 'function') {
              renderPdfPageSearchHighlights(pageCard, obj, pageNum);
            }
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
          if (card) {
            pagesContainer.scrollTo({ top: Math.max(0, card.offsetTop), behavior: 'smooth' });
          }
        } else if (act === 'next' && loadedPdfDoc) {
          const targetP = Math.min(loadedPdfDoc.numPages, currentVisiblePage + 1);
          const card = pagesContainer.querySelector(`.ff-pdf-page-card[data-page-number="${targetP}"]`);
          if (card) {
            pagesContainer.scrollTo({ top: Math.max(0, card.offsetTop), behavior: 'smooth' });
          }
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

  const isBgShape = () => obj.type === 'shape' && Boolean(obj.shapeBackground);

  const startDrag = (e, forceMove = false) => {
    if (e.button !== 0 || activeTool !== 'select' || obj.locked || isBgShape()) return;
    if (!forceMove && e.target.closest('button, input, textarea, [contenteditable="true"], .ff-chk-widget')) return;
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
    renderAllConnectors();
  };

  // Ctrl-Hold Instant Move Mode: Holding Ctrl + Left-Click anywhere on an object (even over text inputs) immediately drags the object!
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.ctrlKey && e.button === 0 && activeTool === 'select' && !obj.locked && !isBgShape()) {
        if (e.target.closest('.ff-resize-handle, .ff-rotate-handle, .ff-connect-handle')) return;
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        startDrag(e, true);
      }
    },
    true
  );

  // Object Selection & Multi-Object Dragging
  el.addEventListener('pointerdown', (e) => {
    if (activeTool !== 'select' || e.button !== 0) return;
    if (isBgShape()) {
      // Backgrounded shape: let the click fall through to the canvas (only the bg toggle button stops propagation itself)
      return;
    }
    e.stopPropagation();
    selectedConnectorId = null;
    if (e.shiftKey && !(obj.type === 'table' && selectedObjectIds.has(obj.id) && e.target.closest('.ff-table td'))) {
      selectObject(obj.id, { additive: true });
    } else if (!selectedObjectIds.has(obj.id)) {
      selectObject(obj.id, { additive: false });
    }
    if (!e.target.closest('.ff-table, .ff-table-toolbar')) {
      clearTableCellSelection();
    }
    renderAllConnectors();
  });

  el.addEventListener('focusin', () => {
    if (isBgShape()) return;
    if (!selectedObjectIds.has(obj.id)) {
      selectedConnectorId = null;
      selectObject(obj.id, { additive: false });
      renderAllConnectors();
    }
  });

  header.addEventListener('pointerdown', (e) => startDrag(e, false));
  if (
    obj.vectorized ||
    obj.type === 'image' ||
    obj.type === 'sticker' ||
    obj.type === 'label' ||
    obj.type === 'stroke' ||
    obj.type === 'shape' ||
    obj.type === 'link' ||
    obj.type === 'file' ||
    obj.type === 'pdf'
  ) {
    body.addEventListener('pointerdown', (e) => startDrag(e, false));
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

function sendSelectedObjectsToBack() {
  const selected = getSelectedObjects();
  if (!selected.length || !currentBoard) return;
  pushUndoSnapshot('맨 뒤로 보내기');
  const selIds = new Set(selected.map((o) => o.id));
  const ordered = [...currentBoard.objects].sort((a, b) => (a.zIndex || 1) - (b.zIndex || 1));
  let z = 1;
  ordered
    .filter((o) => selIds.has(o.id))
    .forEach((o) => {
      o.zIndex = z++;
    });
  ordered
    .filter((o) => !selIds.has(o.id))
    .forEach((o) => {
      o.zIndex = z++;
    });
  renderAllObjects();
  scheduleSaveBoard();
  showToast('선택 객체를 맨 뒤로 보냈습니다');
}

const RANDOM_CARD_COLOR_POOL = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];
let lastRandomCardColor = '';
function pickRandomNoteOrChecklistColor() {
  const candidates = RANDOM_CARD_COLOR_POOL.filter((c) => c !== lastRandomCardColor);
  const picked = candidates[Math.floor(Math.random() * candidates.length)] || 'yellow';
  lastRandomCardColor = picked;
  return picked;
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
  const rawX = partial.x ?? center.x - Math.round(w / 2) + jitter;
  const rawY = partial.y ?? center.y - Math.round(h / 2) + jitter;
  const targetType = partial.type || 'sticky';
  const newObj = {
    id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: targetType,
    x: snapWorldVal(rawX, gridConfig.snapObjects),
    y: snapWorldVal(rawY, gridConfig.snapObjects),
    width: w,
    height: h,
    rotation: partial.rotation || 0,
    groupId: partial.groupId || undefined,
    color:
      partial.color ||
      (targetType === 'sticky' || targetType === 'text'
        ? pickRandomNoteOrChecklistColor()
        : targetType === 'label'
        ? 'light'
        : 'dark'),
    customColor: partial.customColor || null,
    textStyle: partial.textStyle ? { ...partial.textStyle } : null,
    titleAlign: partial.titleAlign || 'left',
    lineAligns: Array.isArray(partial.lineAligns) ? [...partial.lineAligns] : undefined,
    memoLineAligns: Array.isArray(partial.memoLineAligns) ? [...partial.memoLineAligns] : undefined,
    cellAligns: partial.cellAligns ? { ...partial.cellAligns } : undefined,
    cellStyles: partial.cellStyles ? JSON.parse(JSON.stringify(partial.cellStyles)) : undefined,
    checkAutoWrap: partial.checkAutoWrap !== undefined ? Boolean(partial.checkAutoWrap) : undefined,
    keepAspect: partial.keepAspect !== undefined ? Boolean(partial.keepAspect) : undefined,
    imageAspect: partial.imageAspect || undefined,
    borderEnabled: Boolean(partial.borderEnabled) || undefined,
    borderColor: partial.borderColor || undefined,
    borderWidth: partial.borderWidth || undefined,
    borderStyle: partial.borderStyle || undefined,
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

  [
    'shapeType',
    'polygonSides',
    'cornerEnabled',
    'cornerRadius',
    'fillEnabled',
    'fillColor',
    'fillOpacity',
    'strokeColor',
    'shapeBackground',
    'labelFillEnabled',
    'labelBgEnabled',
    'labelBgColor',
    'labelBgOpacity',
    'labelBgRadius',
    'labelBoxBorderEnabled',
    'labelBoxBorderColor',
    'labelBoxBorderWidth',
    'labelBoxBorderStyle',
    'opaque',
    'labelFillColor',
    'labelStrokeEnabled',
    'labelStrokeColor',
    'labelStrokeWidth',
    'pdfPageAspect',
    'pdfChromeW',
    'pdfChromeH',
    'pdfAspectFitted',
    'viewerWidth',
    'viewerHeight',
    'pdfZoom',
    'groupName',
    'stickerSvgUrl',
    'stickerPresetId',
    'imageUrl'
  ].forEach((k) => {
    if (partial[k] !== undefined && partial[k] !== null) newObj[k] = partial[k];
  });
  if (newObj.type === 'shape') {
    // Shapes reuse borderStyle/borderWidth with 'none' & fractional widths allowed
    if (partial.borderStyle !== undefined) newObj.borderStyle = partial.borderStyle;
    if (partial.borderWidth !== undefined) newObj.borderWidth = partial.borderWidth;
  }

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
        const nextGid = `grp_${Date.now().toString().slice(-5)}_${Math.random().toString(36).slice(2, 4)}`;
        groupMap.set(orig.groupId, nextGid);
        const origGrpName = orig.groupName || (currentBoard.groupNames && currentBoard.groupNames[orig.groupId]);
        if (origGrpName) {
          if (!currentBoard.groupNames) currentBoard.groupNames = {};
          currentBoard.groupNames[nextGid] = origGrpName;
        }
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
      color: pickRandomNoteOrChecklistColor()
    });
    showToast('📝 클립보드 텍스트가 노트 객체로 생성되었습니다');
  }
}

// ============================================================================
// Middle-Mouse-Click+Drag OR Left+Right Simultaneous Click+Drag Pan (Anywhere), Empty Canvas Pan, Shift+Drag Marquee, Smart Pen
// ============================================================================
let chordPanActive = false;
let suppressContextMenuUntil = 0;
let pointerDownInViewport = false;

function startCanvasPanMode(clientX, clientY, isChordPan = false) {
  hideContextMenu();
  cancelViewportAnimation();

  if (isChordPan) {
    chordPanActive = true;
    suppressContextMenuUntil = Date.now() + 800;

    // Cancel and revert any in-flight drag/draw/marquee that began a few ms earlier when the first button was pressed
    if (draggingObjState) {
      draggingObjState.items.forEach((item) => {
        item.obj.x = item.origX;
        item.obj.y = item.origY;
        if (item.el) {
          item.el.style.left = `${item.obj.x}px`;
          item.el.style.top = `${item.obj.y}px`;
        }
      });
      document.body.classList.remove('is-dragging-object');
      draggingObjState = null;
      updateGroupFramesDOM();
      renderAllConnectors();
    }
    if (resizingObjState) {
      resizingObjState.obj.width = resizingObjState.origW;
      resizingObjState.obj.height = resizingObjState.origH;
      if (resizingObjState.el) {
        resizingObjState.el.style.width = `${resizingObjState.origW}px`;
        resizingObjState.el.style.height = `${resizingObjState.origH}px`;
      }
      resizingObjState = null;
      updateGroupFramesDOM();
      renderAllConnectors();
    }
    if (rotatingObjState) {
      rotatingObjState.obj.rotation = rotatingObjState.origRotation;
      if (rotatingObjState.el) {
        rotatingObjState.el.style.transform = `rotate(${rotatingObjState.origRotation}deg)`;
      }
      rotatingObjState = null;
    }
    if (drawingStroke) {
      drawingStroke = null;
      renderAllStrokes();
    }
    if (drawingShapeState) {
      drawingShapeState = null;
      shapeDrawPreview?.classList.add('hidden');
    }
    if (marqueeState) {
      marqueeState = null;
      selectionMarquee?.classList.add('hidden');
    }
    if (tableCellDragState) {
      tableCellDragState.tableEl?.classList.remove('is-selecting-cells');
      tableCellDragState = null;
    }
    if (connectingState) {
      connectingState = null;
      tempConnectorPath?.remove();
      tempConnectorPath = null;
    }
  }

  isPanning = true;
  panStartX = clientX - panX;
  panStartY = clientY - panY;
  canvasViewport?.classList.add('canvas-panning-active');
}

// Prevent Windows default auto-scroll circle on middle mouse button click, and detect Left+Right chord click
window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 1) {
      e.preventDefault();
    }
    // Left + Right simultaneous click anywhere inside canvasViewport -> Pan!
    if ((e.buttons & 3) === 3 && canvasViewport && canvasViewport.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      startCanvasPanMode(e.clientX, e.clientY, true);
    }
  },
  true
);

window.addEventListener(
  'mouseup',
  (e) => {
    if (chordPanActive) {
      suppressContextMenuUntil = Date.now() + 450;
      if ((e.buttons & 3) === 0) {
        chordPanActive = false;
        if (isPanning) {
          isPanning = false;
          canvasViewport?.classList.remove('canvas-panning-active');
          scheduleSaveBoard();
        }
      }
    }
  },
  true
);

// Capture-phase pointerdown on canvasViewport so Middle-Click (Wheel Click) or Left+Right Click Pan works EVEN when objects fill the screen!
canvasViewport.addEventListener(
  'pointerdown',
  (e) => {
    pointerDownInViewport = true;
    hideContextMenu();

    // 1. Middle Mouse Button (Wheel Click + Drag, button === 1) OR Left+Right Simultaneous Click ((e.buttons & 3) === 3) -> Pan anywhere!
    if (e.button === 1 || (e.buttons & 3) === 3) {
      e.preventDefault();
      e.stopPropagation();
      startCanvasPanMode(e.clientX, e.clientY, (e.buttons & 3) === 3);
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
      const sx = snapWorldVal(pt.x, gridConfig.snapDrawing);
      const sy = snapWorldVal(pt.y, gridConfig.snapDrawing);
      drawingStroke = {
        color: currentPenColor,
        width: 3.5,
        points: [[sx, sy]]
      };
      renderAllStrokes();
      return;
    }

    // 3-B. Shape Tool Drawing (drag anywhere on the canvas, even over existing objects, except UI toolbars/HUD)
    if (
      activeTool === 'shape' &&
      e.button === 0 &&
      !e.target.closest('.pen-toolbar, .object-inspector, .grid-settings-popover, .canvas-hud, .canvas-hint-pill, .ff-shape-bg-btn')
    ) {
      e.preventDefault();
      e.stopPropagation();
      const pt = screenToWorld(e.clientX, e.clientY);
      const sx = snapWorldVal(pt.x, gridConfig.snapDrawing);
      const sy = snapWorldVal(pt.y, gridConfig.snapDrawing);
      drawingShapeState = { startX: sx, startY: sy, curX: sx, curY: sy, shiftKey: false };
      updateShapeDrawPreview();
      return;
    }

    if (!isEmptyCanvasTarget) return;

    // 4. Empty Canvas Left-Click Drag -> Pan (Hand cursor -> Grabbing Hand cursor)
    if (e.button === 0) {
      cancelViewportAnimation();
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
  lastCanvasMousePos = { x: e.clientX, y: e.clientY };
  document.body.classList.toggle('ctrl-move-mode', Boolean(e.ctrlKey && activeTool === 'select'));

  // Left + Right simultaneous click + drag ((e.buttons & 3) === 3) -> immediately switch to canvas panning!
  if (!isPanning && (e.buttons & 3) === 3 && (pointerDownInViewport || canvasViewport?.contains(e.target))) {
    startCanvasPanMode(e.clientX, e.clientY, true);
  }

  if (isPanning) {
    if (chordPanActive) {
      suppressContextMenuUntil = Date.now() + 600;
    }
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    applyViewportTransform();
    return;
  }

  if (tableCellDragState) {
    const hoverEl = document.elementFromPoint(e.clientX, e.clientY);
    const hoverTd = hoverEl?.closest?.('td[data-cell-key]');
    if (hoverTd && tableCellDragState.tableEl?.contains(hoverTd)) {
      const rIdx = Number(hoverTd.dataset.rIdx);
      const cIdx = Number(hoverTd.dataset.cIdx);
      if (Number.isFinite(rIdx) && Number.isFinite(cIdx)) {
        if (rIdx !== tableCellDragState.startR || cIdx !== tableCellDragState.startC) {
          tableCellDragState.isMultiDrag = true;
          tableCellDragState.tableEl.classList.add('is-selecting-cells');
          window.getSelection()?.removeAllRanges();
        }
        if (tableCellDragState.isMultiDrag) {
          tableCellDragState.selectCellRange?.(tableCellDragState.startR, tableCellDragState.startC, rIdx, cIdx, true);
        }
      }
    }
    return;
  }

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

  if (drawingShapeState) {
    const pt = screenToWorld(e.clientX, e.clientY);
    drawingShapeState.curX = snapWorldVal(pt.x, gridConfig.snapDrawing);
    drawingShapeState.curY = snapWorldVal(pt.y, gridConfig.snapDrawing);
    drawingShapeState.shiftKey = e.shiftKey;
    updateShapeDrawPreview();
    return;
  }

  if (drawingStroke) {
    const pt = screenToWorld(e.clientX, e.clientY);
    const startPt = drawingStroke.points[0];

    // Live Straight Line Preview while holding Ctrl or Shift
    if (e.ctrlKey || e.shiftKey) {
      let tx = snapWorldVal(pt.x, gridConfig.snapDrawing);
      let ty = snapWorldVal(pt.y, gridConfig.snapDrawing);
      if (e.shiftKey) {
        // 15-degree angle snap
        const angle = Math.atan2(ty - startPt[1], tx - startPt[0]);
        const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const dist = Math.hypot(tx - startPt[0], ty - startPt[1]);
        tx = snapWorldVal(startPt[0] + Math.cos(snapped) * dist, gridConfig.snapDrawing);
        ty = snapWorldVal(startPt[1] + Math.sin(snapped) * dist, gridConfig.snapDrawing);
      }
      drawingStroke.points = [startPt, [tx, ty]];
      drawingStroke.svgPath = `M ${startPt[0]} ${startPt[1]} L ${tx} ${ty}`;
      drawingStroke.hasArrow = arrowPenMode;
    } else {
      delete drawingStroke.svgPath;
      const sx = snapWorldVal(pt.x, gridConfig.snapDrawing);
      const sy = snapWorldVal(pt.y, gridConfig.snapDrawing);
      const prevPt = drawingStroke.points[drawingStroke.points.length - 1];
      if (!prevPt || prevPt[0] !== sx || prevPt[1] !== sy) {
        drawingStroke.points.push([sx, sy]);
      }
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
      item.obj.x = snapWorldVal(item.origX + dx, gridConfig.snapObjects);
      item.obj.y = snapWorldVal(item.origY + dy, gridConfig.snapObjects);
      if (item.el) {
        item.el.style.left = `${item.obj.x}px`;
        item.el.style.top = `${item.obj.y}px`;
      }
    });
    updateGroupFramesDOM();
    renderAllConnectors();
    return;
  }

  if (resizingObjState) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const dw = cur.x - resizingObjState.startWorldX;
    const dh = cur.y - resizingObjState.startWorldY;
    const rObj = resizingObjState.obj;

    if (rObj.vectorized) {
      const minW = 60;
      const minH = 28;
      if (e.shiftKey) {
        // Shift + Drag: Free non-proportional stretch (with zero whitespace)
        rObj.width = Math.max(minW, snapWorldVal(resizingObjState.origW + dw, gridConfig.snapObjects));
        rObj.height = Math.max(minH, snapWorldVal(resizingObjState.origH + dh, gridConfig.snapObjects));
      } else {
        // Default Drag: Proportional vector scaling with zero whitespace
        const aspect =
          rObj.vectorAspect ||
          resizingObjState.origW / Math.max(1, resizingObjState.origH);
        const scaleX = (resizingObjState.origW + dw) / Math.max(1, resizingObjState.origW);
        const scaleY = (resizingObjState.origH + dh) / Math.max(1, resizingObjState.origH);
        const scale = Math.abs(dw) >= Math.abs(dh) ? scaleX : scaleY;
        const nextW = Math.max(minW, snapWorldVal(resizingObjState.origW * scale, gridConfig.snapObjects));
        const nextH = Math.max(minH, Math.round(nextW / Math.max(0.15, aspect)));
        rObj.width = nextW;
        rObj.height = nextH;
      }
    } else if (rObj.type === 'image' || rObj.type === 'sticker') {
      const minW = 48;
      const minH = 40;
      const lockAspect = rObj.keepAspect !== false ? !e.shiftKey : e.shiftKey;
      if (lockAspect) {
        const aspect =
          rObj.imageAspect ||
          resizingObjState.origW / Math.max(1, resizingObjState.origH);
        const scaleX = (resizingObjState.origW + dw) / Math.max(1, resizingObjState.origW);
        const scaleY = (resizingObjState.origH + dh) / Math.max(1, resizingObjState.origH);
        const scale = Math.abs(dw) >= Math.abs(dh) ? scaleX : scaleY;
        const nextW = Math.max(minW, snapWorldVal(resizingObjState.origW * scale, gridConfig.snapObjects));
        const nextH = Math.max(minH, Math.round(nextW / Math.max(0.1, aspect)));
        rObj.width = nextW;
        rObj.height = nextH;
      } else {
        rObj.width = Math.max(minW, snapWorldVal(resizingObjState.origW + dw, gridConfig.snapObjects));
        rObj.height = Math.max(minH, snapWorldVal(resizingObjState.origH + dh, gridConfig.snapObjects));
      }
    } else if (isPdfObject(rObj) && (rObj.pdfViewMode || 'viewer') === 'viewer') {
      // Lock PDF viewer resizing strictly to the document's single-page aspect ratio (both portrait and landscape)
      const aspect = Number(rObj.pdfPageAspect) || 595.28 / 841.89;
      const chromeW = 0;
      const chromeH = 0;
      const isLandscape = aspect > 1.02;
      const minPageW = isLandscape ? 260 : 200;

      const origPageW = Math.max(minPageW, resizingObjState.origW - chromeW);
      const origPageH = Math.max(120, origPageW / Math.max(0.15, aspect));

      const scaleX = (origPageW + dw) / origPageW;
      const scaleY = (origPageH + dh) / origPageH;
      const scale = Math.abs(dw) >= Math.abs(dh) ? scaleX : scaleY;

      const rawNextW = Math.round(origPageW * scale + chromeW);
      const nextW = Math.max(minPageW + chromeW, snapWorldVal(rawNextW, gridConfig.snapObjects));
      const nextPageW = Math.max(minPageW, nextW - chromeW);
      const nextPageH = Math.round(nextPageW / Math.max(0.15, aspect));
      const nextH = nextPageH + chromeH;

      rObj.width = nextW;
      rObj.height = nextH;
      rObj.viewerWidth = nextW;
      rObj.viewerHeight = nextH;
      rObj.pdfAspectFitted = true;

      const zoomFactor = rObj.pdfZoom && rObj.pdfZoom !== 1.15 ? rObj.pdfZoom : 1.0;
      const canvases = resizingObjState.el.querySelectorAll('.ff-pdf-page-canvas');
      canvases.forEach((cv) => {
        const cvAspect = Number(cv.dataset.pageAspect) || aspect;
        cv.style.width = `${Math.round(nextPageW * zoomFactor)}px`;
        cv.style.height = `${Math.round((nextPageW / Math.max(0.15, cvAspect)) * zoomFactor)}px`;
      });
    } else {
      const isSmallKind = rObj.type === 'stroke' || rObj.type === 'shape';
      const minW = isSmallKind ? 36 : 180;
      const minH = isSmallKind ? 36 : 120;
      if (rObj.type === 'shape' && (rObj.shapeType === 'circle' || e.shiftKey)) {
        // Circle (or Shift+drag): keep 1:1 proportional sizing
        const side = Math.max(
          minW,
          snapWorldVal(Math.max(resizingObjState.origW + dw, resizingObjState.origH + dh), gridConfig.snapObjects)
        );
        rObj.width = side;
        rObj.height = side;
      } else {
        rObj.width = Math.max(minW, snapWorldVal(resizingObjState.origW + dw, gridConfig.snapObjects));
        rObj.height = Math.max(minH, snapWorldVal(resizingObjState.origH + dh, gridConfig.snapObjects));
      }
    }
    resizingObjState.el.style.width = `${rObj.width}px`;
    resizingObjState.el.style.height = `${rObj.height}px`;
    if (rObj.type === 'shape') {
      const sWrap = resizingObjState.el.querySelector('.ff-shape-wrap');
      if (sWrap) renderShapeObjectInto(sWrap, rObj);
    }
    updateGroupFramesDOM();
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
  if ((e.buttons & 3) === 0) {
    pointerDownInViewport = false;
  }
  if (chordPanActive) {
    suppressContextMenuUntil = Date.now() + 450;
    if ((e.buttons & 3) === 0) {
      chordPanActive = false;
    }
  }
  if (tableCellDragState) {
    const wasMulti = tableCellDragState.isMultiDrag;
    tableCellDragState.tableEl?.classList.remove('is-selecting-cells');
    tableCellDragState = null;
    if (wasMulti) {
      window.getSelection()?.removeAllRanges();
    }
  }

  if (draggingConnectorEndpoint) {
    if (draggingConnectorEndpoint.snapshotBefore) {
      pushUndoSnapshot('화살표 연결 위치 변경', draggingConnectorEndpoint.snapshotBefore);
    }
    draggingConnectorEndpoint = null;
    renderAllConnectors();
    scheduleSaveBoard();
    showToast('화살표 연결 위치가 이동되었습니다');
  }

  if (drawingShapeState) {
    finalizeShapeDrawing();
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
      .filter((o) => !(o.type === 'shape' && o.shapeBackground))
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

// Smooth Zoom on Mouse Wheel (Always anchored to Mouse Cursor Position!)
canvasViewport.addEventListener(
  'wheel',
  (e) => {
    lastCanvasMousePos = { x: e.clientX, y: e.clientY };
    if (!e.ctrlKey && !e.metaKey) {
      const scrollEl = e.target.closest('.ff-pdf-pages-container, .ff-table-wrap, .ff-obj-body');
      if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 2) {
        const canScrollUp = e.deltaY < 0 && scrollEl.scrollTop > 0;
        const canScrollDown =
          e.deltaY > 0 && scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 1;
        if (canScrollUp || canScrollDown) {
          return;
        }
      }
    }
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAtScreenPoint(zoom * factor, e.clientX, e.clientY);
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
      color: pickRandomNoteOrChecklistColor()
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
  if (chordPanActive || isPanning || Date.now() < suppressContextMenuUntil || (e.buttons & 1) === 1) {
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    return;
  }
  if (e.target.closest('#inspectorColors .swatch, #penToolbar .pen-color')) {
    return;
  }
  e.preventDefault();
  if (!contextMenu) return;

  const worldPos = screenToWorld(e.clientX, e.clientY);
  const objEl = e.target.closest('.ff-object');
  const isTextTarget = Boolean(e.target.closest('input, textarea, [contenteditable="true"]'));
  const selectedText = window.getSelection()?.toString() || '';
  const ctxSel = window.getSelection();
  const ctxSavedRange = ctxSel && ctxSel.rangeCount > 0 && !ctxSel.isCollapsed ? ctxSel.getRangeAt(0).cloneRange() : null;

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

    if (isVectorizableObject(primary)) {
      html += `
        <div class="ctx-divider"></div>
        <button class="ctx-item" data-ctx="obj-toggle-vector"><span class="ctx-item-left">${SVG_ICONS.vectorize}<span>${primary.vectorized ? '일반 편집 모드로 전환' : '객체 벡터 이미지화 (여백 없이 자유 확대)'}</span></span></button>
      `;
    }

    if (primary.type === 'label') {
      html += `
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
      <button class="ctx-item" data-ctx="obj-back"><span class="ctx-item-left">${SVG_ICONS.down}<span>맨 뒤로 보내기</span></span></button>
      <button class="ctx-item" data-ctx="obj-lock"><span class="ctx-item-left">${SVG_ICONS.lock}<span>${primary.locked ? '잠금 해제' : '객체 위치 잠금'}</span></span></button>
      <button class="ctx-item" data-ctx="obj-opacity"><span class="ctx-item-left">${SVG_ICONS.bgLayer}<span>${selected.every((o) => o.opaque) ? '기본 투명도로 되돌리기' : '불투명으로 전환'}</span></span></button>
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
    } else if (act === 'obj-toggle-vector' || act === 'label-toggle-vector') {
      if (primary && isVectorizableObject(primary)) {
        toggleObjectVectorized(primary);
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
        if (!convertSelectedLinesToChecklist(primary, style, ctxSavedRange)) {
          appendCheckItemToNote(primary, style, '');
        }
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
    } else if (act === 'obj-back') {
      sendSelectedObjectsToBack();
    } else if (act === 'obj-lock') {
      const nextLock = !primary.locked;
      getSelectedObjects().forEach((o) => (o.locked = nextLock));
      syncSelectionUI();
      scheduleSaveBoard();
    } else if (act === 'obj-opacity') {
      toggleSelectedObjectsOpacity();
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
      addObjectToBoard({
        type: 'sticky',
        title: '📌 포스트잇 메모',
        x: worldPos.x - 140,
        y: worldPos.y - 110,
        width: 280,
        height: 220,
        color: pickRandomNoteOrChecklistColor()
      });
    } else if (act === 'new-text') {
      const created = addObjectToBoard({
        type: 'text',
        title: '체크리스트 & 노트',
        content: '[square:0] ',
        x: worldPos.x - 175,
        y: worldPos.y - 110,
        width: 360,
        height: 240,
        color: pickRandomNoteOrChecklistColor()
      });
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
    color: pickRandomNoteOrChecklistColor()
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
    color: pickRandomNoteOrChecklistColor()
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
  document.getElementById('toolShapeBtn')?.classList.toggle('active', mode === 'shape');
  canvasViewport?.classList.toggle('pen-mode', mode === 'pen' || mode === 'shape');
  penToolbar?.classList.toggle('hidden', mode !== 'pen');
  shapeToolbar?.classList.toggle('hidden', mode !== 'shape');
  if (mode === 'shape') syncShapeToolbarUI();
  if (mode !== 'shape') {
    drawingShapeState = null;
    shapeDrawPreview?.classList.add('hidden');
  }
  if (mode === 'pen' || mode === 'shape') clearSelection();
}
document.getElementById('toolSelectBtn')?.addEventListener('click', () => setToolMode('select'));
document.getElementById('toolPenBtn')?.addEventListener('click', () => setToolMode(activeTool === 'pen' ? 'select' : 'pen'));
document.getElementById('toolShapeBtn')?.addEventListener('click', () => setToolMode(activeTool === 'shape' ? 'select' : 'shape'));
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
// Shape Drawing Tool (사각형 / 삼각형 / 원형 / 타원형 / 다각형)
// ============================================================================
const SHAPE_LABELS_KO = {
  rect: '사각형',
  triangle: '삼각형',
  circle: '원형',
  ellipse: '타원형',
  polygon: '다각형'
};

function getDrawingShapeRect() {
  if (!drawingShapeState) return null;
  const { startX, startY, curX, curY, shiftKey } = drawingShapeState;
  let w = Math.abs(curX - startX);
  let h = Math.abs(curY - startY);
  if (shapeToolConfig.shapeType === 'circle' || shiftKey) {
    const side = Math.max(w, h);
    w = side;
    h = side;
  }
  const x = curX >= startX ? startX : startX - w;
  const y = curY >= startY ? startY : startY - h;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function buildShapePropsFromToolConfig() {
  return {
    shapeType: shapeToolConfig.shapeType,
    polygonSides: shapeToolConfig.polygonSides,
    cornerEnabled: shapeToolConfig.cornerEnabled,
    cornerRadius: shapeToolConfig.cornerRadius,
    fillEnabled: shapeToolConfig.fillEnabled,
    fillColor: shapeToolConfig.fillColor,
    fillOpacity: shapeToolConfig.fillOpacity,
    borderStyle: shapeToolConfig.borderStyle,
    borderWidth: shapeToolConfig.borderWidth,
    strokeColor: shapeToolConfig.strokeColor
  };
}

function updateShapeDrawPreview() {
  if (!shapeDrawPreview) return;
  const r = getDrawingShapeRect();
  if (!r || (r.w < 2 && r.h < 2)) {
    shapeDrawPreview.classList.add('hidden');
    return;
  }
  shapeDrawPreview.classList.remove('hidden');
  shapeDrawPreview.style.left = `${r.x}px`;
  shapeDrawPreview.style.top = `${r.y}px`;
  shapeDrawPreview.style.width = `${Math.max(4, r.w)}px`;
  shapeDrawPreview.style.height = `${Math.max(4, r.h)}px`;
  renderShapeObjectInto(shapeDrawPreview, {
    id: 'preview',
    type: 'shape',
    width: Math.max(40, r.w),
    height: Math.max(40, r.h),
    color: 'blue',
    ...buildShapePropsFromToolConfig()
  });
}

function finalizeShapeDrawing() {
  const r = getDrawingShapeRect();
  drawingShapeState = null;
  shapeDrawPreview?.classList.add('hidden');
  if (!r || !currentBoard) return;
  // A simple click (no drag) creates a default-sized shape centered at the click point
  let { x, y, w, h } = r;
  if (w < 12 && h < 12) {
    w = 200;
    h = shapeToolConfig.shapeType === 'circle' ? 200 : 140;
    x = Math.round(x - w / 2);
    y = Math.round(y - h / 2);
  }
  w = Math.max(36, w);
  h = Math.max(36, h);
  const label = SHAPE_LABELS_KO[shapeToolConfig.shapeType] || '도형';
  addObjectToBoard({
    type: 'shape',
    title: shapeToolConfig.shapeType === 'polygon' ? `${shapeToolConfig.polygonSides}각형` : label,
    x,
    y,
    width: w,
    height: h,
    color: 'blue',
    ...buildShapePropsFromToolConfig()
  });
}

function syncShapeToolbarUI() {
  document.querySelectorAll('#shapeToolbar .shape-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.shape === shapeToolConfig.shapeType);
  });
  document.getElementById('shapeToolPolySidesWrap')?.classList.toggle('hidden', shapeToolConfig.shapeType !== 'polygon');
  const sidesInp = document.getElementById('shapeToolPolySidesInput');
  if (sidesInp) sidesInp.value = String(shapeToolConfig.polygonSides);
  document.getElementById('shapeToolCornerWrap')?.classList.toggle('hidden', shapeToolConfig.shapeType === 'circle');
  const cornerBtn = document.getElementById('shapeToolCornerToggleBtn');
  cornerBtn?.classList.toggle('active-pill', shapeToolConfig.cornerEnabled);
  const cornerLbl = document.getElementById('shapeToolCornerLabel');
  if (cornerLbl) cornerLbl.textContent = shapeToolConfig.cornerEnabled ? '곡률 ON' : '곡률 OFF';
  const cornerInp = document.getElementById('shapeToolCornerInput');
  if (cornerInp) {
    cornerInp.value = String(shapeToolConfig.cornerRadius);
    cornerInp.disabled = !shapeToolConfig.cornerEnabled;
  }
  const fillBtn = document.getElementById('shapeToolFillToggleBtn');
  fillBtn?.classList.toggle('active-pill', shapeToolConfig.fillEnabled);
  const fillLbl = document.getElementById('shapeToolFillLabel');
  if (fillLbl) fillLbl.textContent = shapeToolConfig.fillEnabled ? '내부채우기 ON' : '내부채우기 OFF';
  document.getElementById('shapeToolFillColorInput')?.classList.toggle('hidden', !shapeToolConfig.fillEnabled);
  document.getElementById('shapeToolFillOpacitySelect')?.classList.toggle('hidden', !shapeToolConfig.fillEnabled);
}

async function persistShapeToolConfig() {
  try {
    await window.freeformAPI.saveConfig({ shapeToolConfig });
  } catch (err) {
    console.warn('persistShapeToolConfig error:', err);
  }
}

document.querySelectorAll('#shapeToolbar .shape-type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    shapeToolConfig.shapeType = btn.dataset.shape || 'rect';
    syncShapeToolbarUI();
    persistShapeToolConfig();
  });
});

document.getElementById('shapeToolPolySidesInput')?.addEventListener('input', (e) => {
  const n = Math.round(Number(e.target.value));
  if (!Number.isFinite(n)) return;
  shapeToolConfig.polygonSides = Math.max(3, Math.min(24, n));
  persistShapeToolConfig();
});

document.getElementById('shapeToolCornerToggleBtn')?.addEventListener('click', () => {
  shapeToolConfig.cornerEnabled = !shapeToolConfig.cornerEnabled;
  syncShapeToolbarUI();
  persistShapeToolConfig();
});

document.getElementById('shapeToolCornerInput')?.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v)) return;
  shapeToolConfig.cornerRadius = Math.max(0, Math.min(120, v));
  persistShapeToolConfig();
});

document.getElementById('shapeToolFillToggleBtn')?.addEventListener('click', () => {
  shapeToolConfig.fillEnabled = !shapeToolConfig.fillEnabled;
  syncShapeToolbarUI();
  persistShapeToolConfig();
});

document.getElementById('shapeToolFillColorInput')?.addEventListener('input', (e) => {
  shapeToolConfig.fillColor = e.target.value || '#0a84ff';
  persistShapeToolConfig();
});

document.getElementById('shapeToolFillOpacitySelect')?.addEventListener('change', (e) => {
  shapeToolConfig.fillOpacity = Number(e.target.value) || 0.25;
  persistShapeToolConfig();
});

document.getElementById('shapeToolBorderStyleSelect')?.addEventListener('change', (e) => {
  shapeToolConfig.borderStyle = e.target.value || 'solid';
  persistShapeToolConfig();
});

document.getElementById('shapeToolBorderWidthSelect')?.addEventListener('change', (e) => {
  shapeToolConfig.borderWidth = Number(e.target.value) || 3.5;
  persistShapeToolConfig();
});

document.getElementById('shapeToolStrokeColorInput')?.addEventListener('input', (e) => {
  shapeToolConfig.strokeColor = e.target.value || '#0a84ff';
  persistShapeToolConfig();
});

document.getElementById('exitShapeModeBtn')?.addEventListener('click', () => setToolMode('select'));

// --- Selected Shape Object Inspector Controls ---
function updateSelectedShapes(mutator, actionLabel) {
  const shapes = getSelectedObjects().filter((o) => o.type === 'shape');
  if (!shapes.length) return;
  pushUndoSnapshot(actionLabel);
  shapes.forEach((o) => mutator(o));
  shapes.forEach((o) => {
    const domEl = objectLayer.querySelector(`.ff-object[data-id="${o.id}"]`);
    const sWrap = domEl?.querySelector('.ff-shape-wrap');
    if (sWrap) renderShapeObjectInto(sWrap, o);
  });
  syncSelectionUI();
  scheduleSaveBoard();
}

document.getElementById('inspShapeTypeSelect')?.addEventListener('change', (e) => {
  const nextType = e.target.value || 'rect';
  updateSelectedShapes((o) => {
    o.shapeType = nextType;
    if (nextType === 'circle') {
      const side = Math.max(o.width, o.height);
      o.width = side;
      o.height = side;
    }
    if (o.title === undefined || Object.values(SHAPE_LABELS_KO).includes(o.title) || /각형$/.test(o.title || '')) {
      o.title = nextType === 'polygon' ? `${o.polygonSides || 5}각형` : SHAPE_LABELS_KO[nextType];
    }
  }, '도형 모양 변경');
  renderAllObjects();
  renderAllConnectors();
});

document.getElementById('inspShapePolySidesInput')?.addEventListener('change', (e) => {
  const n = Math.max(3, Math.min(24, Math.round(Number(e.target.value)) || 5));
  updateSelectedShapes((o) => {
    o.polygonSides = n;
    if (o.shapeType === 'polygon' && (/각형$/.test(o.title || '') || !o.title)) o.title = `${n}각형`;
  }, '다각형 꼭짓점 수 변경');
  renderAllObjects();
});

document.getElementById('inspShapeCornerToggleBtn')?.addEventListener('click', () => {
  const shapes = getSelectedObjects().filter((o) => o.type === 'shape');
  if (!shapes.length) return;
  const next = !(shapes[0].cornerEnabled !== false);
  updateSelectedShapes((o) => {
    o.cornerEnabled = next;
  }, '도형 모서리 곡률 토글');
});

document.getElementById('inspShapeCornerRadiusInput')?.addEventListener('change', (e) => {
  const v = Math.max(0, Math.min(120, Number(e.target.value) || 0));
  updateSelectedShapes((o) => {
    o.cornerEnabled = true;
    o.cornerRadius = v;
  }, '도형 모서리 곡률 변경');
});

document.getElementById('inspShapeFillToggleBtn')?.addEventListener('click', () => {
  const shapes = getSelectedObjects().filter((o) => o.type === 'shape');
  if (!shapes.length) return;
  const next = !(shapes[0].fillEnabled !== false);
  updateSelectedShapes((o) => {
    o.fillEnabled = next;
  }, '도형 내부 채우기 토글');
});

document.getElementById('inspShapeFillColorInput')?.addEventListener('change', (e) => {
  const hex = e.target.value;
  updateSelectedShapes((o) => {
    o.fillEnabled = true;
    o.fillColor = hex;
  }, '도형 채우기 색상 변경');
});

document.getElementById('inspShapeFillOpacitySelect')?.addEventListener('change', (e) => {
  const op = Number(e.target.value) || 0.25;
  updateSelectedShapes((o) => {
    o.fillOpacity = op;
  }, '도형 채우기 투명도 변경');
});

document.getElementById('inspShapeBorderStyleSelect')?.addEventListener('change', (e) => {
  const bs = e.target.value || 'solid';
  updateSelectedShapes((o) => {
    o.borderStyle = bs;
  }, '도형 테두리 모양 변경');
});

document.getElementById('inspShapeBorderWidthSelect')?.addEventListener('change', (e) => {
  const bw = Number(e.target.value) || 3.5;
  updateSelectedShapes((o) => {
    o.borderWidth = bw;
    if (o.borderStyle === 'none') o.borderStyle = 'solid';
  }, '도형 테두리 굵기 변경');
});

document.getElementById('inspShapeStrokeColorInput')?.addEventListener('change', (e) => {
  const hex = e.target.value;
  updateSelectedShapes((o) => {
    o.strokeColor = hex;
    if (o.borderStyle === 'none') o.borderStyle = 'solid';
  }, '도형 테두리 색상 변경');
});

document.getElementById('inspShapeBgBtn')?.addEventListener('click', () => {
  const shapes = getSelectedObjects().filter((o) => o.type === 'shape');
  if (!shapes.length) return;
  if (shapes.length === 1) {
    toggleShapeBackgroundMode(shapes[0]);
    return;
  }
  pushUndoSnapshot('도형 배경화');
  const next = !Boolean(shapes[0].shapeBackground);
  shapes.forEach((o) => {
    o.shapeBackground = next;
    if (next) selectedObjectIds.delete(o.id);
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
});

// --- Text/Title (label) Fill & Outline Inspector Controls ---
function updateSelectedLabels(mutator, actionLabel) {
  const labels = getSelectedObjects().filter((o) => o.type === 'label');
  if (!labels.length) return;
  pushUndoSnapshot(actionLabel);
  labels.forEach((o) => mutator(o));
  labels.forEach((o) => {
    if (o.vectorized) {
      const m = computeVectorLabelMetrics(o);
      o.vectorAspect = m.aspect;
      o.height = Math.max(40, Math.round((o.width || 380) / Math.max(0.2, m.aspect)));
      const domElV = objectLayer.querySelector(`.ff-object[data-id="${o.id}"]`);
      if (domElV) domElV.style.height = `${o.height}px`;
    }
    const domEl = objectLayer.querySelector(`.ff-object[data-id="${o.id}"]`);
    if (domEl) applyObjectCustomColorStyles(domEl, o);
  });
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
}

document.getElementById('inspLabelFillToggleBtn')?.addEventListener('click', () => {
  const labels = getSelectedObjects().filter((o) => o.type === 'label');
  if (!labels.length) return;
  const next = !Boolean(labels[0].labelBgEnabled);
  updateSelectedLabels((o) => {
    o.labelBgEnabled = next;
    if (next && !o.labelBgColor) o.labelBgColor = '#1c1c22';
  }, next ? '텍스트 박스 배경 채우기 ON' : '텍스트 박스 배경 채우기 OFF');
});

document.getElementById('inspLabelFillColorInput')?.addEventListener('input', (e) => {
  const hex = e.target.value;
  getSelectedObjects()
    .filter((o) => o.type === 'label')
    .forEach((o) => {
      o.labelBgEnabled = true;
      o.labelBgColor = hex;
      const domEl = objectLayer.querySelector(`.ff-object[data-id="${o.id}"]`);
      if (domEl) applyObjectCustomColorStyles(domEl, o);
    });
});

document.getElementById('inspLabelFillColorInput')?.addEventListener('change', (e) => {
  const hex = e.target.value;
  updateSelectedLabels((o) => {
    o.labelBgEnabled = true;
    o.labelBgColor = hex;
  }, '텍스트 박스 배경 색상 변경');
});

document.getElementById('inspLabelBgOpacitySelect')?.addEventListener('change', (e) => {
  const op = Number(e.target.value);
  updateSelectedLabels((o) => {
    o.labelBgEnabled = true;
    o.labelBgOpacity = Number.isFinite(op) ? op : 0.85;
  }, '텍스트 박스 배경 투명도 변경');
});

document.getElementById('inspLabelStrokeToggleBtn')?.addEventListener('click', () => {
  const labels = getSelectedObjects().filter((o) => o.type === 'label');
  if (!labels.length) return;
  const next = !Boolean(labels[0].labelStrokeEnabled);
  updateSelectedLabels((o) => {
    o.labelStrokeEnabled = next;
    if (!next && o.labelFillEnabled === false) o.labelFillEnabled = true;
  }, '텍스트 외곽선 토글');
});

document.getElementById('inspLabelStrokeColorInput')?.addEventListener('change', (e) => {
  const hex = e.target.value;
  updateSelectedLabels((o) => {
    o.labelStrokeEnabled = true;
    o.labelStrokeColor = hex;
  }, '텍스트 외곽선 색상 변경');
});

document.getElementById('inspLabelStrokeWidthSelect')?.addEventListener('change', (e) => {
  const sw = Number(e.target.value) || 6;
  updateSelectedLabels((o) => {
    o.labelStrokeEnabled = true;
    o.labelStrokeWidth = sw;
  }, '텍스트 외곽선 굵기 변경');
});

// --- Text/Title Box Border Controls ---
document.getElementById('inspLabelBoxBorderToggleBtn')?.addEventListener('click', () => {
  const labels = getSelectedObjects().filter((o) => o.type === 'label');
  if (!labels.length) return;
  const next = !Boolean(labels[0].labelBoxBorderEnabled);
  updateSelectedLabels((o) => {
    o.labelBoxBorderEnabled = next;
    if (next) {
      if (!o.labelBoxBorderColor) o.labelBoxBorderColor = '#0a84ff';
      if (!o.labelBoxBorderWidth) o.labelBoxBorderWidth = 2;
      if (!o.labelBoxBorderStyle) o.labelBoxBorderStyle = 'solid';
    }
  }, next ? '텍스트 박스 테두리 ON' : '텍스트 박스 테두리 OFF');
});

document.getElementById('inspLabelBoxBorderColorInput')?.addEventListener('change', (e) => {
  const hex = e.target.value;
  updateSelectedLabels((o) => {
    o.labelBoxBorderEnabled = true;
    o.labelBoxBorderColor = hex;
  }, '텍스트 박스 테두리 색상 변경');
});

document.getElementById('inspLabelBoxBorderWidthSelect')?.addEventListener('change', (e) => {
  const bw = Number(e.target.value) || 2;
  updateSelectedLabels((o) => {
    o.labelBoxBorderEnabled = true;
    o.labelBoxBorderWidth = bw;
  }, '텍스트 박스 테두리 굵기 변경');
});

document.getElementById('inspLabelBoxBorderStyleSelect')?.addEventListener('change', (e) => {
  const bs = e.target.value || 'solid';
  updateSelectedLabels((o) => {
    o.labelBoxBorderEnabled = true;
    o.labelBoxBorderStyle = bs;
  }, '텍스트 박스 테두리 모양 변경');
});

// --- Object Opacity Toggle (기본 투명도 <-> 불투명) ---
document.getElementById('inspOpacityBtn')?.addEventListener('click', toggleSelectedObjectsOpacity);

// ============================================================================
// Unified Fast Black Floating Tooltip (replaces slow native `title` tooltips everywhere)
// ============================================================================
const SPAN_TOOLTIP_HOSTS =
  '.top-titlebar .tool-btn, .sync-status-pill, .insp-obj-only-group .insp-btn, #inspDeleteBtn, #undoStrokeBtn';
const FLOATING_TIP_TARGETS = 'button, select, input, label, .swatch, .pen-color, .hud-btn, [role="button"], .board-item, .drive-path-box, .ff-obj-icon-btn';
const floatingTipEl = document.createElement('div');
floatingTipEl.className = 'ff-floating-tip';
document.body.appendChild(floatingTipEl);
let floatingTipHost = null;

function hideFloatingTip() {
  floatingTipHost = null;
  floatingTipEl.classList.remove('visible');
}

function positionFloatingTip(host) {
  const r = host.getBoundingClientRect();
  const tipW = floatingTipEl.offsetWidth;
  const tipH = floatingTipEl.offsetHeight;
  const gap = 8;
  let left = r.left + r.width / 2 - tipW / 2;
  left = Math.max(6, Math.min(window.innerWidth - tipW - 6, left));
  let top = r.bottom + gap;
  let above = false;
  if (top + tipH > window.innerHeight - 6) {
    top = r.top - tipH - gap;
    above = true;
  }
  floatingTipEl.classList.toggle('is-above', above);
  floatingTipEl.style.left = `${Math.round(left)}px`;
  floatingTipEl.style.top = `${Math.round(Math.max(6, top))}px`;
}

document.addEventListener(
  'mouseover',
  (e) => {
    const titled = e.target.closest?.('.ff-obj-icon-btn, [title], [data-ff-tip]');
    if (!titled) {
      if (floatingTipHost && !floatingTipHost.contains(e.target)) hideFloatingTip();
      return;
    }
    // Object header icon buttons: their hidden <span> label becomes the floating tooltip text
    if (titled.matches('.ff-obj-icon-btn')) {
      const spanTxt = titled.querySelector(':scope > span')?.textContent?.trim();
      if (spanTxt) titled.dataset.ffTip = spanTxt;
      titled.removeAttribute('title');
    }
    // Move native title into data attribute so the slow white OS tooltip never appears
    if (titled.hasAttribute('title')) {
      const t = titled.getAttribute('title');
      if (t) titled.dataset.ffTip = t;
      titled.removeAttribute('title');
    }
    // Buttons that already render their own black <span> tooltip keep it (no duplicate)
    if (titled.matches(SPAN_TOOLTIP_HOSTS)) {
      hideFloatingTip();
      return;
    }
    if (!titled.matches(FLOATING_TIP_TARGETS) && !titled.closest('.object-inspector, .pen-toolbar, .canvas-hud, .grid-settings-popover, .modal-overlay, .modal-card')) {
      if (floatingTipHost) hideFloatingTip();
      return;
    }
    const tipText = titled.dataset.ffTip;
    if (!tipText) return;
    if (floatingTipHost === titled) return;
    floatingTipHost = titled;
    floatingTipEl.textContent = tipText;
    floatingTipEl.classList.remove('visible');
    positionFloatingTip(titled);
    requestAnimationFrame(() => {
      if (floatingTipHost === titled) floatingTipEl.classList.add('visible');
    });
  },
  true
);

document.addEventListener(
  'mouseout',
  (e) => {
    if (floatingTipHost && (!e.relatedTarget || !floatingTipHost.contains(e.relatedTarget))) {
      hideFloatingTip();
    }
  },
  true
);
['pointerdown', 'wheel', 'keydown', 'scroll'].forEach((evt) =>
  window.addEventListener(evt, hideFloatingTip, { capture: true, passive: true })
);

// ============================================================================
// Persistent Swatch Color Picker (Right-Click on Object & Pen Swatches)
// ============================================================================
const swatchColorPickerInput = document.getElementById('swatchColorPickerInput');
let activeColorPickerTarget = null; // { kind: 'object' | 'pen', slot: number, btn: HTMLElement }

function applySwatchHexToShapeOrLabel(o, hex) {
  if (!o || !hex) return;
  if (o.type === 'shape') {
    o.fillColor = hex;
    o.strokeColor = hex;
  } else if (o.type === 'label') {
    o.labelFillColor = hex;
  }
}

function generateVibrantRandomHex() {
  const h = Math.floor(Math.random() * 360);
  const s = 72 + Math.floor(Math.random() * 22); // 72% - 94%
  const l = 50 + Math.floor(Math.random() * 14); // 50% - 64%
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function applyCustomSwatchesToDOM() {
  document.querySelectorAll('#inspectorColors .swatch:not(.random-swatch)').forEach((sw, idx) => {
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
        applySwatchHexToShapeOrLabel(o, hex);
        if (hasBorderFrameSupport(o)) {
          o.borderEnabled = true;
          o.borderColor = hex;
          if (!o.borderWidth) o.borderWidth = 4;
          if (!o.borderStyle) o.borderStyle = 'solid';
        }
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
document.querySelectorAll('#inspectorColors .swatch:not(.random-swatch)').forEach((sw, idx) => {
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
      applySwatchHexToShapeOrLabel(o, slotHex);
      if (hasBorderFrameSupport(o)) {
        o.borderEnabled = true;
        o.borderColor = slotHex;
        if (!o.borderWidth) o.borderWidth = 4;
        if (!o.borderStyle) o.borderStyle = 'solid';
      }
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

// Random Color Swatch Button (Assigns a unique random hex to currently selected objects without mutating other objects!)
document.getElementById('inspRandomColorBtn')?.addEventListener('click', () => {
  const randomHex = generateVibrantRandomHex();
  const selectedConn = getSelectedConnector();
  if (selectedConn) {
    pushUndoSnapshot('화살표 랜덤 색상 적용');
    selectedConn.color = randomHex;
    renderAllConnectors();
    syncSelectionUI();
    scheduleSaveBoard();
    showToast(`🎲 랜덤 컬러 적용: ${randomHex.toUpperCase()}`);
    return;
  }

  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot('객체 고유 랜덤 색상 적용');
  selected.forEach((o) => {
    o.customColor = randomHex;
    applySwatchHexToShapeOrLabel(o, randomHex);
    if (hasBorderFrameSupport(o)) {
      o.borderEnabled = true;
      o.borderColor = randomHex;
      if (!o.borderWidth) o.borderWidth = 4;
      if (!o.borderStyle) o.borderStyle = 'solid';
    }
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(`🎲 고유 랜덤 컬러 적용: ${randomHex.toUpperCase()}`);
});

// Image / Sticker Aspect Ratio Lock & Image / Sticker / PDF Colored Border Controls
document.getElementById('inspImgAspectBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects().filter((o) => o.type === 'image' || o.type === 'sticker');
  if (!selected.length) return;
  pushUndoSnapshot('비율유지 전환');
  const nextKeep = !(selected[0].keepAspect !== false);
  selected.forEach((o) => {
    o.keepAspect = nextKeep;
    if (nextKeep && o.imageAspect && o.imageAspect > 0) {
      o.height = Math.max(48, Math.round(o.width / o.imageAspect));
    }
  });
  renderAllObjects();
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(nextKeep ? '🔒 비율유지 ON (여백 없이 비율 고정)' : '🔓 자유비율 크기조절 모드 (여백 없음)');
});

document.getElementById('inspImgBorderToggleBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects().filter((o) => hasBorderFrameSupport(o));
  if (!selected.length) return;
  pushUndoSnapshot('외곽선 토글');
  const nextBorder = !Boolean(selected[0].borderEnabled);
  selected.forEach((o) => {
    o.borderEnabled = nextBorder;
    if (nextBorder) {
      if (!o.borderWidth) o.borderWidth = 4;
      if (!o.borderStyle) o.borderStyle = 'solid';
      if (!o.borderColor) {
        o.borderColor = o.customColor || getResolvedObjectColorHex(o) || '#0a84ff';
      }
    }
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(nextBorder ? '🖼️ 외곽선(테두리) ON' : '외곽선(테두리) OFF');
});

document.getElementById('inspImgBorderWidthSelect')?.addEventListener('change', (e) => {
  const bw = Number(e.target.value) || 4;
  const selected = getSelectedObjects().filter((o) => hasBorderFrameSupport(o));
  if (!selected.length) return;
  pushUndoSnapshot('외곽선 두께 변경');
  selected.forEach((o) => {
    o.borderEnabled = true;
    o.borderWidth = bw;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
});

document.getElementById('inspImgBorderStyleSelect')?.addEventListener('change', (e) => {
  const bs = e.target.value || 'solid';
  const selected = getSelectedObjects().filter((o) => hasBorderFrameSupport(o));
  if (!selected.length) return;
  pushUndoSnapshot('외곽선 모양 변경');
  selected.forEach((o) => {
    o.borderEnabled = true;
    o.borderStyle = bs;
  });
  renderAllObjects();
  syncSelectionUI();
  scheduleSaveBoard();
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
function restoreLastFocusedEditorAfterInspectorChange() {
  if (!lastActiveAlignTarget || !lastActiveAlignTarget.obj || !selectedObjectIds.has(lastActiveAlignTarget.obj.id)) {
    return;
  }
  const t = lastActiveAlignTarget;
  const focusEl =
    (t.kind === 'check-row' && t.inputEl?.isConnected && t.inputEl) ||
    (t.kind === 'line-editor' && t.editorEl?.isConnected && t.editorEl) ||
    (t.kind === 'title' && t.el?.isConnected && t.el) ||
    (t.kind === 'table-cell' && t.tdEl?.isConnected && (t.tdEl.querySelector('span[contenteditable="true"]') || t.tdEl));
  if (focusEl && typeof focusEl.focus === 'function') {
    requestAnimationFrame(() => {
      focusEl.focus();
    });
  }
}

function updateSelectedObjectsTextStyle(mutator, actionLabel = '텍스트 서식 변경', restoreFocus = false) {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot(actionLabel);
  selected.forEach((obj) => {
    if (
      obj.type === 'table' &&
      activeTableCellSelection.objId === obj.id &&
      activeTableCellSelection.cells.size > 0
    ) {
      if (!obj.cellStyles || typeof obj.cellStyles !== 'object') obj.cellStyles = {};
      const totalCells = (obj.tableData?.length || 0) * (obj.tableData?.[0]?.length || 0);
      if (activeTableCellSelection.cells.size >= totalCells && totalCells > 0) {
        const curBase = getObjectTextStyle(obj);
        obj.textStyle = mutator({ ...curBase }, obj);
      }
      activeTableCellSelection.cells.forEach((ck) => {
        const curCell = getCellEffectiveTextStyle(obj, ck);
        const nextCell = mutator({ ...curCell }, obj);
        obj.cellStyles[ck] = {
          fontFamily: nextCell.fontFamily,
          fontSize: nextCell.fontSize,
          bold: nextCell.bold,
          italic: nextCell.italic,
          underline: nextCell.underline
        };
      });
    } else {
      const cur = getObjectTextStyle(obj);
      const next = mutator({ ...cur }, obj);
      obj.textStyle = next;
      if (obj.type === 'table' && obj.cellStyles) {
        // When updating the entire table with no specific cell selected, propagate to any customized cells too
        Object.keys(obj.cellStyles).forEach((ck) => {
          const curCell = getCellEffectiveTextStyle(obj, ck);
          const nextCell = mutator({ ...curCell }, obj);
          obj.cellStyles[ck] = {
            fontFamily: nextCell.fontFamily,
            fontSize: nextCell.fontSize,
            bold: nextCell.bold,
            italic: nextCell.italic,
            underline: nextCell.underline
          };
        });
      }
    }
    const domEl = objectLayer.querySelector(`.ff-object[data-id="${obj.id}"]`);
    if (domEl) applyObjectTypography(domEl, obj);
  });
  syncSelectionUI();
  scheduleSaveBoard();
  if (restoreFocus) {
    restoreLastFocusedEditorAfterInspectorChange();
  }
}

document.getElementById('inspFontFamilySelect')?.addEventListener('change', (e) => {
  const fontFamily = e.target.value || 'system';
  updateSelectedObjectsTextStyle((st) => ({ ...st, fontFamily }), '폰트 변경', true);
});

document.getElementById('inspFontSizeSelect')?.addEventListener('change', (e) => {
  const fontSize = Number(e.target.value) || 14;
  updateSelectedObjectsTextStyle((st) => ({ ...st, fontSize }), '폰트 크기 변경', true);
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
  const selected = getSelectedObjects().filter((o) => isVectorizableObject(o));
  if (!selected.length) return;
  if (selected.length === 1) {
    toggleObjectVectorized(selected[0]);
    return;
  }
  const nextVec = !Boolean(selected[0].vectorized);
  pushUndoSnapshot(nextVec ? '객체 벡터 이미지화' : '벡터 이미지 해제');
  selected.forEach((o) => {
    o.vectorized = nextVec;
    if (nextVec) {
      if (o.type === 'label') {
        if (!(o.content || '').trim()) {
          o.content = (o.title && o.title !== '텍스트') ? o.title : '프로젝트 타이틀';
        }
        const m = computeVectorLabelMetrics(o);
        o.vectorAspect = m.aspect;
        const baseW = Math.max(200, Math.round(o.width || 380));
        o.width = baseW;
        o.height = Math.max(48, Math.round(baseW / Math.max(0.2, m.aspect)));
      } else {
        const curW = Math.max(180, Math.round(o.width || 320));
        const curH = Math.max(110, Math.round(o.height || 220));
        o.vectorBaseW = curW;
        o.vectorBaseH = curH;
        o.vectorAspect = curW / curH;
      }
    }
  });
  renderAllObjects();
  renderAllConnectors();
  syncSelectionUI();
  scheduleSaveBoard();
  showToast(
    nextVec
      ? '✨ 선택된 객체가 벡터 이미지로 변환되었습니다!'
      : '📝 일반 객체 편집 모드로 전환되었습니다'
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

function getActiveSelectionBaseTextStyle(obj) {
  if (
    obj &&
    obj.type === 'table' &&
    activeTableCellSelection.objId === obj.id &&
    activeTableCellSelection.cells.size > 0
  ) {
    const anchorKey = activeTableCellSelection.anchor
      ? `${activeTableCellSelection.anchor.rIdx}_${activeTableCellSelection.anchor.cIdx}`
      : Array.from(activeTableCellSelection.cells)[0];
    return getCellEffectiveTextStyle(obj, anchorKey);
  }
  return getObjectTextStyle(obj);
}

function toggleSelectedObjectsBold() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getActiveSelectionBaseTextStyle(selected[0]).bold;
  updateSelectedObjectsTextStyle((st) => ({ ...st, bold: nextVal }), '굵게 서식 변경', true);
}

function toggleSelectedObjectsItalic() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getActiveSelectionBaseTextStyle(selected[0]).italic;
  updateSelectedObjectsTextStyle((st) => ({ ...st, italic: nextVal }), '기울임 서식 변경', true);
}

function toggleSelectedObjectsUnderline() {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  const nextVal = !getActiveSelectionBaseTextStyle(selected[0]).underline;
  updateSelectedObjectsTextStyle((st) => ({ ...st, underline: nextVal }), '밑줄 서식 변경', true);
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

  // 0. If 1 or more cells are selected in a table, align ALL selected cells at once!
  if (
    activeTableCellSelection.objId &&
    selectedObjectIds.has(activeTableCellSelection.objId) &&
    activeTableCellSelection.cells.size > 0
  ) {
    const tObj = currentBoard?.objects.find((o) => o.id === activeTableCellSelection.objId);
    if (tObj && tObj.type === 'table') {
      pushUndoSnapshot(`표 선택 셀(${activeTableCellSelection.cells.size}개) ${labelMap[align]}`);
      if (!tObj.cellAligns) tObj.cellAligns = {};
      const domEl = objectLayer?.querySelector(`.ff-object[data-id="${tObj.id}"]`);
      activeTableCellSelection.cells.forEach((ck) => {
        tObj.cellAligns[ck] = align;
        const td = domEl?.querySelector(`.ff-table td[data-cell-key="${ck}"]`);
        if (td) {
          td.style.textAlign = align;
          const sp = td.querySelector('span[contenteditable="true"]');
          if (sp) sp.style.textAlign = align;
        }
      });
      if (tObj.vectorized) {
        const vecWrap = domEl?.querySelector('.ff-universal-vector-wrap');
        if (vecWrap) renderUniversalVectorizedObjectInto(vecWrap, tObj);
      }
      syncAlignButtonsUI(align);
      scheduleSaveBoard();
      return;
    }
  }

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
    if (obj.vectorized && obj.type !== 'label') {
      const vecWrap = domEl.querySelector('.ff-universal-vec-wrap');
      if (vecWrap) renderUniversalVectorizedObjectInto(vecWrap, obj);
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

const inspGroupNameInput = document.getElementById('inspGroupNameInput');
if (inspGroupNameInput) {
  inspGroupNameInput.addEventListener('input', () => {
    const selected = getSelectedObjects().filter((o) => Boolean(o.groupId));
    if (!selected.length) return;
    const gid = selected[0].groupId;
    setGroupName(gid, inspGroupNameInput.value);
    scheduleSaveBoard();
    if (typeof isCanvasSearchOpen === 'function' && isCanvasSearchOpen()) {
      performCanvasUnifiedSearch(document.getElementById('canvasSearchInput')?.value || '', { preserveIndex: true });
    }
  });
  inspGroupNameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') {
      inspGroupNameInput.blur();
    }
  });
}

document.getElementById('inspBringFrontBtn')?.addEventListener('click', () => {
  const selected = getSelectedObjects();
  if (!selected.length) return;
  pushUndoSnapshot('맨 앞으로 가져오기');
  selected.forEach((o) => (o.zIndex = getNextZIndex()));
  renderAllObjects();
  scheduleSaveBoard();
  showToast('선택한 객체를 맨 앞으로 가져왔습니다');
});

document.getElementById('inspSendBackBtn')?.addEventListener('click', () => {
  sendSelectedObjectsToBack();
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
  if (e.key === 'Control' || e.ctrlKey) {
    document.body.classList.add('ctrl-move-mode');
  }

  const isEditingText = Boolean(
    e.target.closest('input, textarea, [contenteditable="true"]') ||
      (document.activeElement && document.activeElement.closest('input, textarea, [contenteditable="true"]'))
  );

  // Unified Canvas Search (Ctrl+F / Cmd+F) works anytime!
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
    e.preventDefault();
    openCanvasSearchBar();
    return;
  }

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
    if (document.activeElement && document.activeElement.id === 'canvasSearchInput') {
      closeCanvasSearchBar();
      return;
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    hideContextMenu();
    document.getElementById('linkModal')?.classList.add('hidden');
    document.getElementById('syncModal')?.classList.add('hidden');
    document.getElementById('stickerModal')?.classList.add('hidden');
    document.getElementById('lightboxModal')?.classList.add('hidden');
    document.getElementById('gridSettingsPopover')?.classList.add('hidden');
    if (selectedObjectIds.size === 0 && !selectedConnectorId && isCanvasSearchOpen()) {
      closeCanvasSearchBar();
      return;
    }
    if ((activeTool === 'pen' || activeTool === 'shape') && selectedObjectIds.size === 0 && !selectedConnectorId) {
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
    !document.getElementById('stickerModal')?.classList.contains('hidden') ||
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
    } else if (code === 'KeyB' || key === 'b') {
      e.preventDefault();
      setToolMode(activeTool === 'shape' ? 'select' : 'shape');
      showToast(activeTool === 'shape' ? '🔷 도형 그리기 모드 (B) — 드래그하여 도형 생성 (Shift: 정비율)' : '선택 도구 (A)');
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
    } else if (code === 'KeyK' || key === 'k') {
      e.preventDefault();
      setToolMode('select');
      document.getElementById('addStickerBtn')?.click();
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

window.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || !e.ctrlKey) {
    document.body.classList.remove('ctrl-move-mode');
  }
});

window.addEventListener('blur', () => {
  document.body.classList.remove('ctrl-move-mode');
});

document.getElementById('lightboxModal')?.addEventListener('click', () => {
  document.getElementById('lightboxModal')?.classList.add('hidden');
});

// ============================================================================
// Zoom & View HUD Controls
// ============================================================================
document.getElementById('zoomInBtn')?.addEventListener('click', () => {
  zoomAtScreenPoint(zoom * 1.18);
  scheduleSaveBoard();
});
document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
  zoomAtScreenPoint(zoom / 1.18);
  scheduleSaveBoard();
});
document.getElementById('zoomResetBtn')?.addEventListener('click', () => {
  animateViewportTo(80, 60, 1, 320);
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
  const targetZoom = Math.min(1.4, Math.max(0.1, Math.min(rect.width / contentW, rect.height / contentH)));
  const targetPanX = Math.round((rect.width - (maxX - minX) * targetZoom) / 2 - minX * targetZoom);
  const targetPanY = Math.round((rect.height - (maxY - minY) * targetZoom) / 2 - minY * targetZoom);
  animateViewportTo(targetPanX, targetPanY, targetZoom, 420);
  scheduleSaveBoard();
});

const GRID_MODES = ['grid-dots', 'grid-lines', 'grid-none'];
const GRID_MODE_LABELS = {
  'grid-dots': '도트',
  'grid-lines': '격자',
  'grid-none': '무지'
};

function syncGridSettingsUI() {
  const mode = GRID_MODES.includes(gridConfig.mode) ? gridConfig.mode : 'grid-dots';
  gridConfig.mode = mode;

  // Normalize legacy spacingUnit -> unit if present
  if (!gridConfig.unit && gridConfig.spacingUnit) {
    gridConfig.unit = gridConfig.spacingUnit;
  }
  const unit = ['px', 'cm', 'm'].includes(gridConfig.unit) ? gridConfig.unit : 'px';
  gridConfig.unit = unit;

  if (canvasViewport) {
    canvasViewport.classList.remove(...GRID_MODES);
    canvasViewport.classList.add(mode);
  }

  const lbl = document.getElementById('toggleGridLabel');
  if (lbl) lbl.textContent = GRID_MODE_LABELS[mode] || '도트';

  // Background style pills
  document.querySelectorAll('.grid-style-pill[data-grid-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.gridMode === mode);
  });

  // Unit pills
  document.querySelectorAll('.grid-unit-pill[data-grid-unit]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.gridUnit === unit);
  });

  // Range & Number inputs + suffix
  const rangeEl = document.getElementById('gridSpacingRange');
  const numEl = document.getElementById('gridSpacingNumber');
  const suffixEl = document.getElementById('gridSpacingUnitSuffix');

  let minVal = 8;
  let maxVal = 200;
  let stepVal = 1;
  let defaultVal = 24;
  if (unit === 'cm') {
    minVal = 0.2;
    maxVal = 10;
    stepVal = 0.1;
    defaultVal = 1;
  } else if (unit === 'm') {
    minVal = 0.01;
    maxVal = 0.5;
    stepVal = 0.01;
    defaultVal = 0.05;
  }

  const curVal =
    Number.isFinite(Number(gridConfig.spacingValue)) && Number(gridConfig.spacingValue) > 0
      ? Number(gridConfig.spacingValue)
      : defaultVal;
  gridConfig.spacingValue = curVal;

  if (rangeEl) {
    rangeEl.min = String(minVal);
    rangeEl.max = String(maxVal);
    rangeEl.step = String(stepVal);
    rangeEl.value = String(Math.min(maxVal, Math.max(minVal, curVal)));
  }
  if (numEl) {
    numEl.min = String(minVal);
    numEl.max = String(unit === 'px' ? 500 : unit === 'cm' ? 30 : 1);
    numEl.step = String(stepVal);
    numEl.value = String(curVal);
  }
  if (suffixEl) {
    suffixEl.textContent = unit;
  }

  const snapObjEl = document.getElementById('snapObjectsCheckbox');
  const snapDrawEl = document.getElementById('snapDrawingCheckbox');
  if (snapObjEl) snapObjEl.checked = Boolean(gridConfig.snapObjects);
  if (snapDrawEl) snapDrawEl.checked = Boolean(gridConfig.snapDrawing);

  const openBtn = document.getElementById('openGridSettingsBtn');
  const snapBadge = document.getElementById('gridSnapBadge');
  const anySnap = Boolean(gridConfig.snapObjects || gridConfig.snapDrawing);
  if (openBtn) {
    openBtn.classList.toggle('active', anySnap);
    openBtn.classList.toggle('snap-active', anySnap);
  }
  if (snapBadge) {
    snapBadge.textContent = anySnap ? '스냅 ON' : '스냅';
  }
}

async function persistGridConfig() {
  try {
    await window.freeformAPI.saveConfig({ gridConfig });
  } catch (err) {
    console.warn('persistGridConfig error:', err);
  }
}

function setGridBackgroundMode(mode, notify = true) {
  if (!GRID_MODES.includes(mode)) return;
  gridConfig.mode = mode;
  syncGridSettingsUI();
  applyViewportTransform();
  persistGridConfig();
  if (notify) {
    showToast(`캔버스 배경: ${GRID_MODE_LABELS[mode]}`);
  }
}

document.getElementById('toggleGridBtn')?.addEventListener('click', () => {
  const curIdx = Math.max(0, GRID_MODES.indexOf(gridConfig.mode || 'grid-dots'));
  const nextMode = GRID_MODES[(curIdx + 1) % GRID_MODES.length];
  setGridBackgroundMode(nextMode, true);
});

document.getElementById('toggleGridBtn')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  syncGridSettingsUI();
  gridSettingsPopover?.classList.remove('hidden');
});

const gridSettingsPopover = document.getElementById('gridSettingsPopover');
document.getElementById('openGridSettingsBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  syncGridSettingsUI();
  gridSettingsPopover?.classList.toggle('hidden');
});
document.getElementById('closeGridPopoverBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  gridSettingsPopover?.classList.add('hidden');
});
document.getElementById('closeGridSettingsBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  gridSettingsPopover?.classList.add('hidden');
});
gridSettingsPopover?.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});
window.addEventListener('pointerdown', (e) => {
  if (
    gridSettingsPopover &&
    !gridSettingsPopover.classList.contains('hidden') &&
    !gridSettingsPopover.contains(e.target) &&
    !e.target.closest('#openGridSettingsBtn') &&
    !e.target.closest('#toggleGridBtn')
  ) {
    gridSettingsPopover.classList.add('hidden');
  }
});

// Background style pill buttons inside #gridSettingsPopover
document.querySelectorAll('.grid-style-pill[data-grid-mode]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const mode = btn.dataset.gridMode;
    if (mode) setGridBackgroundMode(mode, true);
  });
});

// Spacing unit pill buttons (px / cm / m) inside #gridSettingsPopover
document.querySelectorAll('.grid-unit-pill[data-grid-unit]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextUnit = btn.dataset.gridUnit || 'px';
    const prevUnit = gridConfig.unit || 'px';
    if (prevUnit === nextUnit) return;
    const prevPx = getGridSpacingWorldPx();
    gridConfig.unit = nextUnit;
    if (nextUnit === 'px') {
      gridConfig.spacingValue = Math.max(8, Math.min(500, Math.round(prevPx)));
    } else if (nextUnit === 'cm') {
      gridConfig.spacingValue = Math.max(0.2, Math.min(30, Number((prevPx / PX_PER_CM).toFixed(1))));
    } else if (nextUnit === 'm') {
      gridConfig.spacingValue = Math.max(0.01, Math.min(1, Number((prevPx / PX_PER_M).toFixed(2))));
    }
    syncGridSettingsUI();
    applyViewportTransform();
    persistGridConfig();
    showToast(`격자/도트 단위: ${nextUnit} (${gridConfig.spacingValue}${nextUnit})`);
  });
});

// Spacing range slider & number input
document.getElementById('gridSpacingRange')?.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val <= 0) return;
  gridConfig.spacingValue = val;
  const numEl = document.getElementById('gridSpacingNumber');
  if (numEl) numEl.value = String(val);
  applyViewportTransform();
  persistGridConfig();
});

document.getElementById('gridSpacingNumber')?.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val <= 0) return;
  gridConfig.spacingValue = val;
  const rangeEl = document.getElementById('gridSpacingRange');
  if (rangeEl) {
    const rMin = Number(rangeEl.min) || 0;
    const rMax = Number(rangeEl.max) || 500;
    rangeEl.value = String(Math.min(rMax, Math.max(rMin, val)));
  }
  applyViewportTransform();
  persistGridConfig();
});

// Snap checkboxes
document.getElementById('snapObjectsCheckbox')?.addEventListener('change', (e) => {
  gridConfig.snapObjects = Boolean(e.target.checked);
  syncGridSettingsUI();
  persistGridConfig();
  showToast(gridConfig.snapObjects ? '🧲 객체 이동·크기 조절 격자/도트 물림 ON' : '객체 격자/도트 물림 OFF');
});

document.getElementById('snapDrawingCheckbox')?.addEventListener('change', (e) => {
  gridConfig.snapDrawing = Boolean(e.target.checked);
  syncGridSettingsUI();
  persistGridConfig();
  showToast(gridConfig.snapDrawing ? '✏️ 펜·도형 그리기 격자/도트 물림 ON' : '그리기 격자/도트 물림 OFF');
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
  if (isSavingBoard || Date.now() - lastLocalSaveAt < 1500) {
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
    if (fresh && (Number(fresh.updatedAt) || 0) > (Number(currentBoard.updatedAt) || 0) + 100) {
      currentBoard = fresh;
      if (activeBoardTitleInput) activeBoardTitleInput.value = currentBoard.title || '제목 없는 보드';
      if (activeBoardEmoji) activeBoardEmoji.textContent = currentBoard.icon || '📋';
      renderAllObjects();
      renderAllConnectors();
      renderAllStrokes();
      if (isCanvasSearchOpen() && canvasSearchState.query) {
        performCanvasUnifiedSearch(canvasSearchState.query, { panToActive: false });
      }
    }
  }
});

window.freeformAPI.onBridgeAddObject?.((objData) => {
  if (!objData) return;

  if (Array.isArray(objData.objects) && objData.objects.length > 0) {
    pushUndoSnapshot(`Spotlight AI 블록 ${objData.objects.length}개 추가`);
    const center = getViewportCenterWorld();
    const cols = objData.objects.length > 2 ? 2 : 1;
    const colW = 430;
    const gapX = 28;
    const gapY = 26;
    const startX = center.x - Math.round(((cols * colW + (cols - 1) * gapX) / 2));
    let curY = center.y - Math.round((Math.ceil(objData.objects.length / cols) * 240) / 2);
    const createdIds = [];

    objData.objects.forEach((item, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const isTable = Boolean(item.tableData);
      const w = isTable ? 460 : 410;
      const lineCount = String(item.content || '').split(/\r?\n/).length;
      const h = isTable ? Math.min(360, Math.max(220, item.tableData.length * 36 + 70)) : Math.min(380, Math.max(210, lineCount * 22 + 95));
      const created = addObjectToBoard(
        {
          type: item.type || (isTable ? 'table' : 'text'),
          title: item.title || `✨ Spotlight AI 블록 #${idx + 1}`,
          content: item.content || '',
          tableData: item.tableData || null,
          url: item.url || null,
          x: startX + col * (colW + gapX),
          y: curY + row * (270 + gapY),
          width: w,
          height: h,
          color: item.color || (isTable ? 'blue' : 'dark')
        },
        idx === 0,
        false
      );
      if (created) createdIds.push(created.id);
    });

    if (createdIds.length > 0) {
      setSelectedObjectIds(createdIds);
    }
    showToast(`✨ Spotlight AI에서 ${objData.objects.length}개의 블록 객체가 보드에 추가되었습니다!`);
    return;
  }

  const isTable = Boolean(objData.tableData);
  const lineCount = String(objData.content || '').split(/\r?\n/).length;
  addObjectToBoard(
    {
      type: objData.type || (isTable ? 'table' : 'text'),
      title: objData.title || '✨ Spotlight AI 카드',
      content: objData.content || '',
      tableData: objData.tableData || null,
      url: objData.url || null,
      width: isTable ? 480 : 420,
      height: isTable ? 260 : Math.min(420, Math.max(240, lineCount * 22 + 95)),
      color: objData.color || (isTable ? 'blue' : 'dark')
    },
    true
  );
  showToast('✨ Spotlight AI에서 보낸 항목이 보드에 추가되었습니다!');
});

// ============================================================================
// Sticker Object Library (32 Built-in Vector Stickers + Custom PNG Auto-Vectorization)
// ============================================================================
function svgMarkupToDataUrl(svgMarkup) {
  let markup = String(svgMarkup || '').trim();
  if (markup.startsWith('<svg') && !/<svg[^>]*preserveAspectRatio\s*=/i.test(markup)) {
    markup = markup.replace(/^<svg\b/i, '<svg preserveAspectRatio="none"');
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function ensureStretchableStickerUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (!url.startsWith('data:image/svg+xml')) return url;
  const commaIdx = url.indexOf(',');
  if (commaIdx === -1) return url;
  const header = url.slice(0, commaIdx + 1);
  const body = url.slice(commaIdx + 1);
  try {
    let decoded = header.includes(';base64') ? atob(body) : decodeURIComponent(body);
    let modified = false;
    if (decoded.includes('<svg') && !/<svg[^>]*preserveAspectRatio\s*=/i.test(decoded)) {
      decoded = decoded.replace(/<svg\b/i, '<svg preserveAspectRatio="none"');
      modified = true;
    }
    if (decoded.includes('preserveAspectRatio="xMidYMid meet"')) {
      decoded = decoded.replace(/preserveAspectRatio="xMidYMid meet"/g, 'preserveAspectRatio="none"');
      modified = true;
    }
    if (!modified) return url;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(decoded)}`;
  } catch (_) {
    return url;
  }
}

const BUILTIN_STICKERS = [
  {
    id: 'heart',
    name: '하트',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff5e7e"/><stop offset="100%" stop-color="#ff2d55"/></linearGradient></defs><path d="M60 103 C60 103 16 74 16 42 C16 25 29 14 44 14 C53 14 60 20 60 27 C60 20 67 14 76 14 C91 14 104 25 104 42 C104 74 60 103 60 103 Z" fill="url(#g)" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/><path d="M32 34 C32 27 38 23 44 23" stroke="rgba(255,255,255,0.65)" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`
  },
  {
    id: 'pencil',
    name: '연필',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><g stroke="#ffffff" stroke-width="4" stroke-linejoin="round"><polygon points="22,98 36,68 52,84" fill="#ffd59e"/><polygon points="22,98 28,85 35,92" fill="#2c2c2e"/><polygon points="36,68 80,24 96,40 52,84" fill="#ffcc00"/><rect x="82" y="16" width="18" height="14" rx="4" transform="rotate(45 91 23)" fill="#ff6b8b"/></g></svg>`
  },
  {
    id: 'sun',
    name: '해 (태양)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><radialGradient id="sg" cx="50%" cy="45%" r="55%"><stop offset="0%" stop-color="#fff07c"/><stop offset="100%" stop-color="#ff9500"/></radialGradient></defs><g stroke="#ff9f0a" stroke-width="6" stroke-linecap="round"><line x1="60" y1="10" x2="60" y2="22"/><line x1="60" y1="98" x2="60" y2="110"/><line x1="10" y1="60" x2="22" y2="60"/><line x1="98" y1="60" x2="110" y2="60"/><line x1="24" y1="24" x2="33" y2="33"/><line x1="87" y1="87" x2="96" y2="96"/><line x1="96" y1="24" x2="87" y2="33"/><line x1="33" y1="87" x2="24" y2="96"/></g><circle cx="60" cy="60" r="28" fill="url(#sg)" stroke="#ffffff" stroke-width="4"/></svg>`
  },
  {
    id: 'moon',
    name: '달 (초승달)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M76 18 C50 22 32 45 36 72 C40 95 62 108 86 102 C67 112 42 107 28 90 C12 70 16 40 36 24 C48 15 62 14 76 18 Z" fill="#ffd60a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><polygon points="88,28 91,36 99,39 91,42 88,50 85,42 77,39 85,36" fill="#fff394"/><circle cx="72" cy="56" r="4" fill="#fff394"/></svg>`
  },
  {
    id: 'star',
    name: '별 (스타)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="stg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffe66d"/><stop offset="100%" stop-color="#ff9f0a"/></linearGradient></defs><polygon points="60,12 74,42 107,46 82,69 89,102 60,85 31,102 38,69 13,46 46,42" fill="url(#stg)" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'monitor',
    name: '모니터',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="14" y="20" width="92" height="64" rx="10" fill="#1c1c1e" stroke="#ffffff" stroke-width="4"/><rect x="20" y="26" width="80" height="48" rx="5" fill="#0a84ff"/><path d="M26 62 L46 42 L62 56 L82 36 L94 48 L94 74 L26 74 Z" fill="#64d2ff" opacity="0.65"/><rect x="48" y="84" width="24" height="12" fill="#8e8e93" stroke="#ffffff" stroke-width="3"/><rect x="34" y="95" width="52" height="7" rx="3.5" fill="#aeaeb2" stroke="#ffffff" stroke-width="3"/></svg>`
  },
  {
    id: 'laptop',
    name: '노트북',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="22" y="24" width="76" height="52" rx="7" fill="#2c2c2e" stroke="#ffffff" stroke-width="4"/><rect x="28" y="30" width="64" height="40" rx="3" fill="#30d158"/><path d="M45 50 L55 60 L76 40" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M10 76 L110 76 L102 90 L18 90 Z" fill="#8e8e93" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'bulb',
    name: '아이디어 전구',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M60 16 C38 16 24 31 24 51 C24 64 32 74 41 81 L44 90 L76 90 L79 81 C88 74 96 64 96 51 C96 31 82 16 60 16 Z" fill="#ffd60a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><rect x="45" y="90" width="30" height="9" rx="3" fill="#8e8e93" stroke="#ffffff" stroke-width="3"/><rect x="50" y="99" width="20" height="8" rx="4" fill="#636366" stroke="#ffffff" stroke-width="3"/><path d="M48 54 L56 44 L64 54 L72 44" stroke="#ff9500" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`
  },
  {
    id: 'check',
    name: '완료 체크',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" fill="#30d158" stroke="#ffffff" stroke-width="5"/><path d="M38 61 L53 76 L84 44" stroke="#ffffff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`
  },
  {
    id: 'fire',
    name: '불꽃 (핫이슈)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M62 12 C62 12 96 40 92 72 C89 94 72 106 58 106 C38 106 24 91 26 70 C28 53 42 44 42 44 C42 44 39 56 47 59 C43 38 62 12 62 12 Z" fill="#ff453a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><path d="M60 52 C60 52 76 66 73 84 C71 95 63 101 56 101 C47 101 41 93 43 82 C45 71 60 52 60 52 Z" fill="#ffd60a"/></svg>`
  },
  {
    id: 'rocket',
    name: '로켓 (런칭)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M88 18 C64 18 42 36 34 60 L20 66 L30 78 L42 86 L54 96 L60 82 C84 74 102 52 102 28 Z" fill="#0a84ff" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><circle cx="72" cy="46" r="10" fill="#ffffff"/><circle cx="72" cy="46" r="6" fill="#64d2ff"/><path d="M28 84 C20 90 16 102 16 102 C16 102 28 98 34 90 Z" fill="#ff9f0a" stroke="#ffffff" stroke-width="3"/></svg>`
  },
  {
    id: 'crown',
    name: '왕관 (VIP)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M16 88 L24 38 L48 60 L60 28 L72 60 L96 38 L104 88 Z" fill="#ffd60a" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/><circle cx="24" cy="32" r="6" fill="#ff375f" stroke="#ffffff" stroke-width="3"/><circle cx="60" cy="22" r="7" fill="#0a84ff" stroke="#ffffff" stroke-width="3"/><circle cx="96" cy="32" r="6" fill="#30d158" stroke="#ffffff" stroke-width="3"/></svg>`
  },
  {
    id: 'coffee',
    name: '커피 타임',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M84 48 H94 C101 48 106 54 106 61 C106 68 101 74 94 74 H84" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/><path d="M24 42 H86 V72 C86 89 72 100 55 100 C38 100 24 89 24 72 Z" fill="#c67c4e" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><path d="M42 28 C40 22 46 18 44 12 M58 28 C56 22 62 18 60 12 M74 28 C72 22 78 18 76 12" stroke="#ffffff" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`
  },
  {
    id: 'pin',
    name: '압정 핀',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><line x1="60" y1="68" x2="60" y2="108" stroke="#d1d1d6" stroke-width="6" stroke-linecap="round"/><path d="M36 22 H84 L76 50 L90 66 H30 L44 50 Z" fill="#ff3b30" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'megaphone',
    name: '메가폰 (공지)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M22 50 L86 24 V92 L22 66 Z" fill="#ff9f0a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><rect x="14" y="48" width="14" height="22" rx="4" fill="#ff3b30" stroke="#ffffff" stroke-width="3.5"/><path d="M28 68 L36 94 H48 L42 72" fill="#5e5ce6" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/><path d="M96 42 C104 48 104 68 96 74" stroke="#ffd60a" stroke-width="5" stroke-linecap="round" fill="none"/></svg>`
  },
  {
    id: 'camera',
    name: '카메라',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M20 38 H38 L45 26 H75 L82 38 H100 C105 38 108 42 108 47 V88 C108 93 105 97 100 97 H20 C15 97 12 93 12 88 V47 C12 42 15 38 20 38 Z" fill="#5e5ce6" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><circle cx="60" cy="67" r="19" fill="#64d2ff" stroke="#ffffff" stroke-width="4.5"/><circle cx="89" cy="50" r="4" fill="#ffd60a"/></svg>`
  },
  {
    id: 'music',
    name: '음표 (뮤직)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M44 84 V30 L92 20 V74" fill="none" stroke="#bf5af2" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><circle cx="34" cy="86" r="14" fill="#bf5af2" stroke="#ffffff" stroke-width="4"/><circle cx="82" cy="76" r="14" fill="#ff375f" stroke="#ffffff" stroke-width="4"/></svg>`
  },
  {
    id: 'gift',
    name: '선물 상자',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="22" y="50" width="76" height="54" rx="6" fill="#ff375f" stroke="#ffffff" stroke-width="4"/><rect x="16" y="36" width="88" height="18" rx="5" fill="#ff6482" stroke="#ffffff" stroke-width="4"/><rect x="53" y="36" width="14" height="68" fill="#ffd60a"/><path d="M60 36 C42 36 36 18 50 18 C58 18 60 30 60 36 C60 30 62 18 70 18 C84 18 78 36 60 36 Z" fill="none" stroke="#ffd60a" stroke-width="6" stroke-linecap="round"/></svg>`
  },
  {
    id: 'trophy',
    name: '트로피 (우승)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M34 26 H86 V52 C86 68 74 78 60 78 C46 78 34 68 34 52 Z" fill="#ffd60a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><path d="M34 32 H20 C20 50 26 58 36 58 M86 32 H100 C100 50 94 58 84 58" fill="none" stroke="#ffd60a" stroke-width="6" stroke-linecap="round"/><rect x="52" y="78" width="16" height="16" fill="#ff9f0a" stroke="#ffffff" stroke-width="3"/><rect x="36" y="92" width="48" height="12" rx="4" fill="#8e8e93" stroke="#ffffff" stroke-width="3.5"/></svg>`
  },
  {
    id: 'rainbow',
    name: '무지개',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M16 84 A44 44 0 0 1 104 84" fill="none" stroke="#ff3b30" stroke-width="9" stroke-linecap="round"/><path d="M25 84 A35 35 0 0 1 95 84" fill="none" stroke="#ff9500" stroke-width="9" stroke-linecap="round"/><path d="M34 84 A26 26 0 0 1 86 84" fill="none" stroke="#ffd60a" stroke-width="9" stroke-linecap="round"/><path d="M43 84 A17 17 0 0 1 77 84" fill="none" stroke="#30d158" stroke-width="9" stroke-linecap="round"/><path d="M52 84 A8 8 0 0 1 68 84" fill="none" stroke="#0a84ff" stroke-width="9" stroke-linecap="round"/></svg>`
  },
  {
    id: 'cloud',
    name: '구름',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M34 88 H88 C100 88 108 79 108 68 C108 58 100 50 90 49 C87 33 73 22 56 22 C39 22 25 34 23 50 C14 52 10 61 10 70 C10 80 20 88 34 88 Z" fill="#64d2ff" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'bolt',
    name: '번개 (스피드)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><polygon points="68,10 26,66 56,66 48,110 94,52 62,52" fill="#ffd60a" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'diamond',
    name: '다이아몬드',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><polygon points="34,22 86,22 108,48 60,104 12,48" fill="#5ac8fa" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><polyline points="12,48 108,48" stroke="#ffffff" stroke-width="3.5"/><polyline points="34,22 46,48 60,104 74,48 86,22" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'search',
    name: '돋보기',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><line x1="74" y1="74" x2="104" y2="104" stroke="#ff9f0a" stroke-width="12" stroke-linecap="round"/><circle cx="52" cy="52" r="32" fill="#64d2ff" fill-opacity="0.45" stroke="#ffffff" stroke-width="7"/></svg>`
  },
  {
    id: 'clock',
    name: '알람시계',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="64" r="40" fill="#ff453a" stroke="#ffffff" stroke-width="5"/><circle cx="60" cy="64" r="31" fill="#ffffff"/><polyline points="60,44 60,64 75,72" fill="none" stroke="#1c1c1e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 28 L38 16 M98 28 L82 16" stroke="#ffd60a" stroke-width="7" stroke-linecap="round"/></svg>`
  },
  {
    id: 'calendar',
    name: '달력 (일정)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="18" y="24" width="84" height="80" rx="12" fill="#ffffff" stroke="#d1d1d6" stroke-width="4"/><path d="M18 36 C18 29 23 24 30 24 H90 C97 24 102 29 102 36 V48 H18 Z" fill="#ff3b30"/><line x1="40" y1="16" x2="40" y2="30" stroke="#8e8e93" stroke-width="6" stroke-linecap="round"/><line x1="80" y1="16" x2="80" y2="30" stroke="#8e8e93" stroke-width="6" stroke-linecap="round"/><text x="60" y="88" font-family="sans-serif" font-size="36" font-weight="800" fill="#1c1c1e" text-anchor="middle">24</text></svg>`
  },
  {
    id: 'folder',
    name: '폴더',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M14 34 C14 28 18 24 24 24 H48 L58 34 H96 C102 34 106 38 106 44 V88 C106 94 102 98 96 98 H24 C18 98 14 94 14 88 Z" fill="#0a84ff" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><rect x="22" y="46" width="76" height="44" rx="6" fill="#64d2ff" opacity="0.55"/></svg>`
  },
  {
    id: 'speech',
    name: '말풍선',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M60 20 C30 20 12 38 12 60 C12 73 20 84 32 91 L22 106 L46 97 C50 98 55 99 60 99 C90 99 108 81 108 60 C108 38 90 20 60 20 Z" fill="#30d158" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/><circle cx="42" cy="60" r="6" fill="#ffffff"/><circle cx="60" cy="60" r="6" fill="#ffffff"/><circle cx="78" cy="60" r="6" fill="#ffffff"/></svg>`
  },
  {
    id: 'thumbsup',
    name: '엄지척 (최고)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="16" y="52" width="22" height="48" rx="5" fill="#0a84ff" stroke="#ffffff" stroke-width="4"/><path d="M38 54 L54 20 C60 20 66 25 65 34 L62 48 H92 C100 48 104 54 102 62 L94 92 C92 98 86 100 78 100 H38 Z" fill="#ffd60a" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/></svg>`
  },
  {
    id: 'target',
    name: '타겟 (목표)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" fill="#ff3b30" stroke="#ffffff" stroke-width="4.5"/><circle cx="60" cy="60" r="32" fill="#ffffff"/><circle cx="60" cy="60" r="19" fill="#ff3b30"/><circle cx="60" cy="60" r="8" fill="#ffd60a"/><line x1="60" y1="60" x2="102" y2="18" stroke="#30d158" stroke-width="6" stroke-linecap="round"/></svg>`
  },
  {
    id: 'book',
    name: '오픈 북 (책)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M60 32 C46 24 26 24 14 30 V92 C26 86 46 86 60 94 C74 86 94 86 106 92 V30 C94 24 74 24 60 32 Z" fill="#5e5ce6" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><line x1="60" y1="32" x2="60" y2="94" stroke="#ffffff" stroke-width="4"/></svg>`
  },
  {
    id: 'leaf',
    name: '나뭇잎 (에코)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M98 20 C52 20 22 46 22 86 C22 92 28 98 34 98 C74 98 100 68 98 20 Z" fill="#30d158" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"/><path d="M24 96 C46 74 66 56 90 30" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" fill="none"/></svg>`
  }
].map((item) => ({
  ...item,
  svgDataUrl: svgMarkupToDataUrl(item.svg)
}));

let customStickers = [];

async function persistCustomStickers() {
  try {
    localStorage.setItem('boss_custom_stickers_v1', JSON.stringify(customStickers));
  } catch (_) {}
  try {
    await window.freeformAPI.saveConfig({ customStickers });
  } catch (_) {}
}

/**
 * Automatically vectorizes a transparent PNG dataURL into a resolution-independent SVG dataURL.
 * - Crops excess transparent borders so the sticker fits its frame tightly
 * - Traces color scanline/contour runs into vector <path> geometry AND wraps a high-precision
 *   SVG vector-upscale filter so scaling up/down on the canvas never shows jagged pixelation.
 */
async function vectorizePngDataUrlToSvg(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const srcW = Math.max(1, img.naturalWidth || img.width || 200);
        const srcH = Math.max(1, img.naturalHeight || img.height || 200);
        const maxSample = 160;
        const scale = Math.min(1, maxSample / Math.max(srcW, srcH));
        const w = Math.max(16, Math.round(srcW * scale));
        const h = Math.max(16, Math.round(srcH * scale));

        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h).data;

        // Find tight bounding box of non-transparent pixels
        let minX = w,
          minY = h,
          maxX = 0,
          maxY = 0,
          hasPixels = false;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = imgData[(y * w + x) * 4 + 3];
            if (a > 18) {
              hasPixels = true;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (!hasPixels) {
          minX = 0;
          minY = 0;
          maxX = w - 1;
          maxY = h - 1;
        } else {
          minX = Math.max(0, minX - 1);
          minY = Math.max(0, minY - 1);
          maxX = Math.min(w - 1, maxX + 1);
          maxY = Math.min(h - 1, maxY + 1);
        }

        // Crop original full-res image to tight bounding box
        const cropX = Math.round((minX / w) * srcW);
        const cropY = Math.round((minY / h) * srcH);
        const cropW = Math.max(1, Math.round(((maxX - minX + 1) / w) * srcW));
        const cropH = Math.max(1, Math.round(((maxY - minY + 1) / h) * srcH));

        const hiCv = document.createElement('canvas');
        const hiMax = 512;
        const hiScale = Math.min(1, hiMax / Math.max(cropW, cropH));
        const outW = Math.max(32, Math.round(cropW * hiScale));
        const outH = Math.max(32, Math.round(cropH * hiScale));
        hiCv.width = outW;
        hiCv.height = outH;
        const hiCtx = hiCv.getContext('2d');
        hiCtx.imageSmoothingEnabled = true;
        hiCtx.imageSmoothingQuality = 'high';
        hiCtx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
        const croppedPngUrl = hiCv.toDataURL('image/png');

        // Build quantized vector scanline paths for crisp vector silhouette under extreme zoom
        const pathsByColor = new Map();
        const cw = maxX - minX + 1;
        const ch = maxY - minY + 1;
        for (let y = minY; y <= maxY; y++) {
          let runColor = null;
          let runStart = minX;
          for (let x = minX; x <= maxX + 1; x++) {
            let hex = null;
            if (x <= maxX) {
              const idx = (y * w + x) * 4;
              const a = imgData[idx + 3];
              if (a > 40) {
                const r = Math.min(255, Math.round(imgData[idx] / 24) * 24);
                const g = Math.min(255, Math.round(imgData[idx + 1] / 24) * 24);
                const b = Math.min(255, Math.round(imgData[idx + 2] / 24) * 24);
                hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            }
            if (hex !== runColor) {
              if (runColor !== null) {
                const rx = runStart - minX;
                const ry = y - minY;
                const rw = x - runStart;
                const prev = pathsByColor.get(runColor) || '';
                pathsByColor.set(runColor, `${prev}M${rx},${ry}h${rw}v1.15h-${rw}Z`);
              }
              runColor = hex;
              runStart = x;
            }
          }
        }

        let vectorPathsMarkup = '';
        if (pathsByColor.size <= 140) {
          pathsByColor.forEach((d, color) => {
            vectorPathsMarkup += `<path d="${d}" fill="${color}" shape-rendering="geometricPrecision"/>`;
          });
        }

        const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cw} ${ch}" width="${outW}" height="${outH}" preserveAspectRatio="none" shape-rendering="geometricPrecision"><defs><filter id="vecSmooth" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0.35" result="blur"/><feComponentTransfer in="blur" result="sharpAlpha"><feFuncA type="linear" slope="2.2" intercept="-0.35"/></feComponentTransfer><feComposite in="SourceGraphic" in2="sharpAlpha" operator="in"/></filter></defs><g filter="url(#vecSmooth)">${vectorPathsMarkup}<image href="${croppedPngUrl}" x="0" y="0" width="${cw}" height="${ch}" preserveAspectRatio="none" style="image-rendering:smooth;"/></g></svg>`;
        const aspect = Number((outW / Math.max(1, outH)).toFixed(4));
        resolve({
          svgDataUrl: svgMarkupToDataUrl(svgMarkup),
          aspect,
          width: outW,
          height: outH
        });
      } catch (err) {
        console.warn('vectorizePngDataUrlToSvg fallback:', err);
        resolve({
          svgDataUrl: dataUrl,
          aspect: 1,
          width: 200,
          height: 200
        });
      }
    };
    img.onerror = () => resolve({ svgDataUrl: dataUrl, aspect: 1, width: 200, height: 200 });
    img.src = dataUrl;
  });
}

function addStickerObjectToCanvas(sticker) {
  if (!sticker) return;
  const aspect = Number(sticker.aspect) || 1;
  const w = 170;
  const h = Math.max(64, Math.round(w / Math.max(0.2, aspect)));
  addObjectToBoard(
    {
      type: 'sticker',
      title: sticker.name || '스티커',
      width: w,
      height: h,
      keepAspect: true,
      imageAspect: aspect,
      color: 'dark',
      stickerPresetId: sticker.id || null,
      stickerSvgUrl: sticker.svgDataUrl,
      resolvedFileUrl: sticker.svgDataUrl
    },
    true
  );
  document.getElementById('stickerModal')?.classList.add('hidden');
  showToast(`✨ '${sticker.name || '스티커'}' 벡터 스티커가 캔버스에 추가되었습니다`);
}

function renderStickerModalGrids() {
  const builtinGrid = document.getElementById('builtinStickerGrid');
  const customSection = document.getElementById('customStickerSection');
  const customGrid = document.getElementById('customStickerGrid');

  if (builtinGrid && !builtinGrid.dataset.rendered) {
    builtinGrid.dataset.rendered = '1';
    builtinGrid.innerHTML = '';
    BUILTIN_STICKERS.forEach((st) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-card-btn';
      btn.title = `${st.name} 스티커 추가 (자동 벡터 스케일링)`;
      btn.innerHTML = `
        <img src="${st.svgDataUrl}" alt="${escapeHtml(st.name)}" draggable="false" />
        <span class="sticker-card-name">${escapeHtml(st.name)}</span>
      `;
      btn.addEventListener('click', () => addStickerObjectToCanvas(st));
      builtinGrid.appendChild(btn);
    });
  }

  if (customSection && customGrid) {
    if (!Array.isArray(customStickers) || customStickers.length === 0) {
      customSection.classList.add('hidden');
      customGrid.innerHTML = '';
    } else {
      customSection.classList.remove('hidden');
      customGrid.innerHTML = '';
      customStickers.forEach((st) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sticker-card-btn';
        btn.title = `${st.name} (클릭하여 추가)`;
        btn.innerHTML = `
          <span class="sticker-card-del" data-del-sticker="${escapeHtml(st.id)}" title="등록된 스티커 삭제">✕</span>
          <img src="${st.svgDataUrl}" alt="${escapeHtml(st.name)}" draggable="false" />
          <span class="sticker-card-name">${escapeHtml(st.name)}</span>
        `;
        btn.addEventListener('click', (e) => {
          if (e.target.closest('[data-del-sticker]')) {
            e.stopPropagation();
            customStickers = customStickers.filter((item) => item.id !== st.id);
            persistCustomStickers();
            renderStickerModalGrids();
            showToast(`🗑️ '${st.name}' 스티커가 보관함에서 삭제되었습니다`);
            return;
          }
          addStickerObjectToCanvas(st);
        });
        customGrid.appendChild(btn);
      });
    }
  }
}

document.getElementById('addStickerBtn')?.addEventListener('click', () => {
  renderStickerModalGrids();
  document.getElementById('stickerModal')?.classList.remove('hidden');
});

document.getElementById('closeStickerModalBtn')?.addEventListener('click', () => {
  document.getElementById('stickerModal')?.classList.add('hidden');
});

document.getElementById('stickerModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'stickerModal') {
    document.getElementById('stickerModal')?.classList.add('hidden');
  }
});

document.getElementById('registerCustomStickerBtn')?.addEventListener('click', () => {
  document.getElementById('customStickerFileInput')?.click();
});

document.getElementById('customStickerFileInput')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  showToast('✨ PNG 이미지를 투명 벡터 스티커로 변환 중...');
  let lastAdded = null;
  for (const file of files) {
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!dataUrl) continue;
    const vec = await vectorizePngDataUrlToSvg(dataUrl);
    const cleanName = String(file.name || '커스텀 스티커').replace(/\.[^.]+$/, '');
    const customItem = {
      id: `custom_stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      svgDataUrl: vec.svgDataUrl,
      aspect: vec.aspect || 1
    };
    customStickers.unshift(customItem);
    lastAdded = customItem;
  }
  await persistCustomStickers();
  renderStickerModalGrids();
  if (lastAdded) {
    addStickerObjectToCanvas(lastAdded);
  }
});

// ============================================================================
// Unified Canvas Search System (Text, Vectorized Titles, Object Titles, Group Names, PDF Content)
// ============================================================================
const canvasSearchState = {
  open: false,
  query: '',
  matches: [],
  activeIndex: -1,
  loadingPdfPaths: new Set()
};

function isCanvasSearchOpen() {
  return Boolean(canvasSearchState.open);
}

function openCanvasSearchBar() {
  const bar = document.getElementById('canvasSearchBar');
  const inp = document.getElementById('canvasSearchInput');
  if (!bar || !inp) return;
  canvasSearchState.open = true;
  bar.classList.remove('hidden');
  document.getElementById('openSearchBarBtn')?.classList.add('active');
  inp.focus();
  inp.select();
  performCanvasUnifiedSearch(inp.value || '', { preserveIndex: true });
}

function closeCanvasSearchBar() {
  const bar = document.getElementById('canvasSearchBar');
  if (bar) bar.classList.add('hidden');
  canvasSearchState.open = false;
  canvasSearchState.query = '';
  canvasSearchState.matches = [];
  canvasSearchState.activeIndex = -1;
  document.getElementById('openSearchBarBtn')?.classList.remove('active');
  clearCanvasSearchHighlights();
}

function clearCanvasSearchHighlights() {
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('ff-search-all');
      CSS.highlights.delete('ff-search-active');
    }
  } catch (_) {}
  document.querySelectorAll('.ff-search-match, .ff-search-match-active').forEach((el) => {
    el.classList.remove('ff-search-match', 'ff-search-match-active');
  });
  document.querySelectorAll('.ff-input-search-hit').forEach((el) => {
    el.classList.remove('ff-input-search-hit');
  });
  document.querySelectorAll('.ff-search-match-badge, .ff-pdf-search-hl-box').forEach((el) => {
    el.remove();
  });
}

function findSubstringOccurrences(haystack, needleLower) {
  const results = [];
  if (!haystack || !needleLower) return results;
  const lower = String(haystack).toLowerCase();
  const step = Math.max(1, needleLower.length);
  let pos = 0;
  while (pos <= lower.length - needleLower.length) {
    const idx = lower.indexOf(needleLower, pos);
    if (idx === -1) break;
    results.push({ start: idx, end: idx + needleLower.length });
    pos = idx + step;
  }
  return results;
}

function performCanvasUnifiedSearch(rawQuery, opts = {}) {
  const q = String(rawQuery || '').trim();
  const qLower = q.toLowerCase();
  canvasSearchState.query = q;
  const prevMatch = canvasSearchState.matches[canvasSearchState.activeIndex] || null;
  const matches = [];

  if (qLower && currentBoard && Array.isArray(currentBoard.objects)) {
    // 1. Search Group Names (once per unique groupId on board)
    const seenGroups = new Set();
    currentBoard.objects.forEach((obj) => {
      if (!obj.groupId || seenGroups.has(obj.groupId)) return;
      seenGroups.add(obj.groupId);
      const gName = getGroupName(obj.groupId);
      const hits = findSubstringOccurrences(gName, qLower);
      hits.forEach((h, occIdx) => {
        matches.push({
          kind: 'group',
          groupId: obj.groupId,
          objId: obj.id,
          occIdx,
          label: `그룹: ${gName}`
        });
      });
    });

    // 2. Search Objects (Object Title, Vectorized Label/Object, Body Text/Checklist/Table/Link/File, and PDF Document Content)
    currentBoard.objects.forEach((obj) => {
      // 2-A. Object Name / Title
      if (obj.title) {
        const titleHits = findSubstringOccurrences(obj.title, qLower);
        titleHits.forEach((h, occIdx) => {
          matches.push({
            kind: 'title',
            objId: obj.id,
            occIdx,
            label: `이름: ${obj.title}`
          });
        });
      }

      // 2-B. Vectorized Title/Label or Universal Vectorized Object Content
      if (obj.type === 'label' || obj.vectorized) {
        const vecText =
          obj.type === 'label'
            ? obj.content || ''
            : obj.type === 'table' && Array.isArray(obj.tableData)
            ? obj.tableData.map((r) => r.join(' ')).join('\n')
            : obj.content || '';
        const vecHits = findSubstringOccurrences(vecText, qLower);
        vecHits.forEach((h, occIdx) => {
          matches.push({
            kind: obj.vectorized ? 'vector' : 'text',
            objId: obj.id,
            occIdx,
            start: h.start,
            end: h.end,
            label: obj.type === 'label' ? `타이틀: ${vecText.slice(h.start, h.end)}` : `벡터 텍스트`
          });
        });
      } else if (obj.type === 'sticky' || obj.type === 'text') {
        // 2-C. Sticky Note or Checklist + Note
        const rawBody =
          obj.type === 'text'
            ? parseNoteLines(obj.content || '')
                .map((it) => it.text || '')
                .join('\n')
            : obj.content || '';
        const bodyHits = findSubstringOccurrences(rawBody, qLower);
        bodyHits.forEach((h, occIdx) => {
          matches.push({
            kind: 'text',
            objId: obj.id,
            occIdx,
            start: h.start,
            end: h.end,
            label: `본문 텍스트`
          });
        });
      } else if (obj.type === 'table' && Array.isArray(obj.tableData)) {
        // 2-D. Table Cells
        let tableOccIdx = 0;
        obj.tableData.forEach((row, rIdx) => {
          if (!Array.isArray(row)) return;
          row.forEach((cell, cIdx) => {
            const cleanCell = String(cell ?? '').replace(/^\[(square|circle|toggle):(0|1)\]\s?/, '');
            const cellHits = findSubstringOccurrences(cleanCell, qLower);
            cellHits.forEach((h) => {
              matches.push({
                kind: 'table-cell',
                objId: obj.id,
                rIdx,
                cIdx,
                occIdx: tableOccIdx++,
                start: h.start,
                end: h.end,
                label: `표 셀 (${rIdx + 1}행 ${cIdx + 1}열)`
              });
            });
          });
        });
      } else if (obj.type === 'link') {
        const linkText = [obj.pageTitle, obj.description, obj.url, obj.domain].filter(Boolean).join(' ');
        const linkHits = findSubstringOccurrences(linkText, qLower);
        linkHits.forEach((h, occIdx) => {
          matches.push({
            kind: 'link',
            objId: obj.id,
            occIdx,
            label: `링크 정보`
          });
        });
      }

      // 2-E. File Name & PDF Full-Text Search
      if (obj.fileName && obj.fileName !== obj.title) {
        const fnHits = findSubstringOccurrences(obj.fileName, qLower);
        fnHits.forEach((h, occIdx) => {
          matches.push({
            kind: 'file',
            objId: obj.id,
            occIdx,
            label: `파일명: ${obj.fileName}`
          });
        });
      }

      if (isPdfObject(obj) && obj.resolvedFilePath) {
        const cached = pdfDocCache.get(obj.resolvedFilePath);
        if (!cached && !canvasSearchState.loadingPdfPaths.has(obj.resolvedFilePath)) {
          canvasSearchState.loadingPdfPaths.add(obj.resolvedFilePath);
          getOrLoadPdfDocument(obj.resolvedFilePath)
            .then(() => {
              canvasSearchState.loadingPdfPaths.delete(obj.resolvedFilePath);
              if (canvasSearchState.open && canvasSearchState.query) {
                performCanvasUnifiedSearch(canvasSearchState.query, { preserveIndex: true });
              }
            })
            .catch(() => {
              canvasSearchState.loadingPdfPaths.delete(obj.resolvedFilePath);
            });
        } else if (cached && Array.isArray(cached.pageTextItems)) {
          cached.pageTextItems.forEach((items, pIdx) => {
            const pageNum = pIdx + 1;
            if (!Array.isArray(items)) return;
            items.forEach((item, itemIdx) => {
              const itemHits = findSubstringOccurrences(item.str, qLower);
              itemHits.forEach((h, subIdx) => {
                const len = Math.max(1, item.str.length);
                const xSubRatio = item.xRatio + (h.start / len) * item.wRatio;
                const wSubRatio = Math.max(0.015, ((h.end - h.start) / len) * item.wRatio);
                matches.push({
                  kind: 'pdf',
                  objId: obj.id,
                  pageNum,
                  itemIdx,
                  subIdx,
                  xRatio: xSubRatio,
                  yRatio: item.yRatio,
                  wRatio: wSubRatio,
                  hRatio: item.hRatio,
                  snippet: item.str,
                  label: `PDF ${pageNum}p`
                });
              });
            });
          });
        }
      }
    });
  }

  canvasSearchState.matches = matches;
  if (matches.length === 0) {
    canvasSearchState.activeIndex = -1;
  } else if (opts.preserveIndex && prevMatch) {
    const foundIdx = matches.findIndex(
      (m) =>
        m.kind === prevMatch.kind &&
        m.objId === prevMatch.objId &&
        m.groupId === prevMatch.groupId &&
        m.pageNum === prevMatch.pageNum &&
        m.occIdx === prevMatch.occIdx
    );
    canvasSearchState.activeIndex = foundIdx >= 0 ? foundIdx : 0;
  } else {
    canvasSearchState.activeIndex = 0;
  }

  updateCanvasSearchCounterUI();
  applyCanvasSearchHighlights();
  if (opts.panToActive && canvasSearchState.activeIndex >= 0) {
    panToCanvasSearchMatch(canvasSearchState.matches[canvasSearchState.activeIndex]);
  }
}

function updateCanvasSearchCounterUI() {
  const badge = document.getElementById('canvasSearchCountBadge');
  if (!badge) return;
  const total = canvasSearchState.matches.length;
  const cur = total > 0 && canvasSearchState.activeIndex >= 0 ? canvasSearchState.activeIndex + 1 : 0;
  badge.textContent = `${cur} / ${total}건`;
  badge.classList.toggle('has-matches', total > 0);
}

function renderPdfPageSearchHighlights(pageCard, obj, pageNum) {
  if (!pageCard || !obj) return;
  pageCard.querySelectorAll('.ff-pdf-search-hl-box').forEach((el) => el.remove());
  if (!canvasSearchState.open || !canvasSearchState.query) return;
  const activeMatch = canvasSearchState.matches[canvasSearchState.activeIndex] || null;
  const pageMatches = canvasSearchState.matches.filter(
    (m) => m.kind === 'pdf' && m.objId === obj.id && m.pageNum === pageNum
  );
  pageMatches.forEach((m) => {
    const box = document.createElement('div');
    const isAct = activeMatch === m;
    box.className = `ff-pdf-search-hl-box ${isAct ? 'is-active' : ''}`;
    box.style.left = `${(m.xRatio * 100).toFixed(2)}%`;
    box.style.top = `${(m.yRatio * 100).toFixed(2)}%`;
    box.style.width = `${(m.wRatio * 100).toFixed(2)}%`;
    box.style.height = `${(m.hRatio * 100).toFixed(2)}%`;
    pageCard.appendChild(box);
  });
}

function applyCanvasSearchHighlights() {
  clearCanvasSearchHighlights();
  if (!canvasSearchState.open || !canvasSearchState.query || !canvasSearchState.matches.length) {
    return;
  }

  const qLower = canvasSearchState.query.toLowerCase();
  const activeMatch = canvasSearchState.matches[canvasSearchState.activeIndex] || null;

  // 1. Highlight editable text nodes via native CSS Custom Highlight API (zero DOM mutation)
  const allRanges = [];
  const activeRanges = [];
  if (objectLayer && typeof Range !== 'undefined') {
    currentBoard?.objects.forEach((obj) => {
      const domEl = objectLayer.querySelector(`.ff-object[data-id="${obj.id}"]`);
      if (!domEl) return;
      const bodyEl = domEl.querySelector('.ff-obj-body');
      if (!bodyEl) return;
      const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT, null);
      let objTextOccCounter = 0;
      let node = walker.nextNode();
      while (node) {
        const val = node.nodeValue || '';
        if (val.trim()) {
          const hits = findSubstringOccurrences(val, qLower);
          hits.forEach((h) => {
            try {
              const rng = new Range();
              rng.setStart(node, h.start);
              rng.setEnd(node, h.end);
              allRanges.push(rng);
              if (
                activeMatch &&
                activeMatch.objId === obj.id &&
                (activeMatch.kind === 'text' || activeMatch.kind === 'table-cell' || activeMatch.kind === 'vector') &&
                activeMatch.occIdx === objTextOccCounter
              ) {
                activeRanges.push(rng);
              }
              objTextOccCounter++;
            } catch (_) {}
          });
        }
        node = walker.nextNode();
      }
    });
  }

  try {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      if (allRanges.length > 0) {
        CSS.highlights.set('ff-search-all', new Highlight(...allRanges));
      }
      if (activeRanges.length > 0) {
        CSS.highlights.set('ff-search-active', new Highlight(...activeRanges));
      }
    }
  } catch (_) {}

  // 2. Highlight matched Objects, Titles, Group Frames, Vectorized SVGs, and PDF Pages
  const matchedObjCounts = new Map();
  canvasSearchState.matches.forEach((m) => {
    if (m.objId) {
      matchedObjCounts.set(m.objId, (matchedObjCounts.get(m.objId) || 0) + 1);
    }
    if (m.kind === 'group' && m.groupId) {
      const frame = objectLayer?.querySelector(`.ff-group-frame[data-group-id="${m.groupId}"]`);
      if (frame) {
        frame.classList.add('ff-search-match');
        if (activeMatch === m) frame.classList.add('ff-search-match-active');
        const gInp = frame.querySelector('.ff-group-name-input');
        if (gInp) gInp.classList.add('ff-input-search-hit');
      }
    }
  });

  matchedObjCounts.forEach((cnt, objId) => {
    const domEl = objectLayer?.querySelector(`.ff-object[data-id="${objId}"]`);
    const obj = currentBoard?.objects.find((o) => o.id === objId);
    if (!domEl || !obj) return;
    domEl.classList.add('ff-search-match');
    if (activeMatch && activeMatch.objId === objId) {
      domEl.classList.add('ff-search-match-active');
    }

    // Highlight title input if title matched
    if (canvasSearchState.matches.some((m) => m.objId === objId && m.kind === 'title')) {
      domEl.querySelector('.ff-obj-title')?.classList.add('ff-input-search-hit');
    }

    // Add floating match badge on object
    const badge = document.createElement('div');
    badge.className = 'ff-search-match-badge';
    badge.textContent = `🔍 검색 일치 ${cnt}건`;
    domEl.appendChild(badge);

    // If PDF viewer, render highlight boxes on each rendered page card
    if (isPdfObject(obj)) {
      domEl.querySelectorAll('.ff-pdf-page-card').forEach((card) => {
        const pNum = Number(card.dataset.pageNumber) || 1;
        renderPdfPageSearchHighlights(card, obj, pNum);
      });
    }
  });
}

function panToCanvasSearchMatch(match) {
  if (!match || !currentBoard) return;
  const obj = currentBoard.objects.find((o) => o.id === match.objId);
  if (!obj) return;

  const rect = canvasViewport.getBoundingClientRect();
  const targetZoom = Math.max(0.65, Math.min(1.25, zoom));
  const cx = obj.x + (obj.width || 300) / 2;
  const cy = obj.y + (obj.height || 200) / 2;
  const targetPanX = Math.round(rect.width / 2 - cx * targetZoom);
  const targetPanY = Math.round(rect.height / 2 - cy * targetZoom);
  animateViewportTo(targetPanX, targetPanY, targetZoom, 280);

  // If the match is inside a PDF page, scroll that PDF viewer container directly to that page!
  if (match.kind === 'pdf' && match.pageNum) {
    const domEl = objectLayer?.querySelector(`.ff-object[data-id="${obj.id}"]`);
    const pagesContainer = domEl?.querySelector('.ff-pdf-pages-container');
    const card = pagesContainer?.querySelector(`.ff-pdf-page-card[data-page-number="${match.pageNum}"]`);
    if (pagesContainer && card) {
      pagesContainer.scrollTo({ top: Math.max(0, card.offsetTop), behavior: 'smooth' });
    }
  }
}

function stepCanvasSearchMatch(delta) {
  const total = canvasSearchState.matches.length;
  if (!total) return;
  canvasSearchState.activeIndex = (canvasSearchState.activeIndex + delta + total) % total;
  updateCanvasSearchCounterUI();
  applyCanvasSearchHighlights();
  panToCanvasSearchMatch(canvasSearchState.matches[canvasSearchState.activeIndex]);
}

document.getElementById('openSearchBarBtn')?.addEventListener('click', () => {
  if (isCanvasSearchOpen()) {
    closeCanvasSearchBar();
  } else {
    openCanvasSearchBar();
  }
});

document.getElementById('canvasSearchInput')?.addEventListener('input', (e) => {
  performCanvasUnifiedSearch(e.target.value, { panToActive: true });
});

document.getElementById('canvasSearchInput')?.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    stepCanvasSearchMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCanvasSearchBar();
  }
});

document.getElementById('canvasSearchPrevBtn')?.addEventListener('click', () => stepCanvasSearchMatch(-1));
document.getElementById('canvasSearchNextBtn')?.addEventListener('click', () => stepCanvasSearchMatch(1));
document.getElementById('canvasSearchCloseBtn')?.addEventListener('click', () => closeCanvasSearchBar());

// Initialize on startup
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const savedCustomStickers = localStorage.getItem('boss_custom_stickers_v1');
    if (savedCustomStickers) {
      const parsed = JSON.parse(savedCustomStickers);
      if (Array.isArray(parsed)) customStickers = parsed;
    }
  } catch (_) {}
  try {
    const cfg = await window.freeformAPI.getConfig();
    if (cfg && Array.isArray(cfg.customObjectSwatches) && cfg.customObjectSwatches.length > 0) {
      customObjectSwatches = DEFAULT_OBJECT_SWATCHES.map((def, i) => cfg.customObjectSwatches[i] || def);
    }
    if (cfg && Array.isArray(cfg.customPenSwatches) && cfg.customPenSwatches.length > 0) {
      customPenSwatches = DEFAULT_PEN_SWATCHES.map((def, i) => cfg.customPenSwatches[i] || def);
    }
    if (cfg && cfg.gridConfig && typeof cfg.gridConfig === 'object') {
      gridConfig = {
        ...gridConfig,
        ...cfg.gridConfig
      };
    }
    if (cfg && cfg.shapeToolConfig && typeof cfg.shapeToolConfig === 'object') {
      shapeToolConfig = {
        ...shapeToolConfig,
        ...cfg.shapeToolConfig
      };
    }
    if (cfg && Array.isArray(cfg.customStickers) && cfg.customStickers.length > 0) {
      customStickers = cfg.customStickers;
    }
  } catch (err) {
    console.warn('getConfig error:', err);
  }
  applyCustomSwatchesToDOM();
  syncGridSettingsUI();
  await refreshSyncUI();
  await refreshBoardsSidebarList();
  const initialId = boardsList[0]?.id || 'board_welcome';
  await loadBoardById(initialId);
});

