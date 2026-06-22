# AeroDrag Coach — App Desktop

App desktop Electron per il dashboard coach. Nessuna cornice browser,
si apre con doppio click sull'icona, si chiude con ESC + conferma.

## Struttura

```
aerodrag-coach-app/
  main.js        ← processo principale Electron
  preload.js     ← bridge sicuro renderer↔main
  assets/
    loading.html ← schermata di attesa Pi
    icon.png     ← icona app (sostituire con logo AeroDrag)
    icon.ico     ← icona Windows
    icon.icns    ← icona Mac
  package.json
```

## Come funziona

1. Doppio click su "AeroDrag Coach" sul desktop
2. Appare la schermata di attesa (spinner) mentre cerca il Pi
3. Appena il Pi è disponibile (USB collegato), si apre il dashboard
4. Per uscire: premi ESC → appare la schermata di conferma → "Esci"
5. Il PC Receiver si avvia in background automaticamente

## Build per distribuzione

**Prerequisiti:**
```bash
npm install
```

**Windows** (produce .exe installer):
```bash
npm run build:win
# Output: dist/AeroDrag Coach Setup 1.0.0.exe
```

**Mac** (produce .dmg):
```bash
npm run build:mac
# Output: dist/AeroDrag Coach-1.0.0.dmg
```

**Linux** (produce .AppImage):
```bash
npm run build:linux
# Output: dist/AeroDrag Coach-1.0.0.AppImage
```

## Sviluppo (senza build)

```bash
npm install
npm start
```

## Icone

Sostituire i file placeholder con le icone reali:
- `assets/icon.png`  — 512×512 PNG (Linux + loading screen)
- `assets/icon.ico`  — multi-size ICO (Windows)  
- `assets/icon.icns` — ICNS (Mac)

## Installazione su PC coach

**Windows:**
1. Esegui `AeroDrag Coach Setup 1.0.0.exe`
2. L'installer crea l'icona sul desktop automaticamente
3. Doppio click su "AeroDrag Coach" per aprire

**Mac:**
1. Apri `AeroDrag Coach-1.0.0.dmg`
2. Trascina l'app nella cartella Applicazioni
3. Doppio click per aprire

## Conformità contratto

Ancorato a **`aerodrag-firmware/docs/CONTRACT.md` v0.3.1** (fonte di verità unica).

- **Dashboard (§4):** non renderizzata dal coach — l'app carica quella servita
  dal Pi (`http://192.168.7.1:8080/dashboard`). L'interpretazione di `pctAero`
  come percentuale 0–100 è quindi responsabilità del Pi (seam `pi↔coach`).
- **Sessione (§5):** il `pc-receiver` riceve via `POST /receive` e riserve via
  `GET /sessions/:id` lo schema `{ts, deviceId, athleteName, laps[]}` (con
  `pts[]` incl. `pitch`/`rho`) **verbatim**, senza riscritture. Il filename è
  validato a **suffisso `deviceId` obbligatorio** (`^session_\d+_[A-Fa-f0-9]+\.json$`):
  niente `unknown` né forma anonima (v0.1.2, identità garantita alla sorgente).
- **Governance:** nessun cambiamento d'interfaccia in autonomia; le modifiche si
  concordano nelle seam issue e si ratificano nel contratto (bump SemVer).

## Note

- L'app si connette automaticamente al Pi su 192.168.7.1:8080
- Il PC Receiver ascolta su 192.168.7.2:8081 (interfaccia USB del PC, CONTRACT §5);
  si avvia in background senza aprire finestre. Override per dev/test con
  `AERODRAG_BIND_HOST` (es. `127.0.0.1`)
- Le sessioni vengono salvate in `Documents/AeroDrag/sessions/`
- Se il Pi non è collegato, la schermata di attesa riprova ogni 2.5 secondi
