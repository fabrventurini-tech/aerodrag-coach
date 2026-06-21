# AeroDrag Coach — Design / Redesign

Materiale di **redesign** della visualizzazione grafica. Punto di partenza:
i mockup concept generati in Canva, da cui è stata estratta la direzione visiva,
poi tradotta in **prototipi statici HTML** (apribili in qualsiasi browser).

## Card / mockup concept (`mockups/`)
Slide-concept (stile presentazione) usate come **moodboard**, non come spec 1:1.

| File | Schermata | Concept |
|------|-----------|---------|
| `A1-dashboard.png` · `A2-loading.png` · `A3-settings.png` | dashboard / loading / settings | Concept A (navy + teal, premium dark) |
| `B1-dashboard.png` · `B2-loading.png` · `B3-settings.png` | dashboard / loading / settings | Concept B (slate freddo, gauge ad anello, card arrotondate) |

## Prototipi statici (`prototype/`)
Proposta concreta, autonoma (nessuna dipendenza, dati finti):

| File | Stato | Destinazione |
|------|-------|--------------|
| `prototype/loading.html`   | proposta | → `assets/loading.html` (questo repo) |
| `prototype/settings.html`  | proposta | → `assets/settings.html` (questo repo) |
| `prototype/dashboard.html` | **solo proposta** | → `aerodrag-pi/server/dashboard.html` (repo del vicino; coordinata via seam #3) |

## Direzione visiva
- **Palette** (raffinamento di quella attuale): bg `#07090f`; superfici `#0f1420`/`#161d2e`/`#1e2840`;
  bordo `rgba(120,160,220,.12)`; accenti **teal `#00d9a3`**, ambra `#f5a623`, rosso `#ff4d6a`,
  blu `#4d9fff`, viola `#9b7bff`.
- **Tipografia**: sans (Inter/system-ui) per label e titoli, **monospace** per i valori numerici.
- **CdA come ring-gauge** (da Concept B): anello con gradiente teal→blu + readout centrale,
  al posto del numero piatto.
- **Card** più ariose: radius 12–14px, padding maggiore, sottile highlight interno, ombre morbide.
- **Gerarchia**: label piccole maiuscole spaziate; valori grandi; micro-stati colore
  (teal/ambra/rosso) per peak/avg/best.

## Governance
- Le schermate **loading/settings** sono in questo repo → PR qui.
- La **dashboard live** è in `aerodrag-pi/server/dashboard.html`: solo proposta, la PR spetta al Pi
  (seam pi↔coach #3 / pi#6).
