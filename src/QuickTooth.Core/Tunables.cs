using System.Globalization;
using System.Text;

namespace QuickTooth;

/// <summary>
/// Every timing and animation number the app uses, in one place. The native app only ever uses the
/// defaults; the browser simulator can override any of them by name (qt-sim --tune Travel=2.4) to
/// try a change before committing it here.
/// </summary>
internal static class Tunables
{
    // ---- connect / disconnect (TrayController)
    // Measured on the dev PC: with the Hands-Free control included, reconnects land in ~1–3 s. The
    // timeout leaves room for one resend plus a slow page.
    public static int PendingTimeoutMs { get; set; } = 20000;
    public static int IdlePollMs { get; set; } = 20000;
    public static int PendingPollMs { get; set; } = 500;    // notifications may not fire for hidden endpoints
    public static int ResendAfterMs { get; set; } = 8000;
    public static int LinkTeardownWaitMs { get; set; } = 5000;
    public static int TeardownPollMs { get; set; } = 200;
    public static int TeardownLogAboveMs { get; set; } = 300;
    public static int DebounceMs { get; set; } = 200;       // endpoint notification → refresh
    public static int AddRetryMs { get; set; } = 2000;
    public static int AddMaxAttempts { get; set; } = 60;
    public static int PromoteRetryMs { get; set; } = 3000;
    public static int PromoteMaxAttempts { get; set; } = 10;
    public static int TooltipMaxChars { get; set; } = 127;  // NOTIFYICONDATA.szTip

    // ---- battery
    public static int BatteryCheckMs { get; set; } = 60000;
    public static int FirstBatteryMs { get; set; } = 2500;  // first reading soon after connecting
    public static int BleScanSeconds { get; set; } = 12;
    public static int BatteryMaxAgeMin { get; set; } = 5;
    public static int BatteryShowAgeMin { get; set; } = 15;
    public static int MenuBatteryMaxAgeS { get; set; } = 60;

    // ---- icon and animation (IconRenderer)
    public static int AnimFrameMs { get; set; } = 83;       // ≈ 12 fps nominal (Win32 timers make it ~10.5)
    public static double SpringSeconds { get; set; } = 0.2;
    public static double LandSeconds { get; set; } = 0.5;
    public static double DisconnectSeconds { get; set; } = 0.8;
    public static double CancelSeconds { get; set; } = 0.3;
    public static double Travel { get; set; } = 1.9;        // how far each earbud moves apart (24-unit glyph space)
    public static double TracerPeriod { get; set; } = 1.1;  // seconds per lap
    public static double SpotRadius { get; set; } = 3.0;
    /// <summary>Tracer path: 1 = a short glow running around each earbud's whole outline (head and stem); 0 = the earlier spot circling each head.</summary>
    public static int TracerOutline { get; set; } = 1;
    /// <summary>Outline tracer: how long the lit stretch is, and how far it reaches either side of the edge (glyph units).</summary>
    public static double TracerLength { get; set; } = 6.0;
    public static double TracerWidth { get; set; } = 1.0;
    /// <summary>
    /// How much bigger than the SVG's 24-unit box the glyph is drawn. The artwork spans x 1.33–22.67 /
    /// y 5–18.7, so zoom 1.125 makes it fill the full 16 px width (16 × 10.3 px). tools/airpods_glyph.py
    /// lays the artwork out for exactly this zoom at 16 px (stems on whole pixels), so keep the two in step.
    /// </summary>
    public static double Zoom { get; set; } = 1.125;

    public const string OnDarkTaskbar = "#FFFFFF";
    public const string OnLightTaskbar = "#1A1A1A";

