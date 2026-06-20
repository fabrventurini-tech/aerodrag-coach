#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIVER="$DIR/pc-receiver.js"

echo "AeroDrag PC Receiver"
echo "Avvio ricezione sessioni dal Pi..."
echo "Le sessioni vengono salvate in: ~/Documents/AeroDrag/sessions/"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "ERRORE: 'node' non trovato nel PATH. Installa Node.js >= 18." >&2
  exit 1
fi

if [ ! -f "$RECEIVER" ]; then
  echo "ERRORE: pc-receiver.js non trovato in $DIR" >&2
  exit 1
fi

exec node "$RECEIVER"
