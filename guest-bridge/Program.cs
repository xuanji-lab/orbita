// Orbita guest bridge —— 跑在 Windows Sandbox 内的极简命令执行器。
//
// 通道 = 映射文件夹里的文件，不是网络：
//   宿主防火墙把宿主↔沙箱的 TCP 当成不可测的（2026-10-10 真机：ICMP 通、TCP 被丢，
//   且随每次沙箱启动时好时坏），而 .wsb 读写映射文件夹双向实时同步、每次都可靠。
//   所以：宿主把命令写进 out/cmd/<名字>.req.json（tmp+rename），桥轮询执行，
//   结果写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件），然后删掉 req。
//   宿主读完响应后负责清理 resp/jpg。
//
// 命令：ping（就绪探针）、screenshot（截主屏）、click / type / key / scroll（SendInput 注入），
// 以及 PR3 的 cdp-*（沙箱内 Edge 的 CDP 语义命令，实现在文件末尾的 CdpSession）。
// CDP 的 WebSocket 只在 guest 内（桥 ↔ 同机 Edge 的 127.0.0.1 端口），不过映射目录。
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
    // 空闲 5 分钟回收）。宿主不逐字比版本，但 bridge.json 里的版本是排查现场的第一行证据：
    // 抬了能力就抬它。
    private const string Version = "0.6.0";
    private const string CmdDirName = "cmd";          // out 下的命令目录
    private const string ReqSuffix = ".req.json";     // 宿主写：命令请求
    private const string RespSuffix = ".resp.json";   // 桥写：执行结果
    private const int PollIntervalMs = 250;           // 命令轮询间隔

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
        // 测试专用入口（宿主上跑 bridge.test.mjs）：只验 JSON 取值器，不碰协议、不碰桌面。
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--selftest-json") return RunJsonSelfTest();
            // 打包产物冒烟的路径闸门自测（纯函数：不启动任何进程、不碰桌面）
            if (args[i] == "--selftest-launch") return RunLaunchSelfTest();
            // 会话 id 安全化的自测（纯函数：CDP 会话键直接拼进 profile 目录，这一关失守就是路径穿越）
            if (args[i] == "--selftest-session") return RunSessionSelfTest();
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
            if (flag == "--no-browser")
            {
                BrowserDisabled = true;
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

    private static void WriteBridgeJson()
    {
        string json = "{\"version\":\"" + Version + "\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}";
        AtomicWrite(Path.Combine(_outDir, "bridge.json"), Encoding.UTF8.GetBytes(json));
        Log("已就绪（bridge.json 已通告）");
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
    /** 全量枚举对齐的周期：16 × 250ms ≈ 4s */
    private const int AlignEveryPolls = 16;

    private static void CommandLoop()
    {
        while (true)
        {
            try
            {
                PollOnce();
                // 空闲浏览器实例的回收：每轮都看一眼（字典空时立刻返回）。
                // 放在这里而不是命令里：一只空闲的 Edge 没有任何命令会经过它，
                // 不在循环里主动看就永远不会被收。
                CdpSessions.ReapIdle();
            }
            catch (Exception ex)
            {
                // 单轮失败不许弄死循环（映射目录抖动等），记下继续
                Log("轮询异常：" + ex.Message);
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
        if (File.Exists(expected))
        {
            ProcessOne(expected);
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
        string[] reqs = Directory.GetFiles(_cmdDir, "*" + ReqSuffix);
        Array.Sort(reqs, StringComparer.Ordinal); // 名字即顺序（宿主命名带递增序号）
        foreach (string reqPath in reqs)
        {
            ProcessOne(reqPath);
            string name = Path.GetFileName(reqPath);
            int seen;
            // cmd-000042.req.json → 序号在 [4, 10)
            if (name.Length >= 14 && int.TryParse(name.Substring(4, 6), out seen) && seen >= _nextSeq)
                _nextSeq = seen + 1;
        }
    }

    /**
     * 处理一个请求文件：读 → 执行 → 写 resp → 删 req。
     * 读失败（宿主 rename 途中的瞬时点 / 文件被占）**静默下轮**：不写 resp、不删 req、
     * 不弄死循环——下一轮直探同一个名字会再试一次。
     */
    private static void ProcessOne(string reqPath)
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
            return; // 宿主 rename 途中的瞬时点，下轮再来
        }
        Log("收到命令 " + name);
        string respJson = Execute(raw, baseName);
        AtomicWrite(Path.Combine(_cmdDir, baseName + RespSuffix), Encoding.UTF8.GetBytes(respJson));
        try { File.Delete(reqPath); } catch { }
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
        if (command == "click") return ExecuteClick(raw);
        if (command == "type") return ExecuteType(raw);
        if (command == "key") return ExecuteKey(raw);
        if (command == "scroll") return ExecuteScroll(raw);
        // 打包产物冒烟（0.5.0）：起 / 停映射进来的 exe，以及只回数字的截图统计
        if (command == "launch") return ExecuteLaunch(raw);
        if (command == "kill") return ExecuteKill(raw);
        if (command == "screenshot-stats") return ExecuteScreenshotStats(raw);
        // CDP 浏览器通道（PR3）：一条语义命令 = 一次文件往返，内部可以有多条 CDP 消息。
        // 实现在 Cdp.cs；0.6.0 起一个会话一个实例，由 CdpSessions 按 session 字段路由
        //（不传就是 default，与改动前同一份行为）。
        if (command.Length > 4 && command.Substring(0, 4) == "cdp-") return CdpSessions.Execute(command, raw, baseName, _cmdDir);
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

    /** 统一的自测回执照 JSON（三个 selftest 共用一份形状，跑测试的人不用记三种） */
    private static string BuildSelfTestJson(List<string> failures, int cases)
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

    private static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
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

    private static void CheckString(List<string> failures, ref int cases, string name, string expected, string actual)
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
