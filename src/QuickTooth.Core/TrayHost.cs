namespace QuickTooth;

/// <summary>
/// What the tray state machine needs from the platform. The native app implements it with a Win32
/// window, Shell_NotifyIcon, SetTimer and TrackPopupMenu; the browser simulator with its virtual
/// clock and mock taskbar. All calls happen on the host's UI thread.
/// </summary>
internal interface ITrayHost
{
    string ExePath { get; }

    // ---- time
    /// <summary>Monotonic milliseconds (Stopwatch on Windows, the virtual clock in the simulator).</summary>
    double NowMs { get; }
    /// <summary>Wall-clock time, for battery reading ages.</summary>
    DateTime Now { get; }
    /// <summary>Task.Delay, on the host's clock.</summary>
    Task Delay(int ms);
    /// <summary>A repeating timer like Win32 SetTimer; the host calls <see cref="TrayController.OnTimer"/> on each tick.</summary>
    void SetTimer(int id, int ms);
    void KillTimer(int id);
    void KillAllTimers();

    // ---- the taskbar
    bool LightTaskbar { get; }
    /// <summary>Small-icon size at the taskbar's DPI (16 px at 100 %).</summary>
    int IconSize { get; }
    void ApplyMenuTheme(bool light);
    bool AddIcon(IconImage icon, string tip);
    bool ModifyIcon(IconImage icon, string tip);
    void RemoveIcon();
    /// <summary>The icon is no longer shown or needed (frees its native handle, if the host made one).</summary>
    void ReleaseIcon(IconImage icon);
    (int X, int Y)? CursorPos();
    /// <summary>Where a menu opened by command (--show-menu) is anchored: the icon's top centre.</summary>
    (int X, int Y)? IconAnchor();
    /// <summary>Shows the popup menu; completes with the chosen command ID (0 = dismissed).</summary>
    Task<int> TrackPopupMenu(IReadOnlyList<MenuItem> items, int x, int y, bool light);
    void EndMenu();
    /// <summary>Marks our notification-area entry as promoted; returns the TrayPromotion result name.</summary>
    string PromoteSelf();

    // ---- system
    bool AutostartEnabled { get; }
    void SetAutostart(bool on);
    /// <summary>Ends the app (the native host destroys its window, which ends the message loop).</summary>
    void Exit();
    /// <summary>A structured event for the simulator's timeline (JSON object body); ignored natively.</summary>
    void Emit(string json);
}

/// <summary>The Bluetooth side: real Core Audio / KS / BLE on Windows, the mock stack in the simulator.</summary>
internal interface IDeviceBackend
{
    /// <summary>Raised (on any thread) when Windows reports an audio endpoint change.</summary>
    event Action? EndpointChanged;
    Task RegisterNotifications();
    /// <summary>Enumerates Bluetooth audio devices; also reads the battery Windows knows for <paramref name="mac"/>.</summary>
    Task<(Snapshot Snap, int? WindowsBattery)> Refresh(string? mac);
    /// <summary>Sends the one-shot connect/disconnect to every KS control of the device (and logs each result).</summary>
    Task<IReadOnlyList<SendResult>> SendOneShot(Guid containerId, OneShot op);
    /// <summary>The Bluetooth link's connected flag (null if the device isn't known).</summary>
    Task<bool?> BluetoothConnected(string mac);
    Task<BatteryReading?> ScanBattery(ushort model, TimeSpan window);
}

/// <summary>Icon pixels plus what they show. Hosts may attach a native handle (an HICON) to it.</summary>
internal sealed class IconImage(byte[] bgra, int size, string descJson)
{
    /// <summary>Straight-alpha BGRA, top-down rows.</summary>
    public byte[] Bgra { get; } = bgra;
    public int Size { get; } = size;
    /// <summary>e.g. {"kind":"static","state":"connected"} or {"kind":"anim","phase":"Landing","t":0.2,"tracerT":1.6}.</summary>
    public string DescJson { get; } = descJson;
    public object? HostHandle { get; set; }
}

/// <summary>One popup menu entry (a separator, a command, or a submenu).</summary>
internal sealed record MenuItem(int Id, string? Text, bool Grayed = false, bool Checked = false,
    bool Separator = false, IReadOnlyList<MenuItem>? Submenu = null)
{
    public static readonly MenuItem Divider = new(0, null, Separator: true);
}

/// <summary>Commands another QuickTooth.exe sends to the running tray (QuickTooth.Command.v1 wParam).</summary>
internal static class TrayCommands
{
    public const int Toggle = 1, Connect = 2, Disconnect = 3, Exit = 4, ShowMenu = 5, CloseMenu = 6;
}
