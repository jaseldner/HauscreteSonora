@echo off
title Respaldo Hauscrete
cd /d "%~dp0"
echo.
echo   Generando respaldo de tu base de datos (incluye todo Ajustes)...
echo.
node backup.mjs
echo.
echo   Listo. El archivo quedo en la carpeta "backups".
pause
