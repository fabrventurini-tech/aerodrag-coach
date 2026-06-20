#!/bin/bash
set -euo pipefail
echo "AeroDrag PC Receiver"
echo "Avvio ricezione sessioni dal Pi..."
echo "Le sessioni vengono salvate in: ~/Documents/AeroDrag/sessions/"
echo ""

# Fix 11: verifica che node sia nel PATH con un messaggio chiaro.
if ! command -v node >/dev/null 2>&1; then
  echo "ERRORE: 'node' non trovato nel PATH." >&2
  echo "Installa Node.js (>= 18) da https://nodejs.org e riprova." >&2
  exit 1
fi

node "$(dirname "$0")/pc-receiver.js"
