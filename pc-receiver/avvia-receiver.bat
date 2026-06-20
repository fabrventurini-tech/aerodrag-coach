@echo off
setlocal
set "DIR=%~dp0"
set "RECEIVER=%DIR%pc-receiver.js"

echo AeroDrag PC Receiver
echo Avvio ricezione sessioni dal Pi...
echo Le sessioni vengono salvate in: %USERPROFILE%\Documents\AeroDrag\sessions\
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERRORE: 'node' non trovato nel PATH. Installa Node.js ^>= 18.
  pause
  exit /b 1
)

if not exist "%RECEIVER%" (
  echo ERRORE: pc-receiver.js non trovato in "%DIR%"
  pause
  exit /b 1
)

node "%RECEIVER%"
pause
