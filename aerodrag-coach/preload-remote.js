// Fix 5: preload MINIMALE per il contenuto REMOTO HTTP (dashboard del Pi
// caricata via http://192.168.7.1:8080/dashboard).
//
// La dashboard remota è una pagina in chiaro servita dal Pi: NON deve avere
// accesso agli IPC privilegiati (dialog, shell.openPath, scrittura config,
// restart del processo) esposti dal preload completo. Questo preload non
// espone NULLA al contesto remoto.
//
// Mantenuto come file dedicato (invece di "nessun preload") per chiarezza
// d'intento e per avere un punto unico dove aggiungere, se mai servisse,
// API di sola lettura sicure per la dashboard.
