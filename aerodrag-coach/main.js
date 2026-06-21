/**
 * AeroDrag Coach — Electron main process
 * App desktop senza cornice browser, doppio click per aprire, ESC per uscire.
 * Supporta selezione cartella di destinazione sessioni tramite dialog nativo.
 *
 * Contract: v0.3.0 — fonte di verità in aerodrag-firmware/docs/CONTRACT.md
 *   Il coach NON renderizza la dashboard: carica quella servita dal Pi
 *   (PI_URL → /dashboard, §4). La conformità di pctAero (0–100) è del Pi.
 *   Le sessioni (§5) sono ricevute/servite verbatim dal pc-receiver, che
 *   valida il filename a suffisso deviceId obbligatorio (§5 v0.1.2).
 */

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');

const PI_URL      = 'http://192.168.7.1:8080/dashboard';
// Origine/host del Pi: usati per confinare il contenuto remoto (issue #8)
const PI_ORIGIN   = new URL(PI_URL).origin;   // http://192.168.7.1:8080
const PI_HOST     = new URL(PI_URL).host;      // 192.168.7.1:8080
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

  // Assicurati che la cartella sessioni esista; se fallisce, log + fallback alla
  // cartella predefinita (issue #8, BASSO).
  try {
    fs.mkdirSync(config.sessionsDir, { recursive: true });
  } catch (e) {
    console.error(`[app] Impossibile creare ${config.sessionsDir}: ${e.message} — uso ${DEFAULT_SESSIONS_DIR}`);
    config.sessionsDir = DEFAULT_SESSIONS_DIR;
    try { fs.mkdirSync(config.sessionsDir, { recursive: true }); } catch {}
  }

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
  // Avvia il nuovo receiver SOLO dopo che il vecchio è davvero uscito (issue #8):
  // un timeout fisso poteva lasciare la porta 8081 occupata → EADDRINUSE →
  // exit(0) → zero receiver. Niente più race.
  if (!receiverProc) { startReceiver(); return; }
  isRestarting = true;
  const old = receiverProc;
  receiverProc = null;
  old.once('exit', () => { isRestarting = false; startReceiver(); });
  old.kill();
}

// ─── Probe Pi ─────────────────────────────────────────────────────────────────
function probePi(callback) {
  const req = http.request({
    hostname: '192.168.7.1', port: 8080, path: '/status',
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
  attachEscHandler(loadingWin);
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
      // Sicurezza (issue #8): contenuto REMOTO → preload MINIMALE senza API
      // privilegiate. Le API settings/quit restano alle sole finestre locali.
      preload: path.join(__dirname, 'preload-remote.js'),
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  // Confina il contenuto remoto: niente navigazione fuori dall'origine del Pi,
  // niente apertura di nuove finestre (issue #8).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(PI_ORIGIN + '/') && url !== PI_ORIGIN) {
      e.preventDefault();
      console.warn('[security] navigazione bloccata fuori da PI_URL:', url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  attachEscHandler(mainWindow);

  mainWindow.loadURL(PI_URL);

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
  attachEscHandler(settingsWin);
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

// ─── ESC: conferma uscita (issue #8) ──────────────────────────────────────────
// Conferma in dialog NATIVO locale (non più iniettata nel DOM remoto del Pi, che
// poteva forzarla/impedirla). ESC agganciato a `before-input-event` per-finestra
// (solo a finestra a fuoco), non più via globalShortcut globale di sistema.
let quitDialogOpen = false;
function confirmQuit() {
  if (quitDialogOpen) return;
  const win = mainWindow || settingsWin || loadingWin || null;
  quitDialogOpen = true;
  dialog.showMessageBox(win, {
    type:      'warning',
    buttons:   ['Annulla', 'Esci'],
    defaultId: 0,
    cancelId:  0,
    noLink:    true,
    title:     'AeroDrag Coach',
    message:   'Uscire da AeroDrag Coach?',
    detail:    'I dati della sessione corrente sono al sicuro sul Pi e sul PC.',
  }).then(({ response }) => {
    quitDialogOpen = false;
    if (response === 1) { app.isQuitting = true; app.quit(); }
  }).catch(() => { quitDialogOpen = false; });
}

// Intercetta ESC PRIMA che arrivi alla pagina (anche remota); vale solo quando
// la finestra è a fuoco. Sostituisce globalShortcut('Escape').
function attachEscHandler(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      e.preventDefault();
      confirmQuit();
    }
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.on('quit-confirmed', () => { app.isQuitting = true; app.quit(); });

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

// Validazione path (issue #8): la cartella sessioni DEVE stare dentro la home
// utente. Impedisce scrittura file arbitraria (path traversal, dir di sistema)
// anche nel caso un canale IPC venisse invocato in modo inatteso.
function resolveAllowedSessionsDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved.startsWith(home + path.sep)) return resolved;
  return null;
}

// Salva la cartella scelta e riavvia il receiver
ipcMain.handle('set-sessions-dir', async (_, newDir) => {
  const dir = resolveAllowedSessionsDir(newDir);
  if (!dir) return { ok: false, error: 'Cartella non consentita: deve essere dentro la cartella utente.' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    config.sessionsDir = dir;
    saveConfig(config);
    restartReceiver();
    // Notifica la finestra principale del cambiamento
    if (mainWindow) mainWindow.webContents.send('sessions-dir-changed', dir);
    return { ok: true, dir };
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

// ─── App lifecycle ────────────────────────────────────────────────────────────
// ─── CSP per il contenuto remoto del Pi (issue #8) ────────────────────────────
// Limita il contenuto servito dal Pi a same-origin + origine Pi: consente la
// dashboard (inline + WS verso il Pi) ma blocca connessioni/risorse verso host
// esterni (anti-esfiltrazione). Le finestre locali (file://) non sono toccate.
function installRemoteCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (!details.url.startsWith(PI_ORIGIN)) return cb({ responseHeaders: details.responseHeaders });
    const csp =
      `default-src 'self' ${PI_ORIGIN} ws://${PI_HOST}; ` +
      `script-src 'self' ${PI_ORIGIN} 'unsafe-inline' 'unsafe-eval'; ` +
      `style-src 'self' ${PI_ORIGIN} 'unsafe-inline'; ` +
      `img-src 'self' ${PI_ORIGIN} data: blob:; ` +
      `font-src 'self' ${PI_ORIGIN} data:; ` +
      `connect-src 'self' ${PI_ORIGIN} ws://${PI_HOST}`;
    const headers = { ...details.responseHeaders };
    // Rimuovi eventuali CSP in arrivo (case-insensitive) e imponi la nostra
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') delete headers[k];
    }
    headers['Content-Security-Policy'] = [csp];
    cb({ responseHeaders: headers });
  });
}

app.whenReady().then(() => {
  installRemoteCSP();
  startReceiver();
  createLoadingWindow();
  scheduleProbe();

  app.on('activate', () => {
    if (!mainWindow && !loadingWin) createLoadingWindow();
  });
});

app.on('will-quit', () => {
  if (receiverProc) receiverProc.kill();
  clearTimeout(probeTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
