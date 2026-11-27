// Orbita guest bridge —— 会话内 PostMessage 车道（P2 / L2b 的第三条合成车道）。
//
// 为什么需要它：MXC 的 IsolationSession 是 RDP 形态的会话（SM_REMOTESESSION=1），
// **SendInput 返回成功但光标永远停在 (0,0)** —— 像素点击 / 打字在那一档里全是假的。
// 而宿主不能替会话发窗口消息（跨会话 PostMessage = ERROR_ACCESS_DENIED），所以必须由
// **会话里的进程**来发。桥本来就跑在会话里，它就是那个执行者。
//
// 实测（2026-11-15，同一台机器）：会话内 PostMessage(WM_LBUTTONDOWN/UP) 让 WinForms 按钮的
// Click 计数从 1 变 2；PostMessage(WM_CHAR) 让文本框内容变成 "PQuia-wrote-this"。
// 注意 WinForms 子窗口的 class 是 `WindowsForms10.BUTTON.app.0.34f5582...`，按精确 class 名
// "Button" 匹配会落空——本文件按 **UIA 元素**定位（ref / name），再读它的 NativeWindowHandle，
// 不猜 class 名。
//
// 定位：`wm-act` 是 UIA 车道的补充，不是替代。
//   - UIA 有模式（invoke / value）时用 UIA：它更稳、不需要窗口句柄、也不依赖坐标；
//   - UIA 没有模式时（自绘控件、部分第三方 Win32 控件）走这里：把字符 / 鼠标消息直接送进那个 HWND。
//   - **两者都不解决 canvas**：没有 UIA 也没有独立 HWND 的自绘 UI，这一档做不到（见 P2 报告）。
//
// 本文件只做三件事：解析参数（纯函数，可 selftest）、解析出目标 HWND、往它投消息。
// 所有 UIA COM 调用都在 Uia 的 STA 线程里（Uia.Run），避免跨线程用 COM 指针。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

internal static class WmPost
{
    // ── Win32 ────────────────────────────────────────────────────────────

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_CHAR = 0x0102;
    /** MK_LBUTTON：按住左键期间 wParam 的值（WinForms 的 Button 会看它） */
    private const int MK_LBUTTON = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    internal const int MaxChars = 2000;

    // ── 纯函数（selftest 直接验，不碰任何窗口）────────────────────────────

    /**
     * 参数校验。回 null = 通过；否则回一句给模型的人话。
     * 三个要素：动作认识 / 有目标 / 动作要的参数齐了。
     */
    internal static string Validate(string action, bool hasTarget, string text)
    {
        if (action != "type" && action != "click")
            return "wm-act 的 action 必须是 type（往控件里打字）或 click（往控件中心点一下）";
        if (!hasTarget)
            return "wm-act 需要目标：ref（上一次 uia-list 回执里的 \"g12:r3\"）或 name（控件名字的一部分）";
        if (action == "type")
        {
            if (text == null || text.Length == 0)
                return "wm-act type 需要 text（要写进控件的文本；要清空请用 uia-act setValue 传空字符串）";
            if (text.Length > MaxChars)
                return "wm-act type 的 text 太长了（上限 " + MaxChars.ToString(CultureInfo.InvariantCulture)
                    + " 个字符；更长的文本请分几次）";
        }
        return null;
    }

    /**
     * WM_CHAR 的 wParam：逐 UTF-16 code unit。**不按 code point 合并**——Windows 的
     * WM_CHAR 本来就是按 UTF-16 单元投递的（代理对由两次消息拼回去），合并反而会写出半个字符。
     */
    internal static char[] CharPayload(string text)
    {
        if (text == null) return new char[0];
        return text.ToCharArray();
    }

    /** MAKELPARAM(x, y)：低 16 位 x、高 16 位 y（Windows 的窗口消息约定） */
    internal static long PackPoint(int x, int y)
    {
        long low = (long)(x & 0xFFFF);
        long high = (long)(y & 0xFFFF);
        return (high << 16) | low;
    }

    /** 控件中心点（屏幕坐标）→ 投给该 HWND 的客户区坐标。宽高为 0 时回 0,0 并由调用方报错 */
    internal static bool CenterOf(int left, int top, int right, int bottom, out int x, out int y)
    {
        int width = right - left;
        int height = bottom - top;
        if (width <= 0 || height <= 0)
        {
            x = 0;
            y = 0;
            return false;
        }
        x = left + width / 2;
        y = top + height / 2;
        return true;
    }

