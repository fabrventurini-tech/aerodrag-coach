@echo off
echo AeroDrag PC Receiver
echo Avvio ricezione sessioni dal Pi...
echo Le sessioni vengono salvate in: %USERPROFILE%\Documents\AeroDrag\sessions\
echo.

REM Fix 11: verifica che node sia nel PATH con un messaggio chiaro.
where node >/dev/null 2>nul
if errorlevel 1 (
  echo ERRORE: "node" non trovato nel PATH.
  echo Installa Node.js ^(^>= 18^) da https://nodejs.org e riprova.
  pause
  exit /b 1
)

node "%~dp0pc-receiver.js"
pause
