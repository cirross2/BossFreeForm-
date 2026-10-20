/**
 * BossFreeForm Standalone EXE Builder (build-exe.js)
 * 별도 설치 없이 바로 실행 가능한 단독 실행 파일 버전:
 *   dist/BossFreeForm/BossFreeForm.exe
 * 을 빌드하고, 커스텀 아이콘(assets/icon.ico)을 EXE 바이너리에 직접 주입합니다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_APP_DIR = path.join(ROOT_DIR, 'dist', 'BossFreeForm');
const TARGET_EXE = path.join(DIST_APP_DIR, 'BossFreeForm.exe');
const ICON_ICO = path.join(ROOT_DIR, 'assets', 'icon.ico');

function findDependencySource(relPath) {
  const candidates = [
    path.join(ROOT_DIR, relPath),
    path.resolve(ROOT_DIR, '..', 'FreeformDrive', relPath),
    path.resolve(ROOT_DIR, '..', 'SpotlightAgent', relPath)
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('====================================================');
console.log(' 🚀 BossFreeForm 단독 실행 파일(.exe) 빌드 시작');
console.log('====================================================');

// 1. Ensure custom icon exists
if (!fs.existsSync(ICON_ICO)) {
  require('./generate-icon');
}

// 2. Locate Electron dist binary
const electronDist = findDependencySource(path.join('node_modules', 'electron', 'dist'));
if (!electronDist) {
  throw new Error('Electron 런타임(node_modules/electron/dist)을 찾을 수 없습니다. npm install을 먼저 실행해 주세요.');
}

console.log(`[1/4] Electron 런타임 복사 중... (${electronDist})`);
if (fs.existsSync(DIST_APP_DIR)) {
  fs.rmSync(DIST_APP_DIR, { recursive: true, force: true });
}
copyDirRecursive(electronDist, DIST_APP_DIR);

// 3. Rename electron.exe -> BossFreeForm.exe & remove default_app.asar
const origExe = path.join(DIST_APP_DIR, 'electron.exe');
if (fs.existsSync(origExe)) {
  fs.renameSync(origExe, TARGET_EXE);
}
const defaultAsar = path.join(DIST_APP_DIR, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) {
  fs.rmSync(defaultAsar, { force: true });
}

// 4. Populate resources/app with BossFreeForm source, assets, and runtime modules
console.log('[2/4] BossFreeForm 앱 리소스 및 모듈 패키징 중...');
const appResDir = path.join(DIST_APP_DIR, 'resources', 'app');
fs.mkdirSync(appResDir, { recursive: true });

fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(appResDir, 'package.json'));
copyDirRecursive(path.join(ROOT_DIR, 'src'), path.join(appResDir, 'src'));
copyDirRecursive(path.join(ROOT_DIR, 'assets'), path.join(appResDir, 'assets'));

const runtimeDeps = ['marked', 'pdfjs-dist'];
for (const dep of runtimeDeps) {
  const depSrc = findDependencySource(path.join('node_modules', dep));
  if (depSrc) {
    copyDirRecursive(depSrc, path.join(appResDir, 'node_modules', dep));
  }
}

// 5. Inject custom multi-resolution icon (assets/icon.ico) into BossFreeForm.exe PE resources
console.log('[3/4] BossFreeForm.exe 실행 파일에 커스텀 아이콘 주입 중...');
const psIconInject = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class PeIconInjector {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, string lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

    public static void InjectIcon(string exePath, string icoPath) {
        byte[] ico = File.ReadAllBytes(icoPath);
        int count = BitConverter.ToUInt16(ico, 4);
        IntPtr hUpdate = BeginUpdateResource(exePath, false);
        if (hUpdate == IntPtr.Zero) throw new Exception("BeginUpdateResource failed");

        using (MemoryStream grpStream = new MemoryStream())
        using (BinaryWriter bw = new BinaryWriter(grpStream)) {
            bw.Write((ushort)0);
            bw.Write((ushort)1);
            bw.Write((ushort)count);

            for (int i = 0; i < count; i++) {
                int entryOffset = 6 + i * 16;
                byte width = ico[entryOffset];
                byte height = ico[entryOffset + 1];
                byte colorCount = ico[entryOffset + 2];
                byte reserved = ico[entryOffset + 3];
                ushort planes = BitConverter.ToUInt16(ico, entryOffset + 4);
                ushort bitCount = BitConverter.ToUInt16(ico, entryOffset + 6);
                uint bytesInRes = BitConverter.ToUInt32(ico, entryOffset + 8);
                uint imgOffset = BitConverter.ToUInt32(ico, entryOffset + 12);

                byte[] imgData = new byte[bytesInRes];
                Buffer.BlockCopy(ico, (int)imgOffset, imgData, 0, (int)bytesInRes);

                ushort iconId = (ushort)(i + 1);
                UpdateResource(hUpdate, (IntPtr)3, (IntPtr)iconId, 1033, imgData, bytesInRes);

                bw.Write(width);
                bw.Write(height);
                bw.Write(colorCount);
                bw.Write(reserved);
                bw.Write(planes);
                bw.Write(bitCount);
                bw.Write(bytesInRes);
                bw.Write(iconId);
            }

            byte[] grpData = grpStream.ToArray();
            UpdateResource(hUpdate, (IntPtr)14, "IDR_MAINFRAME", 1033, grpData, (uint)grpData.Length);
            UpdateResource(hUpdate, (IntPtr)14, (IntPtr)1, 1033, grpData, (uint)grpData.Length);
        }

        if (!EndUpdateResource(hUpdate, false)) {
            throw new Exception("EndUpdateResource failed");
        }
    }
}
"@
[PeIconInjector]::InjectIcon('${TARGET_EXE.replace(/'/g, "''")}', '${ICON_ICO.replace(/'/g, "''")}')
`;

try {
  const tmpPs1 = path.join(os.tmpdir(), `inject_icon_${Date.now()}.ps1`);
  fs.writeFileSync(tmpPs1, '\ufeff' + psIconInject, 'utf8');
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { stdio: 'inherit' });
  fs.unlinkSync(tmpPs1);
  console.log('[✓] BossFreeForm.exe 커스텀 아이콘 주입 완료');
} catch (err) {
  console.warn('[!] 아이콘 리소스 주입 경고:', err.message);
}

console.log('[4/4] 빌드 검증 중...');
if (!fs.existsSync(TARGET_EXE)) {
  throw new Error('BossFreeForm.exe 파일이 생성되지 않았습니다.');
}
const stat = fs.statSync(TARGET_EXE);
console.log('====================================================');
console.log(` ✨ BossFreeForm 단독 실행 파일 빌드 완료!`);
console.log(` 📂 경로: ${TARGET_EXE}`);
console.log(` 📦 크기: ${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
console.log('====================================================');
