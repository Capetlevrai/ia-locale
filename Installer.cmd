@echo off
chcp 65001 >nul
echo Installation de l'IA locale pour Paseo...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
