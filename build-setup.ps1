<#
.SYNOPSIS
  Construit CapetLocal-Setup.exe (installateur en un clic) et le zip équivalent.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-setup.ps1
#>
param([string]$OutDir = [Environment]::GetFolderPath("Desktop"))
$ErrorActionPreference = "Stop"
$stage = Join-Path $env:TEMP "CapetLocal-build"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
$payloadDir = Join-Path $stage "payload"
New-Item -ItemType Directory -Force $payloadDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "install.ps1"), (Join-Path $PSScriptRoot "Installer.cmd"), (Join-Path $PSScriptRoot "LISEZMOI.txt") $payloadDir
robocopy (Join-Path $PSScriptRoot "capet-local") (Join-Path $payloadDir "capet-local") /E /XD node_modules tools /XF package-lock.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
$payload = Join-Path $stage "payload.zip"
Compress-Archive -Path (Join-Path $payloadDir "*") -DestinationPath $payload

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$exe = Join-Path $OutDir "CapetLocal-Setup.exe"
& $csc /nologo /target:exe /optimize+ "/out:$exe" "/resource:$payload,payload.zip" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot "setup\Setup.cs")
if ($LASTEXITCODE -ne 0) { throw "csc $LASTEXITCODE" }
Copy-Item $payload (Join-Path $OutDir "CapetLocal-beta.zip") -Force
"Installateur : $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) Ko)"
"Zip : $(Join-Path $OutDir 'CapetLocal-beta.zip')"

# macOS and Linux: one self-extracting script (setup/unix-header.sh + a tar.gz of install.sh,
# its helper and the plugin). The header finds the archive after its __CAPET_PAYLOAD__ line.
$unixDir = Join-Path $stage "unix"
New-Item -ItemType Directory -Force (Join-Path $unixDir "setup") | Out-Null
Copy-Item (Join-Path $PSScriptRoot "install.sh"), (Join-Path $PSScriptRoot "LISEZMOI.txt") $unixDir
Copy-Item (Join-Path $PSScriptRoot "setup\install-helper.mjs") (Join-Path $unixDir "setup")
robocopy (Join-Path $PSScriptRoot "capet-local") (Join-Path $unixDir "capet-local") /E /XD node_modules tools /XF package-lock.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
foreach ($script in (Join-Path $unixDir "install.sh"), (Join-Path $unixDir "setup\install-helper.mjs")) {
  if ([IO.File]::ReadAllText($script).Contains("`r")) { throw "$script a des fins de ligne Windows (CRLF) : bash ne le lirait pas" }
}
$tgz = Join-Path $stage "unix.tar.gz"
& tar.exe -czf $tgz -C $unixDir .
if ($LASTEXITCODE -ne 0) { throw "tar $LASTEXITCODE" }
$sh = Join-Path $OutDir "CapetLocal-Setup.sh"
$header = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "setup\unix-header.sh"))
if ([Text.Encoding]::UTF8.GetString($header).Contains("`r")) { throw "unix-header.sh a des fins de ligne Windows (CRLF)" }
[IO.File]::WriteAllBytes($sh, [byte[]]($header + [IO.File]::ReadAllBytes($tgz)))
"Installateur Mac et Linux : $sh ($([math]::Round((Get-Item $sh).Length / 1KB)) Ko)"
