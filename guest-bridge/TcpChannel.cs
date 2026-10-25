// Orbita guest bridge —— TCP 命令通道（0.8.0）。
//
// 为什么加这一条：文件协议**每一跳**的传播实测 2.9–7.5 秒（2026-10-25 真机计量；guest 内部
// 处理只有毫秒级），一次 sandbox_navigate 天然 8–10 秒。同一天的一次性沙箱实验里，宿主→guest
// 的 TCP 完全可用：握手 30ms、小包中位 1ms、64KB 往返 2–6ms、两侧都不用动防火墙。
//
// 这是一条**增量**通道，不是替换：
//   - 文件轮询循环（Program.CommandLoop）行为一个字都没动，它是老宿主的唯一通道，也是
//     TCP 不可用时的回退通道；
//   - 两条通道共用同一个 Execute（Program.Execute），所以回执逐字一致；
//   - 监听起不来只是记一行日志，桥照旧靠文件协议工作（沙箱里网络没起来时就是这样）。
//
// 协议（与宿主侧 src/shared/computer-use.ts 的 bridgeTcpHello 严格一致，改一个字母就是两端脱钩）：
//   1. 首行 {"t":"hello","token":"<bridge.json 里的 token>"}
//      → 对：回 {"t":"hello-ok"}；错：回 {"t":"hello-fail"} 并立刻断开，**不接受任何命令**。
//   2. 命令 {"id":<n>,"command":"<cmd>","fields":{...}}，整行原样交给 Execute
//      （取值器按字段名在整行里找，所以 fields 不必拆出来，与文件协议的 body 同形）。
//   3. 回执 {"id":<n>,"resp":{...}}；截图的 JPEG 内联在 "jpegBase64"。
//      注意 resp 里的 "jpeg" 字段照旧保留（与文件协议逐字一致），只是那个文件被本文件读完即删。
//
// 串行化：命令执行全部过 Program.ExecuteGate（文件轮询线程与每条 TCP 连接线程共用一把锁），
// 所以两条命令不会互相踩 CDP 状态；转给 worker 的 cdp-* 在锁里只是「投递 + 返回 null」，
// 真正的等待在本文件的 WaitHostResp 里、锁外进行——否则一条 40 秒的导航会把别的会话堵死。
//
// 端口与令牌：TcpListener 绑 IPAddress.Any:0（系统分配，不需要预置端口），令牌每次启动
// 随机生成 32 位十六进制。为什么要有令牌：同一个沙箱里跑着 agent 打开的网页，端口不是口令，
// 没有令牌任何本地进程都能发 computer_click。**日志里绝不打令牌真值**（它会进 PR / 截图）。
//
// 测试缝：--selftest-tcp 在本进程里起监听、用 127.0.0.1 连回来，验握手、往返、64KB 大载荷、
// 串行与断线重连。不启 Edge、不碰桌面（宿主上跑得起来）。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;

internal static class TcpChannel
{
    /** 握手阶段等首行的上限：连上却不说话的对端不该占着线程 */
    private const int HandshakeTimeoutMs = 3000;
    /** 一行 JSON 的上限（回执里内联 base64 截图，但请求里没有二进制；8MB 已经远超需要） */
    private const int MaxLineChars = 8 * 1024 * 1024;
    /** 一条 TCP 命令自己的序号前缀：与宿主的 cmd-000001 分开，免得清理逻辑互相踩 */
    private const string BaseNamePrefix = "tcp-";
    /**
     * 转给 worker 之后等回执的预算。
     *
     * 要盖住 worker 的 40 秒杀线 + 杀完之后写回执的那一下（WorkerHost.CommandTimeoutMs），
     * 同时**必须短于宿主的命令线**（cdp-* 70s / 像素 45s，见 shared/computer-use.ts）：
     * 否则宿主先放弃，桥这一侧还在等，模型只看到一句笼统的超时。
     */
    private const int ForwardBudgetMs = 55000;

