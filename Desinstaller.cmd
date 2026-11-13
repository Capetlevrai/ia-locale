@echo off
rem Desinstalle l'IA locale. Le script est copie dans le dossier temporaire puis lance de la :
rem il supprime le dossier ou ce fichier se trouve.
copy /y "%~dp0uninstall.ps1" "%TEMP%\capetlocal-uninstall.ps1" >nul
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\capetlocal-uninstall.ps1"
