// Orbita guest bridge —— 沙箱内 Edge 的 CDP 通道（桥版本 0.4.0 新增）。
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

internal static class CdpSession
{
    // ── 沙箱内的固定路径（与 shared/computer-use.ts 的常量严格一致）────────────────
    private const string EdgePathX86 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    private const string EdgePathX64 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
    private const string ProfileDir = @"C:\orbita-browser\profile";
    private const string UploadRoot = @"C:\orbita-out\upload";
    private const string DownloadRoot = @"C:\orbita-out\downloads";

    /** 起 Edge 到 CDP 可用的上限。真机实测 2555ms 就绪；给冷启动 / 首启解压留余量 */
    private const int LaunchTimeoutMs = 25000;
    /** 单条 CDP 消息的默认等待 */
    private const int DefaultTimeoutMs = 10000;
    /** 导航默认等待（页内资源多的站点要更久） */
    private const int NavTimeoutMs = 20000;
    /** 截图默认上限宽度（长边），与像素截图同值 */
    private const int ShotMaxWidth = 1280;
    /** extract / observe 正文单次上限（resp 是整读整写的文件，超了宿主吃不下） */
    private const int TextLimit = 20000;

    // ── 会话状态：只有一份（应用级一个沙箱，沙箱里一个浏览上下文）────────────────
    private static ClientWebSocket _ws;
    private static string _sessionId = "";
    private static string _targetId = "";
    private static int _port = 0;
    private static string _product = "";
    private static Process _edge;
    private static int _nextId = 0;
    private static bool _connecting = false;

    // ── 入口：命令循环把 cdp-* 分派到这里 ────────────────────────────────────────

