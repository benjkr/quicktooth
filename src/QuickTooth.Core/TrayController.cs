using System.Globalization;
using System.Text;
using System.Text.Json;

namespace QuickTooth;

/// <summary>
/// The tray icon's behaviour, shared by the native app and the browser simulator: the
/// connect/disconnect state machine (link-teardown wait, 8 s resend, 20 s timeout), the pending
/// animation, tooltip text, battery readings and the popup menu's contents. The platform comes in
/// through <see cref="ITrayHost"/> (window, timers, icon, menu) and <see cref="IDeviceBackend"/>
/// (Bluetooth). Single-threaded: every call and await continuation runs on the host's UI thread.
/// </summary>
internal sealed class TrayController
{
    public const int TIMER_ANIM = 1, TIMER_TIMEOUT = 2, TIMER_POLL = 3, TIMER_DEBOUNCE = 4,
        TIMER_FASTPOLL = 5, TIMER_ADD_RETRY = 6, TIMER_PROMOTE = 7, TIMER_RESEND = 8, TIMER_BATTERY = 9,
        TIMER_LOWBATTERY = 10;
    public static readonly int[] AllTimers = [TIMER_ANIM, TIMER_TIMEOUT, TIMER_POLL, TIMER_DEBOUNCE,
        TIMER_FASTPOLL, TIMER_ADD_RETRY, TIMER_PROMOTE, TIMER_RESEND, TIMER_BATTERY, TIMER_LOWBATTERY];

    public const int CMD_CONNECT = 1, CMD_DISCONNECT = 2, CMD_AUTOSTART = 3, CMD_EXIT = 4, CMD_STATUS = 9, CMD_DEVICE_BASE = 100;

    private readonly ITrayHost _host;
    private readonly IDeviceBackend _devices;
    private readonly Settings _settings;

    private bool _running;
    private IReadOnlyList<BtDevice> _deviceList = [];
    private BtDevice? _target;
    private bool _haveSnapshot;
    private string? _lastStateLog;

    private OneShot? _pending;
    private int _pendingSeq;
    private Guid _pendingContainer;
    private double _pendingStart;
    private AnimPhase? _anim;                // pending animation phase (see IconRenderer)
    private double _animStart;               // when the phase started (host ms)
    private double _tracerOffset;            // tracer time carried into the phase
    private IconImage? _lastAnimIcon;        // last live-rendered frame (released when replaced)
    private int _animFrames;

    private bool _refreshing, _refreshAgain;

    private BatteryReading? _battery;
    private Guid _batteryContainer;
    private bool _batteryScanning, _wasConnected;

    private bool _iconAdded;
    private int _addAttempts;
    private int _promoteAttempts;
    private int _iconSize;
    private bool _lightTaskbar;
    private IconImage? _iconOn, _iconOff, _iconLow, _shownIcon;
    private bool _lowShown;                  // the static icon last chosen was the low-battery one
    private string _shownTip = "";

    private List<BtDevice> _menuDevices = [];

    public TrayController(ITrayHost host, IDeviceBackend devices, Settings settings)
    {
        _host = host;
        _devices = devices;
        _settings = settings;
    }

    public bool Running => _running;
    private double PendingMs => _host.NowMs - _pendingStart;
    private double AnimSeconds => (_host.NowMs - _animStart) / 1000.0;

    // ------------------------------------------------------------------ lifetime

    public void Start()
    {
        _running = true;
        Log.Info($"tray start: {_host.ExePath}");
        _lightTaskbar = _host.LightTaskbar;
        _host.ApplyMenuTheme(_lightTaskbar);
        RebuildIcons();
        AddIcon();

        _devices.EndpointChanged += OnEndpointChanged;
        _ = RegisterNotificationsAsync();
        RequestRefresh();
        _host.SetTimer(TIMER_POLL, Tunables.IdlePollMs);
        _host.SetTimer(TIMER_BATTERY, Tunables.BatteryCheckMs);
        if (!_settings.TrayPromotedOnce) _host.SetTimer(TIMER_PROMOTE, Tunables.PromoteRetryMs);
    }

    private async Task RegisterNotificationsAsync()
    {
        try { await _devices.RegisterNotifications(); }
        catch (Exception ex) { Log.Error("register notifications", ex); }
    }

