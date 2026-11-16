using System.Runtime.InteropServices;

namespace QuickTooth;

/// <summary>
/// QuickTooth.exe --selftest-icons [cycles]: drives the real <see cref="TrayController"/> through
/// connect and disconnect animations with a window-less host whose icons are real HICONs, created
/// and destroyed exactly as the tray does (<see cref="NativeIcons.HandleFor"/> / Release), and
/// reports the process's GDI and USER object counts. They must stay flat. Read-only: a fake device
/// backend, no tray icon, no device operations; log lines go to the console, not quicktooth.log,
/// and settings are never saved.
/// </summary>
internal static partial class SelfTest
{
    [LibraryImport("user32.dll")] private static partial uint GetGuiResources(IntPtr hProcess, uint uiFlags);
    [LibraryImport("kernel32.dll")] private static partial IntPtr GetCurrentProcess();
    private const uint GR_GDIOBJECTS = 0, GR_USEROBJECTS = 1;

    public static int Icons(TextWriter output, int cycles)
    {
        var sink = Log.Sink;
        var save = Settings.SaveHandler;
        Log.Sink = _ => { };
        Settings.SaveHandler = _ => { };
        try
        {
            var host = new FakeHost();
            var devices = new FakeDevices();
            var settings = new Settings { TargetContainerId = FakeDevices.Container.ToString("B"), TargetMac = "A0B1C2D3E4F5", TargetName = "Test AirPods", TrayPromotedOnce = true };
            var app = new TrayController(host, devices, settings);
            app.Start();

            (uint Gdi, uint User) Count() => (GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS), GetGuiResources(GetCurrentProcess(), GR_USEROBJECTS));
            void Tick(int id) { host.Now += Tunables.AnimFrameMs; app.OnTimer(id); }

            void Cycle()
            {
                app.OnCommand(TrayCommands.Connect);                        // Connecting: buds part, tracer runs
                for (int i = 0; i < 25; i++) Tick(TrayController.TIMER_ANIM);
                devices.Connected = true;
                app.OnTimer(TrayController.TIMER_FASTPOLL);                 // confirmed → Landing
                for (int i = 0; i < 12; i++) Tick(TrayController.TIMER_ANIM);
                app.OnCommand(TrayCommands.Disconnect);                     // Disconnecting
                for (int i = 0; i < 6; i++) Tick(TrayController.TIMER_ANIM);
                devices.Connected = false;
                app.OnTimer(TrayController.TIMER_FASTPOLL);
                for (int i = 0; i < 12; i++) Tick(TrayController.TIMER_ANIM);
            }

            Cycle(); // warm-up: static icons, first frames
            var before = Count();
            int framesBefore = host.FramesShown;
            for (int c = 0; c < cycles; c++) Cycle();
            var after = Count();
            int frames = host.FramesShown - framesBefore;
            app.Exit();
            var end = Count();

            output.WriteLine($"{cycles} connect/disconnect cycles, {frames} animation frames shown as HICONs");
            output.WriteLine($"GDI objects:  {before.Gdi} → {after.Gdi} (after exit {end.Gdi})");
            output.WriteLine($"USER objects: {before.User} → {after.User} (after exit {end.User})");
            output.WriteLine($"icons still owned by the controller: {host.LiveIcons} (the two static icons)");
            bool ok = after.Gdi <= before.Gdi + 2 && after.User <= before.User + 2 && frames > 0;
            output.WriteLine(ok ? "PASS: no icon handles leak" : "FAIL: icon handles leak");
            return ok ? 0 : 1;
        }
        finally
        {
            Log.Sink = sink;
            Settings.SaveHandler = save;
        }
    }

    private sealed class FakeHost : ITrayHost
    {
        public double Now;
        public int FramesShown, LiveIcons;
        private readonly HashSet<IconImage> _live = new();

        public string ExePath => "selftest";
        public double NowMs => Now;
        DateTime ITrayHost.Now => DateTime.UnixEpoch.AddMilliseconds(Now);
        public Task Delay(int ms) { Now += ms; return Task.CompletedTask; }
        public void SetTimer(int id, int ms) { }
        public void KillTimer(int id) { }
        public void KillAllTimers() { }
        public bool LightTaskbar => false;
        public int IconSize => 16;
        public void ApplyMenuTheme(bool light) { }

        private bool Show(IconImage icon)
        {
            NativeIcons.HandleFor(icon);
            if (_live.Add(icon) && icon.DescJson.Contains("\"anim\"")) FramesShown++;
            LiveIcons = _live.Count;
            return true;
        }

        public bool AddIcon(IconImage icon, string tip) => Show(icon);
        public bool ModifyIcon(IconImage icon, string tip) => Show(icon);
        public void RemoveIcon() { }

        public void ReleaseIcon(IconImage icon)
        {
            NativeIcons.Release(icon);
            _live.Remove(icon);
            LiveIcons = _live.Count;
        }

        public (int X, int Y)? CursorPos() => null;
        public (int X, int Y)? IconAnchor() => null;
        public Task<int> TrackPopupMenu(IReadOnlyList<MenuItem> items, int x, int y, bool light) => Task.FromResult(0);
        public void EndMenu() { }
        public string PromoteSelf() => "AlreadyPromoted";
        public bool AutostartEnabled => false;
        public void SetAutostart(bool on) { }
        public void Exit() { }
        public void Emit(string json) { }
    }

    private sealed class FakeDevices : IDeviceBackend
    {
        public static readonly Guid Container = new("a1000001-0000-4000-8000-000000000001");
        public bool Connected;

        public event Action? EndpointChanged { add { } remove { } }
        public Task RegisterNotifications() => Task.CompletedTask;

        public Task<(Snapshot Snap, int? WindowsBattery)> Refresh(string? mac)
        {
            uint state = Connected ? DeviceState.Active : DeviceState.Unplugged;
            var eps = new List<BtEndpoint>
            {
                new("ep1", "Headphones (Test AirPods)", null, state, @"{2}.\\?\bthenum#x", Container, "A0B1C2D3E4F5", false, int.MinValue),
                new("ep2", "Headset (Test AirPods)", null, state, @"{2}.\\?\bthhfenum#x", Container, "A0B1C2D3E4F5", true, int.MinValue),
            };
            var snap = new Snapshot { Devices = [new BtDevice(Container, "Test AirPods", "A0B1C2D3E4F5", eps)] };
            return Task.FromResult<(Snapshot, int?)>((snap, null));
        }

        public Task<IReadOnlyList<SendResult>> SendOneShot(Guid containerId, OneShot op) =>
            Task.FromResult<IReadOnlyList<SendResult>>([new SendResult("Headphones (Test AirPods)", "x", 0, 0)]);

        public Task<bool?> BluetoothConnected(string mac) => Task.FromResult<bool?>(false);
        public Task<BatteryReading?> ScanBattery(ushort model, TimeSpan window) => Task.FromResult<BatteryReading?>(null);
    }
}
