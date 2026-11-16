using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Storage.Streams;

namespace QuickTooth;

/// <summary>
/// Short, passive BLE scans for the target's status advert. Never connects to anything. Each scan
/// stops at the first strong match (the AirPods are in your ears, so they're close), or after the
/// window with the strongest match seen.
/// </summary>
internal static class BleBatteryScanner
{
    private const int StrongRssi = -70, MinRssi = -85;

    /// <summary>Counters from the last finished scan (diagnostics for --battery).</summary>
    public static (int Adverts, int Apple, int Errors) LastScan { get; private set; }

    public static Task<BatteryReading?> ScanAsync(ushort model, TimeSpan window)
    {
        var tcs = new TaskCompletionSource<BatteryReading?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new object();
        BatteryReading? best = null;
        var watcher = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Passive };
        int adverts = 0, apple = 0, errors = 0, logged = 0;

        void Finish()
        {
            try { watcher.Stop(); } catch { }
            Complete();
        }

        void Complete()
        {
            lock (gate)
            {
                if (tcs.Task.IsCompleted) return;
                // Proves the WinRT event path works: adverts heard at all, Apple ones, handler failures.
                LastScan = (adverts, apple, errors);
                Log.Info($"battery scan: {adverts} adverts, {apple} Apple, {errors} handler errors, " +
                         (best != null ? $"reading {best.Buds}% (rssi {best.Rssi})" : "no reading"));
                tcs.TrySetResult(best);
            }
        }

        watcher.Received += (_, e) =>
        {
            try
            {
                Interlocked.Increment(ref adverts);
                if (e.RawSignalStrengthInDBm < MinRssi) return;
                foreach (var md in e.Advertisement.ManufacturerData)
                {
                    if (md.CompanyId != 0x004C) continue;
                    Interlocked.Increment(ref apple);
                    if (md.Data.Length < 9) continue;
                    var bytes = new byte[md.Data.Length];
                    using (var reader = DataReader.FromBuffer(md.Data)) reader.ReadBytes(bytes);
                    var reading = AppleStatusAdvert.Parse(bytes, model, e.RawSignalStrengthInDBm);
                    if (reading == null) continue;
                    bool strong;
                    lock (gate)
                    {
                        if (best == null || reading.Rssi > best.Rssi) best = reading;
                        strong = reading.Rssi >= StrongRssi;
                    }
                    if (strong) Finish();
                }
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref errors);
                if (Interlocked.Increment(ref logged) == 1) Log.Error("battery advert handler", ex);
            }
        };
        watcher.Stopped += (_, e) =>
        {
            if (e.Error != BluetoothError.Success) Log.Info($"battery scan stopped: {e.Error}");
            Complete();
        };

        try
        {
            watcher.Start();
        }
        catch (Exception ex)
        {
            Log.Info($"battery scan unavailable: {ex.Message}");
            tcs.TrySetResult(null);
            return tcs.Task;
        }
        _ = Task.Delay(window).ContinueWith(_ => Finish(), TaskScheduler.Default);
        return tcs.Task;
    }
}
