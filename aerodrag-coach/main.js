/**
 * AeroDrag Coach — Electron main process
 * App desktop senza cornice browser, doppio click per aprire, ESC per uscire.
 * Supporta selezione cartella di destinazione sessioni tramite dialog nativo.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');

const PI_HOST     = '192.168.7.1:8080';
const PI_WS_URL   = `ws://${PI_HOST}/coach`;
const RECEIVER_JS = app.isPackaged
  ? path.join(process.resourcesPath, 'pc-receiver', 'pc-receiver.js')
  : path.join(__dirname, '..', 'pc-receiver', 'pc-receiver.js');
const CONFIG_FILE = path.join(app.getPath('userData'), 'aerodrag-config.json');

// ─── Configurazione persistente ───────────────────────────────────────────────
// Salvata in: %APPDATA%/AeroDrag Coach/aerodrag-config.json (Windows)
//             ~/Library/Application Support/AeroDrag Coach/  (Mac)
//             ~/.config/AeroDrag Coach/                       (Linux)
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), 'Documents', 'AeroDrag', 'sessions');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { sessionsDir: DEFAULT_SESSIONS_DIR };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[config] Errore salvataggio:', e.message);
  }
}

let config = loadConfig();

// ─── Stato finestre ───────────────────────────────────────────────────────────
let mainWindow   = null;
let loadingWin   = null;
let settingsWin  = null;
let quitWin      = null;
let receiverProc = null;
let piAvailable  = false;
let probeTimer   = null;
let isRestarting = false;   // guard: prevents exit handler from re-spawning during restart

// ─── Avvia pc-receiver con la cartella configurata ────────────────────────────
function startReceiver() {
  if (!fs.existsSync(RECEIVER_JS)) {
    console.warn('[app] pc-receiver.js non trovato:', RECEIVER_JS);
    return;
  }

  // Assicurati che la cartella sessioni esista
  try { fs.mkdirSync(config.sessionsDir, { recursive: true }); } catch {}

  const nodeExec = process.platform === 'win32' ? 'node.exe' : 'node';

  receiverProc = spawn(nodeExec, [RECEIVER_JS], {
    detached: false,
    stdio:    'pipe',
    env: {
      ...process.env,
      // Passa la cartella al receiver come variabile d'ambiente
      AERODRAG_SESSIONS_DIR: config.sessionsDir,
    },
  });

  receiverProc.stdout.on('data', d => console.log('[receiver]', d.toString().trim()));
  receiverProc.stderr.on('data', d => console.error('[receiver]', d.toString().trim()));
  receiverProc.on('exit', (code) => {
    if (code !== 0 && !app.isQuitting && !isRestarting) {
      console.log('[receiver] Riavvio tra 3s...');
      setTimeout(startReceiver, 3000);
    }
  });

  console.log(`[app] Receiver avviato — sessioni in: ${config.sessionsDir}`);
}

function restartReceiver() {
  isRestarting = true;
  if (receiverProc) {
    receiverProc.kill();
    receiverProc = null;
  }
  setTimeout(() => {
    isRestarting = false;
    startReceiver();
  }, 500);
}

// ─── Probe Pi ─────────────────────────────────────────────────────────────────
function probePi(callback) {
  const req = http.request({
    hostname: PI_HOST.split(':')[0], port: parseInt(PI_HOST.split(':')[1]), path: '/status',
    method: 'GET', timeout: 2000,
  }, res => { piAvailable = (res.statusCode === 200); callback(piAvailable); });
  req.on('error', () => { piAvailable = false; callback(false); });
  req.on('timeout', () => { req.destroy(); piAvailable = false; callback(false); });
  req.end();
}

// ─── Finestra di caricamento ──────────────────────────────────────────────────
function createLoadingWindow() {
  loadingWin = new BrowserWindow({
    width: 520, height: 340,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  loadingWin.loadFile(path.join(__dirname, 'assets', 'loading.html'));
}

// ─── Finestra principale ──────────────────────────────────────────────────────
function createMainWindow() {
  if (mainWindow) { mainWindow.focus(); return; }

  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width, height,
    frame: false, titleBarStyle: 'hidden', transparent: false,
    backgroundColor: '#07090f', show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'assets', 'dashboard.html'));

  // Inoltra i console.log/error del renderer al terminale — utile per
  // diagnosticare freeze del renderer (il processo main sopravvive).
  mainWindow.webContents.on('console-message', (_e, level, message, line) => {
    const tag = level === 2 ? '[renderer:ERROR]' : '[renderer]';
    console.log(`${tag} ${message}  (dashboard.html:${line})`);
  });

  mainWindow.once('ready-to-show', () => {
    if (loadingWin) { loadingWin.close(); loadingWin = null; }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', () => {
    if (mainWindow) mainWindow.close();
    if (!loadingWin) createLoadingWindow();
    scheduleProbe();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Finestra impostazioni ────────────────────────────────────────────────────
function createSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    width: 540, height: 420,
    frame: false, transparent: false,
    resizable: false, alwaysOnTop: true,
    backgroundColor: '#0f1420',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  settingsWin.loadFile(path.join(__dirname, 'assets', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ─── Probe scheduler ─────────────────────────────────────────────────────────
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probePi(ok => {
      if (ok) {
        if (loadingWin) {
          loadingWin.webContents.send('pi-found');
          setTimeout(() => {
            if (loadingWin) { loadingWin.close(); loadingWin = null; }
            createMainWindow();
          }, 800);
        } else if (!mainWindow) {
          createMainWindow();
        }
      } else {
        if (loadingWin) loadingWin.webContents.send('probe-failed');
        scheduleProbe();
      }
    });
  }, 2500);
}

// ─── ESC: conferma uscita (finestra dedicata) ─────────────────────────────────
function handleEscQuit() {
  if (quitWin) { quitWin.focus(); return; }

  quitWin = new BrowserWindow({
    width: 400, height: 240,
    frame: false, transparent: true,
    resizable: false, alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    parent: mainWindow || undefined,
  });

  quitWin.loadFile(path.join(__dirname, 'assets', 'quit-confirm.html'));
  quitWin.on('closed', () => { quitWin = null; });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.on('quit-confirmed', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('close-quit-window', () => { if (quitWin) { quitWin.close(); quitWin = null; } });

// Apre la finestra impostazioni
ipcMain.on('open-settings', () => createSettingsWindow());

// Restituisce la config corrente alla finestra settings
ipcMain.handle('get-config', () => ({
  sessionsDir: config.sessionsDir,
  defaultDir:  DEFAULT_SESSIONS_DIR,
}));

// Dialog di selezione cartella
ipcMain.handle('pick-folder', async () => {
  const win = settingsWin || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title:       'Scegli cartella per le sessioni di allenamento',
    defaultPath: config.sessionsDir,
    properties:  ['openDirectory', 'createDirectory'],
    buttonLabel: 'Seleziona cartella',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Salva la cartella scelta e riavvia il receiver
ipcMain.handle('set-sessions-dir', async (_, newDir) => {
  if (!newDir || typeof newDir !== 'string') return { ok: false };
  try {
    fs.mkdirSync(newDir, { recursive: true });
    config.sessionsDir = newDir;
    saveConfig(config);
    restartReceiver();
    // Notifica la finestra principale del cambiamento
    if (mainWindow) mainWindow.webContents.send('sessions-dir-changed', newDir);
    return { ok: true, dir: newDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Ripristina la cartella predefinita
ipcMain.handle('reset-sessions-dir', async () => {
  config.sessionsDir = DEFAULT_SESSIONS_DIR;
  saveConfig(config);
  try { fs.mkdirSync(DEFAULT_SESSIONS_DIR, { recursive: true }); } catch {}
  restartReceiver();
  if (mainWindow) mainWindow.webContents.send('sessions-dir-changed', DEFAULT_SESSIONS_DIR);
  return { ok: true, dir: DEFAULT_SESSIONS_DIR };
});

// Apre la cartella sessioni in Esplora File / Finder
ipcMain.on('open-sessions-folder', () => {
  shell.openPath(config.sessionsDir);
});

// Versione app — funziona sia in dev (npm start) sia packaged (binario)
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-pi-ws-url', () => PI_WS_URL);

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startReceiver();
  createLoadingWindow();
  globalShortcut.register('Escape', handleEscQuit);
  scheduleProbe();

  app.on('activate', () => {
    if (!mainWindow && !loadingWin) createLoadingWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (receiverProc) receiverProc.kill();
  clearTimeout(probeTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
