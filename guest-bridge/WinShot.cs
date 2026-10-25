// WinShot.cs —— 按**窗口**截图（桥 0.9.0 的 win-list / win-shot）。
//
// 为什么需要它：原来「看一眼」只有 screenshot（整块桌面），两个会话想同时截图就得排队
// （宿主侧的 desktop:exclusive 租约）。而 PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)
// 读的是那个窗口**自己的 surface**：2026-10-25 在真沙箱里实测，被 900×700 不透明窗口
// 完全遮住的 Edge（Chromium）拍出来与可见时逐像素一致（mean 217.5 / 品红 14.9%），
// 而且不抢焦点、不改变桌面。于是「各拍各的窗口」不再需要排队。
//
// 两条硬事实（同一个实验）：
//   ① PrintWindow 的**返回值不可信**：Chromium 在 flags=0 时返回 TRUE 但整帧全黑；
//      最小化窗口在宿主上实测各方法都返回 TRUE 而 97–99% 是黑的。所以必须做**黑帧自检**，
//      不能拿返回值当成功——宁可回一句「拍不到」，也不能悄悄给模型一张黑图。
//   ② 最小化窗口拍不到：必须先 ShowWindow(SW_SHOWNOACTIVATE) 恢复（不抢焦点），
//      等一帧再拍；恢复不了就按失败处理。
//
// 不用 WGC（Windows.Graphics.Capture）：它要 WinRT 投影 + D3D11 互操作，csc 直编拿不到
// （零 NuGet 是沙箱里的硬约束——里���装不了任何运行时）；而且 WGC 拍的是「显示器 / 窗口
// 的合成输出」，最小化时同样为空。PrintWindow 是这里唯一能直编的路径。
//
// 与 Cdp.cs 同一纪律：只碰 guest 自己的桌面与窗口，命令语义由 Program.Execute 分派；
// 纯函数（过滤 / 标题匹配 / 黑帧判定 / 缩放）可以在宿主上跑 --selftest-shot，不碰桌面。
//
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/** win-list 的一项（字段名与宿主契约 ComputerUseWindowInfo 一一对应，改一个字母就是两端脱钩） */
internal sealed class WindowInfo
{
    public long Hwnd;
    public string Title = "";
    public string Process = "";
    public string ClassName = "";
    public int X;
    public int Y;
    public int W;
    public int H;
    public bool Minimized;
    public bool Visible;
}

internal static class WinShot
{
    // ---- 上限与阈值 ----------------------------------------------------------

    /**
     * win-list 最多回几条。窗口多到几十个时模型读不完，而且它真正要看的就是最上面那些
     * （EnumWindows 按 z 序从上往下枚举，所以截断留下的是最上层的窗口）。
     */
    internal const int MaxWindows = 50;

    /** 标题上限（字符）：浏览器标签页标题能写一本书，截断只为让回执不至于失控 */
    internal const int MaxTitleChars = 300;

    /**
     * 黑帧判定的两个阈值。**只抓「整帧全黑」这种伪成功**，不试图判「画面很暗」：
     * 父会话实验里 flags=0 的 Chromium 回 100% 黑（luma 0），而暗色主题窗口的 mean
     * 仍在 25–40（#202020 的 luma ≈ 32）——所以要求两者同时成立：
     *     mean（0–255）< 6  且  黑像素（luma < 16）占比 ≥ 99.5%
     * 放宽任何一个都会把正常的暗色 UI 误判成失败（误判的代价是模型改用整桌面截图，
     * 而真黑图被当成成功会让模型对着黑屏「操作」，后者更坏）。
     */
    internal const double BlackMeanLimit = 6.0;
    internal const double BlackRatioLimit = 0.995;

    /** 恢复最小化窗口后等一帧：ShowWindow 之后 DWM 的合成要一拍才到位 */
    private const int RestoreWaitMs = 150;

    /** 第一次拍出来疑似全黑时，换组合再试前的一拍（Chromium 偶尔第一帧还没画完） */
    private const int RetryWaitMs = 100;

