[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = (Resolve-Path "$scriptDir\..").Path
$workspaceRoot = Split-Path -Parent $rootDir
$distDir = Join-Path $rootDir "dist"
$appDistDir = Join-Path $distDir "BossFreeForm"
$exePath = Join-Path $appDistDir "BossFreeForm.exe"

Write-Host "=== [1/3] Syncing BossFreeForm Standalone EXE ===" -ForegroundColor Cyan
if (-not (Test-Path $exePath)) {
    node "$scriptDir\build-exe.js"
} else {
    Copy-Item -Path (Join-Path $rootDir "package.json") -Destination (Join-Path $appDistDir "resources\app\package.json") -Force
    Copy-Item -Path (Join-Path $rootDir "src\*") -Destination (Join-Path $appDistDir "resources\app\src") -Recurse -Force
    Copy-Item -Path (Join-Path $rootDir "assets\*") -Destination (Join-Path $appDistDir "resources\app\assets") -Recurse -Force
}

Write-Host "=== [2/3] Compiling Inno Setup Installer (BossFreeForm_Setup_v1.0.0.exe) ===" -ForegroundColor Cyan
$isccCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$isccPath = $null
foreach ($cand in $isccCandidates) {
    if (Test-Path $cand) {
        $isccPath = $cand
        break
    }
}

if (-not $isccPath) {
    Write-Error "Inno Setup 6 (ISCC.exe) not found."
    exit 1
}

$issFile = Join-Path $scriptDir "BossFreeForm_Setup.iss"
& "$isccPath" "$issFile"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup compile failed (ExitCode: $LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Host "=== [3/3] Code Signing & Release Folder Copy ===" -ForegroundColor Cyan
$certName = "CN=BossFreeForm Software"
$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $certName } | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certName -CertStoreLocation "Cert:\CurrentUser\My" -FriendlyName "BossFreeForm Code Signing Certificate" -NotAfter (Get-Date).AddYears(5)
}

$setupExe = Join-Path $distDir "BossFreeForm_Setup_v1.0.0.exe"
if (Test-Path $setupExe) {
    Set-AuthenticodeSignature -Certificate $cert -FilePath $setupExe -HashAlgorithm SHA256 | Out-Null
    $releaseFolderName = [string][char]0xBC30 + [char]0xD3EC + [char]0xBCF8
    $releaseDir = Join-Path $workspaceRoot $releaseFolderName
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    Copy-Item -Path $setupExe -Destination (Join-Path $releaseDir "BossFreeForm_Setup_v1.0.0.exe") -Force
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host " Setup Installer Created: $setupExe" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
}
