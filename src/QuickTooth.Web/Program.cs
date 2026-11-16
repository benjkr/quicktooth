namespace QuickTooth.Web;

internal static class Program
{
    // The page calls Bridge.Init() after loading; nothing runs at startup.
    private static void Main() { }
}

/// <summary>
/// Runs await continuations immediately, on the one browser thread, when the awaited JS promise
/// settles (FIFO, never nested). Without it the .NET browser runtime resumes them on a later event
/// loop turn, after the simulator's virtual clock has already moved on, so "await delay(100)"
/// could resume at 400 ms instead of 100.
/// </summary>
internal sealed class InlineContext : SynchronizationContext
{
    public static readonly InlineContext Instance = new();
    private readonly Queue<(SendOrPostCallback, object?)> _queue = new();
    private bool _draining;

    public static void Install()
    {
        if (Current != Instance) SetSynchronizationContext(Instance);
    }

    public override void Post(SendOrPostCallback d, object? state)
    {
        _queue.Enqueue((d, state));
        if (_draining) return;
        _draining = true;
        try
        {
            while (_queue.TryDequeue(out var item))
            {
                try { item.Item1(item.Item2); }
                catch (Exception ex) { Log.Error("continuation", ex); }
            }
        }
        finally
        {
            _draining = false;
        }
    }

    public override void Send(SendOrPostCallback d, object? state) => d(state);

    public override SynchronizationContext CreateCopy() => this;
}