    /// <summary>Exit from the menu or QuickTooth.exe --exit; also the window being destroyed.</summary>
    public void Exit()
    {
        if (!_running) return;
        RemoveIcon();
        _host.EndMenu();
        _host.KillAllTimers();
        _devices.EndpointChanged -= OnEndpointChanged;
        _running = false;
        Log.Info("tray exit");
        Emit("{\"type\":\"exit\"}");
        _host.Exit();
    }

    // ------------------------------------------------------------------ host events

    /// <summary>A notification-area event: left click (select), keyboard select, or right click (context menu at x,y).</summary>
    public void OnTrayEvent(string ev, int x, int y)
    {
        if (!_running) return;
        switch (ev)
        {
            case "select":
            case "keyselect":
                Toggle(ev == "select" ? "click" : "key");
                break;
            case "contextmenu":
                _ = ShowMenu(x, y);
                break;
        }
    }

    /// <summary>A command from another QuickTooth.exe (--toggle, --connect, …).</summary>
    public void OnCommand(int cmd)
    {
        if (!_running) return;
        switch (cmd)
        {
            case TrayCommands.Toggle: Toggle("cli"); break;
            case TrayCommands.Connect: _ = StartAction(OneShot.Connect, "cli"); break;
            case TrayCommands.Disconnect: _ = StartAction(OneShot.Disconnect, "cli"); break;
            case TrayCommands.Exit: Exit(); break;
            case TrayCommands.ShowMenu:
                if (_host.IconAnchor() is var (x, y)) _ = ShowMenu(x, y);
                break;
            case TrayCommands.CloseMenu: _host.EndMenu(); break;
        }
    }

    public void OnTimer(int id)
    {
        if (!_running) return;
        switch (id)
        {
            case TIMER_ANIM:
                AdvanceAnimation();
                break;
            case TIMER_TIMEOUT:
                Log.Info($"{_pending} timed out after {(long)PendingMs} ms; showing the real state");
                EndPending();
                RequestRefresh();
                break;
            case TIMER_FASTPOLL:
            case TIMER_POLL:
                RequestRefresh();
                if (id == TIMER_POLL) CheckIconMetrics();
                break;
            case TIMER_DEBOUNCE:
                _host.KillTimer(TIMER_DEBOUNCE);
                RequestRefresh();
                break;
            case TIMER_ADD_RETRY:
                _host.KillTimer(TIMER_ADD_RETRY);
                AddIcon();
                break;
            case TIMER_PROMOTE:
                _host.KillTimer(TIMER_PROMOTE);
                TryPromoteOnce();
                break;
            case TIMER_RESEND:
                _host.KillTimer(TIMER_RESEND);
                _ = ResendConnect();
                break;
            case TIMER_LOWBATTERY: // the next ripple, while the dot shows and nothing else animates
                if (_anim == null && _pending == null && _lowShown) StartAnimation(AnimPhase.LowBattery);
                break;
            case TIMER_BATTERY:
                _host.SetTimer(TIMER_BATTERY, Tunables.BatteryCheckMs); // back to the periodic check
                _ = MaybeScanBattery(TimeSpan.FromMinutes(Tunables.BatteryMaxAgeMin));
                break;
        }
    }

    /// <summary>An audio endpoint changed (any thread on Windows: the host marshals it to the UI thread first).</summary>
    public void OnEndpointChangedOnUiThread()
    {
        if (_running) _host.SetTimer(TIMER_DEBOUNCE, Tunables.DebounceMs);
    }

    private Action? _endpointChangedHandler;

    /// <summary>
    /// Hosts whose backend raises EndpointChanged off the UI thread set this to marshal the call
    /// (the native host posts a window message). Default: handle it directly.
    /// </summary>
    public Action? EndpointChangedDispatcher { get => _endpointChangedHandler; set => _endpointChangedHandler = value; }

    private void OnEndpointChanged()
    {
        if (_endpointChangedHandler is { } dispatch) dispatch();
        else OnEndpointChangedOnUiThread();
    }

