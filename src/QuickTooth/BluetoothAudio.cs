using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Text;
using System.Text.RegularExpressions;
using QuickTooth.Native;

namespace QuickTooth;

internal enum OneShot { Connect, Disconnect }

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
    public bool Active => State == CoreAudio.DEVICE_STATE_ACTIVE;
    public bool IsA2dp => BthDeviceId.Contains(@"\bthenum#", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A Bluetooth audio device: all its render endpoints, grouped by container ID.</summary>
internal sealed record BtDevice(Guid ContainerId, string Name, string? Mac, IReadOnlyList<BtEndpoint> Endpoints)
{
    /// <summary>Connected if any of its endpoints (A2DP or HFP) is ACTIVE.</summary>
    public bool Connected => Endpoints.Any(e => e.Active);

    /// <summary>Compact state signature, used to log transitions.</summary>
    public string StateSignature => string.Join(", ", Endpoints.Select(e => $"{(e.IsA2dp ? "A2DP" : "HFP")}={CoreAudio.StateName(e.State)}"));
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

/// <summary>
/// Bluetooth audio connect/disconnect through the Bluetooth audio driver's one-shot KS properties
/// (the approach used by ToothTray). Every method must run on the same MTA thread
/// (<see cref="DeviceWorker"/>).
/// </summary>
internal sealed partial class BluetoothAudio
{
    private static readonly Regex MacRegex = new(@"&([0-9a-f]{12})_c[0-9a-f]+#", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private IMMDeviceEnumerator? _enumerator;
    private NotificationClient? _client; // rooted: the audio service only holds a raw COM pointer

    private IMMDeviceEnumerator Enumerator => _enumerator ??= CoreAudio.CreateEnumerator();

    /// <summary>Raised on an arbitrary audio-service thread. Handlers must only post a message.</summary>
    public event Action<string>? EndpointChanged;

    public void RegisterNotifications()
    {
        if (_client != null) return;
        _client = new NotificationClient(this);
        int hr = Enumerator.RegisterEndpointNotificationCallback(_client);
        Log.Info($"RegisterEndpointNotificationCallback hr=0x{hr:X8}");
        if (hr != 0) _client = null;
    }

    /// <summary>Enumerates every render endpoint and groups the Bluetooth ones by container ID.</summary>
    public Snapshot Enumerate(bool probeKsControl = false, bool includeOthers = false)
    {
        var endpoints = new List<BtEndpoint>();
        var others = new List<OtherEndpoint>();
        var com = new ComBag();
        string? error = null;
        try
        {
            foreach (var (device, hidden) in RenderEndpoints(com))
            {
                try
                {
                    var ep = ReadEndpoint(device, hidden, com, probeKsControl, includeOthers ? others : null);
                    if (ep != null) endpoints.Add(ep);
                }
                catch (Exception ex)
                {
                    Log.Info($"read endpoint: {ex.GetType().Name}: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
            Log.Error("enumerate", ex);
        }
        finally
        {
            com.ReleaseAll();
        }

        var devices = endpoints
            .Where(e => e.ContainerId != Guid.Empty)
            .GroupBy(e => e.ContainerId)
            .Select(g =>
            {
                var eps = g.OrderByDescending(e => e.IsA2dp).ThenBy(e => e.Name, StringComparer.Ordinal).ToList();
                return new BtDevice(g.Key, DisplayName(eps), eps.Select(e => e.Mac).FirstOrDefault(m => m != null), eps);
            })
            .OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
        return new Snapshot { Devices = devices, Others = others, Error = error };
    }

    /// <summary>
    /// Sends the one-shot connect/disconnect to EVERY Bluetooth KS control (A2DP and HFP) of the
    /// device with this exact container ID, as read from each endpoint's own property store.
    /// This is the only place in the app that sends anything to a device.
    /// </summary>
    public IReadOnlyList<SendResult> SendOneShot(Guid containerId, OneShot op, bool a2dpOnly = false)
    {
        if (containerId == Guid.Empty) throw new ArgumentException("empty container id");
        var results = new List<SendResult>();
        var com = new ComBag();
        try
        {
            var targets = new List<(string Name, string BthId)>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (device, _) in RenderEndpoints(com))
            {
                if (ReadContainerId(device, com) != containerId) continue; // never touch any other device
                string name = ReadString(device, com, CoreAudio.PKEY_Device_FriendlyName) ?? "?";
                foreach (var bthId in BluetoothTopologyIds(device, com, out _))
                {
                    if (a2dpOnly && !bthId.Contains(@"\bthenum#", StringComparison.OrdinalIgnoreCase)) continue; // A/B experiment switch
                    if (seen.Add(bthId)) targets.Add((name, bthId));
                }
            }
            // A2DP first, then HFP (stable, and matches the order ToothTray tends to see them in).
            foreach (var (name, bthId) in targets.OrderByDescending(t => t.BthId.Contains(@"\bthenum#", StringComparison.OrdinalIgnoreCase)))
            {
                var ks = ActivateKsControl(bthId, com, out int ksHr);
                if (ks == null)
                {
                    results.Add(new SendResult(name, bthId, ksHr, 0));
                    continue;
                }
                int hr = KsOneShot(ks, op, out uint bytes);
                results.Add(new SendResult(name, bthId, hr, bytes));
            }
        }
        finally
        {
            com.ReleaseAll();
        }

        string prop = op == OneShot.Connect ? "ONESHOT_RECONNECT" : "ONESHOT_DISCONNECT";
        foreach (var r in results)
            Log.Info($"KsProperty {prop} -> hr=0x{r.Hr:X8} bytes={r.BytesReturned}  [{r.EndpointName}]  {r.BthDeviceId}");
        if (results.Count == 0)
            Log.Info($"KsProperty {prop}: no Bluetooth KS controls found for container {containerId:B}");
        return results;
    }

    /// <summary>Read-only diagnostics for one endpoint ID (--probe).</summary>
    public string Probe(string endpointId)
    {
        var com = new ComBag();
        try
        {
            int hr = Enumerator.GetDevice(endpointId, out var device);
            if (hr != 0 || device == null) return $"GetDevice hr=0x{hr:X8}";
            com.Add(device);
            device.GetState(out uint state);
            var ids = BluetoothTopologyIds(device, com, out var all);
            var sb = new StringBuilder();
            sb.AppendLine($"name       {ReadString(device, com, CoreAudio.PKEY_Device_FriendlyName) ?? "?"}");
            sb.AppendLine($"state      {CoreAudio.StateName(state)} ({state})");
            sb.AppendLine($"container  {ReadContainerId(device, com):B}");
            sb.AppendLine($"topology   {(all.Count == 0 ? "-" : string.Join(" | ", all))}");
            foreach (var id in ids)
            {
                ActivateKsControl(id, com, out int ksHr);
                sb.AppendLine($"IKsControl hr=0x{ksHr:X8}  {id}");
            }
            return sb.ToString();
        }
        finally
        {
            com.ReleaseAll();
        }
    }

    /// <summary>
    /// All render endpoints: Core Audio's EnumAudioEndpoints(eRender, ALL), plus PnP render
    /// endpoints it didn't return, present or not (opened with GetDevice). Deduplicated case-insensitively.
    /// </summary>
    private IEnumerable<(IMMDevice Device, bool Hidden)> RenderEndpoints(ComBag com)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int hr = Enumerator.EnumAudioEndpoints(EDataFlow.eRender, CoreAudio.DEVICE_STATEMASK_ALL, out var collection);
        if (hr != 0) throw new COMException("EnumAudioEndpoints failed", hr);
        if (collection == null) throw new COMException("EnumAudioEndpoints returned no collection");
        com.Add(collection);
        collection.GetCount(out uint count);
        for (uint i = 0; i < count; i++)
        {
            if (collection.Item(i, out var device) != 0 || device == null) continue;
            com.Add(device);
            if (device.GetId(out string? id) == 0 && id != null) seen.Add(id);
            yield return (device, false);
        }

        List<string> pnpIds;
        try
        {
            pnpIds = PnpEndpoints.RenderEndpointIds();
        }
        catch (Exception ex)
        {
            Log.Info($"PnP endpoint lookup failed, using Core Audio enumeration only: {ex.Message}");
            yield break;
        }
        foreach (var id in pnpIds)
        {
            if (seen.Contains(id)) continue;
            if (Enumerator.GetDevice(id, out var device) != 0 || device == null) continue;
            com.Add(device);
            seen.Add(id);
            yield return (device, true);
        }
    }

    private static int KsOneShot(IKsControl ks, OneShot op, out uint bytesReturned)
    {
        var prop = new KSPROPERTY
        {
            Set = CoreAudio.KSPROPSETID_BtAudio,
            Id = op == OneShot.Connect ? CoreAudio.KSPROPERTY_ONESHOT_RECONNECT : CoreAudio.KSPROPERTY_ONESHOT_DISCONNECT,
            Flags = CoreAudio.KSPROPERTY_TYPE_GET,
        };
        unsafe
        {
            return ks.KsProperty((IntPtr)(&prop), (uint)sizeof(KSPROPERTY), IntPtr.Zero, 0, out bytesReturned);
        }
    }

    private BtEndpoint? ReadEndpoint(IMMDevice device, bool hidden, ComBag com, bool probeKs, List<OtherEndpoint>? others)
    {
        if (device.GetId(out string? id) != 0 || id == null) return null;
        device.GetState(out uint state);
        string name = ReadString(device, com, CoreAudio.PKEY_Device_FriendlyName) ?? id;
        var bthIds = BluetoothTopologyIds(device, com, out var allIds);
        if (bthIds.Count == 0)
        {
            others?.Add(new OtherEndpoint(id, name, state, allIds.Count > 0 ? string.Join(" | ", allIds) : null));
            return null;
        }
        string bthId = bthIds[0];
        int ksHr = int.MinValue;
        if (probeKs) ActivateKsControl(bthId, com, out ksHr);
        var mac = MacRegex.Match(bthId) is { Success: true } m ? m.Groups[1].Value.ToUpperInvariant() : null;
        return new BtEndpoint(id, name, ReadString(device, com, CoreAudio.PKEY_DeviceInterface_FriendlyName), state,
            bthId, ReadContainerId(device, com), mac, hidden, ksHr);
    }

    /// <summary>
    /// Endpoint -> IDeviceTopology -> each connector -> GetConnectedTo -> IPart -> GetTopologyObject
    /// -> GetDeviceId; keeps the IDs that start with "{2}.\\?\bth" (bthenum = A2DP, bthhfenum = HFP).
    /// </summary>
    private static List<string> BluetoothTopologyIds(IMMDevice device, ComBag com, out List<string> allIds)
    {
        var bth = new List<string>();
        allIds = new List<string>();
        var iid = CoreAudio.IID_IDeviceTopology;
        if (device.Activate(ref iid, CoreAudio.CLSCTX_ALL, IntPtr.Zero, out var topoPtr) != 0 ||
            CoreAudio.Wrap<IDeviceTopology>(topoPtr) is not { } topo)
            return bth;
        com.Add(topo);
        if (topo.GetConnectorCount(out uint n) != 0) return bth;
        for (uint c = 0; c < n; c++)
        {
            if (topo.GetConnector(c, out var connector) != 0 || connector == null) continue;
            com.Add(connector);
            if (connector.GetConnectedTo(out var other) != 0 || other == null) continue; // normal for unconnected connectors
            com.Add(other);
            if (other is not IPart part) continue; // QueryInterface(IPart)
            if (part.GetTopologyObject(out var otherTopo) != 0 || otherTopo == null) continue;
            com.Add(otherTopo);
            if (otherTopo.GetDeviceId(out string? devId) != 0 || devId == null) continue;
            allIds.Add(devId);
            if (devId.StartsWith(@"{2}.\\?\bth", StringComparison.OrdinalIgnoreCase)) bth.Add(devId);
        }
        return bth;
    }

    private IKsControl? ActivateKsControl(string bthDeviceId, ComBag com, out int hr)
    {
        hr = Enumerator.GetDevice(bthDeviceId, out var ksDevice);
        if (hr != 0 || ksDevice == null) return null;
        com.Add(ksDevice);
        var iid = CoreAudio.IID_IKsControl;
        hr = ksDevice.Activate(ref iid, CoreAudio.CLSCTX_ALL, IntPtr.Zero, out var ksPtr);
        if (hr != 0 || CoreAudio.Wrap<IKsControl>(ksPtr) is not { } ks) return null;
        com.Add(ks);
        return ks;
    }

    private static Guid ReadContainerId(IMMDevice device, ComBag com)
    {
        if (!OpenStore(device, com, out var store)) return Guid.Empty;
        var key = CoreAudio.PKEY_Device_ContainerId;
        if (store.GetValue(ref key, out var pv) != 0) return Guid.Empty;
        try { return pv.AsGuid() ?? Guid.Empty; }
        finally { CoreAudio.PropVariantClear(ref pv); }
    }

    private static string? ReadString(IMMDevice device, ComBag com, PROPERTYKEY key)
    {
        if (!OpenStore(device, com, out var store)) return null;
        if (store.GetValue(ref key, out var pv) != 0) return null;
        try { return pv.AsString(); }
        finally { CoreAudio.PropVariantClear(ref pv); }
    }

    private static bool OpenStore(IMMDevice device, ComBag com, [NotNullWhen(true)] out IPropertyStore? store)
    {
        if (device.OpenPropertyStore(CoreAudio.STGM_READ, out store) != 0 || store == null) return false;
        com.Add(store);
        return true;
    }

    /// <summary>The Bluetooth device's own name: the A2DP endpoint's interface name, else the endpoint name.</summary>
    private static string DisplayName(List<BtEndpoint> eps)
    {
        foreach (var e in eps)
            if (!string.IsNullOrWhiteSpace(e.InterfaceName)) return e.InterfaceName!;
        var n = eps[0].Name;
        int open = n.IndexOf('(');
        return open >= 0 && n.EndsWith(')') ? n[(open + 1)..^1] : n;
    }

    /// <summary>
    /// Releases COM wrappers deterministically so KS filter handles don't pile up until a GC.
    /// Every interface we receive is a unique instance (see CoreAudio), which FinalRelease frees,
    /// including interfaces reached through a cast (QueryInterface) on it.
    /// </summary>
    private sealed class ComBag
    {
        private readonly List<ComObject> _items = new();
        public void Add(object? o) { if (o is ComObject c) _items.Add(c); }
        public void ReleaseAll()
        {
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                try { _items[i].FinalRelease(); } catch { }
            }
            _items.Clear();
        }
    }

    [GeneratedComClass]
    private sealed partial class NotificationClient(BluetoothAudio owner) : IMMNotificationClient
    {
        public int OnDeviceStateChanged(string id, uint newState) { owner.Notified(); owner.EndpointChanged?.Invoke(id); return 0; }
        public int OnDeviceAdded(string id) { owner.Notified(); owner.EndpointChanged?.Invoke(id); return 0; }
        public int OnDeviceRemoved(string id) { owner.Notified(); owner.EndpointChanged?.Invoke(id); return 0; }
        public int OnDefaultDeviceChanged(EDataFlow flow, ERole role, string? id) { owner.Notified(); return 0; }
        public int OnPropertyValueChanged(string id, PROPERTYKEY key) { owner.Notified(); return 0; }
    }

    private int _notifications;
    private void Notified() => Interlocked.Increment(ref _notifications);

    /// <summary>Callbacks received from the audio service so far (all kinds; diagnostics).</summary>
    public int NotificationCount => Volatile.Read(ref _notifications);

    /// <summary>
    /// Test hook: calls our own callback object the way the audio service does, through its native
    /// COM vtable (OnDeviceStateChanged, slot 3), and reports whether the managed handler saw the
    /// same endpoint ID. Proves the generated COM callable wrapper works in this build.
    /// </summary>
    public unsafe bool SelfTestCallback()
    {
        var client = new NotificationClient(this);
        string? seen = null;
        void Handler(string id) => seen = id;
        EndpointChanged += Handler;
        void* p = ComInterfaceMarshaller<IMMNotificationClient>.ConvertToUnmanaged(client);
        try
        {
            const string id = "{0.0.0.00000000}.{self-test}";
            var vtbl = *(void***)p;
            var onStateChanged = (delegate* unmanaged[Stdcall]<void*, char*, uint, int>)vtbl[3];
            int hr;
            fixed (char* s = id) hr = onStateChanged(p, s, CoreAudio.DEVICE_STATE_ACTIVE);
            return hr == 0 && seen == id;
        }
        finally
        {
            ComInterfaceMarshaller<IMMNotificationClient>.Free(p);
            EndpointChanged -= Handler;
        }
    }
}
