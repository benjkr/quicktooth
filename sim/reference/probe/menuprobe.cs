#:property AllowUnsafeBlocks=true
#:property JsonSerializerIsReflectionEnabledByDefault=true
// Measures a real Win32 popup menu built exactly like QuickTooth's tray menu (TrayApp.ShowMenu):
// window rects, item rects, and a WM_PRINT render of every menu window in a few states.
// WM_PRINT goes through the menu's own painting, so it works even while the session is locked.
// DWM effects (rounded corners, shadow) are NOT in these renders.
//
//   dotnet run sim/reference/probe/menuprobe.cs -- <dark|light> <outDir> [anchorX anchorY] [tag]
//
// Writes <outDir>/<mode>-<tag>-<scene>-<n>.png and <outDir>/<mode>-<tag>.json.
// Opens a menu on screen for ~3 s in a throwaway window of its own; never touches the QuickTooth app.
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

string mode = args.Length > 0 ? args[0] : "dark";
string outDir = args.Length > 1 ? args[1] : ".";
int ax = args.Length > 3 ? int.Parse(args[2]) : 1710, ay = args.Length > 3 ? int.Parse(args[3]) : 1032;
string tag = args.Length > 4 ? args[4] : $"{ax}x{ay}";
Directory.CreateDirectory(outDir);
N.SetProcessDpiAwarenessContext(new IntPtr(-4)); // PerMonitorV2, like app.manifest

N.WndProc wndProc = (h, m, w, l) => N.DefWindowProc(h, m, w, l);
var wc = new N.WNDCLASSEX { cbSize = Marshal.SizeOf<N.WNDCLASSEX>(), lpfnWndProc = Marshal.GetFunctionPointerForDelegate(wndProc), hInstance = N.GetModuleHandle(IntPtr.Zero), lpszClassName = "QuickTooth.MenuProbe" };
N.RegisterClassEx(ref wc);
IntPtr hwnd = N.CreateWindowEx(0x80 /*WS_EX_TOOLWINDOW*/, wc.lpszClassName, "MenuProbe", unchecked((int)0x80000000) /*WS_POPUP*/, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);

bool dark = mode == "dark";
N.SetPreferredAppMode(dark ? 2 : 3);
N.AllowDarkModeForWindow(hwnd, dark);
N.FlushMenuThemes();

// Same items, flags and order as TrayApp.ShowMenu in the "connected, battery known" state.
IntPtr menu = N.CreatePopupMenu();
N.AppendMenu(menu, 0x0001, 9, "AirPods Pro — Connected · 80%");      // MF_GRAYED header
N.AppendMenu(menu, 0x0800, 0, null);                                    // MF_SEPARATOR
N.AppendMenu(menu, 0, 2, "Disconnect");
IntPtr sub = N.CreatePopupMenu();
N.AppendMenu(sub, 0x0008, 100, "AirPods Pro  (connected)");             // MF_CHECKED
N.AppendMenu(sub, 0, 101, "Other Headset");
N.AppendMenu(menu, 0x0010, sub, "Device");                              // MF_POPUP
N.AppendMenu(menu, 0x0800, 0, null);
N.AppendMenu(menu, 0x0008, 3, "Start with Windows");
N.AppendMenu(menu, 0, 4, "Exit");

const int MN_OPENHIERARCHY = 0x01E3, MN_SELECTITEM = 0x01E5;
var scenes = new (string Name, Action<List<IntPtr>> Act)[]
{
    ("idle", _ => { }),
    ("hot-disconnect", m => N.SendMessage(m[^1], MN_SELECTITEM, 2, 0)),
    ("hot-header-disabled", m => N.SendMessage(m[^1], MN_SELECTITEM, 0, 0)),
    ("submenu-open", m => { N.SendMessage(m[^1], MN_SELECTITEM, 3, 0); N.SendMessage(m[^1], MN_OPENHIERARCHY, 0, 0); }),
    ("submenu-hot", m => { if (m.Count > 1) N.SendMessage(m[0], MN_SELECTITEM, 1, 0); }),
};
var report = new Dictionary<string, object> { ["mode"] = mode, ["anchor"] = new[] { ax, ay }, ["flags"] = "TPM_RETURNCMD|TPM_RIGHTBUTTON|TPM_BOTTOMALIGN" };
var sceneReports = new List<object>();
int step = -1;
N.TimerProc timer = (h, m, id, t) =>
{
    // Capture the state the previous step set up, then set up the next one.
    var menus = N.VisibleMenus(); // z-order: topmost (the submenu, when open) first
    if (step >= 0)
    {
        var windows = new List<object>();
        for (int k = 0; k < menus.Count; k++)
        {
            N.GetWindowRect(menus[k], out var r);
            string file = $"{mode}-{tag}-{scenes[step].Name}-{k}.png";
            Png.Save(Path.Combine(outDir, file), N.Print(menus[k], r.R - r.L, r.B - r.T), r.R - r.L, r.B - r.T);
            windows.Add(new { rect = new[] { r.L, r.T, r.R, r.B }, dpi = N.GetDpiForWindow(menus[k]), file });
        }
        var items = new List<object>();
        for (int i = 0; i < 7; i++) if (N.GetMenuItemRect(hwnd, menu, (uint)i, out var ir)) items.Add(new[] { ir.L, ir.T, ir.R, ir.B });
        var subItems = new List<object>();
        for (int i = 0; i < 2; i++) if (N.GetMenuItemRect(hwnd, sub, (uint)i, out var ir) && ir.R > ir.L) subItems.Add(new[] { ir.L, ir.T, ir.R, ir.B });
        sceneReports.Add(new { scene = scenes[step].Name, windows, items, subItems });
    }
    step++;
    if (step >= scenes.Length || menus.Count == 0) { N.EndMenu(); return; }
    scenes[step].Act(menus);
};
N.SetForegroundWindow(hwnd);
N.SetTimer(hwnd, 1, 500, Marshal.GetFunctionPointerForDelegate(timer));
int cmd = N.TrackPopupMenuEx(menu, 0x0100 | 0x0002 | 0x0020, ax, ay, hwnd, IntPtr.Zero);
N.KillTimer(hwnd, 1);
report["scenes"] = sceneReports;
report["returned"] = cmd;
string json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
File.WriteAllText(Path.Combine(outDir, $"{mode}-{tag}.json"), json);
Console.WriteLine(json);
GC.KeepAlive(wndProc); GC.KeepAlive(timer);

