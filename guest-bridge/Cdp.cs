// Orbita guest bridge —— 沙箱内 Edge 的 CDP 通道（桥版本 0.4.0 新增）。
//
// 0.6.0 起**一个会话一个实例**：CdpSession 是每个会话自己的 Edge（各自的 --user-data-dir 与
// --remote-debugging-port=0）。0.7.0 起执行者换成**该会话自己的 worker 子进程**（WorkerHost.cs）：
// 一个 worker 进程里只有一个 CdpSession，因而这里不再需要会话表 / 空闲回收——上来的是
// 「会话」这件事已经由「哪个 worker 进程」表达了，worker 被杀 = 它的 Edge 一起死。
// CdpSessions 因此只剩纯函数与常量：会话 id 安全化（两边必须逐字一致）、命令名白名单、
// 实例上限那句话、profile 目录的路径与删除。
//
// 为什么是「语义原子命令」而不是裸 CDP 转发：
//   ① CDP 是事件驱动的（导航完成是 Page.loadEventFired 事件，不是 navigate 的回执），
//      文件协议没有流，裸转发就得在 guest 里造一个可回放的事件缓冲；
//   ② 截图回执是内联 base64（实测 71KB 回执 / 5 帧到达），塞进 resp JSON 会把宿主侧的
//      JSON.parse 与 IPC 拖垮——所以 cdp-shot 写同名 .jpg 兄弟文件，与 screenshot 同款；
//   ③ 裸转发等于把「任意 CDP 命令」交给模型（Runtime.evaluate 只是其中一条）。
//   于是：一条命令内部 3~4 条 CDP 消息，只算一次文件往返。cdp-eval 不进工具面。
//
// 拓扑（2026-10-24 沙箱真机验过）：browser 级 WebSocket + Target.createTarget +
//   Target.attachToTarget{flatten:true}。一个 socket 管所有 target，事件也在这条上。
//
// 三个必须照做的坑（真机踩过，不做就是「握手 403 / 底层连接已关闭」）：
//   ① Proxy = null（HttpWebRequest 与 ClientWebSocket.Options 两处）：沙箱里的系统代理
//      会把 127.0.0.1 也送进代理，报错完全不像代理问题；
//   ② 不设 Origin：Chromium 校验 WS 握手的 Origin，ClientWebSocket 默认不发，保持默认；
//   ③ 跳过所有没有 id 的消息：Page.enable 之后事件会插在回复之间，「下一次读到的就是
//      回复」这个假设在开启任何 domain 之后立刻失效。
//
// 编译约束不变：csc v4.0.30319 = C# 5（禁字符串插值 / ?. / out var / using 声明 / 枚举）。
// 全程同步 .Wait(ms)：桥本来就是 while(true) 轮询循环，铺 async 状态机没有收益。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal sealed class CdpSession
{
    // ── 沙箱内的固定路径（与 shared/computer-use.ts 的常量严格一致）────────────────
    private const string EdgePathX86 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    private const string EdgePathX64 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
    private const string UploadRoot = @"C:\orbita-out\upload";
    private const string DownloadRoot = @"C:\orbita-out\downloads";

    /** 起 Edge 到 CDP 可用的上限。真机实测 2555ms 就绪；给冷启动 / 首启解压留余量 */
    private const int LaunchTimeoutMs = 25000;
    /** 单条 CDP 消息的默认等待 */
    private const int DefaultTimeoutMs = 10000;
    /** 导航默认等待（页内资源多的站点要更久） */
    private const int NavTimeoutMs = 20000;
    /**
     * 错误页正文里原因码的等待窗口（另见 WaitForErrorCode）。为什么是 2s：
     * 错误页的 DOM 是本地资源，正常一两帧就好；超过 2s 说明这页不会渲染正文了，
     * 继续等就是在把「省下的 20 秒」还回去。每 300ms 一轮 = 最多 7 次读正文。
     */
    private const int ErrorCodeWaitMs = 2000;
    private const int ErrorCodePollMs = 300;
    /** 错误页的诊断日志只打这么多字（一整行日志，读的时候不用翻页） */
    private const int ErrorPageLogChars = 120;
    /** 错误文案里回显 URL 的上限：data: / 长查询串会把一句话撑成一屏（真机见过几百字符） */
    private const int NavUrlInMessageMax = 80;
    /** 截图默认上限宽度（长边），与像素截图同值 */
    private const int ShotMaxWidth = 1280;
    /** extract / observe 正文单次上限（resp 是整读整写的文件，超了宿主吃不下） */
    private const int TextLimit = 20000;

    // ── 会话状态：**一个实例一个会话**（v1.5-1 起；一个 worker 进程只有它）────────────────
    /** 安全化之后的会话键（等于 profile 目录名）。诊断日志与回执里的 session 字段都用它 */
    internal readonly string Key;
    /** 这个会话的 profile 目录（guest 绝对路径，C:\orbita-browser\sessions\<Key>） */
    private readonly string _profileDir;
    private ClientWebSocket _ws;
    /** CDP 的 flatten sessionId（不是我们的会话键；同名不同物，别混） */
    private string _sessionId = "";
    private string _targetId = "";
    private int _port = 0;
    private string _product = "";
    private Process _edge;
    private int _nextId = 0;
    private bool _connecting = false;

    public CdpSession(string key)
    {
        Key = key;
        _profileDir = CdpSessions.ProfileDir(key);
    }

    // ── 入口：worker（或没有 worker 时的临时实例）按命令分派 ─────────────────────

    internal string Execute(string command, string raw, string baseName, string cmdDir)
    {
        try
        {
            if (command == "cdp-start") return Start(raw);
            if (command == "cdp-status") return Status();
            if (command == "cdp-nav") return Nav(raw);
            if (command == "cdp-observe") return Observe(raw);
            if (command == "cdp-click") return Click(raw);
            if (command == "cdp-type") return TypeText(raw);
            if (command == "cdp-extract") return ExtractText(raw);
            if (command == "cdp-wait") return WaitFor(raw);
            if (command == "cdp-shot") return Shot(raw, baseName, cmdDir);
            if (command == "cdp-upload") return Upload(raw);
            if (command == "cdp-download") return Download(raw);
            if (command == "cdp-tabs") return Tabs(raw);
            return Fail("未知的 CDP 命令：" + command);
        }
        catch (Exception ex)
        {
            // **任何失败都不能弄死桥**：回一句人话，命令循环继续。模型看不见 UI，
            // 所以错误里要带「下一步」——CDP 不可用时提示可以退回像素工具。
            Program.Log("CDP " + command + " 失败：" + ex.Message);
            return Fail(Describe(command, ex.Message));
        }
    }

    /** 把底层异常翻成模型能照着做的句子（裸异常名对模型没有信息量） */
    private string Describe(string command, string message)
    {
        if (message != null && message.IndexOf("没有在运行", StringComparison.Ordinal) >= 0) return message;
        return "沙箱里的浏览器命令 " + command + " 失败：" + message;
    }

    // ── cdp-start ────────────────────────────────────────────────────────────────

    /**
     * 等 CDP 连接就绪的期限与节奏。
     *
     * **必须重试**：超时杀掉 worker 之后重开同一个会话时，profile 里可能还留着上一只 Edge 的
     * DevToolsActivePort（ClearStalePortFile 会先删它，但删不掉 / Edge 自己写一半都可能留下旧端口），
     * 于是第一条命令去连一个死端口，.NET 只回一句「Unable to connect to the remote server」
     * ——模型看不懂也修不了（2026-10-25 真机就这么挂在超时之后的自愈路上）。
     * 这种「端口还没就绪」的阶段在 guest 内轮询掉，别把异常扔给模型。
     * 8s 与 LaunchTimeoutMs 加起来仍在主桥的 40s 命令线之下。
     */
    private const int ConnectRetryMs = 8000;
    private const int ConnectRetryIntervalMs = 400;

    private string Start(string raw)
    {
        bool headless = Program.ExtractBool(raw, "headless");
        int port = ReadInt(raw, "port", 0, 0, 65535);
        string url = Program.ExtractJsonString(raw, "url");

        if (IsAlive())
        {
            // 幂等：已经在跑就直接回现状；带 url 就当作一次导航
            if (url != null && url.Trim().Length > 0) return Nav(raw);
            return OkWithStatus(true);
        }

        Launch(headless, port);
        try
        {
            ConnectAndAttach();
        }
        catch
        {
            // 连不上就把我们刚起的进程收掉，别留一个「起了但没用」的 Edge
            KillOurEdge();
            throw;
        }
        if (url != null && url.Trim().Length > 0) return Nav(raw);
        return OkWithStatus(true);
    }

    private void Launch(bool headless, int port)
    {
        // 测试缝：在宿主上跑 bridge.test.mjs 时绝不能去 Process.Start msedge.exe
        //（那是用户真实的浏览器）。生产不带 --no-browser。
        if (Program.BrowserDisabled)
            throw new Exception("测试模式（--no-browser）：不在这个进程里启动 Edge。"
                + "真机请用 sandbox_navigate；如不能起 CDP，改用 computer_screenshot / computer_click 像素工具");
        string edge = EdgePath();
        if (edge == null)
        {
            throw new Exception(
                "沙箱里没有找到 msedge.exe（找过 Program Files (x86) 与 Program Files 两处）。"
                + "CDP 通道在这个沙箱里用不了：请改用 computer_screenshot / computer_click 像素工具操作网页");
        }
        try
        {
            Directory.CreateDirectory(_profileDir);
        }
        catch (Exception ex)
        {
            // profile 目录建不起来 = 这个会话的浏览器必定起不来，说清楚是哪条路、下一步做什么
            throw new Exception("沙箱里的浏览器 profile 目录建不起来：" + _profileDir + "（" + ex.Message + "）。"
                + "这个会话的浏览器用不了：先 cdp-stop 这个会话，再 sandbox_navigate 重试；连续失败就改用 computer_screenshot 像素工具");
        }
        string args = BuildArgs(port, headless, false);
        // 开场之前先清掉**上一只 Edge 留下的端口文件**：超时杀 worker 只杀进程树（不删 profile，
        // 免得把登录态一起扔了），而 DevToolsActivePort 会活下来。留着它的后果：新 Edge 刚起来、
        // WaitForPortFile 一进循环就看见「文件已存在」立刻回 true，然后把**旧端口**当成本次端口，
        // 之后去连一个死 socket——真机 2026-10-25 的「cdp-start 失败：Unable to connect to the remote server」。
        ClearStalePortFile(_profileDir);
        Program.Log("CDP 启动 Edge：" + edge + " " + args);
        _edge = Process.Start(new ProcessStartInfo(edge, args));
        if (_edge == null) throw new Exception("启动 msedge.exe 失败（进程没有起来）");

        // 首启偶尔会因为沙箱里嵌套的 Chromium sandbox 冲突秒退：给一次 --no-sandbox 重试
        //（沙箱本身已是 VM 隔离，这一层可接受）。
        if (!WaitForPortFile(8000))
        {
            if (_edge.HasExited || !PortFileReady())
            {
                Program.Log("CDP 首启未就绪，带 --no-sandbox 重试一次");
                KillOurEdge();
                _edge = Process.Start(new ProcessStartInfo(edge, BuildArgs(port, headless, true)));
                if (_edge == null) throw new Exception("启动 msedge.exe 失败（重试也没有起来）");
            }
        }

        string content = ReadPortFile(LaunchTimeoutMs);
        if (content.Length == 0)
        {
            throw new Exception(
                "Edge 进程起来了，但 " + LaunchTimeoutMs / 1000 + " 秒内没有打开调试端口（"
                + Path.Combine(_profileDir, "DevToolsActivePort") + " 没出现）。"
                + "可以再试一次 sandbox_navigate；连续失败就改用 computer_screenshot / computer_click 像素工具");
        }
        string[] lines = content.Replace("\r", "").Split('\n');
        string portText = lines.Length > 0 ? lines[0].Trim() : "";
        int parsed = ParsePortFileContent(content);
        if (parsed <= 0)
            throw new Exception("DevToolsActivePort 的首行不是端口号（读到「" + portText + "」）——这个 Edge 版本的端口文件格式不同");
        _port = parsed;
        Program.Log("CDP 端口 " + _port + "（来自 DevToolsActivePort）");
    }

    /**
     * 端口文件正文 → 端口（首行）。不能解析回 0。**纯函数**：自测在宿主上直接验它，不碰 Edge。
     * 格式固定是「端口\n/devtools/browser/<id>」。
     */
    internal static int ParsePortFileContent(string content)
    {
        if (content == null) return 0;
        string[] lines = content.Replace("\r", "").Split('\n');
        string portText = lines.Length > 0 ? lines[0].Trim() : "";
        int port;
        if (!int.TryParse(portText, out port) || port <= 0 || port > 65535) return 0;
        return port;
    }

    /**
     * 起 Edge **之前**删掉旧的 DevToolsActivePort。返回 true = 现在可以放心起了（文件不在）。
     *
     * 为什么不能只靠「新 Edge 会重写它」：写是晚于我们读的。旧文件在场时，新 Edge 刚被拉起、
     * 还没监听，等待循环却已经把旧端口交回去了。**删不掉不算失败**（记日志，继续起）——
     * 后面的连接重试与重读端口文件是第二道防线。
     */
    internal static bool ClearStalePortFile(string profileDir)
    {
        string path = Path.Combine(profileDir, "DevToolsActivePort");
        try
        {
            if (!File.Exists(path)) return true;
            File.Delete(path);
            if (File.Exists(path))
            {
                Program.Log("旧的 DevToolsActivePort 删不掉（还在）：" + path);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            Program.Log("删除旧的 DevToolsActivePort 失败（" + path + "）：" + ex.Message);
            return false;
        }
    }

    private string BuildArgs(int port, bool headless, bool noSandbox)
    {
        StringBuilder a = new StringBuilder();
        a.Append("--remote-debugging-port=").Append(port).Append(" ");
        a.Append("--user-data-dir=\"").Append(_profileDir).Append("\" ");
        a.Append("--no-first-run --no-default-browser-check ");
        a.Append("--disable-sync --disable-background-networking --disable-component-update ");
        a.Append("--disable-features=msEdgeFirstRunExperience,msEdgeSidebarV2,msEdgeWelcomePage ");
        a.Append("--disable-gpu ");
        a.Append("--window-size=1366,900 ");
        if (headless) a.Append("--headless=new ");
        if (noSandbox) a.Append("--no-sandbox ");
        a.Append("about:blank");
        return a.ToString();
    }

    private string EdgePath()
    {
        if (File.Exists(EdgePathX86)) return EdgePathX86;
        if (File.Exists(EdgePathX64)) return EdgePathX64;
        return null;
    }

    private bool PortFileReady()
    {
        try { return File.Exists(Path.Combine(_profileDir, "DevToolsActivePort")); }
        catch { return false; }
    }

    /** 等 DevToolsActivePort 出现（true = 出现）。进程秒退时提前返回 false */
    private bool WaitForPortFile(int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (PortFileReady()) return true;
            if (_edge != null && _edge.HasExited) return false;
            Thread.Sleep(200);
        }
        return PortFileReady();
    }

    private string ReadPortFile(int timeoutMs)
    {
        string path = Path.Combine(_profileDir, "DevToolsActivePort");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        string content = "";
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (File.Exists(path)) content = File.ReadAllText(path);
            }
            catch
            {
                // 端口文件可能正被 Edge 写一半，下一轮再读
            }
            if (content.Trim().Length > 0) return content;
            Thread.Sleep(200);
        }
        return content;
    }

    // ── 停一个会话（worker 收到 worker-stop / 被主桥杀掉之前调它）─────────────────

    /** 清连接、清状态、杀我们自己起的那个进程树。不删 profile 目录（那个由主桥在收尾时删） */
    internal void Shutdown()
    {
        CloseSocket();
        _sessionId = "";
        _targetId = "";
        _product = "";
        _port = 0;
        KillOurEdge();
    }

    /** 是否还在跑我们起的 Edge：worker 用它判断「启动失败不占着这个 worker」 */
    internal bool HasLiveProcess()
    {
        return _edge != null && !_edge.HasExited;
    }

    /**
     * 只杀 `_edge` 记录下来的那一条进程树。
     *
     * **绝不按镜像名杀**（沙箱里可能还有用户自己开的 Edge，宿主上更是别人的应用）。
     * /T 是必须的：msedge.exe 只是父进程，renderer / gpu 都是子进程，单杀父进程会留孤儿。
     */
    private void KillOurEdge()
    {
        Process edge = _edge;
        _edge = null;
        if (edge == null) return;
        int pid = 0;
        try { pid = edge.Id; } catch { pid = 0; }
        try { if (!edge.HasExited) edge.Kill(); } catch { }
        if (pid > 0) RunQuiet("taskkill.exe", "/PID " + pid + " /T /F");
    }

    private void RunQuiet(string file, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process p = Process.Start(psi);
            if (p != null) p.WaitForExit(5000);
        }
        catch
        {
            // 杀不掉不是命令失败：调用方已经先把 ws / 状态清了
        }
    }

    private void CloseSocket()
    {
        ClientWebSocket ws = _ws;
        _ws = null;
        if (ws == null) return;
        try { ws.Dispose(); } catch { }
    }

    private bool IsAlive()
    {
        if (_edge == null || _edge.HasExited) return false;
        if (_ws != null && _ws.State == WebSocketState.Open) return true;
        // 进程在、socket 断了（Edge 自己重开过 target）：算活着，交给 EnsureConnection 重连
        return _port > 0;
    }

    // ── cdp-status ───────────────────────────────────────────────────────────────

    private string Status()
    {
        if (!IsAlive()) return NotRunningStatus();
        try
        {
            ConnectAndAttach();
            string href = EvalString("location.href", 5000);
            string title = EvalString("document.title", 5000);
            List<TargetInfo> pages = PageTargets();
            JObj o = new JObj().Bool("ok", true).Str("session", Key).Bool("running", true).Num("port", _port)
                .Str("product", _product).Str("url", href).Str("title", title)
                .Num("active", ActiveIndex(pages)).Raw("tabs", TabsJson(pages));
            return o.ToString();
        }
        catch (Exception ex)
        {
            // CDP 通道坏了不等于浏览器没了。旧行为在这里一律回 running:false，于是宿主看到
            // 「没在跑」而进程其实好好的（自相矛盾），「下一条命令能不能用」也没人处理。
            InvalidateSession();
            // 先确认真相：没等到的这段时间 Edge 也可能真的退了（那就是真的没在跑）
            if (!IsAlive()) return NotRunningStatus();
            return new JObj().Bool("ok", true).Str("session", Key).Bool("running", true).Num("port", _port)
                .Str("error", ex.Message)
                .Str("hint", "浏览器进程还活着，但 CDP 通道刚断过一次（上一条命令超时 / 页面崩了）。"
                    + "下一条 sandbox_navigate 会自动重连；连续失败就改用 computer_screenshot / computer_click 像素工具")
                .ToString();
        }
    }

    private string NotRunningStatus()
    {
        return new JObj().Bool("ok", true).Str("session", Key).Bool("running", false).Num("port", _port)
            .Str("hint", "沙箱里的 Edge 没有在运行。sandbox_navigate 会自动把它拉起来；"
                + "如果拉不起来，改用 computer_screenshot / computer_click 像素工具").ToString();
    }

    private string OkWithStatus(bool alreadyRunning)
    {
        JObj o = new JObj().Bool("ok", true).Str("session", Key).Num("port", _port).Str("product", _product)
            .Bool("alreadyRunning", alreadyRunning);
        try
        {
            Process edge = _edge;
            if (edge != null) o.Num("pid", edge.Id);
        }
        catch
        {
            // pid 只是给现场排查看的，取不到不影响命令结果
        }
        return o.ToString();
    }

    // ── WebSocket 连接与 target 附着 ─────────────────────────────────────────────

    private void ConnectAndAttach()
    {
        if (_ws != null && _ws.State == WebSocketState.Open && _sessionId.Length > 0) return;
        if (_edge == null || _edge.HasExited)
            throw new Exception("沙箱里的 Edge 没有在运行（或已经退出）。先发 sandbox_navigate 打开网页，"
                + "它会把 Edge 拉起来；连续失败就改用 computer_screenshot / computer_click 像素工具");
        if (_connecting) throw new Exception("CDP 连接正在建立中（上一条命令还没收尾）");
        _connecting = true;
        try
        {
            if (_port <= 0) throw new Exception("不知道 CDP 端口（DevToolsActivePort 没读到）");
            OpenSocket();
            AttachPage();
        }
        finally
        {
            _connecting = false;
        }
    }

    /**
     * 拿 browser 级 WebSocket（/json/version → webSocketDebuggerUrl → 连接）。
     *
     * **连不上就重试**（理由见 ConnectRetryMs）：真机上这只 Edge 可能刚被重新拉起、
     * 端口文件里还是上一只的旧端口，或监听还没就绪。这两种都是秒级自愈的，
     * 不该变成模型看到的一句「Unable to connect to the remote server」。
     * 每次重试前**重读端口文件**：旧端口 → 新端口的切换就靠它。
     */
    private void OpenSocket()
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ConnectRetryMs);
        while (true)
        {
            string version;
            try
            {
                version = HttpGet("http://127.0.0.1:" + _port + "/json/version", 5000);
            }
            catch (Exception ex)
            {
                if (RetryConnection(ex, deadline)) continue;
                throw new Exception("沙箱里的 Edge 调试端口 " + _port + " 连不上（" + BaseMessage(ex) + "）。"
                    + "可能是 Edge 刚重启、调试端口还没就绪：稍后重试一次 sandbox_navigate；"
                    + "连续失败就改用 computer_screenshot / computer_click 像素工具");
            }
            string wsUrl = Program.ExtractString(version, "webSocketDebuggerUrl");
            if (wsUrl == null || wsUrl.Length == 0)
                throw new Exception("Edge 的 /json/version 里没有 webSocketDebuggerUrl（端口 " + _port + " 可能被别的进程占了）");
            _product = Program.ExtractString(version, "Browser");
            CloseSocket();
            try
            {
                _ws = Connect(wsUrl, 5000);
            }
            catch (Exception ex)
            {
                if (RetryConnection(ex, deadline)) continue;
                throw;
            }
            Program.Log("CDP 已连接：" + wsUrl + " product=" + _product);
            return;
        }
    }

    /**
     * 一次连接失败之后：还能等就重读端口、睡一下、回 true（调用方 continue）；
     * 超期限回 false（调用方报错）；**Edge 已经退了就直接说「没有在运行」**——宿主的
     * 缓存自愈就是按这句话触发的。
     */
    private bool RetryConnection(Exception cause, DateTime deadline)
    {
        if (_edge == null || _edge.HasExited)
            throw new Exception("沙箱里的浏览器没有在运行（Edge 在等调试端口时退出了）。"
                + "先 sandbox_navigate 把它重新拉起来；连续失败就改用 computer_screenshot / computer_click 像素工具");
        if (DateTime.UtcNow >= deadline) return false;
        RefreshPortFromFile();
        Program.Log("CDP 连接还没就绪（" + BaseMessage(cause) + "），" + ConnectRetryIntervalMs
            + "ms 后重试（端口 " + _port + "）");
        Thread.Sleep(ConnectRetryIntervalMs);
        return true;
    }

    /** 重读端口文件：上次读到的可能是上一只 Edge 留下的旧端口（换了就跟着改，并记一笔） */
    private void RefreshPortFromFile()
    {
        try
        {
            string path = Path.Combine(_profileDir, "DevToolsActivePort");
            if (!File.Exists(path)) return;
            int port = ParsePortFileContent(File.ReadAllText(path));
            if (port <= 0 || port == _port) return;
            Program.Log("CDP 端口从 " + _port + " 改成 " + port + "（端口文件被新的 Edge 重写过）");
            _port = port;
        }
        catch
        {
            // 端口文件可能正被写一半，下一轮再读
        }
    }

    /** 底层异常取最内层原因（WebException 自己的 Message 只有「远程服务器返回错误」这类套话） */
    private static string BaseMessage(Exception ex)
    {
        if (ex == null) return "未知原因";
        Exception inner = ex.GetBaseException();
        string message = inner == null ? ex.Message : inner.Message;
        return message == null || message.Length == 0 ? "未知原因" : message;
    }

    /** 选一个 page target 并 attach（flatten）。优先回到原来那个 target（保持当前标签页），没有就新建一个 */
    private void AttachPage()
    {
        List<TargetInfo> pages = PageTargets();
        TargetInfo chosen = null;
        // 重连（上一条命令超时后 session 被丢掉）时不能随手拿 pages[0]：那会把模型
        // 从正在操作的那个标签页换到另一个上。原来那个 target 还在就回到它。
        for (int i = 0; i < pages.Count; i++)
        {
            if (_targetId.Length > 0 && pages[i].Id == _targetId) { chosen = pages[i]; break; }
        }
        if (chosen == null) chosen = pages.Count > 0 ? pages[0] : null;
        if (chosen == null)
        {
            string created = CallBrowser("Target.createTarget", "{\"url\":\"about:blank\"}", 10000);
            string newId = Program.ExtractString(created, "targetId");
            if (newId == null || newId.Length == 0) throw new Exception("Target.createTarget 没有回 targetId");
            chosen = new TargetInfo();
            chosen.Id = newId;
            chosen.Type = "page";
            chosen.Url = "about:blank";
            chosen.Title = "";
        }
        Attach(chosen.Id);
    }

    private void Attach(string targetId)
    {
        string attached = CallBrowser(
            "Target.attachToTarget",
            "{\"targetId\":" + Program.JsonQuote(targetId) + ",\"flatten\":true}",
            10000);
        string sessionId = Program.ExtractString(attached, "sessionId");
        if (sessionId == null || sessionId.Length == 0)
            throw new Exception("Target.attachToTarget 没有回 sessionId（这个 Edge 的 flatten 拓扑可能不同）");
        _sessionId = sessionId;
        _targetId = targetId;
        // Page 域要先 enable 才有事件与 captureScreenshot 的完整能力；每个新 session 一次
        CallSession(_sessionId, "Page.enable", "{}", 8000);
        Program.Log("CDP 已附着 target " + targetId + " session " + sessionId);
    }

    private sealed class TargetInfo
    {
        public string Id = "";
        public string Type = "";
        public string Url = "";
        public string Title = "";
    }

    private List<TargetInfo> PageTargets()
    {
        string reply = CallBrowser("Target.getTargets", "{}", 8000);
        List<TargetInfo> all = ParseTargets(reply);
        List<TargetInfo> pages = new List<TargetInfo>();
        for (int i = 0; i < all.Count; i++)
        {
            if (all[i].Type == "page") pages.Add(all[i]);
        }
        return pages;
    }

    /**
     * 解析 Target.getTargets 的 reply。没有 JSON 库，按 `"targetId":"` 切块再逐字段取：
     * 一个 targetInfo 的字段顺序是 targetId → type → title → url，块内取不会串到下一个。
     */
    private List<TargetInfo> ParseTargets(string reply)
    {
        List<TargetInfo> list = new List<TargetInfo>();
        string marker = "\"targetId\":\"";
        int at = reply.IndexOf(marker, StringComparison.Ordinal);
        while (at >= 0)
        {
            int next = reply.IndexOf(marker, at + marker.Length, StringComparison.Ordinal);
            string chunk = next > 0 ? reply.Substring(at, next - at) : reply.Substring(at);
            TargetInfo info = new TargetInfo();
            info.Id = Program.ExtractString(chunk, "targetId");
            info.Type = Program.ExtractString(chunk, "type");
            info.Title = Program.ExtractString(chunk, "title");
            info.Url = Program.ExtractString(chunk, "url");
            if (info.Id == null) info.Id = "";
            if (info.Type == null) info.Type = "";
            if (info.Title == null) info.Title = "";
            if (info.Url == null) info.Url = "";
            list.Add(info);
            if (next < 0) break;
            at = next;
        }
        return list;
    }

    private int ActiveIndex(List<TargetInfo> pages)
    {
        for (int i = 0; i < pages.Count; i++)
        {
            if (pages[i].Id == _targetId) return i;
        }
        return pages.Count > 0 ? 0 : -1;
    }

    private string TabsJson(List<TargetInfo> pages)
    {
        StringBuilder sb = new StringBuilder("[");
        int active = ActiveIndex(pages);
        for (int i = 0; i < pages.Count; i++)
        {
            if (i > 0) sb.Append(",");
            JObj o = new JObj().Num("index", i).Str("id", pages[i].Id)
                .Str("url", pages[i].Url).Str("title", pages[i].Title)
                .Bool("active", i == active);
            sb.Append(o.ToString());
        }
        return sb.Append("]").ToString();
    }

    // ── CDP 调用核心 ─────────────────────────────────────────────────────────────

    private string Call(string method, string paramsJson, int timeoutMs)
    {
        return CallSession(_sessionId, method, paramsJson, timeoutMs);
    }

    private string CallBrowser(string method, string paramsJson, int timeoutMs)
    {
        return CallSession(null, method, paramsJson, timeoutMs);
    }

    private string CallSession(string sessionId, string method, string paramsJson, int timeoutMs)
    {
        if (!_connecting) ConnectAndAttach();
        if (_ws == null || _ws.State != WebSocketState.Open) throw new Exception("CDP 连接已断开");
        string text = Exchange(sessionId, method, paramsJson, timeoutMs);
        if (sessionId == null || sessionId.Length == 0) return text;
        if (!IsStaleSessionError(text)) return text;
        // attach 自己发命令时（_connecting）不在这里重连：本来就在建连，重入只会害自己
        if (_connecting) return text;
        // 这条 flatten session 在 Edge 那边已经没了。真机现场（2026-10-25）：上一条
        // cdp-nav 的 Page.navigate 超时之后，**紧接着的下一条命令**必回
        // 「Session with given id not found」，再下一条才自愈——对模型就是「刚才那个
        // 站点打不开，现在连下一个页面也打不开」。这里当场重连 + 重发一次（session 失效
        // 意味着这条命令根本没执行过，重发是安全的）。
        Program.Log("CDP session 已失效（" + method + " 回 Session not found），重连后重发一次");
        InvalidateSession();
        ConnectAndAttach();
        if (_sessionId.Length == 0) return text;
        return Exchange(_sessionId, method, paramsJson, timeoutMs);
    }

    /** 发一条 CDP 消息并等它自己的回执（只发、不重试、不解释错误） */
    private string Exchange(string sessionId, string method, string paramsJson, int timeoutMs)
    {
        int id = ++_nextId;
        StringBuilder m = new StringBuilder();
        m.Append("{\"id\":").Append(id).Append(",\"method\":\"").Append(method).Append("\",\"params\":").Append(paramsJson);
        if (sessionId != null && sessionId.Length > 0)
            m.Append(",\"sessionId\":").Append(Program.JsonQuote(sessionId));
        m.Append("}");

        byte[] bytes = Encoding.UTF8.GetBytes(m.ToString());
        Task send = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        if (!send.Wait(timeoutMs))
        {
            // 超时的 SendAsync 会让 socket 进入不可用状态：丢掉引用，下一条命令重连
            InvalidateSession();
            throw new Exception("CDP 发送超时（" + method + "）");
        }
        if (send.IsFaulted)
        {
            InvalidateSession();
            throw new Exception("CDP 发送失败（" + method + "）：" + BaseMessage(send));
        }

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            int left = (int)Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds);
            string text = ReceiveMessage(left);
            if (text == null) break;
            // **没有 id 的是事件**（Page.loadEventFired / Network.* 等），一律丢掉
            if (HasId(text, id)) return text;
        }
        // 超时之后这条 session 也可能已经废了（真机：下一条命令会撞 Session not found），
        // 连同 socket 一起丢掉；_targetId 留着，重连时回到同一个标签页。
        InvalidateSession();
        throw new Exception("CDP 命令超时（" + method + "，" + timeoutMs + "ms 内没有回执）");
    }

    /**
     * 丢掉 CDP 连接与会话，但**不杀 Edge、也不丢 _targetId**：下次用到时重连 + 重新 attach，
     * 仍然回到原来那个标签页。用在「上一条命令超时 / session 已失效 / 状态查询失败」之后。
     */
    private void InvalidateSession()
    {
        CloseSocket();
        _sessionId = "";
    }

    /**
     * 回执里是不是「这个 flatten session 已经不存在了」。真机原文：
     * `Session with given id not found.`（target 没了时是 `No target with given id found`）。
     * **纯函数**：自测在宿主上直接验它。
     */
    internal static bool IsStaleSessionError(string reply)
    {
        if (reply == null) return false;
        return reply.IndexOf("Session with given id not found", StringComparison.OrdinalIgnoreCase) >= 0
            || reply.IndexOf("No target with given id", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /**
     * 读**一整条** WebSocket 消息：截图回执会被拆成多帧（真机实测 5 帧、最大帧 16KB），
     * 只读一次就是半截 JSON。循环到 EndOfMessage 再拼。
     */
    private string ReceiveMessage(int timeoutMs)
    {
        ClientWebSocket ws = _ws;
        if (ws == null) return null;
        byte[] buf = new byte[64 * 1024];
        MemoryStream acc = new MemoryStream();
        CancellationTokenSource cts = new CancellationTokenSource(timeoutMs);
        try
        {
            while (true)
            {
                Task<WebSocketReceiveResult> t = ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                if (!t.Wait(timeoutMs))
                {
                    // 超时的 ReceiveAsync 会把 socket 作废：丢掉引用，下次命令重连
                    CloseSocket();
                    return null;
                }
                if (t.IsFaulted)
                {
                    CloseSocket();
                    return null;
                }
                WebSocketReceiveResult r = t.Result;
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    CloseSocket();
                    return null;
                }
                acc.Write(buf, 0, r.Count);
                if (r.EndOfMessage) return Encoding.UTF8.GetString(acc.ToArray());
            }
        }
        finally
        {
            cts.Dispose();
            acc.Dispose();
        }
    }

    private bool HasId(string json, int id)
    {
        string needle = "\"id\":" + id;
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return false;
        int after = i + needle.Length;
        if (after >= json.Length) return true;
        char c = json[after];
        return c == ',' || c == '}' || c == ' ' || c == '\r' || c == '\n';
    }

    private string BaseMessage(Task task)
    {
        try
        {
            if (task.Exception != null) return task.Exception.GetBaseException().Message;
        }
        catch { }
        return "未知原因";
    }

    private ClientWebSocket Connect(string wsUrl, int timeoutMs)
    {
        ClientWebSocket ws = new ClientWebSocket();
        ws.Options.Proxy = null;                       // 关键 1：别让系统代理吃掉 127.0.0.1
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        // 关键 2：不设 Origin（Chromium 会拒绝不匹配的 Origin，ClientWebSocket 默认不发）
        CancellationTokenSource cts = new CancellationTokenSource(timeoutMs);
        try
        {
            Task t = ws.ConnectAsync(new Uri(wsUrl), cts.Token);
            if (!t.Wait(timeoutMs + 500)) throw new Exception("CDP 连接超时（" + wsUrl + "）");
            if (t.IsFaulted)
                throw new Exception("CDP 连接失败：" + BaseMessage(t)
                    + "（若是 403，先确认没设 Origin；报「底层连接已关闭」通常是代理没关）");
            return ws;
        }
        finally
        {
            cts.Dispose();
        }
    }

    // ── 小工具：HTTP（loopback）──────────────────────────────────────────────────

    private string HttpGet(string url, int timeoutMs)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs;
        req.Proxy = null;                              // 关键 1 的 HTTP 侧
        req.KeepAlive = false;
        using (WebResponse resp = req.GetResponse())
        using (Stream s = resp.GetResponseStream())
        using (StreamReader r = new StreamReader(s, Encoding.UTF8))
            return r.ReadToEnd();
    }

    // ── 求值 helper ──────────────────────────────────────────────────────────────

    private string Eval(string expression, int timeoutMs)
    {
        string reply = Call("Runtime.evaluate",
            "{\"expression\":" + Program.JsonQuote(expression) + ",\"returnByValue\":true}", timeoutMs);
        string err = CdpError(reply);
        if (err != null) throw new Exception("页面里的脚本报错：" + err);
        return reply;
    }

    private string EvalString(string expression, int timeoutMs)
    {
        string reply = Eval(expression, timeoutMs);
        string value = Program.ExtractJsonString(reply, "value");
        return value == null ? "" : value;
    }

    private bool EvalBool(string expression, int timeoutMs)
    {
        string reply = Eval(expression, timeoutMs);
        return reply.IndexOf("\"value\":true", StringComparison.Ordinal) >= 0;
    }

    /** CDP 回执里的 error.message（没有 error 回 null）。裸异常对模型没有信息量，要带 message */
    private string CdpError(string reply)
    {
        if (reply == null) return "没有回执";
        if (reply.IndexOf("\"error\":{", StringComparison.Ordinal) < 0) return null;
        string message = Program.ExtractString(reply, "message");
        return message == null || message.Length == 0 ? "CDP 返回了错误但没有 message" : message;
    }

    // ── cdp-nav ──────────────────────────────────────────────────────────────────

    private string Nav(string raw)
    {
        string url = Program.ExtractJsonString(raw, "url");
        if (url == null || url.Trim().Length == 0) return Fail("cdp-nav 需要 url 字段");
        url = url.Trim();
        int timeoutMs = ReadInt(raw, "timeoutMs", NavTimeoutMs, 2000, 60000);
        Stopwatch sw = Stopwatch.StartNew();

        string lower = url.ToLowerInvariant();
        if (lower == "back" || lower == "forward")
        {
            try { EvalString("(function(){history." + lower + "();return 'ok';})()", 5000); }
            catch
            {
                // 导航会把执行上下文销毁，Runtime.evaluate 可能就在那一刻回不来了；
                // 这是正常现场，不要因为历史前进/后退把整条命令判死
            }
            int moved = WaitForReady(null, timeoutMs);
            return NavResult(sw, moved == ReadyOk ? null : "历史" + (lower == "back" ? "后退" : "前进") + "后页面在 "
                + timeoutMs + "ms 内没有加载完成（可能已经没有上一页 / 下一页）");
        }

        string target = NormalizeUrl(url);
        string navReply;
        try
        {
            navReply = Call("Page.navigate", "{\"url\":" + Program.JsonQuote(target) + "}", timeoutMs);
        }
        catch (Exception ex)
        {
            // Page.navigate 自己超时（连接超时 / 渲染器卡死）：Call 里已经把 session 丢掉了，
            // 所以下一条命令会重连，不会带着残骸去撞 Session not found。
            // 给模型的话里不回「CDP 命令超时（Page.navigate，…）」这种内部措辞。
            if (!IsCdpTimeoutMessage(ex.Message)) throw;
            // 不报 timeoutMs（超时可能发生在内部的 Page.enable 上，未必是导航那 20s）：
            // 报真实等到的秒数，两种现场都说得对。
            long seconds = Math.Max(1, sw.ElapsedMilliseconds / 1000);
            return NavFailureReceipt(sw, NavErrorMessage("连接超时（浏览器在 " + seconds + " 秒内没有回应）"));
        }
        string navError = CdpError(navReply);
        if (navError != null) return Fail("无法打开这个网址（" + ShortUrl(target, NavUrlInMessageMax) + "）：" + navError);
        int ready = WaitForReady(target, timeoutMs);
        // 落在浏览器的错误页 = 这一页没有打开。不能报 ok:true：错误页也是「加载完成」的
        // 普通页面，模型拿到 ok 会接着 observe / click 去操作「你似乎未连接到 Internet」。
        if (ready == ReadyErrorPage) return NavFailure(sw);
        return NavResult(sw, ready == ReadyOk ? null : "页面在 " + timeoutMs + "ms 内没有加载完成，"
            + "可能还在渲染。可以先 sandbox_wait 一下，或 sandbox_observe 看看当前结构");
    }

    /**
     * 导航落在错误页时的回执：**ok:false + 人话**，但 url / title / ms 照留——排查要看这些
     *（真机上 title 甚至还是主机名，那正是「假成功」的来源）。
     *
     * 不回 `chrome-error://chromewebdata/` 这种内部串：模型只会照着它去猜一个不存在的页面。
     */
    private string NavFailure(Stopwatch sw)
    {
        string href = SafeEvalString("location.href", 3000);
        string title = SafeEvalString("document.title", 3000);
        string dump;
        string code = WaitForErrorCode(out dump);
        LogErrorPageEvidence(code, dump);
        return new JObj().Bool("ok", false).Str("error", NavErrorMessage(code))
            .Str("url", href).Str("title", title).Num("ms", sw.ElapsedMilliseconds).ToString();
    }

    /** 同一形状的失败回执，但不去读页面（超时后页面多半也读不到，再读就是又一轮卡死） */
    private string NavFailureReceipt(Stopwatch sw, string error)
    {
        return new JObj().Bool("ok", false).Str("error", error).Num("ms", sw.ElapsedMilliseconds).ToString();
    }

    /**
     * 错误页正文里的原因码，带一个**很短的等待窗口**。
     *
     * 为什么不能一判出错误页就直接读：`chrome-error://` 一出现就判失败（那一步很早就完成了），
     * 而那一刻错误页的 DOM 往往还没渲染好，正文是空的——真机 2026-10-25 的回执就是
     * 「页面加载失败（没有拿到内容）」，而正文其实稍后就有 ERR_NAME_NOT_RESOLVED。
     * 为什么要设上限：错误页的 DOM 是本地资源，正常一两帧（<300ms）就好；等超过 2s 说明
     * 这一页根本不会渲染正文，再等就是把「省下的 20 秒」还回去了。
     *
     * `lastDump` 交回最后一次读到的内容（包含了每路来源的长度），供诊断日志用。
     */
    private string WaitForErrorCode(out string lastDump)
    {
        lastDump = "";
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ErrorCodeWaitMs);
        while (true)
        {
            lastDump = ReadErrorPageDump();
            string code = NavErrorCode(lastDump);
            if (code != null) return code;
            if (DateTime.UtcNow >= deadline) return null;
            Thread.Sleep(ErrorCodePollMs);
        }
    }

    /**
     * 真的机上错误页取到的证据，单独一行日志（**只走错误页路径**，不吵）。
     *
     * 为什么要它：真机第一次修这里时「页面明明在（status 里能看到 chrome-error://），
     * 正文却一个字也读不到」，靠猜改了两轮。这行日志把「取不到」与「取到了但没码」分开：
     * 每路来源的字符数都在 dump 开头（`[body.innerText=0] [html.outerHTML=18302] …`）。
     */
    private void LogErrorPageEvidence(string code, string dump)
    {
        string head = dump == null ? "" : dump.Replace("\r", " ").Replace("\n", " ");
        if (head.Length > ErrorPageLogChars) head = head.Substring(0, ErrorPageLogChars);
        Program.Log("错误页诊断：会话 " + Key + "，抓到码=" + (code == null ? "(无)" : code)
            + "，取到的内容（前 " + ErrorPageLogChars + " 字）：" + (head.Length == 0 ? "(空)" : head));
    }

    /** 错误页正文的取法自测用：不让它悄悄退化成只读 body.innerText */
    internal static string ErrorPageDumpScriptForTest
    {
        get { return ErrorPageDumpJs; }
    }

    /**
     * 错误页的取正文脚本：**多路都取**，不等只取一个地方。
     *
     * 2026-10-25 真机：错误页确实在（status 里看到 chrome-error://chromewebdata/、title 是主机名），
     * 但 `document.body.innerText` 一个字也没读到，于是 ERR_NAME_NOT_RESOLVED 白白丢了。
     * Chromium 的错误页 UI 不必落在 body 的普通文本里（自定义元素 / 隐藏到渲染后才可见 / 只存于源码），
     * 所以这里把能拿到的都拿上，任一处有码即可：innerText → textContent →#main-message
     * → 打开 shadow root 的正文 → 整页 outerHTML。
     *
     * 每路开头先写一个 `[来源=字符数]`：真机日志里能一眼看出是「空」还是「有文本但没码」。
     * 总长封顶 60000（头尾各留一段，错误文案不会被截掉）。
     */
    private const string ErrorPageDumpJs = @"
