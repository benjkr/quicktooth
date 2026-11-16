using System.Text.RegularExpressions;

namespace QuickTooth;

/// <summary>A battery reading. Apple status adverts give per-bud and case levels in 10 % steps.</summary>
internal sealed record BatteryReading(
    int? Left, int? Right, int? Case, bool BudsCharging, bool CaseCharging, int Rssi, DateTime At, string Source)
{
    /// <summary>The level that matters for listening: the emptier bud (or the single reported level).</summary>
    public int? Buds => Left is int l && Right is int r ? Math.Min(l, r) : Left ?? Right;

    /// <summary>e.g. "30%" or "30% · case 80%"; null when nothing useful is known.</summary>
    public string? Text
    {
        get
        {
            var parts = new List<string>();
            if (Buds is int b) parts.Add($"{b}%{(BudsCharging ? " charging" : "")}");
            if (Case is int c) parts.Add($"case {c}%{(CaseCharging ? " charging" : "")}");
            return parts.Count > 0 ? string.Join(" · ", parts) : null;
        }
    }

    public string Describe() => $"buds {Buds?.ToString() ?? "?"}% (L {Left?.ToString() ?? "?"}, R {Right?.ToString() ?? "?"}), case {Case?.ToString() ?? "?"}, rssi {Rssi}, {Source}";
}

internal static class AppleStatusAdvert
{
    private static readonly Regex ApplePid = new(@"_vid&0001004c_pid&([0-9a-f]{4})", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The Apple model ID (= Bluetooth PID, e.g. 0x2027) of a device, if it is an Apple accessory.</summary>
    public static ushort? ModelOf(BtDevice device)
    {
        foreach (var e in device.Endpoints)
            if (ApplePid.Match(e.BthDeviceId) is { Success: true } m)
                return Convert.ToUInt16(m.Groups[1].Value, 16);
        return null;
    }

    /// <summary>
    /// Parses Apple's "proximity pairing" status message (manufacturer data, company 0x004C, type 0x07),
    /// which AirPods broadcast while out of the case:
    ///   [0]=0x07 [1]=length [2]=prefix [3..4]=model (LE) [5]=status [6]=bud levels (two nibbles)
    ///   [7]=charging flags (high nibble) + case level (low nibble) …
    /// Levels are 0–10 (×10 %); 15 = unknown. Bit 0x20 of the status byte tells which nibble is left.
    /// </summary>
    public static BatteryReading? Parse(byte[] b, ushort model, int rssi)
    {
        if (b.Length < 9 || b[0] != 0x07 || b[1] < 7) return null;
        if ((ushort)(b[3] | (b[4] << 8)) != model) return null;
        bool flipped = (b[5] & 0x20) == 0;
        int hi = b[6] >> 4, lo = b[6] & 0x0F;
        int? left = Level(flipped ? hi : lo), right = Level(flipped ? lo : hi);
        int charging = (b[7] >> 4) & 0x07;
        bool budsCharging = (charging & 0b011) != 0, caseCharging = (charging & 0b100) != 0;
        int? caseLevel = Level(b[7] & 0x0F);
        if (left == null && right == null && caseLevel == null) return null;
        return new BatteryReading(left, right, caseLevel, budsCharging, caseCharging, rssi, DateTime.Now, "ble");
    }

    private static int? Level(int nibble) => nibble <= 10 ? nibble * 10 : null;
}
