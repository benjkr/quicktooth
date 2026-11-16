using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using QuickTooth.Native;
using PnpEndpoints = QuickTooth.Native.PnpEndpoints;

namespace QuickTooth;

/// <summary>Constants shared by the tray instance and CLI invocations that forward to it.</summary>
internal static class Ipc
{
    public const string WindowClass = "QuickTooth.TrayWindow";
    public const string CommandMessageName = "QuickTooth.Command.v1";
    public const int IconId = 1;

    public static IntPtr FindTrayWindow() => Win32.FindWindow(WindowClass, null);
}

internal static class Cli
{
    private static TextWriter Out = TextWriter.Null;

    public static int Run(string[] args)
    {
        Out = OpenConsole();
        try
        {
            string cmd = args[0].ToLowerInvariant();
            bool has(string flag) => args.Any(a => string.Equals(a, flag, StringComparison.OrdinalIgnoreCase));
            switch (cmd)
            {
                case "--list": return List(includeOthers: has("--all"));
                case "--battery": return BatteryCmd();
                case "--toggle": return Action(null, !has("--no-wait"), has("--direct"), has("--a2dp-only"));
                case "--connect": return Action(OneShot.Connect, !has("--no-wait"), has("--direct"), has("--a2dp-only"));
                case "--disconnect": return Action(OneShot.Disconnect, !has("--no-wait"), has("--direct"), has("--a2dp-only"));
                case "--exit": return ExitTray();
                case "--autostart": return AutostartCmd(args.Length > 1 ? args[1] : "status");
                case "--render-icons":
                    int zi = Array.FindIndex(args, a => a.Equals("--zoom", StringComparison.OrdinalIgnoreCase));
                    if (zi > 0 && zi + 1 < args.Length) IconRenderer.Zoom = double.Parse(args[zi + 1], System.Globalization.CultureInfo.InvariantCulture);
                    return RenderIcons(args.Length > 1 && !args[1].StartsWith("--") ? args[1] : Path.Combine(Environment.CurrentDirectory, "icon-check"));
                case "--icon-rect": return IconRect();
                case "--probe": return Probe(args[1]);
                // test hooks: open/close the tray menu without touching the mouse
                case "--show-menu": return Forward(TrayCommands.ShowMenu);
                case "--close-menu": return Forward(TrayCommands.CloseMenu);
                // test hooks (read-only): settings load/save fidelity, and COM release under load
                case "--settings-roundtrip": File.WriteAllText(args[2], Settings.Load(args[1]).ToJson()); return 0;
                case "--stress-enumerate": return StressEnumerate(int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture));
                case "--watch-endpoints": return WatchEndpoints(int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture));
                case "--selftest-icons": return SelfTest.Icons(Out, args.Length > 1 ? int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture) : 200);
                case "--version":
                    Out.WriteLine($"QuickTooth {typeof(Cli).Assembly.GetName().Version}  ({System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}, " +
                                  $"{(System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported ? "JIT" : "Native AOT")})");
                    return 0;
                case "--help": case "-h": case "/?": return Help(0);
                default:
                    Out.WriteLine($"Unknown option: {args[0]}");
                    return Help(2);
            }
        }
        catch (Exception ex)
        {
            Out.WriteLine("Error: " + ex);
            Log.Error("cli", ex);
            return 1;
        }
        finally
        {
            Out.Flush();
        }
    }

    private static int Help(int code)
    {
        Out.WriteLine("""
            QuickTooth — tray toggle for a Bluetooth audio device.

              QuickTooth.exe                 start the tray icon (single instance)
              QuickTooth.exe --list [--all]  list Bluetooth audio devices (read-only)
              QuickTooth.exe --toggle        connect/disconnect the target device
              QuickTooth.exe --connect       connect the target device
              QuickTooth.exe --disconnect    disconnect the target device
                                             (add --no-wait to return immediately)
              QuickTooth.exe --autostart on|off|status
              QuickTooth.exe --exit          close the running tray instance

            When the tray is running, --toggle/--connect/--disconnect are handed to it, so they
            behave exactly like clicking the icon.
            """);
        return code;
    }

    /// <summary>
    /// Enumerates (activating every Bluetooth KS control) <paramref name="n"/> times and prints the
    /// process handle count, which must stay flat if COM objects are released deterministically.
    /// </summary>
    private static int StressEnumerate(int n)
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        int Handles() { using var p = System.Diagnostics.Process.GetCurrentProcess(); return p.HandleCount; }
        for (int i = 0; i <= n; i++)
        {
            if (i % 50 == 0) Out.WriteLine($"after {i,4} enumerations: {Handles()} handles");
            if (i < n) worker.Run(() => audio.Enumerate(probeKsControl: true)).GetAwaiter().GetResult();
        }
        return 0;
    }

    /// <summary>
    /// Read-only: checks the endpoint-notification callback object through its native vtable, then
    /// registers it with the audio service and counts the callbacks that arrive in <paramref name="seconds"/>.
    /// </summary>
    private static int WatchEndpoints(int seconds)
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        Out.WriteLine($"callback self-test through the COM vtable: {(worker.Run(audio.SelfTestCallback).GetAwaiter().GetResult() ? "OK" : "FAILED")}");
        worker.Run(audio.RegisterNotifications).GetAwaiter().GetResult();
        Out.WriteLine($"registered; listening {seconds} s…");
        Out.Flush();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        Out.WriteLine($"callbacks received from the audio service: {audio.NotificationCount}");
        return 0;
    }

    // ------------------------------------------------------------------ --list

    private static int List(bool includeOthers)
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        var snap = worker.Run(() => audio.Enumerate(probeKsControl: true, includeOthers: includeOthers)).GetAwaiter().GetResult();
        if (snap.Error != null) Out.WriteLine("Enumeration error: " + snap.Error);

        var settings = Settings.Load();
        var target = settings.HasTarget ? settings.Resolve(snap.Devices) : Settings.DefaultTarget(snap.Devices);
        string how = settings.HasTarget
            ? (target != null ? "stored in settings" : "STORED TARGET NOT FOUND — nothing would be sent")
            : (target != null ? "default: first-run pick, name contains \"AirPods\" (not saved yet)" : "none");

        Out.WriteLine($"Settings: {Settings.FilePath}");
        Out.WriteLine($"Target:   {(target?.Name ?? settings.TargetName ?? "-")}  [{how}]");
        if (settings.HasTarget) Out.WriteLine($"          stored container {settings.TargetContainerId ?? "-"}  MAC {settings.TargetMac ?? "-"}");
        Out.WriteLine();
        Out.WriteLine($"Bluetooth audio devices ({snap.Devices.Count}), grouped by container ID:");
        foreach (var d in snap.Devices)
        {
            bool isTarget = target != null && d.ContainerId == target.ContainerId;
            Out.WriteLine();
            Out.WriteLine($"{(isTarget ? "*" : " ")} {d.Name}   {(d.Connected ? "CONNECTED" : "not connected")}{(isTarget ? "   <== target" : "")}");
            Out.WriteLine($"    container {d.ContainerId:B}   MAC {d.Mac ?? "-"}");
            foreach (var e in d.Endpoints)
            {
                Out.WriteLine($"    - {e.Name}");
                Out.WriteLine($"        state       {DeviceState.Name(e.State)} ({e.State})");
                Out.WriteLine($"        endpoint    {e.EndpointId}{(e.HiddenFromEnumeration ? "   (not returned by EnumAudioEndpoints; found via PnP)" : "")}");
                Out.WriteLine($"        interface   {e.InterfaceName ?? "-"}");
                Out.WriteLine($"        bth device  {e.BthDeviceId}");
                string ks = e.KsActivateHr == 0 ? "activates (hr=0x00000000)" : $"FAILED hr=0x{e.KsActivateHr:X8}";
                Out.WriteLine($"        IKsControl  {ks}{(isTarget && e.KsActivateHr == 0 ? "   -> a send would hit this control" : "")}");
            }
        }
        Out.WriteLine();
        if (includeOthers)
        {
            Out.WriteLine($"Other render endpoints ({snap.Others.Count}):");
            foreach (var o in snap.Others)
                Out.WriteLine($"  {DeviceState.Name(o.State),-10} {o.Name}\n             {o.EndpointId}\n             topology: {o.TopologyIds ?? "-"}");
        }
        else
        {
            Out.WriteLine("(Non-Bluetooth endpoints hidden; add --all to show them.)");
        }
        return 0;
    }

    // ------------------------------------------------------------------ --toggle / --connect / --disconnect

    /// <param name="direct">Send from this process even if the tray is running (diagnostics).</param>
    /// <param name="a2dpOnly">Send only to the A2DP control (diagnostics / A-B test).</param>
    private static int Action(OneShot? requested, bool wait, bool direct, bool a2dpOnly)
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        var settings = Settings.Load();
        var snap = worker.Run(() => audio.Enumerate()).GetAwaiter().GetResult();
        var target = settings.ResolveOrDefault(snap.Devices, persist: true);
        if (target == null)
        {
            Out.WriteLine(settings.HasTarget
                ? $"Target '{settings.TargetName}' ({settings.TargetContainerId}) is not available. Nothing sent."
                : "No target device (no Bluetooth audio device named *AirPods*). Pick one from the tray menu. Nothing sent.");
            return 3;
        }

        var op = requested ?? (target.Connected ? OneShot.Disconnect : OneShot.Connect);
        bool expectConnected = op == OneShot.Connect;
        Out.WriteLine($"Target: {target.Name}  container {target.ContainerId:B}  — currently {(target.Connected ? "connected" : "not connected")}");
        if (target.Connected == expectConnected)
        {
            Out.WriteLine($"Already {(expectConnected ? "connected" : "disconnected")}; nothing to do.");
            return 0;
        }

        var hwnd = direct ? IntPtr.Zero : Ipc.FindTrayWindow();
        var sent = Stopwatch.StartNew();
        if (hwnd != IntPtr.Zero)
        {
            int msg = Win32.RegisterWindowMessage(Ipc.CommandMessageName);
            int code = requested switch { null => TrayCommands.Toggle, OneShot.Connect => TrayCommands.Connect, _ => TrayCommands.Disconnect };
            bool ok = Win32.PostMessage(hwnd, msg, code, IntPtr.Zero);
            Out.WriteLine(ok
                ? $"Handed '{(requested?.ToString() ?? "toggle")}' to the running tray instance (same path as a click)."
                : $"PostMessage to tray failed (error {Marshal.GetLastWin32Error()}).");
            if (!ok) return 1;
        }
        else
        {
            if (op == OneShot.Connect && target.Mac is string mac)
            {
                // Same as the tray: let a lingering link from a recent disconnect close first.
                var hold = Stopwatch.StartNew();
                while (hold.ElapsedMilliseconds < 5000 && PnpEndpoints.BluetoothConnected(mac) == true) Thread.Sleep(200);
                if (hold.ElapsedMilliseconds > 300) Out.WriteLine($"Waited {hold.ElapsedMilliseconds} ms for the previous link to close.");
            }
            Out.WriteLine($"{(direct ? "Direct" : "Tray not running;")} sending {op}{(a2dpOnly ? " (A2DP control only)" : "")} at {DateTime.Now:HH:mm:ss.fff}.");
            sent.Restart();
            var results = worker.Run(() => audio.SendOneShot(target.ContainerId, op, a2dpOnly)).GetAwaiter().GetResult();
            foreach (var r in results)
                Out.WriteLine($"  KsProperty hr=0x{r.Hr:X8}  {r.EndpointName}");
            if (results.Count == 0 || results.All(r => r.Hr != 0))
            {
                Out.WriteLine("No control accepted the request.");
                return 1;
            }
        }

        if (!wait) return 0;
        return WaitForState(worker, audio, target.ContainerId, target.Mac, expectConnected, sent) ? 0 : 4;
    }

    /// <summary>Read-only polling: prints every endpoint state transition until the device reaches the expected state.</summary>
    private static bool WaitForState(DeviceWorker worker, BluetoothAudio audio, Guid containerId, string? mac, bool expectConnected, Stopwatch sw)
    {
        var last = new Dictionary<string, uint>();
        TimeSpan? reachedAt = null;
        bool? lastLink = null;
        while (sw.Elapsed < TimeSpan.FromSeconds(40))
        {
            if (mac != null)
            {
                var link = PnpEndpoints.BluetoothConnected(mac);
                if (link != lastLink)
                {
                    Out.WriteLine($"  +{sw.ElapsedMilliseconds,6} ms  Bluetooth link flag: {(link == null ? "?" : link.Value ? "connected" : "not connected")}");
                    lastLink = link;
                }
            }
            var snap = worker.Run(() => audio.Enumerate()).GetAwaiter().GetResult();
            var dev = snap.Devices.FirstOrDefault(d => d.ContainerId == containerId);
            if (dev != null)
            {
                foreach (var e in dev.Endpoints)
                {
                    if (!last.TryGetValue(e.EndpointId, out var prev) || prev != e.State)
                    {
                        Out.WriteLine($"  +{sw.ElapsedMilliseconds,6} ms  {DeviceState.Name(e.State),-10} {e.Name}");
                        last[e.EndpointId] = e.State;
                    }
                }
                if (dev.Connected == expectConnected && reachedAt == null)
                {
                    reachedAt = sw.Elapsed;
                    Out.WriteLine($"  Reached {(expectConnected ? "connected" : "disconnected")} after {sw.ElapsedMilliseconds} ms; watching 4 s more for changes…");
                }
                if (reachedAt != null && dev.Connected != expectConnected)
                    Out.WriteLine($"  !! state flipped back after reaching it (+{sw.ElapsedMilliseconds} ms)");
                if (reachedAt != null && sw.Elapsed - reachedAt.Value > TimeSpan.FromSeconds(4))
                    return dev.Connected == expectConnected;
            }
            Thread.Sleep(100);
        }
        Out.WriteLine(reachedAt == null ? "  Timed out after 40 s." : "  Done.");
        return reachedAt != null;
    }

    // ------------------------------------------------------------------ misc

    private static int Probe(string endpointId)
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        Out.WriteLine(worker.Run(() => audio.Probe(endpointId)).GetAwaiter().GetResult());
        return 0;
    }

    /// <summary>Read-only: Windows' battery property, then one passive BLE scan for the AirPods status advert.</summary>
    private static int BatteryCmd()
    {
        using var worker = new DeviceWorker();
        var audio = new BluetoothAudio();
        var snap = worker.Run(() => audio.Enumerate()).GetAwaiter().GetResult();
        var target = Settings.Load().ResolveOrDefault(snap.Devices, persist: false);
        if (target == null) { Out.WriteLine("No target device."); return 3; }
        Out.WriteLine($"Target: {target.Name} — {(target.Connected ? "connected" : "not connected")}");
        int? windows = target.Mac != null ? PnpEndpoints.BluetoothBattery(target.Mac) : null;
        Out.WriteLine($"Windows battery property: {(windows is int w ? w + "%" : "none")}");
        if (AppleStatusAdvert.ModelOf(target) is not ushort model) { Out.WriteLine("Not an Apple accessory; no BLE status advert to read."); return 0; }
        Out.WriteLine($"Listening for Apple status adverts (model 0x{model:X4}) for up to 12 s…");
        var reading = BleBatteryScanner.ScanAsync(model, TimeSpan.FromSeconds(12)).GetAwaiter().GetResult();
        Out.WriteLine(reading == null ? "No status advert heard (the AirPods only broadcast it while out of the case)." : $"Battery: {reading.Text}   [{reading.Describe()}]");
        var (adverts, apple, errors) = BleBatteryScanner.LastScan;
        Out.WriteLine($"Scan: {adverts} Bluetooth LE adverts heard, {apple} from Apple devices, {errors} handler errors.");
        return 0;
    }

    private static int Forward(int cmd)
    {
        var hwnd = Ipc.FindTrayWindow();
        if (hwnd == IntPtr.Zero) { Out.WriteLine("Tray instance is not running."); return 1; }
        Win32.PostMessage(hwnd, Win32.RegisterWindowMessage(Ipc.CommandMessageName), cmd, IntPtr.Zero);
        return 0;
    }

    private static int ExitTray()
    {
        var hwnd = Ipc.FindTrayWindow();
        if (hwnd == IntPtr.Zero) { Out.WriteLine("Tray instance is not running."); return 0; }
        Win32.PostMessage(hwnd, Win32.RegisterWindowMessage(Ipc.CommandMessageName), TrayCommands.Exit, IntPtr.Zero);
        Out.WriteLine("Asked the tray instance to exit.");
        return 0;
    }

    private static int AutostartCmd(string arg)
    {
        switch (arg.ToLowerInvariant())
        {
            case "on": Autostart.Enable(); break;
            case "off": Autostart.Disable(); break;
        }
        Out.WriteLine($"Start with Windows: {(Autostart.IsEnabled() ? "on" : "off")}  ({Autostart.CurrentValue() ?? "no Run entry"})");
        return 0;
    }

    private static int IconRect()
    {
        var hwnd = Ipc.FindTrayWindow();
        if (hwnd == IntPtr.Zero) { Out.WriteLine("Tray instance is not running."); return 1; }
        var id = new Win32.NOTIFYICONIDENTIFIER { cbSize = Marshal.SizeOf<Win32.NOTIFYICONIDENTIFIER>(), hWnd = hwnd, uID = Ipc.IconId };
        int hr = Win32.Shell_NotifyIconGetRect(ref id, out var r);
        Out.WriteLine(hr == 0 ? $"{r.Left} {r.Top} {r.Right} {r.Bottom}" : $"Shell_NotifyIconGetRect hr=0x{hr:X8}");
        return hr == 0 ? 0 : 1;
    }

    private static int RenderIcons(string dir)
    {
        Directory.CreateDirectory(dir);
        foreach (var f in NativeIcons.WriteCheckImages(dir)) Out.WriteLine(f);
        return 0;
    }

    // ------------------------------------------------------------------ console plumbing

    /// <summary>
    /// QuickTooth is a WinExe. If stdout is redirected (pipe/file) write UTF-8 to it; otherwise attach
    /// to the parent console and write UTF-16 with WriteConsoleW (the device names contain U+2019).
    /// </summary>
    private static TextWriter OpenConsole()
    {
        var h = Win32.GetStdHandle(Win32.STD_OUTPUT_HANDLE);
        uint type = h == IntPtr.Zero || h == new IntPtr(-1) ? 0 : Win32.GetFileType(h);
        if (type is Win32.FILE_TYPE_DISK or Win32.FILE_TYPE_PIPE)
            return new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        if (Win32.AttachConsole(Win32.ATTACH_PARENT_PROCESS))
        {
            var con = ConsoleWriter.TryOpen();
            if (con != null) { con.WriteLine(); return con; }
        }
        return TextWriter.Null;
    }

    private sealed class ConsoleWriter : TextWriter
    {
        private readonly IntPtr _h;
        private ConsoleWriter(IntPtr h) => _h = h;
        public override Encoding Encoding => Encoding.Unicode;

        public static ConsoleWriter? TryOpen()
        {
            var h = CreateFile("CONOUT$", 0xC0000000, 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
            return h == new IntPtr(-1) ? null : new ConsoleWriter(h);
        }

        public override void Write(char value) => Write(value.ToString());
        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value)) return;
            WriteConsoleW(_h, value, (uint)value.Length, out _, IntPtr.Zero);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool WriteConsoleW(IntPtr h, string text, uint len, out uint written, IntPtr reserved);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    }
}