(function(){
  var parts=[];
  function add(label,text){
    var s=text||'';
    parts.push('['+label+'='+s.length+']');
    if(s.length>0) parts.push(s);
  }
  var body=document.body, root=document.documentElement;
  try{ add('body.innerText', body?body.innerText:''); }catch(e){}
  try{ add('body.textContent', body?body.textContent:''); }catch(e){}
  try{ add('html.innerText', root?root.innerText:''); }catch(e){}
  try{ var m=document.getElementById('main-message'); add('main-message', m?m.innerText:''); }catch(e){}
  var shadow='';
  try{
    var all=document.querySelectorAll('*'), n=all.length>500?500:all.length;
    for(var i=0;i<n;i++){
      var sr=all[i].shadowRoot;
      if(!sr) continue;
      try{ var t=sr.textContent; if(t) shadow+=t+' '; }catch(e2){}
    }
  }catch(e){}
  add('shadow', shadow);
  try{ add('html.outerHTML', root?root.outerHTML:''); }catch(e){}
  var out=parts.join(' ');
  if(out.length>60000) out=out.substring(0,58000)+' '+out.substring(out.length-2000);
  return out;
})()";

    /** 读错误页的全部可用取径（已截断）：原因码只关心那一串字，不关心排版 */
    private string ReadErrorPageDump()
    {
        try
        {
            return EvalString(ErrorPageDumpJs, 4000);
        }
        catch
        {
            // 错误页也可能在换上下文的一瞬间不响应：这轮拿不到就交给下一轮（窗口内会重试），
            // 不要把「这是错误页」这个判定一起丢掉。
            return "";
        }
    }

    private string SafeEvalString(string expression, int timeoutMs)
    {
        try { return EvalString(expression, timeoutMs); }
        catch { return ""; }
    }

    private string NavResult(Stopwatch sw, string warning)
    {
        string href = EvalString("location.href", 8000);
        string title = EvalString("document.title", 8000);
        JObj o = new JObj().Bool("ok", true).Str("url", href).Str("title", title).Num("ms", sw.ElapsedMilliseconds);
        if (warning != null) o.Str("warning", warning);
        return o.ToString();
    }

    /** 裸域名补协议（与 browser_navigate 的语义一致：裸域名按 https） */
    private string NormalizeUrl(string url)
    {
        string lower = url.ToLowerInvariant();
        if (lower.StartsWith("http://") || lower.StartsWith("https://") || lower.StartsWith("file:")
            || lower.StartsWith("about:") || lower.StartsWith("data:") || lower.StartsWith("chrome:"))
            return url;
        return "https://" + url;
    }

    /** WaitForReady 的三个结果（C# 5 禁枚举，用常量） */
    internal const int ReadyOk = 0;
    private const int ReadyTimeout = 1;
    private const int ReadyErrorPage = 2;

    /**
     * 等 page readyState === 'complete' 且 URL 对上（expected == null 就只看 readyState）。
     *
     * 为什么不用 Page.loadEventFired：事件没有 id，要和普通回执混在一条 socket 上抢读；
     * 而「加载完了」本来就有一个可轮询的真值（readyState）。轮询多几条 CDP 消息，换来的是
     * 不会因为一次事件迟到 / 丢失把整条命令判死。
     *
     * 落成错误页时**立刻**返回 ReadyErrorPage，不空转到 timeoutMs：错误页是导航失败的那一刻
     * 就出现的（2026-10-25 真机：离线时每条导航白等满 20 秒才回）。它是「已经失败」，不是
     * 「还没到」——再等下去，这个页面也不会变成用户要的那一页。
     *
     * 正文只在「complete 但 URL 对不上」时读，且同一个 href 只读一次（重定向到别的路径的
     * 慢站点不该每 300ms 读一遍整页正文）。
     */
    private int WaitForReady(string expected, int timeoutMs)
    {
        Thread.Sleep(300); // 让 navigate 真正开始（否则第一轮读到的还是旧页面的 complete）
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        string checkedHref = null;
        while (DateTime.UtcNow < deadline)
        {
            // 错误页的判定**不挂在 readyState 上**：chrome-error:// 一旦出现就说明导航已经失败了，
            // 不必先相信「这个 Chromium 会在哪个时刻把错误页报成 complete」（我们只有真机回执，
            // 回执里只有「URL 一直对不上」，没有 readyState 的时间线）。
            string href = expected == null ? null : SafeEvalString("location.href", 3000);
            if (href != null && IsNavErrorPage(href, null)) return ReadyErrorPage;
            bool complete;
            try { complete = EvalString("document.readyState", 5000) == "complete"; }
            catch { complete = false; }
            if (complete)
            {
                if (expected == null) return ReadyOk;
                if (UrlMatches(expected, href)) return ReadyOk;
                // 正文兜底：Chromium 版本 / 证书拦截页的 scheme 不一定是 chrome-error
                if (href != checkedHref)
                {
                    checkedHref = href;
                    if (IsNavErrorPage(null, ReadErrorPageDump())) return ReadyErrorPage;
                }
            }
            Thread.Sleep(300);
        }
        return ReadyTimeout;
    }

    // ── 浏览器错误页的判定（纯函数：自测在宿主上直接验，不碰 Edge）──────────────────

    /**
     * 导航是不是落在了 Chromium 的「打不开」错误页上。
     *
     * 为什么错误页必须算**失败**：错误页本身也是一个加载完成的普通页面——readyState 是
     * complete、`document.title` 还是主机名，于是旧行为只会在「URL 对不上」里空转到超时，
     * 再回 ok:true + 「可能还在渲染」。对模型是假成功：它会接着 sandbox_observe / sandbox_click
     * 去操作一个正文写着「你似乎未连接到 Internet」的页面（2026-10-25 真机，三个站点全这样）。
     *
     * 两个信号，都只认「这确实是错误页」，不认「看起来奇怪」：
     *   ① 地址是 chrome-error:// —— 这个 scheme 只有 Chromium 的错误页在用，几乎不可能误判；
     *   ② 正文里有 ERR_* 原因码 —— 只在「URL 对不上」时才看，所以停在旧页面上等新页面的
     *      那几百毫秒不会把旧正文当成本次导航的结果。
     */
    internal static bool IsNavErrorPage(string url, string bodyText)
    {
        if (url != null && url.Trim().ToLowerInvariant().StartsWith("chrome-error://", StringComparison.Ordinal))
            return true;
        return NavErrorCode(bodyText) != null;
    }

    /**
     * 从错误页正文里抠原因码（`ERR_INTERNET_DISCONNECTED` 这种），没有就回 null。**纯函数**。
     *
     * 边界：码必须由一个不属于 [A-Z0-9_] 的字符开头（`NETERR_FOO` 不算 `ERR_FOO`）；
     * 后面必须真跟着码字符（正文里孤零零一个 `ERR_` 不算一个码）。
     */
    internal static string NavErrorCode(string bodyText)
    {
        if (bodyText == null) return null;
        const string prefix = "ERR_";
        int from = 0;
        while (true)
        {
            int at = bodyText.IndexOf(prefix, from, StringComparison.Ordinal);
            if (at < 0) return null;
            from = at + 1;
            if (at > 0 && IsErrorCodeChar(bodyText[at - 1])) continue;
            int end = at + prefix.Length;
            while (end < bodyText.Length && IsErrorCodeChar(bodyText[end])) end++;
            if (end > at + prefix.Length) return bodyText.Substring(at, end - at);
        }
    }

    private static bool IsErrorCodeChar(char c)
    {
        return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
    }

    /**
     * 导航失败给模型看的人话：原因 + 怎么确认 + 还能做什么。
     *
     * `reason` 要么是错误页的原因码（ERR_INTERNET_DISCONNECTED），要么是一句人说的原因
     *（「连接超时（浏览器在 20 秒内没有回应）」）——两种都是「页面没有加载」的后半句。
     *
     * 不写「设置 › … › 允许沙箱出网」：这个开关现在不存在（.wsb 固定 `<Networking>Default`），
     * 指一条不存在的路比不指更坏。拿不到原因时不编一个，就说没有拿到内容。
     */
    internal static string NavErrorMessage(string reason)
    {
        string head = reason == null || reason.Length == 0
            ? "页面加载失败（没有拿到内容）"
            : "页面没有加载：" + reason;
        return head + "（沙箱可能没有出网、宿主机没联网，或这个地址不可达）。"
            + "确认方式：换一个一定能打开的地址试一次；如果所有站点都是这个错，那是网络的问题，不是这一页的问题。"
            + "仍要操作当前界面时改用 computer_screenshot / computer_click 像素工具。";
    }

    /**
     * 错误文案里回显 URL 的截断（80 字符 + `…`）。
     * 真机现场：一条 data: URL 的失败把「无法打开这个网址（…）：…」撑成一屏，
     * 真正有用的后半句（错误原因）被挤到看不见。**纯函数**。
     */
    internal static string ShortUrl(string url, int max)
    {
        if (url == null) return "";
        string v = url.Trim();
        if (max <= 0 || v.Length <= max) return v;
        return v.Substring(0, max) + "…";
    }

    /**
     * 底部异常是不是 CDP 自己的超时（连接 / 发送 / 等回执），而不是页面或 bridge 的错误。
     * 是的话导航把它翻成一句人话（「连接超时」），不再把 `CDP 命令超时（Page.navigate，…）`
     * 这种内部措辞甩给模型。**纯函数**。
     */
    internal static bool IsCdpTimeoutMessage(string message)
    {
        if (message == null) return false;
        return message.IndexOf("CDP ", StringComparison.Ordinal) >= 0
            && message.IndexOf("超时", StringComparison.Ordinal) >= 0;
    }

    private bool UrlMatches(string expected, string actual)
    {
        if (actual == null) return false;
        string a = TrimSlash(expected);
        string b = TrimSlash(actual);
        if (a == b) return true;
        // data: URL 很长，页面可能把空格 / 引号规范化过；比前 64 字符足够判定「到了同一页」
        if (a.Length > 64 || b.Length > 64)
            return a.Substring(0, Math.Min(64, a.Length)) == b.Substring(0, Math.Min(64, b.Length));
        return false;
    }

    private string TrimSlash(string value)
    {
        string v = value.Trim();
        while (v.Length > 0 && v[v.Length - 1] == '/') v = v.Substring(0, v.Length - 1);
        return v;
    }

    // ── cdp-observe ──────────────────────────────────────────────────────────────

    /**
     * 页面结构：正文文本 + 可交互元素清单（每行带一个可直接回传的选择器与中心坐标）。
     *
     * 返回值的编码：JS 返回一个用控制字符分节的字符串（\u0003 分节、\u0001 分元素行、
     * \u0002 分字段），桥再把它拼成合法 JSON。
     * 桥再把它拼成合法 JSON。为什么不直接让 JS 返回 JSON：桥没有 JSON 库，嵌套的
     * `\"value\":\"{\\\"a\\\"…}\"` 用 ExtractString 取不出来。平面编码 + 桥侧重拼最省事。
     */
    private string Observe(string raw)
    {
        int maxElements = ReadInt(raw, "maxElements", 120, 10, 400);
        string js = ObserveJs.Replace("__MAX__", maxElements.ToString());
        string payload = EvalString(js, 15000);
        if (payload.Length == 0) return Fail("页面没有返回可读内容（可能还在加载，或是一个空白页）");

        // 分节符 、元素行分隔 、字段分隔  —— 三个不同的控制字符，
        // 不能用同一个（元素块内部的行会与分节撞车）
        string[] sections = payload.Split((char)3);
        string url = sections.Length > 0 ? sections[0] : "";
        string title = sections.Length > 1 ? sections[1] : "";
        string text = sections.Length > 2 ? sections[2] : "";
        int totalText = text.Length;
        int parsedTotal;
        if (sections.Length > 3 && int.TryParse(sections[3], out parsedTotal)) totalText = parsedTotal;
        string block = sections.Length > 4 ? sections[4] : "";

        JObj o = new JObj().Bool("ok", true).Str("url", url).Str("title", title)
            .Str("text", text).Num("totalTextLength", totalText).Bool("truncated", totalText > text.Length);

        List<string> lines = new List<string>();
        if (block.Length > 0) lines.AddRange(block.Split((char)1));

        StringBuilder els = new StringBuilder("[");
        int count = 0;
        for (int i = 0; i < lines.Count; i++)
        {
            if (lines[i].Length == 0) continue;
            string[] f = lines[i].Split((char)2);
            if (f.Length < 7) continue;
            if (count > 0) els.Append(",");
            els.Append(new JObj().Str("selector", f[0]).Str("tag", f[1]).Str("text", f[2])
                .Num("x", ParseLong(f[3], 0)).Num("y", ParseLong(f[4], 0))
                .Str("role", f[5]).Bool("editable", f[6] == "1").ToString());
            count++;
        }
        els.Append("]");
        o.Raw("elements", els.ToString());
        o.Num("elementCount", count);
        return o.ToString();
    }

    /**
     * observe 的 JS。选择器只靠 id 与 nth-of-type 链（不拼属性选择器）：链从 body 往下
     * 逐级限定，天然唯一，也不用在 C# 里给属性值里的引号找转义。
     */
    private const string ObserveJs = @"
