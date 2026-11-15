using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using QuickTooth.Native;

namespace QuickTooth;

internal enum IconState { Connected, Disconnected }

internal enum AnimPhase { Connecting, Landing, Disconnecting, Cancelling }

/// <summary>
/// Renders the MingCute "airpods" glyphs (Apache-2.0) with WPF at the exact small-icon size and
/// turns them into HICONs. Connected = solid fill at full opacity; disconnected = outline, dimmed.
/// Must be called on an STA thread.
/// </summary>
internal static class IconRenderer
{
    public const double DisconnectedOpacity = 0.45;
    private static readonly Color OnDarkTaskbar = Color.FromRgb(0xFF, 0xFF, 0xFF);
    private static readonly Color OnLightTaskbar = Color.FromRgb(0x1A, 0x1A, 0x1A);

    private static Geometry? _fill, _line;
    private static Geometry Fill => _fill ??= LoadGeometry("airpods-fill.svg");
    private static Geometry Line => _line ??= LoadGeometry("airpods-line.svg");

    private static Geometry LoadGeometry(string resource)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException("missing resource " + resource);
        string svg = new StreamReader(stream).ReadToEnd();
        string d = Regex.Match(svg, "\\sd=\"([^\"]+)\"").Groups[1].Value;
        // F1 = nonzero fill rule, which is SVG's default.
        var g = Geometry.Parse("F1 " + d);
        g.Freeze();
        return g;
    }

    /// <summary>
    /// How much bigger than the SVG's 24-unit box the glyph is drawn. The artwork spans x 2–22 /
    /// y 3.9–20.1, so at zoom 1 it fills only 13.3 × 10.8 px of a 16 px icon; zoom 1.125 makes it
    /// 15 × 12.2 px. Settable for comparison renders (--render-icons … --zoom).
    /// </summary>
    public static double Zoom { get; set; } = 1.125;

    /// <summary>Maps glyph units (24-unit box, centre 12,12) onto an icon of <paramref name="size"/> px at <paramref name="zoom"/>.</summary>
    private static Transform GlyphTransform(int size, double zoom)
    {
        double s = size * zoom / 24.0;
        return new MatrixTransform(s, 0, 0, s, size / 2.0 - 12 * s, size / 2.0 - 12 * s);
    }

    /// <summary>Straight-alpha BGRA, top-down rows.</summary>
    public static byte[] RenderBgra(IconState state, bool lightTaskbar, int size)
    {
        var color = lightTaskbar ? OnLightTaskbar : OnDarkTaskbar;
        double opacity = state == IconState.Connected ? 1.0 : DisconnectedOpacity;
        var geometry = state == IconState.Connected ? Fill : Line;
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(GlyphTransform(size, Zoom));
            dc.DrawGeometry(Brush(color, opacity), null, geometry);
        }
        return Rasterize(visual, size);
    }

    private static byte[] RenderGeometry(Geometry geometry, Color color, double opacity, int size, double scale)
    {
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(new ScaleTransform(scale, scale));
            dc.DrawGeometry(Brush(color, opacity), null, geometry);
        }
        return Rasterize(visual, size);
    }

    private static SolidColorBrush Brush(Color color, double opacity)
    {
        var brush = new SolidColorBrush(Color.FromArgb((byte)Math.Round(255 * Math.Clamp(opacity, 0, 1)), color.R, color.G, color.B));
        brush.Freeze();
        return brush;
    }

    // ------------------------------------------------------------------ pending animation ("tracer")
    //
    // Connecting:    the buds spring apart, then a bright spot circles each earbud (steady brightness,
    //                never loops back to an earlier look) until the connection lands.
    // Landing:       the buds close together while the solid fills up from the bottom.
    // Disconnecting: the solid drains top-down while the buds part, then the outline settles back;
    //                if the disconnect is still pending after that, the tracer runs on the outline.
    // Cancelling:    a connect that failed: the buds glide back and the tracer fades out.
    // Every phase ends exactly on the static connected / not-connected icon.

    public const int AnimFrameMs = 83; // ≈ 12 fps
    public const double SpringSeconds = 0.2, LandSeconds = 0.5, DisconnectSeconds = 0.8, CancelSeconds = 0.3;
    private const double Travel = 1.9;          // how far each earbud moves apart (24-unit glyph space)
    private const double TracerPeriod = 1.1;    // seconds per lap
    private const double OrbitRadius = 4.6, SpotRadius = 3.0;
    private const double GlyphTop = 3.8, GlyphBottom = 20.2;

    /// <summary>One animation frame as an HICON (caller owns it).</summary>
    /// <param name="t">Seconds since the phase started.</param>
    /// <param name="tracerT">Seconds the tracer has been running (continuous across phases).</param>
    public static IntPtr CreateAnimFrame(AnimPhase phase, double t, double tracerT, bool lightTaskbar, int size) =>
        CreateIconFromBgra(RenderAnim(phase, t, tracerT, lightTaskbar, size), size);

    private static double Clamp01(double v) => Math.Clamp(v, 0, 1);
    private static double EaseOut(double t) => 1 - Math.Pow(1 - t, 3);
    private static double EaseInOut(double t) => t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;

    private static byte[] RenderAnim(AnimPhase phase, double t, double tracerT, bool lightTaskbar, int size)
    {
        var color = lightTaskbar ? OnLightTaskbar : OnDarkTaskbar;
        double dx, level, tracer; // bud offset, solid level (0 = none, 1 = full), tracer opacity
        switch (phase)
        {
            case AnimPhase.Connecting:
                dx = Travel * EaseOut(Clamp01(t / SpringSeconds));
                level = 0;
                tracer = Clamp01(t / 0.15);
                break;
            case AnimPhase.Landing:
            {
                double u = Clamp01(t / LandSeconds);
                dx = Travel * (1 - EaseOut(Clamp01(u / 0.5)));       // close the gap in the first half
                level = EaseInOut(Clamp01((u - 0.2) / 0.8));        // fill up from the bottom
                tracer = 1 - Clamp01(u / 0.3);
                break;
            }
            case AnimPhase.Disconnecting:
            {
                double u = Clamp01(t / DisconnectSeconds), a = Clamp01(u / 0.6);
                dx = Travel * EaseOut(a) * (1 - EaseInOut(Clamp01((u - 0.6) / 0.4))); // part, then settle back
                level = 1 - EaseInOut(a);                                          // drain top-down
                tracer = t > DisconnectSeconds ? Clamp01((t - DisconnectSeconds) / 0.15) : 0;
                tracerT = Math.Max(0, t - DisconnectSeconds);
                break;
            }
            default: // Cancelling
            {
                double u = Clamp01(t / CancelSeconds);
                dx = Travel * (1 - EaseOut(u));
                level = 0;
                tracer = 1 - u;
                break;
            }
        }

        // At rest the glyph is drawn at Zoom; apart, the buds shrink back to zoom 1, the size at
        // which the fully-apart pose still fits inside the icon without clipping.
        double poseZoom = Zoom + (Math.Min(Zoom, 1.0) - Zoom) * (dx / Travel);
        double yLevel = GlyphBottom - level * (GlyphBottom - GlyphTop);
        double angle = 2 * Math.PI * tracerT / TracerPeriod;

        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(GlyphTransform(size, poseZoom));
            foreach (var (left, offset) in new[] { (true, -dx), (false, dx) })
            {
                dc.PushTransform(new TranslateTransform(offset, 0));
                dc.PushClip(new RectangleGeometry(new Rect(left ? 0 : 12, 0, 12, 24))); // one earbud per half

                // Above the fill line: the dim outline, plus the tracer spot.
                dc.PushClip(new RectangleGeometry(new Rect(0, 0, 24, yLevel)));
                dc.DrawGeometry(Brush(color, DisconnectedOpacity), null, Line);
                if (tracer > 0.001)
                {
                    // Left spot runs clockwise, right counter-clockwise (mirrored), around each head.
                    double cx = left ? 6.5 : 17.5, dir = left ? 1 : -1;
                    var spot = new Point(cx + dir * OrbitRadius * Math.Sin(angle), 8.5 - OrbitRadius * Math.Cos(angle));
                    dc.PushClip(new EllipseGeometry(spot, SpotRadius, SpotRadius));
                    dc.DrawGeometry(Brush(color, tracer), null, Line);
                    dc.Pop();
                }
                dc.Pop();

                // Below the fill line: solid.
                if (level > 0.001)
                {
                    dc.PushClip(new RectangleGeometry(new Rect(0, yLevel, 24, 24 - yLevel)));
                    dc.DrawGeometry(Brush(color, 1), null, Fill);
                    dc.Pop();
                }

                dc.Pop();
                dc.Pop();
            }
        }
        return Rasterize(visual, size);
    }

    private static byte[] Rasterize(Visual visual, int size)
    {
        var rtb = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
        rtb.Render(visual);
        var px = new byte[size * size * 4];
        rtb.CopyPixels(px, size * 4, 0);
        // Pbgra32 is premultiplied; icon resources use straight alpha.
        for (int i = 0; i < px.Length; i += 4)
        {
            int a = px[i + 3];
            if (a == 0 || a == 255) continue;
            px[i] = (byte)Math.Min(255, (px[i] * 255 + a / 2) / a);
            px[i + 1] = (byte)Math.Min(255, (px[i + 1] * 255 + a / 2) / a);
            px[i + 2] = (byte)Math.Min(255, (px[i + 2] * 255 + a / 2) / a);
        }
        return px;
    }

    /// <summary>Creates a 32-bpp alpha HICON. The caller owns it (DestroyIcon).</summary>
    public static IntPtr CreateIcon(IconState state, bool lightTaskbar, int size) =>
        CreateIconFromBgra(RenderBgra(state, lightTaskbar, size), size);

    private static unsafe IntPtr CreateIconFromBgra(byte[] bgra, int size)
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
    private static unsafe byte[] DrawIconOnBackground(IntPtr hIcon, int size, Color bg)
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
        var files = new List<string>();
        int[] sizes = [16, 20, 24, 32];
        var themes = new (string Name, bool Light, Color Bg)[]
        {
            ("dark", false, Color.FromRgb(0x1C, 0x1C, 0x1C)),
            ("light", true, Color.FromRgb(0xEE, 0xEE, 0xEE)),
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
        files.Add(SavePng(Path.Combine(dir, "tray-check-1x.png"), sheet, width, height));
        files.Add(SavePng(Path.Combine(dir, "tray-check-8x.png"), Scale(sheet, width, height, 8), width * 8, height * 8));

        // Each theme/state at the current 16 px as a standalone file.
        foreach (var (name, light, bg) in themes)
            foreach (var state in new[] { IconState.Connected, IconState.Disconnected })
            {
                var hIcon = CreateIcon(state, light, 16);
                var px = DrawIconOnBackground(hIcon, 16, bg);
                Win32.DestroyIcon(hIcon);
                files.Add(SavePng(Path.Combine(dir, $"icon16-{name}-{state.ToString().ToLowerInvariant()}.png"), Scale(px, 16, 16, 6), 96, 96));
            }

        // Pending animation, frame by frame at 12 fps, on both taskbars, through the HICON path.
        // Per theme: connecting (1.4 s), landing after 1.4 s of connecting, disconnecting (+0.4 s still pending).
        {
            const int fs = 16, fpad = 4, cols = 17;
            double ft = AnimFrameMs / 1000.0;
            var rows = new List<(bool Light, Color Bg, AnimPhase Phase, int Frames, double TracerOffset)>();
            foreach (var (_, light, bg) in themes)
            {
                rows.Add((light, bg, AnimPhase.Connecting, cols, 0));
                rows.Add((light, bg, AnimPhase.Landing, (int)Math.Ceiling(LandSeconds / ft) + 1, 1.4));
                rows.Add((light, bg, AnimPhase.Disconnecting, (int)Math.Ceiling((DisconnectSeconds + 0.4) / ft), 0));
            }
            int fw = cols * (fs + fpad) + fpad, fh = rows.Count * (fs + fpad) + fpad;
            var strip = new byte[fw * fh * 4];
            for (int i = 0; i < fw * fh; i++)
            {
                var bg = themes[i / fw < fh / 2 ? 0 : 1].Bg; // top half dark, bottom half light
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
            files.Add(SavePng(Path.Combine(dir, "anim-frames-1x.png"), strip, fw, fh));
            files.Add(SavePng(Path.Combine(dir, "anim-frames-6x.png"), Scale(strip, fw, fh, 6), fw * 6, fh * 6));
        }

        // Large renders for parse verification against the SVG.
        foreach (var (file, geo) in new[] { ("large-fill.png", Fill), ("large-line.png", Line) })
        {
            var px = RenderGeometry(geo, Colors.Black, 1, 240, 10);
            var flat = new byte[px.Length];
            for (int i = 0; i < px.Length; i += 4)
            {
                byte v = (byte)(255 - px[i + 3]);
                flat[i] = flat[i + 1] = flat[i + 2] = v; flat[i + 3] = 255;
            }
            files.Add(SavePng(Path.Combine(dir, file), flat, 240, 240));
        }
        return files;
    }

    private static byte[] Scale(byte[] src, int w, int h, int k)
    {
        var dst = new byte[w * k * h * k * 4];
        for (int y = 0; y < h * k; y++)
            for (int x = 0; x < w * k; x++)
                Buffer.BlockCopy(src, ((y / k) * w + x / k) * 4, dst, (y * w * k + x) * 4, 4);
        return dst;
    }

    private static string SavePng(string path, byte[] bgra, int w, int h)
    {
        var src = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, bgra, w * 4);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(src));
        using var fs = File.Create(path);
        enc.Save(fs);
        return path;
    }
}
