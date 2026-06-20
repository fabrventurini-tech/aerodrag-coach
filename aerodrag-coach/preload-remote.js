/**
 * Preload MINIMALE per la finestra che carica contenuto REMOTO (dashboard del Pi).
 *
 * Sicurezza (issue #8, contract v0.2.3): la dashboard è HTML/JS servito dal Pi
 * (o potenzialmente MITM sul link USB in HTTP). NON deve avere accesso ad alcuna
 * API privilegiata. Per questo la finestra remota usa questo preload — che non
 * espone NULLA via contextBridge — invece di `preload.js` (riservato alle sole
 * finestre LOCALI loading.html/settings.html).
 *
 * Mantenuto come file esplicito (anziché "nessun preload") per rendere
 * l'intenzione evidente e impedire future aggiunte accidentali di API qui.
 */

// Volutamente vuoto: nessuna API esposta al contenuto remoto.
