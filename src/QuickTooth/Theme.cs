using Microsoft.Win32;

namespace QuickTooth;

internal static class Theme
{
    /// <summary>
    /// The taskbar follows SystemUsesLightTheme (Windows mode), not AppsUseLightTheme (app mode).
    /// Missing value = dark, the Windows 10/11 taskbar default.
    /// </summary>
    public static bool TaskbarIsLight()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("SystemUsesLightTheme") is int v && v != 0;
        }
        catch
        {
            return false;
        }
    }
}
