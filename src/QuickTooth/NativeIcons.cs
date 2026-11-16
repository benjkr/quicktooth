using System.Runtime.InteropServices;
using QuickTooth.Native;

namespace QuickTooth;

/// <summary>
/// Turns the shared renderer's pixels into Windows icons (HICON), and writes the --render-icons
/// check sheets through the same HICON path the tray uses (DrawIconEx onto taskbar colours).
/// </summary>
internal static class NativeIcons
{
    /// <summary>The HICON for these pixels, created on first use and owned by the image until <see cref="Release"/>.</summary>
    public static IntPtr HandleFor(IconImage icon)
    {
        if (icon.HostHandle is IntPtr h) return h;
        h = FromBgra(icon.Bgra, icon.Size);
        icon.HostHandle = h;
        return h;
    }

    public static void Release(IconImage icon)
    {
        if (icon.HostHandle is IntPtr h)
        {
            Win32.DestroyIcon(h);
            icon.HostHandle = null;
        }
    }

    /// <summary>Creates a 32-bpp alpha HICON. The caller owns it (DestroyIcon).</summary>
    public static IntPtr CreateIcon(IconState state, bool lightTaskbar, int size) =>
        FromBgra(IconRenderer.RenderBgra(state, lightTaskbar, size), size);

    /// <summary>One animation frame as an HICON (caller owns it).</summary>
    public static IntPtr CreateAnimFrame(AnimPhase phase, double t, double tracerT, bool lightTaskbar, int size) =>
        FromBgra(IconRenderer.RenderAnim(phase, t, tracerT, lightTaskbar, size), size);

    public static unsafe IntPtr FromBgra(byte[] bgra, int size)
    {
        // An icon resource image: BITMAPINFOHEADER (height doubled) + bottom-up XOR pixels + AND mask.
        int xorBytes = size * size * 4;
        int maskStride = (size + 31) / 32 * 4;
        int maskBytes = maskStride * size;
        var res = new byte[40 + xorBytes + maskBytes];
        var span = res.AsSpan();
        BitConverter.TryWriteBytes(span[0..], 40);
        BitConverter.TryWriteBytes(span[4..], size);
        BitConverter.TryWriteBytes(span[8..], size * 2);
        BitConverter.TryWriteBytes(span[12..], (short)1);
        BitConverter.TryWriteBytes(span[14..], (short)32);
        BitConverter.TryWriteBytes(span[20..], xorBytes + maskBytes);
        for (int y = 0; y < size; y++)
            Buffer.BlockCopy(bgra, (size - 1 - y) * size * 4, res, 40 + y * size * 4, size * 4);
        // AND mask stays all zero: the alpha channel decides transparency.
        fixed (byte* p = res)
        {
            var h = Win32.CreateIconFromResourceEx(p, (uint)res.Length, true, 0x00030000, size, size, 0);
            if (h == IntPtr.Zero) throw new InvalidOperationException($"CreateIconFromResourceEx failed ({Marshal.GetLastWin32Error()})");
            return h;
        }
    }

    // ------------------------------------------------------------------ verification images

    /// <summary>Draws an HICON the way the shell does (DrawIconEx) onto an opaque background colour.</summary>
    private static unsafe byte[] DrawIconOnBackground(IntPtr hIcon, int size, Rgb bg)
    {
        var bmi = new Win32.BITMAPINFOHEADER
        {
            biSize = 40, biWidth = size, biHeight = -size, biPlanes = 1, biBitCount = 32,
        };
        var dc = Win32.CreateCompatibleDC(IntPtr.Zero);
        var dib = Win32.CreateDIBSection(dc, ref bmi, 0, out var bits, IntPtr.Zero, 0);
        var old = Win32.SelectObject(dc, dib);
        var p = (byte*)bits;
        for (int i = 0; i < size * size; i++)
        {
            p[i * 4] = bg.B; p[i * 4 + 1] = bg.G; p[i * 4 + 2] = bg.R; p[i * 4 + 3] = 255;
        }
        Win32.DrawIconEx(dc, 0, 0, hIcon, size, size, 0, IntPtr.Zero, Win32.DI_NORMAL);
        var result = new byte[size * size * 4];
        Marshal.Copy(bits, result, 0, result.Length);
        for (int i = 3; i < result.Length; i += 4) result[i] = 255;
        Win32.SelectObject(dc, old);
        Win32.DeleteObject(dib);
        Win32.DeleteDC(dc);
        return result;
    }

