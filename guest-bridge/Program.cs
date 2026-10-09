// Orbita guest bridge —— 跑在 Windows Sandbox 内的极简 HTTP 服务（PR1，仅截图）。
//
// 职责：
//   1. 绑定 0.0.0.0:<listen-port>（宿主经沙箱 NAT 访问，必须绑全接口）；
//   2. 把宿主 IP 解析为本机默认网关（沙箱的虚拟网卡网关即宿主），每 2 秒 POST
//      http://<网关>:<host-port>/register 上报自己的监听端口，直到拿到 200；
//   3. 对外提供 GET /health 与 GET /screenshot，全部要求 Bearer token。
//
// 编译：node build.mjs（用 Windows 自带的 .NET Framework 4.x csc.exe，零第三方依赖）。
// 约束：单文件、单进程、无持久化——沙箱每次重置即消失，不需要任何清理逻辑。
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    // ---- 协议常量：与宿主侧（Orbita 主进程）严格对齐，一个字母都不能差 ----
    private const string Version = "0.1.0";
    private const int DefaultHostPort = 52740;   // 宿主 register 服务的端口
    private const int DefaultListenPort = 52741; // 本桥默认监听端口
    private const int RegisterIntervalMs = 2000; // 注册重试间隔

    private static int _hostPort = DefaultHostPort;
    private static int _listenPort = DefaultListenPort;
    private static string _token = "";
    // 测试用：显式指定宿主 IP，跳过默认网关发现（沙箱内不传该参数，走网关）。
    private static string _hostIpOverride;

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

        TcpListener listener;
        try
        {
            listener = new TcpListener(IPAddress.Any, _listenPort);
            listener.Start();
        }
        catch (Exception ex)
        {
            Log("监听端口 " + _listenPort + " 失败：" + ex.Message);
            return 1;
        }
        // --listen-port 0（测试场景）时取系统分配的实际端口，后续注册上报它
        _listenPort = ((IPEndPoint)listener.LocalEndpoint).Port;

        Log("启动：版本 " + Version
            + "，监听 0.0.0.0:" + _listenPort
            + "，宿主 " + (_hostIpOverride ?? "<默认网关>") + ":" + _hostPort
            + "，token " + _token.Length + " 位");

        Thread acceptThread = new Thread(new ParameterizedThreadStart(AcceptLoop));
        acceptThread.IsBackground = true;
        acceptThread.Start(listener);

        RegisterLoop(); // 阻塞直到注册成功

        Thread.Sleep(Timeout.Infinite); // 主线程保活，HTTP 服务在后台线程继续
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
            switch (flag)
            {
                case "--host-port":
                    if (!TryParsePort(value, ref _hostPort)) return false;
                    break;
                case "--listen-port":
                    if (!TryParsePort(value, ref _listenPort)) return false;
                    break;
                case "--token":
                    _token = value;
                    break;
                case "--host-ip":
                    _hostIpOverride = value;
                    break;
                default:
                    Log("未知参数：" + flag);
                    return false;
            }
        }
        if (string.IsNullOrEmpty(_token))
        {
            Log("缺少 --token 参数");
            return false;
        }
        return true;
    }

    private static bool TryParsePort(string value, ref int port)
    {
        int parsed;
        if (!int.TryParse(value, out parsed) || parsed < 0 || parsed > 65535)
        {
            Log("端口非法：" + value);
            return false;
        }
        port = parsed;
        return true;
    }

    // ---- 注册：发现宿主（默认网关）并上报端口，直到 200 ----

    private static void RegisterLoop()
    {
        string lastGateway = null;
        while (true)
        {
            string hostIp = _hostIpOverride ?? FindGatewayIp();
            if (hostIp == null)
            {
                Log("尚未发现默认网关，" + (RegisterIntervalMs / 1000) + " 秒后重试");
                Thread.Sleep(RegisterIntervalMs);
                continue;
            }
            if (hostIp != lastGateway)
            {
                Log("宿主地址：" + hostIp + ":" + _hostPort);
                lastGateway = hostIp;
            }
            if (TryRegister(hostIp)) return;
            Thread.Sleep(RegisterIntervalMs);
        }
    }

    // 宿主 IP = 本机默认网关（沙箱内虚拟网卡的网关就是宿主）
    private static string FindGatewayIp()
    {
        try
        {
            NetworkInterface[] nics = NetworkInterface.GetAllNetworkInterfaces();
            foreach (NetworkInterface nic in nics)
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                GatewayIPAddressInformationCollection gateways = nic.GetIPProperties().GatewayAddresses;
                foreach (GatewayIPAddressInformation gw in gateways)
                {
                    if (gw.Address != null && gw.Address.AddressFamily == AddressFamily.InterNetwork)
                        return gw.Address.ToString();
                }
            }
        }
        catch (Exception ex)
        {
            Log("网关发现异常：" + ex.Message);
        }
        return null;
    }

    private static bool TryRegister(string hostIp)
    {
        string url = "http://" + hostIp + ":" + _hostPort + "/register";
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Proxy = null; // 沙箱内不应有代理，直连
            req.Timeout = 5000;
            req.ReadWriteTimeout = 5000;
            req.KeepAlive = false;
            req.Headers[HttpRequestHeader.Authorization] = "Bearer " + _token;
            byte[] body = Encoding.UTF8.GetBytes("{\"port\":" + _listenPort.ToString() + "}");
            req.ContentLength = body.Length;
            Stream requestStream = req.GetRequestStream();
            try { requestStream.Write(body, 0, body.Length); }
            finally { requestStream.Dispose(); }

            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                if (resp.StatusCode == HttpStatusCode.OK)
                {
                    Log("注册成功 → " + url + "（port=" + _listenPort + "）");
                    return true;
                }
                Log("注册响应异常 HTTP " + (int)resp.StatusCode + "，重试");
            }
        }
        catch (WebException we)
        {
            HttpWebResponse resp = we.Response as HttpWebResponse;
            if (resp != null)
                Log("注册被拒 HTTP " + (int)resp.StatusCode + "（" + we.Message + "），重试");
            else
                Log("注册失败：" + we.Message + "，重试");
        }
        catch (Exception ex)
        {
            Log("注册失败：" + ex.Message + "，重试");
        }
        return false;
    }

    // ---- HTTP 服务（手写 TcpListener，避免 HttpListener 的 URL ACL 依赖）----

    private static void AcceptLoop(object state)
    {
        TcpListener listener = (TcpListener)state;
        while (true)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch (Exception ex)
            {
                Log("Accept 失败：" + ex.Message);
                Thread.Sleep(200);
                continue;
            }
            ThreadPool.QueueUserWorkItem(new WaitCallback(HandleClient), client);
        }
    }

    private static void HandleClient(object state)
    {
        TcpClient client = (TcpClient)state;
        NetworkStream stream = null;
        try
        {
            client.ReceiveTimeout = 10000;
            client.NoDelay = true;
            stream = client.GetStream();

            string head = ReadHead(stream);
            if (head == null)
            {
                WriteResponse(stream, 400, "Bad Request", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("请求头不完整"), null);
                return;
            }
            string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] parts = lines[0].Split(' ');
            if (parts.Length < 2)
            {
                WriteResponse(stream, 400, "Bad Request", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("请求行不完整"), null);
                return;
            }
            string method = parts[0];
            string target = parts[1];
            string path = target;
            string query = "";
            int q = target.IndexOf('?');
            if (q >= 0)
            {
                path = target.Substring(0, q);
                query = target.Substring(q + 1);
            }

            // 所有请求先过 token，再看路径（鉴权优先于 404）
            string auth = FindHeader(lines, "Authorization");
            if (auth == null || auth != "Bearer " + _token)
            {
                Log("收到请求: " + method + " " + path + " → 401（token 无效或缺失）");
                WriteResponse(stream, 401, "Unauthorized", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("unauthorized"), null);
                return;
            }
            if (method != "GET")
            {
                Log("收到请求: " + method + " " + path + " → 405");
                WriteResponse(stream, 405, "Method Not Allowed", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("仅支持 GET"), null);
                return;
            }
            if (path == "/health")
            {
                byte[] body = Encoding.UTF8.GetBytes("{\"ok\":true,\"version\":\"" + Version + "\"}");
                Log("收到请求: GET /health → 200");
                WriteResponse(stream, 200, "OK", "application/json", body, null);
                return;
            }
            if (path == "/screenshot")
            {
                HandleScreenshot(stream, query);
                return;
            }
            Log("收到请求: GET " + path + " → 404");
            WriteResponse(stream, 404, "Not Found", "text/plain; charset=utf-8",
                Encoding.UTF8.GetBytes("not found"), null);
        }
        catch (Exception ex)
        {
            Log("处理请求异常：" + ex.GetType().Name + " " + ex.Message);
        }
        finally
        {
            TryDrain(stream);
            try { client.Close(); } catch { }
        }
    }

    private static void HandleScreenshot(NetworkStream stream, string query)
    {
        int maxWidth = 1280; // 缺省 1280
        bool hasMaxWidth = false;
        string[] pairs = query.Split(new char[] { '&' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string pair in pairs)
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            if (!string.Equals(pair.Substring(0, eq), "maxWidth", StringComparison.OrdinalIgnoreCase)) continue;
            hasMaxWidth = true;
            int parsed;
            if (!int.TryParse(pair.Substring(eq + 1), out parsed) || parsed <= 0)
            {
                Log("收到请求: GET /screenshot → 400（maxWidth 非法）");
                WriteResponse(stream, 400, "Bad Request", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("maxWidth 必须是正整数"), null);
                return;
            }
            maxWidth = parsed;
        }

        byte[] jpeg;
        int nativeW, nativeH, outW, outH;
        try
        {
            CaptureJpeg(maxWidth, out jpeg, out nativeW, out nativeH, out outW, out outH);
        }
        catch (Exception ex)
        {
            // 截图失败（例如在无桌面会话里）：503 + 可读错误文本
            Log("收到请求: GET /screenshot → 503（" + ex.Message + "）");
            WriteResponse(stream, 503, "Service Unavailable", "text/plain; charset=utf-8",
                Encoding.UTF8.GetBytes("截图失败：" + ex.Message), null);
            return;
        }

        string[] extraHeaders = new string[]
        {
            "X-Native-Width: " + nativeW,
            "X-Native-Height: " + nativeH,
        };
        Log("收到请求: GET /screenshot" + (hasMaxWidth ? "?maxWidth=" + maxWidth : "")
            + " → 200（原始 " + nativeW + "x" + nativeH + "，输出 " + outW + "x" + outH
            + "，" + jpeg.Length + " 字节）");
        WriteResponse(stream, 200, "OK", "image/jpeg", jpeg, extraHeaders);
    }

    // BitBlt 抓主屏全屏（Graphics.CopyFromScreen 内部即 BitBlt SRCCOPY），
    // 等比缩放到长边 ≤ maxWidth（只缩不放），JPEG quality 80 输出。
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

    // ---- HTTP 细节 ----

    // 读请求头，读到 \r\n\r\n 为止；超过 64KB 或连接断开视为无效
    private static string ReadHead(NetworkStream stream)
    {
        MemoryStream buf = new MemoryStream();
        byte[] tmp = new byte[4096];
        while (buf.Length < 64 * 1024)
        {
            int n = stream.Read(tmp, 0, tmp.Length);
            if (n <= 0) return null;
            buf.Write(tmp, 0, n);
            byte[] data = buf.GetBuffer();
            int len = (int)buf.Length;
            for (int i = 3; i < len; i++)
            {
                if (data[i] == (byte)'\n' && data[i - 1] == (byte)'\r'
                    && data[i - 2] == (byte)'\n' && data[i - 3] == (byte)'\r')
                {
                    return Encoding.ASCII.GetString(data, 0, len);
                }
            }
        }
        return null;
    }

    private static string FindHeader(string[] lines, string name)
    {
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon <= 0) continue;
            if (string.Equals(lines[i].Substring(0, colon).Trim(), name, StringComparison.OrdinalIgnoreCase))
                return lines[i].Substring(colon + 1).Trim();
        }
        return null;
    }

    private static void WriteResponse(NetworkStream stream, int code, string reason, string contentType, byte[] body, string[] extraHeaders)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(code).Append(' ').Append(reason).Append("\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        sb.Append("Connection: close\r\n");
        if (extraHeaders != null)
        {
            foreach (string h in extraHeaders) sb.Append(h).Append("\r\n");
        }
        sb.Append("\r\n");
        byte[] head = Encoding.ASCII.GetBytes(sb.ToString());
        stream.Write(head, 0, head.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    // 半关闭 + 排空：把连接收干净再关，避免客户端还有未读数据时触发 RST 冲掉响应
    private static void TryDrain(NetworkStream stream)
    {
        if (stream == null) return;
        try
        {
            stream.ReadTimeout = 1000;
            byte[] sink = new byte[4096];
            while (stream.Read(sink, 0, sink.Length) > 0) { }
        }
        catch { }
    }

    private static void Log(string msg)
    {
        Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] [bridge] " + msg);
    }
}