(function(){
  function cssEsc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; } catch(e){ return s; } }
  function sel(el){
    if(el.id) return '#'+cssEsc(el.id);
    var parts=[], cur=el, depth=0;
    while(cur && cur.nodeType===1 && cur!==document.body && depth<6){
      if(cur.id){ parts.unshift('#'+cssEsc(cur.id)); break; }
      var tag=cur.tagName.toLowerCase(), part=tag, par=cur.parentNode;
      if(par && par.children){
        var same=[];
        for(var i=0;i<par.children.length;i++){ if(par.children[i].tagName===cur.tagName) same.push(par.children[i]); }
        if(same.length>1) part += ':nth-of-type(' + (same.indexOf(cur)+1) + ')';
      }
      parts.unshift(part);
      cur=par; depth++;
    }
    return parts.join(' > ');
  }
  var nodes=document.querySelectorAll('a,button,input,select,textarea,summary,[role=""button""],[role=""link""],[contenteditable=""true""]');
  var lines=[];
  var MAX=__MAX__;
  for(var i=0;i<nodes.length && lines.length<MAX;i++){
    var el=nodes[i];
    var r=el.getBoundingClientRect();
    if(r.width<=0||r.height<=0) continue;
    var label=el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.innerText||el.value||'';
    label=String(label).replace(/\s+/g,' ');
    label=label.replace(/\u0001/g,' ').replace(/\u0002/g,' ').replace(/\u0003/g,' ').trim();
    if(label.length>80) label=label.slice(0,80);
    var role=el.getAttribute('role')||'';
    var ed=(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.getAttribute('contenteditable')==='true')?'1':'0';
    var t=el.tagName.toLowerCase();
    if(t==='input') t='input['+(el.getAttribute('type')||'text')+']';
    lines.push([sel(el),t,label,Math.round(r.left+r.width/2),Math.round(r.top+r.height/2),role,ed].join('\u0002'));
  }
  var txt=document.body?String(document.body.innerText||''):'';
  return [location.href,document.title,txt.slice(0,20000),String(txt.length),lines.join('\u0001')].join('\u0003');
})()";

    // ── cdp-click ────────────────────────────────────────────────────────────────

    private string Click(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        if (selector == null || selector.Trim().Length == 0)
            return Fail("cdp-click 需要 selector 字段（用 cdp-observe 拿可用的选择器）");
        string point = ResolvePoint(selector);
        if (point == null)
            return Fail("选择器「" + selector + "」在页面上没有匹配到可见元素。"
                + "重新 sandbox_observe 看当前页面结构，用它给的 selector；页面导航后旧选择器可能已失效");
        string[] parts = point.Split((char)2);
        int x = (int)ParseLong(parts[0], 0);
        int y = (int)ParseLong(parts[1], 0);
        DispatchClick(x, y);
        Thread.Sleep(250);
        string href = EvalString("location.href", 5000);
        string title = EvalString("document.title", 5000);
        return new JObj().Bool("ok", true).Num("x", x).Num("y", y)
            .Str("tag", parts.Length > 2 ? parts[2] : "").Str("text", parts.Length > 3 ? parts[3] : "")
            .Str("url", href).Str("title", title).ToString();
    }

    /** 滚动到元素可见并回它的中心点 / 标签 / 文本；没匹配到回 null��JS 侧分开返回（避免多一次往返） */
    private string ResolvePoint(string selector)
    {
        string js = "(function(){var el=document.querySelector(" + Program.JsonQuote(selector) + ");"
            + "if(!el) return 'NOTFOUND';"
            + "try{el.scrollIntoView({block:'center',inline:'center'});}catch(e){el.scrollIntoView();}"
            + "var r=el.getBoundingClientRect();"
            + "if(r.width<=0||r.height<=0) return 'NOTFOUND';"
            + "var label=String(el.innerText||el.value||'').replace(/\\s+/g,' ').slice(0,80);"
            + "return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2),el.tagName.toLowerCase(),label].join('\\u0002');})()";
        string result = EvalString(js, 8000);
        if (result == "NOTFOUND" || result.Length == 0) return null;
        return result;
    }

    private void DispatchClick(int x, int y)
    {
        Call("Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\",\"x\":" + x + ",\"y\":" + y + "}", 5000);
        string press = "{\"type\":\"mousePressed\",\"x\":" + x + ",\"y\":" + y + ",\"button\":\"left\",\"clickCount\":1}";
        string release = "{\"type\":\"mouseReleased\",\"x\":" + x + ",\"y\":" + y + ",\"button\":\"left\",\"clickCount\":1}";
        Call("Input.dispatchMouseEvent", press, 5000);
        Call("Input.dispatchMouseEvent", release, 5000);
    }

    // ── cdp-type ─────────────────────────────────────────────────────────────────

    private string TypeText(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        string text = Program.ExtractJsonString(raw, "text");
        if (selector == null || selector.Trim().Length == 0) return Fail("cdp-type 需要 selector 字段");
        if (text == null) return Fail("cdp-type 需要 text 字段（字符串）");
        bool submit = Program.ExtractBool(raw, "submit");
        // clear 缺省 true：模型多半想「把这个框填成 X」，追加会让它把旧值也提交上去
        bool clear = raw.IndexOf("\"clear\":false", StringComparison.Ordinal) < 0;

        string focusJs = "(function(){var el=document.querySelector(" + Program.JsonQuote(selector) + ");"
            + "if(!el) return 'NOTFOUND'; el.focus();"
            + (clear
                ? "if('value' in el){el.value='';} else if(el.isContentEditable){el.textContent='';}"
                : "")
            + "return 'OK';})()";
        string focused = EvalString(focusJs, 8000);
        if (focused == "NOTFOUND" || focused.Length == 0)
            return Fail("选择器「" + selector + "」在页面上没有匹配到输入框。"
                + "先 sandbox_observe 确认哪个元素可以输入（它会在输入控件上标 editable）");

        Call("Input.insertText", "{\"text\":" + Program.JsonQuote(text) + "}", 8000);
        bool submitted = false;
        if (submit)
        {
            DispatchEnter();
            submitted = true;
            Thread.Sleep(250);
        }
        Thread.Sleep(120);

        string readJs = "(function(){var el=document.querySelector(" + Program.JsonQuote(selector) + ");"
            + "if(!el) return ''; return (el.value !== undefined && el.value !== null) ? String(el.value) : String(el.innerText||'');})()";
        string value = EvalString(readJs, 5000);
        if (value.Length > 200) value = value.Substring(0, 200);
        return new JObj().Bool("ok", true).Str("value", value).Bool("submitted", submitted).ToString();
    }

    private void DispatchEnter()
    {
        Call("Input.dispatchKeyEvent",
            "{\"type\":\"keyDown\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13,\"nativeVirtualKeyCode\":13,\"text\":\"\\r\"}",
            5000);
        Call("Input.dispatchKeyEvent",
            "{\"type\":\"keyUp\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13,\"nativeVirtualKeyCode\":13}",
            5000);
    }

    // ── cdp-extract ──────────────────────────────────────────────────────────────

    private string ExtractText(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        string js;
        if (selector != null && selector.Trim().Length > 0)
        {
            js = "(function(){var el=document.querySelector(" + Program.JsonQuote(selector) + ");"
                + "return el?String(el.innerText||el.textContent||''):'';})()";
        }
        else
        {
            js = "(function(){return document.body?String(document.body.innerText||''):'';})()";
        }
        string text = EvalString(js, 15000);
        int total = text.Length;
        bool truncated = total > TextLimit;
        if (truncated) text = text.Substring(0, TextLimit);
        if (selector != null && selector.Trim().Length > 0 && total == 0)
        {
            return new JObj().Bool("ok", true).Str("text", "")
                .Num("totalLength", 0).Bool("truncated", false)
                .Str("warning", "选择器「" + selector + "」没有匹配到元素，或它没有文本").ToString();
        }
        return new JObj().Bool("ok", true).Str("text", text)
            .Num("totalLength", total).Bool("truncated", truncated).ToString();
    }

    // ── cdp-wait ─────────────────────────────────────────────────────────────────

    private string WaitFor(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        string msText = Program.ExtractNumber(raw, "ms");
        int timeoutMs = ReadInt(raw, "timeoutMs", 8000, 250, 15000);
        Stopwatch sw = Stopwatch.StartNew();

        if (selector != null && selector.Trim().Length > 0)
        {
            string js = "(function(){return !!document.querySelector(" + Program.JsonQuote(selector) + ");})()";
            bool appeared = false;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                try { appeared = EvalBool(js, 4000); }
                catch { appeared = false; }
                if (appeared) break;
                Thread.Sleep(250);
            }
            return new JObj().Bool("ok", true).Bool("appeared", appeared)
                .Num("waitedMs", sw.ElapsedMilliseconds).Str("selector", selector).ToString();
        }

        if (msText != null)
        {
            long ms;
            if (!long.TryParse(msText, out ms) || ms < 0) return Fail("ms 必须是非负整数");
            if (ms > 10000) ms = 10000; // 再长就把宿主的 45s 命令线吃掉了：宁可让模型重试
            Thread.Sleep((int)ms);
            return new JObj().Bool("ok", true).Bool("appeared", true)
                .Num("waitedMs", sw.ElapsedMilliseconds).ToString();
        }

        return Fail("cdp-wait 需要 selector 或 ms 其中一个");
    }

    // ── cdp-shot ─────────────────────────────────────────────────────────────────

    private string Shot(string raw, string baseName, string cmdDir)
    {
        int maxWidth = ReadInt(raw, "maxWidth", ShotMaxWidth, 320, 4096);
        string reply = Call("Page.captureScreenshot", "{\"format\":\"jpeg\",\"quality\":70}", 25000);
        string b64 = Program.ExtractJsonString(reply, "data");
        if (b64 == null || b64.Length < 1000)
            return Fail("页面截图失败：回执里没有图像数据（页面可能还在合成中，稍等再试一次）");

        byte[] jpeg = Convert.FromBase64String(b64);
        int width, height;
        Bitmap bmp = new Bitmap(new MemoryStream(jpeg));
        try
        {
            width = bmp.Width;
            height = bmp.Height;
            int longEdge = Math.Max(width, height);
            if (longEdge > maxWidth)
            {
                double scale = (double)maxWidth / longEdge;
                int outW = Math.Max(1, (int)Math.Round(width * scale));
                int outH = Math.Max(1, (int)Math.Round(height * scale));
                Bitmap scaled = new Bitmap(outW, outH);
                try
                {
                    Graphics g = Graphics.FromImage(scaled);
                    try
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(bmp, new Rectangle(0, 0, outW, outH),
                            new Rectangle(0, 0, width, height), GraphicsUnit.Pixel);
                    }
                    finally { g.Dispose(); }
                    jpeg = Program.EncodeJpeg(scaled, 80);
                    width = outW;
                    height = outH;
                }
                finally { scaled.Dispose(); }
            }
        }
        finally
        {
            bmp.Dispose();
        }

        string jpgName = baseName + ".jpg";
        Program.AtomicWrite(Path.Combine(cmdDir, jpgName), jpeg);

        int viewW = (int)ParseLong(EvalString("String(window.innerWidth)", 5000), width);
        int viewH = (int)ParseLong(EvalString("String(window.innerHeight)", 5000), height);
        Program.Log("CDP 截图完成：" + width + "x" + height + "，" + jpeg.Length + " 字节");
        return new JObj().Bool("ok", true).Str("jpeg", jpgName).Num("width", width).Num("height", height)
            .Num("nativeWidth", viewW).Num("nativeHeight", viewH)
            .Str("url", EvalString("location.href", 5000)).Str("title", EvalString("document.title", 5000))
            .ToString();
    }

    // ── cdp-upload ───────────────────────────────────────────────────────────────

    private string Upload(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        string path = Program.ExtractJsonString(raw, "path");
        if (selector == null || selector.Trim().Length == 0) return Fail("cdp-upload 需要 selector 字段");
        if (path == null || path.Trim().Length == 0) return Fail("cdp-upload 需要 path 字段（guest 绝对路径）");
        // 白名单：只认映射目录的上传子目录。DOM.setFileInputFiles 能读 guest 任意文件，
        // 不设边界的话一份被篡改的 req 就能把沙箱里读得到的东西塞进页面。
        if (!path.StartsWith(UploadRoot + "\\", StringComparison.OrdinalIgnoreCase))
            return Fail("这个文件不在允许上传的目录里：只接受 " + UploadRoot + " 下的文件（宿主会先把文件拷到这里）");
        if (!File.Exists(path)) return Fail("沙箱里看不到这个文件：" + path + "（映射目录可能还没同步完，稍等重试）");

        string doc = Call("DOM.getDocument", "{\"depth\":1}", 10000);
        string rootText = Program.ExtractNumber(doc, "nodeId");
        long rootNode = ParseLong(rootText, 0);
        if (rootNode <= 0) return Fail("取页面根节点失败（DOM.getDocument 没有回 nodeId）");
        string query = Call("DOM.querySelector",
            "{\"nodeId\":" + rootNode + ",\"selector\":" + Program.JsonQuote(selector) + "}", 8000);
        long inputNode = ParseLong(Program.ExtractNumber(query, "nodeId"), 0);
        if (inputNode <= 0)
            return Fail("选择器「" + selector + "」没有匹配到元素。先 sandbox_observe 找到文件输入框");

        string files = "[\"" + path.Replace("\\", "\\\\") + "\"]";
        string setReply = Call("DOM.setFileInputFiles",
            "{\"nodeId\":" + inputNode + ",\"files\":" + files + "}", 15000);
        string err = CdpError(setReply);
        if (err != null) return Fail("设置上传文件失败：" + err);

        JObj o = new JObj().Bool("ok", true).Str("path", path).Str("fileName", Path.GetFileName(path));
        return o.ToString();
    }

    // ── cdp-download ─────────────────────────────────────────────────────────────

    private string Download(string raw)
    {
        string selector = Program.ExtractJsonString(raw, "selector");
        string dir = Program.ExtractJsonString(raw, "dir");
        if (selector == null || selector.Trim().Length == 0) return Fail("cdp-download 需要 selector 字段");
        if (dir == null || dir.Trim().Length == 0) dir = DownloadRoot;
        if (!dir.StartsWith(@"C:\orbita-out\", StringComparison.OrdinalIgnoreCase))
            return Fail("下载目录必须是映射目录（C:\\orbita-out\\）之下，宿主才能拿到文件");
        try { Directory.CreateDirectory(dir); }
        catch (Exception ex) { return Fail("建下载目录失败：" + ex.Message); }

        // 不设这个就是 bug：默认会弹「另存为」对话框，headed 下等于把命令卡死
        string setReply = CallBrowser("Browser.setDownloadBehavior",
            "{\"behavior\":\"allow\",\"downloadPath\":" + Program.JsonQuote(dir) + ",\"eventsEnabled\":true}",
            8000);
        string setErr = CdpError(setReply);
        if (setErr != null) return Fail("设置下载行为失败：" + setErr);

        string point = ResolvePoint(selector);
        if (point == null) return Fail("选择器「" + selector + "」没有匹配到可点击的下载链接");
        string[] parts = point.Split((char)2);
        DispatchClick((int)ParseLong(parts[0], 0), (int)ParseLong(parts[1], 0));

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(20000);
        List<string> landed = new List<string>();
        while (DateTime.UtcNow < deadline)
        {
            landed.Clear();
            try
            {
                string[] files = Directory.GetFiles(dir);
                for (int i = 0; i < files.Length; i++)
                {
                    string name = Path.GetFileName(files[i]);
                    if (name.EndsWith(".crdownload", StringComparison.OrdinalIgnoreCase)) continue;
                    if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
                    landed.Add(name);
                }
            }
            catch
            {
                // 目录同步抖动，下一轮再看
            }
            if (landed.Count > 0) break;
            Thread.Sleep(300);
        }

        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < landed.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append(Program.JsonQuote(landed[i]));
        }
        sb.Append("]");
        bool ok = landed.Count > 0;
        JObj o = new JObj().Bool("ok", ok).Str("dir", dir).Raw("files", sb.ToString());
        if (!ok) o.Str("error", "20 秒内没有文件落到下载目录。链接可能不是下载（而是打开了新页面），"
            + "或者页面还在准备文件——先 sandbox_observe 看看页面状态再重试");
        return o.ToString();
    }

    // ── cdp-tabs ─────────────────────────────────────────────────────────────────

    private string Tabs(string raw)
    {
        string op = Program.ExtractString(raw, "op");
        if (op == null || op.Length == 0) op = "list";
        // 先校验 op 再碰 CDP：否则一个写错的 op 会把 Edge 拉起来（且报错说的是别的事）
        if (op != "list" && op != "switch")
            return Fail("cdp-tabs 的 op 只能是 list 或 switch，收到：" + op);
        List<TargetInfo> pages = PageTargets();

        if (op == "switch")
        {
            int index = ReadInt(raw, "index", 0, 0, 100);
            if (index >= pages.Count)
                return Fail("没有第 " + index + " 个标签页（当前一共 " + pages.Count + " 个）");
            CloseSocket();
            _sessionId = "";
            ConnectAndAttach();
            Attach(pages[index].Id);
            pages = PageTargets();
        }

        return new JObj().Bool("ok", true).Raw("tabs", TabsJson(pages))
            .Num("active", ActiveIndex(pages)).Num("count", pages.Count).ToString();
    }

    // ── 通用小工具 ───────────────────────────────────────────────────────────────

    private int ReadInt(string raw, string field, int fallback, int min, int max)
    {
        string text = Program.ExtractNumber(raw, field);
        int value;
        if (text == null || !int.TryParse(text, out value)) return fallback;
        if (value < min) value = min;
        if (value > max) value = max;
        return value;
    }

    private long ParseLong(string text, long fallback)
    {
        long value;
        if (text == null || !long.TryParse(text, out value)) return fallback;
        return value;
    }

    private string Fail(string message)
    {
        return new JObj().Bool("ok", false).Str("error", message).ToString();
    }
}