    /**
     * 「拍不到」的人话。宿主不翻译它（原样交给模型）：模型看不见 UI，也想不到原因；
     * 这句必须同时给出**原因猜测**与**下一步能用什么**，否则它只会重试同一个窗口。
     */
    internal const string UncapturableMessage =
        "这个窗口拍不到（可能被最小化后无法恢复 / 显卡合成方式不支持按窗口截取）——改用整桌面截图或 computer_screenshot";

    // ---- Win32（整个文件只碰这些：枚举 / 标题 / 矩形 / 恢复 / PrintWindow）----

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int SW_SHOWNOACTIVATE = 4;
    private const uint PW_CLIENTONLY = 0x00000001;
    private const uint PW_RENDERFULLCONTENT = 0x00000002;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    /**
     * GetWindowText 对**别的进程**的窗口读的是缓存的标题，不会给那个进程发消息——挂死的
     * 窗口不会把这条命令卡住（MSDN 明确写了它「by design」不等待无响应的进程）。
     * 这正是这里用它、而不是 SendMessageTimeout(WM_GETTEXT) 的原因。
     */
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    /**
     * GWL_EXSTYLE 是 32 位值，用 GetWindowLong 就够（GetWindowLongPtr 在 32 位 user32 里
     * 不存在，而 anycpu 的桥在 32 位 Windows 上要能起来）。WS_EX_TOOLWINDOW 只有 0x80。
     */
    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // ---- 纯函数（--selftest-shot 覆盖；不碰桌面、不起进程）--------------------

    /**
     * win-list 的候选过滤（**纯输入**，所以能在宿主上测）。
     *
     * 规则：可见、有标题、不是 tool window、不是桥自己、尺寸为正。
     *   - 不可见：隐藏 / 最小化到托盘的主窗口拍出来也是黑的，列出来只会误导模型；
     *   - 无标题：桌面上大量 0 字节的隐形容器（IME、提示框宿主），模型无从指认；
     *   - WS_EX_TOOLWINDOW：浮动工具条 / 托盘弹窗，不是用户心智里的「窗口」；
     *   - 桥自己：桥从 cmd.exe 起，会有一个控制台窗口——列它等于让模型去截自己。
     * 注意「最小化」**不在**过滤项里：最小化的窗口仍是用户眼里的窗口，win-shot 会先恢复它。
     */
    internal static bool IsShootable(bool visible, string title, bool toolWindow, int width, int height,
        uint pid, uint ownPid)
    {
        if (!visible) return false;
        if (title == null || title.Trim().Length == 0) return false;
        if (toolWindow) return false;
        if (width <= 0 || height <= 0) return false;
        if (pid == ownPid) return false;
        return true;
    }

    /**
     * 按标题选窗口：**不区分大小写的包含匹配**，命中多个取**枚举顺序里的第一个**
     * （EnumWindows 是 z 序，第一个 = 最上层那个，通常正是用户说的那个窗口）。
     * 回 -1 = 没命中（index 无意义）。matched 回命中个数，让回执能说「有 3 个窗口都叫这个，
     * 我用的是最上面那个」——否则模型无法解释自己拍到了哪一个。
     */
    internal static int SelectByTitle(string[] titles, string query, out int matched)
    {
        int index;
        SelectByTitle(titles, query, out index, out matched);
        return index;
    }

    /** 同上的完整形态：index = 第一个命中的下标（-1 = 没命中） */
    internal static void SelectByTitle(string[] titles, string query, out int index, out int matched)
    {
        index = -1;
        matched = 0;
        if (titles == null || query == null) return;
        string needle = query.Trim();
        if (needle.Length == 0) return;
        for (int i = 0; i < titles.Length; i++)
        {
            string title = titles[i];
            if (title == null) continue;
            if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
            matched++;
            if (index < 0) index = i;
        }
    }