    public static string Execute(string command, string raw, string baseName, string cmdDir)
    {
        try
        {
            if (command == "cdp-start") return Start(raw);
            if (command == "cdp-stop") return Stop();
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
    private static string Describe(string command, string message)
    {
        if (message != null && message.IndexOf("没有在运行", StringComparison.Ordinal) >= 0) return message;
        return "沙箱里的浏览器命令 " + command + " 失败：" + message;
    }

    // ── cdp-start ────────────────────────────────────────────────────────────────

    private static string Start(string raw)
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

    private static void Launch(bool headless, int port)
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
        Directory.CreateDirectory(ProfileDir);
        string args = BuildArgs(port, headless, false);
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
                + Path.Combine(ProfileDir, "DevToolsActivePort") + " 没出现）。"
                + "可以再试一次 sandbox_navigate；连续失败就改用 computer_screenshot / computer_click 像素工具");
        }
        string[] lines = content.Replace("\r", "").Split('\n');
        string portText = lines.Length > 0 ? lines[0].Trim() : "";
        int parsed;
        if (!int.TryParse(portText, out parsed) || parsed <= 0)
            throw new Exception("DevToolsActivePort 的首行不是端口号（读到「" + portText + "」）——这个 Edge 版本的端口文件格式不同");
        _port = parsed;
        Program.Log("CDP 端口 " + _port + "（来自 DevToolsActivePort）");
    }

    private static string BuildArgs(int port, bool headless, bool noSandbox)
    {
        StringBuilder a = new StringBuilder();
        a.Append("--remote-debugging-port=").Append(port).Append(" ");
        a.Append("--user-data-dir=\"").Append(ProfileDir).Append("\" ");
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

    private static string EdgePath()
    {
        if (File.Exists(EdgePathX86)) return EdgePathX86;
        if (File.Exists(EdgePathX64)) return EdgePathX64;
        return null;
    }

    private static bool PortFileReady()
    {
        try { return File.Exists(Path.Combine(ProfileDir, "DevToolsActivePort")); }
        catch { return false; }
    }

    /** 等 DevToolsActivePort 出现（true = 出现）。进程秒退时提前返回 false */
    private static bool WaitForPortFile(int timeoutMs)
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

    private static string ReadPortFile(int timeoutMs)
    {
        string path = Path.Combine(ProfileDir, "DevToolsActivePort");
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

    // ── cdp-stop：只停我们自己启动的那一个进程树 ─────────────────────────────────

    private static string Stop()
    {
        CloseSocket();
        _sessionId = "";
        _targetId = "";
        _product = "";
        _port = 0;
        KillOurEdge();
        return new JObj().Bool("ok", true).ToString();
    }

    /**
     * 只杀 `_edge` 记录下来的那一条进程树。
     *
     * **绝不按镜像名杀**（沙箱里可能还有用户自己开的 Edge，宿主上更是别人的应用）。
     * /T 是必须的：msedge.exe 只是父进程，renderer / gpu 都是子进程，单杀父进程会留孤儿。
     */
    private static void KillOurEdge()
    {
        Process edge = _edge;
        _edge = null;
        if (edge == null) return;
        int pid = 0;
        try { pid = edge.Id; } catch { pid = 0; }
        try { if (!edge.HasExited) edge.Kill(); } catch { }
        if (pid > 0) RunQuiet("taskkill.exe", "/PID " + pid + " /T /F");
    }

    private static void RunQuiet(string file, string args)
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

    private static void CloseSocket()
    {
        ClientWebSocket ws = _ws;
        _ws = null;
        if (ws == null) return;
        try { ws.Dispose(); } catch { }
    }

    private static bool IsAlive()
    {
        if (_edge == null || _edge.HasExited) return false;
        if (_ws != null && _ws.State == WebSocketState.Open) return true;
        // 进程在、socket 断了（Edge 自己重开过 target）：算活着，交给 EnsureConnection 重连
        return _port > 0;
    }

    // ── cdp-status ───────────────────────────────────────────────────────────────

    private static string Status()
    {
        if (!IsAlive())
        {
            return new JObj().Bool("ok", true).Bool("running", false).Num("port", _port)
                .Str("hint", "沙箱里的 Edge 没有在运行。sandbox_navigate 会自动把它拉起来；"
                    + "如果拉不起来，改用 computer_screenshot / computer_click 像素工具").ToString();
        }
        try
        {
            ConnectAndAttach();
            string href = EvalString("location.href", 5000);
            string title = EvalString("document.title", 5000);
            List<TargetInfo> pages = PageTargets();
            JObj o = new JObj().Bool("ok", true).Bool("running", true).Num("port", _port)
                .Str("product", _product).Str("url", href).Str("title", title)
                .Num("active", ActiveIndex(pages)).Raw("tabs", TabsJson(pages));
            return o.ToString();
        }
        catch (Exception ex)
        {
            return new JObj().Bool("ok", true).Bool("running", false).Num("port", _port)
                .Str("error", ex.Message).ToString();
        }
    }

    private static string OkWithStatus(bool alreadyRunning)
    {
        JObj o = new JObj().Bool("ok", true).Num("port", _port).Str("product", _product)
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

    private static void ConnectAndAttach()
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
            string version = HttpGet("http://127.0.0.1:" + _port + "/json/version", 5000);
            string wsUrl = Program.ExtractString(version, "webSocketDebuggerUrl");
            if (wsUrl == null || wsUrl.Length == 0)
                throw new Exception("Edge 的 /json/version 里没有 webSocketDebuggerUrl（端口 " + _port + " 可能被别的进程占了）");
            _product = Program.ExtractString(version, "Browser");
            CloseSocket();
            _ws = Connect(wsUrl, 5000);
            Program.Log("CDP 已连接：" + wsUrl + " product=" + _product);
            AttachPage();
        }
        finally
        {
            _connecting = false;
        }
    }

    /** 选一个 page target 并 attach（flatten）；没有就新建一个 */
    private static void AttachPage()
    {
        List<TargetInfo> pages = PageTargets();
        TargetInfo chosen = pages.Count > 0 ? pages[0] : null;
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

    private static void Attach(string targetId)
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

    private static List<TargetInfo> PageTargets()
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
    private static List<TargetInfo> ParseTargets(string reply)
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

    private static int ActiveIndex(List<TargetInfo> pages)
    {
        for (int i = 0; i < pages.Count; i++)
        {
            if (pages[i].Id == _targetId) return i;
        }
        return pages.Count > 0 ? 0 : -1;
    }

    private static string TabsJson(List<TargetInfo> pages)
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

    private static string Call(string method, string paramsJson, int timeoutMs)
    {
        return CallSession(_sessionId, method, paramsJson, timeoutMs);
    }

    private static string CallBrowser(string method, string paramsJson, int timeoutMs)
    {
        return CallSession(null, method, paramsJson, timeoutMs);
    }

    private static string CallSession(string sessionId, string method, string paramsJson, int timeoutMs)
    {
        if (!_connecting) ConnectAndAttach();
        if (_ws == null || _ws.State != WebSocketState.Open) throw new Exception("CDP 连接已断开");

        int id = ++_nextId;
        StringBuilder m = new StringBuilder();
        m.Append("{\"id\":").Append(id).Append(",\"method\":\"").Append(method).Append("\",\"params\":").Append(paramsJson);
        if (sessionId != null && sessionId.Length > 0)
            m.Append(",\"sessionId\":").Append(Program.JsonQuote(sessionId));
        m.Append("}");

        byte[] bytes = Encoding.UTF8.GetBytes(m.ToString());
        Task send = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        if (!send.Wait(timeoutMs)) throw new Exception("CDP 发送超时（" + method + "）");
        if (send.IsFaulted) throw new Exception("CDP 发送失败（" + method + "）：" + BaseMessage(send));

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            int left = (int)Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds);
            string text = ReceiveMessage(left);
            if (text == null) break;
            // **没有 id 的是事件**（Page.loadEventFired / Network.* 等），一律丢掉
            if (HasId(text, id)) return text;
        }
        throw new Exception("CDP 命令超时（" + method + "，" + timeoutMs + "ms 内没有回执）");
    }

    /**
     * 读**一整条** WebSocket 消息：截图回执会被拆成多帧（真机实测 5 帧、最大帧 16KB），
     * 只读一次就是半截 JSON。循环到 EndOfMessage 再拼。
     */
    private static string ReceiveMessage(int timeoutMs)
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

    private static bool HasId(string json, int id)
    {
        string needle = "\"id\":" + id;
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return false;
        int after = i + needle.Length;
        if (after >= json.Length) return true;
        char c = json[after];
        return c == ',' || c == '}' || c == ' ' || c == '\r' || c == '\n';
    }

    private static string BaseMessage(Task task)
    {
        try
        {
            if (task.Exception != null) return task.Exception.GetBaseException().Message;
        }
        catch { }
        return "未知原因";
    }

    private static ClientWebSocket Connect(string wsUrl, int timeoutMs)
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

    private static string HttpGet(string url, int timeoutMs)
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

    private static string Eval(string expression, int timeoutMs)
    {
        string reply = Call("Runtime.evaluate",
            "{\"expression\":" + Program.JsonQuote(expression) + ",\"returnByValue\":true}", timeoutMs);
        string err = CdpError(reply);
        if (err != null) throw new Exception("页面里的脚本报错：" + err);
        return reply;
    }

    private static string EvalString(string expression, int timeoutMs)
    {
        string reply = Eval(expression, timeoutMs);
        string value = Program.ExtractJsonString(reply, "value");
        return value == null ? "" : value;
    }

    private static bool EvalBool(string expression, int timeoutMs)
    {
        string reply = Eval(expression, timeoutMs);
        return reply.IndexOf("\"value\":true", StringComparison.Ordinal) >= 0;
    }

    /** CDP 回执里的 error.message（没有 error 回 null）。裸异常对模型没有信息量，要带 message */
    private static string CdpError(string reply)
    {
        if (reply == null) return "没有回执";
        if (reply.IndexOf("\"error\":{", StringComparison.Ordinal) < 0) return null;
        string message = Program.ExtractString(reply, "message");
        return message == null || message.Length == 0 ? "CDP 返回了错误但没有 message" : message;
    }

    // ── cdp-nav ──────────────────────────────────────────────────────────────────

    private static string Nav(string raw)
    {
        string url = Program.ExtractJsonString(raw, "url");
        if (url == null || url.Trim().Length == 0) return Fail("cdp-nav 需要 url 字段");
        url = url.Trim();
        int timeoutMs = ReadInt(raw, "timeoutMs", NavTimeoutMs, 2000, 60000);
        Stopwatch sw = Stopwatch.StartNew();

        string lower = url.ToLowerInvariant();
        if (lower == "back" || lower == "forward")
        {
            EvalString("(function(){history." + lower + "();return 'ok';})()", 5000);
            WaitForReady(null, timeoutMs);
            return NavResult(sw, null);
        }

        string target = NormalizeUrl(url);
        Call("Page.navigate", "{\"url\":" + Program.JsonQuote(target) + "}", timeoutMs);
        bool loaded = WaitForReady(target, timeoutMs);
        return NavResult(sw, loaded ? null : "页面在 " + timeoutMs + "ms 内没有加载完成，"
            + "可能还在渲染。可以先 sandbox_wait 一下，或 sandbox_observe 看看当前结构");
    }

    private static string NavResult(Stopwatch sw, string warning)
    {
        string href = EvalString("location.href", 8000);
        string title = EvalString("document.title", 8000);
        JObj o = new JObj().Bool("ok", true).Str("url", href).Str("title", title).Num("ms", sw.ElapsedMilliseconds);
        if (warning != null) o.Str("warning", warning);
        return o.ToString();
    }

    /** 裸域名补协议（与 browser_navigate 的语义一致：裸域名按 https） */
    private static string NormalizeUrl(string url)
    {
        string lower = url.ToLowerInvariant();
        if (lower.StartsWith("http://") || lower.StartsWith("https://") || lower.StartsWith("file:")
            || lower.StartsWith("about:") || lower.StartsWith("data:") || lower.StartsWith("chrome:"))
            return url;
        return "https://" + url;
    }

    /**
     * 等 page readyState === 'complete' 且 URL 对上（expected == null 就只看 readyState）。
     *
     * 为什么不用 Page.loadEventFired：事件没有 id，要和普通回执混在一条 socket 上抢读；
     * 而「加载完了」本来就有一个可轮询的真值（readyState）。轮询多几条 CDP 消息，换来的是
     * 不会因为一次事件迟到 / 丢失把整条命令判死。
     */
    private static bool WaitForReady(string expected, int timeoutMs)
    {
        Thread.Sleep(300); // 让 navigate 真正开始（否则第一轮读到的还是旧页面的 complete）
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            bool complete;
            try { complete = EvalString("document.readyState", 5000) == "complete"; }
            catch { complete = false; }
            if (complete)
            {
                if (expected == null) return true;
                string href = EvalString("location.href", 5000);
                if (UrlMatches(expected, href)) return true;
            }
            Thread.Sleep(300);
        }
        return false;
    }

    private static bool UrlMatches(string expected, string actual)
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

    private static string TrimSlash(string value)
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
    private static string Observe(string raw)
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

    private static string Click(string raw)
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
    private static string ResolvePoint(string selector)
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

    private static void DispatchClick(int x, int y)
    {
        Call("Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\",\"x\":" + x + ",\"y\":" + y + "}", 5000);
        string press = "{\"type\":\"mousePressed\",\"x\":" + x + ",\"y\":" + y + ",\"button\":\"left\",\"clickCount\":1}";
        string release = "{\"type\":\"mouseReleased\",\"x\":" + x + ",\"y\":" + y + ",\"button\":\"left\",\"clickCount\":1}";
        Call("Input.dispatchMouseEvent", press, 5000);
        Call("Input.dispatchMouseEvent", release, 5000);
    }

    // ── cdp-type ─────────────────────────────────────────────────────────────────

    private static string TypeText(string raw)
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

    private static void DispatchEnter()
    {
        Call("Input.dispatchKeyEvent",
            "{\"type\":\"keyDown\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13,\"nativeVirtualKeyCode\":13,\"text\":\"\\r\"}",
            5000);
        Call("Input.dispatchKeyEvent",
            "{\"type\":\"keyUp\",\"key\":\"Enter\",\"code\":\"Enter\",\"windowsVirtualKeyCode\":13,\"nativeVirtualKeyCode\":13}",
            5000);
    }

    // ── cdp-extract ──────────────────────────────────────────────────────────────

    private static string ExtractText(string raw)
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

    private static string WaitFor(string raw)
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

    private static string Shot(string raw, string baseName, string cmdDir)
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

    private static string Upload(string raw)
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

    private static string Download(string raw)
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

    private static string Tabs(string raw)
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

    private static int ReadInt(string raw, string field, int fallback, int min, int max)
    {
        string text = Program.ExtractNumber(raw, field);
        int value;
        if (text == null || !int.TryParse(text, out value)) return fallback;
        if (value < min) value = min;
        if (value > max) value = max;
        return value;
    }

    private static long ParseLong(string text, long fallback)
    {
        long value;
        if (text == null || !long.TryParse(text, out value)) return fallback;
        return value;
    }

    private static string Fail(string message)
    {
        return new JObj().Bool("ok", false).Str("error", message).ToString();
    }

    /** 极简 JSON 对象构造器：只为了不用手数逗号（手拼 `,,` 是 cupprobe 踩过的坑） */
    private sealed class JObj
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
}
