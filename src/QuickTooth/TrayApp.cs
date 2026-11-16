using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using QuickTooth.Native;
using static QuickTooth.Native.Win32;

namespace QuickTooth;

/// <summary>
/// The Windows side of the tray icon: a hidden top-level window (message-only windows never receive
/// "TaskbarCreated" or WM_SETTINGCHANGE), Shell_NotifyIcon v4, SetTimer, a native popup menu and
/// HICONs. All behaviour lives in the shared <see cref="TrayController"/> (also run by the browser
/// simulator); this class only connects it to Win32. Everything here runs on the STA UI thread;
/// device work runs on <see cref="DeviceWorker"/> (in <see cref="WindowsDevices"/>).
/// </summary>
internal sealed class TrayApp : ITrayHost
{
    private const int WM_TRAY = WM_APP + 1;
    private const int WM_APP_INVOKE = WM_APP + 2;
    private const int WM_APP_DEVCHANGE = WM_APP + 3;

    // Rooted for the process lifetime: native code holds these.
    private static Mutex? s_mutex;
    private static TrayApp? s_app;
    private static WndProc? s_wndProc;

    private readonly WindowsDevices _devices = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly UiContext _ui;
    private readonly IntPtr _hwnd;
    private readonly int _msgTaskbarCreated;
    private readonly int _msgCommand;
    private readonly TrayController? _controller;
    private bool _destroying;

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

        _ui = new UiContext(_hwnd);
        SynchronizationContext.SetSynchronizationContext(_ui);