    /// <summary>WM_SETTINGCHANGE: "ImmersiveColorSet" means the taskbar theme may have flipped.</summary>
    public void OnSettingChange(string? area)
    {
        if (!_running) return;
        if (area == "ImmersiveColorSet")
        {
            bool light = _host.LightTaskbar;
            if (light != _lightTaskbar)
            {
                Log.Info($"taskbar theme -> {(light ? "light" : "dark")}");
                _lightTaskbar = light;
                _host.ApplyMenuTheme(light);
                RebuildIcons();
            }
        }
        else
        {
            CheckIconMetrics();
        }
    }

    /// <summary>WM_DISPLAYCHANGE / WM_DPICHANGED.</summary>
    public void OnDisplayChange()
    {
        if (_running) CheckIconMetrics();
    }

    /// <summary>"TaskbarCreated": Explorer restarted, so the icon has to be added again.</summary>
    public void OnTaskbarCreated()
    {
        if (!_running) return;
        Log.Info("TaskbarCreated: re-adding icon");
        _iconAdded = false;
        _addAttempts = 0;
        RebuildIcons();
        AddIcon();
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
                var (snap, windowsBattery) = await _devices.Refresh(_target?.Mac);
                if (!_running) return;
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
        _deviceList = snap.Devices;
        _haveSnapshot = true;
        _target = _settings.ResolveOrDefault(_deviceList, persist: true);

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
                _battery = new BatteryReading(level, null, null, false, false, 0, _host.Now, "windows");
                _batteryContainer = _target!.ContainerId;
            }
            if (!_wasConnected) _host.SetTimer(TIMER_BATTERY, Tunables.FirstBatteryMs); // first reading soon after connecting
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
            double ms = PendingMs;
            Log.Info($"{op} confirmed after {(long)ms} ms");
            Emit($"{{\"type\":\"confirmed\",\"op\":\"{op}\",\"ms\":{Num(ms)}}}");
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
            if (source != "cli" && _host.CursorPos() is var (x, y)) _ = ShowMenu(x, y);
            return;
        }
        _ = StartAction(_target.Connected ? OneShot.Disconnect : OneShot.Connect, source);
    }

    private async Task StartAction(OneShot op, string source)
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
            _pendingStart = _host.NowMs;
            StartAnimation(op == OneShot.Connect ? AnimPhase.Connecting : AnimPhase.Disconnecting);
            Log.Info($"{source}: {op} '{target.Name}' {target.ContainerId:B} (was {target.StateSignature})");
            Emit($"{{\"type\":\"start\",\"op\":\"{op}\",\"source\":\"{source}\"}}");
            UpdateIcon();

            if (op == OneShot.Connect && target.Mac is string mac)
            {
                // After a disconnect the Bluetooth link lingers ~3 s; a reconnect sent into that teardown
                // can stall for 15 s+. Wait (still animating) until the link has closed.
                double holdStart = _host.NowMs;
                while (_host.NowMs - holdStart < Tunables.LinkTeardownWaitMs
                       && await _devices.BluetoothConnected(mac) == true)
                    await _host.Delay(Tunables.TeardownPollMs);
                if (seq != _pendingSeq || _pending != op) return;
                double held = _host.NowMs - holdStart;
                if (held > Tunables.TeardownLogAboveMs) Log.Info($"waited {(long)held} ms for the previous link to close");
            }

            _host.SetTimer(TIMER_TIMEOUT, Tunables.PendingTimeoutMs);
            _host.SetTimer(TIMER_FASTPOLL, Tunables.PendingPollMs); // notifications may not fire for hidden endpoints
            if (op == OneShot.Connect) _host.SetTimer(TIMER_RESEND, Tunables.ResendAfterMs);

            // A2DP *and* Hands-Free controls: kicking only A2DP leaves Windows waiting for the
            // headset to bring up Hands-Free, which measured 15–40 s+ instead of ~1–3 s.
            var results = await _devices.SendOneShot(target.ContainerId, op);
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
        double t = AnimSeconds;
        if (op == OneShot.Connect && _anim == AnimPhase.Connecting)
            StartAnimation(succeeded ? AnimPhase.Landing : AnimPhase.Cancelling, tracerOffset: _tracerOffset + t);
        else if (op == OneShot.Disconnect && _anim == AnimPhase.Disconnecting && succeeded)
            { /* keeps playing; AdvanceAnimation stops it at its end pose */ }
        else
            StopAnimation();
        _host.KillTimer(TIMER_TIMEOUT);
        _host.KillTimer(TIMER_FASTPOLL);
        _host.KillTimer(TIMER_RESEND);
        Emit($"{{\"type\":\"end\",\"op\":{(op is OneShot o ? $"\"{o}\"" : "null")},\"succeeded\":{(succeeded ? "true" : "false")}}}");
        UpdateIcon();
    }

    /// <summary>One safety-net resend if a reconnect hasn't landed after <see cref="Tunables.ResendAfterMs"/>.</summary>
    private async Task ResendConnect()
    {
        if (_pending != OneShot.Connect) return;
        var container = _pendingContainer;
        Log.Info($"Connect not confirmed after {(long)PendingMs} ms; resending once");
        Emit("{\"type\":\"resend\"}");
        try { await _devices.SendOneShot(container, OneShot.Connect); }
        catch (Exception ex) { Log.Error("resend", ex); }
        RequestRefresh();
    }

    // ------------------------------------------------------------------ text

    public string StatusText()
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
        if (_batteryContainer != _target.ContainerId || _host.Now - _battery.At > TimeSpan.FromMinutes(Tunables.BatteryShowAgeMin)) return null;
        return _battery.Text;
    }

    /// <summary>The tooltip shows a battery reading, the buds are at or below the low mark and not charging.</summary>
    private bool LowBattery() =>
        BatteryText() != null && !_battery!.BudsCharging && _battery.Buds is int level && level <= Tunables.LowBatteryPercent;

    /// <summary>Tooltip and menu header, e.g. "AirPods Pro — Connected · 30%".</summary>
    public string StatusLine() =>
        BatteryText() is string battery ? $"{DeviceLabel()} — {StatusText()} · {battery}" : $"{DeviceLabel()} — {StatusText()}";

    /// <summary>Reads AirPods battery from their BLE status advert (Windows doesn't expose it for AirPods).</summary>
    private async Task MaybeScanBattery(TimeSpan maxAge)
    {
        var target = _target;
        if (_batteryScanning || _pending != null || target?.Connected != true) return;
        if (_battery != null && _batteryContainer == target.ContainerId &&
            (_battery.Source == "windows" || _host.Now - _battery.At < maxAge)) return;
        if (AppleStatusAdvert.ModelOf(target) is not ushort model) return;
        _batteryScanning = true;
        try
        {
            var reading = await _devices.ScanBattery(model, TimeSpan.FromSeconds(Tunables.BleScanSeconds));
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
        _animStart = _host.NowMs;
        _host.SetTimer(TIMER_ANIM, Tunables.AnimFrameMs);
        Emit($"{{\"type\":\"anim\",\"phase\":\"{phase}\"}}");
        UpdateIcon();
    }

    private void StopAnimation()
    {
        _anim = null;
        _host.KillTimer(TIMER_ANIM);
        Emit("{\"type\":\"anim\",\"phase\":null}");
        UpdateIcon();
    }

    private void AdvanceAnimation()
    {
        if (_anim is not AnimPhase phase) { StopAnimation(); return; }
        if (IconRenderer.PhaseDone(phase, AnimSeconds, _pending == OneShot.Disconnect)) StopAnimation();
        else UpdateIcon();
    }

    // ------------------------------------------------------------------ notify icon

    private void UpdateIcon(bool force = false)
    {
        IconImage? icon, animIcon = null;
        if (_anim is AnimPhase phase && _iconSize > 0)
        {
            double t = AnimSeconds, tracerT = _tracerOffset + t;
            string desc = $"{{\"kind\":\"anim\",\"phase\":\"{phase}\",\"t\":{Num(Round4(t))},\"tracerT\":{Num(Round4(tracerT))}}}";
            icon = animIcon = new IconImage(IconRenderer.RenderAnim(phase, t, tracerT, _lightTaskbar, _iconSize), _iconSize, desc);
            _animFrames++;
        }
        else
        {
            bool low = _target?.Connected == true && LowBattery();
            if (low != _lowShown)
            {
                _lowShown = low;
                if (low) _host.SetTimer(TIMER_LOWBATTERY, Tunables.LowBatteryReplayMs);
                else _host.KillTimer(TIMER_LOWBATTERY);
                if (low && _iconSize > 0) { StartAnimation(AnimPhase.LowBattery); return; } // the first ripple
            }
            icon = _target?.Connected != true ? _iconOff : low ? _iconLow : _iconOn;
        }
        if (icon == null) return;
        string tip = StatusLine();
        if (tip.Length > Tunables.TooltipMaxChars) tip = tip[..Tunables.TooltipMaxChars];
        if (!force && animIcon == null && icon == _shownIcon && tip == _shownTip) return;
        if (tip != _shownTip && _pending == null) Log.Info("tooltip: " + tip);
        var previousFrame = _lastAnimIcon;
        _lastAnimIcon = animIcon;
        _shownIcon = icon;
        _shownTip = tip;
        if (_iconAdded && !_host.ModifyIcon(icon, tip))
            Log.Info("NIM_MODIFY failed");
        // Animation frames are drawn per tick; release the previous one once the new one is in place.
        if (previousFrame != null) _host.ReleaseIcon(previousFrame);
    }

    private void AddIcon()
    {
        if (_iconAdded) return;
        UpdateIcon(); // computes _shownIcon/_shownTip
        if (_shownIcon == null || !_host.AddIcon(_shownIcon, _shownTip))
        {
            _addAttempts++;
            Log.Info($"NIM_ADD failed (attempt {_addAttempts}); retrying");
            if (_addAttempts < Tunables.AddMaxAttempts) _host.SetTimer(TIMER_ADD_RETRY, Tunables.AddRetryMs);
            return;
        }
        _iconAdded = true;
        Log.Info($"tray icon added ({_iconSize} px, {(_lightTaskbar ? "light" : "dark")} taskbar)");
    }

    private void RemoveIcon()
    {
        if (!_iconAdded) return;
        _host.RemoveIcon();
        _iconAdded = false;
    }

    private void CheckIconMetrics()
    {
        if (_host.IconSize != _iconSize) RebuildIcons();
    }

    /// <summary>Redraws the static icons (the simulator after a --tune change).</summary>
    public void RebuildIconsNow()
    {
        if (_running) RebuildIcons();
    }

    private void RebuildIcons()
    {
        int size = _host.IconSize;
        var on = new IconImage(IconRenderer.RenderBgra(IconState.Connected, _lightTaskbar, size), size, "{\"kind\":\"static\",\"state\":\"connected\"}");
        var off = new IconImage(IconRenderer.RenderBgra(IconState.Disconnected, _lightTaskbar, size), size, "{\"kind\":\"static\",\"state\":\"disconnected\"}");
        var low = new IconImage(IconRenderer.RenderBgra(IconState.LowBattery, _lightTaskbar, size), size, "{\"kind\":\"static\",\"state\":\"connected\",\"lowBattery\":true}");
        var old = new[] { _iconOn, _iconOff, _iconLow };
        bool rebuilt = _iconOn != null;
        (_iconOn, _iconOff, _iconLow, _iconSize) = (on, off, low, size);
        if (rebuilt) Log.Info($"icons rebuilt: {size} px, {(_lightTaskbar ? "light" : "dark")} taskbar");
        UpdateIcon(force: true); // the shell has the new icon before the old one goes
        foreach (var img in old)
            if (img != null) _host.ReleaseIcon(img);
    }

    // ------------------------------------------------------------------ menu

    /// <summary>Builds the popup menu, shows it (modal on Windows), then runs the chosen command.</summary>
    private async Task ShowMenu(int x, int y)
    {
        _ = MaybeScanBattery(TimeSpan.FromSeconds(Tunables.MenuBatteryMaxAgeS)); // refreshes the tooltip if the reading is a bit old
        var items = new List<MenuItem>
        {
            new(CMD_STATUS, StatusLine(), Grayed: true),
            MenuItem.Divider,
        };

        if (_pending != null)
            items.Add(new(0, StatusText(), Grayed: true));
        else if (_target == null)
            items.Add(new(0, "Connect", Grayed: true));
        else if (_target.Connected)
            items.Add(new(CMD_DISCONNECT, "Disconnect"));
        else
            items.Add(new(CMD_CONNECT, "Connect"));

        var sub = new List<MenuItem>();
        _menuDevices = _deviceList.ToList();
        for (int i = 0; i < _menuDevices.Count; i++)
        {
            var d = _menuDevices[i];
            bool isTarget = _target != null && d.ContainerId == _target.ContainerId;
            sub.Add(new(CMD_DEVICE_BASE + i, d.Name + (d.Connected ? "  (connected)" : ""), Checked: isTarget));
        }
        if (_target == null && _settings.HasTarget)
            sub.Add(new(0, $"{_settings.TargetName ?? "Saved device"} (not available)", Grayed: true, Checked: true));
        if (_menuDevices.Count == 0 && !(_target == null && _settings.HasTarget))
            sub.Add(new(0, "No Bluetooth audio devices", Grayed: true));
        items.Add(new(0, "Device", Grayed: _pending != null, Submenu: sub));

        items.Add(MenuItem.Divider);
        items.Add(new(CMD_AUTOSTART, "Start with Windows", Checked: _host.AutostartEnabled));
        items.Add(new(CMD_EXIT, "Exit"));

        Emit("{\"type\":\"menu\",\"open\":true}");
        int cmd = await _host.TrackPopupMenu(items, x, y, _lightTaskbar);
        Emit($"{{\"type\":\"menu\",\"open\":false,\"cmd\":{cmd}}}");
        OnMenuCommand(cmd);
    }

    private void OnMenuCommand(int cmd)
    {
        switch (cmd)
        {
            case 0: return;
            case CMD_CONNECT: _ = StartAction(OneShot.Connect, "menu"); return;
            case CMD_DISCONNECT: _ = StartAction(OneShot.Disconnect, "menu"); return;
            case CMD_AUTOSTART: _host.SetAutostart(!_host.AutostartEnabled); return;
            case CMD_EXIT: Exit(); return;
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
        string result = _host.PromoteSelf();
        Log.Info($"tray promotion attempt {_promoteAttempts}: {result}");
        if (result == "EntryNotFound" && _promoteAttempts < Tunables.PromoteMaxAttempts)
        {
            _host.SetTimer(TIMER_PROMOTE, Tunables.PromoteRetryMs);
            return;
        }
        _settings.TrayPromotedOnce = true;
        _settings.Save();
    }

    // ------------------------------------------------------------------ introspection (simulator)

    /// <summary>The controller's state as JSON (the simulator adds its host-side parts: timers, autostart).</summary>
    public string SnapshotJson()
    {
        var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteBoolean("running", _running);
            if (_pending is OneShot p) w.WriteString("pending", p.ToString()); else w.WriteNull("pending");
            if (_anim is AnimPhase a)
            {
                w.WriteString("anim", a.ToString());
                w.WriteNumber("animT", Math.Round(AnimSeconds, 3, MidpointRounding.AwayFromZero));
            }
            else
            {
                w.WriteNull("anim");
                w.WriteNull("animT");
            }
            if (_target is { } t)
            {
                w.WriteStartObject("target");
                w.WriteString("name", t.Name);
                w.WriteBoolean("connected", t.Connected);
                w.WriteString("stateSignature", t.StateSignature);
                w.WriteEndObject();
            }
            else w.WriteNull("target");
            w.WriteBoolean("haveSnapshot", _haveSnapshot);
            w.WriteString("statusText", StatusText());
            w.WriteString("tooltip", _shownTip);
            if (_shownIcon != null)
            {
                w.WritePropertyName("icon");
                w.WriteRawValue(_shownIcon.DescJson);
            }
            else w.WriteNull("icon");
            w.WriteNumber("iconSize", _iconSize);
            if (_battery != null)
            {
                w.WriteStartObject("battery");
                if (_battery.Text is string bt) w.WriteString("text", bt); else w.WriteNull("text");
                w.WriteString("source", _battery.Source);
                w.WriteEndObject();
            }
            else w.WriteNull("battery");
            w.WriteStartObject("settings");
            if (_settings.TargetName is string tn) w.WriteString("targetName", tn); else w.WriteNull("targetName");
            w.WriteBoolean("trayPromotedOnce", _settings.TrayPromotedOnce);
            w.WriteEndObject();
            w.WriteNumber("animFrames", _animFrames);
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private void Emit(string json) => _host.Emit(json);

    private static double Round4(double v) => Math.Round(v, 4, MidpointRounding.AwayFromZero);

    private static string Num(double v) => v.ToString("R", CultureInfo.InvariantCulture);
}
