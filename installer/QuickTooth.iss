; QuickTooth installer (Inno Setup 6.7+). Build it with installer\build.ps1, which publishes the
; native app (one exe) and passes AppVersion and AppSource on the ISCC command line.
;
; Per-user install into %LOCALAPPDATA%\Programs\QuickTooth (the same folder publish.ps1 uses), so
; it needs no admin rights and installs cleanly over a copy that publish.ps1 put there.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppSource
  #error Pass /DAppSource=<publish folder> (installer\build.ps1 does this).
#endif

#define AppName "QuickTooth"
#define AppExe "QuickTooth.exe"
#define AppUrl "https://github.com/benjkr/quicktooth"

[Setup]
AppId={{7B3B0E01-B6A0-48E8-9970-DC16E85B4B7F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=benjkr
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup

PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041

; The [Code] section closes QuickTooth itself (it's a tray app with no visible window).
CloseApplications=no
RestartApplications=no

SetupIconFile=..\assets\quicktooth.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern dynamic windows11
SetupLogging=yes

OutputDir=..\dist
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

[Tasks]
; Offered (ticked) only on a fresh install. An update leaves "Start with Windows" exactly as the
; user last set it in the tray menu.
Name: autostart; Description: "Start QuickTooth when I sign in to Windows"; Check: IsFreshInstall

[InstallDelete]
; Left over from 1.0.x builds, which bundled the .NET runtime and WPF next to the exe.
Type: files; Name: "{app}\*_cor3.dll"

[Files]
Source: "{#AppSource}\*"; Excludes: "*.pdb"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Connect or disconnect your AirPods with one click"

[Run]
; Only ever turns autostart on, and only on a fresh install. The app's own menu (or uninstalling)
; turns it off.
Filename: "{app}\{#AppExe}"; Parameters: "--autostart on"; Flags: runhidden waituntilterminated; Tasks: autostart
; No skipifsilent: a silent update should leave QuickTooth running, as it was before.
Filename: "{app}\{#AppExe}"; Description: "Start QuickTooth now"; Flags: nowait postinstall

[UninstallDelete]
Type: dirifempty; Name: "{app}"

[Code]
const
  TrayMutex = 'Local\QuickTooth.Tray.6F0C2B1E';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

{ No QuickTooth.exe in the install folder yet. Also treats a copy that publish.ps1 put there as
  an existing install, so switching to the installer keeps its autostart setting. }
function IsFreshInstall: Boolean;
begin
  Result := not FileExists(AddBackslash(WizardDirValue) + '{#AppExe}');
end;

{ The running tray copies of this exe (WMI), or nil if WMI is unavailable. }
function RunningCopies(const ExePath: String): Variant;
var
  Locator, Service: Variant;
  Path: String;
begin
  Result := Null;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Path := ExePath;
    StringChangeEx(Path, '\', '\\', True);
    StringChangeEx(Path, '''', '\''', True);
    Result := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE ExecutablePath = ''' + Path + '''');
  except
    Result := Null;
  end;
end;

function IsRunning(const ExePath: String): Boolean;
var
  Procs: Variant;
begin
  Procs := RunningCopies(ExePath);
  if VarIsNull(Procs) then
    Result := CheckForMutexes(TrayMutex)
  else
    Result := Procs.Count > 0;
end;

function WaitUntilGone(const ExePath: String; TimeoutMs: Integer): Boolean;
var
  Waited: Integer;
begin
  Waited := 0;
  while IsRunning(ExePath) and (Waited < TimeoutMs) do
  begin
    Sleep(200);
    Waited := Waited + 200;
  end;
  Result := not IsRunning(ExePath);
end;

{ Asks the running tray to exit (QuickTooth.exe --exit), then force-closes it if it hasn't
  gone within 10 s. A running exe can't be overwritten or deleted. }
function CloseQuickTooth(const ExePath: String): Boolean;
var
  Procs: Variant;
  I, Code: Integer;
begin
  Result := True;
  if not FileExists(ExePath) or not IsRunning(ExePath) then Exit;
  Log('Asking the running QuickTooth to exit');
  Exec(ExePath, '--exit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if WaitUntilGone(ExePath, 10000) then Exit;
  Log('QuickTooth did not exit in time; terminating it');
  Procs := RunningCopies(ExePath);
  if not VarIsNull(Procs) then
    for I := 0 to Procs.Count - 1 do
      try
        Procs.ItemIndex(I).Terminate();
      except
      end;
  Result := WaitUntilGone(ExePath, 5000);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not CloseQuickTooth(ExpandConstant('{app}\{#AppExe}')) then
    Result := 'QuickTooth is still running and could not be closed. Choose Exit in its tray menu, then run Setup again.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Value: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    CloseQuickTooth(ExpandConstant('{app}\{#AppExe}'));
    { Remove "Start with Windows", but only if it points at this install. Settings in
      %APPDATA%\QuickTooth are kept, so a reinstall remembers the chosen headset. }
    if RegQueryStringValue(HKEY_CURRENT_USER, RunKey, '{#AppName}', Value) and
       (Pos(Lowercase(ExpandConstant('{app}')), Lowercase(Value)) > 0) then
      RegDeleteValue(HKEY_CURRENT_USER, RunKey, '{#AppName}');
  end;
end;