/** 极简 JSON 对象构造器：只为了不用手数逗号（手拼 `,,` 是 cupprobe 踩过的坑） */
internal sealed class JObj
{
    private readonly StringBuilder _sb = new StringBuilder("{");
    private bool _first = true;

    private void Next(string key)
    {
        if (!_first) _sb.Append(",");
        _first = false;
        _sb.Append(Program.JsonQuote(key)).Append(":");
    }

    public JObj Str(string key, string value)
    {
        Next(key);
        _sb.Append(Program.JsonQuote(value == null ? "" : value));
        return this;
    }

    public JObj Num(string key, long value)
    {
        Next(key);
        _sb.Append(value);
        return this;
    }

    public JObj Bool(string key, bool value)
    {
        Next(key);
        _sb.Append(value ? "true" : "false");
        return this;
    }

    /** 已经序列化好的 JSON 片段（数组 / 嵌套对象） */
    public JObj Raw(string key, string json)
    {
        Next(key);
        _sb.Append(json == null ? "null" : json);
        return this;
    }

    public override string ToString()
    {
        return _sb.ToString() + "}";
    }
}

/**
 * CDP 侧的两个纯函数与常量（0.7.0 起不再是「会话注册表」）。
 *
 * 0.6.0 之前这里是一张会话表：按 session 路由、执行 4 个实例的上限、空闲回收。
 * 0.7.0 把执行搬进了**每会话一个 worker 子进程**（WorkerHost.cs）之后，那张表就由
 * 「哪个 worker 进程」本身表达了——资源上限也在主桥（谁负责拉 worker，谁计数）。
 * 留在这里的只有：命令名白名单（主桥据此判「未知的 CDP 命令」）、会话 id 安全化
 * （**与宿主 shared/computer-use.ts 的 safeBrowserSessionId 逐字一致**）、上限那句话
 * （模型看得见的文案，自测断言它）、以及删 profile 目录。
 */
