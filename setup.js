/**
 * BossFreeForm Automated Setup Script
 * 다른 PC나 포맷 후 `npm run setup` 또는 `node setup.js` 실행 시
 * 구글 드라이브 경로 자동 탐색, 기본 보드 생성, 단독 실행 파일(BossFreeForm.exe) 빌드 및 바탕화면 바로가기(.lnk) 생성을 자동 수행합니다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const driveSync = require('./src/main/driveSync');

const ROOT_DIR = __dirname;

console.log('====================================================');
console.log(' 🎨 BossFreeForm 자동 환경 셋업 시작');
console.log('====================================================');

const status = driveSync.getSyncStatus();
if (status.isDesktopDriveDetected) {
  console.log(`[✓] Google Drive PC 동기화 폴더 자동 감지됨: ${status.syncFolderPath}`);
} else {
  console.log(`[i] 기본 로컬 데이터 폴더로 초기화됨: ${status.syncFolderPath}`);
}
console.log('[✓] config.json 설정 및 기본 프리폼 보드/에셋 디렉터리 준비 완료');

// 2. 커스텀 아이콘(assets/icon.ico) 확인 및 생성
const iconIcoPath = path.join(ROOT_DIR, 'assets', 'icon.ico');
if (!fs.existsSync(iconIcoPath)) {
  try {
    require('./scripts/generate-icon');
  } catch (err) {
    console.warn('[!] 아이콘 생성 스크립트 실행 경고:', err.message);
  }
}

// 3. 단독 실행 파일(dist/BossFreeForm/BossFreeForm.exe) 확인 및 빌드
const builtExePath = path.join(ROOT_DIR, 'dist', 'BossFreeForm', 'BossFreeForm.exe');
if (!fs.existsSync(builtExePath)) {
  try {
    require('./scripts/build-exe');
  } catch (err) {
    console.warn('[!] EXE 자동 빌드 건너뜀:', err.message);
  }
}

// 4. 바탕화면 바로가기 생성 (BossFreeForm.exe 우선 연결)
try {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const shortcutPath = path.join(desktopDir, 'BossFreeForm 보드.lnk');
  const hasExe = fs.existsSync(builtExePath);
  const targetPath = hasExe ? builtExePath : 'wscript.exe';
  const targetArgs = hasExe ? '' : `"${path.join(ROOT_DIR, 'BossFreeForm_시작.vbs')}"`;
  const workDir = hasExe ? path.dirname(builtExePath) : ROOT_DIR;
  const iconLoc = hasExe
    ? `${builtExePath},0`
    : fs.existsSync(iconIcoPath)
      ? `${iconIcoPath},0`
      : 'shell32.dll,21';

  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$Shortcut.TargetPath = '${targetPath.replace(/'/g, "''")}'
$Shortcut.Arguments = '${targetArgs.replace(/'/g, "''")}'
$Shortcut.WorkingDirectory = '${workDir.replace(/'/g, "''")}'
$Shortcut.Description = 'BossFreeForm - Standalone Google Drive Infinite Canvas'
$Shortcut.IconLocation = '${iconLoc.replace(/'/g, "''")}'
$Shortcut.Save()
`;
  const tempPs1 = path.join(os.tmpdir(), 'bossfreeform_shortcut.ps1');
  fs.writeFileSync(tempPs1, '\ufeff' + psScript, 'utf8');
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPs1}"`);
  fs.unlinkSync(tempPs1);
  console.log(`[✓] 바탕화면 바로가기 생성 완료: ${shortcutPath}`);
} catch (err) {
  console.warn('[!] 바탕화면 바로가기 생성 건너뜀:', err.message);
}

console.log('====================================================');
console.log(' ✨ BossFreeForm 설치 및 셋업이 완료되었습니다!');
console.log(' 👉 실행 방법: dist\\BossFreeForm\\BossFreeForm.exe 실행');
console.log('    또는 바탕화면의 [BossFreeForm 보드] 아이콘 더블클릭 (호출 단축키: Ctrl+Shift+Space)');
console.log('====================================================');
