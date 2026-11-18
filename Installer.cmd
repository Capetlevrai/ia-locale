@echo off
chcp 65001 >nul
echo Installation de l'IA locale pour Paseo...
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
