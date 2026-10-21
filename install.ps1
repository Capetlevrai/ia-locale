<#
.SYNOPSIS
  Installe « IA locale (Capet Local) » sur ce PC, de zéro jusqu'au modèle prêt.

.DESCRIPTION
  Chaque étape vérifie avant d'agir et peut être relancée sans risque :
    1. Paseo (téléchargé et installé s'il manque, service démarré)
    2. Carte graphique et pilote (NVIDIA : moteur CUDA ; AMD, Intel : moteur Vulkan)
    3. Mémoire virtuelle de Windows
    4. Bun + Oh My Pi (l'agent)
    5. Node.js (outils navigateur de l'agent)
    6. Plugin IA locale, copié et activé dans Paseo
    7. Moteur llama.cpp + modèle conseillé pour la carte, chargé, agent « IA locale » ajouté à Paseo
  Ensuite : ouvrir Paseo, créer un agent et choisir « IA locale ».

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DataDir D:\CapetLocal   # moteur et modèles sur D:
#>
param(
  # Where the engine, models and plugin go (models weigh 10-19 GB). Empty: C: if it has
  # room, otherwise the fixed drive with the most free space.
  [string]$DataDir = "",
  [switch]$SkipNode,
  # Leave Windows' paging file alone (otherwise enlarged automatically when too small).
  [switch]$SkipPagefile,
  # Stop after the plugin: no engine or model download.
  [switch]$NoModel,
  # No question and no final pause (scripted runs).
  [switch]$Unattended
)

$ErrorActionPreference = "Stop"
# Accents survive Windows PowerShell 5 consoles and SSH sessions.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = "Installation IA locale" } catch {}
# GitHub and Hugging Face refuse the TLS 1.0 that Windows PowerShell 5 may default to.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Invoke-WebRequest is many times slower while it draws its progress bar.
$ProgressPreference = "SilentlyContinue"
$OmpVersion = "18.8.0"
# OMP 18.8 uses `using` declarations: older Bun fails with "Unexpected identifier".
$MinBun = [version]"1.3.14"
$PluginId = "capet-local"
$Gateway = "http://127.0.0.1:8190"
$Steps = 7

function Step($n, $text) { Write-Host "`n[$n/$Steps] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host "  X   $text" -ForegroundColor Red
  if (-not $Unattended) { Write-Host "`nAppuie sur Entrée pour fermer."; [void](Read-Host) }
  exit 1
}
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Native([scriptblock]$block) {
  # Native tools print progress on stderr; Windows PowerShell 5 treats that as fatal.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $block 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
}
function Find-Paseo {
  # Default per-user install, else wherever the uninstall entry says (custom folder).
  $cmd = Join-Path $env:LOCALAPPDATA "Programs\Paseo\resources\bin\paseo.cmd"
  if (Test-Path $cmd) { return $cmd }
  $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "Paseo*" -and $_.DisplayIcon } | Select-Object -First 1
  # InstallLocation stays empty for custom folders; DisplayIcon is "<dir>\Paseo.exe,0".
  if ($entry) {
    $cmd = Join-Path (Split-Path ($entry.DisplayIcon -replace ',\d+$', '').Trim('"')) "resources\bin\paseo.cmd"
    if (Test-Path $cmd) { return $cmd }
  }
  return $null
}
function Get-Status {
  try { return Invoke-RestMethod "$Gateway/capet/status" -TimeoutSec 15 } catch { return $null }
}
function Wait-Gateway([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $s = Get-Status
    if ($s) { return $s }
    Start-Sleep 3
  }
  return $null
}
function Gb($bytes) { "{0:N1}" -f ($bytes / 1GB) }

# --- 1. Paseo ---------------------------------------------------------------
Step 1 "Paseo"
$paseo = Find-Paseo
if (-not $paseo) {
  Write-Host "  Téléchargement de Paseo (environ 140 Mo)..."
  $feed = "https://github.com/getpaseo/paseo/releases/latest/download"
  try { $yml = (Invoke-WebRequest "$feed/latest.yml" -UseBasicParsing -TimeoutSec 60).Content } catch { Fail "Impossible de joindre GitHub pour télécharger Paseo : $($_.Exception.Message)" }
  if ($yml -is [byte[]]) { $yml = [Text.Encoding]::UTF8.GetString($yml) }
  # latest.yml lists one installer per processor; its "path:" line can name the ARM64 one
  # (0.12.0), which installs nothing on a regular PC. Pick ours, else the universal one.
  $files = [regex]::Matches($yml, '(?m)^\s*-\s*url:\s*(\S+\.exe)\s*$') | ForEach-Object { $_.Groups[1].Value }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $file = $files | Where-Object { $_ -like "*-$arch.exe" } | Select-Object -First 1
  if (-not $file) { $file = $files | Where-Object { $_ -notmatch '-(x64|arm64|ia32)\.exe$' } | Select-Object -First 1 }
  if (-not $file) { Fail "Version de Paseo introuvable sur GitHub." }
  $sha = ([regex]::Match($yml, "(?s)url:\s*$([regex]::Escape($file))\s+sha512:\s*(\S+)")).Groups[1].Value
  $setup = Join-Path $env:TEMP $file
  & curl.exe -L --fail --retry 10 --retry-all-errors --retry-delay 5 -C - --progress-bar -o $setup "$feed/$file"
  if ($LASTEXITCODE -ne 0) { Fail "Téléchargement de Paseo impossible (curl $LASTEXITCODE)." }
  if ($sha) {
    $hex = (Get-FileHash -Algorithm SHA512 $setup).Hash
    $bytes = [byte[]]::new($hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
    if ([Convert]::ToBase64String($bytes) -ne $sha) { Remove-Item $setup; Fail "Le fichier de Paseo téléchargé est abîmé : relance l'installation." }
  }
  Write-Host "  Installation de Paseo..."
  Start-Process $setup -ArgumentList "/S" -Wait
  Remove-Item $setup -ErrorAction SilentlyContinue
  $paseo = Find-Paseo
  if (-not $paseo) { Fail "Paseo ne s'est pas installé. Installe-le depuis https://paseo.sh puis relance l'installation." }
}
$paseoVersion = (Native { & $paseo --version }).Trim()
Ok "Paseo $paseoVersion"
# A fresh Paseo has no configuration and no running service until its first-time setup.
$config = Join-Path $env:USERPROFILE ".paseo\config.json"
if (-not (Test-Path $config)) {
  Write-Host "  Première configuration de Paseo..."
  Native { & $paseo onboard --relay --voice disable --timeout 300 } | Out-Null
  if (-not (Test-Path $config)) { Fail "La première configuration de Paseo a échoué (paseo onboard)." }
  Ok "Service Paseo configuré et démarré (accès depuis le téléphone activé)"
} else {
  # Already running: returns at once. Stopped: starts in the background and waits until ready.
  Native { & $paseo start --timeout 180 } | Out-Null
}

# --- 2. Carte graphique -----------------------------------------------------
Step 2 "Carte graphique"
# Several cards: the plugin runs the engine on the one with the most VRAM, so size everything for it.
$cards = @()
if (Have "nvidia-smi") {
  $cards = @((Native { nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits }).Trim().Split("`n") |
    Where-Object { $_ -match "," } |
    ForEach-Object {
      $f = $_.Split(",") | ForEach-Object { $_.Trim() }
      [pscustomobject]@{ Name = $f[0]; Mem = [int]$f[1]; Driver = $f[2]; Cap = $f[3] }
    } | Sort-Object Mem -Descending)
}
if ($cards.Count -gt 0) {
  $gpuName, $mem, $driver, $cap = $cards[0].Name, $cards[0].Mem, $cards[0].Driver, $cards[0].Cap
  $vramGb = [int]$mem / 1024
  Ok "$gpuName, $([math]::Round($vramGb)) Go de VRAM, pilote $driver"
  if ($cards.Count -gt 1) { Ok "$($cards.Count) cartes détectées : l'IA locale utilisera seulement la $gpuName" }
  $major = [int]($driver.Split(".")[0])
  # RTX 50 (Blackwell, compute 12.x) uses the CUDA 13 engine, which needs driver 580+.
  # Older cards use CUDA 12.4, which needs 551+.
  $need = if ([double]$cap -ge 12) { 580 } else { 551 }
  if ($major -lt $need) {
    Fail "Pilote NVIDIA trop ancien ($driver, il faut $need ou plus). Mets-le à jour avec l'application NVIDIA ou sur https://www.nvidia.com/fr-fr/drivers/ puis relance l'installation."
  }
} else {
  # AMD, Intel and others (Vulkan engine), detected like the plugin does (server/hardware.ts):
  # DirectX lists each adapter it has seen with its LUID, and only cards present now have
  # a GPU memory counter. Microsoft's software renderer (vendor 0x1414) is skipped.
  $present = @{}
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -EA 0 | ForEach-Object {
    if ($_.Name -match '^luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_0$') { $present[[Convert]::ToInt64($matches[1] + $matches[2], 16)] = $true }
  }
  $cards = @(Get-ChildItem HKLM:\SOFTWARE\Microsoft\DirectX -EA 0 | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.Description -and $_.VendorId -ne 0x1414 -and $_.DedicatedVideoMemory -gt 0 -and $present.ContainsKey([int64]$_.AdapterLuid) } |
    Sort-Object LastSeen -Descending | Group-Object AdapterLuid | ForEach-Object { $_.Group[0] } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Description; Mem = [int]($_.DedicatedVideoMemory / 1MB) } } |
    Sort-Object Mem -Descending)
  if ($cards.Count -eq 0) {
    Fail "Aucune carte graphique détectée. Installe le pilote de ta carte (NVIDIA, AMD ou Intel) puis relance l'installation."
  }
  $gpuName, $mem = $cards[0].Name, $cards[0].Mem
  $vramGb = $mem / 1024
  Ok "$gpuName, $([math]::Round($vramGb)) Go de VRAM (moteur Vulkan)"
  if ($cards.Count -gt 1) { Ok "$($cards.Count) cartes détectées : l'IA locale utilisera seulement la $gpuName" }
  Warn "Cartes AMD et Intel : prise en charge expérimentale. Les cartes NVIDIA restent les plus rapides."
  if (-not (Test-Path (Join-Path $env:WINDIR "System32\vulkan-1.dll"))) {
    Fail "Le pilote de ta carte ne fournit pas Vulkan. Mets-le à jour (AMD Software Adrenalin, ou pilote Intel Arc) puis relance l'installation."
  }
}
if ($vramGb -lt 7.5) { Warn "Moins de 8 Go de VRAM : aucun modèle n'est conseillé pour cette carte." }