    /**
     * 长边缩到 maxWidth 以内（与 screenshot 同一条规则：等比、四舍五入、至少 1 像素）。
     * 抽成纯函数是为了让窗口截图与整桌面截图**不可能**算出两套尺寸，也为了能直接测。
     */
    internal static void FitLongEdge(int nativeWidth, int nativeHeight, int maxWidth,
        out int width, out int height)
    {
        width = nativeWidth;
        height = nativeHeight;
        int longEdge = Math.Max(nativeWidth, nativeHeight);
        if (longEdge > maxWidth && longEdge > 0)
        {
            double scale = (double)maxWidth / longEdge;
            width = Math.Max(1, (int)Math.Round(nativeWidth * scale));
            height = Math.Max(1, (int)Math.Round(nativeHeight * scale));
        }
    }

    /**
     * 黑帧判定（阈值与理由见 BlackMeanLimit / BlackRatioLimit）。纯数字输入，
     * --selftest-shot 用几组人造统计直接验边界。
     */
    internal static bool LooksBlack(double mean, double blackRatio)
    {
        return mean < BlackMeanLimit && blackRatio >= BlackRatioLimit;
    }

    /**
     * 逐像素统计（BGRA32，stride 可能带行尾填充）。step = 采样步长（每隔 step 个像素取一个）。
     * luma 与 screenshot-stats 同一条公式：(0.299R + 0.587G + 0.114B)。
     * 纯函数：输入就是一段内存字节，测试里造 4×2 的数组就能验。
     */
    internal static void MeasureFrame(byte[] bgra, int width, int height, int stride, int step,
        out double mean, out double blackRatio)
    {
        mean = 0;
        blackRatio = 0;
        if (bgra == null || width <= 0 || height <= 0) return;
        int absStride = Math.Abs(stride);
        int strideStep = step < 1 ? 1 : step;
        double sum = 0;
        long black = 0;
        long count = 0;
        for (int y = 0; y < height; y += strideStep)
        {
            int row = y * absStride;
            for (int x = 0; x < width; x += strideStep)
            {
                int at = row + x * 4;
                if (at + 2 >= bgra.Length) continue;
                byte b = bgra[at];
                byte gr = bgra[at + 1];
                byte r = bgra[at + 2];
                double luma = 0.299 * r + 0.587 * gr + 0.114 * b;
                sum += luma;
                if (luma < 16) black++;
                count++;
            }
        }
        if (count == 0) return;
        mean = sum / count;
        blackRatio = (double)black / count;
    }

    // ---- win-list ------------------------------------------------------------