static class Png
{
    public static void Save(string path, byte[] bgra, int w, int h)
    {
        var raw = new byte[(w * 4 + 1) * h];
        for (int y = 0; y < h; y++)
        {
            raw[y * (w * 4 + 1)] = 0;
            for (int x = 0; x < w; x++)
            {
                int s = (y * w + x) * 4, d = y * (w * 4 + 1) + 1 + x * 4;
                raw[d] = bgra[s + 2]; raw[d + 1] = bgra[s + 1]; raw[d + 2] = bgra[s]; raw[d + 3] = 255;
            }
        }
        using var ms = new MemoryStream();
        using (var z = new ZLibStream(ms, CompressionLevel.Optimal, leaveOpen: true)) z.Write(raw);
        using var fs = File.Create(path);
        fs.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BE(ihdr, 0, w); BE(ihdr, 4, h); ihdr[8] = 8; ihdr[9] = 6;
        Chunk(fs, "IHDR", ihdr); Chunk(fs, "IDAT", ms.ToArray()); Chunk(fs, "IEND", []);
    }
    static void BE(byte[] b, int o, int v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }
    static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4]; BE(len, 0, data.Length); s.Write(len);
        var td = Encoding.ASCII.GetBytes(type).Concat(data).ToArray(); s.Write(td);
        var crc = new byte[4]; BE(crc, 0, (int)Crc(td)); s.Write(crc);
    }
    static uint Crc(byte[] d)
    {
        uint c = 0xFFFFFFFF;
        foreach (var b in d) { c ^= b; for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1; }
        return c ^ 0xFFFFFFFF;
    }
}

static class N
{
    public delegate IntPtr WndProc(IntPtr h, int m, IntPtr w, IntPtr l);
    public delegate void TimerProc(IntPtr h, int m, IntPtr id, uint t);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX { public int cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string? lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassEx(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr param);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProc(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(IntPtr n);
    [DllImport("user32.dll")] public static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool AppendMenu(IntPtr m, int f, nint id, string? s);
    [DllImport("user32.dll")] public static extern int TrackPopupMenuEx(IntPtr m, int f, int x, int y, IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr h, nint id, int ms, IntPtr proc);
    [DllImport("user32.dll")] public static extern bool KillTimer(IntPtr h, nint id);
    [DllImport("user32.dll")] public static extern bool EndMenu();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, nint w, nint l);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr h, IntPtr m, uint i, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint u, out IntPtr bits, IntPtr s, uint o);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("uxtheme.dll", EntryPoint = "#135")] public static extern int SetPreferredAppMode(int mode);
    [DllImport("uxtheme.dll", EntryPoint = "#136")] public static extern void FlushMenuThemes();
    [DllImport("uxtheme.dll", EntryPoint = "#133")] public static extern bool AllowDarkModeForWindow(IntPtr h, bool allow);

    public static List<IntPtr> VisibleMenus()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { var sb = new StringBuilder(64); GetClassName(h, sb, 64); if (sb.ToString() == "#32768" && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    /// <summary>WM_PRINT (PRF_NONCLIENT|PRF_CLIENT|PRF_ERASEBKGND|PRF_CHILDREN) into a 32-bpp DIB; returns BGRA.</summary>
    public static unsafe byte[] Print(IntPtr hwnd, int w, int h)
    {
        var bmi = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        IntPtr dib = CreateDIBSection(dc, ref bmi, 0, out var bits, IntPtr.Zero, 0);
        IntPtr old = SelectObject(dc, dib);
        SendMessage(hwnd, 0x0317, dc, 0x2 | 0x4 | 0x8 | 0x10);
        var px = new byte[w * h * 4];
        Marshal.Copy(bits, px, 0, px.Length);
        SelectObject(dc, old); DeleteObject(dib); DeleteDC(dc);
        return px;
    }
}