# --- 3. Mémoire virtuelle de Windows ----------------------------------------
Step 3 "Mémoire de Windows"
# Windows reserves virtual memory as large as the VRAM the engine uses (measured:
# +16 GB for 13 GB of VRAM, while real RAM stays ~1 GB). The limit is RAM + paging
# file: with a small paging file (nearly full C:) the engine crashes on load. The
# paging file is only a guarantee here: inference speed is unchanged.
$os = Get-CimInstance Win32_OperatingSystem
$ramGb = $os.TotalVisibleMemorySize / 1MB
$roomGb = $os.FreeVirtualMemory / 1MB
$needGb = $vramGb + 8
if ($ramGb -lt 15) { Warn ("{0:N0} Go de RAM : 16 Go minimum conseillés, 32 Go pour les cartes de 10 à 12 Go." -f $ramGb) }
if ($SkipPagefile) {
  Ok "Fichier d'échange laissé tel quel (option -SkipPagefile)"
} elseif ($roomGb -ge $needGb) {
  Ok ("Mémoire virtuelle suffisante ({0:N0} Go disponibles)" -f $roomGb)
} else {
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object FreeSpace -Descending | Select-Object -First 1
  $file = "$($disk.DeviceID)\pagefile.sys"
  Write-Host ("  Mémoire virtuelle juste ({0:N0} Go pour {1:N0} Go conseillés) : ajout d'un fichier d'échange sur {2}" -f $roomGb, $needGb, $disk.DeviceID)
  # System-managed sizes (0/0) on the roomiest drive; the existing one stays.
  $fix = @"
`$cs = Get-CimInstance Win32_ComputerSystem
if (`$cs.AutomaticManagedPagefile) { Set-CimInstance -InputObject `$cs -Property @{ AutomaticManagedPagefile = `$false } }
if (-not (Get-CimInstance Win32_PageFileSetting | Where-Object Name -eq 'C:\pagefile.sys')) {
  New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\pagefile.sys'; InitialSize = [uint32]0; MaximumSize = [uint32]0 } | Out-Null
}
if (-not (Get-CimInstance Win32_PageFileSetting | Where-Object Name -eq '$file')) {
  New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = '$file'; InitialSize = [uint32]0; MaximumSize = [uint32]0 } | Out-Null
}
"@
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  try {
    if ($isAdmin) { Invoke-Expression $fix }
    else {
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fix))
      Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList "-NoProfile -EncodedCommand $encoded"
    }
    Ok "Fichier d'échange ajouté sur $($disk.DeviceID) (actif au prochain redémarrage ; d'ici là le plugin s'adapte tout seul)"
  } catch {
    Warn "Fichier d'échange non modifié ($($_.Exception.Message)). Le plugin réduira la VRAM utilisée si besoin."
  }
}

