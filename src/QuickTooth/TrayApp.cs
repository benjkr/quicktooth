using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using QuickTooth.Native;
using static QuickTooth.Native.Win32;

namespace QuickTooth;

/// <summary>
/// The notification-area icon: a hidden top-level window (message-only windows never receive
/// "TaskbarCreated" or WM_SETTINGCHANGE), Shell_NotifyIcon v4, a native popup menu, and a small
/// connect/disconnect state machine. Everything here runs on the STA UI thread; device work runs
/// on <see cref="DeviceWorker"/>.
/// </summary>
internal sealed class TrayApp
{
    private const int WM_TRAY = WM_APP + 1;
    private const int WM_APP_INVOKE = WM_APP + 2;
    private const int WM_APP_DEVCHANGE = WM_APP + 3;

    private const int TIMER_ANIM = 1, TIMER_TIMEOUT = 2, TIMER_POLL = 3, TIMER_DEBOUNCE = 4,
        TIMER_FASTPOLL = 5, TIMER_ADD_RETRY = 6, TIMER_PROMOTE = 7, TIMER_RESEND = 8, TIMER_BATTERY = 9;

    // Measured on this machine: with the Hands-Free control included, reconnects land in ~1–3 s.
    // The timeout leaves room for one resend plus a slow page.
    private const int PendingTimeoutMs = 20000, IdlePollMs = 20000, PendingPollMs = 500,
        ResendAfterMs = 8000, LinkTeardownWaitMs = 5000;

    private const int CMD_CONNECT = 1, CMD_DISCONNECT = 2, CMD_AUTOSTART = 3, CMD_EXIT = 4, CMD_DEVICE_BASE = 100;

    // Rooted for the process lifetime: native code holds these.
    private static Mutex? s_mutex;
    private static TrayApp? s_app;
    private static WndProc? s_wndProc;

    private readonly DeviceWorker _worker = new();
    private readonly BluetoothAudio _audio = new();
    private readonly Settings _settings = Settings.Load();
    private readonly UiContext _ui;
    private readonly IntPtr _hwnd;
    private readonly int _msgTaskbarCreated;
    private readonly int _msgCommand;

    private IReadOnlyList<BtDevice> _devices = [];
    private BtDevice? _target;
    private bool _haveSnapshot;
    private string? _lastStateLog;

    private OneShot? _pending;
    private int _pendingSeq;
    private Guid _pendingContainer;
    private readonly Stopwatch _pendingWatch = new();
    private AnimPhase? _anim;                          // pending animation phase (see IconRenderer)
    private readonly Stopwatch _animClock = new();     // time since the phase started
    private double _tracerOffset;                      // tracer time carried into the phase
    private IntPtr _lastAnimIcon;                      // last live-rendered frame (freed when replaced)

    private bool _refreshing, _refreshAgain;

    private BatteryReading? _battery;
    private Guid _batteryContainer;
    private bool _batteryScanning, _wasConnected;
    private const int BatteryCheckMs = 60000;
    private static readonly TimeSpan BatteryMaxAge = TimeSpan.FromMinutes(5), BatteryShowAge = TimeSpan.FromMinutes(15);

    private bool _iconAdded;
    private int _addAttempts;
    private int _promoteAttempts;
    private int _iconSize;
    private bool _lightTaskbar;
    private IntPtr _iconOn, _iconOff, _shownIcon;
    private string _shownTip = "";

    private List<BtDevice> _menuDevices = [];

    public static int Run()
    {
        s_mutex = new Mutex(true, @"Local\QuickTooth.Tray.6F0C2B1E", out bool createdNew);
        if (!createdNew)
        {
            Log.Info("another tray instance is already running; exiting");
            return 0;
        }
        s_app = new TrayApp();
        return s_app.MessageLoop();
    }

