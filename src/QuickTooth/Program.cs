namespace QuickTooth;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0) return Cli.Run(args);
        return TrayApp.Run();
    }
}
