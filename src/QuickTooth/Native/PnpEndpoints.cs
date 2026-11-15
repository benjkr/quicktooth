using System.Runtime.InteropServices;

namespace QuickTooth.Native;

/// <summary>
/// PnP (CfgMgr32) helpers.
///
/// Render endpoint IDs: on recent Windows 11 builds Core Audio's EnumAudioEndpoints hides a
/// Bluetooth device's Hands-Free (HFP) render endpoint, but its SWD\MMDEVAPI devnode still exists
/// and IMMDeviceEnumerator.GetDevice opens it. Neither source is complete on its own, so callers
/// union this list with EnumAudioEndpoints.
/// </summary>
internal static class PnpEndpoints
{
    private const string Prefix = @"SWD\MMDEVAPI\";
    private const uint CM_GETIDLIST_FILTER_ENUMERATOR = 0x00000001;
    private const uint CM_LOCATE_DEVNODE_PHANTOM = 0x00000001;
    private const int CR_SUCCESS = 0;
    private const int CR_BUFFER_SMALL = 0x1A;

    // DEVPKEY_Device_IsConnected-style flag the Bluetooth stack sets on BTHENUM\DEV_<mac> (what Settings shows).
    private static readonly DEVPROPKEY BluetoothConnectedKey = new(new Guid("83DA6326-97A6-4088-9453-A1923F573B29"), 15);
    // DEVPKEY_Bluetooth_Battery (percentage, BYTE) — reported by some headsets (HFP battery indicators).
    private static readonly DEVPROPKEY BluetoothBatteryKey = new(new Guid("104EA319-6EE2-4701-BD47-8DDBF425BBE5"), 2);

    /// <summary>Render endpoint IDs of SWD\MMDEVAPI devnodes, present or not, e.g. "{0.0.0.00000000}.{guid}" (lower-case).</summary>
    public static List<string> RenderEndpointIds()
    {
        var result = new List<string>();
        foreach (var id in DeviceIds("SWD"))
        {
            if (!id.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) continue;
            string endpointId = id[Prefix.Length..];
            if (endpointId.StartsWith("{0.0.0.", StringComparison.Ordinal)) // {0.0.0} = render, {0.0.1} = capture
                result.Add(endpointId.ToLowerInvariant());
        }
        return result;
    }

    /// <summary>Whether Windows considers the Bluetooth device with this MAC connected (null = unknown).</summary>
    public static bool? BluetoothConnected(string mac)
    {
        var buf = GetBluetoothDeviceProperty(mac, BluetoothConnectedKey);
        return buf is { Length: >= 1 } ? buf[0] != 0 : null;
    }

    /// <summary>Battery percentage Windows has for the Bluetooth device with this MAC, if any.</summary>
    public static int? BluetoothBattery(string mac)
    {
        var buf = GetBluetoothDeviceProperty(mac, BluetoothBatteryKey);
        return buf is { Length: >= 1 } && buf[0] <= 100 ? buf[0] : null;
    }

    private static readonly Dictionary<string, string?> DevNodeByMac = new(StringComparer.OrdinalIgnoreCase);

    private static byte[]? GetBluetoothDeviceProperty(string mac, DEVPROPKEY key)
    {
        try
        {
            string? instanceId;
            lock (DevNodeByMac)
            {
                if (!DevNodeByMac.TryGetValue(mac, out instanceId))
                {
                    string prefix = $@"BTHENUM\DEV_{mac}\";
                    instanceId = DeviceIds("BTHENUM").FirstOrDefault(i => i.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
                    DevNodeByMac[mac] = instanceId;
                }
            }
            if (instanceId == null) return null;
            if (CM_Locate_DevNode(out uint devInst, instanceId, CM_LOCATE_DEVNODE_PHANTOM) != CR_SUCCESS) return null;
            uint size = 16;
            var buf = new byte[size];
            if (CM_Get_DevNode_Property(devInst, ref key, out _, buf, ref size, 0) != CR_SUCCESS || size == 0) return null;
            return buf[..(int)size];
        }
        catch
        {
            return null;
        }
    }

    private static IEnumerable<string> DeviceIds(string enumerator)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            int cr = CM_Get_Device_ID_List_Size(out uint len, enumerator, CM_GETIDLIST_FILTER_ENUMERATOR);
            if (cr != CR_SUCCESS) throw new InvalidOperationException($"CM_Get_Device_ID_List_Size cr={cr}");
            var buffer = new char[len];
            cr = CM_Get_Device_ID_List(enumerator, buffer, len, CM_GETIDLIST_FILTER_ENUMERATOR);
            if (cr == CR_BUFFER_SMALL) continue; // list changed between the two calls
            if (cr != CR_SUCCESS) throw new InvalidOperationException($"CM_Get_Device_ID_List cr={cr}");
            return new string(buffer).Split('\0', StringSplitOptions.RemoveEmptyEntries);
        }
        throw new InvalidOperationException("device list kept changing");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DEVPROPKEY
    {
        public Guid fmtid;
        public uint pid;
        public DEVPROPKEY(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
    }

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Get_Device_ID_List_SizeW")]
    private static extern int CM_Get_Device_ID_List_Size(out uint len, string filter, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Get_Device_ID_ListW")]
    private static extern int CM_Get_Device_ID_List(string filter, [Out] char[] buffer, uint len, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Locate_DevNodeW")]
    private static extern int CM_Locate_DevNode(out uint devInst, string deviceId, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Get_DevNode_PropertyW")]
    private static extern int CM_Get_DevNode_Property(uint devInst, ref DEVPROPKEY key, out uint type, [Out] byte[] buffer, ref uint size, uint flags);
}
