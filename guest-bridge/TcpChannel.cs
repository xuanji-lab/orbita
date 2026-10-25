// Orbita guest bridge —— TCP 命令通道（0.8.1）。
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
// 0.8.2 修「TCP 间歇不可达」的真因（2026-10-25 真机 + 用户截图）：沙箱里弹了 Windows 防火墙
//   提示（「Windows 防火墙已阻止…orbita-guest-bridge 的某些功能」，[允许]/[取消]），没人点
//   「允许」入站 TCP 就全被丢——宿主 8 次连接全超时、guest 心跳「已接入 0 条」，点了之后
//   同一个端口 4ms 就通。现在桥**启动时自己建一条入站允许规则**（netsh，不弹窗、不等待人）：
//     · 尽力而为：失败只记一句人话、把 fwAllowed=false 写进 bridge.json，桥与文件协议照常工作；
//     · 一定在 TcpListener.Start() **之前**做完，宿主第一次探活就不会撞上「已监听但被防火墙丢」；
//     · 不碰任何提权/弹窗逻辑（沙箱里以 WDAGUtilityAccount 跑，按推断不需要 UAC）。
//
// 0.8.1 修一条结构性缺陷（真机三轮挖出来的）：「第一条连接建立后，监听再也不接新连接」。
//   现场是宿主连上并复用之后，从外部对同一个 ip:port 连 30 次全部超时，guest 日志里除了
//   「监听」+ 那一次「握手成功」什么都没有——即 accept 循环不再取连接。现在把职责钉死：
//     · accept 线程**只做** accept → 记账 → 交给一条独立线程 → 立刻回去 accept；
//       不读 hello、不发命令、不写日志（日志写向映射目录，同样可能被卡住）；
//     · 一条连接的一生（握手 + 命令循环 + 关闭）全部在那条线程里；
//     · hello 读有硬超时 1s（宿主只等 1.5s）：连上来却不说话的对端会被立刻关掉，
//       绝不把一条线程挂在它身上；
//     · backlog 给到 64：accept 被系统短暂挂住时，宿主侧 connect() 也不至于被丢 SYN；
//     · 每条连接结束都关掉 socket / reader / stream 并减活跃计数。
//   日志：进入连接的第一件事是「TCP 接入（#N）：<对端>」，另有一条 60s 心跳线程单独打
//   「accept 循环心跳：已接入 N 条，当前活跃 M 条」——有了这两行，现场才能区分
//   「SYN 没到达」（宿主侧连不上、guest 没有接入行）与「到了没被 accept」（没有接入行但有心跳）。
//
// 测试缝：--selftest-tcp 在本进程里起监听、用 127.0.0.1 连回来，验握手、往返、64KB 大载荷、
// 串行、并发连接、不发 hello 就断、断线后监听仍在。不启 Edge、不碰桌面（宿主上跑得起来）。

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
    /**
     * 握手阶段等首行的上限。
     *
     * **1 秒**，不是 3 秒：宿主连一个候选地址（含握手）只等 1.5s（shared/computer-use.ts 的
     * BRIDGE_TCP_CONNECT_TIMEOUT_MS），它放弃之后这条连接就该立刻被关掉。留 3 秒会让每条
     * 被放弃的连接多在 guest 里挂 2 秒——真机那串「首次失败」正是这么攒出来的嫌疑之一。
     */
    private const int HelloReadTimeoutMs = 1000;
    /** 监听 backlog：accept 被系统短暂挂住时，宿主的 connect() 也不该被丢 SYN */
    private const int ListenBacklog = 64;
    /** 心跳间隔：只用来证明 accept 循环还活着（心跳线程单独跑，绝不占 accept 线程） */
    private const int HeartbeatIntervalMs = 60000;
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
    /** 已接入的连接总数 / 当前活跃连接数（只记账与心跳日志用；int 读写本身是原子的） */
    private static int _accepted = 0;
    private static int _active = 0;
    /** 本次启动的防火墙放行结果（写进 bridge.json，宿主据此解释「为什么连不上」） */
    private static bool _fwAllowed = false;
    /** 自测开关：宿主上**绝不**真跑 netsh（那是在改用户机器的防火墙） */
    private static bool _fwSkip = false;
    /** 入站规则名：固定，重跑时靠它判断「已经放行过」 */
    internal const string FirewallRuleName = "orbita-guest-bridge";
    /** netsh 的上限：放行是尽力而为，绝不许把桥的启动拖住 */
    private const int FirewallTimeoutMs = 5000;
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
        // **先放行再监听**：顺序反了的话，宿主第一次探活会撞在「已监听但被防火墙丢包」的窗口里，
        // 而沙箱还会弹一个等人去点的提示（真机上就是它让 TCP 看起来「间歇可用」）。
        _fwAllowed = EnsureFirewallRule();
        try
        {
            _token = NewToken();
            TcpListener listener = new TcpListener(IPAddress.Any, 0);
            listener.Start(ListenBacklog);
            _listener = listener;
            _port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Thread accept = new Thread(AcceptLoop);
            accept.IsBackground = true;
            accept.Name = "orbita-tcp-accept";
            accept.Start();
            // 心跳是**另一条**线程：accept 线程一行日志都不写（写映射目录的日志也可能被卡住），
            // 而「循环还活着吗」恰恰是 0.8.1 那个现场唯一没被记录下来的事情。
            Thread beat = new Thread(HeartbeatLoop);
            beat.IsBackground = true;
            beat.Name = "orbita-tcp-heartbeat";
            beat.Start();
            Log("TCP 通道已监听：0.0.0.0:" + _port + "，backlog " + ListenBacklog
                + "，本机 IPv4：" + JoinIPv4(LocalIPv4()));
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

    /**
     * accept 循环：**只做**「收一条 → 交给一条独立线程 → 立刻回去收下一条」。
     *
     * 三条纪律（0.8.1，真机三轮挖出来的结构性缺陷）：
     *   ① 这里绝不读 hello、绝不执行命令：一条连接活多久都不该影响还能不能接新连接；
     *   ② 这里绝不写日志：日志写向映射目录，一次慢写就会把 accept 卡住；
     *   ③ 这里的任何异常都不许终止循环：连线程都开不出来也只关这一条连接。
     * 心跳线程（HeartbeatLoop）负责证明这个循环还活着，日志里分得清「没到达」和「到了没被 accept」。
     */
    private static void AcceptLoop()
    {
        TcpListener listener = _listener;
        while (true)
        {
            TcpClient client;
            int seq;
            try
            {
                client = listener.AcceptTcpClient();
                seq = Interlocked.Increment(ref _accepted);
            }
            catch (Exception ex)
            {
                if (_stopping) return;
                // 监听被关 / 系统抖动：记一行、稍等再接受。不弄死线程——桥本身还得活着。
                Log("TCP 接受连接失败：" + ex.Message);
                Thread.Sleep(200);
                continue;
            }
            Interlocked.Increment(ref _active);
            try
            {
                // 一条连接一条线程：握手与整条命令循环都在里面（绝不回到 accept 线程上做）
                Thread worker = new Thread(delegate() { ServeClient(client, seq); });
                worker.IsBackground = true;
                worker.Name = "orbita-tcp-client";
                worker.Start();
            }
            catch (Exception ex)
            {
                // 极端情况下线程都开不出来：只关这一条连接，监听继续（绝不让 accept 循环死掉）
                Log("TCP 连接线程启动失败：" + ex.Message);
                Interlocked.Decrement(ref _active);
                try { client.Close(); } catch { }
            }
        }
    }

    // ---- 防火墙放行（0.8.2）-------------------------------------------------------
    //
    // 真沙箱里第一次监听入站端口时，Windows 会弹「是否允许…访问此应用？」的防火墙提示；
    // 没人点「允许」时**所有入站 TCP 都被丢**（SYN 连回答都没有），宿主看到的就是「连接超时」。
    // 2026-10-25 真机：同一个 ip:port，点「允许」之前 8 次全超时、guest 心跳「已接入 0 条」，
    // 点完之后 4ms 就通。所以桥自己建一条入站允许规则，把「等人点」这件事彻底去掉。
    //
    // 三条纪律：
    //   ① 尽力而为：失败只记一句人话，桥与文件协议照常工作（TCP 只是加速器）；
    //   ② 不弹窗：UseShellExecute=false + CreateNoWindow（也就不经过 Shell / UAC）；
    //   ③ 幂等：先 `show rule` 看一眼，已有同名规则就不再 add（netsh 允同名重复，重跑会堆规则）。

    /** 本进程 exe 的绝对路径（规则按程序放行，比按端口放行精确） */
    private static string CurrentExePath()
    {
        try
        {
            return System.Reflection.Assembly.GetExecutingAssembly().Location;
        }
        catch
        {
            return "";
        }
    }

    /**
     * `netsh advfirewall firewall add rule` 的参数串（纯函数，自测直接验它）。
     *
     * 为什么 program= 外面一定有引号：安装路径可能带空格，而 Windows 的 argv 解析会把
     * `program="C:\A B\x.exe"` 合成一个 token `program=C:\A B\x.exe`，netsh 正好吃这个形状。
     */
    internal static string BuildAddRuleArgs(string exePath)
    {
        return "advfirewall firewall add rule name=\"" + FirewallRuleName + "\""
            + " dir=in action=allow program=\"" + exePath + "\" enable=yes profile=any";
    }

    /** `netsh advfirewall firewall show rule name=...` 的参数串（纯函数） */
    internal static string BuildShowRuleArgs()
    {
        return "advfirewall firewall show rule name=\"" + FirewallRuleName + "\"";
    }

    /**
     * 要不要再 add 一条（纯函数）：show 成功 = 规则已在，跳过；show 失败但输出里已经出现规则名
     * （不同语言版本的输出/退出码差异）也算在。这样重跑桥不会把同名规则堆一坨。
     */
    internal static bool ShouldAddRule(int showExitCode, string showOutput)
    {
        if (showExitCode == 0) return false;
        if (showOutput != null && showOutput.IndexOf(FirewallRuleName, StringComparison.OrdinalIgnoreCase) >= 0)
            return false;
        return true;
    }

    /** bridge.json 里的 fwAllowed 字段片段（纯函数，自测直接验它） */
    internal static string FirewallField(bool allowed)
    {
        return ",\"fwAllowed\":" + (allowed ? "true" : "false");
    }

    /** 自测：不真的跑 netsh（宿主上改用户防火墙是红线） */
    internal static void SkipFirewallForSelfTest()
    {
        _fwSkip = true;
    }

    /** 放行结果（写进 bridge.json）。false 也可能只是「netsh 没成」，不代表桥不可用。 */
    internal static bool FirewallAllowed
    {
        get { return _fwAllowed; }
    }

    /** 建入站允许规则；任何失败都只记日志（返回 false），绝不抛 */
    private static bool EnsureFirewallRule()
    {
        if (_fwSkip)
        {
            Log("防火墙：自测跳过放行（不跑 netsh）");
            _fwAllowed = true;
            return true;
        }
        string exePath = CurrentExePath();
        if (exePath.Length == 0)
        {
            Log("防火墙：自动放行失败（取不到本进程 exe 路径）——TCP 通道需要用户在弹出的提示里点「允许」，否则只走文件协议");
            return false;
        }
        try
        {
            NetShellResult shown = RunNetsh(BuildShowRuleArgs());
            if (!ShouldAddRule(shown.Code, shown.Output))
            {
                Log("防火墙：入站规则 " + FirewallRuleName + " 已存在，跳过");
                return true;
            }
            NetShellResult added = RunNetsh(BuildAddRuleArgs(exePath));
            if (added.Code == 0)
            {
                Log("防火墙：已放行 " + FirewallRuleName + "（入站任意 profile）");
                return true;
            }
            Log("防火墙：自动放行失败（netsh 退出码 " + added.Code + "：" + FirstLine(added.Output)
                + "）——TCP 通道需要用户在弹出的提示里点「允许」，否则只走文件协议");
            return false;
        }
        catch (Exception ex)
        {
            Log("防火墙：自动放行失败（" + ex.Message
                + "）——TCP 通道需要用户在弹出的提示里点「允许」，否则只走文件协议");
            return false;
        }
    }

    /** netsh 的输出只取第一行（多行会挤满 bridge.log，看原因第一行就够） */
    private static string FirstLine(string text)
    {
        if (text == null) return "";
        string trimmed = text.Trim();
        int at = trimmed.IndexOfAny(new char[] { '\r', '\n' });
        string line = at < 0 ? trimmed : trimmed.Substring(0, at);
        if (line.Length > 200) line = line.Substring(0, 200) + "…";
        return line;
    }

    private sealed class NetShellResult
    {
        internal int Code = -1;
        internal string Output = "";
    }

    /**
     * 跑一次 netsh 并等它退出。**用一条后台线程 + Join 上限**把它框住：
     * 放行是尽力而为，netsh 万一卡住也绝不能把桥的启动拖死（否则文件协议也跟着起不来）。
     */
    private static NetShellResult RunNetsh(string args)
    {
        NetShellResult result = new NetShellResult();
        Thread runner = new Thread(delegate() { RunNetshInto(args, result); });
        runner.IsBackground = true;
        runner.Name = "orbita-firewall";
        runner.Start();
        if (!runner.Join(FirewallTimeoutMs))
        {
            result.Code = -1;
            result.Output = "netsh " + FirewallTimeoutMs + "ms 内没有退出";
        }
        return result;
    }

    private static void RunNetshInto(string args, NetShellResult result)
    {
        try
        {
            // 用绝对路径：UseShellExecute=false 时进程搜索会先看当前目录，别让一个同名 exe 顶掉系统 netsh
            string netsh = Path.Combine(Environment.SystemDirectory, "netsh.exe");
            ProcessStartInfo psi = new ProcessStartInfo(netsh, args);
            psi.UseShellExecute = false; // 不经过 Shell：不弹窗、不弹 UAC
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process process = Process.Start(psi))
            {
                // 先读完两个流再等退出（顺序反了会互相卡住）
                string stdout = process.StandardOutput.ReadToEnd();
                string stderr = process.StandardError.ReadToEnd();
                if (!process.WaitForExit(FirewallTimeoutMs))
                {
                    try { process.Kill(); } catch { }
                    result.Code = -1;
                    result.Output = "netsh " + FirewallTimeoutMs + "ms 内没有退出";
                    return;
                }
                result.Code = process.ExitCode;
                result.Output = (stdout + "\n" + stderr).Trim();
            }
        }
        catch (Exception ex)
        {
            result.Code = -1;
            result.Output = ex.Message;
        }
    }

    /** 心跳：只证明 accept 循环还活着 + 当前有多少条连接（60s 一行，不占 accept 线程） */
    private static void HeartbeatLoop()
    {
        while (true)
        {
            Thread.Sleep(HeartbeatIntervalMs);
            if (_stopping) return;
            try
            {
                Log("accept 循环心跳：已接入 " + _accepted + " 条，当前活跃 " + _active + " 条");
            }
            catch
            {
                // 日志写不出去也不能弄死心跳线程
            }
        }
    }

    /**
     * 一条连接的一生：接入 → 握手 → 循环收发 → 断开。
     *
     * 全程在这条连接**自己的线程**里（accept 线程不知道这条连接活多久）。三条硬约束：
     *   · 接入第一件事就记一行「TCP 接入（#N）：<对端>」——现场靠它区分「SYN 没到达」与
     *     「到了但没被 accept」；
     *   · hello 读有 **1s** 硬超时：宿主 1.5s 就放弃，这条连接必须随它一起消失，不许挂着；
     *   · finally 里关掉 reader / stream / socket 并减活跃计数——上一个客户端断开之后，
     *     监听必须还能接下一个（0.8.1 修的正是这条）。
     */
    private static void ServeClient(TcpClient client, int seq)
    {
        string source = "?";
        try
        {
            IPEndPoint remote = client.Client.RemoteEndPoint as IPEndPoint;
            if (remote != null) source = remote.Address + ":" + remote.Port;
        }
        catch { }

        string tag = "TCP 接入（#" + seq + "）：" + source;
        bool handshook = false;
        NetworkStream stream = null;
        StreamReader reader = null;
        try
        {
            Log(tag);
            // 命令是一行一行的：不让 Nagle 把行攒起来（那会平白加 40ms，正是要消灭的成本）
            client.NoDelay = true;
            stream = client.GetStream();
            // 握手阶段的硬超时：连上却不发首行的对端不许占着线程
            client.ReceiveTimeout = HelloReadTimeoutMs;
            reader = new StreamReader(stream, new UTF8Encoding(false));

            string first = reader.ReadLine();
            if (first == null)
            {
                Log(tag + "：还没发首行就断了");
                return;
            }
            string rejection = HandshakeRejection(first);
            if (rejection != null)
            {
                // 只说原因，**不打令牌真值**（日志会进 PR / 截图）
                Log("TCP 握手失败（" + source + "）：" + rejection + "，已断开，不接受任何命令");
                handshook = true; // 已经回过 hello-fail，不必再按「握手超时」解释一次
                WriteLine(stream, "{\"t\":" + Program.JsonQuote(Program.TcpHelloFailType) + "}");
                return;
            }
            handshook = true;
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
            // 握手超时（宿主 1.5s 放弃 → 它先关连接，或我们先到 1s）与其它异常分开说，
            // 因为它们在真机上是完全不同的事：前者是正常的建连竞争，后者才是 bug。
            if (!handshook)
                Log(tag + "：" + HelloReadTimeoutMs + "ms 内没等到 hello（" + ex.Message + "），关连接");
            else
                Log("TCP 连接异常（" + source + "）：" + ex.Message);
        }
        finally
        {
            try { if (reader != null) reader.Dispose(); } catch { }
            try { if (stream != null) stream.Dispose(); } catch { }
            try { client.Close(); } catch { }
            Interlocked.Decrement(ref _active);
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
            // 宿主上**绝不**真跑 netsh（那是在改用户机器的防火墙）：只关掉它，纯逻辑照测
            SkipFirewallForSelfTest();
            Console.SetOut(captured);
            bool started = Start();
            Console.SetOut(realOut);
            Program.CheckTrue(failures, ref cases, "监听起得来", started);
            Program.CheckTrue(failures, ref cases, "端口是系统分配的（>0）", Port > 0);
            Program.CheckTrue(failures, ref cases, "令牌是 32 位十六进制", IsHex32(Token));
            Program.CheckTrue(failures, ref cases, "bridge.json 的 ipv4 字段是数组（本机可能没有非回环地址）",
                IPv4Json(LocalIPv4()).StartsWith("[", StringComparison.Ordinal));

            // ---- 防火墙放行（0.8.2）：只验拼装与幂等判断，宿主上不跑 netsh ----
            string exe = "C:" + Path.DirectorySeparatorChar + "orbita-bridge" + Path.DirectorySeparatorChar
                + "orbita-guest-bridge.exe";
            string addArgs = BuildAddRuleArgs(exe);
            Program.CheckTrue(failures, ref cases, "放行参数：规则名 / 方向 / 动作 / 启用 / profile 都对",
                addArgs.IndexOf("advfirewall firewall add rule name=\"" + FirewallRuleName + "\"",
                    StringComparison.Ordinal) == 0
                && addArgs.IndexOf(" dir=in ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" action=allow ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" enable=yes ", StringComparison.Ordinal) > 0
                && addArgs.EndsWith(" profile=any", StringComparison.Ordinal));
            Program.CheckTrue(failures, ref cases, "放行参数：程序路径带引号且指向本 exe",
                addArgs.IndexOf("program=\"" + exe + "\"", StringComparison.Ordinal) > 0);
            Program.CheckTrue(failures, ref cases, "放行参数：引号只有两对（名字 + 路径），路径里的反斜杠不被转义",
                CountChar(addArgs, '"') == 4 && addArgs.IndexOf("\\\\", StringComparison.Ordinal) < 0);
            string spaced = BuildAddRuleArgs("C:" + Path.DirectorySeparatorChar + "Program Files"
                + Path.DirectorySeparatorChar + "orbita app" + Path.DirectorySeparatorChar + "orbita-guest-bridge.exe");
            Program.CheckTrue(failures, ref cases, "放行参数：路径带空格时引号仍然整段包住路径",
                spaced.IndexOf("program=\"C:" + Path.DirectorySeparatorChar + "Program Files"
                    + Path.DirectorySeparatorChar + "orbita app" + Path.DirectorySeparatorChar
                    + "orbita-guest-bridge.exe\"", StringComparison.Ordinal) > 0);
            Program.CheckString(failures, ref cases, "查询参数：按规则名查",
                "advfirewall firewall show rule name=\"" + FirewallRuleName + "\"", BuildShowRuleArgs());
            Program.CheckTrue(failures, ref cases, "幂等：show 成功 = 规则已在，不再 add",
                !ShouldAddRule(0, "Rule orbita-guest-bridge"));
            Program.CheckTrue(failures, ref cases, "幂等：show 失败且输出里没有规则名 → 要加",
                ShouldAddRule(1, "没有与指定条件相匹配的规则。"));
            Program.CheckTrue(failures, ref cases, "幂等：show 失败但输出里已有规则名 → 不加",
                !ShouldAddRule(1, "orbita-guest-bridge"));
            Program.CheckString(failures, ref cases, "fwAllowed 字段片段（true）", ",\"fwAllowed\":true",
                FirewallField(true));
            Program.CheckString(failures, ref cases, "fwAllowed 字段片段（false）", ",\"fwAllowed\":false",
                FirewallField(false));
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

            // ⑧ 并发连接：两条**同时**握手都要成功，且各自能跑一条命令。
            //    0.8.1 的结构性缺陷就是「一次只能服务一条连接」——真机上第一条连上之后，
            //    第二条连 SYN-ACK 都收不到。两条同时活着是最直接的回归用例。
            SelfTestClient first = SelfTestClient.Connect(Port);
            SelfTestClient second = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "并发连接 A 握手成功", Program.TcpHelloOkType, first.Hello(Token));
                CheckString(failures, ref cases, "并发连接 B 握手成功", Program.TcpHelloOkType, second.Hello(Token));
                Program.CheckTrue(failures, ref cases, "并发连接 A 能跑命令",
                    Program.ExtractBool(first.Request("ping", null), "ok"));
                Program.CheckTrue(failures, ref cases, "并发连接 B 能跑命令",
                    Program.ExtractBool(second.Request("ping", null), "ok"));

                // ⑨ 已有一条（其实是两条）连接在用时，**第三条**仍要能握手成功：
                //    明确钉死「不是一次一条」，而不是靠「上一条刚好断了」蒙对。
                SelfTestClient third = SelfTestClient.Connect(Port);
                try
                {
                    CheckString(failures, ref cases, "前两条都活着时第三条仍能握手", Program.TcpHelloOkType,
                        third.Hello(Token));
                    Program.CheckTrue(failures, ref cases, "第三条也能跑命令",
                        Program.ExtractBool(third.Request("ping", null), "ok"));
                }
                finally { third.Close(); }
            }
            finally
            {
                first.Close();
                second.Close();
            }

            // ⑩ 连上之后不发 hello 直接断开（= 宿主 1.5s 放弃那个现场）：监听照旧能接新的
            SelfTestClient mute = SelfTestClient.Connect(Port);
            mute.Close();
            SelfTestClient afterMute = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "不发 hello 就断之后，仍能握手", Program.TcpHelloOkType,
                    afterMute.Hello(Token));
                Program.CheckTrue(failures, ref cases, "不发 hello 就断之后，仍能跑命令",
                    Program.ExtractBool(afterMute.Request("ping", null), "ok"));
            }
            finally { afterMute.Close(); }

            // ⑪ 连上但一直不说话：服务端必须在 hello 超时（1s）后自己关掉这条连接。
            //    宿主只等 1.5s——guest 把线程挂在一条被放弃的连接上，正是「监听被占住」的另一半。
            SelfTestClient silent = SelfTestClient.Connect(Port);
            try
            {
                Stopwatch wait = Stopwatch.StartNew();
                bool closed = silent.AtEnd();
                long waitedMs = wait.ElapsedMilliseconds;
                Program.CheckTrue(failures, ref cases, "不发 hello 的连接会被服务端关掉", closed);
                Program.CheckTrue(failures, ref cases,
                    "关掉得够快（hello 超时 1s，实测 " + waitedMs + "ms）", waitedMs >= 700 && waitedMs <= 3500);
            }
            finally { silent.Close(); }

            // ⑫ 这一串之后监听仍在：再来一条能握手、能跑命令
            SelfTestClient last = SelfTestClient.Connect(Port);
            try
            {
                CheckString(failures, ref cases, "以上全部之后监听仍然健康", Program.TcpHelloOkType, last.Hello(Token));
                Program.CheckTrue(failures, ref cases, "以上全部之后仍能跑命令",
                    Program.ExtractBool(last.Request("ping", null), "ok"));
            }
            finally { last.Close(); }

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

    /** 数一个字符出现几次（验引号配对的纯函数） */
    private static int CountChar(string text, char needle)
    {
        int count = 0;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] == needle) count++;
        }
        return count;
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
