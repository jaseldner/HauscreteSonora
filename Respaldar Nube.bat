@echo off
title Respaldo de la NUBE - Hauscrete
cd /d "%~dp0"
echo.
echo   Descargando el respaldo de la base EN LA NUBE (hauscrete-crm.fly.dev)...
echo.
node backup-nube.mjs
echo.
echo   Listo. El respaldo quedo en la carpeta "backups".
pause
