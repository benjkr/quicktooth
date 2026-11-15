using Microsoft.Win32;

namespace QuickTooth;

/// <summary>"Start with Windows" via HKCU\Software\Microsoft\Windows\CurrentVersion\Run\QuickTooth.</summary>
internal static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "QuickTooth";

    private static string ExePath => Environment.ProcessPath ?? throw new InvalidOperationException("no process path");

    public static string? CurrentValue()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) as string;
    }

    public static bool IsEnabled() => !string.IsNullOrWhiteSpace(CurrentValue());

    public static void Enable()
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        key.SetValue(ValueName, $"\"{ExePath}\"", RegistryValueKind.String);
        Log.Info($"autostart on: \"{ExePath}\"");
    }

    public static void Disable()
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        key.DeleteValue(ValueName, throwOnMissingValue: false);
        Log.Info("autostart off");
    }
}
