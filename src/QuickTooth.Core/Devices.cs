namespace QuickTooth;

internal enum OneShot { Connect, Disconnect }

/// <summary>Core Audio endpoint states (mmdeviceapi.h DEVICE_STATE_*).</summary>
internal static class DeviceState
{
    public const uint Active = 0x1;
    public const uint Disabled = 0x2;
    public const uint NotPresent = 0x4;
    public const uint Unplugged = 0x8;

    public static string Name(uint state) => state switch
    {
        Active => "ACTIVE",
        Disabled => "DISABLED",
        NotPresent => "NOTPRESENT",
        Unplugged => "UNPLUGGED",
        _ => $"0x{state:X}",
    };
}

/// <summary>One render endpoint whose topology leads to a Bluetooth KS filter.</summary>
internal sealed record BtEndpoint(
    string EndpointId,
    string Name,
    string? InterfaceName,
    uint State,
    string BthDeviceId,
    Guid ContainerId,
    string? Mac,
    bool HiddenFromEnumeration, // found only via PnP (Core Audio's EnumAudioEndpoints omits it)
    int KsActivateHr)           // int.MinValue = not attempted
{
    public bool Active => State == DeviceState.Active;
    public bool IsA2dp => BthDeviceId.Contains(@"\bthenum#", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A Bluetooth audio device: all its render endpoints, grouped by container ID.</summary>
internal sealed record BtDevice(Guid ContainerId, string Name, string? Mac, IReadOnlyList<BtEndpoint> Endpoints)
{
    /// <summary>Connected if any of its endpoints (A2DP or HFP) is ACTIVE.</summary>
    public bool Connected => Endpoints.Any(e => e.Active);

    /// <summary>Compact state signature, used to log transitions.</summary>
    public string StateSignature => string.Join(", ", Endpoints.Select(e => $"{(e.IsA2dp ? "A2DP" : "HFP")}={DeviceState.Name(e.State)}"));
}

/// <summary>A render endpoint that is not Bluetooth (kept only for --list --all diagnostics).</summary>
internal sealed record OtherEndpoint(string EndpointId, string Name, uint State, string? TopologyIds);

internal sealed record SendResult(string EndpointName, string BthDeviceId, int Hr, uint BytesReturned);

internal sealed class Snapshot
{
    public required IReadOnlyList<BtDevice> Devices { get; init; }
    public IReadOnlyList<OtherEndpoint> Others { get; init; } = [];
    public string? Error { get; init; }
}

internal static class SendLog
{
    /// <summary>Logs the outcome of a one-shot send, one line per KS control (BluetoothAudio.SendOneShot).</summary>
    public static void Write(Guid containerId, OneShot op, IReadOnlyList<SendResult> results)
    {
        string prop = op == OneShot.Connect ? "ONESHOT_RECONNECT" : "ONESHOT_DISCONNECT";
        foreach (var r in results)
            Log.Info($"KsProperty {prop} -> hr=0x{r.Hr:X8} bytes={r.BytesReturned}  [{r.EndpointName}]  {r.BthDeviceId}");
        if (results.Count == 0)
            Log.Info($"KsProperty {prop}: no Bluetooth KS controls found for container {containerId:B}");
    }
}
