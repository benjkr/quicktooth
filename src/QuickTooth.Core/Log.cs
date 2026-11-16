namespace QuickTooth;

/// <summary>
/// The app's log. Lines go to a host-provided sink, which adds the timestamp and process ID: the
/// native app appends to %APPDATA%\QuickTooth\quicktooth.log, the simulator to its virtual-time log.
/// </summary>
internal static class Log
{
    public static Action<string>? Sink { get; set; }

    public static void Info(string message) => Sink?.Invoke(message);

    public static void Error(string context, Exception ex) => Sink?.Invoke($"ERROR {context}: {ex}");
}