    private TrayApp()
    {
        Log.Info($"tray start: {Environment.ProcessPath}");
        s_wndProc = WndProcImpl;
        var wc = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(s_wndProc),
            hInstance = GetModuleHandle(IntPtr.Zero),
            lpszClassName = Ipc.WindowClass,
        };
        if (RegisterClassEx(ref wc) == 0) throw new InvalidOperationException($"RegisterClassEx failed ({Marshal.GetLastWin32Error()})");
        _hwnd = CreateWindowEx(WS_EX_TOOLWINDOW, Ipc.WindowClass, "QuickTooth", WS_POPUP, 0, 0, 0, 0,
            IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero) throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()})");

        _msgTaskbarCreated = RegisterWindowMessage("TaskbarCreated");
        _msgCommand = RegisterWindowMessage(Ipc.CommandMessageName);
        // If we ever run elevated, let Explorer's broadcast and non-elevated CLI commands through UIPI.
        ChangeWindowMessageFilterEx(_hwnd, _msgTaskbarCreated, MSGFLT_ALLOW, IntPtr.Zero);
        ChangeWindowMessageFilterEx(_hwnd, _msgCommand, MSGFLT_ALLOW, IntPtr.Zero);

        _lightTaskbar = Theme.TaskbarIsLight();
        ApplyMenuTheme();
        RebuildIcons(); // touches WPF; install our context afterwards so ours is current

        _ui = new UiContext(_hwnd);
        SynchronizationContext.SetSynchronizationContext(_ui);

        AddIcon();

        _audio.EndpointChanged += _ => PostMessage(_hwnd, WM_APP_DEVCHANGE, IntPtr.Zero, IntPtr.Zero);
        _ = _worker.Run(_audio.RegisterNotifications);
        RequestRefresh();
        SetTimer(_hwnd, TIMER_POLL, IdlePollMs, IntPtr.Zero);
        SetTimer(_hwnd, TIMER_BATTERY, BatteryCheckMs, IntPtr.Zero);
        if (!_settings.TrayPromotedOnce) SetTimer(_hwnd, TIMER_PROMOTE, 3000, IntPtr.Zero);
    }

    private int MessageLoop()
    {
        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        _worker.Dispose();
        Log.Info("tray exit");
        return 0;
    }

    // ------------------------------------------------------------------ window procedure

    private IntPtr WndProcImpl(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (_ui != null && SynchronizationContext.Current != _ui) SynchronizationContext.SetSynchronizationContext(_ui);
            switch (msg)
            {
                case WM_TRAY:
                    OnTrayMessage(LoWord(lParam), wParam);
                    return IntPtr.Zero;
                case WM_APP_INVOKE:
                    _ui?.Drain();
                    return IntPtr.Zero;
                case WM_APP_DEVCHANGE:
                    SetTimer(_hwnd, TIMER_DEBOUNCE, 200, IntPtr.Zero);
                    return IntPtr.Zero;
                case WM_TIMER:
                    OnTimer((int)wParam);
                    return IntPtr.Zero;
                case WM_SETTINGCHANGE:
                    OnSettingChange(lParam);
                    break;
                case WM_DISPLAYCHANGE:
                case WM_DPICHANGED:
                    CheckIconMetrics();
                    break;
                case WM_DESTROY:
                    RemoveIcon();
                    PostQuitMessage(0);
                    return IntPtr.Zero;
                default:
                    if (msg == _msgTaskbarCreated && msg != 0)
                    {
                        Log.Info("TaskbarCreated: re-adding icon");
                        _iconAdded = false;
                        _addAttempts = 0;
                        RebuildIcons();
                        AddIcon();
                        return IntPtr.Zero;
                    }
                    if (msg == _msgCommand && msg != 0)
                    {
                        OnCommand((int)wParam);
                        return IntPtr.Zero;
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"wndproc msg=0x{msg:X}", ex);
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    private void OnTrayMessage(int ev, IntPtr wParam)
    {
        switch (ev)
        {
            case NIN_SELECT:     // left click (v4)
            case NIN_KEYSELECT:  // Space/Enter on the focused icon
                Toggle(ev == NIN_SELECT ? "click" : "key");
                break;
            case WM_CONTEXTMENU: // right click or Shift+F10 (v4: anchor in wParam)
                ShowMenu(LoWord(wParam), HiWord(wParam));
                break;
        }
    }

    private void OnCommand(int cmd)
    {
        switch (cmd)
        {
            case Ipc.CmdToggle: Toggle("cli"); break;
            case Ipc.CmdConnect: StartAction(OneShot.Connect, "cli"); break;
            case Ipc.CmdDisconnect: StartAction(OneShot.Disconnect, "cli"); break;
            case Ipc.CmdExit: DestroyWindow(_hwnd); break;
            case Ipc.CmdShowMenu:
                var id = new NOTIFYICONIDENTIFIER { cbSize = Marshal.SizeOf<NOTIFYICONIDENTIFIER>(), hWnd = _hwnd, uID = Ipc.IconId };
                if (Shell_NotifyIconGetRect(ref id, out var r) == 0) ShowMenu((r.Left + r.Right) / 2, r.Top);
                break;
            case Ipc.CmdCloseMenu: EndMenu(); break;
        }
    }

    private void OnTimer(int id)
    {
        switch (id)
        {
            case TIMER_ANIM:
                AdvanceAnimation();
                break;
            case TIMER_TIMEOUT:
                Log.Info($"{_pending} timed out after {_pendingWatch.ElapsedMilliseconds} ms; showing the real state");
                EndPending();
                RequestRefresh();
                break;
            case TIMER_FASTPOLL:
            case TIMER_POLL:
                RequestRefresh();
                if (id == TIMER_POLL) CheckIconMetrics();
                break;
            case TIMER_DEBOUNCE:
                KillTimer(_hwnd, TIMER_DEBOUNCE);
                RequestRefresh();
                break;
            case TIMER_ADD_RETRY:
                KillTimer(_hwnd, TIMER_ADD_RETRY);
                AddIcon();
                break;
            case TIMER_PROMOTE:
                KillTimer(_hwnd, TIMER_PROMOTE);
                TryPromoteOnce();
                break;
            case TIMER_RESEND:
                KillTimer(_hwnd, TIMER_RESEND);
                ResendConnect();
                break;
            case TIMER_BATTERY:
                SetTimer(_hwnd, TIMER_BATTERY, BatteryCheckMs, IntPtr.Zero); // back to the periodic check
                MaybeScanBattery(BatteryMaxAge);
                break;
        }
    }

    private void OnSettingChange(IntPtr lParam)
    {
        string? area = lParam != IntPtr.Zero ? Marshal.PtrToStringUni(lParam) : null;
        if (area == "ImmersiveColorSet")
        {
            bool light = Theme.TaskbarIsLight();
            if (light != _lightTaskbar)
            {
                Log.Info($"taskbar theme -> {(light ? "light" : "dark")}");
                _lightTaskbar = light;
                ApplyMenuTheme();
                RebuildIcons();
            }
        }
        else
        {
            CheckIconMetrics();
        }
    }

    // ------------------------------------------------------------------ state

    private void RequestRefresh()
    {
        if (_refreshing) { _refreshAgain = true; return; }
        _ = RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        _refreshing = true;
        try
        {
            do
            {
                _refreshAgain = false;
                string? mac = _target?.Mac;
                var (snap, windowsBattery) = await _worker.Run(() =>
                    (_audio.Enumerate(), mac != null ? Native.PnpEndpoints.BluetoothBattery(mac) : null));
                Apply(snap, windowsBattery);
            } while (_refreshAgain);
        }
        catch (Exception ex)
        {
            Log.Error("refresh", ex);
        }
        finally
        {
            _refreshing = false;
        }
    }

    private void Apply(Snapshot snap, int? windowsBattery = null)
    {
        _devices = snap.Devices;
        _haveSnapshot = true;
        _target = _settings.ResolveOrDefault(_devices, persist: true);

        bool connected = _target?.Connected == true;
        if (!connected)
        {
            _battery = null;
        }
        else
        {
            if (windowsBattery is int level) // headsets that report battery to Windows (not AirPods)
            {
                if (_battery?.Source != "windows" || _battery.Left != level) Log.Info($"battery: {level}% (Windows)");
                _battery = new BatteryReading(level, null, null, false, false, 0, DateTime.Now, "windows");
                _batteryContainer = _target!.ContainerId;
            }
            if (!_wasConnected) SetTimer(_hwnd, TIMER_BATTERY, 2500, IntPtr.Zero); // first reading soon after connecting
        }
        _wasConnected = connected;

        string stateLog = _target != null
            ? $"{_target.Name}: {(_target.Connected ? "connected" : "not connected")} ({_target.StateSignature})"
            : _settings.HasTarget ? $"{_settings.TargetName}: not available" : "no target";
        if (stateLog != _lastStateLog)
        {
            Log.Info("state " + stateLog);
            _lastStateLog = stateLog;
        }

        if (_pending is OneShot op && _target != null && _target.Connected == (op == OneShot.Connect))
        {
            Log.Info($"{op} confirmed after {_pendingWatch.ElapsedMilliseconds} ms");
            EndPending(succeeded: true);
        }
        UpdateIcon();
    }

    private void Toggle(string source)
    {
        if (_pending != null)
        {
            Log.Info($"{source}: ignored, {_pending} still pending");
            return;
        }
        if (_target == null)
        {
            Log.Info($"{source}: no target device");
            if (source != "cli" && GetCursorPos(out var pt)) ShowMenu(pt.X, pt.Y);
            return;
        }
        StartAction(_target.Connected ? OneShot.Disconnect : OneShot.Connect, source);
    }

    private async void StartAction(OneShot op, string source)
    {
        try
        {
            if (_pending != null) { Log.Info($"{source}: {op} ignored, {_pending} still pending"); return; }
            var target = _target;
            if (target == null) { Log.Info($"{source}: {op} ignored, no target"); return; }
            if (target.Connected == (op == OneShot.Connect)) { Log.Info($"{source}: already {(target.Connected ? "connected" : "disconnected")}"); return; }

            _pending = op;
            int seq = ++_pendingSeq;
            _pendingContainer = target.ContainerId;
            _pendingWatch.Restart();
            StartAnimation(op == OneShot.Connect ? AnimPhase.Connecting : AnimPhase.Disconnecting);
            Log.Info($"{source}: {op} '{target.Name}' {target.ContainerId:B} (was {target.StateSignature})");
            UpdateIcon();

            if (op == OneShot.Connect && target.Mac is string mac)
            {
                // After a disconnect the Bluetooth link lingers ~3 s; a reconnect sent into that teardown
                // can stall for 15 s+. Wait (still animating) until the link has closed.
                var hold = Stopwatch.StartNew();
                while (hold.ElapsedMilliseconds < LinkTeardownWaitMs
                       && await _worker.Run(() => PnpEndpoints.BluetoothConnected(mac)) == true)
                    await Task.Delay(200);
                if (seq != _pendingSeq || _pending != op) return;
                if (hold.ElapsedMilliseconds > 300) Log.Info($"waited {hold.ElapsedMilliseconds} ms for the previous link to close");
            }

            SetTimer(_hwnd, TIMER_TIMEOUT, PendingTimeoutMs, IntPtr.Zero);
            SetTimer(_hwnd, TIMER_FASTPOLL, PendingPollMs, IntPtr.Zero); // notifications may not fire for hidden endpoints
            if (op == OneShot.Connect) SetTimer(_hwnd, TIMER_RESEND, ResendAfterMs, IntPtr.Zero);

            // A2DP *and* Hands-Free controls: kicking only A2DP leaves Windows waiting for the
            // headset to bring up Hands-Free, which measured 15–40 s+ instead of ~1–3 s.
            var results = await _worker.Run(() => _audio.SendOneShot(target.ContainerId, op));
            // Judge success by the resulting state; only give up early if nothing accepted the request.
            if (results.Count == 0 || results.All(r => r.Hr < 0))
            {
                Log.Info($"{op}: no control accepted the request");
                EndPending();
            }
            RequestRefresh();
        }
        catch (Exception ex)
        {
            Log.Error($"{op}", ex);
            EndPending();
            RequestRefresh();
        }
    }

    /// <param name="succeeded">
    /// The state landed: a connect plays its close-and-fill ending, a disconnect plays its motion to
    /// the end. Otherwise a connect glides back (cancel). Clicks are accepted again immediately.
    /// </param>
    private void EndPending(bool succeeded = false)
    {
        var op = _pending;
        _pending = null;
        _pendingSeq++;
        double t = _animClock.Elapsed.TotalSeconds;
        if (op == OneShot.Connect && _anim == AnimPhase.Connecting)
            StartAnimation(succeeded ? AnimPhase.Landing : AnimPhase.Cancelling, tracerOffset: _tracerOffset + t);
        else if (op == OneShot.Disconnect && _anim == AnimPhase.Disconnecting && succeeded)
            { /* keeps playing; AdvanceAnimation stops it at its end pose */ }
        else
            StopAnimation();
        KillTimer(_hwnd, TIMER_TIMEOUT);
        KillTimer(_hwnd, TIMER_FASTPOLL);
        KillTimer(_hwnd, TIMER_RESEND);
        UpdateIcon();
    }

    /// <summary>One safety-net resend if a reconnect hasn't landed after <see cref="ResendAfterMs"/>.</summary>
    private async void ResendConnect()
    {
        if (_pending != OneShot.Connect) return;
        var container = _pendingContainer;
        Log.Info($"Connect not confirmed after {_pendingWatch.ElapsedMilliseconds} ms; resending once");
        try { await _worker.Run(() => _audio.SendOneShot(container, OneShot.Connect)); }
        catch (Exception ex) { Log.Error("resend", ex); }
        RequestRefresh();
    }

    // ------------------------------------------------------------------ notify icon

    private string StatusText()
    {
        if (_pending == OneShot.Connect) return "Connecting…";
        if (_pending == OneShot.Disconnect) return "Disconnecting…";
        if (!_haveSnapshot) return "Checking…";
        if (_target == null) return _settings.HasTarget ? "Not available" : "No device selected";
        return _target.Connected ? "Connected" : "Not connected";
    }

    private string DeviceLabel() => _target?.Name ?? _settings.TargetName ?? "QuickTooth";

    /// <summary>"30% · case 80%" while connected and the reading is recent; otherwise null.</summary>
    private string? BatteryText()
    {
        if (_pending != null || _target?.Connected != true || _battery == null) return null;
        if (_batteryContainer != _target.ContainerId || DateTime.Now - _battery.At > BatteryShowAge) return null;
        return _battery.Text;
    }

    /// <summary>Tooltip and menu header, e.g. "AirPods Pro — Connected · 30%".</summary>
    private string StatusLine() =>
        BatteryText() is string battery ? $"{DeviceLabel()} — {StatusText()} · {battery}" : $"{DeviceLabel()} — {StatusText()}";

    /// <summary>Reads AirPods battery from their BLE status advert (Windows doesn't expose it for AirPods).</summary>
    private async void MaybeScanBattery(TimeSpan maxAge)
    {
        var target = _target;
        if (_batteryScanning || _pending != null || target?.Connected != true) return;
        if (_battery != null && _batteryContainer == target.ContainerId &&
            (_battery.Source == "windows" || DateTime.Now - _battery.At < maxAge)) return;
        if (AppleStatusAdvert.ModelOf(target) is not ushort model) return;
        _batteryScanning = true;
        try
        {
            var reading = await BleBatteryScanner.ScanAsync(model, TimeSpan.FromSeconds(12));
            if (_target?.ContainerId != target.ContainerId || _target.Connected != true) return;
            if (reading == null)
            {
                Log.Info("battery: no status advert heard");
                return;
            }
            if (_battery?.Text != reading.Text) Log.Info("battery: " + reading.Describe());
            _battery = reading;
            _batteryContainer = target.ContainerId;
            UpdateIcon();
        }
        catch (Exception ex)
        {
            Log.Error("battery scan", ex);
        }
        finally
        {
            _batteryScanning = false;
        }
    }

    // ------------------------------------------------------------------ pending animation

    private void StartAnimation(AnimPhase phase, double tracerOffset = 0)
    {
        _anim = phase;
        _tracerOffset = tracerOffset;
        _animClock.Restart();
        SetTimer(_hwnd, TIMER_ANIM, IconRenderer.AnimFrameMs, IntPtr.Zero);
        UpdateIcon();
    }

    private void StopAnimation()
    {
        _anim = null;
        KillTimer(_hwnd, TIMER_ANIM);
        UpdateIcon();
    }

    private void AdvanceAnimation()
    {
        double t = _animClock.Elapsed.TotalSeconds;
        bool done = _anim switch
        {
            AnimPhase.Landing => t >= IconRenderer.LandSeconds,
            AnimPhase.Cancelling => t >= IconRenderer.CancelSeconds,
            // Plays to its end pose; if still pending after that, the tracer runs until it lands.
            AnimPhase.Disconnecting => t >= IconRenderer.DisconnectSeconds && _pending != OneShot.Disconnect,
            AnimPhase.Connecting => false,
            _ => true,
        };
        if (done) StopAnimation();
        else UpdateIcon();
    }

    private void UpdateIcon(bool force = false)
    {
        IntPtr icon, animIcon = IntPtr.Zero;
        if (_anim is AnimPhase phase && _iconSize > 0)
        {
            double t = _animClock.Elapsed.TotalSeconds;
            icon = animIcon = IconRenderer.CreateAnimFrame(phase, t, _tracerOffset + t, _lightTaskbar, _iconSize);
        }
        else
        {
            icon = _target?.Connected == true ? _iconOn : _iconOff;
        }
        string tip = StatusLine();
        if (tip.Length > 127) tip = tip[..127];
        if (!force && animIcon == IntPtr.Zero && icon == _shownIcon && tip == _shownTip) return;
        if (tip != _shownTip && _pending == null) Log.Info("tooltip: " + tip);
        var previousFrame = _lastAnimIcon;
        _lastAnimIcon = animIcon;
        _shownIcon = icon;
        _shownTip = tip;
        if (_iconAdded)
        {
            var nid = NewNid();
            nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
            nid.hIcon = icon;
            nid.szTip = tip;
            if (!Shell_NotifyIcon(NIM_MODIFY, ref nid))
                Log.Info("NIM_MODIFY failed");
        }
        // Animation frames are drawn per tick; free the previous one once the new one is in place.
        if (previousFrame != IntPtr.Zero) DestroyIcon(previousFrame);
    }

    private void AddIcon()
    {
        if (_iconAdded) return;
        UpdateIcon(); // computes _shownIcon/_shownTip
        var nid = NewNid();
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = _shownIcon;
        nid.szTip = _shownTip;
        if (!Shell_NotifyIcon(NIM_ADD, ref nid))
        {
            // Probably a stale icon from a previous session (or Explorer isn't ready yet at logon).
            Shell_NotifyIcon(NIM_DELETE, ref nid);
            if (!Shell_NotifyIcon(NIM_ADD, ref nid))
            {
                _addAttempts++;
                Log.Info($"NIM_ADD failed (attempt {_addAttempts}); retrying");
                if (_addAttempts < 60) SetTimer(_hwnd, TIMER_ADD_RETRY, 2000, IntPtr.Zero);
                return;
            }
        }
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIcon(NIM_SETVERSION, ref nid);
        _iconAdded = true;
        Log.Info($"tray icon added ({_iconSize} px, {(_lightTaskbar ? "light" : "dark")} taskbar)");
    }

    private void RemoveIcon()
    {
        if (!_iconAdded) return;
        var nid = NewNid();
        Shell_NotifyIcon(NIM_DELETE, ref nid);
        _iconAdded = false;
    }

    private NOTIFYICONDATA NewNid() => new()
    {
        cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = _hwnd,
        uID = Ipc.IconId,
        szTip = "",
        szInfo = "",
        szInfoTitle = "",
    };

    /// <summary>Small-icon size at the taskbar's DPI (16 px at 96 DPI).</summary>
    private static int CurrentIconSize()
    {
        uint dpi = 0;
        var tray = FindWindow("Shell_TrayWnd", null);
        if (tray != IntPtr.Zero) dpi = GetDpiForWindow(tray);
        if (dpi == 0) dpi = GetDpiForSystem();
        int size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
        return size > 0 ? size : 16;
    }

    private void CheckIconMetrics()
    {
        if (CurrentIconSize() != _iconSize) RebuildIcons();
    }

    private void RebuildIcons()
    {
        int size = CurrentIconSize();
        var on = IconRenderer.CreateIcon(IconState.Connected, _lightTaskbar, size);
        var off = IconRenderer.CreateIcon(IconState.Disconnected, _lightTaskbar, size);
        var old = new[] { _iconOn, _iconOff };
        bool rebuilt = _iconOn != IntPtr.Zero;
        (_iconOn, _iconOff, _iconSize) = (on, off, size);
        if (rebuilt) Log.Info($"icons rebuilt: {size} px, {(_lightTaskbar ? "light" : "dark")} taskbar");
        UpdateIcon(force: true); // the shell has the new icon before the old handles go
        foreach (var h in old)
            if (h != IntPtr.Zero) DestroyIcon(h);
    }

    // ------------------------------------------------------------------ menu

    private void ApplyMenuTheme()
    {
        try
        {
            SetPreferredAppMode(_lightTaskbar ? AppModeForceLight : AppModeForceDark);
            AllowDarkModeForWindow(_hwnd, !_lightTaskbar);
            FlushMenuThemes();
        }
        catch (Exception ex)
        {
            Log.Info("dark menu support unavailable: " + ex.Message);
        }
    }

    private void ShowMenu(int x, int y)
    {
        var menu = CreatePopupMenu();
        try
        {
            MaybeScanBattery(TimeSpan.FromSeconds(60)); // refreshes the tooltip if the reading is a bit old
            AppendMenu(menu, MF_STRING | MF_GRAYED, 9, StatusLine());
            AppendMenu(menu, MF_SEPARATOR, 0, null);

            if (_pending != null)
                AppendMenu(menu, MF_STRING | MF_GRAYED, 0, StatusText());
            else if (_target == null)
                AppendMenu(menu, MF_STRING | MF_GRAYED, 0, "Connect");
            else if (_target.Connected)
                AppendMenu(menu, MF_STRING, CMD_DISCONNECT, "Disconnect");
            else
                AppendMenu(menu, MF_STRING, CMD_CONNECT, "Connect");

            var sub = CreatePopupMenu();
            _menuDevices = _devices.ToList();
            for (int i = 0; i < _menuDevices.Count; i++)
            {
                var d = _menuDevices[i];
                bool isTarget = _target != null && d.ContainerId == _target.ContainerId;
                AppendMenu(sub, MF_STRING | (isTarget ? MF_CHECKED : 0), CMD_DEVICE_BASE + i,
                    d.Name + (d.Connected ? "  (connected)" : ""));
            }
            if (_target == null && _settings.HasTarget)
                AppendMenu(sub, MF_STRING | MF_GRAYED | MF_CHECKED, 0, $"{_settings.TargetName ?? "Saved device"} (not available)");
            if (_menuDevices.Count == 0 && !(_target == null && _settings.HasTarget))
                AppendMenu(sub, MF_STRING | MF_GRAYED, 0, "No Bluetooth audio devices");
            AppendMenu(menu, MF_POPUP | (_pending != null ? MF_GRAYED : 0), sub, "Device");

            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING | (Autostart.IsEnabled() ? MF_CHECKED : 0), CMD_AUTOSTART, "Start with Windows");
            AppendMenu(menu, MF_STRING, CMD_EXIT, "Exit");

            SetForegroundWindow(_hwnd); // so the menu closes when clicking elsewhere
            int cmd = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, x, y, _hwnd, IntPtr.Zero);
            PostMessage(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
            OnMenuCommand(cmd);
        }
        finally
        {
            DestroyMenu(menu); // also destroys the submenu
        }
    }

    private void OnMenuCommand(int cmd)
    {
        switch (cmd)
        {
            case 0: return;
            case CMD_CONNECT: StartAction(OneShot.Connect, "menu"); return;
            case CMD_DISCONNECT: StartAction(OneShot.Disconnect, "menu"); return;
            case CMD_AUTOSTART:
                if (Autostart.IsEnabled()) Autostart.Disable(); else Autostart.Enable();
                return;
            case CMD_EXIT: DestroyWindow(_hwnd); return;
        }
        int index = cmd - CMD_DEVICE_BASE;
        if (index >= 0 && index < _menuDevices.Count && _pending == null)
        {
            var d = _menuDevices[index];
            _settings.SetTarget(d);
            _settings.Save();
            Log.Info($"target set: {d.Name} {d.ContainerId:B} MAC {d.Mac}");
            _target = d;
            UpdateIcon();
            RequestRefresh();
        }
    }

    // ------------------------------------------------------------------ overflow promotion

    /// <summary>
    /// New tray icons land in the overflow on Windows 11. Once (first run only) mark our own
    /// NotifyIconSettings entry as promoted; after that the user's choice is left alone.
    /// </summary>
    private void TryPromoteOnce()
    {
        _promoteAttempts++;
        var result = TrayPromotion.PromoteSelf();
        Log.Info($"tray promotion attempt {_promoteAttempts}: {result}");
        if (result == TrayPromotion.Result.EntryNotFound && _promoteAttempts < 10)
        {
            SetTimer(_hwnd, TIMER_PROMOTE, 3000, IntPtr.Zero);
            return;
        }
        _settings.TrayPromotedOnce = true;
        _settings.Save();
    }

    // ------------------------------------------------------------------ UI synchronization context

    /// <summary>Lets <c>await</c> continuations resume on the UI thread via PostMessage.</summary>
    private sealed class UiContext(IntPtr hwnd) : SynchronizationContext
    {
        private readonly ConcurrentQueue<(SendOrPostCallback, object?)> _queue = new();

        public override void Post(SendOrPostCallback d, object? state)
        {
            _queue.Enqueue((d, state));
            PostMessage(hwnd, WM_APP_INVOKE, IntPtr.Zero, IntPtr.Zero);
        }

        public override void Send(SendOrPostCallback d, object? state) => throw new NotSupportedException();

        public override SynchronizationContext CreateCopy() => this;

        public void Drain()
        {
            while (_queue.TryDequeue(out var item))
            {
                try { item.Item1(item.Item2); }
                catch (Exception ex) { Log.Error("ui callback", ex); }
            }
        }
    }
}