    /**
     * win-list → `{ok:true,windows:[{hwnd,title,process,className,x,y,w,h,minimized,visible}]}`
     *
     * 只读：枚举顶层窗口、读标题 / 类名 / 矩形 / 扩展样式。不改任何状态、不抢焦点。
     */
    internal static string ExecuteList()
    {
        try
        {
            List<WindowInfo> windows = EnumerateShootable();
            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"windows\":[");
            for (int i = 0; i < windows.Count; i++)
            {
                if (i > 0) json.Append(",");
                WindowInfo w = windows[i];
                json.Append("{\"hwnd\":").Append(w.Hwnd)
                    .Append(",\"title\":").Append(Program.JsonQuote(w.Title))
                    .Append(",\"process\":").Append(Program.JsonQuote(w.Process))
                    .Append(",\"className\":").Append(Program.JsonQuote(w.ClassName))
                    .Append(",\"x\":").Append(w.X)
                    .Append(",\"y\":").Append(w.Y)
                    .Append(",\"w\":").Append(w.W)
                    .Append(",\"h\":").Append(w.H)
                    .Append(",\"minimized\":").Append(w.Minimized ? "true" : "false")
                    .Append(",\"visible\":").Append(w.Visible ? "true" : "false")
                    .Append("}");
            }
            json.Append("]}");
            Program.Log("窗口列表：" + windows.Count + " 个可截图窗口");
            return json.ToString();
        }
        catch (Exception ex)
        {
            Program.Log("窗口列表失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + Program.JsonQuote("枚举窗口失败：" + ex.Message) + "}";
        }
    }

    // ---- win-shot ------------------------------------------------------------

    /**
     * win-shot {hwnd?, title?, maxWidth?} —— hwnd 优先；否则按标题包含匹配（取第一个）。
     *
     * 流程：选目标 → 最小化就先 SW_SHOWNOACTIVATE 恢复并等一帧 → PrintWindow
     * (PW_RENDERFULLCONTENT) → **黑帧自检** → 疑似全黑就换 PW_RENDERFULLCONTENT|PW_CLIENTONLY
     * 再试一次 → 仍黑就回 ok:false + 人话（绝不悄悄回一张黑图）。
     *
     * 成功回执与 screenshot 同一条通道：JPEG 写同名 .jpg 兄弟文件（TCP 通道下由 TcpChannel
     * 内联成 jpegBase64），resp 里放纯文件名 + 回图/窗口两套尺寸 + hwnd / title /
     * restoredFromMinimized / matched。
     */
    internal static string ExecuteShot(string raw, string baseName)
    {
        int maxWidth = 1280;
        string maxWidthRaw = Program.ExtractNumber(raw, "maxWidth");
        if (maxWidthRaw != null && (!int.TryParse(maxWidthRaw, out maxWidth) || maxWidth <= 0))
            return "{\"ok\":false,\"error\":\"maxWidth 必须是正整数\"}";

        string hwndRaw = Program.ExtractNumber(raw, "hwnd");
        string titleQuery = Program.ExtractJsonString(raw, "title");
        if (titleQuery != null) titleQuery = titleQuery.Trim();

        IntPtr hwnd = IntPtr.Zero;
        int matched = 1;
        try
        {
            if (hwndRaw != null)
            {
                long parsed;
                if (!long.TryParse(hwndRaw, out parsed) || parsed <= 0)
                    return "{\"ok\":false,\"error\":\"hwnd 必须是正整数（win-list 回执里的那个）\"}";
                hwnd = new IntPtr(parsed);
            }
            else
            {
                if (titleQuery == null || titleQuery.Length == 0)
                    return "{\"ok\":false,\"error\":" + Program.JsonQuote(
                        "win-shot 需要 hwnd 或 title（窗口标题的一部分，不区分大小写）——先用 win-list 看现在有哪些窗口") + "}";
                List<WindowInfo> windows = EnumerateShootable();
                string[] titles = new string[windows.Count];
                for (int i = 0; i < windows.Count; i++) titles[i] = windows[i].Title;
                int index;
                SelectByTitle(titles, titleQuery, out index, out matched);
                if (index < 0)
                    return "{\"ok\":false,\"error\":" + Program.JsonQuote(
                        "没找到标题包含「" + titleQuery + "」的窗口——先用 win-list 看现在有哪些窗口，"
                        + "或者直接传它的 hwnd") + "}";
                hwnd = new IntPtr(windows[index].Hwnd);
            }
        }
        catch (Exception ex)
        {
            Program.Log("win-shot 选窗口失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + Program.JsonQuote("选择窗口失败：" + ex.Message) + "}";
        }

        if (!IsWindow(hwnd))
            return "{\"ok\":false,\"error\":" + Program.JsonQuote(
                "这个窗口已经不在了（hwnd " + hwnd.ToInt64() + "）——先用 win-list 看现在有哪些窗口") + "}";

        bool restored = false;
        try
        {
            // ② 最小化窗口拍不到（宿主实测各方法都回 TRUE 但 97–99% 黑）：先恢复，
            //    用 SW_SHOWNOACTIVATE——不抢焦点是这条命令能「不打扰正在操作的人」的前提。
            if (IsIconic(hwnd))
            {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                Thread.Sleep(RestoreWaitMs);
                restored = true;
                if (IsIconic(hwnd))
                {
                    Program.Log("win-shot：最小化恢复失败 hwnd " + hwnd.ToInt64());
                    return "{\"ok\":false,\"error\":" + Program.JsonQuote(UncapturableMessage) + "}";
                }
            }

            string title = ReadTitle(hwnd);
            Bitmap captured = null;
            int nativeW = 0;
            int nativeH = 0;
            try
            {
                // 最多两次：第一次 PW_RENDERFULLCONTENT，疑似全黑就换组合再等一拍
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    uint flags = attempt == 0 ? PW_RENDERFULLCONTENT : (PW_RENDERFULLCONTENT | PW_CLIENTONLY);
                    captured = Capture(hwnd, flags, out nativeW, out nativeH);
                    double mean;
                    double blackRatio;
                    MeasureBitmap(captured, out mean, out blackRatio);
                    if (!LooksBlack(mean, blackRatio))
                    {
                        int outW;
                        int outH;
                        FitLongEdge(nativeW, nativeH, maxWidth, out outW, out outH);
                        byte[] jpeg = EncodeScaled(captured, nativeW, nativeH, outW, outH);
                        string jpgName = baseName + ".jpg";
                        Program.AtomicWrite(System.IO.Path.Combine(Program.CmdDir, jpgName), jpeg);
                        Program.Log("窗口截图完成 hwnd " + hwnd.ToInt64() + "（" + (restored ? "从最小化恢复" : "原状")
                            + "，第 " + (attempt + 1) + " 次，mean " + mean.ToString("F1")
                            + " black " + blackRatio.ToString("F3") + "）：窗口 " + nativeW + "x" + nativeH
                            + "，输出 " + outW + "x" + outH + "，" + jpeg.Length + " 字节");
                        return "{\"ok\":true,\"hwnd\":" + hwnd.ToInt64()
                            + ",\"title\":" + Program.JsonQuote(title)
                            + ",\"restoredFromMinimized\":" + (restored ? "true" : "false")
                            + ",\"matched\":" + matched
                            + ",\"nativeWidth\":" + nativeW + ",\"nativeHeight\":" + nativeH
                            + ",\"width\":" + outW + ",\"height\":" + outH
                            + ",\"jpeg\":\"" + jpgName + "\"}";
                    }
                    Program.Log("win-shot：疑似全黑 hwnd " + hwnd.ToInt64() + "（第 " + (attempt + 1)
                        + " 次，mean " + mean.ToString("F1") + " black " + blackRatio.ToString("F3")
                        + "，PrintWindow=" + (attempt == 0 ? "PW_RENDERFULLCONTENT" : "PW_RENDERFULLCONTENT|PW_CLIENTONLY") + "）");
                    if (attempt == 0)
                    {
                        // 换了组合就换一张新位图：上一帧要释放，否则这是每张黑图漏一个 GDI 对象
                        captured.Dispose();
                        captured = null;
                        Thread.Sleep(RetryWaitMs);
                    }
                }
            }
            finally
            {
                if (captured != null) captured.Dispose();
            }

            // ① PrintWindow 可能回了 true、像素却真的是黑的：这就是「拍不到」，说清楚，
            //    不要给黑图
            return "{\"ok\":false,\"error\":" + Program.JsonQuote(UncapturableMessage) + "}";
        }
        catch (Exception ex)
        {
            Program.Log("win-shot 失败：" + ex.Message);
            return "{\"ok\":false,\"error\":" + Program.JsonQuote(UncapturableMessage
                + "（" + ex.Message + "）") + "}";
        }
    }

    // ---- 内部实现 ------------------------------------------------------------

    /** 枚举 + 过滤（上限 MaxWindows，保持 z 序）。任何单个窗口的异常都不该让整条命令失败 */
    private static List<WindowInfo> EnumerateShootable()
    {
        uint ownPid = (uint)Process.GetCurrentProcess().Id;
        List<WindowInfo> windows = new List<WindowInfo>();
        Dictionary<uint, string> processNames = new Dictionary<uint, string>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            if (windows.Count >= MaxWindows) return false; // 够数就停（z 序最上面那些）
            try
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                string title = ReadTitle(hwnd);
                int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
                bool toolWindow = (exStyle & WS_EX_TOOLWINDOW) != 0;
                RECT rect;
                GetWindowRect(hwnd, out rect);
                int w = rect.Right - rect.Left;
                int h = rect.Bottom - rect.Top;
                bool visible = IsWindowVisible(hwnd);
                if (!IsShootable(visible, title, toolWindow, w, h, pid, ownPid)) return true;

                WindowInfo info = new WindowInfo();
                info.Hwnd = hwnd.ToInt64();
                info.Title = TrimTitle(title);
                info.Process = ProcessNameOf(pid, processNames);
                info.ClassName = ReadClassName(hwnd);
                info.X = rect.Left;
                info.Y = rect.Top;
                info.W = w;
                info.H = h;
                info.Minimized = IsIconic(hwnd);
                info.Visible = true;
                windows.Add(info);
            }
            catch
            {
                // 枚举途中的窗口消失 / 权限不足：跳过它，别让整个列表失败
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static string ReadTitle(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(MaxTitleChars + 1);
        // 别的进程的窗口读缓存标题（不等待无响应进程），见 DllImport 上的注释
        int len = GetWindowText(hwnd, sb, sb.Capacity);
        return len <= 0 ? "" : sb.ToString();
    }

    private static string ReadClassName(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(256);
        int len = GetClassName(hwnd, sb, sb.Capacity);
        return len <= 0 ? "" : sb.ToString();
    }

    private static string TrimTitle(string title)
    {
        if (title == null) return "";
        string trimmed = title.Trim();
        if (trimmed.Length <= MaxTitleChars) return trimmed;
        return trimmed.Substring(0, MaxTitleChars);
    }

    private static string ProcessNameOf(uint pid, Dictionary<uint, string> cache)
    {
        string cached;
        if (cache.TryGetValue(pid, out cached)) return cached;
        string name = "";
        try
        {
            Process p = Process.GetProcessById((int)pid);
            try { name = p.ProcessName; }
            finally { p.Dispose(); }
        }
        catch
        {
            // 受保护进程 / 已退出：名字留空（不是失败，窗口照样能拍）
        }
        cache[pid] = name;
        return name;
    }

    /**
     * 拍一帧到 Bitmap。PrintWindow 的返回值**只用来记日志**（见文件头 ①）：真正的成功
     * 判据是后面的黑帧自检。窗口矩形在恢复之后重新读，最小化的窗口这一步才拿得到真实尺寸。
     */
    private static Bitmap Capture(IntPtr hwnd, uint flags, out int width, out int height)
    {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect))
            throw new InvalidOperationException("拿不到窗口矩形（GetWindowRect 失败）");
        width = rect.Right - rect.Left;
        height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0)
            throw new InvalidOperationException("窗口尺寸为 0（" + width + "x" + height + "）");

        Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        try
        {
            bool printed;
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.Black); // 拍失败时的底色：统计会把它认成黑帧，而不是上一帧的残影
                IntPtr hdc = g.GetHdc();
                try
                {
                    printed = PrintWindow(hwnd, hdc, flags);
                }
                finally
                {
                    g.ReleaseHdc(hdc);
                }
            }
            if (!printed) Program.Log("PrintWindow 回了 false（hwnd " + hwnd.ToInt64() + "，flags " + flags + "）");
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    private static void MeasureBitmap(Bitmap bitmap, out double mean, out double blackRatio)
    {
        int width = bitmap.Width;
        int height = bitmap.Height;
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly,
            PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            int absStride = Math.Abs(stride);
            byte[] buffer = new byte[absStride * height];
            Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);
            // 采样步长 2：判「整帧是不是黑的」不需要逐像素，2M 像素减到 0.5M
            MeasureFrame(buffer, width, height, stride, 2, out mean, out blackRatio);
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    private static byte[] EncodeScaled(Bitmap source, int nativeW, int nativeH, int outW, int outH)
    {
        if (outW == nativeW && outH == nativeH) return Program.EncodeJpeg(source, 80);
        Bitmap target = new Bitmap(outW, outH);
        try
        {
            using (Graphics g = Graphics.FromImage(target))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(source, new Rectangle(0, 0, outW, outH), new Rectangle(0, 0, nativeW, nativeH),
                    GraphicsUnit.Pixel);
            }
            return Program.EncodeJpeg(target, 80);
        }
        finally
        {
            target.Dispose();
        }
    }

    // ---- 自测（--selftest-shot：纯函数，不启进程、不碰桌面）--------------------

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // ① win-list 过滤：可见 / 有标题 / 非 tool window / 非自己 / 尺寸为正
        CheckTrue(failures, ref cases, "可见 + 有标题 + 普通窗口 → 可截图",
            IsShootable(true, "Edge - 新建标签页", false, 800, 600, 100, 999));
        CheckTrue(failures, ref cases, "不可见 → 不列",
            !IsShootable(false, "Edge", false, 800, 600, 100, 999));
        CheckTrue(failures, ref cases, "无标题 → 不列",
            !IsShootable(true, "", false, 800, 600, 100, 999));
        CheckTrue(failures, ref cases, "纯空白标题 → 不列",
            !IsShootable(true, "   ", false, 800, 600, 100, 999));
        CheckTrue(failures, ref cases, "tool window → 不列",
            !IsShootable(true, "浮动工具条", true, 800, 600, 100, 999));
        CheckTrue(failures, ref cases, "桥自己（同 pid）→ 不列",
            !IsShootable(true, "orbita-guest-bridge", false, 800, 600, 777, 777));
        CheckTrue(failures, ref cases, "尺寸为 0 → 不列",
            !IsShootable(true, "零尺寸", false, 0, 600, 100, 999));
        CheckTrue(failures, ref cases, "负尺寸 → 不列",
            !IsShootable(true, "负尺寸", false, 800, -1, 100, 999));

        // ② 标题匹配：不区分大小写、包含、取第一个、回命中数
        string[] titles = new string[] { "Edge - 新建标签页", "记事本 - 未命名", "edge 文档", "设置" };
        int index;
        int matched;
        index = SelectByTitle(titles, "edge", out matched);
        CheckNumber(failures, ref cases, "标题匹配取第一个（z 序最上面）", "0", index.ToString());
        CheckNumber(failures, ref cases, "标题匹配回命中个数", "2", matched.ToString());
        index = SelectByTitle(titles, "EDGE", out matched);
        CheckNumber(failures, ref cases, "大小写不敏感", "0", index.ToString());
        index = SelectByTitle(titles, "记事", out matched);
        CheckNumber(failures, ref cases, "中文包含匹配", "1", index.ToString());
        index = SelectByTitle(titles, "不存在的窗口", out matched);
        CheckNumber(failures, ref cases, "没命中回 -1", "-1", index.ToString());
        CheckNumber(failures, ref cases, "没命中 matched 为 0", "0", matched.ToString());
        index = SelectByTitle(titles, "   ", out matched);
        CheckNumber(failures, ref cases, "空查询不当成匹配一切", "-1", index.ToString());
        index = SelectByTitle(new string[0], "edge", out matched);
        CheckNumber(failures, ref cases, "空列表回 -1", "-1", index.ToString());

        // ③ 缩放：与 screenshot 同一条规则（长边、等比、至少 1 像素）
        int w;
        int h;
        FitLongEdge(800, 600, 1280, out w, out h);
        CheckNumber(failures, ref cases, "小于上限不放大（宽）", "800", w.ToString());
        CheckNumber(failures, ref cases, "小于上限不放大（高）", "600", h.ToString());
        FitLongEdge(2560, 1440, 1280, out w, out h);
        CheckNumber(failures, ref cases, "长边缩到 1280（宽）", "1280", w.ToString());
        CheckNumber(failures, ref cases, "等比缩放（高）", "720", h.ToString());
        FitLongEdge(600, 1200, 600, out w, out h);
        CheckNumber(failures, ref cases, "长边是高度时按高度缩（宽）", "300", w.ToString());
        CheckNumber(failures, ref cases, "长边是高度时按高度缩（高）", "600", h.ToString());
        FitLongEdge(3, 1, 1, out w, out h);
        CheckNumber(failures, ref cases, "极端比例也不回 0（宽）", "1", w.ToString());
        CheckNumber(failures, ref cases, "极端比例也不回 0（高）", "1", h.ToString());

        // ④ 黑帧判定：只抓「整帧全黑」，暗色主题不能误判
        CheckTrue(failures, ref cases, "全黑（mean 0 / 100%）→ 判黑", LooksBlack(0, 1.0));
        CheckTrue(failures, ref cases, "近全黑（mean 2.5 / 99.9%）→ 判黑", LooksBlack(2.5, 0.999));
        CheckTrue(failures, ref cases, "暗色主题（mean 32 / 60%）→ 不判黑", !LooksBlack(32, 0.6));
        CheckTrue(failures, ref cases, "略亮但仍过半黑（mean 10 / 99%）→ 不判黑", !LooksBlack(10, 0.99));
        CheckTrue(failures, ref cases, "很黑但没到 99.5%（mean 5 / 98%）→ 不判黑", !LooksBlack(5, 0.98));
        CheckTrue(failures, ref cases, "纯白（mean 255 / 0%）→ 不判黑", !LooksBlack(255, 0));

        // ⑤ 逐像素统计：人造 2×2 图（BGRA），stride 带行尾填充
        //    第 1 行：黑 (0,0,0)、白 (255,255,255)；第 2 行：纯红 (255,0,0)、纯绿 (0,255,0)
        int strideBytes = 4 * 3; // 2 像素 + 1 像素的行尾填充
        byte[] frame = new byte[strideBytes * 2 + 8];
        // 黑
        frame[0] = 0; frame[1] = 0; frame[2] = 0;
        // 白
        frame[4] = 255; frame[5] = 255; frame[6] = 255;
        // 第二行：红
        int row1 = strideBytes;
        frame[row1] = 0; frame[row1 + 1] = 0; frame[row1 + 2] = 255;
        // 第二行：绿
        frame[row1 + 4] = 0; frame[row1 + 5] = 255; frame[row1 + 6] = 0;
        double mean;
        double blackRatio;
        MeasureFrame(frame, 2, 2, strideBytes, 1, out mean, out blackRatio);
        // 黑 0 + 白 255 + 红 0.299*255=76.245 + 绿 0.587*255=149.685 → 平均 120.23
        CheckNumber(failures, ref cases, "逐像素 mean（BGRA + luma 公式）", "120.23",
            mean.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
        // 只有黑与红 luma < 16（红 76 不算黑）→ 1/4
        CheckNumber(failures, ref cases, "逐像素 blackRatio", "0.25",
            blackRatio.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
        CheckTrue(failures, ref cases, "统计结果接进黑帧判定：这张图不是黑帧", !LooksBlack(mean, blackRatio));

        byte[] allBlack = new byte[4 * 4 * 2];
        MeasureFrame(allBlack, 4, 2, 16, 1, out mean, out blackRatio);
        CheckNumber(failures, ref cases, "全黑图 mean 为 0", "0.00",
            mean.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "全黑图 blackRatio 为 1", "1.00",
            blackRatio.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
        CheckTrue(failures, ref cases, "统计结果接进黑帧判定：全黑图判黑", LooksBlack(mean, blackRatio));

        // 采样步长 2：只数左下角那个像素（黑）→ mean 0 / 100%
        MeasureFrame(frame, 2, 2, strideBytes, 2, out mean, out blackRatio);
        CheckNumber(failures, ref cases, "采样步长 2 只取左上角像素", "0.00",
            mean.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

        // 空输入不炸（Bitmap.LockBits 极端情况下可能给 0 尺寸）
        MeasureFrame(new byte[0], 0, 0, 0, 1, out mean, out blackRatio);
        CheckNumber(failures, ref cases, "空输入不炸（mean 0）", "0.00",
            mean.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

        // ⑥ 失败文案：模型只有这一句能照着换路（换了说法就等于没说）
        CheckTrue(failures, ref cases, "失败文案给出下一步（整桌面截图）",
            UncapturableMessage.IndexOf("computer_screenshot", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "失败文案给出原因猜测",
            UncapturableMessage.IndexOf("最小化", StringComparison.Ordinal) >= 0
            && UncapturableMessage.IndexOf("显卡合成", StringComparison.Ordinal) >= 0);

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    private static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
    {
        Program.CheckTrue(failures, ref cases, name, condition);
    }

    private static void CheckNumber(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        Program.CheckNumber(failures, ref cases, name, expected, actual);
    }
}
