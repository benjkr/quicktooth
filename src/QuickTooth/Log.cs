namespace QuickTooth;

/// <summary>Tiny append-only log in %APPDATA%\QuickTooth\quicktooth.log (rolled at 512 KB).</summary>
internal static class Log
{
    private static readonly object Gate = new();
    public static string FilePath { get; } = Path.Combine(Settings.Directory, "quicktooth.log");

    /// <summary>Also echo log lines to the console (CLI mode).</summary>
    public static TextWriter? Echo { get; set; }

    public static void Info(string message) => Write(message);

    public static void Error(string context, Exception ex) => Write($"ERROR {context}: {ex}");

    private static void Write(string message)
    {
        string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {message}";
        lock (Gate)
        {
            try
            {
                System.IO.Directory.CreateDirectory(Settings.Directory);
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length > 512 * 1024)
                    File.Move(FilePath, FilePath + ".old", overwrite: true);
                File.AppendAllText(FilePath, line + Environment.NewLine);
            }
            catch
            {
                // logging must never break the app
            }
            Echo?.WriteLine("  log: " + message);
        }
    }
}
