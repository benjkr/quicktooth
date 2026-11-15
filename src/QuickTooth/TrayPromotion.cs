using System.Runtime.InteropServices;
using Microsoft.Win32;
using QuickTooth.Native;

namespace QuickTooth;

/// <summary>
/// Windows 11 keeps per-icon notification-area settings under
/// HKCU\Control Panel\NotifyIconSettings\&lt;id&gt; (ExecutablePath, IsPromoted, …). IsPromoted=1
/// shows the icon on the taskbar instead of in the overflow.
/// </summary>
internal static class TrayPromotion
{
    public enum Result { Promoted, AlreadyPromoted, EntryNotFound, Failed }

    private const string Root = @"Control Panel\NotifyIconSettings";

    public static Result PromoteSelf()
    {
        try
        {
            string exe = Path.GetFullPath(Environment.ProcessPath!);
            using var root = Registry.CurrentUser.OpenSubKey(Root);
            if (root == null) return Result.EntryNotFound;
            var result = Result.EntryNotFound;
            foreach (var name in root.GetSubKeyNames())
            {
                using var key = root.OpenSubKey(name, writable: true);
                if (key?.GetValue("ExecutablePath") is not string path) continue;
                if (!string.Equals(ResolveKnownFolder(path), exe, StringComparison.OrdinalIgnoreCase)) continue;
                if (key.GetValue("IsPromoted") is int v && v == 1)
                {
                    if (result == Result.EntryNotFound) result = Result.AlreadyPromoted;
                    continue;
                }
                key.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                Log.Info($@"NotifyIconSettings\{name}: IsPromoted=1 ({path})");
                result = Result.Promoted;
            }
            return result;
        }
        catch (Exception ex)
        {
            Log.Error("promote tray icon", ex);
            return Result.Failed;
        }
    }

    /// <summary>ExecutablePath may be stored as "{KNOWNFOLDERID}\relative\path.exe".</summary>
    private static string ResolveKnownFolder(string path)
    {
        if (path.Length > 38 && path[0] == '{' && path[37] == '}' && Guid.TryParse(path[..38], out var folderId))
        {
            if (Win32.SHGetKnownFolderPath(ref folderId, 0, IntPtr.Zero, out var p) == 0)
            {
                try { return Path.GetFullPath(Path.Join(Marshal.PtrToStringUni(p), path[38..].TrimStart('\\'))); }
                finally { Marshal.FreeCoTaskMem(p); }
            }
            return path;
        }
        try { return Path.GetFullPath(path); } catch { return path; }
    }
}