    private static TcpListener _listener;
    /** 自测收尾时置 true：Accept 被 Stop() 打断是正常退出，不该记一行「失败」 */
    private static bool _stopping = false;
    private static int _port = 0;
    private static string _token = "";
    /** TCP 命令的全局序号（多连接共用，文件名不许撞） */
    private static int _seq = 0;

    /** 监听端口；0 = 没起来（文件协议照旧） */
    internal static int Port
    {
        get { return _port; }
    }

    /** 本次启动的令牌（只写进 bridge.json，日志里绝不打） */
    internal static string Token
    {
        get { return _token; }
    }

    // ---- 启动 ----

    /**
     * 起监听并挂上接受线程。**失败不抛**：返回 false 只是这一侧没有 TCP，桥照旧跑文件协议。
     * 调用点（Program.Main）必须先调它再写 bridge.json——通告里带了端口才代表 TCP 可用。
     */
    internal static bool Start()
    {
        try
        {
            _token = NewToken();
            TcpListener listener = new TcpListener(IPAddress.Any, 0);
            listener.Start();
            _listener = listener;
            _port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Thread accept = new Thread(AcceptLoop);
            accept.IsBackground = true;
            accept.Name = "orbita-tcp-accept";
            accept.Start();
            Log("TCP 通道已监听：0.0.0.0:" + _port + "，本机 IPv4：" + JoinIPv4(LocalIPv4()));
            return true;
        }
        catch (Exception ex)
        {
            Log("TCP 通道启动失败（继续只用文件协议）：" + ex.Message);
            _listener = null;
            _port = 0;
            _token = "";
            return false;
        }
    }

    /** 32 位十六进制随机令牌（CSPRNG；不打印） */
    private static string NewToken()
    {
        byte[] bytes = new byte[16];
        using (System.Security.Cryptography.RNGCryptoServiceProvider rng =
            new System.Security.Cryptography.RNGCryptoServiceProvider())
        {
            rng.GetBytes(bytes);
        }
        StringBuilder sb = new StringBuilder(32);
        for (int i = 0; i < bytes.Length; i++) sb.Append(bytes[i].ToString("x2"));
        return sb.ToString();
    }

    /**
     * 本机所有非回环 IPv4（宿主按这个顺序逐个试连）。
     * 169.254.x.x（APIPA）排到最后：它是「没拿到 DHCP」的地址，基本连不通，但不排除能用。
     */
    internal static List<string> LocalIPv4()
    {
        List<string> normal = new List<string>();
        List<string> apipa = new List<string>();
        try
        {
            NetworkInterface[] all = NetworkInterface.GetAllNetworkInterfaces();
            for (int i = 0; i < all.Length; i++)
            {
                NetworkInterface nic = all[i];
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                UnicastIPAddressInformationCollection addrs = nic.GetIPProperties().UnicastAddresses;
                for (int j = 0; j < addrs.Count; j++)
                {
                    IPAddress address = addrs[j].Address;
                    if (address.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(address)) continue;
                    string text = address.ToString();
                    if (text.StartsWith("169.254.", StringComparison.Ordinal)) apipa.Add(text);
                    else normal.Add(text);
                }
            }
        }
        catch (Exception ex)
        {
            Log("枚举本机 IPv4 失败：" + ex.Message);
        }
        normal.AddRange(apipa);
        return normal;
    }

