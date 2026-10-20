; Inno Setup Script for BossFreeForm
; Standalone Infinite Canvas Workspace x Google Drive
; (보스가 명시적으로 배포용 Setup.exe 생성을 요청할 때에만 컴파일)

#define MyAppName "BossFreeForm"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "BossFreeForm Software"
#define MyAppExeName "BossFreeForm.exe"

[Setup]
AppId={{8E4C72B1-5A91-4E3A-9C14-7D8E92C3A105}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=BossFreeForm_Setup_v1.0.0
SetupIconFile=..\assets\icon.ico
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 BossFreeForm 바로가기 만들기"; GroupDescription: "추가 아이콘:"; Flags: checkedonce

[Files]
Source: "..\dist\BossFreeForm\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{#MyAppName} 제거"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName} 보드"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "BossFreeForm 지금 실행하기 (호출 단축키: Ctrl+Shift+Space)"; Flags: postinstall nowait skipifsilent
