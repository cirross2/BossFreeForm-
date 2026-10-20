const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('freeformAPI', {
  // Window Controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  resetWindowBounds: () => ipcRenderer.invoke('window:reset-bounds'),

  // Boards CRUD
  listBoards: () => ipcRenderer.invoke('board:list'),
  getBoard: (boardId) => ipcRenderer.invoke('board:get', boardId),
  saveBoard: (board) => ipcRenderer.invoke('board:save', board),
  createBoard: (opts) => ipcRenderer.invoke('board:create', opts),
  deleteBoard: (boardId) => ipcRenderer.invoke('board:delete', boardId),

  // Assets & Clipboard & Screen Capture
  getPathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : file?.path || '';
    } catch (_) {
      return file?.path || '';
    }
  },
  saveAssetFromPath: (filePath, name) => ipcRenderer.invoke('asset:save-path', { filePath, name }),
  saveAssetFromBuffer: (data) => ipcRenderer.invoke('asset:save-buffer', data),
  pickFiles: (opts) => ipcRenderer.invoke('dialog:pick-files', opts),
  readClipboardSmart: () => ipcRenderer.invoke('clipboard:read-smart'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  writeClipboardImage: (payload) => ipcRenderer.invoke('clipboard:write-image', payload),
  readPdfBase64: (filePath) => ipcRenderer.invoke('pdf:read-base64', filePath),
  openInBossPdf: (filePath) => ipcRenderer.invoke('pdf:open-bosspdf', filePath),
  captureScreenToAsset: () => ipcRenderer.invoke('screen:capture-asset'),

  // URL Metadata & External Links
  fetchUrlMetadata: (url) => ipcRenderer.invoke('url:fetch-metadata', url),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),

  // Export & Import
  exportTableCsv: (payload) => ipcRenderer.invoke('export:table-csv', payload),
  exportBoardJson: (board) => ipcRenderer.invoke('export:board-json', board),
  importBoardJson: () => ipcRenderer.invoke('import:board-json'),

  // Google Drive Sync (Desktop Folder + Cloud OAuth + Built-in Google Web Login) & Hotkey Config
  getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
  pickSyncFolder: () => ipcRenderer.invoke('sync:pick-folder'),
  useDetectedGoogleDriveFolder: () => ipcRenderer.invoke('sync:use-detected-drive'),
  openSyncFolder: () => ipcRenderer.invoke('sync:open-folder'),
  startGoogleOAuth: (creds) => ipcRenderer.invoke('sync:start-oauth', creds),
  syncCloudNow: () => ipcRenderer.invoke('sync:cloud-now'),
  disconnectOAuth: () => ipcRenderer.invoke('sync:disconnect-oauth'),
  openGoogleWebLogin: () => ipcRenderer.invoke('sync:open-google-web'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  setGlobalHotkey: (hotkey) => ipcRenderer.invoke('config:set-hotkey', hotkey),

  // Events from Main Process (External Drive file sync)
  onBoardExternallyUpdated: (cb) => {
    const handler = (_, boardId) => cb(boardId);
    ipcRenderer.on('board:external-update', handler);
    return () => ipcRenderer.removeListener('board:external-update', handler);
  }
});
