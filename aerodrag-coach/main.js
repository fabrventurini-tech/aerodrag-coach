/**
 * AeroDrag Coach — Electron main process
 * App desktop senza cornice browser, doppio click per aprire, ESC per uscire.
 * Supporta selezione cartella di destinazione sessioni tramite dialog nativo.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');

const PI_URL      = 'http://192.168.7.1:8080/dashboard';
const RECEIVER_JS = app.isPackaged
  ? path.join(process.resourcesPath, 'pc-receiver', 'pc-receiver.js')
  : path.join(__dirname, '..', 'pc-receiver', 'pc-receiver.js');
const CONFIG_FILE = path.join(app.getPath('userData'), 'aerodrag-config.json');

// Fix 15: disaccoppia timeout del probe (< intervallo, con margine) così un Pi
// lento ha tempo di rispondere prima del ciclo successivo.
const PROBE_INTERVAL_MS = 2500;
const PROBE_TIMEOUT_MS  = 1500;

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
// Fix 4: backoff su crash ripetuti del receiver (evita restart all'infinito).
let crashCount   = 0;
let crashWindowStart = 0;
const RESTART_BASE_MS  = 1500;   // ≥1.5s: lascia liberare la porta 8081
const RESTART_MAX_MS   = 30000;
const CRASH_RESET_MS   = 60000;  // reset del contatore dopo 60s di stabilità

// ─── Avvia pc-receiver con la cartella configurata ────────────────────────────
function startReceiver() {
  if (!fs.existsSync(RECEIVER_JS)) {
    console.warn('[app] pc-receiver.js non trovato:', RECEIVER_JS);
    return;
  }

  // Assicurati che la cartella sessioni esista. Fix 12: logga l'errore e
  // ripiega sulla cartella predefinita invece di ingoiarlo silenziosamente.
  try {
    fs.mkdirSync(config.sessionsDir, { recursive: true });
  } catch (e) {
    console.error(`[app] Impossibile creare ${config.sessionsDir}: ${e.message} — fallback a default`);
    config.sessionsDir = DEFAULT_SESSIONS_DIR;
    try { fs.mkdirSync(DEFAULT_SESSIONS_DIR, { recursive: true }); }
    catch (e2) { console.error(`[app] Anche il fallback è fallito: ${e2.message}`); }
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

  const spawned = receiverProc;
  spawned.stdout.on('data', d => console.log('[receiver]', d.toString().trim()));
  spawned.stderr.on('data', d => console.error('[receiver]', d.toString().trim()));
  spawned.on('exit', (code) => {
    if (receiverProc === spawned) receiverProc = null;
    if (code === 0 || app.isQuitting || isRestarting) return;

    // Fix 4: backoff esponenziale su crash ripetuti per non riavviare all'infinito.
    const now = Date.now();
    if (now - crashWindowStart > CRASH_RESET_MS) { crashWindowStart = now; crashCount = 0; }
    crashCount++;
    if (crashCount > 5) {
      console.error('[receiver] Troppi crash ravvicinati — riavvio sospeso.');
      return;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** (crashCount - 1), RESTART_MAX_MS);
    console.log(`[receiver] Exit code ${code} — riavvio tra ${delay}ms (tentativo ${crashCount})`);
    setTimeout(() => { if (!app.isQuitting && !isRestarting) startReceiver(); }, delay);
  });

  console.log(`[app] Receiver avviato — sessioni in: ${config.sessionsDir}`);
}

function restartReceiver() {
  // Fix 4: attendi l'evento 'exit' del vecchio processo PRIMA di rilanciare,
  // altrimenti la porta 8081 può essere ancora occupata (EADDRINUSE).
  isRestarting = true;
  // Restart manuale (cambio cartella): azzera il backoff dei crash.
  crashCount = 0;
  const launch = () => {
    isRestarting = false;
    startReceiver();
  };
  if (receiverProc) {
    const old = receiverProc;
    receiverProc = null;
    old.once('exit', () => {
      // ≥1.5s dopo l'uscita: dà tempo al SO di liberare la porta.
      setTimeout(launch, RESTART_BASE_MS);
    });
    old.kill();
  } else {
    setTimeout(launch, RESTART_BASE_MS);
  }
}

// ─── Probe Pi ─────────────────────────────────────────────────────────────────
function probePi(callback) {
  const req = http.request({
    hostname: '192.168.7.1', port: 8080, path: '/status',
    method: 'GET', timeout: PROBE_TIMEOUT_MS,
  }, res => { piAvailable = (res.statusCode === 200); res.resume(); callback(piAvailable); });
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
      // Fix 5: la finestra che carica il contenuto REMOTO del Pi usa un preload
      // MINIMALE (nessun IPC privilegiato esposto). Il preload completo è
      // riservato agli HTML LOCALI (loading/settings).
      preload: path.join(__dirname, 'preload-remote.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadURL(PI_URL);

  // Fix 2: usa did-finish-load (ricorrente) invece di ready-to-show (one-shot)
  // così anche un loadURL di retry dopo un fail-load ri-mostra la finestra.
  mainWindow.webContents.on('did-finish-load', () => {
    if (loadingWin) { loadingWin.close(); loadingWin = null; }
    mainWindow.show();
    mainWindow.focus();
  });

  // Fix 2: NON chiudere/ricreare mainWindow su fail-load (innescava un ciclo
  // close/open con doppia finestra di loading). Tieni la STESSA mainWindow
  // nascosta, mostra il loader (solo se non esiste già) e lascia che lo
  // scheduleProbe ritenti loadURL sulla finestra esistente.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode) => {
    // -3 = ERR_ABORTED, capita su navigazioni sovrapposte: ignora.
    if (errorCode === -3) return;
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
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
            // Fix 2: se mainWindow esiste già (fail-load precedente), ricarica
            // sulla STESSA finestra invece di crearne una nuova.
            if (mainWindow) mainWindow.loadURL(PI_URL);
            else createMainWindow();
          }, 800);
        } else if (mainWindow) {
          mainWindow.loadURL(PI_URL);
        } else {
          createMainWindow();
        }
      } else {
        if (loadingWin) loadingWin.webContents.send('probe-failed');
        scheduleProbe();
      }
    });
  }, PROBE_INTERVAL_MS);
}

// ─── ESC: conferma uscita ─────────────────────────────────────────────────────
// Fix 8: usa un dialog NATIVO Electron invece di iniettare un overlay nel DOM
// remoto del Pi via executeJavaScript + polling. Un errore d'iniezione non deve
// più causare app.quit() senza conferma.
let quitDialogOpen = false;
function handleEscQuit() {
  const win = mainWindow || loadingWin;
  if (!win) { app.isQuitting = true; app.quit(); return; }
  if (quitDialogOpen) return;   // evita dialog multipli su ESC ripetuti

  quitDialogOpen = true;
  dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Annulla', 'Esci'],
    defaultId: 0,
    cancelId: 0,
    title: 'AeroDrag Coach',
    message: 'Uscire da AeroDrag Coach?',
    detail: 'I dati della sessione corrente sono al sicuro sul Pi e sul PC.',
    noLink: true,
  }).then(({ response }) => {
    quitDialogOpen = false;
    if (response === 1) {
      app.isQuitting = true;
      app.quit();
    }
  }).catch(() => { quitDialogOpen = false; });
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

// ─── Menu applicazione ────────────────────────────────────────────────────────
// Fix 3: su macOS l'app frameless restava viva senza un modo nativo di uscire.
// Registra un menu con ruolo `quit` (acceleratore ⌘Q) che imposta isQuitting.
function buildAppMenu() {
  const quitItem = {
    label: 'Esci da AeroDrag Coach',
    accelerator: 'CmdOrCtrl+Q',
    click: () => { app.isQuitting = true; app.quit(); },
  };
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        quitItem,
      ],
    });
  } else {
    template.push({ label: 'File', submenu: [quitItem] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildAppMenu();
  startReceiver();
  createLoadingWindow();
  globalShortcut.register('Escape', handleEscQuit);
  scheduleProbe();

  app.on('activate', () => {
    // Fix 3: non ricreare finestre mentre l'app sta uscendo.
    if (app.isQuitting) return;
    if (!mainWindow && !loadingWin) createLoadingWindow();
  });
});

// Fix 3: assicura la terminazione del receiver alla chiusura definitiva.
app.on('before-quit', () => { app.isQuitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (receiverProc) { receiverProc.kill(); receiverProc = null; }
  clearTimeout(probeTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
