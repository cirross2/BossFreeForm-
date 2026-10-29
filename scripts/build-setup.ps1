[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = (Resolve-Path "$scriptDir\..").Path
$distDir = Join-Path $rootDir "dist"
$exePath = Join-Path $distDir "BossFreeForm\BossFreeForm.exe"

Write-Host "=== [1/3] BossFreeForm 단독 EXE 확인 ===" -ForegroundColor Cyan
if (-not (Test-Path $exePath)) {
    Write-Host "BossFreeForm.exe가 없어 먼저 단독 EXE를 빌드합니다..." -ForegroundColor Yellow
    node "$scriptDir\build-exe.js"
}

Write-Host "=== [2/3] Inno Setup 기반 배포용 설치 파일(BossFreeForm_Setup_v1.0.0.exe) 컴파일 ===" -ForegroundColor Cyan
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
    Write-Error "Inno Setup 6 (ISCC.exe)를 찾을 수 없습니다."
    exit 1
}

$issFile = Join-Path $scriptDir "BossFreeForm_Setup.iss"
& "$isccPath" "$issFile"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup 컴파일 실패 (ExitCode: $LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Host "=== [3/3] 디지털 서명 적용 ===" -ForegroundColor Cyan
$certName = "CN=BossFreeForm Software"
$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $certName } | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certName -CertStoreLocation "Cert:\CurrentUser\My" -FriendlyName "BossFreeForm Code Signing Certificate" -NotAfter (Get-Date).AddYears(5)
}

$setupExe = Join-Path $distDir "BossFreeForm_Setup_v1.0.0.exe"
if (Test-Path $setupExe) {
    Set-AuthenticodeSignature -Certificate $cert -FilePath $setupExe -HashAlgorithm SHA256 | Out-Null
    $releaseDir = "E:\코딩\배포본"
    if (Test-Path "E:\코딩") {
        New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
        Copy-Item -Path $setupExe -Destination (Join-Path $releaseDir "BossFreeForm_Setup_v1.0.0.exe") -Force
    }
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host " ✨ 배포용 설치 파일 생성 완료: $setupExe" -ForegroundColor Green
    Write-Host " 📂 배포본 폴더 복사 완료: $releaseDir\BossFreeForm_Setup_v1.0.0.exe" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
}
