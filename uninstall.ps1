<#
.SYNOPSIS
  Désinstalle « IA locale (Capet Local) » : plugin, agent « IA locale », moteur, modèles.

.DESCRIPTION
  Retire de Paseo le plugin et l'agent « IA locale », puis supprime le dossier des données
  (moteur llama.cpp, modèles, Oh My Pi, journaux). Paseo, Bun et Node.js restent installés :
  ils servent à d'autres choses. Le fichier d'échange de Windows n'est pas modifié.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepModels   # garde les modèles (10 à 19 Go chacun)
#>
param(
  # Keep the downloaded models: a later install finds them and skips the download.
  [switch]$KeepModels,
  # No question and no final pause (scripted runs).
  [switch]$Unattended
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = "Désinstallation IA locale" } catch {}
$PluginId = "capet-local"
$Gateway = "http://127.0.0.1:8190"

function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Native([scriptblock]$block) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $block 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
}
function Find-Paseo {
  $cmd = Join-Path $env:LOCALAPPDATA "Programs\Paseo\resources\bin\paseo.cmd"
  if (Test-Path $cmd) { return $cmd }
  $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "Paseo*" -and $_.DisplayIcon } | Select-Object -First 1
  if ($entry) {
    $cmd = Join-Path (Split-Path ($entry.DisplayIcon -replace ',\d+$', '').Trim('"')) "resources\bin\paseo.cmd"
    if (Test-Path $cmd) { return $cmd }
  }
  return $null
}

Write-Host "Désinstallation de l'IA locale pour Paseo" -ForegroundColor Cyan
$defaultHome = Join-Path $env:LOCALAPPDATA "CapetLocal"
$pointer = Join-Path $defaultHome "home.txt"
$dataDir = $defaultHome
if (Test-Path $pointer) {
  $target = (Get-Content -Raw $pointer).Trim([char]0xFEFF, " ", "`r", "`n")
  if ($target) { $dataDir = $target }
}
Write-Host "  Dossier des données : $dataDir"
if (-not $Unattended) {
  if (-not $KeepModels) {
    $answer = Read-Host "  Supprimer aussi les modèles téléchargés (10 à 19 Go chacun) ? [O/n]"
    if ($answer -match '^[nN]') { $KeepModels = $true }
  }
  $answer = Read-Host "  Désinstaller l'IA locale maintenant ? [O/n]"
  if ($answer -match '^[nN]') { Write-Host "Annulé."; exit 0 }
}

# 1. Free the graphics card: the engine holds its files open.
try { Invoke-RestMethod -Method Post "$Gateway/capet/stop" -TimeoutSec 30 | Out-Null; Ok "Modèle déchargé de la carte graphique" } catch {}

# 2. Plugin and agent out of Paseo.
$paseo = Find-Paseo
$config = Join-Path $env:USERPROFILE ".paseo\config.json"
if ($paseo) {
  Native { & $paseo plugin remove $PluginId } | Out-Null
  Ok "Plugin retiré de Paseo"
}
if (Test-Path $config) {
  try {
    $json = Get-Content -Raw -Encoding UTF8 $config | ConvertFrom-Json
    if ($json.agents -and $json.agents.providers -and $json.agents.providers.PSObject.Properties[$PluginId]) {
      Copy-Item $config "$config.capet-uninstall-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
      $json.agents.providers.PSObject.Properties.Remove($PluginId)
      [IO.File]::WriteAllText($config, ($json | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding $false))
      Ok "Agent « IA locale » retiré de Paseo"
    }
  } catch { Warn "Configuration de Paseo non modifiée : $($_.Exception.Message)" }
}
$settings = Join-Path $env:USERPROFILE ".paseo\plugin-settings\$PluginId"
if (Test-Path $settings) { Remove-Item -Recurse -Force $settings }
if ($paseo) { Native { & $paseo reload } | Out-Null }

# 3. A llama-server of ours still running (Paseo closed while a model was loaded).
$runtime = Join-Path $dataDir "runtime"
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Local agents still open in Paseo: each is a Bun process running Oh My Pi from our folder,
# and it keeps the agent's files open (the omp folder would stay behind).
$agentDir = Join-Path $dataDir "agent"
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($agentDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2

# 4. Files. Only folders this installer created, never the whole data folder blindly:
#    with -DataDir the user may have pointed it at a folder that holds other things.
$freed = 0
foreach ($name in "runtime", "plugin", "agent", "omp", "logs", "models") {
  if ($name -eq "models" -and $KeepModels) { continue }
  $dir = Join-Path $dataDir $name
  if (-not (Test-Path $dir)) { continue }
  $freed += (Get-ChildItem -Recurse -File -Force $dir -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  try { Remove-Item -Recurse -Force $dir } catch { Warn "Dossier non supprimé (fichier ouvert ?) : $dir" }
}
foreach ($name in "state.json", "calibration.json", "contexts.json") {
  $file = Join-Path $dataDir $name
  if (Test-Path $file) { Remove-Item -Force $file }
}
Ok ("Fichiers supprimés ({0:N1} Go libérés)" -f ($freed / 1GB))
if ($KeepModels) {
  Ok "Modèles gardés dans $(Join-Path $dataDir 'models')"
} else {
  foreach ($dir in @($dataDir, $defaultHome) | Select-Object -Unique) {
    foreach ($name in "home.txt", "uninstall.ps1", "Desinstaller.cmd") {
      $file = Join-Path $dir $name
      if (Test-Path $file) { Remove-Item -Force $file -ErrorAction SilentlyContinue }
    }
    # Gone only when nothing else is left in it.
    if ((Test-Path $dir) -and -not (Get-ChildItem -Force $dir)) { Remove-Item -Force $dir -ErrorAction SilentlyContinue }
  }
}

Write-Host "`nTerminé." -ForegroundColor Green
Write-Host "Paseo, Bun et Node.js restent installés. Pour retirer Paseo : Paramètres de Windows > Applications."
if (-not $Unattended) { Write-Host "`nAppuie sur Entrée pour fermer."; [void](Read-Host) }
