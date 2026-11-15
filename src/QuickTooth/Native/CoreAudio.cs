using System.Runtime.InteropServices;

namespace QuickTooth.Native;

// Core Audio / DeviceTopology / KS COM interop.
// Vtable order MUST match the Windows SDK headers (mmdeviceapi.h, devicetopology.h,
// ks.h). A wrong order silently calls the wrong method. Every method is PreserveSig
// so failures come back as HRESULTs instead of exceptions.

internal static class CoreAudio
{
    public const uint DEVICE_STATE_ACTIVE = 0x1;
    public const uint DEVICE_STATE_DISABLED = 0x2;
    public const uint DEVICE_STATE_NOTPRESENT = 0x4;
    public const uint DEVICE_STATE_UNPLUGGED = 0x8;
    public const uint DEVICE_STATEMASK_ALL = 0xF;

    public const uint CLSCTX_ALL = 0x17;
    public const uint STGM_READ = 0;

    public const int S_OK = 0;

    public static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static readonly Guid IID_IDeviceTopology = new("2A07407E-6497-4A18-9787-32F79BD0D98F");
    public static readonly Guid IID_IKsControl = new("28F54685-06FD-11D2-B27A-00A0C9223196");

    // ksmedia.h: KSPROPSETID_BtAudio
    public static readonly Guid KSPROPSETID_BtAudio = new("7FA06C40-B8F6-4C7E-8556-E8C33A12E54D");
    public const uint KSPROPERTY_ONESHOT_RECONNECT = 0;
    public const uint KSPROPERTY_ONESHOT_DISCONNECT = 1;
    public const uint KSPROPERTY_TYPE_GET = 0x00000001;

    // functiondiscoverykeys_devpkey.h
    public static readonly PROPERTYKEY PKEY_Device_FriendlyName = new(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
    public static readonly PROPERTYKEY PKEY_Device_ContainerId = new(new Guid("8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c"), 2);
    public static readonly PROPERTYKEY PKEY_DeviceInterface_FriendlyName = new(new Guid("026e516e-b814-414b-83cd-856d6fef4822"), 2);

    public static string StateName(uint state) => state switch
    {
        DEVICE_STATE_ACTIVE => "ACTIVE",
        DEVICE_STATE_DISABLED => "DISABLED",
        DEVICE_STATE_NOTPRESENT => "NOTPRESENT",
        DEVICE_STATE_UNPLUGGED => "UNPLUGGED",
        _ => $"0x{state:X}",
    };

    public static IMMDeviceEnumerator CreateEnumerator()
    {
        var type = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator, throwOnError: true)!;
        return (IMMDeviceEnumerator)Activator.CreateInstance(type)!;
    }

    [DllImport("ole32.dll")]
    public static extern int PropVariantClear(ref PROPVARIANT pvar);
}

internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

[StructLayout(LayoutKind.Sequential)]
internal struct PROPERTYKEY
{
    public Guid fmtid;
    public uint pid;
    public PROPERTYKEY(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
}

// PROPVARIANT is 24 bytes on 64-bit: VARTYPE + 3 reserved WORDs, then a 16-byte union.
[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;

    public const ushort VT_EMPTY = 0;
    public const ushort VT_LPWSTR = 31;
    public const ushort VT_CLSID = 72;

    public readonly string? AsString() => vt == VT_LPWSTR && ptr != IntPtr.Zero ? Marshal.PtrToStringUni(ptr) : null;
    public readonly Guid? AsGuid() => vt == VT_CLSID && ptr != IntPtr.Zero ? Marshal.PtrToStructure<Guid>(ptr) : null;
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IMMDeviceCollection ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient pClient);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient pClient);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out uint pcDevices);
    [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object? ppInterface);
    [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore ppProperties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    [PreserveSig] int GetState(out uint pdwState);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
    [PreserveSig] int Commit();
}

[ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMNotificationClient
{
    [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId, uint dwNewState);
    [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId);
    [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId);
    [PreserveSig] int OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string? pwstrDefaultDeviceId);
    [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId, PROPERTYKEY key);
}

[ComImport, Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDeviceTopology
{
    [PreserveSig] int GetConnectorCount(out uint pCount);
    [PreserveSig] int GetConnector(uint nIndex, out IConnector ppConnector);
    [PreserveSig] int GetSubunitCount(out uint pCount);
    [PreserveSig] int GetSubunit(uint nIndex, out IntPtr ppSubunit);
    [PreserveSig] int GetPartById(uint nId, out IPart ppPart);
    [PreserveSig] int GetDeviceId([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrDeviceId);
    [PreserveSig] int GetSignalPath(IPart pIPartFrom, IPart pIPartTo, [MarshalAs(UnmanagedType.Bool)] bool bRejectMixedPaths, out IntPtr ppParts);
}

[ComImport, Guid("9c2c4058-23f5-41de-877a-df3af236a09e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IConnector
{
    [PreserveSig] int GetType(out int pType);
    [PreserveSig] int GetDataFlow(out int pFlow);
    [PreserveSig] int ConnectTo(IConnector pConnectTo);
    [PreserveSig] int Disconnect();
    [PreserveSig] int IsConnected([MarshalAs(UnmanagedType.Bool)] out bool pbConnected);
    [PreserveSig] int GetConnectedTo(out IConnector ppConTo);
    [PreserveSig] int GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrConnectorId);
    [PreserveSig] int GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrDeviceId);
}

[ComImport, Guid("AE2DE0E4-5BCA-4F2D-AA46-5D13F8FDB3A9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPart
{
    [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrName);
    [PreserveSig] int GetLocalId(out uint pnId);
    [PreserveSig] int GetGlobalId([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrGlobalId);
    [PreserveSig] int GetPartType(out int pPartType);
    [PreserveSig] int GetSubType(out Guid pSubType);
    [PreserveSig] int GetControlInterfaceCount(out uint pCount);
    [PreserveSig] int GetControlInterface(uint nIndex, out IntPtr ppInterfaceDesc);
    [PreserveSig] int EnumPartsIncoming(out IntPtr ppParts);
    [PreserveSig] int EnumPartsOutgoing(out IntPtr ppParts);
    [PreserveSig] int GetTopologyObject(out IDeviceTopology ppTopology);
    [PreserveSig] int Activate(uint dwClsContext, ref Guid refiid, [MarshalAs(UnmanagedType.IUnknown)] out object? ppvObject);
    [PreserveSig] int RegisterControlChangeCallback(ref Guid riid, IntPtr pNotify);
    [PreserveSig] int UnregisterControlChangeCallback(IntPtr pNotify);
}

[ComImport, Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IKsControl
{
    [PreserveSig] int KsProperty(IntPtr Property, uint PropertyLength, IntPtr PropertyData, uint DataLength, out uint BytesReturned);
    [PreserveSig] int KsMethod(IntPtr Method, uint MethodLength, IntPtr MethodData, uint DataLength, out uint BytesReturned);
    [PreserveSig] int KsEvent(IntPtr Event, uint EventLength, IntPtr EventData, uint DataLength, out uint BytesReturned);
}

// ks.h: KSIDENTIFIER { struct { GUID Set; ULONG Id; ULONG Flags; }; LONGLONG Alignment; } = 24 bytes.
[StructLayout(LayoutKind.Sequential, Size = 24)]
internal struct KSPROPERTY
{
    public Guid Set;
    public uint Id;
    public uint Flags;
}
