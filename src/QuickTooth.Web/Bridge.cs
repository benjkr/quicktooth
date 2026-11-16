using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using System.Text.Json;

namespace QuickTooth.Web;

/// <summary>
/// What the simulator page provides (sim/web/core.js registers these as module "qt-host"). Each call
/// carries the JS host object of the app instance making it, so work left over from an app that
/// was restarted still lands on its own (stopped) timers, as it would in a real process that exited.
/// </summary>
internal static partial class HostJs
{
    private const string M = "qt-host";

    [JSImport("exePath", M)] internal static partial string ExePath([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("nowMs", M)] internal static partial double NowMs([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("nowEpochMs", M)] internal static partial double NowEpochMs([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("delay", M)] internal static partial Task Delay([JSMarshalAs<JSType.Object>] JSObject h, int ms);
    [JSImport("setTimer", M)] internal static partial void SetTimer([JSMarshalAs<JSType.Object>] JSObject h, int id, int ms);
    [JSImport("killTimer", M)] internal static partial void KillTimer([JSMarshalAs<JSType.Object>] JSObject h, int id);
    [JSImport("killAllTimers", M)] internal static partial void KillAllTimers([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("lightTaskbar", M)] internal static partial bool LightTaskbar([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("iconSize", M)] internal static partial int IconSize([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("addIcon", M)] internal static partial bool AddIcon([JSMarshalAs<JSType.Object>] JSObject h, byte[] rgba, int size, string tip, string descJson);
    [JSImport("modifyIcon", M)] internal static partial bool ModifyIcon([JSMarshalAs<JSType.Object>] JSObject h, byte[] rgba, int size, string tip, string descJson);
    [JSImport("removeIcon", M)] internal static partial void RemoveIcon([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("cursorPos", M)] internal static partial string CursorPos([JSMarshalAs<JSType.Object>] JSObject h);     // "x,y" or ""
    [JSImport("iconAnchor", M)] internal static partial string IconAnchor([JSMarshalAs<JSType.Object>] JSObject h);   // "x,y" or ""
    [JSImport("trackPopupMenu", M)] internal static partial Task<int> TrackPopupMenu([JSMarshalAs<JSType.Object>] JSObject h, string itemsJson, int x, int y, bool light);
    [JSImport("endMenu", M)] internal static partial void EndMenu([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("promoteSelf", M)] internal static partial string PromoteSelf([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("autostartEnabled", M)] internal static partial bool AutostartEnabled([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("setAutostart", M)] internal static partial void SetAutostart([JSMarshalAs<JSType.Object>] JSObject h, bool on);
    [JSImport("exitApp", M)] internal static partial void ExitApp([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("emit", M)] internal static partial void Emit([JSMarshalAs<JSType.Object>] JSObject h, string json);
    [JSImport("log", M)] internal static partial void Log(string line);
    [JSImport("saveSettings", M)] internal static partial void SaveSettings(string json);

    // The mock Bluetooth stack (sim/web/bluetooth.js), behind the app's device worker.
    [JSImport("btRegister", M)] internal static partial Task BtRegister([JSMarshalAs<JSType.Object>] JSObject h);
    [JSImport("btRefresh", M)] internal static partial Task<string> BtRefresh([JSMarshalAs<JSType.Object>] JSObject h, string mac);   // "" = no target MAC
    [JSImport("btSend", M)] internal static partial Task<string> BtSend([JSMarshalAs<JSType.Object>] JSObject h, string containerId, string op);
    [JSImport("btConnected", M)] internal static partial Task<int> BtConnected([JSMarshalAs<JSType.Object>] JSObject h, string mac); // -1 unknown, 0, 1
    [JSImport("btScan", M)] internal static partial Task<string> BtScan([JSMarshalAs<JSType.Object>] JSObject h, int model, int windowMs); // JSON or "null"
}

/// <summary>What the simulator page calls: the shared renderer, tunables, and tray app instances.</summary>
public static partial class Bridge
{
    private static readonly Dictionary<int, (TrayController App, WebDevices Devices)> s_apps = new();
    private static int s_nextId;

    /// <summary>Wires the shared code's logging and settings to the page; call once after loading.</summary>
    [JSExport] internal static void Init()
    {
        InlineContext.Install();
        QuickTooth.Log.Sink = HostJs.Log;
        Settings.SaveHandler = s => HostJs.SaveSettings(s.ToJson());
    }

    // ---- tunables and glyphs
    [JSExport] internal static string Tunables() => QuickTooth.Tunables.ToJson();
    [JSExport] internal static bool SetTunable(string name, double value) => QuickTooth.Tunables.Set(name, value);
    [JSExport] internal static void ResetTunables() => QuickTooth.Tunables.ResetAll();
    [JSExport] internal static void SetGlyphs(string? fillSvg, string? lineSvg) => IconRenderer.SetGlyphs(fillSvg, lineSvg);

    // ---- renderer (RGBA, straight alpha, for ImageData)
    /// <param name="state">"connected", "disconnected" or "lowBattery".</param>
    [JSExport] internal static byte[] RenderStatic(string state, bool light, int size) =>
        ToRgba(IconRenderer.RenderBgra(Enum.Parse<IconState>(state, ignoreCase: true), light, size));

    [JSExport] internal static byte[] RenderAnim(string phase, double t, double tracerT, bool light, int size) =>
        ToRgba(IconRenderer.RenderAnim(Enum.Parse<AnimPhase>(phase), t, tracerT, light, size));

    [JSExport] internal static bool PhaseDone(string phase, double t, bool stillPendingDisconnect) =>
        IconRenderer.PhaseDone(Enum.Parse<AnimPhase>(phase), t, stillPendingDisconnect);

    internal static byte[] ToRgba(byte[] bgra)
    {
        var rgba = new byte[bgra.Length];
        for (int i = 0; i < bgra.Length; i += 4)
        {
            rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3];
        }
        return rgba;
    }

    // ---- tray app instances (a restart creates a new one; the old one keeps its ID)

    /// <summary>Creates an app driven by <paramref name="host"/> (the page's TrayAppModel); returns its ID.</summary>
    [JSExport] internal static int AppCreate([JSMarshalAs<JSType.Object>] JSObject host, string settingsJson)
    {
        InlineContext.Install();
        var devices = new WebDevices(host);
        int id = ++s_nextId;
        s_apps[id] = (new TrayController(new WebHost(host), devices, Settings.FromJson(settingsJson)), devices);
        return id;
    }

    private static TrayController App(int id)
    {
        InlineContext.Install();
        return s_apps.TryGetValue(id, out var a) ? a.App : throw new InvalidOperationException($"no app {id}");
    }

    [JSExport] internal static void AppStart(int id) => App(id).Start();
    [JSExport] internal static void AppExit(int id) => App(id).Exit();
    [JSExport] internal static bool AppRunning(int id) => s_apps.TryGetValue(id, out var a) && a.App.Running;
    [JSExport] internal static void AppTrayEvent(int id, string ev, int x, int y) => App(id).OnTrayEvent(ev, x, y);
    [JSExport] internal static void AppCommand(int id, int cmd) => App(id).OnCommand(cmd);
    [JSExport] internal static void AppTimer(int id, int timer) => App(id).OnTimer(timer);
    [JSExport] internal static void AppSettingChange(int id, string? area) => App(id).OnSettingChange(area);
    [JSExport] internal static void AppDisplayChange(int id) => App(id).OnDisplayChange();
    [JSExport] internal static void AppTaskbarCreated(int id) => App(id).OnTaskbarCreated();
    [JSExport] internal static void AppEndpointChanged(int id) { App(id); s_apps[id].Devices.Raise(); }
    [JSExport] internal static void AppRebuildIcons(int id) => App(id).RebuildIconsNow();
    [JSExport] internal static string AppSnapshot(int id) => App(id).SnapshotJson();
    [JSExport] internal static string AppStatusLine(int id) => App(id).StatusLine();
}

/// <summary><see cref="ITrayHost"/> on the simulator page.</summary>
internal sealed class WebHost(JSObject h) : ITrayHost
{
    public string ExePath => HostJs.ExePath(h);
    public double NowMs => HostJs.NowMs(h);
    public DateTime Now => DateTime.UnixEpoch.AddMilliseconds(HostJs.NowEpochMs(h));
    public Task Delay(int ms) => HostJs.Delay(h, ms);
    public void SetTimer(int id, int ms) => HostJs.SetTimer(h, id, ms);
    public void KillTimer(int id) => HostJs.KillTimer(h, id);
    public void KillAllTimers() => HostJs.KillAllTimers(h);

    public bool LightTaskbar => HostJs.LightTaskbar(h);
    public int IconSize => HostJs.IconSize(h);
    public void ApplyMenuTheme(bool light) { } // the mock menu reads the theme when it opens
    public bool AddIcon(IconImage icon, string tip) => HostJs.AddIcon(h, Bridge.ToRgba(icon.Bgra), icon.Size, tip, icon.DescJson);
    public bool ModifyIcon(IconImage icon, string tip) => HostJs.ModifyIcon(h, Bridge.ToRgba(icon.Bgra), icon.Size, tip, icon.DescJson);
    public void RemoveIcon() => HostJs.RemoveIcon(h);
    public void ReleaseIcon(IconImage icon) { }
    public (int X, int Y)? CursorPos() => Point(HostJs.CursorPos(h));
    public (int X, int Y)? IconAnchor() => Point(HostJs.IconAnchor(h));

    private static (int X, int Y)? Point(string xy)
    {
        var parts = xy.Split(',');
        return parts.Length == 2 ? (int.Parse(parts[0], CultureInfo.InvariantCulture), int.Parse(parts[1], CultureInfo.InvariantCulture)) : null;
    }

    public Task<int> TrackPopupMenu(IReadOnlyList<MenuItem> items, int x, int y, bool light) =>
        HostJs.TrackPopupMenu(h, MenuJson(items), x, y, light);

    /// <summary>The menu as the mock shell takes it: [{id,text,grayed,checked} | {separator} | {text,grayed,submenu}].</summary>
    private static string MenuJson(IReadOnlyList<MenuItem> items)
    {
        var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer)) Write(w, items);
        return Encoding.UTF8.GetString(buffer.ToArray());

        static void Write(Utf8JsonWriter w, IReadOnlyList<MenuItem> list)
        {
            w.WriteStartArray();
            foreach (var item in list)
            {
                w.WriteStartObject();
                if (item.Separator)
                {
                    w.WriteBoolean("separator", true);
                }
                else
                {
                    if (item.Submenu == null) w.WriteNumber("id", item.Id);
                    w.WriteString("text", item.Text);
                    if (item.Grayed || item.Submenu != null) w.WriteBoolean("grayed", item.Grayed);
                    // Checkable items (devices, Start with Windows) always say whether they're checked.
                    bool checkable = item.Id == TrayController.CMD_AUTOSTART || item.Id >= TrayController.CMD_DEVICE_BASE;
                    if (item.Checked || checkable) w.WriteBoolean("checked", item.Checked);
                    if (item.Submenu is { } sub)
                    {
                        w.WritePropertyName("submenu");
                        Write(w, sub);
                    }
                }
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }
    }

    public void EndMenu() => HostJs.EndMenu(h);
    public string PromoteSelf() => HostJs.PromoteSelf(h);
    public bool AutostartEnabled => HostJs.AutostartEnabled(h);
    public void SetAutostart(bool on) => HostJs.SetAutostart(h, on);
    public void Exit() => HostJs.ExitApp(h);
    public void Emit(string json) => HostJs.Emit(h, json);
}

/// <summary><see cref="IDeviceBackend"/> on the simulator's mock Bluetooth stack.</summary>
internal sealed class WebDevices(JSObject h) : IDeviceBackend
{
    public event Action? EndpointChanged;
    public void Raise() => EndpointChanged?.Invoke();

    public Task RegisterNotifications() => HostJs.BtRegister(h);

    public async Task<(Snapshot Snap, int? WindowsBattery)> Refresh(string? mac)
    {
        using var doc = JsonDocument.Parse(await HostJs.BtRefresh(h, mac ?? ""));
        var root = doc.RootElement;
        var devices = new List<BtDevice>();
        foreach (var d in root.GetProperty("devices").EnumerateArray())
        {
            var container = Guid.Parse(d.GetProperty("containerId").GetString()!);
            string? devMac = d.TryGetProperty("mac", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
            var endpoints = new List<BtEndpoint>();
            foreach (var e in d.GetProperty("endpoints").EnumerateArray())
            {
                string bth = e.GetProperty("bthDeviceId").GetString()!;
                endpoints.Add(new BtEndpoint(bth, e.GetProperty("name").GetString()!, null, e.GetProperty("state").GetUInt32(),
                    bth, container, devMac, e.TryGetProperty("hidden", out var h) && h.GetBoolean(), int.MinValue));
            }
            devices.Add(new BtDevice(container, d.GetProperty("name").GetString()!, devMac, endpoints));
        }
        var wb = root.GetProperty("windowsBattery");
        return (new Snapshot { Devices = devices }, wb.ValueKind == JsonValueKind.Number ? wb.GetInt32() : null);
    }

    public async Task<IReadOnlyList<SendResult>> SendOneShot(Guid containerId, OneShot op)
    {
        using var doc = JsonDocument.Parse(await HostJs.BtSend(h, containerId.ToString("B"), op.ToString()));
        var results = doc.RootElement.EnumerateArray()
            .Select(r => new SendResult(r.GetProperty("endpointName").GetString()!, r.GetProperty("bthDeviceId").GetString()!, r.GetProperty("hr").GetInt32(), 0))
            .ToList();
        SendLog.Write(containerId, op, results);
        return results;
    }

    public async Task<bool?> BluetoothConnected(string mac) => await HostJs.BtConnected(h, mac) switch { 1 => true, 0 => false, _ => null };

    public async Task<BatteryReading?> ScanBattery(ushort model, TimeSpan window)
    {
        string json = await HostJs.BtScan(h, model, (int)window.TotalMilliseconds);
        using var doc = JsonDocument.Parse(json);
        var r = doc.RootElement;
        if (r.ValueKind != JsonValueKind.Object) return null;
        static int? Level(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
        static bool Flag(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        return new BatteryReading(Level(r, "left"), Level(r, "right"), Level(r, "case"), Flag(r, "budsCharging"), Flag(r, "caseCharging"),
            Level(r, "rssi") ?? 0, DateTime.UnixEpoch.AddMilliseconds(HostJs.NowEpochMs(h)), r.GetProperty("source").GetString() ?? "ble");
    }
}
