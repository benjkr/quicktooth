using System.Text.Json;
using System.Text.Json.Serialization;

namespace QuickTooth;

/// <summary>Persisted in %APPDATA%\QuickTooth\settings.json.</summary>
internal sealed class Settings
{
    public static string Directory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "QuickTooth");

    public static string FilePath { get; } = Path.Combine(Directory, "settings.json");

    /// <summary>Target device, by container ID (primary) and Bluetooth MAC (fallback).</summary>
    public string? TargetContainerId { get; set; }
    public string? TargetMac { get; set; }
    /// <summary>Display only; never used to pick a device.</summary>
    public string? TargetName { get; set; }

    /// <summary>The tray icon was promoted out of the overflow once; never again (respect the user's choice).</summary>
    public bool TrayPromotedOnce { get; set; }

    [JsonIgnore]
    public Guid? TargetGuid => Guid.TryParse(TargetContainerId, out var g) && g != Guid.Empty ? g : null;

    [JsonIgnore]
    public bool HasTarget => TargetGuid != null || !string.IsNullOrEmpty(TargetMac);

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // keep "’" readable
    };

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath), Options) ?? new Settings();
        }
        catch (Exception ex)
        {
            Log.Error("load settings", ex);
        }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            string tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Options));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Error("save settings", ex);
        }
    }

    public void SetTarget(BtDevice device)
    {
        TargetContainerId = device.ContainerId.ToString("B");
        TargetMac = device.Mac;
        TargetName = device.Name;
    }

    /// <summary>
    /// Finds the stored target: by container ID, then by MAC. If a target is stored but absent,
    /// returns null — it never falls back to some other device.
    /// </summary>
    public BtDevice? Resolve(IReadOnlyList<BtDevice> devices)
    {
        if (TargetGuid is Guid g && devices.FirstOrDefault(d => d.ContainerId == g) is { } byId) return byId;
        if (!string.IsNullOrEmpty(TargetMac) &&
            devices.FirstOrDefault(d => string.Equals(d.Mac, TargetMac, StringComparison.OrdinalIgnoreCase)) is { } byMac)
            return byMac;
        return null;
    }

    /// <summary>Stored target if set (never substituted); otherwise the first-run default, saved if <paramref name="persist"/>.</summary>
    public BtDevice? ResolveOrDefault(IReadOnlyList<BtDevice> devices, bool persist)
    {
        if (HasTarget) return Resolve(devices);
        var pick = DefaultTarget(devices);
        if (pick != null && persist)
        {
            SetTarget(pick);
            Save();
            Log.Info($"default target chosen: {pick.Name} {pick.ContainerId:B} MAC {pick.Mac}");
        }
        return pick;
    }

    /// <summary>
    /// First-run default: a device whose name contains "AirPods" (prefer one that's connected).
    /// Only used when no target has ever been stored.
    /// </summary>
    public static BtDevice? DefaultTarget(IReadOnlyList<BtDevice> devices) =>
        devices.Where(d => d.Name.Contains("AirPods", StringComparison.OrdinalIgnoreCase))
               .OrderByDescending(d => d.Connected)
               .FirstOrDefault();
}