# Data folder (engine, models, agent): decided here because the agent installs into it.
$defaultHome = Join-Path $env:LOCALAPPDATA "CapetLocal"
$pointer = Join-Path $defaultHome "home.txt"
if (-not $DataDir) {
  # Keep a folder chosen by a previous install; otherwise C: if it has room for models.
  if (Test-Path $pointer) {
    $DataDir = (Get-Content -Raw $pointer).Trim([char]0xFEFF, " ", "`r", "`n")
  } else {
    $c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    $best = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object FreeSpace -Descending | Select-Object -First 1
    $DataDir = if ($c.FreeSpace -ge 45GB -or $best.DeviceID -eq $c.DeviceID) { $defaultHome } else { "$($best.DeviceID)\CapetLocal" }
  }
}
$DataDir = [IO.Path]::GetFullPath($DataDir)
New-Item -ItemType Directory -Force $DataDir, $defaultHome | Out-Null
# The plugin reads this pointer to find its data folder (engine, models, logs).
if ($DataDir -ne $defaultHome) {
  [IO.File]::WriteAllText($pointer, $DataDir, (New-Object Text.UTF8Encoding $false))
} elseif (Test-Path $pointer) {
  Remove-Item $pointer
}

# --- 4. Bun + Oh My Pi ------------------------------------------------------
Step 4 "Agent Oh My Pi"
$bunBin = Join-Path $env:USERPROFILE ".bun\bin"
# The official bun.exe: another Bun (e.g. installed through npm, which only adds
# bun.cmd/bun.ps1) is not something the plugin can launch Oh My Pi with.
$bun = Join-Path $bunBin "bun.exe"
if (-not (Test-Path $bun)) {
  Write-Host "  Installation de Bun (runtime de l'agent)..."
  # Separate process: the official script must not inherit this script's error settings.
  Native { powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm https://bun.sh/install.ps1 | iex" } | Out-Null
}
if (-not (Test-Path $bun)) { Fail "Bun ne s'est pas installé dans $bunBin (https://bun.sh)." }
$env:Path = "$bunBin;$env:Path"
$bunVersion = [version](((Native { & $bun --version }).Trim() -split '[-+]')[0])
if ($bunVersion -lt $MinBun) {
  Write-Host "  Mise à jour de Bun $bunVersion -> $MinBun ou plus (requis par Oh My Pi)..."
  Native { & $bun upgrade } | Out-Null
  $bunVersion = [version](((Native { & $bun --version }).Trim() -split '[-+]')[0])
  if ($bunVersion -lt $MinBun) { Fail "Bun $bunVersion est trop ancien et n'a pas pu être mis à jour (bun upgrade)." }
}
Ok "Bun $bunVersion"
# Oh My Pi goes in its own folder, run by bun.exe directly (see findOmp in the plugin):
# Bun's global install follows a stray ~/package.json, and its omp.exe launcher needs
# bun.exe on the PATH of whatever starts it.
$agentDir = Join-Path $DataDir "agent"
$cli = Join-Path $agentDir "node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"
# A working Oh My Pi prints "omp/<version>"; anything else (crash, cut download) means reinstall.
$current = if (Test-Path $cli) { (Native { & $bun $cli --version }).Trim() } else { "" }
if ($current -notmatch "^omp/$([regex]::Escape($OmpVersion))") {
  Write-Host "  Installation d'Oh My Pi $OmpVersion..."
  if (Test-Path $agentDir) { Remove-Item -Recurse -Force $agentDir }
  New-Item -ItemType Directory -Force $agentDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $agentDir "package.json"), '{ "name": "capet-local-agent", "private": true }', (New-Object Text.UTF8Encoding $false))
  Native { & $bun add "@oh-my-pi/pi-coding-agent@$OmpVersion" --cwd $agentDir } | Out-Null
  $current = if (Test-Path $cli) { (Native { & $bun $cli --version }).Trim() } else { "" }
  if ($current -notmatch "^omp/") { Fail "Oh My Pi ne démarre pas après installation : $current" }
}
Ok "Oh My Pi $($current -replace '^omp/', '')"

