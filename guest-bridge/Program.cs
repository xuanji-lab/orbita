// Orbita guest bridge —— 跑在 Windows Sandbox 内的极简命令执行器。
//
// 通道 = **两条，一条语义**（0.8.0）。
//
//   ① TCP（优先）：桥在 guest 里监听一个系统分配的端口，把 port / token / ipv4 通告到
//      bridge.json；宿主主动连进来，一行一条 JSON（TcpChannel.cs）。为什么换：文件协议
//      每一跳传播实测 2.9–7.5 秒（guest 内部只有毫秒级），而 2026-10-25 的隔离沙箱实验里
//      宿主→guest 的 TCP 是握手 30ms、小包中位 1ms、64KB 往返 2–6ms，两侧都不用动防火墙。
//   ② 文件（回退 + 老宿主）：宿主防火墙曾把宿主↔沙箱的 TCP 当成不可测（2026-10-10 真机：
//      ICMP 通、TCP 被丢），而 .wsb 读写映射文件夹双向实时同步、每次都可靠。宿主把命令写进
//      out/cmd/<名字>.req.json（tmp+rename），桥轮询执行，结果写 <名字>.resp.json（截图的
//      JPEG 是同名 .jpg 兄弟文件），然后删掉 req；宿主读完响应后负责清理 resp/jpg。
//      这条通道的一条行为都没改：它就是没有 TCP 时的唯一通道，也是升级/降级时的安全网。
//
// 命令：ping（就绪探针）、screenshot（截主屏）、click / type / key / scroll（SendInput 注入），
// 以及 PR3 的 cdp-*（沙箱内 Edge 的 CDP 语义命令，实现在 Cdp.cs 的 CdpSession）。
// CDP 的 WebSocket 只在 guest 内（桥 ↔ 同机 Edge 的 127.0.0.1 端口），不过映射目录。
//
// ⚠ 0.7.0 起 **cdp-* 由该会话自己的 worker 子进程执行**（WorkerHost.cs）：桥是单线程轮询，
//   一条卡住的导航 / 截图会把整条桥堵死（队头阻塞），而一个会话的浏览器卡住不该拖累别的会话。
//   所以主桥只做转写 + 后台等待，超时就把 worker 连它的 Edge 一起杀掉。宿主侧协议**未变**。
//
// 轮询：**直探下一个序号的文件名**（File.Exists），不是目录枚举——映射文件夹的目录枚举
//   会被 RDP 驱动器重定向的缓存卡住（win+r 后 ~20s 看不见新文件，2026-10-14 真机实测）。
//   为什么、实测数据与兜底对齐都在 PollOnce 的注释里。
//
// ⚠ 输入类命令（click / type / key / scroll）**只允许在沙箱里执行**：SendInput 注入的是
//   当前会话的真实输入流，在宿主上跑就会劫持用户正在用的鼠标键盘（用户可能在开会、
//   共享屏幕）。桥的设计前提就是「跑在沙箱内」，宿主侧代码一律不得在宿主机上跑这些命令。
//
// 测试缝：请求里带 "dryRun":true 时，输入类命令**只解析不注入**，回执带解析结果
//   （坐标 / 键名→VK / 原文）。宿主上跑 guest-bridge/bridge.test.mjs 验键名映射与参数校验
//   就走它——宿主上真注入是红线。宿主主进程永远不发这个字段。
//
// 测试缝 2：桥启动时带 `--no-browser` 时，CDP 命令的**启动 Edge**那一步直接报错，
//   已经跑着的会话仍然工作。为什么需要：在宿主上跑 bridge.test.mjs 时，一条
//   cdp-nav / cdp-observe 就会去 Process.Start msedge.exe——那是用户的真实浏览器进程，
//   属于红线。带这个参数就能把参数校验、错误文案、幂等分派全验一遍，而不碰 Edge。
//   生产（.wsb 的 LogonCommand）不带它。
//
// 就绪通告：启动完成后写 out/bridge.json（tmp+rename）——它出现即代表命令循环已上线。
//
// 编译：node build.mjs（用 Windows 自带的 .NET Framework 4.x csc.exe，零第三方依赖）。
// 约束：单 exe、单进程、无持久化——沙箱每次重置即消失，不需要任何清理逻辑。
//   源码两个文件：Program.cs（文件协议与像素命令）+ Cdp.cs（浏览器通道），一起用 build.mjs 编。
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Collections.Generic;
using System.Diagnostics;
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
    // ⚠ 0.4.0 起多了 cdp-*（浏览器通道），0.5.0 起多了 launch / kill / screenshot-stats
    //（打包版 UI 冒烟：在沙箱里启动一份只读映射进来的 orbita.exe 并用像素统计判断它渲染没渲染），
    // 0.6.0 起**一个会话一个 Edge 实例**（cdp-* 带 session 字段，各自 profile / 端口，上限 4，
    // 空闲 5 分钟回收），0.7.0 起 cdp-* 由**该会话自己的 worker 子进程**执行（可超时杀；
    // 慢命令不再堵住整条桥，宿主侧协议不变），0.7.1 修了「超时杀完 worker、重开同一会话时
    // 读到上一只 Edge 的旧端口」那条自愈路上的 bug（起 Edge 前清端口文件 + 连接重试）。
    // 0.7.2 只加计量（命令行耗时分解 + 枚举兜底耗时 + 实验用 --align-every），协议与行为未变。
    // 0.8.0 多了一条 **TCP 命令通道**（TcpChannel.cs）：bridge.json 里通告 port / token / ipv4，
    //   宿主优先走它（文件协议每一跳 2.9–7.5s，TCP 只有毫秒级）。文件轮询循环与全部命令语义
    //   一个字都没改——它仍是老宿主的唯一通道、也是 TCP 不可用时的回退通道。
    // 0.8.1 修监听的结构性缺陷：accept 线程只管收连接（握手/命令/日志全在每条连接自己的线程里），
    //   hello 读 1s 硬超时，backlog 64，接入与心跳各有日志。文件协议与命令语义**未变**。
    // 0.8.2 启动时自己建一条防火墙入站允许规则：真机上「TCP 间歇不可达」的真因就是沙箱弹了
    //   防火墙提示、没人点「允许」（点了立刻 4ms 就通）。
    // 0.8.3 按**程序路径**的规则在真机被证明不放行（netsh 成功、连接仍全超时——桥从 junction
    //   出来的路径启动，镜像路径对不上），改成按**端口**放行 + 关掉沙箱内防火墙兜底；
    //   结果写进 bridge.json 的 fwAllowed / fwStateOff，宿主据此解释「为什么连不上」。
    // 0.8.4 把「关防火墙」提到**开始监听之前**（那个「是否允许」的提示框是 Windows 在程序第一次
    //   开始监听入站时弹的，之后再关防火墙收不回它，还抢焦点），并在监听后起一条 ~2s 的短任务
    //   把可能已经弹出的那个框收掉（枚举顶层窗口 → 精确匹配 → WM_CLOSE，只做一次）。
    // 宿主不逐字比版本，但 bridge.json 里的版本是排查现场的第一行证据：抬了能力就抬它。
    private const string Version = "0.8.4";
    private const string CmdDirName = "cmd";          // out 下的命令目录
    internal const string ReqSuffix = ".req.json";    // 宿主写：命令请求
    internal const string RespSuffix = ".resp.json";  // 桥写：执行结果
    private const int PollIntervalMs = 250;           // 命令轮询间隔

    // TCP 行协议的握手标记（与 shared/computer-use.ts 的 bridgeTcpHello 严格一致，一个字母都不能差）
    internal const string TcpHelloType = "hello";
    internal const string TcpHelloOkType = "hello-ok";
    internal const string TcpHelloFailType = "hello-fail";

    /**
     * 命令执行的串行闸门：文件轮询线程与每条 TCP 连接线程共用这一把锁。
     *
     * 为什么必须有：CdpSession 的状态在两个通道里是同一份（同一个会话的端口 / 标签页），
     * 两条命令并行进 Execute 就是互相踩。文件协议原本靠「单线程轮询」天然串行，加了 TCP
     * 就不再天然了——锁是这件事唯一便宜的保证。
     *
     * 锁只包 Execute 本身（cdp-* 在锁里只是投递 + 返回 null），等 worker 回执在锁外：
     * 否则一条 40 秒的导航会把别的会话（以及文件协议）整块堵住，正是 0.7.0 要消灭的队头阻塞。
     */
    internal static readonly object ExecuteGate = new object();

    private static string _outDir = "";
    private static string _cmdDir = "";
    /** --no-browser：测试模式，CDP 的“启动 Edge”直接报错（绝不 Process.Start msedge.exe） */
    internal static bool BrowserDisabled = false;

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const int SM_CXSCREEN = 0; // 主屏宽（进程 DPI aware 后为物理像素）
    private const int SM_CYSCREEN = 1; // 主屏高

    // ---- SendInput：输入注入（click / type / key / scroll）----

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    private const int INPUT_MOUSE = 0;
    private const int INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const int WHEEL_DELTA = 120; // 滚轮一格的单位
    /** 一次 SendInput 最多送多少个字符的注入事件（长文本分批发，单次数组不无限长） */
    private const int TYPE_CHUNK_CHARS = 64;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    private static int Main(string[] args)
    {
        // worker 入口：同一个 exe、另一条命令流（0.7.0）。必须在 ParseArgs 之前分流——
        // 它不写 bridge.json、不读 cmd\ 的主命令流，参数也与主桥不同。
        if (args.Length > 0 && args[0] == "--cdp-worker") return RunWorkerMode(args);
        // 测试专用入口（宿主上跑 bridge.test.mjs）：只验 JSON 取值器，不碰协议、不碰桌面。
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--selftest-json") return RunJsonSelfTest();
            // 打包产物冒烟的路径闸门自测（纯函数：不启动任何进程、不碰桌面）
            if (args[i] == "--selftest-launch") return RunLaunchSelfTest();
            // 会话 id 安全化的自测（纯函数：CDP 会话键直接拼进 profile 目录，这一关失守就是路径穿越）
            if (args[i] == "--selftest-session") return RunSessionSelfTest();
            // 浏览器错误页判定的自测（纯函数：不启动任何进程、不碰 Edge）
            if (args[i] == "--selftest-cdp") return RunCdpSelfTest();
            // 耗时计量的自测（纯函数 + 临时目录里一条真 ping；不启动任何进程、不碰桌面）
            if (args[i] == "--selftest-metrics") return RunMetricsSelfTest();
            // worker 层的自测（起真进程、不碰 Edge）：拉起 / 超时被杀 / 崩了能重启 / 自己退出
            if (args[i] == "--selftest-worker") return WorkerHost.RunSelfTest();
            // TCP 通道的自测（本进程里起监听、127.0.0.1 连回来；不启 Edge、不碰桌面）
            if (args[i] == "--selftest-tcp") return TcpChannel.RunSelfTest();
        }
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

        Log("启动：版本 " + Version + "，命令目录 " + _cmdDir + "，轮询 " + PollIntervalMs + "ms"
            + "，对齐枚举周期：每 " + AlignEveryPolls + " 轮，耗时日志阈值 " + HopLogThresholdMs + "ms");

        // TCP 命令行通道：起不来只记一行日志，文件协议照旧是主路
        // 必须在通告之前——bridge.json 里带了端口才代表 TCP 可用（宿主靠这个字段判断）
        TcpChannel.Start();

        // 就绪通告：bridge.json 出现 = 命令循环已上线（宿主据此宣布沙箱 running）
        WriteBridgeJson();

        CommandLoop(); // 永续轮询，直到沙箱销毁
        return 0;
    }

    /** out 目录（映射文件夹的 guest 侧根）：worker 目录、启动通告都落在它下面 */
    internal static string OutDir
    {
        get { return _outDir; }
    }

    /** 主命令目录（out\cmd）：宿主的文件协议入口，也是回执的落点 */
    internal static string CmdDir
    {
        get { return _cmdDir; }
    }

    /**
     * worker 入口（0.7.0）：`--cdp-worker <outDir> <session> [--no-browser] [--test-hooks] [--parent-pid N]`。
     *
     * 与主桥共用同一个 exe，但**不做**主桥的任何事：不写 bridge.json、不读 cmd\、不碰输入注入。
     * `--no-browser` 必须由主桥传下来——真正会 Process.Start msedge.exe 的是这个进程。
     */
    private static int RunWorkerMode(string[] args)
    {
        string outDir = args.Length > 1 ? args[1] : "";
        string session = args.Length > 2 ? args[2] : "";
        if (outDir.Length == 0 || session.Length == 0)
        {
            Log("--cdp-worker 需要 <outDir> <session>");
            return 1;
        }
        bool testHooks = false;
        int parentPid = 0;
        for (int i = 3; i < args.Length; i++)
        {
            if (args[i] == "--no-browser")
            {
                BrowserDisabled = true;
                continue;
            }
            if (args[i] == "--test-hooks")
            {
                testHooks = true;
                WorkerHost.TestHooks = true;
                continue;
            }
            if (args[i] == "--parent-pid" && i + 1 < args.Length)
            {
                int.TryParse(args[i + 1], out parentPid);
                i++;
                continue;
            }
            Log("worker 收到未知参数：" + args[i]);
            return 1;
        }
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        // worker 自己的日志落到映射目录：这是宿主**唯一**能看见 guest 内部发生了什么的通道
        RedirectWorkerLog(outDir, session);
        return WorkerHost.RunWorker(outDir, session, testHooks, parentPid);
    }

    /**
     * worker.log 的单文件上限。超了清空重写（长跑的 worker 不能把映射目录撑爆）；
     * 1 MB 按一行 ~100 字节算是一万行，足够一个会话一局的诊断量。
     */
    private const long WorkerLogMaxBytes = 1024 * 1024;

    /**
     * 把 worker 的 Console 输出（stdout / stderr）接到 `out\worker\<会话>\worker.log`。
     *
     * 为什么要它（2026-10-25 真机）：`.wsb` 的 LogonCommand 只把**主桥**的 stdout 重定向进
     * out\bridge.log；worker 是 Process.Start 起的子进程，它自己的 Console 输出在真机上哪里都
     * 看不到——「CDP 启动 Edge…」「CDP 端口…」「错误页诊断」「注入失败原因」全部丢掉，宿主侧
     * 只能靠猜（错误页正文拿不到码，猜了三轮）。现在 worker 自己把输出写进映射目录，
     * 宿主直接读得到。
     *
     * 为什么不是主桥 RedirectStandardOutput + 转发：那是同步管道，父进程不读干子进程就阻塞，
     * 而主桥是单线程轮询循环（0.7.0 存在的理由就是不许被一条慢命令堵住）。**主桥一个
     * RedirectStandard* 都没加，没有新增任何同步等待**。
     *
     * 每次 worker 启动覆盖重建（每次重启只看这一次的现场，不会与上一具尸体的话搵在一起）。
     */
    private static void RedirectWorkerLog(string outDir, string session)
    {
        string key = CdpSessions.SafeSessionId(session);
        string dir = Path.Combine(outDir, WorkerHost.WorkerDirName, key);
        string path = Path.Combine(dir, "worker.log");
        try
        {
            Directory.CreateDirectory(dir);
            CappedFileWriter writer = new CappedFileWriter(path, WorkerLogMaxBytes);
            Console.SetOut(writer);
            Console.SetError(writer);
            Log("worker 日志文件：" + path);
        }
        catch (Exception ex)
        {
            // 落不了盘就退回 stdout（不能因为日志把 worker 弄死，它还有活儿要干）
            Log("worker 日志文件建不起来（" + path + "）：" + ex.Message + "，退回 stdout");
        }
    }

    /**
     * 写 worker.log 的 TextWriter：只接管 Write(string) / Write(char)——Console.Write / WriteLine
     * 的所有重载最终都落到这两条（base 的 WriteLine 先 Write(string) 再写换行）。
     * 超过上限就 dispose 重开（FileMode.Create = 清空），不会在文件里留洞。
     */
    private sealed class CappedFileWriter : TextWriter
    {
        private readonly string _path;
        private readonly long _maxBytes;
        private readonly object _gate = new object();
        private StreamWriter _inner;

        internal CappedFileWriter(string path, long maxBytes)
        {
            _path = path;
            _maxBytes = maxBytes;
            _inner = Create(_path);
        }

        private static StreamWriter Create(string path)
        {
            FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write,
                FileShare.ReadWrite | FileShare.Delete);
            StreamWriter w = new StreamWriter(fs, new UTF8Encoding(false));
            w.AutoFlush = true; // 被 taskkill 也要留下已经写过的行
            return w;
        }

        public override Encoding Encoding
        {
            get { return Encoding.UTF8; }
        }

        public override void Write(string value)
        {
            if (value == null) return;
            lock (_gate)
            {
                RotateIfNeeded();
                _inner.Write(value);
            }
        }

        public override void Write(char value)
        {
            lock (_gate)
            {
                RotateIfNeeded();
                _inner.Write(value);
            }
        }

        public override void Flush()
        {
            lock (_gate)
            {
                try { _inner.Flush(); } catch { }
            }
        }

        private void RotateIfNeeded()
        {
            try
            {
                if (_inner.BaseStream.Length < _maxBytes) return;
            }
            catch
            {
                return;
            }
            try { _inner.Dispose(); } catch { }
            _inner = Create(_path);
            _inner.Write("[" + DateTime.Now.ToString("HH:mm:ss") + "] [bridge] （日志超过 "
                + (_maxBytes / 1024) + " KB，已清空重写）\r\n");
        }
    }

    // ---- 参数解析 ----

    private static bool ParseArgs(string[] args)
    {
        int i = 0;
        while (i < args.Length)
        {
            string flag = args[i];
            i++;
            if (flag == "--no-browser")
            {
                BrowserDisabled = true;
                continue;
            }
            // 测试缝（只有宿主上的 bridge.test.mjs 带）：**不跑 netsh**。宿主机上改用户防火墙
            // 是红线，而集成测试要起真桥。生产（.wsb 的 LogonCommand）永不带它。
            if (flag == "--no-firewall")
            {
                TcpChannel.SkipFirewallForSelfTest();
                continue;
            }
            // 测试缝（只有 --selftest-worker 起子桥时带）：认 worker-* 命令，并把一条 worker
            // 命令的放弃线缩到 2.5s（自测不能等 40 秒）。生产（.wsb 的 LogonCommand）永不带它。
            if (flag == "--test-hooks")
            {
                WorkerHost.TestHooks = true;
                WorkerHost.CommandTimeoutMs = 2500;
                continue;
            }
            // 实验缝（2026-10-25 传播延迟实验）：把「每几轮做一次全量枚举」的周期换成 N，
            // 让同一次真机实验里能对比 16 / 64 / 160 三档。生产（.wsb 的 LogonCommand）只带
            // --out-dir，不带它，行为与改前逐字一致。**只改计量对比用的周期，默认值不动。**
            if (flag == "--align-every")
            {
                if (i >= args.Length)
                {
                    Log("参数 --align-every 缺少值");
                    return false;
                }
                if (!TryParseAlignEvery(args[i], out AlignEveryPolls))
                {
                    Log("--align-every 需要 ≥ 1 的整数，实得：" + args[i]);
                    return false;
                }
                i++;
                continue;
            }
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

    /**
     * 就绪通告。0.8.0 起多三个 TCP 字段（port / token / ipv4）——**三个齐了宿主的 TCP 才可用**，
     * 缺一个它就当老桥、只走文件协议，所以监听没起来时一个都不写。
     *
     * 令牌明文写在这里是**有意的**：bridge.json 在宿主自己的目录里（沙箱经映射文件夹只读/读写它），
     * 宿主拿它当口令；日志里则绝不打（日志会进 PR、进截图）。
     */
    private static void WriteBridgeJson()
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"version\":").Append(JsonQuote(Version))
            .Append(",\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id)
            // 防火墙放行结果：false 时宿主要能说清「连不上是因为沙箱防火墙没放行」，
            // 而不是继续盲猜网络。fwStateOff = 是否干脆把沙箱防火墙关掉了（兜底那条路）。
            // 老宿主不认识这两个字段，忽略即可。
            .Append(TcpChannel.FirewallField(TcpChannel.FirewallAllowed))
            .Append(TcpChannel.FirewallStateField(TcpChannel.FirewallDisabled));
        if (TcpChannel.Port > 0 && TcpChannel.Token.Length > 0)
        {
            json.Append(",\"port\":").Append(TcpChannel.Port)
                .Append(",\"token\":").Append(JsonQuote(TcpChannel.Token))
                .Append(",\"ipv4\":").Append(TcpChannel.IPv4Json(TcpChannel.LocalIPv4()));
        }
        json.Append("}");
        AtomicWrite(Path.Combine(_outDir, "bridge.json"), Encoding.UTF8.GetBytes(json.ToString()));
        Log("已就绪（bridge.json 已通告"
            + (TcpChannel.Port > 0 ? "，TCP 端口 " + TcpChannel.Port : "，仅文件协议") + "）");
    }

    /**
     * 自测用：把 out / cmd 目录指到一个临时目录（只有 --selftest-tcp 走它）。
     * TCP 自测要跑**真的** Execute 与**真的**文件协议各一条，两者都需要这两个目录。
     */
    internal static void UseDirsForSelfTest(string outDir)
    {
        _outDir = outDir;
        _cmdDir = Path.Combine(outDir, CmdDirName);
        _nextSeq = 1;
        _polls = 0;
        _lastPollEndMs = -1;
        Directory.CreateDirectory(_cmdDir);
    }

    /** 自测用：跑一轮文件轮询（PollOnce 是私有实现，自测不复制一份） */
    internal static void PollOnceForSelfTest()
    {
        PollOnce();
    }

    // tmp + rename 原子写：对端可能在任何时刻读，不许读到半截文件
    internal static void AtomicWrite(string finalPath, byte[] bytes)
    {
        string tmpPath = finalPath + ".tmp";
        File.WriteAllBytes(tmpPath, bytes);
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(tmpPath, finalPath);
    }

    // ---- 命令循环：直探下一个序号，周期性全量对齐 ----

    /** 下一个期望的命令序号。宿主的名字是 cmd-<6 位递增>.req.json，每局从 1 起 */
    private static int _nextSeq = 1;
    /** 快路径连续落空的次数（慢路径按它定期对齐） */
    private static int _polls = 0;
    /** 全量枚举对齐的默认周期：16 × 250ms ≈ 4s（实验可用 --align-every 覆盖，默认值不许动） */
    private const int AlignEveryPollsDefault = 16;
    /** 生效的全量枚举周期。生产路径永远等于 AlignEveryPollsDefault */
    internal static int AlignEveryPolls = AlignEveryPollsDefault;

    private static void CommandLoop()
    {
        while (true)
        {
            try
            {
                PollOnce();
                // 空闲浏览器实例的回收：每轮都看一眼（没有 worker 时立刻返回）。
                // 放在这里而不是命令里：一只空闲的 Edge 没有任何命令会经过它，
                // 不在循环里主动看就永远不会被收。0.7.0 起回收的是「worker + 它的 Edge + profile」。
                WorkerHost.ReapIdle();
            }
            catch (Exception ex)
            {
                // 单轮失败不许弄死循环（映射目录抖动等），记下继续
                Log("轮询异常：" + ex.Message);
            }
            finally
            {
                // 计量：下一轮看见命令时，用它算「看见前等了上一轮循环多久」（含 250ms 睡眠与 ReapIdle）
                _lastPollEndMs = _clock.ElapsedMilliseconds;
            }
            Thread.Sleep(PollIntervalMs);
        }
    }

    /**
     * 一轮轮询。
     *
     * **快路径是「直探下一个序号的文件名」，不是目录枚举**。这不是优化，是正确性：
     * 映射文件夹走 RDP 驱动器重定向，**目录枚举结果会被缓存卡住**。
     * 2026-10-14 真机实测（三轮）：win+r 弹出「运行」框之后，宿主刚写进的 req 在
     * Directory.GetFiles 里 20 秒内看不见——而桥活着（心跳每 4s 照落盘）、
     * guest→host 方向全程通畅，所以不是通道死了、也不是宿主没写。
     * 触发面只有 win+r 这类壳对话框：escape / click 之后立刻 type 只要 433ms。
     * File.Exists 走直接路径查询，同场景 8.4s 就看到（枚举 20.7s）——所以直探是主路。
     * 宿主侧的超时因此放到 45s（bridge-client.ts），给这个黑窗留余量。
     */
    private static void PollOnce()
    {
        string expected = Path.Combine(_cmdDir, "cmd-" + _nextSeq.ToString("000000") + ReqSuffix);
        // 直探本身的耗时也要记：慢映射目录上 File.Exists 自己就可能要几秒（2026-10-14 实测 8.4s），
        // 不单独量就分不清「卡在枚举」还是「卡在这条探测上」
        long probeStart = _clock.ElapsedMilliseconds;
        bool exists = File.Exists(expected);
        long probeMs = _clock.ElapsedMilliseconds - probeStart;
        DateTime seenUtc = DateTime.UtcNow; // 「本进程第一次看见」的墙钟时刻（传播就以它为终点）
        if (exists)
        {
            ProcessOne(expected, probeMs, "快路径", seenUtc, _clock.ElapsedMilliseconds);
            _nextSeq++;
            return;
        }
        // 慢路径：每 ~4s 全量枚举一次，把 _nextSeq 拉回真实位置。
        // 直探只认「下一个」，所以宿主跳号（写失败 / 双宿主并发 / 上一局残留）时得靠它兜底；
        // 快路径一旦落空就一直落空（_nextSeq 卡住），所以这个计数器必然在走，不会饿死。
        _polls++;
        if (_polls % AlignEveryPolls != 0) return;
        AlignFromEnumeration();
    }

    /** 全量枚举对齐：处理枚举到的每个请求，并按文件名把 _nextSeq 推到已见最大序号之后 */
    private static void AlignFromEnumeration()
    {
        _alignRounds++;
        long alignStart = _clock.ElapsedMilliseconds;
        string[] reqs = Directory.GetFiles(_cmdDir, "*" + ReqSuffix);
        long enumMs = _clock.ElapsedMilliseconds - alignStart; // 只有这一条是目录枚举本身
        DateTime seenUtc = DateTime.UtcNow;
        long seenMs = _clock.ElapsedMilliseconds;
        Array.Sort(reqs, StringComparer.Ordinal); // 名字即顺序（宿主命名带递增序号）
        foreach (string reqPath in reqs)
        {
            ProcessOne(reqPath, -1, "枚举兜底", seenUtc, seenMs);
            string name = Path.GetFileName(reqPath);
            int seen;
            // cmd-000042.req.json → 序号在 [4, 10)
            if (name.Length >= 14 && int.TryParse(name.Substring(4, 6), out seen) && seen >= _nextSeq)
                _nextSeq = seen + 1;
        }
        long alignMs = _clock.ElapsedMilliseconds - alignStart;
        // 这一行回答「全量枚举兜底是不是把单线程轮询整块占住了」：慢映射目录上它一次能跑 8–20s，
        // 而它跑的时候快路径根本没机会被看一眼。只在到阈值时打。
        if (alignMs >= HopLogThresholdMs)
            Log(FormatAlignLine(_alignRounds, _polls, alignMs, enumMs, reqs.Length));
    }

    // ---- 计量：一次文件往返的耗时分解（只打日志，不参与任何控制流） ----
    //
    // 为什么先计量（2026-10-25 真机）：Edge 在连不可路由地址（连接风暴）时，宿主↔guest 的
    // 一次 ping 往返从 200ms 涨到 15–19s，而对照实验只排除了 worker 的等待。三个候选原因
    // 都能从这一段日志里读出来，不需要改行为去试：
    //   ① 全量枚举兜底（AlignFromEnumeration）在慢映射目录上把单线程轮询整块占住——
    //      看「对齐枚举耗时」那行，以及命令行里「看见前等上一轮循环」有多大；
    //   ② 跨 VM 的传播延迟本身（host 写 req → guest 看见）——看「传播」；
    //   ③ 单条命令内部的几次文件操作（读 req / 写 resp / 删 req）在慢盘上各要几秒——看
    //      「读请求」「回执落盘」，以及直探 File.Exists 与 mtime 查询各自的耗时。
    // 纪律：这条链路里**没有新增任何让命令变慢的等待**，唯一的额外开销是一次
    // File.GetLastWriteTimeUtc（它自己的耗时也打进日志，真慢了藏不住）。
    // 默认只在任一段 ≥ 500ms 时打一行，避免把 bridge.log 刷爆。
    // 这些日志将来留不留：先留一版（传播延迟是 computer use 的结构性成本，排查下一次
    // 「沙箱怎么这么慢」时它就是第一手证据）；如果之后证明每次都在 200ms 以下、一行不落，
    // 再连同 --align-every 一起删。

    /** 单调时钟：所有时长都用它量（墙钟会被 NTP 调，传播那一段需要墙钟，见 PropagateFromMtime） */
    private static readonly Stopwatch _clock = Stopwatch.StartNew();
    /** 上一轮 CommandLoop 结束时刻（_clock 口径，毫秒）；-1 = 还没有上一轮 */
    private static long _lastPollEndMs = -1;
    /** AlignFromEnumeration 跑了多少轮（日志里的「第 N 轮」） */
    private static int _alignRounds = 0;
    /** 耗时日志的打印线：任一段到线就打一行（实验时自测会临时压到 0） */
    private static int HopLogThresholdMs = 500;
    /** 传播延迟的可信窗口：超过它只可能是时基问题，不是真的传播 */
    private const long PropagateTrustedMaxMs = 120000;

    /** 一条命令的耗时分解。字段全是毫秒；-1 = 未知 / 不适用。 */
    internal sealed class HopReport
    {
        public string Command = "";
        public string Source = "快路径";
        public long PropagateMs = -1;
        public string PropagateNote = "未知";
        public long PollWaitMs = -1;
        public long ProbeMs = 0;
        public long MtimeQueryMs = 0;
        public long ReadMs = 0;
        public long ExecuteMs = 0;
        public bool Forwarded = false;
        public long PersistMs = 0;
    }

    /**
     * mtime 法估「传播延迟」。宿主写 req 用 tmp+rename，映射目录里留下的 mtime 就是宿主的写出
     * 时刻；与 guest 侧第一次看见该文件时的 UtcNow 相减，即 req 写出 → 本进程看见。
     *
     * 三种情况这个数不可信，返回 -1 并让 note 说清为什么（日志里就是「传播未知：…」）：
     *  - mtime 缺失：映射层没带时间戳时 .NET 回 1601-01-01（FAT 是 1980），相减会得到几百万天；
     *  - mtime 晚于本地时钟：宿主与 guest 的时基不一致，差值没有意义；
     *  - 差值超过 120s：比宿主侧 45s 命令超时还大，只可能是时基问题。
     */
    internal static long PropagateFromMtime(DateTime mtimeUtc, DateTime nowUtc, out string note)
    {
        if (mtimeUtc.Year < 1981)
        {
            note = "mtime 缺失（" + mtimeUtc.ToString("yyyy-MM-dd") + "）";
            return -1;
        }
        double deltaMs = (nowUtc - mtimeUtc).TotalMilliseconds;
        if (deltaMs < 0)
        {
            note = "时基差 +" + ((long)(-deltaMs)) + "ms（mtime 晚于本地时钟）";
            return -1;
        }
        if (deltaMs > PropagateTrustedMaxMs)
        {
            note = "mtime 落后 " + ((long)deltaMs) + "ms，超出 " + (PropagateTrustedMaxMs / 1000) + "s 可信窗口";
            return -1;
        }
        note = "mtime 法";
        return (long)deltaMs;
    }

    /** 任一段到线就打（阈值就是打印线：≥ 阈值打，< 阈值不打） */
    internal static bool HopNeedsLog(long thresholdMs, long[] segments)
    {
        for (int i = 0; i < segments.Length; i++)
        {
            if (segments[i] >= thresholdMs) return true;
        }
        return false;
    }

    private static string Ms(long ms)
    {
        return ms + "ms";
    }

    /** 耗时日志的打印线（worker 侧的计量与桥的文件往返用同一个阈值） */
    internal static int HopLogLineMs
    {
        get { return HopLogThresholdMs; }
    }

    /**
     * 一条命令行。算术上只有两种，取决于传播是否可信：
     *  - 可信：总 = 传播 + 读请求 + 执行 + 回执落盘（总 = 宿主写出 → 回执落盘）；
     *    「看见前等上一轮循环」是**传播内部**的细分——两者都从各自的起点量到「看见」，
     *    相加就是把同一段时间算两遍，所以它只跟在后面、不计入总。
     *  - 不可信：总 = 轮询等待 + 读请求 + 执行 + 回执落盘，且只能算「本进程内」的下界。
     */
    internal static string FormatHopLine(HopReport r)
    {
        long inner = r.ReadMs + r.ExecuteMs + r.PersistMs;
        List<string> parts = new List<string>();
        if (r.PollWaitMs >= 0 && r.PropagateMs < 0) parts.Add("轮询等待 " + Ms(r.PollWaitMs));
        parts.Add("读请求 " + Ms(r.ReadMs));
        parts.Add("执行 " + Ms(r.ExecuteMs) + (r.Forwarded ? "（转发 worker，不是浏览器真干活的耗时）" : ""));
        parts.Add("回执落盘 " + Ms(r.PersistMs));

        StringBuilder sb = new StringBuilder("命令 " + r.Command + "：");
        if (r.PropagateMs >= 0)
        {
            sb.Append("总 ").Append(Ms(r.PropagateMs + inner)).Append("（宿主写出→回执落盘）＝ ")
              .Append("传播 ").Append(Ms(r.PropagateMs)).Append("（").Append(r.PropagateNote).Append("） + ");
        }
        else
        {
            long total = (r.PollWaitMs >= 0 ? r.PollWaitMs : 0) + inner;
            sb.Append("本进程内 ").Append(Ms(total)).Append("（传播未知：").Append(r.PropagateNote).Append("）＝ ");
        }
        sb.Append(string.Join(" + ", parts.ToArray()));
        if (r.PropagateMs >= 0 && r.PollWaitMs >= 0)
            sb.Append("；看见前等上一轮循环 ").Append(Ms(r.PollWaitMs)).Append("（细分，已含在传播里，不计入总）");
        sb.Append("；本轮直探 File.Exists ").Append(Ms(r.ProbeMs))
          .Append("、mtime 查询 ").Append(Ms(r.MtimeQueryMs))
          .Append("、来源 ").Append(r.Source);
        return sb.ToString();
    }

    /** 枚举兜底那一行（只在到阈值时打）：它是「单线程轮询被整块占住」的直接证据 */
    internal static string FormatAlignLine(int round, int polls, long alignMs, long enumMs, int visible)
    {
        return "对齐枚举耗时 " + Ms(alignMs) + "（第 " + round + " 轮，_polls=" + polls
            + "，目录可见 " + visible + " 项；其中 Directory.GetFiles " + Ms(enumMs) + "）";
    }

    /**
     * 处理一个请求文件：读 → 执行 → 写 resp → 删 req。
     * 读失败（宿主 rename 途中的瞬时点 / 文件被占）**静默下轮**：不写 resp、不删 req、
     * 不弄死循环——下一轮直探同一个名字会再试一次。
     *
     * probeMs / source / seenUtc / seenMs 全部只服务计量：probeMs = 本轮直探 File.Exists 的耗时，
     * source = 快路径还是枚举兜底，seenUtc = 本进程第一次看见它的墙钟时刻（传播的终点），
     * seenMs = 同一时刻的单调时钟值（算轮询等待）。它们一个都不进控制流。
     */
    private static void ProcessOne(string reqPath, long probeMs, string source, DateTime seenUtc, long seenMs)
    {
        string name = Path.GetFileName(reqPath);
        string baseName = name.Substring(0, name.Length - ReqSuffix.Length);

        HopReport hop = new HopReport();
        hop.Command = baseName;
        hop.Source = source;
        hop.ProbeMs = probeMs < 0 ? 0 : probeMs;
        hop.PollWaitMs = _lastPollEndMs < 0 ? -1 : seenMs - _lastPollEndMs;
        long mtimeStart = _clock.ElapsedMilliseconds;
        DateTime mtimeUtc = File.GetLastWriteTimeUtc(reqPath);
        hop.MtimeQueryMs = _clock.ElapsedMilliseconds - mtimeStart;
        string note;
        hop.PropagateMs = PropagateFromMtime(mtimeUtc, seenUtc, out note);
        hop.PropagateNote = note;

        long readStart = _clock.ElapsedMilliseconds;
        string raw;
        try
        {
            raw = File.ReadAllText(reqPath, Encoding.UTF8);
        }
        catch
        {
            // 只有在「读本身就很慢」时留一行：连接风暴里这条重试每 250ms 一次，不加条件会刷爆日志
            long failedMs = _clock.ElapsedMilliseconds - readStart;
            if (failedMs >= HopLogThresholdMs)
                Log("命令 " + baseName + "：读 req 失败 " + Ms(failedMs) + "（下轮重试）");
            return; // 宿主 rename 途中的瞬时点，下轮再来
        }
        hop.ReadMs = _clock.ElapsedMilliseconds - readStart;
        Log("收到命令 " + name);
        long execStart = _clock.ElapsedMilliseconds;
        string respJson;
        // TCP 通道的命令在别的线程上执行：两个通道共用一把锁（理由见 ExecuteGate）
        lock (ExecuteGate)
        {
            respJson = Execute(raw, baseName);
        }
        hop.ExecuteMs = _clock.ElapsedMilliseconds - execStart;
        // null = 这条命令已经转给该会话的 worker，回执由后台线程写（慢命令不许占住轮询循环）
        hop.Forwarded = respJson == null;
        long persistStart = _clock.ElapsedMilliseconds;
        if (respJson != null)
            AtomicWrite(Path.Combine(_cmdDir, baseName + RespSuffix), Encoding.UTF8.GetBytes(respJson));
        // 主命令流里的这一条已受理：立刻删掉，免得下一轮又执行一遍（worker 侧另有自己的 req）
        try { File.Delete(reqPath); } catch { }
        hop.PersistMs = _clock.ElapsedMilliseconds - persistStart;

        if (HopNeedsLog(HopLogThresholdMs, new long[] {
            hop.PropagateMs, hop.PollWaitMs, hop.ProbeMs, hop.MtimeQueryMs,
            hop.ReadMs, hop.ExecuteMs, hop.PersistMs }))
        {
            Log(FormatHopLine(hop));
        }
    }

    // ---- 命令执行 ----

    internal static string Execute(string raw, string baseName)
    {
        string command = ExtractString(raw, "command");
        if (command == null) return "{\"ok\":false,\"error\":\"请求里缺 command 字段\"}";
        // ping = 宿主的就绪探针：映射文件夹 host→guest 方向开机后有 ~20 秒热身期（实测），
        // 桥通告了不代表命令通道已通——宿主必须等到 ping 应答才能宣布 running
        if (command == "ping") return "{\"ok\":true}";
        if (command == "screenshot") return ExecuteScreenshot(raw, baseName);
        if (command == "click") return ExecuteClick(raw);
        if (command == "type") return ExecuteType(raw);
        if (command == "key") return ExecuteKey(raw);
        if (command == "scroll") return ExecuteScroll(raw);
        // 打包产物冒烟（0.5.0）：起 / 停映射进来的 exe，以及只回数字的截图统计
        if (command == "launch") return ExecuteLaunch(raw);
        if (command == "kill") return ExecuteKill(raw);
        if (command == "screenshot-stats") return ExecuteScreenshotStats(raw);
        // CDP 浏览器通道（PR3）：一条语义命令 = 一次文件往返，内部可以有多条 CDP 消息。
        // 实现在 Cdp.cs；0.6.0 起一个会话一个实例；**0.7.0 起交给该会话自己的 worker 子进程**
        //（WorkerHost.cs 按 session 字段路由，不传就是 default，与改动前同一份行为）。
        // 返回 null = 已经交给后台等待线程，回执由它写。
        if (command.Length > 4 && command.Substring(0, 4) == "cdp-") return WorkerHost.Execute(command, raw, baseName);
        // 测试缝：worker 层的命令（只有 --test-hooks 的桥认它们，生产永远到不了这一行）
        if (WorkerHost.TestHooks && WorkerHost.IsWorkerTestCommand(command))
            return WorkerHost.Execute(command, raw, baseName);
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

    // ---- 打包产物冒烟：launch / kill / screenshot-stats（0.5.0）----
    //
    // 用途：在**干净、一次性**的沙箱里验证「打包出的 orbita.exe 能起来并渲染」——
    // 宿主把 dist/win-unpacked 只读映射成 C:\Users\WDAGUtilityAccount\Desktop\orbita-app，
    // 冒烟脚本 launch 它、等几秒、用 screenshot-stats 断言画面非空，再 kill 掉。
    // 与像素工具（click/type）同一条纪律：真正碰桌面的动作只在沙箱里跑。

    /**
     * launch {path, args?, dryRun?}
     *
     * path 必须是**沙箱桌面的映射目录之内**的绝对路径。为什么要这层白名单：
     * 桥能 Process.Start 任何 exe，被换掉的宿主（或一段伪造的 req）就能让它拉起
     * 沙箱里的任意程序；而这条命令的全部用途只有「跑映射进来的打包产物」，
     * 边界收紧到桌面根目录不会失去任何能力。
     *
     * args 是**一条命令行字符串**（不是数组）：打包产物的启动参数就是
     * `--user-data-dir=...` 这种键值，交给 ProcessStartInfo 按 Windows 规则切比
     * 在桥里再实现一遍引号解析靠谱。
     *
     * dryRun（测试缝）：只做路径校验与解析、**不启动任何进程**，回执带解析结果。
     * bridge.test.mjs 在宿主上跑它——宿主上真启动一份打包版属于红线。
     */
    private static string ExecuteLaunch(string raw)
    {
        string path = ExtractJsonString(raw, "path");
        if (path == null || path.Trim().Length == 0)
            return "{\"ok\":false,\"error\":\"launch 需要 path 字段（沙箱内的绝对路径，指向映射进来的可执行文件）\"}";
        path = path.Trim();

        string rejection = GuestPathRejection(path);
        if (rejection != null)
            return "{\"ok\":false,\"error\":" + JsonQuote(rejection) + "}";
        if (!File.Exists(path))
            return "{\"ok\":false,\"error\":" + JsonQuote("沙箱里没有这个文件：" + path
                + "——宿主是不是还没出包？先把 dist/win-unpacked 映射进来（bun run dist:win）") + "}";

        string args = ExtractJsonString(raw, "args");
        if (args != null) args = args.Trim();

        if (ExtractBool(raw, "dryRun"))
            return "{\"ok\":true,\"dryRun\":true,\"path\":" + JsonQuote(path)
                + ",\"args\":" + (args == null ? "null" : JsonQuote(args)) + "}";

        try
        {
            ProcessStartInfo info = new ProcessStartInfo(path);
            if (args != null && args.Length > 0) info.Arguments = args;
            info.UseShellExecute = false;
            info.WorkingDirectory = Path.GetDirectoryName(path);
            Process started = Process.Start(info);
            if (started == null) throw new InvalidOperationException("进程没有起来（Process.Start 返回 null）");
            int pid = started.Id;
            // 句柄我们不需要：调完就放，进程本身继续跑（kill 按 pid 找它）
            started.Dispose();
            Log("launched " + path + (args == null ? "" : " " + args) + " → pid " + pid);
            return "{\"ok\":true,\"pid\":" + pid + ",\"path\":" + JsonQuote(path) + "}";
        }
        catch (Exception ex)
        {
            Log("启动失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + JsonQuote("启动 " + path + " 失败：" + ex.Message
                + "——若是缺 VC++ 运行库或 side-by-side 配置错，沙箱里跑不了这份产物，先看宿主能不能双击启动") + "}";
        }
    }

    /**
     * kill {pid}
     *
     * **只杀这一个 pid 的进程树**（Electron 是 主进程 + 一堆 renderer/GPU 子进程，
     * 只杀主进程会留一群孤儿）。**绝不按镜像名杀**——仓规的硬约束，而且沙箱里
     * 可能同时跑着别的 orbita.exe（用户手动开的），按名字杀会连它们一起带走。
     *
     * pid 不存在 / 已经退出都回 ok（幂等：冒烟脚本在 finally 里无脑调用）。
     */
    private static string ExecuteKill(string raw)
    {
        string pidRaw = ExtractNumber(raw, "pid");
        int pid;
        if (pidRaw == null || !int.TryParse(pidRaw, out pid) || pid <= 0)
            return "{\"ok\":false,\"error\":\"kill 需要整数 pid（launch 回执里的那个）\"}";

        bool dryRun = ExtractBool(raw, "dryRun"); // 测试缝：只校验参数，不杀任何进程
        bool existed;
        try
        {
            Process p = Process.GetProcessById(pid);
            existed = true;
            p.Dispose();
        }
        catch (ArgumentException)
        {
            existed = false; // 没有这个进程：幂等成功
        }
        if (!existed)
        {
            Log("kill " + pid + "：没有这个进程（已经退出）");
            return "{\"ok\":true,\"pid\":" + pid + ",\"alreadyGone\":true}";
        }
        if (dryRun)
            return "{\"ok\":true,\"dryRun\":true,\"pid\":" + pid + "}";

        try
        {
            // taskkill /T 是整棵树（Electron 的子进程不继承父进程的杀），/F 免确认
            ProcessStartInfo info = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Process killer = Process.Start(info);
            if (killer == null) throw new InvalidOperationException("taskkill 没有起来");
            string output = killer.StandardOutput.ReadToEnd() + killer.StandardError.ReadToEnd();
            killer.WaitForExit(15000);
            int code = killer.ExitCode;
            killer.Dispose();
            // taskkill 的退出码 128 = 进程已经不存在（竞态下正常），其它非 0 才当失败
            if (code != 0 && code != 128)
                return "{\"ok\":false,\"error\":" + JsonQuote("taskkill 失败（退出码 " + code + "）：" + output.Trim()) + "}";
            Log("killed pid " + pid + "（树）");
            return "{\"ok\":true,\"pid\":" + pid + "}";
        }
        catch (Exception ex)
        {
            Log("kill 失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + JsonQuote("终止 pid " + pid + " 失败：" + ex.Message) + "}";
        }
    }

    /**
     * screenshot-stats {maxWidth?}
     *
     * 只回**数字**，不回图：冒烟脚本用它断言「窗口非空、不是全黑/全白」，
     * 不需要宿主解 JPEG、也不需要基线图（基线图会在每次 UI 改版后过期）。
     *
     * 统计在缩到 ~640 宽的那张图上做——全屏逐像素对 4K 屏幕是 8M 次运算，
     * 缩样后 0.3M 次，而「有没有内容」这种结论在 640 宽上完全够。
     * 亮度 = (0.299R + 0.587G + 0.114B)，与常见的灰度公式一致；
     * blackRatio = 亮度 < 16 的占比，whiteRatio = 亮度 > 240 的占比。
     * distinctColors = 缩样后出现过的 (R,G,B) 种类数（上限 4096，够判「是不是纯色」）。
     */
    private const int StatsSampleWidth = 640;
    private const int StatsDistinctCap = 4096;

    private static string ExecuteScreenshotStats(string raw)
    {
        int maxWidth = StatsSampleWidth;
        string maxWidthRaw = ExtractNumber(raw, "maxWidth");
        if (maxWidthRaw != null && (!int.TryParse(maxWidthRaw, out maxWidth) || maxWidth <= 0))
            return "{\"ok\":false,\"error\":\"maxWidth 必须是正整数\"}";
        if (maxWidth > 2560) maxWidth = 2560;

        try
        {
            int width, height;
            double mean, stdDev, blackRatio, whiteRatio;
            int distinctColors;
            CaptureStats(maxWidth, out width, out height, out mean, out stdDev,
                out blackRatio, out whiteRatio, out distinctColors);
            Log("像素统计 " + width + "x" + height + " mean=" + mean.ToString("F1") + " sd=" + stdDev.ToString("F1")
                + " black=" + blackRatio.ToString("F3") + " white=" + whiteRatio.ToString("F3") + " colors=" + distinctColors);
            return "{\"ok\":true,\"width\":" + width + ",\"height\":" + height
                + ",\"mean\":" + mean.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"stdDev\":" + stdDev.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"blackRatio\":" + blackRatio.ToString("F4", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"whiteRatio\":" + whiteRatio.ToString("F4", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"distinctColors\":" + distinctColors + "}";
        }
        catch (Exception ex)
        {
            Log("像素统计失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + JsonQuote("像素统计失败：" + ex.Message) + "}";
        }
    }

    /**
     * 沙箱内允许 launch 的路径闸门：只认桌面根目录之下的绝对路径。
     *
     * 为什么是桌面根而不是「映射目录的 basename」：.wsb 的映射目录一律落在
     * C:\Users\WDAGUtilityAccount\Desktop\<名字>\，映射名可由宿主任意起
     * （PR5 的打包产物映射叫 orbita-app），桥不该把那个名字编译进来。
     * 桌面根仍然把范围钉死在「宿主拷进来的东西」，而 C:\Windows\... 之类一概拒绝。
     *
     * 路径先归一化：拒绝 `..`（`Desktop\..\Windows\system32\cmd.exe` 会被规范化成
     * 桌面之外的路径）。回 null = 放行。
     */
    internal static string GuestPathRejection(string path)
    {
        // 先判绝对路径：GetFullPath 会把相对路径接到**桥的工作目录**上，
        // 那是宿主不该知道的一个值（而且它在沙箱桌面下吗？不一定）——直接拒绝才可控。
        if (!Path.IsPathRooted(path))
            return "launch 的 path 必须是绝对路径：" + path;
        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception ex)
        {
            return "路径不合法：" + path + "（" + ex.Message + "）";
        }
        string allowRoot = GuestDesktopRoot(); // 带结尾反斜杠
        if (!full.StartsWith(allowRoot, StringComparison.OrdinalIgnoreCase))
            return "launch 只允许沙箱桌面下的路径（" + allowRoot + "），收到：" + full
                + "——宿主把产物映射进桌面后，路径形如 " + allowRoot + "orbita-app\\orbita.exe";
        if (!full.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            return "launch 只启动 .exe，收到：" + full;
        return null;
    }

    /** 沙箱桌面根（固定用户 WDAGUtilityAccount，WSB 的映射落点），带结尾反斜杠 */
    internal static string GuestDesktopRoot()
    {
        return WSB_DESKTOP_ROOT;
    }

    private const string WSB_DESKTOP_ROOT = "C:\\Users\\WDAGUtilityAccount\\Desktop\\";

    /**
     * 主屏 → 缩样图 → 逐像素统计。
     * 只读桌面，不改任何状态；失败（拿不到桌面尺寸 / 没有交互会话）抛异常给调用方翻成人话。
     */
    private static void CaptureStats(int maxWidth, out int width, out int height, out double mean,
        out double stdDev, out double blackRatio, out double whiteRatio, out int distinctColors)
    {
        int nativeW = GetSystemMetrics(SM_CXSCREEN);
        int nativeH = GetSystemMetrics(SM_CYSCREEN);
        if (nativeW <= 0 || nativeH <= 0)
            throw new InvalidOperationException("无法获取主屏尺寸（可能不在交互式桌面会话中）");

        width = nativeW;
        height = nativeH;
        int longEdge = Math.Max(nativeW, nativeH);
        if (longEdge > maxWidth)
        {
            double scale = (double)maxWidth / longEdge;
            width = Math.Max(1, (int)Math.Round(nativeW * scale));
            height = Math.Max(1, (int)Math.Round(nativeH * scale));
        }

        Bitmap full = new Bitmap(nativeW, nativeH);
        Bitmap sample = null;
        try
        {
            Graphics g = Graphics.FromImage(full);
            try { g.CopyFromScreen(0, 0, 0, 0, new Size(nativeW, nativeH)); }
            finally { g.Dispose(); }

            if (width != nativeW || height != nativeH)
            {
                sample = new Bitmap(width, height);
                Graphics g2 = Graphics.FromImage(sample);
                try
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.DrawImage(full, new Rectangle(0, 0, width, height),
                        new Rectangle(0, 0, nativeW, nativeH), GraphicsUnit.Pixel);
                }
                finally { g2.Dispose(); }
            }
            Bitmap target = sample != null ? sample : full;

            // 逐行拷成数组再算：Bitmap.GetPixel 每像素一次 GDI 调用，30 万次会拖到秒级
            System.Drawing.Imaging.BitmapData data = target.LockBits(
                new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                int absStride = Math.Abs(stride);
                byte[] buffer = new byte[absStride * height];
                Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);

                double sum = 0;
                double sumSq = 0;
                long black = 0;
                long white = 0;
                long count = (long)width * height;
                HashSet<int> colors = new HashSet<int>();
                bool colorsFull = false;
                for (int y = 0; y < height; y++)
                {
                    int row = y * absStride;
                    for (int x = 0; x < width; x++)
                    {
                        int at = row + x * 4;
                        byte b = buffer[at];
                        byte gr = buffer[at + 1];
                        byte r = buffer[at + 2];
                        double luma = 0.299 * r + 0.587 * gr + 0.114 * b;
                        sum += luma;
                        sumSq += luma * luma;
                        if (luma < 16) black++;
                        else if (luma > 240) white++;
                        if (!colorsFull)
                        {
                            colors.Add((r << 16) | (gr << 8) | b);
                            if (colors.Count >= StatsDistinctCap) colorsFull = true;
                        }
                    }
                }
                mean = sum / count;
                double variance = sumSq / count - mean * mean;
                stdDev = variance > 0 ? Math.Sqrt(variance) : 0;
                blackRatio = (double)black / count;
                whiteRatio = (double)white / count;
                distinctColors = colors.Count;
            }
            finally { target.UnlockBits(data); }
        }
        finally
        {
            if (sample != null) sample.Dispose();
            full.Dispose();
        }
    }

    // ---- 输入注入：click / type / key / scroll（SendInput）----

    /**
     * click {x, y, button, double}：把指针移到 (x, y) 并按一下（或双击）。
     * 坐标是**沙箱主屏的原生物理像素**（宿主已按回图/物理屏比例换算过）。
     * 绝对坐标要归一化到 0..65535（SendInput 的约定），主屏 1:1 映射。
     */
    private static string ExecuteClick(string raw)
    {
        int x, y;
        string bad = ReadPoint(raw, "click", out x, out y);
        if (bad != null) return bad;

        string button = ExtractString(raw, "button");
        if (button == null || button.Length == 0) button = "left";
        uint down, up;
        if (!TryButtonFlags(button, out down, out up))
            return "{\"ok\":false,\"error\":\"button 只能是 left / right / middle，收到：" + JsonEscape(button) + "\"}";
        bool dbl = ExtractBool(raw, "double");

        if (ExtractBool(raw, "dryRun"))
            return "{\"ok\":true,\"dryRun\":true,\"x\":" + x + ",\"y\":" + y
                + ",\"button\":\"" + JsonEscape(button) + "\",\"double\":" + (dbl ? "true" : "false") + "}";

        try
        {
            List<INPUT> inputs = new List<INPUT>();
            inputs.Add(MoveInput(x, y));
            int presses = dbl ? 2 : 1;
            for (int i = 0; i < presses; i++)
            {
                inputs.Add(MouseInput(0, 0, down, 0));
                inputs.Add(MouseInput(0, 0, up, 0));
            }
            SendInputs(inputs.ToArray());
            Log("点击 (" + x + ", " + y + ") " + button + (dbl ? " ×2" : ""));
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            Log("点击失败：" + ex.Message);
            return "{\"ok\":false,\"error\":\"点击失败：" + JsonEscape(ex.Message) + "\"}";
        }
    }

    /**
     * type {text}：逐字符 Unicode 注入（KEYEVENTF_UNICODE），中文/引号/换行都能原样送。
     * 落在当前焦点窗口——调用方要先点中目标输入框。控制字符（\n / \t）多数应用不认，
     * 回车与 Tab 用 key 命令。
     */
    private static string ExecuteType(string raw)
    {
        string text = ExtractJsonString(raw, "text");
        if (text == null)
            return "{\"ok\":false,\"error\":\"type 需要 text 字段（字符串）\"}";

        if (ExtractBool(raw, "dryRun"))
            return "{\"ok\":true,\"dryRun\":true,\"text\":" + JsonQuote(text) + ",\"length\":" + text.Length + "}";

        try
        {
            int at = 0;
            while (at < text.Length)
            {
                int chunk = Math.Min(TYPE_CHUNK_CHARS, text.Length - at);
                INPUT[] inputs = new INPUT[chunk * 2];
                for (int j = 0; j < chunk; j++)
                {
                    ushort scan = (ushort)text[at + j];
                    inputs[j * 2] = KeyInput(0, scan, KEYEVENTF_UNICODE);
                    inputs[j * 2 + 1] = KeyInput(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
                }
                SendInputs(inputs);
                at += chunk;
            }
            Log("已输入 " + text.Length + " 个字符");
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            Log("输入失败：" + ex.Message);
            return "{\"ok\":false,\"error\":\"输入失败：" + JsonEscape(ex.Message) + "\"}";
        }
    }

    /**
     * key {key}：一个键或一组组合键（enter / tab / ctrl+a / alt+f4 / win+r …）。
     * 组合键 = 用 + 连起来，最后一段是主键、前面都是修饰键；先按修饰键、再主键、
     * 最后逆序松修饰键，整组一次性送出（不会被中间的其他输入插队）。
     * 键名→VK 的映射在 TryKeyVk；**认不出来就不送任何事件**（全有或全无，
     * 不能只按下一半修饰键把桌面卡在 Ctrl 按下的状态）。
     */
    private static string ExecuteKey(string raw)
    {
        string spec = ExtractString(raw, "key");
        if (spec == null || spec.Trim().Length == 0)
            return "{\"ok\":false,\"error\":\"key 需要 key 字段（如 enter / ctrl+a / alt+f4）\"}";

        List<ushort> vks = new List<ushort>();
        string[] parts = spec.Split('+');
        for (int i = 0; i < parts.Length; i++)
        {
            string name = parts[i].Trim();
            if (name.Length == 0) continue;
            ushort vk;
            if (!TryKeyVk(name, out vk))
                return "{\"ok\":false,\"error\":\"不认识的按键名：" + JsonEscape(name) + "\"}";
            vks.Add(vk);
        }
        if (vks.Count == 0)
            return "{\"ok\":false,\"error\":\"key 里没有可用的按键名\"}";

        if (ExtractBool(raw, "dryRun"))
        {
            StringBuilder list = new StringBuilder();
            for (int i = 0; i < vks.Count; i++)
            {
                if (i > 0) list.Append(",");
                list.Append(vks[i]);
            }
            return "{\"ok\":true,\"dryRun\":true,\"vks\":[" + list + "]}";
        }

        try
        {
            ushort main = vks[vks.Count - 1];
            List<INPUT> inputs = new List<INPUT>();
            for (int i = 0; i < vks.Count - 1; i++) inputs.Add(KeyInput(vks[i], 0, 0));
            inputs.Add(KeyInput(main, 0, 0));
            inputs.Add(KeyInput(main, 0, KEYEVENTF_KEYUP));
            for (int i = vks.Count - 2; i >= 0; i--) inputs.Add(KeyInput(vks[i], 0, KEYEVENTF_KEYUP));
            SendInputs(inputs.ToArray());
            Log("按键 " + spec);
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            Log("按键失败：" + ex.Message);
            return "{\"ok\":false,\"error\":\"按键失败：" + JsonEscape(ex.Message) + "\"}";
        }
    }

    /** scroll {x, y, deltaY}：先把指针移到 (x, y) 再滚轮——滚轮作用于指针下的窗口，
     * 不先移过去就是在滚另一个面板。deltaY 的单位是**滚轮格数**（正数向下），
     * 这里乘 WHEEL_DELTA 得到 Windows 的 wheel 数据（wheel 正数向上，所以取负）。*/
    private static string ExecuteScroll(string raw)
    {
        int x, y;
        string bad = ReadPoint(raw, "scroll", out x, out y);
        if (bad != null) return bad;

        string deltaRaw = ExtractNumber(raw, "deltaY");
        int deltaY;
        if (deltaRaw == null || !int.TryParse(deltaRaw, out deltaY))
            return "{\"ok\":false,\"error\":\"scroll 需要整数 deltaY（正数向下）\"}";
        if (deltaY == 0)
            return "{\"ok\":false,\"error\":\"deltaY 不能是 0\"}";

        if (ExtractBool(raw, "dryRun"))
            return "{\"ok\":true,\"dryRun\":true,\"x\":" + x + ",\"y\":" + y + ",\"deltaY\":" + deltaY + "}";

        try
        {
            int wheelData = -deltaY * WHEEL_DELTA;
            INPUT[] inputs = new INPUT[2];
            inputs[0] = MoveInput(x, y);
            inputs[1] = MouseInput(0, 0, MOUSEEVENTF_WHEEL, wheelData);
            SendInputs(inputs);
            Log("滚动 (" + x + ", " + y + ") deltaY=" + deltaY);
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            Log("滚动失败：" + ex.Message);
            return "{\"ok\":false,\"error\":\"滚动失败：" + JsonEscape(ex.Message) + "\"}";
        }
    }

    // ---- 输入注入的小工具 ----

    /** 读整数 x / y（click 与 scroll 共用）；缺字段或不是整数回人话错误，否则 null */
    private static string ReadPoint(string raw, string command, out int x, out int y)
    {
        string xRaw = ExtractNumber(raw, "x");
        string yRaw = ExtractNumber(raw, "y");
        x = 0;
        y = 0;
        if (xRaw == null || yRaw == null || !int.TryParse(xRaw, out x) || !int.TryParse(yRaw, out y))
            return "{\"ok\":false,\"error\":\"" + command + " 需要整数 x 与 y（沙箱物理像素）\"}";
        return null;
    }

    /** 绝对坐标事件：按主屏归一化到 0..65535（SendInput 的约定） */
    private static INPUT MoveInput(int x, int y)
    {
        int screenW = GetSystemMetrics(SM_CXSCREEN);
        int screenH = GetSystemMetrics(SM_CYSCREEN);
        int nx = (int)Math.Round((double)x * 65535 / Math.Max(1, screenW - 1));
        int ny = (int)Math.Round((double)y * 65535 / Math.Max(1, screenH - 1));
        return MouseInput(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0);
    }

    private static INPUT MouseInput(int dx, int dy, uint flags, int mouseData)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = unchecked((uint)mouseData);
        input.u.mi.dwFlags = flags;
        return input;
    }

    private static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        return input;
    }

    /**
     * 送一批事件；没全送到就是失败（注入被拦 / 桌面不在交互态），不吞成成功。
     * 错误码要翻成人话：2026-10-14 真机在垂死 / 未就绪的沙箱里拿到「只送达 0/4（错误码 5）」，
     * 模型只能看见一个裸数字，白试了两轮——错误码 5 = 系统拒绝注入，含义是会话没就绪或已失效，
     * 正确动作是先截图确认状态，不是反复重试。
     */
    private static void SendInputs(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)inputs.Length)
            throw new InvalidOperationException("SendInput 只送达 " + sent + "/" + inputs.Length
                + " 个事件（" + DescribeSendInputError((int)Marshal.GetLastWin32Error()) + "）");
    }

    /** SendInput 失败的错误码 → 一句人话（模型看得到的就是它，别让它对着裸数字试） */
    private static string DescribeSendInputError(int code)
    {
        if (code == 5)
            return "错误码 5 = 拒绝访问：系统拒绝了这次注入——沙箱会话可能还没就绪或已经失效，"
                + "先截图确认沙箱状态，再决定重试还是重启沙箱";
        return "错误码 " + code;
    }

    private static bool TryButtonFlags(string button, out uint down, out uint up)
    {
        down = 0;
        up = 0;
        string b = button.ToLowerInvariant();
        if (b == "left") { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; return true; }
        if (b == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; return true; }
        if (b == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; return true; }
        return false;
    }

    /**
     * 键名 → 虚拟键码（VK）。大小写不敏感，同一个键的常见别名都认
     * （enter / return、escape / esc、pageup / pgup、win / meta / super / cmd …）。
     * 名字里带 f + 数字的一律当功能键（f1..f24）。
     */
    private static bool TryKeyVk(string name, out ushort vk)
    {
        vk = 0;
        string n = name.ToLowerInvariant();
        if (n.Length == 1)
        {
            char c = n[0];
            if (c >= 'a' && c <= 'z') { vk = (ushort)(0x41 + (c - 'a')); return true; }
            if (c >= '0' && c <= '9') { vk = (ushort)(0x30 + (c - '0')); return true; }
        }
        if (n.Length >= 2 && n[0] == 'f')
        {
            int num;
            if (int.TryParse(n.Substring(1), out num) && num >= 1 && num <= 24)
            {
                vk = (ushort)(0x70 + num - 1);
                return true;
            }
        }
        if (n.Length >= 7 && n.Substring(0, 6) == "numpad")
        {
            int num;
            if (int.TryParse(n.Substring(6), out num) && num >= 0 && num <= 9)
            {
                vk = (ushort)(0x60 + num);
                return true;
            }
        }
        switch (n)
        {
            case "enter": case "return": vk = 0x0D; return true;
            case "tab": vk = 0x09; return true;
            case "escape": case "esc": vk = 0x1B; return true;
            case "space": case "spacebar": vk = 0x20; return true;
            case "backspace": case "back": vk = 0x08; return true;
            case "delete": case "del": vk = 0x2E; return true;
            case "insert": case "ins": vk = 0x2D; return true;
            case "home": vk = 0x24; return true;
            case "end": vk = 0x23; return true;
            case "pageup": case "pgup": vk = 0x21; return true;
            case "pagedown": case "pgdn": vk = 0x22; return true;
            case "up": case "arrowup": vk = 0x26; return true;
            case "down": case "arrowdown": vk = 0x28; return true;
            case "left": case "arrowleft": vk = 0x25; return true;
            case "right": case "arrowright": vk = 0x27; return true;
            case "ctrl": case "control": vk = 0x11; return true;
            case "alt": vk = 0x12; return true;
            case "shift": vk = 0x10; return true;
            case "win": case "windows": case "meta": case "super": case "cmd": vk = 0x5B; return true;
            case "capslock": vk = 0x14; return true;
            case "numlock": vk = 0x90; return true;
            case "scrolllock": vk = 0x91; return true;
            case "printscreen": case "prtsc": vk = 0x2C; return true;
            case "pause": vk = 0x13; return true;
            case "apps": case "menu": vk = 0x5D; return true;
            case "minus": case "hyphen": vk = 0xBD; return true;
            case "equal": case "equals": case "plus": vk = 0xBB; return true;
            case "comma": vk = 0xBC; return true;
            case "period": case "dot": vk = 0xBE; return true;
            case "slash": case "forwardslash": vk = 0xBF; return true;
            case "backslash": vk = 0xDC; return true;
            case "semicolon": vk = 0xBA; return true;
            case "quote": case "apostrophe": vk = 0xDE; return true;
            case "backtick": case "grave": vk = 0xC0; return true;
            case "bracketleft": case "leftbracket": vk = 0xDB; return true;
            case "bracketright": case "rightbracket": vk = 0xDD; return true;
            case "numadd": vk = 0x6B; return true;
            case "numsubtract": vk = 0x6D; return true;
            case "nummultiply": vk = 0x6A; return true;
            case "numdivide": vk = 0x6F; return true;
            case "numdecimal": vk = 0x6E; return true;
        }
        return false;
    }

    // ---- 极简 JSON 字段抽取（命令是宿主生成的扁平小对象，不值得引 JSON 库） ----
    //
    // 两个写法都要吃：CDP 的 WebSocket 回复是紧凑的（`"id":1`），而 Chromium 的
    // /json/* HTTP 端点是**冒号后有空格**的（`"Browser": "Edg/..."`）。
    // 2026-10-24 真机验收就栽在这上面：cdp-start 读 /json/version 的
    // webSocketDebuggerUrl 取到 null，报出来却是「端口可能被别的进程占了」。
    // 另外 CDP 回复里的 title / text / value 会带转义（\" \\ \n \uXXXX），
    // 旧的「找到下一个引号就切」会把 `他说"你好"` 切成 `他说` 后面全丢。

    private static bool IsJsonSpace(char c)
    {
        return c == ' ' || c == '\t' || c == '\r' || c == '\n';
    }

    /**
     * 找字段值在 json 里的起点（冒号 + 空白之后的那个字符）。找不到回 -1。
     *
     * 跳过**被转义的假字段名**：字符串值里的 `\"command\":\"x\"` 前面是反斜杠，
     * 那不是字段名。这条不判的话，一段恰好写了字段名的网页文本就能把取值器带偏。
     */
    private static int FieldValueStart(string json, string field)
    {
        if (json == null) return -1;
        string needle = "\"" + field + "\"";
        int at = json.IndexOf(needle, StringComparison.Ordinal);
        while (at >= 0)
        {
            bool escapedKey = at > 0 && json[at - 1] == '\\';
            int i = at + needle.Length;
            while (i < json.Length && IsJsonSpace(json[i])) i++;
            if (!escapedKey && i < json.Length && json[i] == ':')
            {
                i++;
                while (i < json.Length && IsJsonSpace(json[i])) i++;
                return i;
            }
            at = json.IndexOf(needle, at + needle.Length, StringComparison.Ordinal);
        }
        return -1;
    }

    /** 取字符串字段并解转义（ExtractString 与 ExtractJsonString 是同一件事，旧名字留给调用点） */
    internal static string ExtractString(string json, string field)
    {
        return ExtractJsonString(json, field);
    }

    /**
     * 取字符串字段**并解转义**：\" \\ \/ \b \f \n \r \t \uXXXX 全部还原。
     * 回 null = 没有这个字段 / 值不是字符串（null、数字、布尔）/ 字符串没收尾（半截请求）。
     */
    internal static string ExtractJsonString(string json, string field)
    {
        int start = FieldValueStart(json, field);
        if (start < 0 || start >= json.Length || json[start] != '"') return null;
        StringBuilder sb = new StringBuilder();
        int i = start + 1;
        while (i < json.Length)
        {
            char c = json[i];
            if (c == '"') return sb.ToString();
            if (c != '\\')
            {
                sb.Append(c);
                i++;
                continue;
            }
            i++;
            if (i >= json.Length) return null;
            char esc = json[i];
            if (esc == 'n') { sb.Append('\n'); i++; }
            else if (esc == 't') { sb.Append('\t'); i++; }
            else if (esc == 'r') { sb.Append('\r'); i++; }
            else if (esc == 'b') { sb.Append('\b'); i++; }
            else if (esc == 'f') { sb.Append('\f'); i++; }
            else if (esc == 'u')
            {
                if (i + 4 >= json.Length) return null;
                int code;
                if (!int.TryParse(json.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code))
                    return null;
                sb.Append((char)code);
                i += 5;
            }
            else { sb.Append(esc); i++; } // \"  \\  \/ 等
        }
        return null; // 半截字符串：不猜，交给调用方报「字段不全」
    }

    /**
     * 数字字段（整数或小数）。回 null = 没有这个字段 / 值不是数字（null、true、字符串）。
     * 跳过空白再读：`"port": 49720`（冒号后有空格）也要吃。
     */
    internal static string ExtractNumber(string json, string field)
    {
        int start = FieldValueStart(json, field);
        if (start < 0) return null;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-' || json[end] == '+'
            || json[end] == '.' || json[end] == 'e' || json[end] == 'E')) end++;
        if (end == start) return null;
        return json.Substring(start, end - start);
    }

    /**
     * 布尔字段：跳过空白后必须是字面量 true。`"dryRun": true` 与紧凑写法都吃；
     * false / 缺失 / 别的类型一律 false（调用方都是「缺省 false」的开关）。
     */
    internal static bool ExtractBool(string json, string field)
    {
        int start = FieldValueStart(json, field);
        if (start < 0 || start + 4 > json.Length) return false;
        return string.CompareOrdinal(json, start, "true", 0, 4) == 0;
    }


    // ---- JSON 取值器自测（测试专用入口：--selftest-json） --------------------------
    //
    // 为什么要有它：2026-10-24 真机验收的第一个 bug 就是取值器只认紧凑写法——
    // Chromium 的 /json/version 是 `"key": "value"`（冒号后有空格），于是
    // webSocketDebuggerUrl 取不到、cdp-start 报出一句完全指向别处的话。
    // 这类缺陷只能靠用例盯住：真机验收太贵，而解析器是纯函数，测它不需要沙箱、不碰桌面。
    //
    // 只在 flag 分支里跑，生产路径一行都不碰。

    private static int RunJsonSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // 真机 /json/version 的形状（spaced：冒号后带空格）
        string version = "{\"Browser\": \"Edg/154.0.4258.62\", \"Protocol-Version\": \"1.3\", "
            + "\"User-Agent\": \"Mozilla/5.0 (Windows NT 10.0) Edg/154.0.4258.62\", "
            + "\"webSocketDebuggerUrl\": \"ws://127.0.0.1:49720/devtools/browser/8f0c-4a1e\"}";
        CheckString(failures, ref cases, "spaced webSocketDebuggerUrl",
            "ws://127.0.0.1:49720/devtools/browser/8f0c-4a1e", ExtractString(version, "webSocketDebuggerUrl"));
        CheckString(failures, ref cases, "spaced Browser", "Edg/154.0.4258.62", ExtractString(version, "Browser"));
        CheckString(failures, ref cases, "spaced User-Agent（中间有括号与斜杠）", "Mozilla/5.0 (Windows NT 10.0) Edg/154.0.4258.62",
            ExtractString(version, "User-Agent"));

        // 桥自己的请求（紧凑）
        CheckString(failures, ref cases, "compact command", "ping", ExtractString("{\"seq\":1,\"command\":\"ping\"}", "command"));
        CheckString(failures, ref cases, "换行/制表符在冒号后", "x", ExtractString("{\"a\":\n\t \"x\"}", "a"));
        CheckString(failures, ref cases, "键两侧有空格", "v", ExtractString("{ \"a\" : \"v\" }", "a"));

        // 转义：这是 cdp-observe / cdp-extract 的正文会不会缺尾巴的那条
        CheckString(failures, ref cases, "转义引号", "他说\"你好\"", ExtractString("{\"text\":\"他说\\\"你好\\\"\"}", "text"));
        CheckString(failures, ref cases, "转义反斜杠", "C:\\orbita-out\\upload\\a.pdf",
            ExtractString("{\"path\":\"C:\\\\orbita-out\\\\upload\\\\a.pdf\"}", "path"));
        CheckString(failures, ref cases, "控制字符转义", "a\nb\tc\r\bd\fe",
            ExtractString("{\"text\":\"a\\nb\\tc\\r\\bd\\fe\"}", "text"));
        CheckString(failures, ref cases, "\\uXXXX 转义", "你好", ExtractString("{\"text\":\"\\u4F60\\u597D\"}", "text"));
        CheckString(failures, ref cases, "\\/ 转义", "a/b", ExtractString("{\"text\":\"a\\/b\"}", "text"));

        // 边界
        CheckString(failures, ref cases, "空字符串", "", ExtractString("{\"a\":\"\"}", "a"));
        CheckString(failures, ref cases, "缺失字段", null, ExtractString("{\"a\":\"b\"}", "nope"));
        CheckString(failures, ref cases, "半截字符串", null, ExtractString("{\"a\":\"half", "a"));
        CheckString(failures, ref cases, "值是 null", null, ExtractString("{\"url\":null,\"a\":\"b\"}", "url"));
        CheckString(failures, ref cases, "值里的假字段名不被当字段名", "ping",
            ExtractString("{\"text\":\"say \\\"command\\\":\\\"x\\\"\",\"command\":\"ping\"}", "command"));

        // 数字：maxWidth / port / index 都走它
        CheckNumber(failures, ref cases, "紧凑数字", "1", ExtractNumber("{\"id\":1}", "id"));
        CheckNumber(failures, ref cases, "带空格数字", "49720", ExtractNumber("{\"port\": 49720}", "port"));
        CheckNumber(failures, ref cases, "负数", "-3", ExtractNumber("{\"deltaY\": -3}", "deltaY"));
        CheckNumber(failures, ref cases, "缺失数字", null, ExtractNumber("{\"a\":\"b\"}", "nope"));
        CheckNumber(failures, ref cases, "非数字值", null, ExtractNumber("{\"v\":true}", "v"));

        // 布尔：submit / clear / dryRun 都走它
        CheckBool(failures, ref cases, "紧凑 true", true, ExtractBool("{\"dryRun\":true}", "dryRun"));
        CheckBool(failures, ref cases, "带空格 true", true, ExtractBool("{\"dryRun\": true}", "dryRun"));
        CheckBool(failures, ref cases, "false", false, ExtractBool("{\"submit\": false}", "submit"));
        CheckBool(failures, ref cases, "缺失布尔", false, ExtractBool("{\"a\":\"b\"}", "nope"));
        CheckBool(failures, ref cases, "字符串里的 true 不算", false, ExtractBool("{\"text\":\"dryRun: true\"}", "dryRun"));

        Console.WriteLine(BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    // ---- launch 路径闸门自测（--selftest-launch）--------------------------------
    //
    // launch 的这条闸门是「桥能 Process.Start 任意 exe」的唯一边界，而它恰好是纯函数——
    // 在宿主上就能测，不必起沙箱、也不必真启动一份打包版（那在宿主上是红线）。

    private static int RunLaunchSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        string ok = "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\orbita.exe";
        CheckReject(failures, ref cases, "映射目录里的 exe 放行", null, GuestPathRejection(ok));
        CheckReject(failures, ref cases, "大小写不敏感", null,
            GuestPathRejection("c:\\users\\wdagutilityaccount\\desktop\\orbita-app\\orbita.EXE"));
        CheckReject(failures, ref cases, "桌面根下的深层路径放行", null,
            GuestPathRejection("C:\\Users\\WDAGUtilityAccount\\Desktop\\a\\b\\c\\x.exe"));
        CheckReject(failures, ref cases, "桌面外的系统目录拒绝", "拒绝",
            GuestPathRejection("C:\\Windows\\System32\\cmd.exe"));
        CheckReject(failures, ref cases, ".. 穿越回桌面之外拒绝", "拒绝",
            GuestPathRejection("C:\\Users\\WDAGUtilityAccount\\Desktop\\..\\..\\Windows\\System32\\cmd.exe"));
        CheckReject(failures, ref cases, "桌面根本身（\"Desktop\" 前缀但不是子路径）拒绝", "拒绝",
            GuestPathRejection("C:\\Users\\WDAGUtilityAccount\\DesktopX\\a.exe"));
        CheckReject(failures, ref cases, "非 .exe 拒绝", "拒绝",
            GuestPathRejection("C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\resources\\app.asar"));
        CheckReject(failures, ref cases, "相对路径拒绝", "拒绝", GuestPathRejection("orbita-app\\orbita.exe"));

        Console.WriteLine(BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    // ---- 会话 id 安全化自测（--selftest-session）----------------------------------
    //
    // 会话 id 会被拼成 `C:\orbita-browser\sessions\<键>`——它是**外部输入**（宿主给的 session
    // 字段），而 profile 目录里全是可执行配置。带 `..` 或 `\` 的 id 就能把目录指到 guest 的
    // 任意位置。这一关是纯函数，在宿主上就能测，不必起沙箱、更不必起 Edge。
    //
    // 充分一条：实例上限的文案（模型只有这句话能照着做）。它跟宿主的
    // computerUseBrowserErrors.tooMany 同义，两边都在模型看得见的路径上。

    private static int RunSessionSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        CheckString(failures, ref cases, "缺省（null）回落 default", "default", CdpSessions.SafeSessionId(null));
        CheckString(failures, ref cases, "空串回落 default", "default", CdpSessions.SafeSessionId(""));
        CheckString(failures, ref cases, "会话 UUID 原样保留", "5408f95e-cc30-4689-a8bb-3abfdc4ff044",
            CdpSessions.SafeSessionId("5408f95e-cc30-4689-a8bb-3abfdc4ff044"));
        CheckString(failures, ref cases, "下划线 / 减号 / 大小写都是合法字符", "A-b_1", CdpSessions.SafeSessionId("A-b_1"));
        CheckString(failures, ref cases, "空格换下划线", "a_b", CdpSessions.SafeSessionId("a b"));
        CheckString(failures, ref cases, "路径分隔符与 .. 全部换掉", "______x", CdpSessions.SafeSessionId("..\\..\\x"));
        CheckString(failures, ref cases, "正斜杠也换掉", "a_b", CdpSessions.SafeSessionId("a/b"));
        CheckString(failures, ref cases, "中文（多字节）换下划线", "__", CdpSessions.SafeSessionId("中文"));
        CheckString(failures, ref cases, "冒号（盘符）换掉", "C__x", CdpSessions.SafeSessionId("C:\\x"));
        CheckString(failures, ref cases, "超长截到 48 字符", new string('a', 48), CdpSessions.SafeSessionId(new string('a', 60)));
        CheckString(failures, ref cases, "全非法字符不回 default（不能和默认会话撞）", "___", CdpSessions.SafeSessionId("///"));
        CheckString(failures, ref cases, "首尾空格也不放过", "_x_", CdpSessions.SafeSessionId(" x "));

        string tooMany = CdpSessions.TooManyMessage();
        CheckTrue(failures, ref cases, "上限文案点明 4 个", tooMany.IndexOf("最多 4 个", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "上限文案给出下一步（cdp-stop）", tooMany.IndexOf("cdp-stop", StringComparison.Ordinal) >= 0);

        Console.WriteLine(BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    // ---- 浏览器错误页判定的自测（--selftest-cdp）----------------------------------
    //
    // 2026-10-25 真机：沙箱离线时每条 sandbox_navigate 都回 ok:true + 「可能还在渲染」，
    // 而正文是「你似乎未连接到 Internet」。对模型是假成功——它会接着去 operate 一个错误页，
    // 而且每次白等满 20 秒。错误页的判定与原因码都是纯函数，在宿主上就能测；
    // 真机才能验的部分（导航真落在 chrome-error:// 上）交给验收。

    private static int RunCdpSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // 真机回执里的最终 URL（Edge 154）
        CheckTrue(failures, ref cases, "chrome-error://chromewebdata/ 命中",
            CdpSession.IsNavErrorPage("chrome-error://chromewebdata/", null));
        CheckTrue(failures, ref cases, "新标签时的 chrome-error:// 也命中",
            CdpSession.IsNavErrorPage("chrome-error://", ""));
        CheckTrue(failures, ref cases, "大小写 / 首尾空白不影响",
            CdpSession.IsNavErrorPage("  CHROME-ERROR://chromewebdata/\r\n", null));
        CheckTrue(failures, ref cases, "正常页面不命中（URL）",
            !CdpSession.IsNavErrorPage("https://example.com/", null));
        CheckTrue(failures, ref cases, "正常页面不命中（正文里只有普通 error 字样）",
            !CdpSession.IsNavErrorPage("https://example.com/", "Server error: try again later (500)"));
        CheckTrue(failures, ref cases, "about:blank / data: / file: 不命中",
            !CdpSession.IsNavErrorPage("about:blank", "")
            && !CdpSession.IsNavErrorPage("data:text/html,<h1>hi</h1>", "hi")
            && !CdpSession.IsNavErrorPage("file:///C:/orbita-out/upload/a.html", "hello"));

        // 正文里的原因码（离线错误页的正文形状，三站点实测）
        string offline = "你似乎未连接到 Internet\r\n\r\nERR_INTERNET_DISCONNECTED\r\n\r\n请检查你的网络连接";
        CheckTrue(failures, ref cases, "正文里的 ERR_ 命中", CdpSession.IsNavErrorPage(null, offline));
        CheckString(failures, ref cases, "抓到 ERR_INTERNET_DISCONNECTED", "ERR_INTERNET_DISCONNECTED",
            CdpSession.NavErrorCode(offline));
        CheckString(failures, ref cases, "net::ERR_NAME_NOT_RESOLVED 只献出码", "ERR_NAME_NOT_RESOLVED",
            CdpSession.NavErrorCode("net::ERR_NAME_NOT_RESOLVED"));
        CheckString(failures, ref cases, "正文里有多个码时取第一个", "ERR_HTTP_RESPONSE_CODE_FAILURE",
            CdpSession.NavErrorCode("ERR_HTTP_RESPONSE_CODE_FAILURE\nERR_SSL_VERSION_OR_CIPHER_MISMATCH"));
        CheckString(failures, ref cases, "大写字母开头的 ERR_ 不是码（NETERR_FOO）", null,
            CdpSession.NavErrorCode("NETERR_FOO"));
        CheckString(failures, ref cases, "孤零零的 ERR_ 不是码", null, CdpSession.NavErrorCode("错误光 ERR_ 没有码"));
        CheckString(failures, ref cases, "没有原因码时回 null", null,
            CdpSession.NavErrorCode("你似乎未连接到 Internet"));
        CheckString(failures, ref cases, "null 正文不会崩", null, CdpSession.NavErrorCode(null));

        // 人话：带原因、带下一步、不带内部串
        string withCode = CdpSession.NavErrorMessage("ERR_INTERNET_DISCONNECTED");
        CheckTrue(failures, ref cases, "有码：报出原因", withCode.IndexOf("ERR_INTERNET_DISCONNECTED", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "有码：不是「没有拿到内容」",
            withCode.IndexOf("没有拿到内容", StringComparison.Ordinal) < 0);
        string noCode = CdpSession.NavErrorMessage(null);
        CheckTrue(failures, ref cases, "无码：说清没拿到内容", noCode.IndexOf("页面加载失败（没有拿到内容）", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "文案带下一步（换一个地址）",
            withCode.IndexOf("换一个", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "文案带降级工具（computer_screenshot / computer_click）",
            withCode.IndexOf("computer_screenshot", StringComparison.Ordinal) >= 0
            && withCode.IndexOf("computer_click", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "文案不把 chromewebdata 这种内部串甩给模型",
            withCode.IndexOf("chromewebdata", StringComparison.Ordinal) < 0
            && noCode.IndexOf("chromewebdata", StringComparison.Ordinal) < 0);

        // 连接超时也是同一句人话的前半句（不回「CDP 命令超时（Page.navigate，…）」）
        string timeoutText = CdpSession.NavErrorMessage("连接超时（20000ms 内没有回执）");
        CheckTrue(failures, ref cases, "超时：说成「页面没有加载：连接超时」",
            timeoutText.StartsWith("页面没有加载：连接超时", StringComparison.Ordinal));
        CheckTrue(failures, ref cases, "超时文案里没有 CDP 内部措辞",
            timeoutText.IndexOf("Page.navigate", StringComparison.Ordinal) < 0
            && timeoutText.IndexOf("CDP 命令超时", StringComparison.Ordinal) < 0);
        CheckTrue(failures, ref cases, "人话不会撑成一屏（< 400 字符）",
            withCode.Length < 400 && timeoutText.Length < 400);

        // 超时异常的识别（Nav 靠它把内部措辞换成上面那句人话）
        CheckTrue(failures, ref cases, "CDP 命令超时命中",
            CdpSession.IsCdpTimeoutMessage("CDP 命令超时（Page.navigate，20000ms 内没有回执）"));
        CheckTrue(failures, ref cases, "CDP 发送超时也命中", CdpSession.IsCdpTimeoutMessage("CDP 发送超时（Page.navigate）"));
        CheckTrue(failures, ref cases, "页面脚本报错不算超时",
            !CdpSession.IsCdpTimeoutMessage("页面里的脚本报错：Cannot read properties of null"));
        CheckTrue(failures, ref cases, "「Edge 没有在运行」不算超时",
            !CdpSession.IsCdpTimeoutMessage("沙箱里的 Edge 没有在运行（或已经退出）"));
        CheckTrue(failures, ref cases, "null 不算超时", !CdpSession.IsCdpTimeoutMessage(null));

        // 失效 session 的识别（真机 2026-10-25：上一条导航超时后，紧接着的下一条必撞它）
        string staleReply = "{\"id\":7,\"error\":{\"code\":-32001,\"message\":\"Session with given id not found.\"}}";
        CheckTrue(failures, ref cases, "Session with given id not found 命中", CdpSession.IsStaleSessionError(staleReply));
        CheckTrue(failures, ref cases, "No target with given id 命中",
            CdpSession.IsStaleSessionError("{\"error\":{\"message\":\"No target with given id found\"}}"));
        CheckTrue(failures, ref cases, "正常回执不算失效",
            !CdpSession.IsStaleSessionError("{\"id\":7,\"result\":{\"frameId\":\"A1\"}}"));
        CheckTrue(failures, ref cases, "navigation 失败的普通错误不算失效",
            !CdpSession.IsStaleSessionError("{\"error\":{\"message\":\"net::ERR_NAME_NOT_RESOLVED\"}}"));
        CheckTrue(failures, ref cases, "null 不算失效", !CdpSession.IsStaleSessionError(null));

        // 错误文案里的 URL 截断（data: URL 真机把一句错误撑成一屏）
        string longData = "data:text/html;charset=utf-8;base64," + new string('A', 500);
        string shorted = CdpSession.ShortUrl(longData, 80);
        CheckTrue(failures, ref cases, "长 URL 截到 80 + …", shorted.Length == 81 && shorted.EndsWith("…", StringComparison.Ordinal));
        CheckString(failures, ref cases, "短 URL 原样保留", "https://example.com/", CdpSession.ShortUrl("https://example.com/", 80));
        CheckString(failures, ref cases, "刚好 80 不截", new string('a', 80), CdpSession.ShortUrl(new string('a', 80), 80));
        CheckString(failures, ref cases, "null URL 回空串", "", CdpSession.ShortUrl(null, 80));

        // 取正文的脚本不能退化成只读 body.innerText：真机就是这样漏掉 ERR_NAME_NOT_RESOLVED 的
        string dumpJs = CdpSession.ErrorPageDumpScriptForTest;
        CheckTrue(failures, ref cases, "取正文覆盖 body.innerText / textContent", 
            dumpJs.IndexOf("innerText", StringComparison.Ordinal) >= 0
            && dumpJs.IndexOf("textContent", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "取正文覆盖 #main-message / shadow root / outerHTML",
            dumpJs.IndexOf("main-message", StringComparison.Ordinal) >= 0
            && dumpJs.IndexOf("shadowRoot", StringComparison.Ordinal) >= 0
            && dumpJs.IndexOf("outerHTML", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "每路来源都记了字符数（日志要靠它区分「空」与「没码」）",
            dumpJs.IndexOf("s.length", StringComparison.Ordinal) >= 0);

        // 原因码的第二张牌：Page.navigate 的 errorText（真机错误页 DOM 取不到任何文本时靠它）
        CheckString(failures, ref cases, "正文空时用 Page.navigate 的 errorText", "ERR_NAME_NOT_RESOLVED",
            CdpSession.NavErrorReason("", "net::ERR_NAME_NOT_RESOLVED"));
        CheckString(failures, ref cases, "正文里的码优先（比 errorText 更具体）", "ERR_HTTP_RESPONSE_CODE_FAILURE",
            CdpSession.NavErrorReason("ERR_HTTP_RESPONSE_CODE_FAILURE", "net::ERR_FAILED"));
        CheckString(failures, ref cases, "两张牌都没有时回 null", null,
            CdpSession.NavErrorReason("[body.innerText=0]", null));
        CheckString(failures, ref cases, "errorText 是空串时不编造码", null, CdpSession.NavErrorReason("", ""));

        // ── 连接层自愈：挑 target 的规则（2026-10-25 真机三次故障形态的根因之一）──────────
        // `'Page.navigate' wasn't found` = 会话被挂到了没有 Page 域的 target 上；
        // 而挂回一个卡死的标签页，会把 Page.enable 拖到 8s 超时（下一条命令又白失败一次）。
        List<TargetInfo> pages = new List<TargetInfo>();
        pages.Add(MakeTarget("A", "page", "https://example.com/"));
        pages.Add(MakeTarget("B", "page", "https://other.example/"));
        CheckString(failures, ref cases, "挑 target：已知 target 还是 page 就回它（不换模型的标签页）", "B",
            CdpSession.ChooseTargetId(pages, "B", ""));
        CheckString(failures, ref cases, "挑 target：已知 target 不在了，取第一个 page", "A",
            CdpSession.ChooseTargetId(pages, "GONE", ""));
        CheckString(failures, ref cases, "挑 target：已知 target 可疑就跳过它", "A",
            CdpSession.ChooseTargetId(pages, "B", "B"));
        CheckString(failures, ref cases, "挑 target：没有已知 target 时取第一个", "A",
            CdpSession.ChooseTargetId(pages, "", ""));
        CheckString(failures, ref cases, "挑 target：已知 target 可疑时改用另一个", "B",
            CdpSession.ChooseTargetId(pages, "A", "A"));
        List<TargetInfo> allSuspect = new List<TargetInfo>();
        allSuspect.Add(MakeTarget("A", "page", "https://example.com/"));
        CheckString(failures, ref cases, "挑 target：全部可疑时回 null（调用方去新建标签页）", null,
            CdpSession.ChooseTargetId(allSuspect, "A", "A"));

        List<TargetInfo> mixed = new List<TargetInfo>();
        mixed.Add(MakeTarget("SW", "service_worker", "https://example.com/sw.js"));
        mixed.Add(MakeTarget("TAB", "tab", "https://example.com/"));
        mixed.Add(MakeTarget("ERR", "page", "chrome-error://chromewebdata/"));
        mixed.Add(MakeTarget("P", "page", "https://example.com/"));
        CheckString(failures, ref cases, "挑 target：非 page target 一律不挑（'Page.navigate' wasn't found 的来源）", "P",
            CdpSession.ChooseTargetId(mixed, "", ""));
        CheckString(failures, ref cases, "挑 target：已知 target 是错误页也不挑（第二轮真机：错误页上继续没意义）", "P",
            CdpSession.ChooseTargetId(mixed, "ERR", ""));
        CheckString(failures, ref cases, "挑 target：刚超时的 target 即使还是已知 target 也剔掉（坏连两条的根因）", "B",
            CdpSession.ChooseTargetId(pages, "A", "A"));
        CheckString(failures, ref cases, "挑 target：已知 target 不可用时，错误页不当备选", "P",
            CdpSession.ChooseTargetId(mixed, "GONE", ""));
        List<TargetInfo> onlyError = new List<TargetInfo>();
        onlyError.Add(MakeTarget("ERR", "page", "chrome-error://chromewebdata/"));
        CheckString(failures, ref cases, "挑 target：只有错误页时回 null", null,
            CdpSession.ChooseTargetId(onlyError, "", ""));
        CheckString(failures, ref cases, "挑 target：一个 target 都没有时回 null", null,
            CdpSession.ChooseTargetId(new List<TargetInfo>(), "", ""));
        CheckTrue(failures, ref cases, "错误页地址：chrome-error 命中",
            CdpSession.IsBrowserErrorPageUrl("chrome-error://chromewebdata/"));
        CheckTrue(failures, ref cases, "错误页地址：大小写不敏感",
            CdpSession.IsBrowserErrorPageUrl("  CHROME-ERROR://chromewebdata/"));
        CheckTrue(failures, ref cases, "错误页地址：edge-error 也算",
            CdpSession.IsBrowserErrorPageUrl("edge-error://chromewebdata/"));
        CheckTrue(failures, ref cases, "错误页地址：普通页面不算",
            !CdpSession.IsBrowserErrorPageUrl("https://example.com/")
            && !CdpSession.IsBrowserErrorPageUrl("about:blank")
            && !CdpSession.IsBrowserErrorPageUrl(null));

        // ── 连接层自愈：哪些失败可以重发（安全边界比「重试三次」重要得多）──────────────
        string methodNotFound = "{\"id\":9,\"error\":{\"code\":-32601,\"message\":\"'Page.navigate' wasn't found\"}}";
        CheckTrue(failures, ref cases, "可重发：'Page.navigate' wasn't found（会话挂错了 target）",
            CdpSession.IsRetryableChannelReply(methodNotFound));
        CheckTrue(failures, ref cases, "可重发：Runtime.evaluate 的 wasn't found 也一样（没执行过）",
            CdpSession.IsRetryableChannelReply("{\"error\":{\"message\":\"'Runtime.evaluate' wasn't found\"}}"));
        CheckTrue(failures, ref cases, "可重发：Session not found",
            CdpSession.IsRetryableChannelReply(staleReply));
        CheckTrue(failures, ref cases, "可重发：Target closed",
            CdpSession.IsRetryableChannelReply("{\"error\":{\"message\":\"Target closed.\"}}"));
        CheckTrue(failures, ref cases, "可重发：Not attached to an active page",
            CdpSession.IsRetryableChannelReply("{\"error\":{\"message\":\"Not attached to an active page\"}}"));
        CheckTrue(failures, ref cases, "不重发：真实导航结果 net::ERR_NAME_NOT_RESOLVED",
            !CdpSession.IsRetryableChannelReply("{\"error\":{\"code\":-32000,\"message\":\"net::ERR_NAME_NOT_RESOLVED\"}}"));
        CheckTrue(failures, ref cases, "不重发：真实导航结果 net::ERR_FAILED",
            !CdpSession.IsRetryableChannelReply("{\"error\":{\"message\":\"net::ERR_FAILED\"}}"));
        CheckTrue(failures, ref cases, "不重发：Invalid URL（真的没打开这一页）",
            !CdpSession.IsRetryableChannelReply("{\"error\":{\"message\":\"Cannot navigate to invalid URL\"}}"));
        CheckTrue(failures, ref cases, "不重发：正常回执",
            !CdpSession.IsRetryableChannelReply("{\"id\":7,\"result\":{\"frameId\":\"A1\"}}"));
        CheckTrue(failures, ref cases, "不重发：null 回执", !CdpSession.IsRetryableChannelReply(null));

        CheckTrue(failures, ref cases, "连接层异常：CDP 命令超时",
            CdpSession.IsChannelFailure("CDP 命令超时（Page.enable，8000ms 内没有回执）"));
        CheckTrue(failures, ref cases, "连接层异常：CDP 发送失败",
            CdpSession.IsChannelFailure("CDP 发送失败（Page.navigate）：底层连接已关闭"));
        CheckTrue(failures, ref cases, "连接层异常：CDP 连接已断开",
            CdpSession.IsChannelFailure("CDP 连接已断开"));
        CheckTrue(failures, ref cases, "非连接层：调试端口连不上（OpenSocket 自己已重试 8s）",
            !CdpSession.IsChannelFailure("沙箱里的 Edge 调试端口 49719 连不上（Unable to connect to the remote server）"));
        CheckTrue(failures, ref cases, "非连接层：Edge 没有在运行（那是宿主的缓存自愈信号）",
            !CdpSession.IsChannelFailure("沙箱里的 Edge 没有在运行（或已经退出）"));
        CheckTrue(failures, ref cases, "非连接层：页面脚本报错",
            !CdpSession.IsChannelFailure("页面里的脚本报错：Cannot read properties of null"));
        CheckTrue(failures, ref cases, "非连接层：null", !CdpSession.IsChannelFailure(null));

        CheckTrue(failures, ref cases, "可重发方法：Page.enable", CdpSession.IsRetryableMethod("Page.enable"));
        CheckTrue(failures, ref cases, "不重发：Page.navigate（导航超时 = 判死重启，不是重发）",
            !CdpSession.IsRetryableMethod("Page.navigate"));
        CheckTrue(failures, ref cases, "可重发方法：Target.attachToTarget", CdpSession.IsRetryableMethod("Target.attachToTarget"));
        CheckTrue(failures, ref cases, "不可重发：Input.insertText（会打两遍）",
            !CdpSession.IsRetryableMethod("Input.insertText"));
        CheckTrue(failures, ref cases, "不可重发：Input.dispatchMouseEvent（会点两下）",
            !CdpSession.IsRetryableMethod("Input.dispatchMouseEvent"));
        CheckTrue(failures, ref cases, "不可重发：Runtime.evaluate（脚本可能有副作用）",
            !CdpSession.IsRetryableMethod("Runtime.evaluate"));
        CheckTrue(failures, ref cases, "不可重发：DOM.setFileInputFiles",
            !CdpSession.IsRetryableMethod("DOM.setFileInputFiles"));
        CheckTrue(failures, ref cases, "不可重发：null", !CdpSession.IsRetryableMethod(null));

        CheckTrue(failures, ref cases, "结构性错误：wasn't found",
            CdpSession.IsStructuralChannelError("'Page.navigate' wasn't found"));
        CheckTrue(failures, ref cases, "结构性错误：Session not found",
            CdpSession.IsStructuralChannelError("Session with given id not found."));
        CheckTrue(failures, ref cases, "不是结构性错误：普通超时",
            !CdpSession.IsStructuralChannelError("CDP 命令超时（Page.enable，8000ms 内没有回执）"));

        // 预算与 worker 的杀线：34s 预算 + 6s 收尾 < 40s 杀线（一个在 Cdp.cs，一个在 WorkerHost.cs）
        CheckTrue(failures, ref cases, "连接层预算 + 收尾余量不越过 worker 的 40s 杀线",
            CdpSession.ChannelBudgetMsForTest + 6000 <= 40000);
        // 导航超时那一轮的预算：12s（navigate 等回执）+ 18s（重启 + attach + 验过）< 40s
        CheckTrue(failures, ref cases, "导航超时 + 判死重启装得进 worker 的 40s 杀线",
            CdpSession.PageNavigateTimeoutMsForTest + CdpSession.RestartRoomMsForTest <= 40000);

        // ── 导航分段计量（2026-10-25 真机：warm 导航总 2649ms，worker 回执自报 ms=343）────────
        // 分段日志的规矩：任一段 ≥ 200ms 或整条 ≥ 500ms 才打一行。快导航不能刷日志，
        // 慢导航必须把「哪一段慢」写进 worker.log——这几条钉的是阈值与文本。
        CdpSession.NavTiming fast = new CdpSession.NavTiming();
        fast.NavigateMs = 8;
        fast.ReadyMs = 110;
        fast.FirstSleepMs = 100;
        fast.RecordReadyRound(2, 4);
        fast.ReadySleepMs = 60;
        fast.ResultMs = 3;
        CheckTrue(failures, ref cases, "分段日志：快导航（每段 < 200ms、整条 < 500ms）一行都不打",
            !CdpSession.NavTraceNeeded(fast, 121));
        CdpSession.NavTiming slowReady = new CdpSession.NavTiming();
        slowReady.NavigateMs = 8;
        slowReady.ReadyMs = 2410;
        slowReady.FirstSleepMs = 300;
        slowReady.RecordReadyRound(5, 12);
        slowReady.ReadySleepMs = 1500;
        slowReady.ResultMs = 3;
        CheckTrue(failures, ref cases, "分段日志：某一段 ≥ 200ms 就打（等就绪 2410ms）",
            CdpSession.NavTraceNeeded(slowReady, 2445));
        CdpSession.NavTiming spread = new CdpSession.NavTiming();
        spread.NavigateMs = 150;
        spread.ReadyMs = 150;
        spread.ResultMs = 150;
        CheckTrue(failures, ref cases, "分段日志：每段都 < 200ms 但整条 ≥ 500ms 也打",
            CdpSession.NavTraceNeeded(spread, 600));
        CheckTrue(failures, ref cases, "分段日志：timing 为 null 时不打（不崩）",
            !CdpSession.NavTraceNeeded(null, 9999));
        string slowLine = CdpSession.FormatNavSegmentLine("cdp-nav", slowReady, 2445);
        CheckTrue(failures, ref cases, "分段日志：三个分段都写出来（navigate / 等就绪 / 取回执）",
            slowLine.StartsWith("cdp-nav 分段：", StringComparison.Ordinal)
            && slowLine.IndexOf("Page.navigate 回执 8ms", StringComparison.Ordinal) >= 0
            && slowLine.IndexOf("等就绪 2410ms", StringComparison.Ordinal) >= 0
            && slowLine.IndexOf("取 url/title 3ms", StringComparison.Ordinal) >= 0
            && slowLine.EndsWith("= 2445ms", StringComparison.Ordinal));
        CheckTrue(failures, ref cases, "分段日志：等就绪带首睡 / 轮数 / eval / sleep（能分清是固定睡眠还是轮询）",
            slowLine.IndexOf("首睡 300ms", StringComparison.Ordinal) >= 0
            && slowLine.IndexOf("5 轮", StringComparison.Ordinal) >= 0
            && slowLine.IndexOf("eval 12ms", StringComparison.Ordinal) >= 0
            && slowLine.IndexOf("sleep 1500ms", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "分段日志：没走过的分段（错误页窗口）不写出来",
            slowLine.IndexOf("错误页正文窗口", StringComparison.Ordinal) < 0);
        CdpSession.NavTiming failedNav = new CdpSession.NavTiming();
        failedNav.NavigateMs = 10;
        failedNav.ReadyMs = 320;
        failedNav.RecordErrorDump(7, 2010);
        failedNav.ResultMs = 4;
        string failedLine = CdpSession.FormatNavSegmentLine("cdp-nav", failedNav, 2350);
        CheckTrue(failures, ref cases, "分段日志：错误页那段单独出来（2s 正文窗口是排查重点）",
            failedLine.IndexOf("错误页正文窗口 2010ms（7 轮）", StringComparison.Ordinal) >= 0);

        Console.WriteLine(BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    /** --align-every 的值：整数且 ≥ 1。生产 .wsb 不带它，默认仍是 AlignEveryPollsDefault */
    internal static bool TryParseAlignEvery(string raw, out int every)
    {
        every = 0;
        if (raw == null || !int.TryParse(raw, out every)) return false;
        if (every < 1)
        {
            every = 0;
            return false;
        }
        return true;
    }

    // ---- 耗时计量的自测（--selftest-metrics）-----------------------------------------
    //
    // 计量这一刀的产出就是「能读的数字」，所以它自己的口径必须先被钉住：阈值判断、传播的
    // 可信性判定（mtime 缺失 / 时基差 / 超窗口）、一行日志的算术，以及最要紧的一条——
    // PollOnce 真跑一次时那行日志真的落出来、传播真的按 mtime 算。前几条是纯函数；最后一条在
    // 临时目录里跑真实链路（一条 ping：不碰桌面、不起 Edge、不起子进程）。
    // 可信度只在宿主文件系统上验过（NTFS 临时目录）；映射目录的时间戳行为只能真机看日志——
    // 所以「传播未知：…」也是一条合法输出，而不是失败。

    private static int RunMetricsSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // 阈值：500ms 就是打印线
        CheckBool(failures, ref cases, "499ms 不打", false, HopNeedsLog(500, new long[] { 499 }));
        CheckBool(failures, ref cases, "到线 500ms 就打", true, HopNeedsLog(500, new long[] { 500 }));
        CheckBool(failures, ref cases, "任一段到线就打", true, HopNeedsLog(500, new long[] { 0, 0, 501, 0 }));
        CheckBool(failures, ref cases, "全段都小就不打", false, HopNeedsLog(500, new long[] { 0, 499, 12, 3 }));
        CheckBool(failures, ref cases, "未知段（-1）不算超阈值", false, HopNeedsLog(500, new long[] { -1, 0 }));

        // 传播（mtime 法）的四种可信性
        DateTime now = new DateTime(2026, 10, 25, 5, 0, 0, DateTimeKind.Utc);
        string note;
        CheckNumber(failures, ref cases, "mtime 落后 2500ms → 传播 2500ms", "2500",
            PropagateFromMtime(now.AddMilliseconds(-2500), now, out note).ToString());
        CheckString(failures, ref cases, "可信时注明用的是 mtime 法", "mtime 法", note);
        CheckNumber(failures, ref cases, "mtime 缺失（1601）→ 未知", "-1",
            PropagateFromMtime(new DateTime(1601, 1, 1, 0, 0, 0, DateTimeKind.Utc), now, out note).ToString());
        CheckTrue(failures, ref cases, "mtime 缺失的 note 说清是 mtime 缺失",
            note.IndexOf("mtime 缺失", StringComparison.Ordinal) >= 0);
        CheckNumber(failures, ref cases, "mtime 晚于本地时钟（时基不一致）→ 未知", "-1",
            PropagateFromMtime(now.AddMilliseconds(3000), now, out note).ToString());
        CheckTrue(failures, ref cases, "时基差的 note 点明时基差",
            note.IndexOf("时基差", StringComparison.Ordinal) >= 0);
        CheckNumber(failures, ref cases, "差 200s（超可信窗口）→ 未知", "-1",
            PropagateFromMtime(now.AddMilliseconds(-200000), now, out note).ToString());
        CheckTrue(failures, ref cases, "超窗口的 note 点明可信窗口",
            note.IndexOf("可信窗口", StringComparison.Ordinal) >= 0);
        CheckNumber(failures, ref cases, "差 119s（窗口内最大的可信值）→ 119000", "119000",
            PropagateFromMtime(now.AddMilliseconds(-119000), now, out note).ToString());

        // 一行日志的算术：传播可信时 总 = 传播 + 读 + 执行 + 落盘（轮询等待不在总和里）
        HopReport r = new HopReport();
        r.Command = "cmd-000007";
        r.PropagateMs = 8100;
        r.PropagateNote = "mtime 法";
        r.PollWaitMs = 6400;
        r.ProbeMs = 310;
        r.MtimeQueryMs = 12;
        r.ReadMs = 12;
        r.ExecuteMs = 120;
        r.PersistMs = 700;
        string line = FormatHopLine(r);
        CheckTrue(failures, ref cases, "可信传播：总 = 传播 + 读 + 执行 + 落盘（8100+12+120+700 = 8932）",
            line.IndexOf("总 8932ms", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "可信传播：四段都在同一行里",
            line.IndexOf("传播 8100ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("读请求 12ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("执行 120ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("回执落盘 700ms", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "轮询等待作为细分出现，并注明已含在传播里",
            line.IndexOf("看见前等上一轮循环 6400ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("不计入总", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "直探 / mtime 查询 / 来源都带上（才分得清卡在哪一步）",
            line.IndexOf("File.Exists 310ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("mtime 查询 12ms", StringComparison.Ordinal) >= 0
            && line.IndexOf("来源 快路径", StringComparison.Ordinal) >= 0);

        // cdp-* 转给 worker 时，执行段不是浏览器真干活的时间，行里必须自己说
        r.Forwarded = true;
        CheckTrue(failures, ref cases, "转发 worker 时注明执行是转发耗时",
            FormatHopLine(r).IndexOf("转发 worker", StringComparison.Ordinal) >= 0);
        r.Forwarded = false;

        // 传播不可信：总 = 轮询等待 + 读 + 执行 + 落盘（6400+12+120+700 = 7232）
        r.PropagateMs = -1;
        r.PropagateNote = "时基差 +3000ms（mtime 晚于本地时钟）";
        string unknownLine = FormatHopLine(r);
        CheckTrue(failures, ref cases, "传播未知：明写原因，且总量按轮询等待起算",
            unknownLine.IndexOf("传播未知：时基差", StringComparison.Ordinal) >= 0
            && unknownLine.IndexOf("本进程内 7232ms", StringComparison.Ordinal) >= 0
            && unknownLine.IndexOf("轮询等待 6400ms", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "传播未知：不再出现「已含在传播里」的细分",
            unknownLine.IndexOf("看见前等上一轮循环", StringComparison.Ordinal) < 0);
        r.PollWaitMs = -1;
        CheckTrue(failures, ref cases, "第一轮没有上一轮就不列轮询等待",
            FormatHopLine(r).IndexOf("轮询等待", StringComparison.Ordinal) < 0);

        // 枚举那行的形状（猜测 1 的证据格式，钉死）
        CheckString(failures, ref cases, "枚举兜底那一行的形状",
            "对齐枚举耗时 18400ms（第 3 轮，_polls=48，目录可见 5 项；其中 Directory.GetFiles 18300ms）",
            FormatAlignLine(3, 48, 18400, 18300, 5));

        // --align-every：实验用，默认值不许被动
        int every;
        CheckTrue(failures, ref cases, "--align-every 16 可用", TryParseAlignEvery("16", out every) && every == 16);
        CheckTrue(failures, ref cases, "--align-every 160 可用", TryParseAlignEvery("160", out every) && every == 160);
        CheckTrue(failures, ref cases, "--align-every 0 拒", !TryParseAlignEvery("0", out every));
        CheckTrue(failures, ref cases, "--align-every -4 拒", !TryParseAlignEvery("-4", out every));
        CheckTrue(failures, ref cases, "--align-every abc 拒", !TryParseAlignEvery("abc", out every));
        CheckTrue(failures, ref cases, "--align-every 空串拒", !TryParseAlignEvery("", out every));
        CheckString(failures, ref cases, "默认枚举周期仍然是每 16 轮", "16",
            AlignEveryPolls.ToString() + (AlignEveryPolls == AlignEveryPollsDefault ? "" : "（已被覆盖）"));

        // ---- 真链路：临时目录里发一条 ping，确认那行日志真的落出来、传播真的按 mtime 算 ----
        string dir = Path.Combine(Path.GetTempPath(), "orbita-metrics-selftest-" + Guid.NewGuid().ToString("N"));
        TextWriter realOut = Console.Out;
        StringWriter captured = new StringWriter();
        try
        {
            Directory.CreateDirectory(dir);
            _outDir = dir;
            _cmdDir = dir;
            _nextSeq = 1;
            _polls = 0;
            _lastPollEndMs = -1;
            int savedThreshold = HopLogThresholdMs;
            HopLogThresholdMs = 0; // 只在自测里把打印线压到 0，保证一定有这一行
            string req1 = Path.Combine(dir, "cmd-000001" + ReqSuffix);
            File.WriteAllText(req1, "{\"command\":\"ping\"}", new UTF8Encoding(false));
            // 把 mtime 往回拨 2s：模拟「宿主 2 秒前写好、guest 现在才看见」
            File.SetLastWriteTimeUtc(req1, DateTime.UtcNow.AddMilliseconds(-2000));
            Console.SetOut(captured);
            PollOnce();
            Console.SetOut(realOut);
            CheckTrue(failures, ref cases, "真链路：回执落盘",
                File.Exists(Path.Combine(dir, "cmd-000001" + RespSuffix)));
            CheckTrue(failures, ref cases, "真链路：req 受理即删", !File.Exists(req1));
            // 第二条：mtime 在未来（时基不一致），必须报传播未知
            string req2 = Path.Combine(dir, "cmd-000002" + ReqSuffix);
            File.WriteAllText(req2, "{\"command\":\"ping\"}", new UTF8Encoding(false));
            File.SetLastWriteTimeUtc(req2, DateTime.UtcNow.AddMinutes(5));
            Console.SetOut(captured);
            PollOnce();
            Console.SetOut(realOut);
            HopLogThresholdMs = savedThreshold;
        }
        catch (Exception ex)
        {
            failures.Add("真链路跑不起来：" + ex.Message);
        }
        finally
        {
            Console.SetOut(realOut);
            HopLogThresholdMs = 500;
            try { Directory.Delete(dir, true); } catch { }
        }
        string log = captured.ToString();
        CheckTrue(failures, ref cases, "真链路：ping 的命令行真的打出来了",
            log.IndexOf("命令 cmd-000001：", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "真链路：传播按 mtime 算（不是未知）",
            log.IndexOf("mtime 法", StringComparison.Ordinal) >= 0);
        // 拨回 2000ms：容 300ms 抖动，读不出来就是时基/时间戳这一环有问题
        long measured = -1;
        int at = log.IndexOf("传播 ", StringComparison.Ordinal);
        if (at >= 0)
        {
            int p = at + "传播 ".Length;
            int start = p;
            while (p < log.Length && log[p] >= '0' && log[p] <= '9') p++;
            long parsed;
            if (p > start && long.TryParse(log.Substring(start, p - start), out parsed)) measured = parsed;
        }
        CheckTrue(failures, ref cases, "真链路：传播量级对得上（拨回 2000ms，实测 " + measured + "ms）",
            measured >= 1900 && measured <= 2400);
        CheckTrue(failures, ref cases, "真链路：mtime 在未来时报传播未知（时基差）",
            log.IndexOf("传播未知：时基差", StringComparison.Ordinal) >= 0);

        Console.WriteLine(BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    /** 自测用的 target 构造器（TargetInfo 的字段是 public 的，但造四条写起来太啰嗦） */
    private static TargetInfo MakeTarget(string id, string type, string url)
    {
        TargetInfo info = new TargetInfo();
        info.Id = id;
        info.Type = type;
        info.Url = url;
        info.Title = "";
        return info;
    }

    /** 统一的自测回执照 JSON（五个 selftest 共用一份形状，跑测试的人不用记五种） */
    internal static string BuildSelfTestJson(List<string> failures, int cases)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":").Append(failures.Count == 0 ? "true" : "false").Append(",\"cases\":").Append(cases);
        if (failures.Count > 0)
        {
            json.Append(",\"failures\":[");
            for (int i = 0; i < failures.Count; i++)
            {
                if (i > 0) json.Append(",");
                json.Append(JsonQuote(failures[i]));
            }
            json.Append("]");
        }
        json.Append("}");
        return json.ToString();
    }

    internal static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
    {
        cases++;
        if (!condition) failures.Add(name + "：不成立");
    }

    /** expectKind：null = 应放行；"拒绝" = 应被拦（只断言倾向，不断言整句文案） */
    private static void CheckReject(List<string> failures, ref int cases, string name, string expectKind, string rejection)
    {
        cases++;
        bool allowed = rejection == null;
        bool expectedAllowed = expectKind == null;
        if (allowed != expectedAllowed)
            failures.Add(name + "：实际" + (allowed ? "放行" : "拦下（" + rejection + "）"));
    }

    internal static void CheckString(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        cases++;
        bool same = expected == null ? actual == null : string.Equals(expected, actual, StringComparison.Ordinal);
        if (!same) failures.Add(name + "：期待 " + ShowValue(expected) + "，实得 " + ShowValue(actual));
    }

    private static void CheckNumber(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        cases++;
        bool same = expected == null ? actual == null : string.Equals(expected, actual, StringComparison.Ordinal);
        if (!same) failures.Add(name + "：期待 " + ShowValue(expected) + "，实得 " + ShowValue(actual));
    }

    private static void CheckBool(List<string> failures, ref int cases, string name, bool expected, bool actual)
    {
        cases++;
        if (expected != actual) failures.Add(name + "：期待 " + (expected ? "true" : "false") + "，实得 " + (actual ? "true" : "false"));
    }

    private static string ShowValue(string value)
    {
        return value == null ? "<null>" : "\"" + value + "\"";
    }

    /** 字符串 → JSON 字面量（dryRun 回显用；非 ASCII 直接原样输出，UTF-8 编码已定） */
    internal static string JsonQuote(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append("\"").ToString();
    }

    internal static string JsonEscape(string value)
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

    internal static byte[] EncodeJpeg(Bitmap bmp, long quality)
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

    internal static void Log(string msg)
    {
        Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] [bridge] " + msg);
    }
}
