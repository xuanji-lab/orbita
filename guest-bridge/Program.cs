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
// 约束：单文件、单进程、无持久化——沙箱每次重置即消失，不需要任何清理逻辑。
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Collections.Generic;
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
    // ⚠ 0.4.0 起多了 cdp-*（浏览器通道）。宿主不逐字比版本，但 bridge.json 里的版本
    // 是排查现场的第一行证据：抬了能力就抬它。
    private const string Version = "0.4.0";
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
        // CDP 浏览器通道（PR3）：一条语义命令 = 一次文件往返，内部可以有多条 CDP 消息。
        // 实现在文件末尾的 CdpSession；它自己管 Edge 进程与 WebSocket 的生命周期。
        if (command.Length > 4 && command.Substring(0, 4) == "cdp-") return CdpSession.Execute(command, raw, baseName, _cmdDir);
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

    internal static string ExtractString(string json, string field)
    {
        string needle = "\"" + field + "\":\"";
        int start = json.IndexOf(needle, StringComparison.Ordinal);
        if (start < 0) return null;
        start += needle.Length;
        int end = json.IndexOf('"', start);
        if (end < 0) return null;
        return json.Substring(start, end - start);
    }

    internal static string ExtractNumber(string json, string field)
    {
        string needle = "\"" + field + "\":";
        int start = json.IndexOf(needle, StringComparison.Ordinal);
        if (start < 0) return null;
        start += needle.Length;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
        return json.Substring(start, end - start);
    }

    /**
     * 取字符串字段**并解转义**：宿主用 JSON.stringify 落盘，所以引号 / 反斜杠 /
     * 换行 / \uXXXX 都会以转义形式出现。ExtractString 那种「找到下一个引号就切」
     * 的读法会把 `他说"你好"` 切坏——type 命令必须用它。
     * 回 null = 没有这个字段，或者字符串没收尾（半截请求）。
     */
    internal static string ExtractJsonString(string json, string field)
    {
        string needle = "\"" + field + "\":\"";
        int start = json.IndexOf(needle, StringComparison.Ordinal);
        if (start < 0) return null;
        start += needle.Length;
        StringBuilder sb = new StringBuilder();
        int i = start;
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
        return null;
    }

    /** 布尔字段：JSON.stringify 落盘是紧凑的（`"dryRun":true`），找字面量即可 */
    internal static bool ExtractBool(string json, string field)
    {
        return json.IndexOf("\"" + field + "\":true", StringComparison.Ordinal) >= 0;
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
