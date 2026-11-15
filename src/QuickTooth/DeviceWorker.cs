using System.Collections.Concurrent;

namespace QuickTooth;

/// <summary>
/// A dedicated MTA thread that owns all Core Audio / KS COM objects. Work is serialized, so the
/// UI thread never blocks on a device call and enumerations never interleave with a send.
/// </summary>
internal sealed class DeviceWorker : IDisposable
{
    private readonly BlockingCollection<Action> _queue = new();
    private readonly Thread _thread;

    public DeviceWorker()
    {
        _thread = new Thread(Loop) { IsBackground = true, Name = "QuickTooth.Device" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    private void Loop()
    {
        foreach (var action in _queue.GetConsumingEnumerable())
        {
            try { action(); }
            catch (Exception ex) { Log.Error("device worker", ex); }
        }
    }

    public Task<T> Run<T>(Func<T> func)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _queue.Add(() =>
        {
            try { tcs.SetResult(func()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    public Task Run(Action action) => Run(() => { action(); return true; });

    public void Dispose() => _queue.CompleteAdding();
}