    private static readonly (string Name, Func<double> Get, Action<double> Set)[] Table =
    [
        (nameof(PendingTimeoutMs), () => PendingTimeoutMs, v => PendingTimeoutMs = (int)v),
        (nameof(IdlePollMs), () => IdlePollMs, v => IdlePollMs = (int)v),
        (nameof(PendingPollMs), () => PendingPollMs, v => PendingPollMs = (int)v),
        (nameof(ResendAfterMs), () => ResendAfterMs, v => ResendAfterMs = (int)v),
        (nameof(LinkTeardownWaitMs), () => LinkTeardownWaitMs, v => LinkTeardownWaitMs = (int)v),
        (nameof(TeardownPollMs), () => TeardownPollMs, v => TeardownPollMs = (int)v),
        (nameof(TeardownLogAboveMs), () => TeardownLogAboveMs, v => TeardownLogAboveMs = (int)v),
        (nameof(DebounceMs), () => DebounceMs, v => DebounceMs = (int)v),
        (nameof(AddRetryMs), () => AddRetryMs, v => AddRetryMs = (int)v),
        (nameof(AddMaxAttempts), () => AddMaxAttempts, v => AddMaxAttempts = (int)v),
        (nameof(PromoteRetryMs), () => PromoteRetryMs, v => PromoteRetryMs = (int)v),
        (nameof(PromoteMaxAttempts), () => PromoteMaxAttempts, v => PromoteMaxAttempts = (int)v),
        (nameof(TooltipMaxChars), () => TooltipMaxChars, v => TooltipMaxChars = (int)v),
        (nameof(BatteryCheckMs), () => BatteryCheckMs, v => BatteryCheckMs = (int)v),
        (nameof(FirstBatteryMs), () => FirstBatteryMs, v => FirstBatteryMs = (int)v),
        (nameof(BleScanSeconds), () => BleScanSeconds, v => BleScanSeconds = (int)v),
        (nameof(BatteryMaxAgeMin), () => BatteryMaxAgeMin, v => BatteryMaxAgeMin = (int)v),
        (nameof(BatteryShowAgeMin), () => BatteryShowAgeMin, v => BatteryShowAgeMin = (int)v),
        (nameof(MenuBatteryMaxAgeS), () => MenuBatteryMaxAgeS, v => MenuBatteryMaxAgeS = (int)v),
        (nameof(AnimFrameMs), () => AnimFrameMs, v => AnimFrameMs = (int)v),
        (nameof(SpringSeconds), () => SpringSeconds, v => SpringSeconds = v),
        (nameof(LandSeconds), () => LandSeconds, v => LandSeconds = v),
        (nameof(DisconnectSeconds), () => DisconnectSeconds, v => DisconnectSeconds = v),
        (nameof(CancelSeconds), () => CancelSeconds, v => CancelSeconds = v),
        (nameof(Travel), () => Travel, v => Travel = v),
        (nameof(TracerPeriod), () => TracerPeriod, v => TracerPeriod = v),
        (nameof(SpotRadius), () => SpotRadius, v => SpotRadius = v),
        (nameof(TracerOutline), () => TracerOutline, v => TracerOutline = (int)v),
        (nameof(TracerLength), () => TracerLength, v => TracerLength = v),
        (nameof(TracerWidth), () => TracerWidth, v => TracerWidth = v),
        (nameof(Zoom), () => Zoom, v => Zoom = v),
    ];

    private static readonly Dictionary<string, double> Defaults = Table.ToDictionary(t => t.Name, t => t.Get());

    /// <summary>Sets one tunable by name; false if there is no such name.</summary>
    public static bool Set(string name, double value)
    {
        foreach (var t in Table)
            if (t.Name == name) { t.Set(value); return true; }
        return false;
    }

    public static void ResetAll()
    {
        foreach (var t in Table) t.Set(Defaults[t.Name]);
    }

    /// <summary>All tunables and their current values as a JSON object (plus the two icon colours).</summary>
    public static string ToJson()
    {
        var sb = new StringBuilder("{");
        foreach (var t in Table)
            sb.Append('"').Append(t.Name).Append("\":").Append(t.Get().ToString("R", CultureInfo.InvariantCulture)).Append(',');
        sb.Append($"\"{nameof(OnDarkTaskbar)}\":\"{OnDarkTaskbar}\",\"{nameof(OnLightTaskbar)}\":\"{OnLightTaskbar}\"}}");
        return sb.ToString();
    }
}