        _controller = new TrayController(this, _devices, Settings.Load())
        {
            // Endpoint notifications arrive on an audio-service thread: hop to the UI thread first.
            EndpointChangedDispatcher = () => PostMessage(_hwnd, WM_APP_DEVCHANGE, IntPtr.Zero, IntPtr.Zero),
        };
        _controller.Start();
    }

    private int MessageLoop()
    {
        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        _devices.Dispose();
        return 0;
    }

    // ------------------------------------------------------------------ window procedure

    private IntPtr WndProcImpl(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (_ui != null && SynchronizationContext.Current != _ui) SynchronizationContext.SetSynchronizationContext(_ui);
            var c = _controller; // null while CreateWindowEx is still running
            switch (msg)
            {
                case WM_TRAY:
                    switch (LoWord(lParam))
                    {
                        case NIN_SELECT: c?.OnTrayEvent("select", 0, 0); break;         // left click (v4)
                        case NIN_KEYSELECT: c?.OnTrayEvent("keyselect", 0, 0); break;   // Space/Enter on the focused icon
                        case WM_CONTEXTMENU: c?.OnTrayEvent("contextmenu", LoWord(wParam), HiWord(wParam)); break; // anchor in wParam (v4)
                    }
                    return IntPtr.Zero;
                case WM_APP_INVOKE:
                    _ui?.Drain();
                    return IntPtr.Zero;
                case WM_APP_DEVCHANGE:
                    c?.OnEndpointChangedOnUiThread();
                    return IntPtr.Zero;
                case WM_TIMER:
                    c?.OnTimer((int)wParam);
                    return IntPtr.Zero;
                case WM_SETTINGCHANGE:
                    c?.OnSettingChange(lParam != IntPtr.Zero ? Marshal.PtrToStringUni(lParam) : null);
                    break;
                case WM_DISPLAYCHANGE:
                case WM_DPICHANGED:
                    c?.OnDisplayChange();
                    break;
                case WM_DESTROY:
                    _destroying = true;
                    c?.Exit();
                    PostQuitMessage(0);
                    return IntPtr.Zero;
                default:
                    if (msg == _msgTaskbarCreated && msg != 0)
                    {
                        c?.OnTaskbarCreated();
                        return IntPtr.Zero;
                    }
                    if (msg == _msgCommand && msg != 0)
                    {
                        c?.OnCommand((int)wParam);
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

    // ------------------------------------------------------------------ ITrayHost: time

    public string ExePath => Environment.ProcessPath ?? "QuickTooth.exe";
    public double NowMs => _clock.Elapsed.TotalMilliseconds;
    public DateTime Now => DateTime.Now;
    public Task Delay(int ms) => Task.Delay(ms);
    public void SetTimer(int id, int ms) => Win32.SetTimer(_hwnd, id, (uint)ms, IntPtr.Zero);
    public void KillTimer(int id) => Win32.KillTimer(_hwnd, id);

    public void KillAllTimers()
    {
        foreach (int id in TrayController.AllTimers) Win32.KillTimer(_hwnd, id);
    }

    // ------------------------------------------------------------------ ITrayHost: the notification icon

    public bool LightTaskbar => Theme.TaskbarIsLight();

    /// <summary>Small-icon size at the taskbar's DPI (16 px at 96 DPI).</summary>
    public int IconSize
    {
        get
        {
            uint dpi = 0;
            var tray = FindWindow("Shell_TrayWnd", null);
            if (tray != IntPtr.Zero) dpi = GetDpiForWindow(tray);
            if (dpi == 0) dpi = GetDpiForSystem();
            int size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
            return size > 0 ? size : 16;
        }
    }

    public void ApplyMenuTheme(bool light)
    {
        try
        {
            SetPreferredAppMode(light ? AppModeForceLight : AppModeForceDark);
            AllowDarkModeForWindow(_hwnd, !light);
            FlushMenuThemes();
        }
        catch (Exception ex)
        {
            Log.Info("dark menu support unavailable: " + ex.Message);
        }
    }

    public bool AddIcon(IconImage icon, string tip)
    {
        var nid = NewNid();
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = HIcon(icon);
        nid.szTip = tip;
        if (!Shell_NotifyIcon(NIM_ADD, ref nid))
        {
            // Probably a stale icon from a previous session (or Explorer isn't ready yet at logon).
            Shell_NotifyIcon(NIM_DELETE, ref nid);
            if (!Shell_NotifyIcon(NIM_ADD, ref nid)) return false;
        }
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIcon(NIM_SETVERSION, ref nid);
        return true;
    }

    public bool ModifyIcon(IconImage icon, string tip)
    {
        var nid = NewNid();
        nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        nid.hIcon = HIcon(icon);
        nid.szTip = tip;
        return Shell_NotifyIcon(NIM_MODIFY, ref nid);
    }

    public void RemoveIcon()
    {
        var nid = NewNid();
        Shell_NotifyIcon(NIM_DELETE, ref nid);
    }

    private static IntPtr HIcon(IconImage icon) => NativeIcons.HandleFor(icon);

    public void ReleaseIcon(IconImage icon) => NativeIcons.Release(icon);

    private NOTIFYICONDATA NewNid() => new()
    {
        cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = _hwnd,
        uID = Ipc.IconId,
        szTip = "",
        szInfo = "",
        szInfoTitle = "",
    };

    public (int X, int Y)? CursorPos() => GetCursorPos(out var pt) ? (pt.X, pt.Y) : null;

    public (int X, int Y)? IconAnchor()
    {
        var id = new NOTIFYICONIDENTIFIER { cbSize = Marshal.SizeOf<NOTIFYICONIDENTIFIER>(), hWnd = _hwnd, uID = Ipc.IconId };
        return Shell_NotifyIconGetRect(ref id, out var r) == 0 ? ((r.Left + r.Right) / 2, r.Top) : null;
    }

    // ------------------------------------------------------------------ ITrayHost: menu

    /// <summary>Shows the menu modally (TrackPopupMenuEx), so the returned task is already complete.</summary>
    public Task<int> TrackPopupMenu(IReadOnlyList<MenuItem> items, int x, int y, bool light)
    {
        var menu = CreatePopupMenu();
        try
        {
            Append(menu, items);
            SetForegroundWindow(_hwnd); // so the menu closes when clicking elsewhere
            int cmd = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, x, y, _hwnd, IntPtr.Zero);
            PostMessage(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
            return Task.FromResult(cmd);
        }
        finally
        {
            DestroyMenu(menu); // also destroys the submenus
        }
    }

    private static void Append(IntPtr menu, IReadOnlyList<MenuItem> items)
    {
        foreach (var item in items)
        {
            if (item.Separator)
            {
                AppendMenu(menu, MF_SEPARATOR, IntPtr.Zero, null);
            }
            else if (item.Submenu is { } children)
            {
                var sub = CreatePopupMenu();
                Append(sub, children);
                AppendMenu(menu, MF_POPUP | (item.Grayed ? MF_GRAYED : 0), sub, item.Text);
            }
            else
            {
                uint flags = MF_STRING | (item.Grayed ? MF_GRAYED : 0) | (item.Checked ? MF_CHECKED : 0);
                AppendMenu(menu, flags, item.Id, item.Text);
            }
        }
    }

    public void EndMenu() => Win32.EndMenu();

    // ------------------------------------------------------------------ ITrayHost: system

    public string PromoteSelf() => TrayPromotion.PromoteSelf().ToString();

    public bool AutostartEnabled => Autostart.IsEnabled();

    public void SetAutostart(bool on)
    {
        if (on) Autostart.Enable(); else Autostart.Disable();
    }

    public void Exit()
    {
        if (!_destroying) DestroyWindow(_hwnd);
    }

    public void Emit(string json) { } // the simulator's timeline only

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
