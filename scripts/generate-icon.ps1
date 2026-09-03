# 生成 大算头适配器 图标资源 (PowerShell 薄壳 + C# 绘制内核, 规避 PS GDI+ 方法绑定坑)
# 输出:
#   resources/icon.png  512x512  窗口图标(圆角方块+科技蓝渐变+适配LOGO)
#   resources/icon.ico  16/24/32/48/64/128/256  多尺寸 Windows 图标(exe/任务栏)
#   resources/tray.png  32x32    托盘图标
# 运行: pwsh scripts\generate-icon.ps1

Add-Type -AssemblyName System.Drawing

# 编译引用: 使用 .NET Framework 自带的 System.Drawing.dll (与隐式 mscorlib v4.0.30319 同源, 类型完备无冲突)
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'
$sd = $null
foreach ($p in @($fw, 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.Drawing.dll')) {
    if (Test-Path $p) { $sd = $p; break }
}
if ($null -eq $sd) { throw '未找到 .NET Framework System.Drawing.dll, 无法编译图标生成器' }
$refs = @($sd)

Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class IconGen
{
    const int S = 512;          // 主图尺寸
    const float TILE_R = 104f;  // 外框圆角 (~20%)
    const float PIECE_R = 34f;  // 拼图块圆角
    const float KNOB_R = 44f;   // 卡榫/凹槽半径

    static GraphicsPath RoundedRect(float x, float y, float w, float h, float r)
    {
        var gp = new GraphicsPath();
        float d = r * 2f;
        gp.AddArc(x, y, d, d, 180, 90);
        gp.AddArc(x + w - d, y, d, d, 270, 90);
        gp.AddArc(x + w - d, y + h - d, d, d, 0, 90);
        gp.AddArc(x, y + h - d, d, d, 90, 90);
        gp.CloseFigure();
        return gp;
    }

    static Bitmap DrawMaster()
    {
        var bmp = new Bitmap(S, S, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            Color blueTop = Color.FromArgb(255, 13, 139, 255);
            Color blueBot = Color.FromArgb(255, 7, 82, 223);
            Color piece2  = Color.FromArgb(255, 217, 235, 255);
            Color pieceLine = Color.FromArgb(255, 220, 240, 255);
            Color shadow  = Color.FromArgb(90, 3, 45, 150);
            Color greenOk = Color.FromArgb(255, 0, 230, 118);

            // 1) 圆角底座 + 科技蓝垂直渐变
            using (var tile = RoundedRect(0, 0, S, S, TILE_R))
            using (var grad = new LinearGradientBrush(
                new RectangleF(0, 0, S, S), blueTop, blueBot, LinearGradientMode.Vertical))
            {
                g.FillPath(grad, tile);

                // 2) 左上高光(科技感)
                g.SetClip(tile);
                using (var glow = new GraphicsPath())
                {
                    glow.AddEllipse(-60, -60, 480, 380);
                    using (var pb = new PathGradientBrush(glow))
                    {
                        pb.CenterColor = Color.FromArgb(70, 255, 255, 255);
                        pb.SurroundColors = new[] { Color.FromArgb(0, 255, 255, 255) };
                        g.FillRectangle(pb, -80, -80, 640, 480);
                    }
                }
                g.ResetClip();

                // 3) 适配LOGO: AI芯片 + 3×3应用矩阵 (芯片=处理器/适配器, AI矩阵=AI服务)
                Color chipBody = Color.FromArgb(255, 30, 58, 95);
                Color aiBlue = Color.FromArgb(255, 37, 99, 235);
                Color teal = Color.FromArgb(255, 20, 184, 166);
                Color green = Color.FromArgb(255, 34, 197, 94);
                Color darkGrid = Color.FromArgb(255, 51, 65, 85);

                // 3.1) 芯片主体（深蓝圆角矩形）
                using (var chipBrush = new SolidBrush(chipBody))
                using (var chipPath = RoundedRect(116, 116, 280, 280, 20))
                    g.FillPath(chipBrush, chipPath);

                // 3.2) 上下引脚（白色小矩形，各4个）
                using (var pinBrush = new SolidBrush(Color.White))
                {
                    for (int i = 0; i < 4; i++)
                    {
                        float px = 156 + i * 55;
                        g.FillRectangle(pinBrush, px, 86, 20, 30);
                        g.FillRectangle(pinBrush, px, 396, 20, 30);
                    }
                }

                // 3.3) 左右侧翼（深蓝矩形 + 条纹）
                using (var wingBrush = new SolidBrush(chipBody))
                using (var wing1 = RoundedRect(60, 200, 56, 112, 8))
                using (var wing2 = RoundedRect(396, 200, 56, 112, 8))
                {
                    g.FillPath(wingBrush, wing1);
                    g.FillPath(wingBrush, wing2);
                }
                using (var stripeBrush = new SolidBrush(aiBlue))
                {
                    for (int i = 0; i < 3; i++)
                        g.FillRectangle(stripeBrush, 72, 220 + i * 28, 32, 8);
                }
                using (var stripeBrush = new SolidBrush(green))
                {
                    for (int i = 0; i < 3; i++)
                        g.FillRectangle(stripeBrush, 408, 220 + i * 28, 32, 8);
                }

                // 3.4) 中央屏幕（白色圆角矩形）
                using (var screenBrush = new SolidBrush(Color.White))
                using (var screenPath = RoundedRect(156, 156, 200, 200, 16))
                    g.FillPath(screenBrush, screenPath);

                // 3.5) 3×3 网格（9个格子）
                float[] cellX = { 171, 236, 301, 171, 236, 301, 171, 236, 301 };
                float[] cellY = { 171, 171, 171, 236, 236, 236, 301, 301, 301 };
                Color[] cellC = { aiBlue, darkGrid, teal, darkGrid, aiBlue, darkGrid, green, darkGrid, aiBlue };
                for (int i = 0; i < 9; i++)
                {
                    using (var cb = new SolidBrush(cellC[i]))
                    using (var cp = RoundedRect(cellX[i], cellY[i], 55, 55, 6))
                        g.FillPath(cb, cp);
                }

                // 3.6) "AI" 文字（左上格 + 中格）
                using (var font = new Font("Arial", 28f, FontStyle.Bold))
                using (var sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    g.DrawString("AI", font, Brushes.White, new RectangleF(171, 171, 55, 55), sf);
                    g.DrawString("AI", font, Brushes.White, new RectangleF(236, 236, 55, 55), sf);
                }

                // 4) 外框深蓝描边
                using (var pen0 = new Pen(Color.FromArgb(255, 5, 72, 216), 5f))
                    g.DrawPath(pen0, tile);
            }
        }
        return bmp;
    }

    static Bitmap Scale(Bitmap src, int size)
    {
        var outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(outBmp))
        {
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            g.DrawImage(src, 0, 0, size, size);
        }
        return outBmp;
    }

    public static void Generate(string outDir)
    {
        using (var master = DrawMaster())
        {
            master.Save(Path.Combine(outDir, "icon.png"), ImageFormat.Png);

            using (var tray = Scale(master, 32))
                tray.Save(Path.Combine(outDir, "tray.png"), ImageFormat.Png);

            int[] sizes = { 256, 128, 64, 48, 32, 24, 16 };
            byte[][] datas = new byte[sizes.Length][];
            for (int i = 0; i < sizes.Length; i++)
            {
                using (var img = Scale(master, sizes[i]))
                using (var ms = new MemoryStream())
                {
                    img.Save(ms, ImageFormat.Png);
                    datas[i] = ms.ToArray();
                }
            }
            using (var fs = File.Create(Path.Combine(outDir, "icon.ico")))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write((ushort)0);                 // reserved
                bw.Write((ushort)1);                 // type = icon
                bw.Write((ushort)sizes.Length);      // count
                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)
                {
                    byte wh = sizes[i] >= 256 ? (byte)0 : (byte)sizes[i];
                    bw.Write(wh);                    // width
                    bw.Write(wh);                    // height
                    bw.Write((byte)0);               // palette
                    bw.Write((byte)0);               // reserved
                    bw.Write((ushort)1);             // planes
                    bw.Write((ushort)32);            // bpp
                    bw.Write((uint)datas[i].Length);
                    bw.Write((uint)offset);
                    offset += datas[i].Length;
                }
                foreach (var d in datas) bw.Write(d);
            }
        }
    }
}
'@ -Language CSharp

$outRes = Join-Path (Split-Path -Parent $PSScriptRoot) 'resources'
[IconGen]::Generate($outRes)
Write-Host "OK -> $outRes"