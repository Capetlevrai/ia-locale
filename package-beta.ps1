<#
.SYNOPSIS
  Construit le zip de la bêta pour les abonnés : install.ps1, Installer.cmd,
  LISEZMOI.txt et le plugin (sans node_modules ni outils de test).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\package-beta.ps1
#>
param([string]$Out = (Join-Path ([Environment]::GetFolderPath("Desktop")) "CapetLocal-beta.zip"))
$ErrorActionPreference = "Stop"
$stage = Join-Path $env:TEMP "CapetLocal-beta"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $PSScriptRoot "install.ps1"), (Join-Path $PSScriptRoot "Installer.cmd"), (Join-Path $PSScriptRoot "LISEZMOI.txt") $stage
robocopy (Join-Path $PSScriptRoot "capet-local") (Join-Path $stage "capet-local") /E /XD node_modules tools /XF package-lock.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
if (Test-Path $Out) { Remove-Item -Force $Out }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $Out
"Paquet : $Out ($([math]::Round((Get-Item $Out).Length / 1KB)) Ko)"