    /** JSON 数组字面量（bridge.json 的 ipv4 字段） */
    internal static string IPv4Json(List<string> addresses)
    {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < addresses.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append(Program.JsonQuote(addresses[i]));
        }
        return sb.Append("]").ToString();
    }

    private static string JoinIPv4(List<string> addresses)
    {
        if (addresses.Count == 0) return "（无）";
        return string.Join(", ", addresses.ToArray());
    }

    // ---- 接受连接 ----

    private static void AcceptLoop()
    {
        TcpListener listener = _listener;
        while (true)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch (Exception ex)
            {
                if (_stopping) return;
                // 监听被关 / 系统抖动：记一行、稍等再接受。不弄死线程——桥本身还得活着。
                Log("TCP 接受连接失败：" + ex.Message);
                Thread.Sleep(200);
                continue;
            }
            Thread worker = new Thread(delegate() { ServeClient(client); });
            worker.IsBackground = true;
            worker.Name = "orbita-tcp-client";
            worker.Start();
        }
    }

    /**
     * 一条连接的一生：握手 → 循环收发 → 断开。
     * 任何异常都只影响这一条连接（finally 里关 socket），桥与文件协议不受影响。
     */
    private static void ServeClient(TcpClient client)
    {
        string source = "?";
        try
        {
            IPEndPoint remote = client.Client.RemoteEndPoint as IPEndPoint;
            if (remote != null) source = remote.Address.ToString();
        }
        catch { }

        NetworkStream stream = null;
        StreamReader reader = null;
        try
        {
            // 命令是一行一行的：不让 Nagle 把行攒起来（那会平白加 40ms，正是要消灭的成本）
            client.NoDelay = true;
            stream = client.GetStream();
            // 握手阶段必须有超时：连上却不发首行的对端不许占着线程
            client.ReceiveTimeout = HandshakeTimeoutMs;
            reader = new StreamReader(stream, new UTF8Encoding(false));

            string first = reader.ReadLine();
            if (first == null)
            {
                Log("TCP 连接没发首行就断了：" + source);
                return;
            }
            string rejection = HandshakeRejection(first);
            if (rejection != null)
            {
                // 只说原因，**不打令牌真值**（日志会进 PR / 截图）
                Log("TCP 握手失败（" + source + "）：" + rejection + "，已断开，不接受任何命令");
                WriteLine(stream, "{\"t\":" + Program.JsonQuote(Program.TcpHelloFailType) + "}");
                return;
            }
            Log("TCP 握手成功：" + source);
            WriteLine(stream, "{\"t\":" + Program.JsonQuote(Program.TcpHelloOkType) + "}");
            // 之后就是宿主掌控节奏：没有命令时读阻塞在这里（连接断开时 ReadLine 会回 null）。
            // 不设空闲超时：宿主复用同一条连接，10 分钟没操作不该把它掐掉重连。
            client.ReceiveTimeout = 0;

            while (true)
            {
                string line;
                try
                {
                    line = reader.ReadLine();
                }
                catch (Exception ex)
                {
                    Log("TCP 读命令失败（" + source + "）：" + ex.Message);
                    return;
                }
                if (line == null)
                {
                    Log("TCP 连接关闭：" + source);
                    return;
                }
                if (line.Trim().Length == 0) continue;
                if (line.Length > MaxLineChars)
                {
                    Log("TCP 命令超长（" + line.Length + " 字符），断开：" + source);
                    return;
                }
                if (!ServeOne(stream, line, source)) return;
            }
        }
        catch (Exception ex)
        {
            Log("TCP 连接异常（" + source + "）：" + ex.Message);
        }
        finally
        {
            try { if (reader != null) reader.Dispose(); } catch { }
            try { if (stream != null) stream.Dispose(); } catch { }
            try { client.Close(); } catch { }
        }
    }

    /** 首行是不是一次合法握手；返回 null = 通过，否则是给人看的原因（不含令牌真值） */
    private static string HandshakeRejection(string first)
    {
        string type = Program.ExtractJsonString(first, "t");
        if (type == null) return "首行不是 JSON 对象（缺 t 字段）";
        if (type != Program.TcpHelloType) return "首行的 t 不是 hello（实为 " + type + "）";
        string token = Program.ExtractJsonString(first, "token");
        if (token == null || token.Length == 0) return "首行缺 token 字段";
        if (!string.Equals(token, _token, StringComparison.Ordinal)) return "token 不符";
        return null;
    }

    /**
     * 处理一条命令，写回一行回执。返回 false = 这条连接该断（写不出去 / 请求畸形到没法继续）。
     *
     * 与文件协议的关系：Execute 是同一个函数，resp 是同一份 JSON 文本；区别只有
     *   - baseName 用 tcp-<全局序号>（不写 req、不写 resp 文件，截图那张 jpg 写完即读即删）；
     *   - 截图的 JPEG 内联成 base64（回程正是最贵的方向，但 TCP 上 64KB 只要 2–6ms）。
     */
    private static bool ServeOne(NetworkStream stream, string line, string source)
    {
        string command = Program.ExtractJsonString(line, "command");
        long id = 0;
        string idRaw = Program.ExtractNumber(line, "id");
        if (idRaw != null) long.TryParse(idRaw, out id);
        if (command == null)
        {
            return WriteFrame(stream, id, "{\"ok\":false,\"error\":\"请求里缺 command 字段\"}", null);
        }

        int seq = Interlocked.Increment(ref _seq);
        string baseName = BaseNamePrefix + seq.ToString("000000");
        Stopwatch clock = Stopwatch.StartNew();

        string respJson;
        lock (Program.ExecuteGate)
        {
            respJson = Program.Execute(line, baseName);
        }
        long executeMs = clock.ElapsedMilliseconds;
        bool forwarded = respJson == null;

        long waitMs = 0;
        if (forwarded)
        {
            // 锁外等：一条 40 秒的导航不许把别的会话（文件协议 / 其它 TCP 连接）堵住。
            // 回执由 WorkerHost 的后台线程写进 cmd\<baseName>.resp.json，与文件协议同一份产物。
            string waited = WaitHostResp(baseName, ForwardBudgetMs);
            waitMs = clock.ElapsedMilliseconds - executeMs;
            if (waited != null)
            {
                respJson = waited;
            }
            else
            {
                respJson = "{\"ok\":false,\"error\":\"沙箱里的浏览器没有响应（" + Program.JsonEscape(command)
                    + " 超时）——可以再试一次，或用 computer_screenshot 看桌面\"}";
            }
        }

        string jpegBase64 = null;
        string jpegName = Program.ExtractJsonString(respJson, "jpeg");
        if (jpegName != null && jpegName.Length > 0)
        {
            jpegBase64 = ReadAndDropJpeg(jpegName);
        }
        bool written = WriteFrame(stream, id, respJson, jpegBase64);

        string timing = forwarded
            ? "执行 " + executeMs + "ms（投递 worker）+ 等回执 " + waitMs + "ms = " + clock.ElapsedMilliseconds + "ms"
            : "执行 " + clock.ElapsedMilliseconds + "ms";
        Log("TCP 命令 " + command + "（id " + id + "，" + baseName + "）：" + timing
            + (jpegBase64 == null ? "" : "，内联 JPEG " + jpegBase64.Length + " 字符")
            + "，来源 " + source);
        return written;
    }

    /** 等 worker 的回执文件；超时回 null。与文件协议读的是同一个路径、同一份内容。 */
    private static string WaitHostResp(string baseName, int timeoutMs)
    {
        string path = Path.Combine(Program.CmdDir, baseName + Program.RespSuffix);
        Stopwatch clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < timeoutMs)
        {
            try
            {
                if (File.Exists(path)) return File.ReadAllText(path, Encoding.UTF8);
            }
            catch
            {
                // 对端 tmp+rename 途中的瞬时点，下一轮再读
            }
            Thread.Sleep(50);
        }
        try
        {
            if (File.Exists(path)) return File.ReadAllText(path, Encoding.UTF8);
        }
        catch { }
        return null;
    }

    /**
     * 读截图兄弟文件并 base64，然后删掉它（TCP 通道不需要在映射目录里留产物）。
     * 文件名同样过「纯文件名」闸门：resp 是 guest 自己写的，但这条路径将来若被别处复用，
     * 一个 `..\..\x` 就会让桥把宿主任意文件读出来送上线——闸门比信任便宜。
     */
    private static string ReadAndDropJpeg(string jpegName)
    {
        if (!IsPlainFileName(jpegName))
        {
            Log("TCP 回执里的截图文件名非法，未内联：" + jpegName);
            return null;
        }
        string path = Path.Combine(Program.CmdDir, jpegName);
        try
        {
            byte[] bytes = File.ReadAllBytes(path);
            File.Delete(path);
            if (bytes.Length == 0) return null;
            return Convert.ToBase64String(bytes);
        }
        catch (Exception ex)
        {
            Log("读取 TCP 回执的截图失败（" + jpegName + "）：" + ex.Message);
            return null;
        }
    }

    /** 纯文件名（不含目录、不含 ..）：与宿主侧 isPlainScreenshotFileName 同一条纪律 */
    internal static bool IsPlainFileName(string name)
    {
        if (name == null || name.Length == 0) return false;
        if (name.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
        if (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0) return false;
        if (name.IndexOf(':') >= 0) return false;
        return true;
    }

    /** 回执一帧。返回 false = 写不出去（这条连接该断）。 */
    private static bool WriteFrame(NetworkStream stream, long id, string respJson, string jpegBase64)
    {
        StringBuilder frame = new StringBuilder();
        frame.Append("{\"id\":").Append(id).Append(",\"resp\":").Append(respJson);
        if (jpegBase64 != null) frame.Append(",\"jpegBase64\":\"").Append(jpegBase64).Append("\"");
        frame.Append("}");
        return WriteLine(stream, frame.ToString());
    }

    private static bool WriteLine(NetworkStream stream, string line)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
            return true;
        }
        catch (Exception ex)
        {
            Log("TCP 写回执失败：" + ex.Message);
            return false;
        }
    }

    private static void Log(string msg)
    {
        Program.Log("[tcp] " + msg);
    }

    // ---- 自测（--selftest-tcp）----------------------------------------------------
    //
    // 为什么要有它：TCP 通道的每一条都是「线上行为」，真机验收一次要起沙箱（几分钟），
    // 而这里用 127.0.0.1 连回本进程就能把握手、令牌、往返、大载荷、串行、断线重连全验一遍。
    // **不启 Edge、不碰桌面**：命令只用 ping 与 type 的 dryRun 缝（45 秒超时那条线不受影响）。

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;
        string dir = Path.Combine(Path.GetTempPath(), "orbita-tcp-selftest-" + Guid.NewGuid().ToString("N"));
        TextWriter realOut = Console.Out;
        StringWriter captured = new StringWriter();
        try
        {
            Directory.CreateDirectory(dir);
            Program.UseDirsForSelfTest(dir);
            Console.SetOut(captured);
            bool started = Start();
            Console.SetOut(realOut);
            Program.CheckTrue(failures, ref cases, "监听起得来", started);
            Program.CheckTrue(failures, ref cases, "端口是系统分配的（>0）", Port > 0);
            Program.CheckTrue(failures, ref cases, "令牌是 32 位十六进制", IsHex32(Token));
            Program.CheckTrue(failures, ref cases, "bridge.json 的 ipv4 字段是数组（本机可能没有非回环地址）",
                IPv4Json(LocalIPv4()).StartsWith("[", StringComparison.Ordinal));
            if (!started) return Finish(failures, cases, dir, captured);

            // ① 错误令牌：必须被拒、且收不到任何命令回执
            SelfTestClient wrong = SelfTestClient.Connect(Port);
            try
            {
                string helloFail = wrong.Hello("00000000000000000000000000000000");
                CheckString(failures, ref cases, "错令牌握手回 hello-fail", Program.TcpHelloFailType, helloFail);
                Program.CheckTrue(failures, ref cases, "错令牌之后连接被关（没有命令通道）", wrong.AtEnd());
            }
            finally { wrong.Close(); }

            // ② 首行不是 hello：同样被拒（握手之前不接受任何命令）
            SelfTestClient raw = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "首行不是 hello 也回 hello-fail", Program.TcpHelloFailType,
                    raw.Hello("not-a-hello-line", true));
            }
            finally { raw.Close(); }

            // ③ 正确令牌：握手成功 + 一条 ping 往返
            SelfTestClient client = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "正确令牌握手回 hello-ok", Program.TcpHelloOkType, client.Hello(Token));
                string ping = client.Request("ping", null);
                Program.CheckTrue(failures, ref cases, "ping 往返：resp.ok = true",
                    Program.ExtractBool(ping, "ok") && Program.ExtractNumber(ping, "id") == "1");

                // ④ 64KB 大载荷：请求与回显都走满一行（回程正是截图方向）
                string big = new string('璇', 32768); // 32K 个中文字符 ≈ 64KB UTF-8 起步
                StringBuilder payload = new StringBuilder("{\"text\":");
                payload.Append(Program.JsonQuote(big));
                payload.Append(",\"dryRun\":true}");
                string echoed = client.Request("type", payload.ToString());
                string back = Program.ExtractJsonString(echoed, "text");
                Program.CheckTrue(failures, ref cases, "64KB 载荷往返：回显与原文逐字一致",
                    back != null && back.Length == big.Length && back == big);
                Program.CheckTrue(failures, ref cases, "64KB 载荷往返：长度字段对得上",
                    Program.ExtractNumber(echoed, "length") == big.Length.ToString());

                // ⑤ 串行：不读回执就再发一条，两条都要按 id 对号回来（桥是单线程执行）
                Program.CheckTrue(failures, ref cases, "两条连续命令：按 id 对号、都成功", client.RequestTwoPipelined());
            }
            finally { client.Close(); }

            // ⑥ 断开之后监听仍在：重连 + 握手 + ping 全部照旧
            SelfTestClient again = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "断线后重连：握手仍然成功", Program.TcpHelloOkType, again.Hello(Token));
                string ping = again.Request("ping", null);
                Program.CheckTrue(failures, ref cases, "断线后重连：ping 仍然往返", Program.ExtractBool(ping, "ok"));
                Program.CheckTrue(failures, ref cases, "序号跨连接单调（文件名不撞）", MaxSeq() >= 5);
            }
            finally { again.Close(); }

            // ⑦ 回退通道还在：文件协议的一条 ping 照旧落盘、照旧删 req
            string req = Path.Combine(Program.CmdDir, "cmd-000001" + Program.ReqSuffix);
            File.WriteAllText(req, "{\"command\":\"ping\"}", new UTF8Encoding(false));
            bool fileOk;
            try
            {
                Program.PollOnceForSelfTest();
                fileOk = File.Exists(Path.Combine(Program.CmdDir, "cmd-000001" + Program.RespSuffix))
                    && !File.Exists(req);
            }
            catch (Exception ex)
            {
                failures.Add("文件协议自测跑不起来：" + ex.Message);
                fileOk = false;
            }
            Program.CheckTrue(failures, ref cases, "文件协议与 TCP 并存：文件 ping 照旧执行", fileOk);
        }
        catch (Exception ex)
        {
            failures.Add("自测跑不起来：" + ex.Message);
        }
        finally
        {
            Console.SetOut(realOut);
            _stopping = true;
            try { if (_listener != null) _listener.Stop(); } catch { }
        }
        return Finish(failures, cases, dir, captured);
    }

    private static int Finish(List<string> failures, int cases, string dir, StringWriter captured)
    {
        string log = captured.ToString();
        // 令牌真值绝不出现在日志里（这条本身也是纪律的守卫）
        if (Token.Length > 0 && log.IndexOf(Token, StringComparison.Ordinal) >= 0)
            failures.Add("日志里出现了令牌真值（不许）");
        try { Directory.Delete(dir, true); } catch { }
        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    private static int MaxSeq()
    {
        return Volatile.Read(ref _seq);
    }

    private static bool IsHex32(string value)
    {
        if (value == null || value.Length != 32) return false;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) return false;
        }
        return true;
    }

    private static void CheckString(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        cases++;
        if (expected != actual)
            failures.Add(name + "：期待 \"" + expected + "\"，实得 \"" + (actual == null ? "<null>" : actual) + "\"");
    }

    /** 自测客户端：一行一条 JSON，用 127.0.0.1 连回本进程的监听 */
    private sealed class SelfTestClient
    {
        private TcpClient _client;
        private StreamReader _reader;
        private NetworkStream _stream;
        private int _id = 0;

        internal static SelfTestClient Connect(int port)
        {
            SelfTestClient client = new SelfTestClient();
            client._client = new TcpClient();
            client._client.NoDelay = true;
            client._client.Connect(new IPEndPoint(IPAddress.Loopback, port));
            client._client.ReceiveTimeout = 10000;
            client._stream = client._client.GetStream();
            client._reader = new StreamReader(client._stream, new UTF8Encoding(false));
            return client;
        }

        /** 发首行，回桥给的 t（hello-ok / hello-fail）；null = 连接被关 */
        internal string Hello(string token)
        {
            return Hello(token, false);
        }

        /** rawLine = true 时直接发这一行（用来验「首行不是 hello」） */
        internal string Hello(string tokenOrLine, bool rawLine)
        {
            string line = rawLine
                ? tokenOrLine
                : "{\"t\":\"" + Program.TcpHelloType + "\",\"token\":" + Program.JsonQuote(tokenOrLine) + "}";
            Write(line);
            try
            {
                string reply = _reader.ReadLine();
                if (reply == null) return null;
                return Program.ExtractJsonString(reply, "t");
            }
            catch (IOException)
            {
                return null; // 被拒后对端立刻关连接：ReadLine 抛 IO 异常也算「没回 hello-ok」
            }
        }

        /** 发一条命令并读回一行回执（"fields" 是一段已经序列化好的 JSON 对象片段，null = 无字段） */
        internal string Request(string command, string fieldsJson)
        {
            _id++;
            StringBuilder line = new StringBuilder("{\"id\":").Append(_id)
                .Append(",\"command\":").Append(Program.JsonQuote(command));
            if (fieldsJson != null) line.Append(",\"fields\":").Append(fieldsJson);
            line.Append("}");
            Write(line.ToString());
            return Read();
        }

        /** 不读回执就连发两条（桥必须按顺序执行、按 id 对号回来） */
        internal bool RequestTwoPipelined()
        {
            int first = _id + 1;
            string one = "{\"id\":" + first + ",\"command\":\"ping\"}";
            string two = "{\"id\":" + (first + 1) + ",\"command\":\"ping\"}";
            Write(one);
            Write(two);
            _id = first + 1;
            string replyOne = Read();
            string replyTwo = Read();
            return Program.ExtractNumber(replyOne, "id") == first.ToString()
                && Program.ExtractNumber(replyTwo, "id") == (first + 1).ToString()
                && Program.ExtractBool(replyOne, "ok") && Program.ExtractBool(replyTwo, "ok");
        }

        internal bool AtEnd()
        {
            try
            {
                return _reader.ReadLine() == null;
            }
            catch (IOException)
            {
                return true; // 对端关连接时本地读抛 IO 异常
            }
        }

        internal void Close()
        {
            try { if (_reader != null) _reader.Dispose(); } catch { }
            try { if (_stream != null) _stream.Dispose(); } catch { }
            try { if (_client != null) _client.Close(); } catch { }
        }

        private void Write(string line)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
            _stream.Write(bytes, 0, bytes.Length);
            _stream.Flush();
        }

        private string Read()
        {
            string reply = _reader.ReadLine();
            return reply == null ? "{\"ok\":false,\"error\":\"连接被关\"}" : reply;
        }
    }
}