    /// <summary>
    /// Writes check sheets: both states on dark and light taskbar colours at 16/20/24/32 px, drawn
    /// through the real HICON path, at 1x and 8x (nearest neighbour). Also writes 240 px renders of
    /// each path (black on white) for comparison with a browser's SVG rendering.
    /// </summary>
    public static List<string> WriteCheckImages(string dir)
    {
        Directory.CreateDirectory(dir);
        var files = new List<string>();
        int[] sizes = [16, 20, 24, 32];
        var themes = new (string Name, bool Light, Rgb Bg)[]
        {
            ("dark", false, new Rgb(0x1C, 0x1C, 0x1C)),
            ("light", true, new Rgb(0xEE, 0xEE, 0xEE)),
        };
        const int pad = 8;
        int cellW = sizes.Sum() + pad * (sizes.Length + 1);
        int rowH = sizes.Max() + pad * 2;
        int width = cellW * themes.Length;
        int height = rowH * 2;
        var sheet = new byte[width * height * 4];

        for (int t = 0; t < themes.Length; t++)
        {
            var (_, light, bg) = themes[t];
            for (int i = 0; i < width * height; i++)
            {
                int x = i % width;
                if (x / cellW != t) continue;
                sheet[i * 4] = bg.B; sheet[i * 4 + 1] = bg.G; sheet[i * 4 + 2] = bg.R; sheet[i * 4 + 3] = 255;
            }
            for (int s = 0; s < 2; s++)
            {
                var state = s == 0 ? IconState.Connected : IconState.Disconnected;
                int x0 = t * cellW + pad;
                foreach (int size in sizes)
                {
                    var hIcon = CreateIcon(state, light, size);
                    var px = DrawIconOnBackground(hIcon, size, bg);
                    Win32.DestroyIcon(hIcon);
                    int y0 = s * rowH + pad + (sizes.Max() - size) / 2;
                    for (int y = 0; y < size; y++)
                        Buffer.BlockCopy(px, y * size * 4, sheet, ((y0 + y) * width + x0) * 4, size * 4);
                    x0 += size + pad;
                }
            }
        }
        files.Add(Png.Save(Path.Combine(dir, "tray-check-1x.png"), sheet, width, height));
        files.Add(Png.Save(Path.Combine(dir, "tray-check-8x.png"), Scale(sheet, width, height, 8), width * 8, height * 8));

        // Each theme/state at the current 16 px as a standalone file.
        foreach (var (name, light, bg) in themes)
            foreach (var state in new[] { IconState.Connected, IconState.Disconnected })
            {
                var hIcon = CreateIcon(state, light, 16);
                var px = DrawIconOnBackground(hIcon, 16, bg);
                Win32.DestroyIcon(hIcon);
                files.Add(Png.Save(Path.Combine(dir, $"icon16-{name}-{state.ToString().ToLowerInvariant()}.png"), Scale(px, 16, 16, 6), 96, 96));
            }

        // Pending animation, frame by frame at 12 fps, on both taskbars, through the HICON path.
        // Per theme: connecting (1.4 s), landing after 1.4 s of connecting, disconnecting (+0.4 s still pending).
        // Cancelling (a failed connect, after 1.4 s of connecting) goes in a sheet of its own.
        {
            double ft = Tunables.AnimFrameMs / 1000.0;
            var rows = new List<(bool Light, Rgb Bg, AnimPhase Phase, int Frames, double TracerOffset)>();
            var cancelRows = new List<(bool Light, Rgb Bg, AnimPhase Phase, int Frames, double TracerOffset)>();
            foreach (var (_, light, bg) in themes)
            {
                rows.Add((light, bg, AnimPhase.Connecting, 17, 0));
                rows.Add((light, bg, AnimPhase.Landing, (int)Math.Ceiling(Tunables.LandSeconds / ft) + 1, 1.4));
                rows.Add((light, bg, AnimPhase.Disconnecting, (int)Math.Ceiling((Tunables.DisconnectSeconds + 0.4) / ft), 0));
                cancelRows.Add((light, bg, AnimPhase.Cancelling, (int)Math.Ceiling(Tunables.CancelSeconds / ft) + 1, 1.4));
            }
            WriteAnimSheet(dir, "anim-frames", rows, themes[0].Bg, themes[1].Bg, files);
            WriteAnimSheet(dir, "anim-cancel", cancelRows, themes[0].Bg, themes[1].Bg, files);
        }

        // Large renders for parse verification against the SVG.
        foreach (var (file, fill) in new[] { ("large-fill.png", true), ("large-line.png", false) })
        {
            var px = IconRenderer.RenderLargeGlyph(fill);
            var flat = new byte[px.Length];
            for (int i = 0; i < px.Length; i += 4)
            {
                byte v = (byte)(255 - px[i + 3]);
                flat[i] = flat[i + 1] = flat[i + 2] = v; flat[i + 3] = 255;
            }
            files.Add(Png.Save(Path.Combine(dir, file), flat, 240, 240));
        }
        return files;
    }

