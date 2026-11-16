// How often does SetTimer(83 ms) — TrayApp's animation timer — really fire? USER timers tick on
// the system timer, so the requested interval gets rounded to it. Prints the measured intervals.
//
//   dotnet run sim/reference/probe/timerprobe.cs -- [intervalMs=83] [ticks=40]
using System.Diagnostics;
using System.Runtime.InteropServices;

int interval = args.Length > 0 ? int.Parse(args[0]) : 83;
int ticks = args.Length > 1 ? int.Parse(args[1]) : 40;
var sw = Stopwatch.StartNew();
var stamps = new List<double>();
T.TimerProc proc = (h, m, id, t) => stamps.Add(sw.Elapsed.TotalMilliseconds);
T.SetTimer(IntPtr.Zero, 0, interval, Marshal.GetFunctionPointerForDelegate(proc));
while (stamps.Count < ticks && T.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0) T.DispatchMessage(ref msg);
var gaps = stamps.Zip(stamps.Skip(1), (a, b) => b - a).ToList();
Console.WriteLine($"requested {interval} ms; {gaps.Count} intervals: mean {gaps.Average():F2} ms, min {gaps.Min():F2}, max {gaps.Max():F2}");
Console.WriteLine(string.Join(" ", gaps.Select(g => g.ToString("F1"))));
GC.KeepAlive(proc);

static class T
{
    public delegate void TimerProc(IntPtr h, int m, IntPtr id, uint t);
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public int message; public IntPtr wParam, lParam; public uint time; public int x, y; }
    [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr h, nint id, int ms, IntPtr proc);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, int a, int b);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
}
