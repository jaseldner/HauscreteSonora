@echo off
title Hauscrete CRM
cd /d "%~dp0"
echo.
echo   Iniciando Hauscrete CRM...
echo   Abriendo http://localhost:3000 en tu navegador.
echo   Deja esta ventana abierta mientras usas el sistema. Cierrala para apagarlo.
echo.
start "" http://localhost:3000
node server.mjs
pause