    // ── 执行（在 Uia 的 STA 线程里调）──────────────────────────────────────

    /** 往一个 HWND 里逐字符投 WM_CHAR；回实际投出去的条数 */
    internal static int PostText(IntPtr hwnd, string text)
    {
        int posted = 0;
        char[] chars = CharPayload(text);
        for (int i = 0; i < chars.Length; i++)
        {
            // lParam=1：重复计数 1（与键盘发一条字符消息同形）
            if (PostMessage(hwnd, WM_CHAR, (IntPtr)chars[i], (IntPtr)1)) posted++;
        }
        return posted;
    }

    /** 往控件中心投一对 WM_LBUTTONDOWN/UP；回是否两条都投出去了 */
    internal static bool PostClick(IntPtr hwnd, int screenX, int screenY, out int clientX, out int clientY)
    {
        POINT point;
        point.X = screenX;
        point.Y = screenY;
        ScreenToClient(hwnd, ref point);
        clientX = point.X;
        clientY = point.Y;
        long lparam = PackPoint(point.X, point.Y);
        bool down = PostMessage(hwnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, (IntPtr)lparam);
        bool up = PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, (IntPtr)lparam);
        return down && up;
    }

    // ── 自检（纯函数；宿主上绝不碰真实窗口）─────────────────────────────────

    private static void Check(string label, bool ok, List<string> failures, ref int cases)
    {
        cases++;
        if (!ok) failures.Add(label);
    }

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // ① 动作与目标
        Check("type 缺目标被拒", Validate("type", false, "x") != null, failures, ref cases);
        Check("click 缺目标被拒", Validate("click", false, null) != null, failures, ref cases);
        Check("未知动作被拒", Validate("drag", true, null) != null, failures, ref cases);
        Check("type 有目标有文本通过", Validate("type", true, "hi") == null, failures, ref cases);
        Check("click 有目标通过（不需要 text）", Validate("click", true, null) == null, failures, ref cases);

        // ② 文本载荷
        Check("type 空文本被拒", Validate("type", true, "") != null, failures, ref cases);
        Check("超长文本被拒", Validate("type", true, new string('a', MaxChars + 1)) != null, failures, ref cases);
        Check("恰好上限通过", Validate("type", true, new string('a', MaxChars)) == null, failures, ref cases);
        Check("CharPayload 逐 UTF-16 单元", CharPayload("ab").Length == 2, failures, ref cases);
        Check("CharPayload 空文本是空数组", CharPayload(null).Length == 0, failures, ref cases);
        // 中文与代理对：长度按 UTF-16 单元算（"中" 1 个，"😀" 2 个）
        Check("中文 1 个单元", CharPayload("中").Length == 1, failures, ref cases);
        Check("emoji 2 个单元（不合并 code point）", CharPayload("😀").Length == 2, failures, ref cases);

        // ③ MAKELPARAM
        Check("PackPoint(0,0) = 0", PackPoint(0, 0) == 0, failures, ref cases);
        Check("PackPoint(1,0) = 1", PackPoint(1, 0) == 1, failures, ref cases);
        Check("PackPoint(0,1) = 0x10000", PackPoint(0, 1) == 0x10000, failures, ref cases);
        Check("PackPoint(300,200) = (200<<16)|300", PackPoint(300, 200) == ((long)200 << 16 | 300), failures, ref cases);
        Check("负数坐标按 16 位截（不抛）", PackPoint(-1, -1) == 0xFFFFFFFFL, failures, ref cases);

        // ④ 中心点
        int cx;
        int cy;
        Check("控件中心 = 左上 + 半宽/半高",
            CenterOf(100, 50, 300, 90, out cx, out cy) && cx == 200 && cy == 70, failures, ref cases);
        Check("零尺寸控件被拒", !CenterOf(10, 10, 10, 10, out cx, out cy), failures, ref cases);

        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":").Append(failures.Count == 0 ? "true" : "false")
            .Append(",\"cases\":").Append(cases.ToString(CultureInfo.InvariantCulture));
        if (failures.Count > 0)
        {
            json.Append(",\"failures\":[");
            for (int i = 0; i < failures.Count; i++)
            {
                if (i > 0) json.Append(",");
                json.Append(Program.JsonQuote(failures[i]));
            }
            json.Append("]");
        }
        json.Append("}");
        Console.WriteLine(json.ToString());
        return failures.Count == 0 ? 0 : 1;
    }
}
