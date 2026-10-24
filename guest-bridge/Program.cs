// Orbita guest bridge —— 跑在 Windows Sandbox 内的极简命令执行器（PR1，仅截图）。
//
// 通道 = 映射文件夹里的文件，不是网络：
//   宿主防火墙把宿主↔沙箱的 TCP 当成不可测的（2026-10-10 真机：ICMP 通、TCP 被丢，
//   且随每次沙箱启动时好时坏），而 .wsb 读写映射文件夹双向实时同步、每次都可靠。
//   所以：宿主把命令写进 out/cmd/<名字>.req.json（tmp+rename），桥轮询执行，
//   结果写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件），然后删掉 req。
//   宿主读完响应后负责清理 resp/jpg。
//
// 就绪通告：启动完成后写 out/bridge.json（tmp+rename）——它出现即代表命令循环已上线。
//
// 编译：node build.mjs（用 Windows 自带的 .NET Framework 4.x csc.exe，零第三方依赖）。
// 约束：单文件、单进程、无持久化——沙箱每次重置即消失，不需要任何清理逻辑。
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    // ---- 协议常量：与宿主侧（Orbita 主进程）严格对齐，一个字母都不能差 ----
    private const string Version = "0.1.0";
    private const string CmdDirName = "cmd";          // out 下的命令目录
    private const string ReqSuffix = ".req.json";     // 宿主写：命令请求
    private const string RespSuffix = ".resp.json";   // 桥写：执行结果
    private const int PollIntervalMs = 250;           // 命令轮询间隔

    private static string _outDir = "";
    private static string _cmdDir = "";

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const int SM_CXSCREEN = 0; // 主屏宽（进程 DPI aware 后为物理像素）
    private const int SM_CYSCREEN = 1; // 主屏高

    private static int Main(string[] args)
    {
        if (!ParseArgs(args)) return 1;
        try { Console.OutputEncoding = Encoding.UTF8; } catch { } // 无控制台句柄时可能抛异常，忽略
        try { SetProcessDPIAware(); } catch { } // 拿物理像素而不是 DPI 缩放后的逻辑像素

        _cmdDir = Path.Combine(_outDir, CmdDirName);
        try
        {
            Directory.CreateDirectory(_cmdDir);
        }
        catch (Exception ex)
        {
            Log("创建命令目录失败：" + ex.Message);
            return 1;
        }

        Log("启动：版本 " + Version + "，命令目录 " + _cmdDir + "，轮询 " + PollIntervalMs + "ms");

        // 就绪通告：bridge.json 出现 = 命令循环已上线（宿主据此宣布沙箱 running）
        WriteBridgeJson();

        CommandLoop(); // 永续轮询，直到沙箱销毁
        return 0;
    }

    // ---- 参数解析 ----

    private static bool ParseArgs(string[] args)
    {
        int i = 0;
        while (i < args.Length)
        {
            string flag = args[i];
            i++;
            if (i >= args.Length)
            {
                Log("参数 " + flag + " 缺少值");
                return false;
            }
            string value = args[i];
            i++;
            if (flag == "--out-dir")
            {
                _outDir = value;
            }
            else
            {
                Log("未知参数：" + flag);
                return false;
            }
        }
        if (string.IsNullOrEmpty(_outDir))
        {
            Log("缺少 --out-dir 参数");
            return false;
        }
        return true;
    }

    // ---- 就绪通告 ----

    private static void WriteBridgeJson()
    {
        string json = "{\"version\":\"" + Version + "\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}";
        AtomicWrite(Path.Combine(_outDir, "bridge.json"), Encoding.UTF8.GetBytes(json));
        Log("已就绪（bridge.json 已通告）");
    }

    // tmp + rename 原子写：对端可能在任何时刻读，不许读到半截文件
    private static void AtomicWrite(string finalPath, byte[] bytes)
    {
        string tmpPath = finalPath + ".tmp";
        File.WriteAllBytes(tmpPath, bytes);
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(tmpPath, finalPath);
    }

    // ---- 命令循环：轮询 cmd 目录，执行，写响应，删请求 ----

    private static void CommandLoop()
    {
        while (true)
        {
            try
            {
                PollOnce();
            }
            catch (Exception ex)
            {
                // 单轮失败不许弄死循环（映射目录抖动等），记下继续
                Log("轮询异常：" + ex.Message);
            }
            Thread.Sleep(PollIntervalMs);
        }
    }

    private static void PollOnce()
    {
        string[] reqs = Directory.GetFiles(_cmdDir, "*" + ReqSuffix);
        Array.Sort(reqs, StringComparer.Ordinal); // 名字即顺序（宿主命名带递增序号）
        foreach (string reqPath in reqs)
        {
            string name = Path.GetFileName(reqPath);
            string baseName = name.Substring(0, name.Length - ReqSuffix.Length);
            string raw;
            try
            {
                raw = File.ReadAllText(reqPath, Encoding.UTF8);
            }
            catch
            {
                continue; // 宿主 rename 途中的瞬时点，下轮再来
            }
            Log("收到命令 " + name);
            string respJson = Execute(raw, baseName);
            AtomicWrite(Path.Combine(_cmdDir, baseName + RespSuffix), Encoding.UTF8.GetBytes(respJson));
            try { File.Delete(reqPath); } catch { }
        }
    }

    // ---- 命令执行 ----

    private static string Execute(string raw, string baseName)
    {
        string command = ExtractString(raw, "command");
        if (command == null) return "{\"ok\":false,\"error\":\"请求里缺 command 字段\"}";
        // ping = 宿主的就绪探针：映射文件夹 host→guest 方向开机后有 ~20 秒热身期（实测），
        // 桥通告了不代表命令通道已通——宿主必须等到 ping 应答才能宣布 running
        if (command == "ping") return "{\"ok\":true}";
        if (command == "screenshot") return ExecuteScreenshot(raw, baseName);
        return "{\"ok\":false,\"error\":\"未知命令：" + JsonEscape(command) + "\"}";
    }

    private static string ExecuteScreenshot(string raw, string baseName)
    {
        int maxWidth = 1280;
        string maxWidthRaw = ExtractNumber(raw, "maxWidth");
        if (maxWidthRaw != null && (!int.TryParse(maxWidthRaw, out maxWidth) || maxWidth <= 0))
            return "{\"ok\":false,\"error\":\"maxWidth 必须是正整数\"}";

        try
        {
            byte[] jpeg;
            int nativeW, nativeH, outW, outH;
            CaptureJpeg(maxWidth, out jpeg, out nativeW, out nativeH, out outW, out outH);
            string jpgName = baseName + ".jpg";
            AtomicWrite(Path.Combine(_cmdDir, jpgName), jpeg);
            Log("截图完成：原始 " + nativeW + "x" + nativeH + "，输出 " + outW + "x" + outH + "，" + jpeg.Length + " 字节");
            return "{\"ok\":true,\"nativeWidth\":" + nativeW + ",\"nativeHeight\":" + nativeH
                + ",\"width\":" + outW + ",\"height\":" + outH + ",\"jpeg\":\"" + jpgName + "\"}";
        }
        catch (Exception ex)
        {
            Log("截图失败：" + ex.Message);
            return "{\"ok\":false,\"error\":\"截图失败：" + JsonEscape(ex.Message) + "\"}";
        }
    }

    // ---- 极简 JSON 字段抽取（命令是宿主生成的扁平小对象，不值得引 JSON 库） ----

    private static string ExtractString(string json, string field)
    {
        string needle = "\"" + field + "\":\"";
        int start = json.IndexOf(needle, StringComparison.Ordinal);
        if (start < 0) return null;
        start += needle.Length;
        int end = json.IndexOf('"', start);
        if (end < 0) return null;
        return json.Substring(start, end - start);
    }

    private static string ExtractNumber(string json, string field)
    {
        string needle = "\"" + field + "\":";
        int start = json.IndexOf(needle, StringComparison.Ordinal);
        if (start < 0) return null;
        start += needle.Length;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
        return json.Substring(start, end - start);
    }

    private static string JsonEscape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    // ---- 截图（BitBlt 主屏 → 等比缩放 → JPEG q80） ----

    private static void CaptureJpeg(int maxWidth, out byte[] jpeg, out int nativeW, out int nativeH, out int outW, out int outH)
    {
        nativeW = GetSystemMetrics(SM_CXSCREEN);
        nativeH = GetSystemMetrics(SM_CYSCREEN);
        if (nativeW <= 0 || nativeH <= 0)
            throw new InvalidOperationException("无法获取主屏尺寸（可能不在交互式桌面会话中）");

        Bitmap full = new Bitmap(nativeW, nativeH);
        try
        {
            Graphics g = Graphics.FromImage(full);
            try
            {
                g.CopyFromScreen(0, 0, 0, 0, new Size(nativeW, nativeH));
            }
            finally { g.Dispose(); }

            outW = nativeW;
            outH = nativeH;
            int longEdge = Math.Max(nativeW, nativeH);
            if (longEdge > maxWidth)
            {
                double scale = (double)maxWidth / longEdge;
                outW = Math.Max(1, (int)Math.Round(nativeW * scale));
                outH = Math.Max(1, (int)Math.Round(nativeH * scale));
            }

            Bitmap target = full;
            if (outW != nativeW || outH != nativeH)
            {
                target = new Bitmap(outW, outH);
                Graphics g2 = Graphics.FromImage(target);
                try
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.DrawImage(full, new Rectangle(0, 0, outW, outH),
                        new Rectangle(0, 0, nativeW, nativeH), GraphicsUnit.Pixel);
                }
                finally { g2.Dispose(); }
            }
            try { jpeg = EncodeJpeg(target, 80); }
            finally { if (!ReferenceEquals(target, full)) target.Dispose(); }
        }
        finally { full.Dispose(); }
    }

    private static byte[] EncodeJpeg(Bitmap bmp, long quality)
    {
        ImageCodecInfo codec = null;
        ImageCodecInfo[] encoders = ImageCodecInfo.GetImageEncoders();
        foreach (ImageCodecInfo c in encoders)
        {
            if (c.FormatID == ImageFormat.Jpeg.Guid) { codec = c; break; }
        }
        if (codec == null) throw new InvalidOperationException("系统缺少 JPEG 编码器");

        EncoderParameters encoderParams = new EncoderParameters(1);
        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, codec, encoderParams);
            return ms.ToArray();
        }
    }

    private static void Log(string msg)
    {
        Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] [bridge] " + msg);
    }
}
