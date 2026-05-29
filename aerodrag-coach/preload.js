const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aerodrag', {
  // Finestra di caricamento
  onPiFound:     (cb) => ipcRenderer.on('pi-found',     () => cb()),
  onProbeFailed: (cb) => ipcRenderer.on('probe-failed', () => cb()),

  // Uscita
  quit: () => ipcRenderer.send('quit-confirmed'),

  // Impostazioni
  openSettings:      ()      => ipcRenderer.send('open-settings'),
  getConfig:         ()      => ipcRenderer.invoke('get-config'),
  pickFolder:        ()      => ipcRenderer.invoke('pick-folder'),
  setSessionsDir:    (dir)   => ipcRenderer.invoke('set-sessions-dir', dir),
  resetSessionsDir:  ()      => ipcRenderer.invoke('reset-sessions-dir'),
  openSessionsFolder:()      => ipcRenderer.send('open-sessions-folder'),
  onSessionsDirChanged: (cb) => ipcRenderer.on('sessions-dir-changed', (_, dir) => cb(dir)),

  // Versione: legge da main.js via IPC (app.getVersion()) — funziona anche
  // nelle build packaged dove process.env.npm_package_version è undefined
  version: () => ipcRenderer.invoke('get-version'),
});