internal static class CdpSessions
{
    /** 与 shared/computer-use.ts 的 COMPUTER_USE_BROWSER_MAX 同值（桥是执行者，宿主只是转述） */
    internal const int MaxBrowsers = 4;

    /** 与 shared/computer-use.ts 的 COMPUTER_USE_BROWSER_IDLE_MS 同值 */
    internal const int IdleReapMs = 5 * 60 * 1000;

    /** 与 COMPUTER_USE_DEFAULT_BROWSER_SESSION 同值 */
    private const string DefaultKey = "default";

    /** 会话 id 进目录名之前截断到这么长（Windows 路径长度 + 可读性的折中） */
    private const int MaxKeyLength = 48;

    internal static bool IsKnown(string command)
    {
        return command == "cdp-start" || command == "cdp-stop" || command == "cdp-status"
            || command == "cdp-nav" || command == "cdp-observe" || command == "cdp-click"
            || command == "cdp-type" || command == "cdp-extract" || command == "cdp-wait"
            || command == "cdp-shot" || command == "cdp-upload" || command == "cdp-download"
            || command == "cdp-tabs";
    }

    /**
     * 上限文案。**自测断言它**提到 cdp-stop 与「最多 4 个」——模型只有这句话能照着做：
     * 它看不见 UI，也不知道还有几个实例、该停哪一个。宿主 cdp.ts 里有一份同义的中文
     * （computerUseBrowserErrors.tooMany），两边都在模型看得见的路径上。
     */
    internal static string TooManyMessage()
    {
        return "沙箱里同时最多 " + MaxBrowsers + " 个浏览器，先 cdp-stop 一个再开新的（不用的实例在空闲 "
            + (IdleReapMs / 60000) + " 分钟后自动回收）";
    }

