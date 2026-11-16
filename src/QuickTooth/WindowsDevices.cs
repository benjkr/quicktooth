using QuickTooth.Native;

namespace QuickTooth;

/// <summary>
/// The real Bluetooth side for <see cref="TrayController"/>: Core Audio / KS on the MTA
/// <see cref="DeviceWorker"/>, the PnP link and battery properties, and the BLE battery scan.
/// </summary>
internal sealed class WindowsDevices : IDeviceBackend, IDisposable
{
    private readonly DeviceWorker _worker = new();
    private readonly BluetoothAudio _audio = new();

    public WindowsDevices() => _audio.EndpointChanged += _ => EndpointChanged?.Invoke();

    /// <summary>Raised on an audio-service thread.</summary>
    public event Action? EndpointChanged;

    public Task RegisterNotifications() => _worker.Run(_audio.RegisterNotifications);

    public Task<(Snapshot Snap, int? WindowsBattery)> Refresh(string? mac) =>
        _worker.Run(() => (_audio.Enumerate(), mac != null ? PnpEndpoints.BluetoothBattery(mac) : null));

    public Task<IReadOnlyList<SendResult>> SendOneShot(Guid containerId, OneShot op) =>
        _worker.Run(() => _audio.SendOneShot(containerId, op));

    public Task<bool?> BluetoothConnected(string mac) => _worker.Run(() => PnpEndpoints.BluetoothConnected(mac));

    public Task<BatteryReading?> ScanBattery(ushort model, TimeSpan window) => BleBatteryScanner.ScanAsync(model, window);

    public void Dispose() => _worker.Dispose();
}