# --- 5. Node.js -------------------------------------------------------------
Step 5 "Node.js (outils navigateur de l'agent)"
if (Have "npx") {
  Ok "Node.js $((Native { node --version }).Trim())"
} elseif ($SkipNode) {
  Warn "Ignoré : les outils navigateur (Playwright, Chrome DevTools) ne seront pas disponibles."
} elseif (Have "winget") {
  Write-Host "  Installation de Node.js LTS..."
  Native { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements } | Out-Null
  $env:Path = "$bunBin;" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (Have "npx") { Ok "Node.js $((Native { node --version }).Trim())" } else { Warn "Node.js installé : il sera pris en compte au prochain démarrage de Paseo." }
} else {
  Warn "Node.js absent et winget indisponible : installe-le depuis https://nodejs.org pour les outils navigateur."
}

# --- 6. Plugin --------------------------------------------------------------
Step 6 "Plugin IA locale"
$source = Join-Path $PSScriptRoot $PluginId
if (-not (Test-Path (Join-Path $source "paseo-plugin.json"))) { Fail "Dossier du plugin introuvable : $source" }
$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$([IO.Path]::GetPathRoot($DataDir).TrimEnd('\'))'"
Ok ("Moteur et modèles dans {0} ({1} Go libres)" -f $DataDir, (Gb $drive.FreeSpace))
if ($drive.FreeSpace -lt 25GB) { Warn "Moins de 25 Go libres sur ce disque : un modèle pèse de 11 à 19 Go." }
$target = Join-Path $DataDir "plugin\$PluginId"
New-Item -ItemType Directory -Force $target | Out-Null
# Paseo provides zod and its SDK to plugins: node_modules and test tools are not needed.
robocopy $source $target /MIR /XD node_modules tools /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copie du plugin impossible (robocopy $LASTEXITCODE)." }
Ok "Plugin copié dans $target"

# Third-party plugins only load with "pluginsEnabled": true (no CLI flag for it).
$raw = Get-Content -Raw -Encoding UTF8 $config
if ($raw -notmatch '"pluginsEnabled"\s*:\s*true') {
  Copy-Item $config "$config.capet-install-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  $json = $raw | ConvertFrom-Json
  $json | Add-Member -NotePropertyName pluginsEnabled -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($config, ($json | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding $false))
  Ok "Plugins tiers activés dans Paseo"
}
$installed = Native { & $paseo plugin ls }
if ($installed -match "(?m)^$PluginId\s") {
  Native { & $paseo plugin reload $PluginId } | Out-Null
  Ok "Plugin déjà installé : rechargé"
} else {
  Native { & $paseo plugin install $target } | Out-Null
  Ok "Plugin installé dans Paseo"
}
# Stop and start from here rather than restart: a service started before Bun and Node were
# installed keeps its old PATH, and Oh My Pi's launcher then cannot find bun.exe.
Native { & $paseo daemon stop } | Out-Null
Native { & $paseo start --timeout 180 } | Out-Null
$status = Wait-Gateway 180
if (-not $status) { Fail "Le plugin ne répond pas après le redémarrage de Paseo. Relance l'installation ; si ça persiste, envoie le dossier $DataDir\logs." }
Ok "Plugin actif"

# --- 7. Moteur, modèle et agent ---------------------------------------------
Step 7 "Moteur et modèle"
if ($NoModel) {
  Warn "Ignoré (option -NoModel) : choisis un modèle dans Paseo > IA locale."
} else {
  if (-not $status.runtime.installed) {
    Write-Host "  Téléchargement du moteur llama.cpp..."
    try { Invoke-RestMethod -Method Post "$Gateway/capet/install-runtime" -TimeoutSec 1800 | Out-Null } catch { Fail "Moteur non installé : $($_.Exception.Message)" }
    $status = Get-Status
  }
  if (-not $status.runtime.installed) { Fail "Le moteur llama.cpp ne s'est pas installé. Relance l'installation." }
  Ok "Moteur llama.cpp installé"

  $settings = Join-Path $env:USERPROFILE ".paseo\plugin-settings\$PluginId\local.json"
  $chosen = $null
  if (Test-Path $settings) { try { $chosen = (Get-Content -Raw -Encoding UTF8 $settings | ConvertFrom-Json).values.modelId } catch {} }
  $model = $status.models | Where-Object { $_.id -eq $chosen } | Select-Object -First 1
  if (-not $model) { $model = $status.models | Where-Object { $_.tier -eq "recommended" } | Select-Object -First 1 }
  if (-not $model) {
    Warn "Aucun modèle conseillé pour cette carte : choisis-en un dans Paseo > IA locale."
  } else {
    Ok "Modèle conseillé : $($model.label) ($(Gb $model.sizeBytes) Go)"
    if ($model.id -ne $chosen) {
      New-Item -ItemType Directory -Force (Split-Path $settings) | Out-Null
      [IO.File]::WriteAllText($settings, (@{ version = 1; values = @{ modelId = $model.id } } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
      Native { & $paseo plugin reload $PluginId } | Out-Null
      if (-not (Wait-Gateway 120)) { Fail "Le plugin ne répond plus après le choix du modèle." }
    }

    # Download with live progress; the plugin resumes on network cuts, we restart it if it gives up.
    $tries = 0
    while ($true) {
      $m = (Get-Status).models | Where-Object { $_.id -eq $model.id }
      if ($m.installed) { break }
      if (-not $m.download -or $m.download.state -ne "running") {
        if ($tries -ge 5) { Write-Host ""; Fail "Téléchargement du modèle impossible : $($m.download.error)" }
        $tries++
        $body = @{ modelId = $model.id } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post "$Gateway/capet/download-model" -ContentType "application/json" -Body $body -TimeoutSec 60 | Out-Null
        Start-Sleep 3
        continue
      }
      $d = $m.download
      $pct = if ($d.total -gt 0) { [math]::Floor(100 * $d.done / $d.total) } else { 0 }
      Write-Host -NoNewline ("`r  Téléchargement du modèle : {0} / {1} Go ({2} %)   " -f (Gb $d.done), (Gb $d.total), $pct)
      Start-Sleep 3
    }
    Write-Host ""
    Ok "Modèle téléchargé"

    Write-Host "  Chargement du modèle sur la carte graphique (une à deux minutes)..."
    $e = Invoke-RestMethod -Method Post "$Gateway/capet/apply" -ContentType "application/json" -Body "{}" -TimeoutSec 1800
    if ($e.state -ne "ready") { Fail "Le modèle ne s'est pas chargé : $($e.error) (journal : $DataDir\logs\llama-server.log)" }
    $visionText = if ($e.vision) { "avec la vision" } else { "sans la vision" }
    Ok ("Modèle chargé : {0}K de contexte, {1}" -f [math]::Round($e.ctx / 1024), $visionText)
    if ($e.notice) { Warn $e.notice }

    # The plugin only gets a Paseo client once the app opens: register the agent here.
    $entry = Invoke-RestMethod "$Gateway/capet/provider" -TimeoutSec 30
    $json = Get-Content -Raw -Encoding UTF8 $config | ConvertFrom-Json
    if (-not $json.agents) { $json | Add-Member -NotePropertyName agents -NotePropertyValue ([pscustomobject]@{}) -Force }
    if (-not $json.agents.providers) { $json.agents | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{}) -Force }
    $json.agents.providers | Add-Member -NotePropertyName $entry.id -NotePropertyValue $entry.entry -Force
    [IO.File]::WriteAllText($config, ($json | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding $false))
    Native { & $paseo reload } | Out-Null
    $providers = Native { & $paseo provider ls }
    if ($providers -match "(?m)IA locale|$PluginId") { Ok "Agent « IA locale » ajouté à Paseo" } else { Warn "Agent « IA locale » ajouté ; il apparaîtra à l'ouverture de Paseo." }
  }
}

Write-Host "`nTerminé." -ForegroundColor Green
Write-Host "Ouvre Paseo, crée un agent et choisis « IA locale » comme fournisseur."
Write-Host "Réglages (modèle, contexte, outils) : Paseo > IA locale."
if (-not $Unattended) {
  $app = Join-Path (Split-Path (Split-Path (Split-Path $paseo))) "Paseo.exe"
  # Through Explorer: started from here, Paseo inherits this console and prints its logs
  # under "Terminé" (seen on a reinstall), which reads like a failure.
  if (Test-Path $app) { Start-Process explorer.exe -ArgumentList "`"$app`"" }
  Write-Host "`nAppuie sur Entrée pour fermer."; [void](Read-Host)
}