    private static void WriteAnimSheet(string dir, string name, List<(bool Light, Rgb Bg, AnimPhase Phase, int Frames, double TracerOffset)> rows,
                                       Rgb darkBg, Rgb lightBg, List<string> files)
    {
        const int fs = 16, fpad = 4, cols = 17;
        double ft = Tunables.AnimFrameMs / 1000.0;
        int fw = cols * (fs + fpad) + fpad, fh = rows.Count * (fs + fpad) + fpad;
        var strip = new byte[fw * fh * 4];
        for (int i = 0; i < fw * fh; i++)
        {
            var bg = i / fw < fh / 2 ? darkBg : lightBg; // top half dark, bottom half light
            strip[i * 4] = bg.B; strip[i * 4 + 1] = bg.G; strip[i * 4 + 2] = bg.R; strip[i * 4 + 3] = 255;
        }
        for (int r = 0; r < rows.Count; r++)
        {
            var (light, bg, phase, count, tracerOffset) = rows[r];
            for (int f = 0; f < Math.Min(count, cols); f++)
            {
                double t = f * ft;
                var h = CreateAnimFrame(phase, t, tracerOffset + t, light, fs);
                var px = DrawIconOnBackground(h, fs, bg);
                Win32.DestroyIcon(h);
                int x0 = fpad + f * (fs + fpad), y0 = fpad + r * (fs + fpad);
                for (int y = 0; y < fs; y++)
                    Buffer.BlockCopy(px, y * fs * 4, strip, ((y0 + y) * fw + x0) * 4, fs * 4);
            }
        }
        files.Add(Png.Save(Path.Combine(dir, name + "-1x.png"), strip, fw, fh));
        files.Add(Png.Save(Path.Combine(dir, name + "-6x.png"), Scale(strip, fw, fh, 6), fw * 6, fh * 6));
    }

    private static byte[] Scale(byte[] src, int w, int h, int k)
    {
        var dst = new byte[w * k * h * k * 4];
        for (int y = 0; y < h * k; y++)
            for (int x = 0; x < w * k; x++)
                Buffer.BlockCopy(src, ((y / k) * w + x / k) * 4, dst, (y * w * k + x) * 4, 4);
        return dst;
    }
}