    /** 会话键 → profile 目录（两边同一个规则：C:\orbita-browser\sessions\<键>） */
    internal static string ProfileDir(string key)
    {
        return System.IO.Path.Combine(@"C:\orbita-browser\sessions", key);
    }

    /**
     * 删掉一个会话的 profile 目录（显式 stop / 空闲回收）。**删不掉只记日志**：
     * Edge 刚被杀时文件句柄可能还没全放开，删不动是常态；残留目录不占名额，
     * 下次同会话启动时会被自己复用。
     */
    internal static void DeleteProfile(string key)
    {
        string dir = ProfileDir(key);
        try
        {
            if (System.IO.Directory.Exists(dir)) System.IO.Directory.Delete(dir, true);
        }
        catch (Exception ex)
        {
            Program.Log("删除 profile 目录失败（" + dir + "）：" + ex.Message);
        }
    }

    /**
     * 安全化（与 shared/computer-use.ts 的 safeBrowserSessionId **逐字一致**）：
     * 只允许 `[A-Za-z0-9_-]`，其余换 `_`，最长 48；空 / 缺省回落 `default`。
     *
     * 为什么必须有这一关：键会拼进 `C:\orbita-browser\sessions\<键>`——带 `..` 或 `\`
     * 的会话 id 能把 profile 目录指到 guest 的任意位置（那目录里全是可执行配置）。
     * 同时它也是「两个宿主会话不会在桥侧撞成同一个浏览器」的保证，以及 worker 目录名
     * （`out\worker\<键>`）与命令文件名前缀的来源。
     */
    internal static string SafeSessionId(string raw)
    {
        if (raw == null || raw.Length == 0) return DefaultKey;
        StringBuilder sb = new StringBuilder(MaxKeyLength);
        for (int i = 0; i < raw.Length && sb.Length < MaxKeyLength; i++)
        {
            char c = raw[i];
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                || c == '_' || c == '-';
            sb.Append(ok ? c : '_');
        }
        return sb.Length == 0 ? DefaultKey : sb.ToString();
    }
}
