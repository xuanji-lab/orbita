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
using System.Runtime.InteropServices;
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
        // **关防火墙必须在开始监听之前**：那个「是否允许…」的框是 Windows 在程序第一次开始监听
        // 入站时弹的；等它弹出来之后再关防火墙不会把框收回去，框会留在桌面上抢焦点。
        PrepareFirewallBeforeListen();
        try
        {
            _token = NewToken();
            TcpListener listener = new TcpListener(IPAddress.Any, 0);
            listener.Start(ListenBacklog);
            _listener = listener;
            _port = ((IPEndPoint)listener.LocalEndpoint).Port;
            // 端口知道了才建端口规则（belt-and-braces：防火墙通常已经被上一步关掉）。
            // 顺序：关防火墙 → 监听 → 端口规则 → 写 bridge.json（宿主看见通告时入站已放开）。
            AddPortRuleAfterListen();
            // 万一某些机器上仍然弹了那个框：监听后起一条 ~2s 的短任务把它收掉（只做一次）
            ArmFirewallPromptSweep();
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

    // ---- 防火墙放行（0.8.4）-------------------------------------------------------
    //
    // 真沙箱里的两个现象（2026-10-25 真机，两轮）：
    //   ① 只按**程序路径**加规则（0.8.2）：netsh 返回成功、fwAllowed=true，宿主 8 次连接仍全超时
    //      —— 桥从一张 mklink /J 出来的路径启动，镜像路径可能与规则里的字面路径对不上；
    //   ② 「是否允许… orbita-guest-bridge」那个框**还在弹**（用户拍的第二张截图）：
    //      它是 Windows 在程序**第一次开始监听**入站时弹的（InboundUserNotification），
    //      在它之后关防火墙不会把框收回去——框会一直留在沙箱桌面上，还抢焦点（干扰像素工具）。
    //
    // 所以顺序改成（0.8.4）：**先关防火墙 → 再开始监听** → 取端口 → 建端口规则（belt-and-braces）
    // → 写 bridge.json。关掉之后才开始监听，就不该再有那个提示。万一某些机器上仍然弹了，
    // 监听之后起一条 ~2s 的短任务，把它收掉（枚举顶层窗口，精确匹配再 PostMessage(WM_CLOSE)）。
    //
    // 三条纪律：
    //   ① 尽力而为：每一步失败都只记人话日志，桥与文件协议照常工作；
    //   ② 不弹窗、不提权：UseShellExecute=false + CreateNoWindow，整次调用框在 5s 上限里；
    //   ③ 只碰**沙箱内**我们自己的桌面窗口（宿主进程永不执行这些代码，`--no-firewall` 也会关掉它）。

    /** 规则名前缀：端口规则叫 orbita-guest-bridge-<port>，一局沙箱里端口唯一 */
    internal const string FirewallRuleName = "orbita-guest-bridge";
    /** 确定性兜底：在沙箱里关掉防火墙（一次性 VM；只在 guest 进程里执行，宿主永不碰） */
    internal const string FirewallOffArgs = "advfirewall set allprofiles state off";
    /** netsh 的上限：放行是尽力而为，绝不许把桥的启动拖住 */
    private const int FirewallTimeoutMs = 5000;
    /** 关弹框的延迟：给 Windows 弹框留一点时间（它在监听那一刻弹） */
    private const int FirewallPromptDelayMs = 2000;
    /** WM_CLOSE */
    private const uint WM_CLOSE = 0x0010;

    /** 本次启动的入站放行结果（端口规则或关防火墙任一成功 = true），写进 bridge.json */
    private static bool _fwAllowed = false;
    /** 防火墙是否真的被关掉了（bridge.json 的 fwStateOff，用于解释「为什么能连上」） */
    private static bool _fwStateOff = false;
    /** 自测开关：宿主上**绝不**真跑 netsh、绝不碰桌面窗口 */
    private static bool _fwSkip = false;
    /** 诊断路径只打一次 */
    private static bool _fwDiagnosticsLogged = false;
    /** 弹框兜底只做一次（判据是「别等、别重试超过一次」） */
    private static int _fwPromptSweepArmed = 0;

    // ---- 那个提示框的长相（纯函数，自测直接验）----

    /**
     * 是不是 Windows 的「是否允许…访问此应用」防火墙提示。
     *
     * 三个条件（前两个是硬条件，后两个满足其一即可）：
     *   · 类名必须是 `#32770`（Win32 标准对话框）——否则可能误关 Security 应用主窗口；
     *   · 标题命中一组多语言关键字（中文 / 英文 / 通用），**或**正文（子控件文本）里出现
     *     `orbita-guest-bridge`（程序名是最不容易被本地化/改版弄丢的信号）。
     */
    internal static bool IsFirewallPrompt(string className, string title, string body)
    {
        if (!string.Equals(className, "#32770", StringComparison.Ordinal)) return false;
        if (LooksLikeFirewallTitle(title)) return true;
        if (body == null) return false;
        return body.IndexOf("orbita-guest-bridge", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /** 提示框标题的多语言关键字（Windows 安全中心 / Windows Security Alert / 安全警报 …） */
    internal static bool LooksLikeFirewallTitle(string title)
    {
        if (title == null || title.Trim().Length == 0) return false;
        string[] needles = new string[]
        {
            "Windows 安全中心",
            "Windows 安全性",
            "Windows Security Alert",
            "Windows Security",
            "Windows Defender 防火墙",
            "Windows Defender Firewall",
            "安全警报",
            "防火墙",
        };
        for (int i = 0; i < needles.Length; i++)
        {
            if (title.IndexOf(needles[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    /** 端口规则名：带端口，避免上一局残留的同名规则被误判成「已存在」 */
    internal static string PortRuleName(int port)
    {
        return FirewallRuleName + "-" + port;
    }

    /**
     * `netsh advfirewall firewall add rule` 的端口放行参数串（纯函数，自测直接验它）。
     *
     * 为什么按端口而不是按程序：桥的 exe 是从一张 mklink /J 出来的目录启动的，Windows 记的
     * 镜像路径可能与参数里的字面路径不同，程序规则就匹配不上（真机：netsh 成功、连接仍超时）。
     */
    internal static string BuildPortRuleArgs(int port)
    {
        return "advfirewall firewall add rule name=\"" + PortRuleName(port) + "\""
            + " dir=in action=allow protocol=TCP localport=" + port
            + " profile=any enable=yes";
    }

    /** `netsh advfirewall firewall show rule name=...` 的参数串（纯函数） */
    internal static string BuildShowRuleArgs(string ruleName, bool verbose)
    {
        return "advfirewall firewall show rule name=\"" + ruleName + "\"" + (verbose ? " verbose" : "");
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

    /** bridge.json 里的 fwStateOff 字段片段（纯函数） */
    internal static string FirewallStateField(bool off)
    {
        return ",\"fwStateOff\":" + (off ? "true" : "false");
    }

    /** 自测：不真的跑 netsh、也不去关窗口（宿主上的红线） */
    internal static void SkipFirewallForSelfTest()
    {
        _fwSkip = true;
    }

    /**
     * 入站是否已放行 = 防火墙已关闭 **或** 端口规则建成（取其一即够）。
     * false 只代表两条路都没成，不代表桥不可用（文件协议照旧）。
     */
    internal static bool FirewallAllowed
    {
        get { return _fwAllowed; }
    }

    /** 沙箱内防火墙是否被关掉（写进 bridge.json，解释「为什么这次能连上」） */
    internal static bool FirewallDisabled
    {
        get { return _fwStateOff; }
    }

    /**
     * 监听**之前**的一步：打路径诊断 + 关掉沙箱防火墙。
     *
     * 为什么必须在监听之前（0.8.4 的关键）：那个「是否允许…」的框是 Windows 在程序第一次
     * 开始监听入站端口时弹的；等它弹出来之后关防火墙**不会**把框收回去，框会一直留在桌面上，
     * 还抢焦点（对像素工具是干扰源）。先关防火墙，监听时就不会有提示。
     */
    private static void PrepareFirewallBeforeListen()
    {
        if (_fwSkip)
        {
            Log("防火墙：自测跳过放行（不跑 netsh、不碰窗口）");
            _fwAllowed = true;
            _fwStateOff = false;
            return;
        }
        LogPathsForDiagnostics();
        _fwStateOff = DisableFirewall();
    }

    /** 监听之后的一步：端口规则（belt-and-braces；防火墙通常已经被关掉） */
    private static void AddPortRuleAfterListen()
    {
        if (_fwSkip) return;
        bool byPort = EnsureRule(PortRuleName(_port), BuildPortRuleArgs(_port));
        _fwAllowed = byPort || _fwStateOff;
        Log("防火墙：" + (_fwAllowed ? "入站已放行" : "未能放行")
            + "（关闭防火墙 " + (_fwStateOff ? "成功" : "失败")
            + "；端口规则 " + (byPort ? "成功" : "失败") + "）");
    }

    /** 加一条规则（已有同名就跳过）；返回是否「这条规则确定在」 */
    private static bool EnsureRule(string ruleName, string addArgs)
    {
        NetShellResult shown = RunNetsh(BuildShowRuleArgs(ruleName, false));
        if (!ShouldAddRule(shown.Code, shown.Output))
        {
            Log("防火墙：入站规则 " + ruleName + " 已存在，跳过");
            return true;
        }
        NetShellResult added = RunNetsh(addArgs);
        if (added.Code == 0)
        {
            Log("防火墙：已添加入站规则 " + ruleName + "（任意 profile，本端口 TCP 入站）");
            // 回读一次：证明规则真的在（0.8.2 的教训就是「netsh 返回 0 ≠ 真的放行」）
            NetShellResult verbose = RunNetsh(BuildShowRuleArgs(ruleName, true));
            Log("防火墙：规则回读（第一行）— " + FirstLine(verbose.Output));
            return true;
        }
        Log("防火墙：添加入站规则失败（" + ruleName + "，netsh 退出码 " + added.Code + "："
            + FirstLine(added.Output) + "）");
        return false;
    }

    /** 兜底：在沙箱里关掉防火墙（一次性 VM，只与宿主通信） */
    private static bool DisableFirewall()
    {
        NetShellResult result = RunNetsh(FirewallOffArgs);
        if (result.Code == 0)
        {
            Log("防火墙：已在沙箱内关闭（一次性 VM，仅与宿主通信；这样开始监听时不会弹「是否允许」）");
            return true;
        }
        Log("防火墙：关闭失败（netsh 退出码 " + result.Code + "：" + FirstLine(result.Output)
            + "）——可能会弹「是否允许」的提示，TCP 通道在用户点「允许」之前只走文件协议");
        return false;
    }

    // ---- 弹框兜底：关掉那个「是否允许…」的提示（0.8.4）---------------------------
    //
    // 顺序调整之后理论上不该再弹；但对「某些机器上 InboundUserNotification 先于防火墙状态生效」
    // 这种我们控制不了的情况留一手：监听之后起一条 ~2s 的短任务，枚举顶层窗口找那个框，
    // 精确匹配后 PostMessage(WM_CLOSE)。**只做一次、不等待、不重试**——找不到就算了。
    // 这是沙箱内我们自己的桌面（一次性 VM，桌面本来就整块交给 agent），不碰宿主窗口。

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    /** 监听之后调一次：排一条 ~2s 的短任务去收掉可能已经弹出来的防火墙提示 */
    private static void ArmFirewallPromptSweep()
    {
        if (_fwSkip) return;
        if (Interlocked.CompareExchange(ref _fwPromptSweepArmed, 1, 0) != 0) return;
        Thread sweeper = new Thread(delegate() { SweepFirewallPrompt(); });
        sweeper.IsBackground = true;
        sweeper.Name = "orbita-fw-dialog";
        sweeper.Start();
    }

    private static void SweepFirewallPrompt()
    {
        try
        {
            Thread.Sleep(FirewallPromptDelayMs);
            List<IntPtr> hits = new List<IntPtr>();
            List<string> titles = new List<string>();
            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                try
                {
                    if (!IsWindowVisible(hwnd)) return true;
                    string title = WindowTextOf(hwnd);
                    string body = ChildTextOf(hwnd);
                    if (!IsFirewallPrompt(ClassNameOf(hwnd), title, body)) return true;
                    hits.Add(hwnd);
                    titles.Add(title.Trim().Length == 0 ? "（无标题）" : title.Trim());
                }
                catch
                {
                    // 单个窗口查不到就跳过，继续枚举
                }
                return true;
            }, IntPtr.Zero);

            for (int i = 0; i < hits.Count; i++)
            {
                PostMessage(hits[i], WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                Log("防火墙：已关闭系统弹框「" + titles[i] + "」（它会影响沙箱内焦点）");
            }
        }
        catch (Exception ex)
        {
            Log("防火墙：关弹框失败（" + ex.Message + "）");
        }
    }

    private static string ClassNameOf(IntPtr hwnd)
    {
        StringBuilder buffer = new StringBuilder(256);
        int length = GetClassName(hwnd, buffer, buffer.Capacity);
        return length > 0 ? buffer.ToString(0, length) : "";
    }

    private static string WindowTextOf(IntPtr hwnd)
    {
        StringBuilder buffer = new StringBuilder(512);
        int length = GetWindowText(hwnd, buffer, buffer.Capacity);
        return length > 0 ? buffer.ToString(0, length) : "";
    }

    /** 子控件文本拼起来（提示框的正文在 Static 控件里，含程序名 orbita-guest-bridge） */
    private static string ChildTextOf(IntPtr hwnd)
    {
        StringBuilder parts = new StringBuilder();
        EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr lParam)
        {
            try
            {
                string text = WindowTextOf(child);
                if (text.Length > 0) parts.Append(text).Append('\n');
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return parts.ToString();
    }

    /**
     * 把三个可能不一致的「本进程 exe 路径」打进日志：真机上要确认 junction 到底让哪个路径生效
     * （.NET Framework 4.x 没有 Environment.ProcessPath，所以用等价的三个来源）。
     */
    private static void LogPathsForDiagnostics()
    {
        if (_fwDiagnosticsLogged) return;
        _fwDiagnosticsLogged = true;
        string mainModule = "?";
        try
        {
            mainModule = Process.GetCurrentProcess().MainModule.FileName;
        }
        catch (Exception ex)
        {
            mainModule = "?(" + ex.Message + ")";
        }
        string entry = "?";
        try
        {
            System.Reflection.Assembly asm = System.Reflection.Assembly.GetEntryAssembly();
            entry = asm == null ? "?（无入口程序集）" : asm.Location;
        }
        catch (Exception ex)
        {
            entry = "?(" + ex.Message + ")";
        }
        string argv0 = "?";
        try
        {
            string[] argv = Environment.GetCommandLineArgs();
            if (argv.Length > 0) argv0 = argv[0];
        }
        catch { }
        Log("防火墙：路径诊断 — MainModule=" + mainModule + "；EntryAssembly=" + entry
            + "；CommandLine[0]=" + argv0);
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

            // ---- 防火墙放行（0.8.3）：只验拼装与幂等判断，宿主上不跑 netsh ----
            string addArgs = BuildPortRuleArgs(49686);
            Program.CheckTrue(failures, ref cases, "端口规则：按端口而不是按程序路径（junction 坑不到）",
                addArgs.IndexOf("advfirewall firewall add rule name=\"" + PortRuleName(49686) + "\"",
                    StringComparison.Ordinal) == 0
                && addArgs.IndexOf(" program=", StringComparison.Ordinal) < 0);
            Program.CheckTrue(failures, ref cases, "端口规则：方向 / 动作 / 协议 / 端口 / profile / enable 都对",
                addArgs.IndexOf(" dir=in ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" action=allow ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" protocol=TCP ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" localport=49686 ", StringComparison.Ordinal) > 0
                && addArgs.IndexOf(" profile=any ", StringComparison.Ordinal) > 0
                && addArgs.EndsWith(" enable=yes", StringComparison.Ordinal));
            Program.CheckTrue(failures, ref cases, "端口规则：名字里的端口与实际端口一致（一局一规则，不撞旧残留）",
                PortRuleName(1) == "orbita-guest-bridge-1" && PortRuleName(65535) == "orbita-guest-bridge-65535");
            Program.CheckTrue(failures, ref cases, "端口规则：引号只有一对（规则名），没有转义反斜杠",
                CountChar(addArgs, '"') == 2 && addArgs.IndexOf("\\\\", StringComparison.Ordinal) < 0);
            Program.CheckString(failures, ref cases, "查询参数：按规则名查",
                "advfirewall firewall show rule name=\"" + PortRuleName(49686) + "\"",
                BuildShowRuleArgs(PortRuleName(49686), false));
            Program.CheckString(failures, ref cases, "查询参数：verbose 回读",
                "advfirewall firewall show rule name=\"" + PortRuleName(49686) + "\" verbose",
                BuildShowRuleArgs(PortRuleName(49686), true));
            Program.CheckString(failures, ref cases, "兜底：在沙箱里关掉防火墙的参数",
                "advfirewall set allprofiles state off", FirewallOffArgs);
            Program.CheckTrue(failures, ref cases, "幂等：show 成功 = 规则已在，不再 add",
                !ShouldAddRule(0, "Rule orbita-guest-bridge-49686"));
            Program.CheckTrue(failures, ref cases, "幂等：show 失败且输出里没有规则名 → 要加",
                ShouldAddRule(1, "没有与指定条件相匹配的规则。"));
            Program.CheckTrue(failures, ref cases, "幂等：show 失败但输出里已有规则名 → 不加",
                !ShouldAddRule(1, "orbita-guest-bridge-49686"));
            Program.CheckString(failures, ref cases, "fwAllowed 字段片段（true）", ",\"fwAllowed\":true",
                FirewallField(true));
            Program.CheckString(failures, ref cases, "fwAllowed 字段片段（false）", ",\"fwAllowed\":false",
                FirewallField(false));
            Program.CheckString(failures, ref cases, "fwStateOff 字段片段（true）", ",\"fwStateOff\":true",
                FirewallStateField(true));
            Program.CheckString(failures, ref cases, "fwStateOff 字段片段（false）", ",\"fwStateOff\":false",
                FirewallStateField(false));
            // ---- 弹框识别（0.8.4）：只验匹配条件，宿主上不枚举窗口 ----
            Program.CheckTrue(failures, ref cases, "弹框：中文标题命中（Windows 安全中心）",
                IsFirewallPrompt("#32770", "Windows 安全中心", ""));
            Program.CheckTrue(failures, ref cases, "弹框：英文标题命中（Windows Security Alert）",
                IsFirewallPrompt("#32770", "Windows Security Alert", ""));
            Program.CheckTrue(failures, ref cases, "弹框：标题没命中但正文带程序名也命中（最不怕本地化）",
                IsFirewallPrompt("#32770", "某个提示",
                    "Windows 防火墙已阻止所有公用网络和专用网络上的 orbita-guest-bridge 的某些功能。"));
            Program.CheckTrue(failures, ref cases, "弹框：正文大小写不敏感",
                IsFirewallPrompt("#32770", "", "Blocked ORBITA-GUEST-BRIDGE"));
            Program.CheckTrue(failures, ref cases, "弹框：类名不是 #32770 一律不碰（别误关 Security 应用主窗口）",
                !IsFirewallPrompt("ApplicationFrameWindow", "Windows 安全中心", "orbita-guest-bridge"));
            Program.CheckTrue(failures, ref cases, "弹框：无关的标准对话框不碰",
                !IsFirewallPrompt("#32770", "确认删除", "确实要删除这个文件吗？"));
            Program.CheckTrue(failures, ref cases, "弹框：空标题空正文不碰", !IsFirewallPrompt("#32770", "", ""));

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
