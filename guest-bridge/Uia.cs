// Uia.cs —— UI Automation 车道（桥 0.10.0 的 uia-list / uia-act）。
//
// 为什么需要它：像素输入（click / type / key / scroll）走 SendInput，那是**全局输入**——
// 抢焦点、打到当前前台窗口，多个会话只能靠宿主侧的 desktop:exclusive 串行。UIA 换了一条
// 入口：针对某个窗口/控件直接调它的模式（InvokePattern / ValuePattern /
// SelectionItemPattern），那个窗口不必在前台。于是「在后台窗口里点一个按钮」不再需要
// 独占整块桌面，多 agent 并行的最后一道墙在这里拆开。
//
// 三个必须处理的坑（每一个都能让这条车道变成新的坑）：
//
//   ① AutoSetFocus：IUIAutomation 默认 AutoSetFocus = true —— 一调用模式就把目标窗口
//      带到前台，等于「换了条路抢焦点」。所以这里不用 .NET 的 System.Windows.Automation
//      包装（它不暴露这个开关），而是**手写 COM interop**：拿到 CUIAutomation8 的
//      IUIAutomation，再 QueryInterface 到 IUIAutomation2，调 put_AutoSetFocus(false)，
//      并用 get_AutoSetFocus 读回确认。关不掉（老系统没有 IUIAutomation2 / QI 失败）时
//      不阻断功能，只在回执里把 autoSetFocus 置 false 并把「可能抢焦点」写进日志与文案。
//
//   ② 阻塞：UIA 调用是跨进程的，目标进程忙 / 卡在模态对话框上时，调用会**在 CPU 级阻塞**，
//      没有任何超时参数能打断它。所以每次 UIA 调用都放进一条专用 STA 线程（UIA 客户端
//      要求 STA），调用方最多等 5 秒（COMPUTER_USE_UIA_TIMEOUT_MS，可被请求覆写）。超时后
//      桥**放弃那条线程**（IsBackground，不挡进程退出），回一句人话给模型，下一条命令起
//      一条新的 STA 线程。命令循环与 TCP 连接线程都不会被卡住——这是这一刀最重要的验收点。
//
//   ③ ref 的生命周期：uia-list 回的 ref 是「这个窗口里按遍历顺序的第几个」，映射存的是
//      那一次枚举出来的 COM 指针（只在那条 STA 单元里有效）。所以 ref 映射跟着 STA 线程
//      走：线程被超时放弃时映射一并作废，下一次 uia-act 会回「ref 已经失效，重新 uia-list」。
//      跨线程 Release 可能卡在代理的单元锁上——放弃线程时我们**不 Release**（沙箱一次性，
//      留给进程退出），正常替换列表时才逐个 Release。
//
// 支持的动作只有四条，与宿主契约 ComputerUseUiaAction 一一对应：
//   invoke    → InvokePattern.Invoke()           按钮 / 链接 / 菜单项 / 标签页
//   setValue  → ValuePattern.SetValue(BSTR)      输入框 / 文档（直接设值，不经 IME）
//   selection → SelectionItemPattern.Select()    列表项 / 标签项 / 菜单项的单选
//   focus     → Element.SetFocus()               唯一一个**有意**移动键盘焦点的动作
//
// 不支持的控件（模式取不到）一律回人话，并点名它支持哪些模式、改用 computer_click /
// computer_type 的像素路径——模型看不见 UI，不会自己想到这一点。
//
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。
// COM 的 vtable 槽位号全部来自 Windows SDK 的 UIAutomationClient.h（槽 0 基，IUnknown 占 0..2），
// 每个常量旁边都写了它对应第几个方法，改的时候对着头文件数一遍。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/** uia-list 的一项（字段名与宿主契约 ComputerUseUiaItem 一一对应，改一个字母就是两端脱钩） */
internal sealed class UiaItemInfo
{
    public int Ref;
    public string Name = "";
    public string ControlType = "";
    public string AutomationId = "";
    public string ClassName = "";
    public int X;
    public int Y;
    public int W;
    public int H;
    public List<string> Patterns = new List<string>();
    public bool Enabled;
    public bool Offscreen;
}

internal static class Uia
{
    // ---- 阈值与文案（纯函数部分由 --selftest-uia 覆盖，不启进程、不碰桌面）----

    /** uia-list 缺省的返回条数（多开几屏控件就够模型挑了；再多只是烧上下文） */
    internal const int DefaultMaxItems = 200;

    /** 上限：即使模型要 5000 条也只回 500（回执走文件 / TCP，不能让一条命令的回执失控） */
    internal const int MaxItemsLimit = 500;

    /** 看门狗（毫秒）：默认与宿主契约 COMPUTER_USE_UIA_TIMEOUT_MS 同一个数字 */
    internal const int DefaultTimeoutMs = 5000;
    internal const int MinTimeoutMs = 100;
    internal const int MaxTimeoutMs = 20000;

    /** 控件树的一轮读取：Descendants（TreeScope_Descendants = 0x4） */
    private const int TreeScopeDescendants = 0x4;

    /** 模式 id（UIAutomationClient.h 的 UIA_*PatternId） */
    private const int InvokePatternId = 10000;
    private const int ValuePatternId = 10002;
    private const int SelectionItemPatternId = 10010;

    /** 控件类型 id → 小写名字（只列常用档位；其余回 control-<id>，模型看得到原文） */
    internal static string ControlTypeName(int controlType)
    {
        switch (controlType)
        {
            case 50000: return "button";
            case 50001: return "calendar";
            case 50002: return "check-box";
            case 50003: return "combo-box";
            case 50004: return "edit";
            case 50005: return "hyperlink";
            case 50006: return "image";
            case 50007: return "list-item";
            case 50008: return "list";
            case 50009: return "menu";
            case 50010: return "menu-bar";
            case 50011: return "menu-item";
            case 50012: return "progress-bar";
            case 50013: return "radio-button";
            case 50014: return "scroll-bar";
            case 50015: return "slider";
            case 50016: return "spinner";
            case 50017: return "status-bar";
            case 50018: return "tab";
            case 50019: return "tab-item";
            case 50020: return "text";
            case 50021: return "tool-bar";
            case 50022: return "tool-tip";
            case 50023: return "tree";
            case 50024: return "tree-item";
            case 50025: return "custom";
            case 50026: return "group";
            case 50027: return "thumb";
            case 50028: return "data-grid";
            case 50029: return "data-item";
            case 50030: return "document";
            case 50031: return "split-button";
            case 50032: return "window";
            case 50033: return "pane";
            case 50034: return "header";
            case 50035: return "header-item";
            case 50036: return "table";
            case 50037: return "title-bar";
            case 50038: return "separator";
            case 50039: return "semantic-zoom";
            case 50040: return "app-bar";
            default: return "control-" + controlType.ToString(CultureInfo.InvariantCulture);
        }
    }

    /**
     * 布局 / 展示类控件：不列进 uia-list。
     *
     * 理由：树里绝大多数节点是容器（pane / group / window / title-bar）与纯展示件
     * （text / image / progress-bar / status-bar / tooltip），它们没有本车道能执行的动作；
     * 列出来只会把真正的按钮和输入框挤出 maxItems。「有名字的 pane」也不列：那是容器，
     * 模型对它的名字无法动作。**custom 不在此列**——自定义控件常常才是唯一可点的那一个。
     */
    internal static bool IsLayoutControlType(int controlType)
    {
        switch (controlType)
        {
            case 50006: // image
            case 50012: // progress-bar
            case 50014: // scroll-bar
            case 50017: // status-bar
            case 50020: // text
            case 50021: // tool-bar
            case 50022: // tool-tip
            case 50026: // group
            case 50027: // thumb
            case 50032: // window
            case 50033: // pane
            case 50034: // header
            case 50036: // table
            case 50037: // title-bar
            case 50038: // separator
                return true;
            default:
                return false;
        }
    }

    /**
     * uia-list 的过滤（**纯输入**，宿主上就能测）。
     *
     * 规则：是控件元素、不是布局/展示件、**有名字或 automationId**。
     *   - 名字与 id 都空：模型无从指认它（uia-act 也找不到），列出来等于噪音；
     *   - 不是 control element：raw view 里的实现细节节点；
     *   - 布局/展示类：见 IsLayoutControlType。
     * 注意「不在可见区」**不**是过滤项：滚动后才能点的按钮仍然要列（offscreen 标出来），
     * 否则模型会把「现在看不到」误判成「不存在」。
     */
    internal static bool IsListable(bool isControlElement, int controlType, string name, string automationId)
    {
        if (!isControlElement) return false;
        if (IsLayoutControlType(controlType)) return false;
        bool hasName = name != null && name.Trim().Length > 0;
        bool hasId = automationId != null && automationId.Trim().Length > 0;
        return hasName || hasId;
    }

    /** ref 是 1 基的（0 留给「没给」/ 解析失败），与模型的直觉一致 */
    internal static int RefOf(int zeroBasedIndex)
    {
        return zeroBasedIndex + 1;
    }

    /** ref → 数组下标。越界回 false（调用方拼「ref 已失效」的人话） */
    internal static bool TryResolveRef(int refNo, int count, out int index)
    {
        index = -1;
        if (refNo <= 0 || count <= 0) return false;
        if (refNo > count) return false;
        index = refNo - 1;
        return true;
    }

    /** 动作 → 真正要调的 UIA 模式名；focus 没有模式（回 "focus"），未知动作回 null */
    internal static string PatternNameForAction(string action)
    {
        if (action == "invoke") return "invoke";
        if (action == "setValue") return "value";
        if (action == "selection") return "selectionItem";
        if (action == "focus") return "focus";
        return null;
    }

    /** 动作 → 模式 id；-1 = 这个动作不需要模式（focus）或动作不认识 */
    internal static int PatternIdForAction(string action)
    {
        if (action == "invoke") return InvokePatternId;
        if (action == "setValue") return ValuePatternId;
        if (action == "selection") return SelectionItemPatternId;
        return -1;
    }

    /**
     * 规范动作名：去空白 + 大小写不敏感，但**回规范写法**（setValue 不能变成 setvalue，
     * 否则下面每一个 == "setValue" 的比较都会落空——2026-10-25 就是这么写出过一次 bug）。
     */
    internal static string NormalizeAction(string raw)
    {
        if (raw == null) return null;
        string value = raw.Trim().ToLowerInvariant();
        if (value == "setvalue") return "setValue";
        if (value == "invoke") return "invoke";
        if (value == "selection") return "selection";
        if (value == "focus") return "focus";
        return value;
    }

    /**
     * 动作参数校验（纯函数）。回 null = 通过；否则回一句给模型的人话。
     * 放在这里而不是散在执行路径上：同一套话术要能被 selftest 逐条钉住。
     */
    internal static string ValidateAct(string action, bool hasRef, bool hasName, bool hasValue)
    {
        if (action == null || PatternNameForAction(action) == null)
            return "action 必须是 invoke / setValue / selection / focus 之一（大小写不敏感）";
        if (action == "setValue")
        {
            if (!hasRef && !hasName) return "setValue 需要 ref 或 name 指定目标控件（先 uia-list 看有哪些）";
            if (!hasValue) return "setValue 需要 value（要写进控件的新文本；可以直接清空：value 传空字符串）";
            return null;
        }
        if (!hasRef && !hasName) return "uia-act 需要 ref（上一次 uia-list 的序号）或 name（控件名字的一部分）";
        return null;
    }

    /**
     * 不支持某个动作时给模型的话。三件事必须同时在：
     *   ① 是哪个动作不支持；② 它到底支持哪些（模型据此换动作）；③ 换成像素工具怎么走。
     */
    internal static string UnsupportedMessage(string action, string controlType, List<string> patterns)
    {
        string supported = patterns == null || patterns.Count == 0
            ? "没有任何本车道可用的模式"
            : JoinPatterns(patterns);
        return "这个控件不支持 " + action + "（" + controlType + "，它支持：" + supported + "）。"
            + "改用 computer_click / computer_type 的像素路径，或者先用 computer_screenshot 看一眼它现在的位置。";
    }

    private static string JoinPatterns(List<string> patterns)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < patterns.Count; i++)
        {
            if (i > 0) sb.Append("/");
            sb.Append(patterns[i]);
        }
        return sb.ToString();
    }

    /** maxItems：缺省 200，非正数 / 非整数报错，超过 500 静默截到 500（读操作，截断是安全的） */
    internal static string NormalizeMaxItems(string raw, out int maxItems)
    {
        maxItems = DefaultMaxItems;
        if (raw == null) return null;
        int parsed;
        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) || parsed <= 0)
            return "maxItems 必须是正整数（缺省 " + DefaultMaxItems + "，上限 " + MaxItemsLimit + "）";
        maxItems = parsed > MaxItemsLimit ? MaxItemsLimit : parsed;
        return null;
    }

    /** timeoutMs：缺省 5 秒；小于 100 / 非整数报错，大于 20 秒截到 20 秒 */
    internal static string NormalizeTimeout(string raw, out int timeoutMs)
    {
        timeoutMs = DefaultTimeoutMs;
        if (raw == null) return null;
        int parsed;
        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) || parsed < MinTimeoutMs)
            return "timeoutMs 必须是 >= " + MinTimeoutMs + " 的整数（毫秒，缺省 " + DefaultTimeoutMs + "，上限 " + MaxTimeoutMs + "）";
        timeoutMs = parsed > MaxTimeoutMs ? MaxTimeoutMs : parsed;
        return null;
    }

    /**
     * 看门狗到点时的回执文案。**必须**同时给出：发生了什么、为什么、下一步做什么。
     * 「UIA 调用超时」是验收时要能一眼搜到的词。
     */
    internal static string TimeoutMessage(string command, int timeoutMs)
    {
        return "目标窗口没有响应（UIA 调用超时：" + command + " 在 "
            + (timeoutMs / 1000.0).ToString("0.#", CultureInfo.InvariantCulture)
            + " 秒内没有返回）——它可能正忙，或者卡在一个模态对话框上。"
            + "不要对同一个控件重试：先用 computer_screenshot 看一眼它现在是什么状态；"
            + "如果只是要点一个按钮，改用 computer_click 的像素路径。";
    }

    /**
     * AutoSetFocus 的降级标记（**纯函数**，selftest 直接验）。
     * 回 null = 已关掉（不会抢焦点）；回字符串 = 关不掉，把这个原因交给回执与日志。
     */
    internal static string DescribeAutoSetFocus(bool disabled)
    {
        if (disabled) return null;
        return "AutoSetFocus 关不掉（这个系统的 UIA 客户端没有 IUIAutomation2）——"
            + "这条动作可能把目标窗口带到前台、抢走焦点；做完先用 computer_screenshot 确认谁在前面。";
    }

    /** UIA 的 HRESULT → 人话。**下一句动作比原因重要**：模型看不到 UI，只会照着做 */
    internal static string DescribeHresult(int hr, string context)
    {
        string code = "0x" + ((uint)hr).ToString("X8", CultureInfo.InvariantCulture);
        if (hr == unchecked((int)0x80040201))
            return "这个控件已经不在了（窗口内容变了 / 页面跳转了，UIA 回 UIA_E_ELEMENTNOTAVAILABLE）——重新 uia-list 再动作。";
        if (hr == unchecked((int)0x80040204))
            return "目标控件不支持这次操作（UIA_E_NOTSUPPORTED）——改用 computer_click / computer_type 的像素路径。";
        if (hr == unchecked((int)0x80131509))
            return "目标控件拒绝了这次操作（UIA_E_INVALIDOPERATION：它可能被禁用 / 只读，或正处在不可交互的状态）——"
                + "先用 computer_screenshot 看它的状态，必要时改用像素路径。";
        if (hr == unchecked((int)0x80070005))
            return "拒绝访问（E_ACCESSDENIED）：目标窗口以更高的权限运行，UIA 不能跨权限级别操作它——"
                + "改用 computer_click / computer_type 的像素路径。";
        return context + "失败（HRESULT " + code + "）——先用 computer_screenshot 看一眼，必要时改用像素路径。";
    }

    /** uia-list 一项的 JSON（纯函数：名字里的引号 / 反斜杠 / 中文都要正确转义） */
    internal static string ItemJson(UiaItemInfo item)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ref\":").Append(item.Ref)
            .Append(",\"name\":").Append(Program.JsonQuote(item.Name))
            .Append(",\"controlType\":").Append(Program.JsonQuote(item.ControlType))
            .Append(",\"automationId\":").Append(Program.JsonQuote(item.AutomationId))
            .Append(",\"className\":").Append(Program.JsonQuote(item.ClassName))
            .Append(",\"x\":").Append(item.X)
            .Append(",\"y\":").Append(item.Y)
            .Append(",\"w\":").Append(item.W)
            .Append(",\"h\":").Append(item.H)
            .Append(",\"patterns\":[");
        for (int i = 0; i < item.Patterns.Count; i++)
        {
            if (i > 0) json.Append(",");
            json.Append(Program.JsonQuote(item.Patterns[i]));
        }
        json.Append("],\"enabled\":").Append(item.Enabled ? "true" : "false")
            .Append(",\"offscreen\":").Append(item.Offscreen ? "true" : "false")
            .Append("}");
        return json.ToString();
    }

    // ---- COM：手写 interop（.NET 的 System.Windows.Automation 不暴露 AutoSetFocus）----
    //
    // 为什么不用 ComImport 接口：IUIAutomation 有 55 个方法、IUIAutomationElement 有 82 个，
    // 声明一份完整 vtable 要上百个占位方法，数错一个就是调错函数（在真实用户桌面上调错
    // 函数可能等于抢焦点）。这里改成**直接读 vtable 槽**：每个槽位号都写成
    // 「IUnknown 3 槽 + 第 N 个方法」的算式，旁边写着方法名，对着 UIAutomationClient.h 就能核。
    // 代价是返回 HRESULT 要自己判——这也正是我们想要的：错误要变成人话，而不是 COMException。

    private const uint CLSCTX_INPROC_SERVER = 1;
    private const uint COINIT_APARTMENTTHREADED = 2;

    // CLSID / IID（UIAutomationClient.h / uuids）
    private static Guid CLSID_CUIAutomation8 = new Guid("E22AD333-B25F-460C-83D0-0581107395C9");
    private static Guid CLSID_CUIAutomation = new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E");
    private static Guid IID_IUIAutomation = new Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE");
    private static Guid IID_IUIAutomation2 = new Guid("34723AFF-0C9D-49D0-9896-7AB52DF8CD8A");

    // vtable 槽（0 基；IUnknown 的 QueryInterface / AddRef / Release 占 0 / 1 / 2）
    private const int SlotRelease = 2;
    /** IUIAutomation 第 4 个方法 ElementFromHandle(HWND, IUIAutomationElement**) */
    private const int SlotElementFromHandle = 3 + 4 - 1;
    /** IUIAutomation 第 16 个方法 get_ControlViewCondition(IUIAutomationCondition**) */
    private const int SlotControlViewCondition = 3 + 16 - 1;
    /** IUIAutomation2 第 2 个方法 put_AutoSetFocus（前面是 IUIAutomation 的 55 个方法） */
    private const int SlotPutAutoSetFocus = 3 + 55 + 2 - 1;
    /** IUIAutomation2 第 1 个方法 get_AutoSetFocus（同上，用来读回确认） */
    private const int SlotGetAutoSetFocus = 3 + 55 + 1 - 1;
    /** IUIAutomationElement 第 1 个方法 SetFocus() */
    private const int SlotSetFocus = 3 + 1 - 1;
    /** IUIAutomationElement 第 4 个方法 FindAll(scope, condition, IUIAutomationElementArray**) */
    private const int SlotFindAll = 3 + 4 - 1;
    /** IUIAutomationElement 第 14 个方法 GetCurrentPattern(patternId, IUnknown**) */
    private const int SlotGetCurrentPattern = 3 + 14 - 1;
    /** IUIAutomationElement 第 19 个方法 get_CurrentControlType */
    private const int SlotCurrentControlType = 3 + 19 - 1;
    /** IUIAutomationElement 第 21 个方法 get_CurrentName */
    private const int SlotCurrentName = 3 + 21 - 1;
    /** IUIAutomationElement 第 26 个方法 get_CurrentIsEnabled */
    private const int SlotCurrentIsEnabled = 3 + 26 - 1;
    /** IUIAutomationElement 第 27 个方法 get_CurrentAutomationId */
    private const int SlotCurrentAutomationId = 3 + 27 - 1;
    /** IUIAutomationElement 第 28 个方法 get_CurrentClassName */
    private const int SlotCurrentClassName = 3 + 28 - 1;
    /** IUIAutomationElement 第 31 个方法 get_CurrentIsControlElement */
    private const int SlotCurrentIsControlElement = 3 + 31 - 1;
    /** IUIAutomationElement 第 36 个方法 get_CurrentIsOffscreen */
    private const int SlotCurrentIsOffscreen = 3 + 36 - 1;
    /** IUIAutomationElement 第 41 个方法 get_CurrentBoundingRectangle */
    private const int SlotCurrentBoundingRectangle = 3 + 41 - 1;
    /** IUIAutomationElementArray 第 1 个方法 get_Length */
    private const int SlotArrayLength = 3 + 1 - 1;
    /** IUIAutomationElementArray 第 2 个方法 GetElement(index, IUIAutomationElement**) */
    private const int SlotArrayGetElement = 3 + 2 - 1;
    /** IUIAutomationInvokePattern 第 1 个方法 Invoke() */
    private const int SlotInvoke = 3 + 1 - 1;
    /** IUIAutomationValuePattern 第 1 个方法 SetValue(BSTR) */
    private const int SlotSetValue = 3 + 1 - 1;
    /** IUIAutomationValuePattern 第 3 个方法 get_CurrentIsReadOnly */
    private const int SlotValueIsReadOnly = 3 + 3 - 1;
    /** IUIAutomationSelectionItemPattern 第 1 个方法 Select() */
    private const int SlotSelect = 3 + 1 - 1;

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint coInit);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint clsContext,
        ref Guid iid, out IntPtr instance);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // 每个 vtable 槽一个委托。签名必须与头文件里的参数逐个对应（HRESULT 我们自己判）。
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ReleaseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ElementFromHandleFn(IntPtr self, IntPtr hwnd, out IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetConditionFn(IntPtr self, out IntPtr condition);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int PutBoolFn(IntPtr self, int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetIntFn(IntPtr self, out int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetStringFn(IntPtr self, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetRectFn(IntPtr self, out RECT rect);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetFocusFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int FindAllFn(IntPtr self, int scope, IntPtr condition, out IntPtr array);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetCurrentPatternFn(IntPtr self, int patternId, out IntPtr pattern);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ArrayLengthFn(IntPtr self, out int length);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ArrayGetFn(IntPtr self, int index, out IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int InvokeFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetValueFn(IntPtr self, IntPtr value);

    /** 读槽位并包成委托（每次调用重读一次 vtable：对象换了也不会拿到旧函数指针） */
    private static T Slot<T>(IntPtr instance, int slot) where T : class
    {
        IntPtr vtable = Marshal.ReadIntPtr(instance);
        IntPtr fn = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
    }

    private static void Release(IntPtr instance)
    {
        if (instance == IntPtr.Zero) return;
        try { Slot<ReleaseFn>(instance, SlotRelease)(instance); }
        catch { }
    }

    // ---- STA 线程 + 看门狗 ---------------------------------------------------
    //
    // 一条常驻 STA 线程跑所有 UIA 调用；调用方在锁里等结果，最多等 timeoutMs。
    // 超时 = 那条线程卡在跨进程调用里：把它标记成「作废」（generation 变），**不等它**，
    // 下一条命令起一条新线程。老线程是后台线程：进程退出时不会挡路；它若自己解开了，
    // 循环发现 generation 变了就退出并 CoUninitialize。
    //
    // ref 映射（hwnd → 那一次 uia-list 的元素指针）只属于创建它的那条单元，所以线程作废时
    // 一并丢弃（不 Release：跨线程 Release 可能卡在代理的单元锁上，正是看门狗要避开的东西）。

    private sealed class Job
    {
        public Func<string> Body;
        public string Result;
        public Exception Error;
        public bool Done;
    }

    private static readonly object Gate = new object();
    private static Thread _worker;
    private static Job _pending;
    private static long _generation;
    private static Dictionary<long, List<IntPtr>> _refs = new Dictionary<long, List<IntPtr>>();

    /**
     * 跑一个 UIA 任务。timeoutMs 到点回 null 且 timedOut = true。
     * 异常从任务里原样抛回调用线程（由 Execute* 统一翻成人话）。
     */
    private static string Run(Func<string> body, int timeoutMs, out bool timedOut)
    {
        timedOut = false;
        Job job = new Job();
        job.Body = body;
        lock (Gate)
        {
            if (_worker == null)
            {
                _worker = new Thread(WorkerLoop);
                _worker.IsBackground = true;
                _worker.Name = "orbita-uia";
                try { _worker.SetApartmentState(ApartmentState.STA); }
                catch { } // 已经起来的线程不能再设单元状态；这里刚 new 出来，理论上不会失败
                _worker.Start();
            }
            _pending = job;
            Monitor.PulseAll(Gate);
            long deadline = DateTime.UtcNow.Ticks + timeoutMs * TimeSpan.TicksPerMillisecond;
            while (!job.Done)
            {
                long remainingMs = (deadline - DateTime.UtcNow.Ticks) / TimeSpan.TicksPerMillisecond;
                if (remainingMs <= 0) break;
                if (!Monitor.Wait(Gate, (int)remainingMs)) break;
            }
            if (!job.Done)
            {
                Program.Log("UIA：调用超时（" + timeoutMs + "ms），放弃当前 STA 线程；ref 映射作废");
                _generation++;
                _worker = null;
                _pending = null;
                _refs = new Dictionary<long, List<IntPtr>>();
                timedOut = true;
                return null;
            }
        }
        if (job.Error != null) throw job.Error;
        return job.Result;
    }

    private static void WorkerLoop()
    {
        long myGeneration;
        lock (Gate) { myGeneration = _generation; }
        int initHr = -1;
        try { initHr = CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED); }
        catch { }
        if (initHr < 0 && initHr != 1) // S_FALSE = 1 = 已经初始化过，可用
        {
            Program.Log("UIA：STA 线程 CoInitializeEx 失败（HRESULT 0x"
                + ((uint)initHr).ToString("X8", CultureInfo.InvariantCulture) + "）");
        }
        try
        {
            for (;;)
            {
                Job job;
                lock (Gate)
                {
                    while (_pending == null && myGeneration == _generation) Monitor.Wait(Gate);
                    if (myGeneration != _generation) return;
                    job = _pending;
                    _pending = null;
                }
                try { job.Result = job.Body(); }
                catch (Exception ex) { job.Error = ex; }
                lock (Gate)
                {
                    job.Done = true;
                    Monitor.PulseAll(Gate);
                }
            }
        }
        finally
        {
            try { CoUninitialize(); } catch { }
            // 这条线程上的 COM 对象随单元一起消失；不要从别的线程去 Release 它们
        }
    }

    // ---- UIA 客户端（每线程一份）--------------------------------------------

    [ThreadStatic]
    private static IntPtr _automation;
    [ThreadStatic]
    private static IntPtr _controlViewCondition;
    /** AutoSetFocus 的降级原因（null = 已关掉）。同一线程内只算一次 */
    [ThreadStatic]
    private static string _autoSetFocusWarning;
    [ThreadStatic]
    private static bool _autoSetFocusProbed;

    private static IntPtr EnsureAutomation()
    {
        if (_automation != IntPtr.Zero) return _automation;
        IntPtr automation;
        int hr = Com.CoCreate(CLSID_CUIAutomation8, IID_IUIAutomation, out automation);
        bool from8 = hr >= 0;
        if (!from8)
        {
            hr = Com.CoCreate(CLSID_CUIAutomation, IID_IUIAutomation, out automation);
            if (hr < 0)
                throw new InvalidOperationException("创建 UIAutomation 失败（CUIAutomation8 与 CUIAutomation 都不可用）——"
                    + "这台机器不支持 UI Automation 吗？改用 computer_screenshot / computer_click 的像素路径。");
        }
        _automation = automation;
        if (from8) ProbeAutoSetFocus(automation);
        else _autoSetFocusWarning = DescribeAutoSetFocus(false);
        if (_autoSetFocusWarning != null) Program.Log("UIA：" + _autoSetFocusWarning);
        return automation;
    }

    private static void ProbeAutoSetFocus(IntPtr automation)
    {
        if (_autoSetFocusProbed) return;
        _autoSetFocusProbed = true;
        IntPtr automation2;
        int hr = Marshal.QueryInterface(automation, ref IID_IUIAutomation2, out automation2);
        if (hr < 0 || automation2 == IntPtr.Zero)
        {
            _autoSetFocusWarning = DescribeAutoSetFocus(false);
            return;
        }
        try
        {
            int putHr = Slot<PutBoolFn>(automation2, SlotPutAutoSetFocus)(automation2, 0);
            if (putHr < 0)
            {
                _autoSetFocusWarning = DescribeAutoSetFocus(false);
                return;
            }
            // 读回确认：put 成功不代表值生效（某些实现是空实现），回执里的 autoSetFocus 必须是真值
            int value;
            int getHr = Slot<GetIntFn>(automation2, SlotGetAutoSetFocus)(automation2, out value);
            bool disabled = getHr >= 0 && value == 0;
            _autoSetFocusWarning = DescribeAutoSetFocus(disabled);
            if (disabled) Program.Log("UIA：AutoSetFocus 已置 false 并读回确认（IUIAutomation2 vtable 槽 "
                + SlotPutAutoSetFocus + "）");
        }
        finally
        {
            Release(automation2);
        }
    }

    private static IntPtr ElementFromHandle(IntPtr automation, IntPtr hwnd)
    {
        IntPtr element;
        int hr = Slot<ElementFromHandleFn>(automation, SlotElementFromHandle)(automation, hwnd, out element);
        if (hr < 0)
            throw new InvalidOperationException("这个窗口没有 UIA 元素（hwnd " + hwnd.ToInt64()
                + "，HRESULT 0x" + ((uint)hr).ToString("X8", CultureInfo.InvariantCulture)
                + "）——先用 win-list / computer_screenshot 确认它是哪个窗口。");
        return element;
    }

    private static IntPtr ControlViewCondition(IntPtr automation)
    {
        if (_controlViewCondition != IntPtr.Zero) return _controlViewCondition;
        IntPtr condition;
        int hr = Slot<GetConditionFn>(automation, SlotControlViewCondition)(automation, out condition);
        if (hr < 0)
            throw new InvalidOperationException("拿不到 UIA 的 ControlView 条件（HRESULT 0x"
                + ((uint)hr).ToString("X8", CultureInfo.InvariantCulture) + "）");
        _controlViewCondition = condition;
        return condition;
    }

    private static string ReadString(IntPtr element, int slot)
    {
        IntPtr bstr;
        int hr = Slot<GetStringFn>(element, slot)(element, out bstr);
        if (hr < 0 || bstr == IntPtr.Zero) return "";
        try { return Marshal.PtrToStringBSTR(bstr) ?? ""; }
        finally { Marshal.FreeBSTR(bstr); }
    }

    private static int ReadInt(IntPtr element, int slot)
    {
        int value;
        int hr = Slot<GetIntFn>(element, slot)(element, out value);
        return hr < 0 ? 0 : value;
    }

    private static bool ReadBool(IntPtr element, int slot)
    {
        return ReadInt(element, slot) != 0;
    }

    private static RECT ReadRect(IntPtr element)
    {
        RECT rect;
        rect.Left = 0;
        rect.Top = 0;
        rect.Right = 0;
        rect.Bottom = 0;
        int hr = Slot<GetRectFn>(element, SlotCurrentBoundingRectangle)(element, out rect);
        if (hr < 0)
        {
            rect.Left = 0;
            rect.Top = 0;
            rect.Right = 0;
            rect.Bottom = 0;
        }
        return rect;
    }

    /** 探测本车道能执行的三个模式（拿得到就 Release，只留名字） */
    private static List<string> ProbePatterns(IntPtr element)
    {
        List<string> patterns = new List<string>();
        int[] ids = new int[] { InvokePatternId, ValuePatternId, SelectionItemPatternId };
        string[] names = new string[] { "invoke", "value", "selectionItem" };
        for (int i = 0; i < ids.Length; i++)
        {
            IntPtr pattern;
            int hr = Slot<GetCurrentPatternFn>(element, SlotGetCurrentPattern)(element, ids[i], out pattern);
            if (hr >= 0 && pattern != IntPtr.Zero)
            {
                patterns.Add(names[i]);
                Release(pattern);
            }
        }
        return patterns;
    }

    private static IntPtr GetPattern(IntPtr element, int patternId, string action, string controlType,
        List<string> patterns)
    {
        IntPtr pattern;
        int hr = Slot<GetCurrentPatternFn>(element, SlotGetCurrentPattern)(element, patternId, out pattern);
        if (hr < 0 || pattern == IntPtr.Zero)
            throw new InvalidOperationException(UnsupportedMessage(action, controlType, patterns));
        return pattern;
    }

    // ---- 窗口解析（标题 → hwnd）-----------------------------------------------

    /**
     * 从请求里解出目标 hwnd：数字字段 hwnd 优先；否则按标题**不区分大小写包含匹配**，
     * 取 z 序最上面那个（与 win-shot 同一套语义，模型的心智模型不用换）。
     */
    private static IntPtr ResolveTarget(string raw, string command, out string error)
    {
        error = null;
        string hwndRaw = Program.ExtractNumber(raw, "hwnd");
        string titleQuery = Program.ExtractJsonString(raw, "title");
        if (titleQuery != null) titleQuery = titleQuery.Trim();

        if (hwndRaw != null)
        {
            long parsed;
            if (!long.TryParse(hwndRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) || parsed <= 0)
            {
                error = "hwnd 必须是正整数（win-list 回执里的那个）";
                return IntPtr.Zero;
            }
            IntPtr hwnd = new IntPtr(parsed);
            if (!IsWindow(hwnd))
            {
                error = "这个窗口已经不在了（hwnd " + parsed + "）——先用 win-list 看现在有哪些窗口";
                return IntPtr.Zero;
            }
            return hwnd;
        }
        if (titleQuery == null || titleQuery.Length == 0)
        {
            error = command + " 需要 hwnd 或 title（窗口标题的一部分，不区分大小写）——"
                + "先用 win-list 看现在有哪些窗口，或者用 computer_screenshot 带 window 先看一眼";
            return IntPtr.Zero;
        }
        IntPtr found = IntPtr.Zero;
        int matched = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            try
            {
                if (!IsWindowVisible(hwnd)) return true;
                string title = WindowTitle(hwnd);
                if (title.Length == 0) return true;
                if (title.IndexOf(titleQuery, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    matched++;
                    if (found == IntPtr.Zero) found = hwnd;
                }
            }
            catch
            {
                // 枚举途中的窗口消失：跳过它
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero)
        {
            error = "没找到标题包含「" + titleQuery + "」的窗口——先用 win-list 看现在有哪些窗口，或者直接传它的 hwnd";
            return IntPtr.Zero;
        }
        if (matched > 1) Program.Log(command + "：有 " + matched + " 个窗口标题包含「" + titleQuery
            + "」，用 z 序最上面那个（hwnd " + found.ToInt64() + "）");
        return found;
    }

    private static string WindowTitle(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(300);
        int len = GetWindowText(hwnd, sb, sb.Capacity);
        return len <= 0 ? "" : sb.ToString().Trim();
    }

    // ---- uia-list ------------------------------------------------------------

    /**
     * uia-list {hwnd?, title?, maxItems?}
     *   → `{ok:true,hwnd,window:{title,className},items:[...],truncated}`
     *
     * 只读：从 hwnd 取 UIA 根元素 → 在 ControlView 里 FindAll(Descendants) → 过滤 →
     * 读名字/类型/id/矩形/可用性 → 探测三个模式。全程不 SetFocus、不调任何写模式，
     * 也不把窗口带到前台（AutoSetFocus 只影响模式调用，读属性不受它影响）。
     */
    internal static string ExecuteList(string raw)
    {
        int maxItems;
        string bad = NormalizeMaxItems(Program.ExtractNumber(raw, "maxItems"), out maxItems);
        if (bad != null) return Fail(bad);
        string error;
        IntPtr hwnd = ResolveTarget(raw, "uia-list", out error);
        if (error != null) return Fail(error);

        int timeoutMs;
        string badTimeout = NormalizeTimeout(Program.ExtractNumber(raw, "timeoutMs"), out timeoutMs);
        if (badTimeout != null) return Fail(badTimeout);

        bool timedOut;
        string json;
        try
        {
            json = Run(delegate { return BuildListJson(hwnd, maxItems); }, timeoutMs, out timedOut);
        }
        catch (Exception ex)
        {
            Program.Log("uia-list 失败：" + ex.Message);
            return Fail(ex.Message);
        }
        if (timedOut) return Fail(TimeoutMessage("uia-list", timeoutMs));
        return json;
    }

    private static string BuildListJson(IntPtr hwnd, int maxItems)
    {
        IntPtr automation = EnsureAutomation();
        IntPtr window = ElementFromHandle(automation, hwnd);
        try
        {
            string windowTitle = ReadString(window, SlotCurrentName);
            if (windowTitle.Length == 0) windowTitle = WindowTitle(hwnd);
            string windowClass = ReadString(window, SlotCurrentClassName);

            IntPtr array;
            int findHr = Slot<FindAllFn>(window, SlotFindAll)(window, TreeScopeDescendants,
                ControlViewCondition(automation), out array);
            if (findHr < 0 || array == IntPtr.Zero)
                throw new InvalidOperationException("读不到这个窗口的控件树（FindAll HRESULT 0x"
                    + ((uint)findHr).ToString("X8", CultureInfo.InvariantCulture)
                    + "）——它可能不是标准窗口，改用 computer_screenshot 看一眼");

            List<IntPtr> retained = new List<IntPtr>();
            StringBuilder items = new StringBuilder();
            bool truncated = false;
            try
            {
                int length;
                int lenHr = Slot<ArrayLengthFn>(array, SlotArrayLength)(array, out length);
                int total = lenHr < 0 ? 0 : length;
                for (int i = 0; i < total; i++)
                {
                    IntPtr element;
                    int hr = Slot<ArrayGetFn>(array, SlotArrayGetElement)(array, i, out element);
                    if (hr < 0 || element == IntPtr.Zero) continue;
                    bool keep = false;
                    try
                    {
                        keep = CollectItem(element, retained.Count, ref items);
                        if (keep)
                        {
                            retained.Add(element);
                            if (retained.Count >= maxItems)
                            {
                                truncated = i + 1 < total;
                                break;
                            }
                            // 已经拼进 JSON 的元素指针要留着给 uia-act 用；不 Release
                            continue;
                        }
                    }
                    finally
                    {
                        if (!keep) Release(element);
                    }
                }
            }
            finally
            {
                Release(array);
            }

            ReplaceRefs(hwnd, retained);

            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"hwnd\":").Append(hwnd.ToInt64())
                .Append(",\"window\":{\"title\":").Append(Program.JsonQuote(windowTitle))
                .Append(",\"className\":").Append(Program.JsonQuote(windowClass))
                .Append("},\"items\":[").Append(items.ToString())
                .Append("],\"truncated\":").Append(truncated ? "true" : "false").Append("}");
            Program.Log("uia-list hwnd " + hwnd.ToInt64() + "「" + windowTitle + "」：" + retained.Count
                + " 个可动作控件" + (truncated ? "（还有更多，已截断）" : ""));
            return json.ToString();
        }
        finally
        {
            Release(window);
        }
    }

    /**
     * 一个候选元素要不要留下；留下就把它拼进 items（ref = retainedCount + 1）。
     * 返回 false 时调用方负责 Release（不能在这里放：`keep` 为 true 的指针要留给 ref 映射）。
     */
    private static bool CollectItem(IntPtr element, int retainedCount, ref StringBuilder items)
    {
        bool isControl = ReadBool(element, SlotCurrentIsControlElement);
        int controlTypeId = ReadInt(element, SlotCurrentControlType);
        string name = ReadString(element, SlotCurrentName);
        string automationId = ReadString(element, SlotCurrentAutomationId);
        if (!IsListable(isControl, controlTypeId, name, automationId)) return false;

        UiaItemInfo info = new UiaItemInfo();
        info.Ref = RefOf(retainedCount);
        info.Name = name;
        info.ControlType = ControlTypeName(controlTypeId);
        info.AutomationId = automationId;
        info.ClassName = ReadString(element, SlotCurrentClassName);
        RECT rect = ReadRect(element);
        info.X = rect.Left;
        info.Y = rect.Top;
        info.W = rect.Right > rect.Left ? rect.Right - rect.Left : 0;
        info.H = rect.Bottom > rect.Top ? rect.Bottom - rect.Top : 0;
        info.Enabled = ReadBool(element, SlotCurrentIsEnabled);
        info.Offscreen = ReadBool(element, SlotCurrentIsOffscreen);
        info.Patterns = ProbePatterns(element);

        if (retainedCount > 0) items.Append(",");
        items.Append(ItemJson(info));
        return true;
    }

    /** 用新一次 uia-list 的结果替换 ref 映射（旧指针在**本线程**上 Release，是安全的） */
    private static void ReplaceRefs(IntPtr hwnd, List<IntPtr> retained)
    {
        List<IntPtr> old;
        if (_refs.TryGetValue(hwnd.ToInt64(), out old))
        {
            for (int i = 0; i < old.Count; i++) Release(old[i]);
        }
        _refs[hwnd.ToInt64()] = retained;
    }

    // ---- uia-act -------------------------------------------------------------

    /**
     * uia-act {hwnd?, title?, ref?, name?, action, value?, timeoutMs?}
     *   → `{ok:true,hwnd,action,usedPattern,name,controlType,focused,autoSetFocus,elapsedMs}`
     *
     * 目标：ref（同一次 uia-list 的元素指针）优先，否则按 name 现枚举一遍（精确匹配优先，
     * 其次包含匹配）。动作按契约的四条走；模式取不到就回人话，不静默失败。
     */
    internal static string ExecuteAct(string raw)
    {
        string action = NormalizeAction(Program.ExtractJsonString(raw, "action"));
        string value = Program.ExtractJsonString(raw, "value");
        string refRaw = Program.ExtractNumber(raw, "ref");
        string name = Program.ExtractJsonString(raw, "name");
        if (name != null) name = name.Trim();

        int refNo = 0;
        bool hasRef = false;
        if (refRaw != null)
        {
            if (!int.TryParse(refRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out refNo) || refNo <= 0)
                return Fail("ref 必须是正整数（上一次 uia-list 回执里的那个序号）");
            hasRef = true;
        }
        bool hasName = name != null && name.Length > 0;
        string bad = ValidateAct(action, hasRef, hasName, value != null);
        if (bad != null) return Fail(bad);

        string error;
        IntPtr hwnd = ResolveTarget(raw, "uia-act", out error);
        if (error != null) return Fail(error);

        int timeoutMs;
        string badTimeout = NormalizeTimeout(Program.ExtractNumber(raw, "timeoutMs"), out timeoutMs);
        if (badTimeout != null) return Fail(badTimeout);

        bool timedOut;
        string json;
        try
        {
            json = Run(delegate
            {
                return BuildActJson(hwnd, action, hasRef, refNo, hasName, name, value);
            }, timeoutMs, out timedOut);
        }
        catch (Exception ex)
        {
            Program.Log("uia-act 失败：" + ex.Message);
            return Fail(ex.Message);
        }
        if (timedOut) return Fail(TimeoutMessage("uia-act", timeoutMs));
        return json;
    }

    private static string BuildActJson(IntPtr hwnd, string action, bool hasRef, int refNo, bool hasName,
        string name, string value)
    {
        Stopwatch clock = Stopwatch.StartNew();
        IntPtr automation = EnsureAutomation();
        IntPtr window = ElementFromHandle(automation, hwnd);
        IntPtr target = IntPtr.Zero;
        bool ownsTarget = false;
        try
        {
            if (hasRef)
            {
                List<IntPtr> list;
                if (!_refs.TryGetValue(hwnd.ToInt64(), out list) || list.Count == 0)
                    throw new InvalidOperationException("ref " + refNo + " 已经失效（这个窗口没有可用的 uia-list 快照）——"
                        + "重新 uia-list 一次再用新的 ref。");
                int index;
                if (!TryResolveRef(refNo, list.Count, out index))
                    throw new InvalidOperationException("ref " + refNo + " 超出范围（这个窗口上一次 uia-list 只回了 "
                        + list.Count + " 个控件）——重新 uia-list 看新的序号。");
                target = list[index];
            }
            else
            {
                target = FindByName(window, automation, name);
                if (target == IntPtr.Zero)
                    throw new InvalidOperationException("没找到名字包含「" + name + "」的控件——"
                        + "先用 uia-list 看这个窗口里有哪些控件（name 是不区分大小写的包含匹配）。");
                ownsTarget = true;
            }

            string targetName = ReadString(target, SlotCurrentName);
            string controlType = ControlTypeName(ReadInt(target, SlotCurrentControlType));
            List<string> patterns = ProbePatterns(target);

            int hr;
            string usedPattern;
            bool focused = false;
            if (action == "focus")
            {
                hr = Slot<SetFocusFn>(target, SlotSetFocus)(target);
                usedPattern = "focus";
                focused = true;
            }
            else
            {
                int patternId = PatternIdForAction(action);
                IntPtr pattern = GetPattern(target, patternId, action, controlType, patterns);
                try
                {
                    if (action == "invoke")
                    {
                        hr = Slot<InvokeFn>(pattern, SlotInvoke)(pattern);
                        usedPattern = "invoke";
                    }
                    else if (action == "setValue")
                    {
                        bool readOnly = ReadBool(pattern, SlotValueIsReadOnly);
                        if (readOnly)
                            throw new InvalidOperationException("这个控件是只读的（ValuePattern 报告 CurrentIsReadOnly）——"
                                + "它不接受设值；改用 computer_click / computer_type 的像素路径，或者换一个输入框。");
                        IntPtr bstr = Marshal.StringToBSTR(value);
                        try { hr = Slot<SetValueFn>(pattern, SlotSetValue)(pattern, bstr); }
                        finally { Marshal.FreeBSTR(bstr); }
                        usedPattern = "value";
                    }
                    else
                    {
                        hr = Slot<InvokeFn>(pattern, SlotSelect)(pattern);
                        usedPattern = "selectionItem";
                    }
                }
                finally
                {
                    Release(pattern);
                }
            }
            if (hr < 0) throw new InvalidOperationException(DescribeHresult(hr, "UIA 动作 " + action + " "));

            string warning = _autoSetFocusWarning;
            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"hwnd\":").Append(hwnd.ToInt64())
                .Append(",\"action\":").Append(Program.JsonQuote(action))
                .Append(",\"usedPattern\":").Append(Program.JsonQuote(usedPattern))
                .Append(",\"name\":").Append(Program.JsonQuote(targetName))
                .Append(",\"controlType\":").Append(Program.JsonQuote(controlType))
                .Append(",\"focused\":").Append(focused ? "true" : "false")
                .Append(",\"autoSetFocus\":").Append(warning == null ? "true" : "false")
                .Append(",\"elapsedMs\":").Append(clock.ElapsedMilliseconds);
            if (warning != null) json.Append(",\"autoSetFocusWarning\":").Append(Program.JsonQuote(warning));
            json.Append("}");
            Program.Log("uia-act hwnd " + hwnd.ToInt64() + " " + action + " → 「" + targetName + "」（"
                + controlType + "，模式 " + usedPattern + "，autoSetFocus=" + (warning == null) + "，"
                + clock.ElapsedMilliseconds + "ms）");
            return json.ToString();
        }
        finally
        {
            if (ownsTarget) Release(target);
            Release(window);
        }
    }

    /**
     * 按名字找控件：现枚举一遍（ref 映射只由 uia-list 维护，这里不覆盖它）。
     * 精确匹配（不区分大小写）优先，其次包含匹配；都取遍历顺序里的第一个。
     */
    private static IntPtr FindByName(IntPtr window, IntPtr automation, string name)
    {
        IntPtr array;
        int hr = Slot<FindAllFn>(window, SlotFindAll)(window, TreeScopeDescendants,
            ControlViewCondition(automation), out array);
        if (hr < 0 || array == IntPtr.Zero) return IntPtr.Zero;
        IntPtr contains = IntPtr.Zero;
        try
        {
            int length;
            int lenHr = Slot<ArrayLengthFn>(array, SlotArrayLength)(array, out length);
            int total = lenHr < 0 ? 0 : length;
            for (int i = 0; i < total; i++)
            {
                IntPtr element;
                int getHr = Slot<ArrayGetFn>(array, SlotArrayGetElement)(array, i, out element);
                if (getHr < 0 || element == IntPtr.Zero) continue;
                string candidate = ReadString(element, SlotCurrentName);
                bool isControl = ReadBool(element, SlotCurrentIsControlElement);
                bool usable = isControl && candidate.Length > 0;
                if (usable && string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase))
                {
                    // 精确命中：直接交出去（不 Release）；之前留着的包含命中要放掉
                    Release(contains);
                    contains = IntPtr.Zero;
                    return element;
                }
                if (usable && contains == IntPtr.Zero
                    && candidate.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    contains = element; // 先留着，看后面有没有精确命中
                    continue;
                }
                Release(element);
            }
            return contains;
        }
        finally
        {
            Release(array);
        }
    }

    /**
     * 客户端自检（--selftest-uia-client）：只创建 IUIAutomation 客户端对象、把 AutoSetFocus
     * 置 false 并读回确认，**不取任何窗口、不调任何模式**。
     *
     * 为什么单独一条：com/CLSID/IID/vtable 槽是这条路唯一的硬风险（数错一格就是调错函数），
     * 而纯函数测不到它；这条路径只动我们自己的 in-proc 对象，不碰用户桌面，宿主上跑是安全的。
     * 真机上「能不能列出某个窗口的控件、能不能点中按钮」仍然只能在沙箱里验。
     */
    internal static int RunClientSelfTest()
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        bool timedOut;
        string json;
        try
        {
            json = Run(delegate
            {
                EnsureAutomation();
                string warning = _autoSetFocusWarning;
                return "{\"ok\":true,\"autoSetFocus\":" + (warning == null ? "true" : "false")
                    + (warning == null ? "" : ",\"warning\":" + Program.JsonQuote(warning)) + "}";
            }, DefaultTimeoutMs, out timedOut);
        }
        catch (Exception ex)
        {
            Console.WriteLine(Fail("UIA 客户端初始化失败：" + ex.Message));
            return 1;
        }
        if (timedOut)
        {
            Console.WriteLine(Fail(TimeoutMessage("uia-client", DefaultTimeoutMs)));
            return 1;
        }
        Console.WriteLine(json);
        return json.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0 ? 0 : 1;
    }

    // ---- 自测（--selftest-uia：纯函数，不启进程、不碰桌面）--------------------

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // ① ref 编号与查找：1 基、越界拒绝
        CheckNumber(failures, ref cases, "ref 从 1 起（下标 0）", "1", RefOf(0).ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "ref 从 1 起（下标 4）", "5", RefOf(4).ToString(CultureInfo.InvariantCulture));
        int index;
        CheckTrue(failures, ref cases, "ref 1 → 下标 0", TryResolveRef(1, 3, out index) && index == 0);
        CheckTrue(failures, ref cases, "ref 3 → 下标 2", TryResolveRef(3, 3, out index) && index == 2);
        CheckTrue(failures, ref cases, "ref 0 拒绝", !TryResolveRef(0, 3, out index));
        CheckTrue(failures, ref cases, "ref 负数拒绝", !TryResolveRef(-2, 3, out index));
        CheckTrue(failures, ref cases, "ref 越界拒绝（4 / 3）", !TryResolveRef(4, 3, out index));
        CheckTrue(failures, ref cases, "空列表拒绝任何 ref", !TryResolveRef(1, 0, out index));

        // ② 动作 → 模式：哪种控件用哪个 pattern 的唯一出处
        CheckString(failures, ref cases, "invoke → invoke 模式", "invoke", PatternNameForAction("invoke"));
        CheckString(failures, ref cases, "setValue → value 模式", "value", PatternNameForAction("setValue"));
        CheckString(failures, ref cases, "selection → selectionItem 模式", "selectionItem", PatternNameForAction("selection"));
        CheckString(failures, ref cases, "focus 不需要模式", "focus", PatternNameForAction("focus"));
        CheckTrue(failures, ref cases, "未知动作没有模式", PatternNameForAction("click") == null);
        CheckNumber(failures, ref cases, "invoke 用 UIA_InvokePatternId", "10000",
            PatternIdForAction("invoke").ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "setValue 用 UIA_ValuePatternId", "10002",
            PatternIdForAction("setValue").ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "selection 用 UIA_SelectionItemPatternId", "10010",
            PatternIdForAction("selection").ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "focus 没有模式 id", "-1",
            PatternIdForAction("focus").ToString(CultureInfo.InvariantCulture));
        CheckString(failures, ref cases, "动作名规范化（大小写 / 空白）", "invoke", NormalizeAction("  Invoke "));
        CheckString(failures, ref cases, "动作名规范化：setValue 回规范写法（不是全小写）", "setValue",
            NormalizeAction(" SetValue "));
        CheckString(failures, ref cases, "规范化之后能选中 value 模式", "value",
            PatternNameForAction(NormalizeAction("SETVALUE")));
        CheckTrue(failures, ref cases, "规范化之后 setValue 校验仍认 value", ValidateAct("setValue", true, false, true) == null);

        // ③ 参数校验：错在哪儿就说哪儿
        CheckTrue(failures, ref cases, "缺 action → 报四个动作",
            ValidateAct(null, false, true, true) != null
            && ValidateAct(null, false, true, true).IndexOf("invoke / setValue / selection / focus", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "未知 action → 拒绝", ValidateAct("click", false, true, true) != null);
        CheckTrue(failures, ref cases, "invoke 缺 ref 与 name → 拒绝",
            ValidateAct("invoke", false, false, false) != null);
        CheckTrue(failures, ref cases, "invoke 给了 ref → 通过", ValidateAct("invoke", true, false, false) == null);
        CheckTrue(failures, ref cases, "invoke 给了 name → 通过", ValidateAct("invoke", false, true, false) == null);
        CheckTrue(failures, ref cases, "setValue 缺 value → 拒绝（文案点名 value）",
            ValidateAct("setValue", true, false, false) != null
            && ValidateAct("setValue", true, false, false).IndexOf("value", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "setValue 空串也算给了 value", ValidateAct("setValue", true, false, true) == null);
        CheckTrue(failures, ref cases, "focus 也要 ref 或 name", ValidateAct("focus", false, false, false) != null);

        // ④ 不支持模式的文案：动作、它支持什么、像素退路，三件都在
        List<string> valueOnly = new List<string>();
        valueOnly.Add("value");
        string unsupported = UnsupportedMessage("invoke", "edit", valueOnly);
        CheckTrue(failures, ref cases, "不支持文案点名动作",
            unsupported.IndexOf("不支持 invoke", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "不支持文案点名它支持的模式",
            unsupported.IndexOf("它支持：value", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "不支持文案给出像素退路",
            unsupported.IndexOf("computer_click", StringComparison.Ordinal) >= 0
            && unsupported.IndexOf("computer_type", StringComparison.Ordinal) >= 0);
        string none = UnsupportedMessage("selection", "pane", new List<string>());
        CheckTrue(failures, ref cases, "一个模式都没有时也说清楚",
            none.IndexOf("没有任何本车道可用的模式", StringComparison.Ordinal) >= 0);

        // ⑤ 控件类型名与布局过滤
        CheckString(failures, ref cases, "50000 → button", "button", ControlTypeName(50000));
        CheckString(failures, ref cases, "50004 → edit", "edit", ControlTypeName(50004));
        CheckString(failures, ref cases, "50019 → tab-item", "tab-item", ControlTypeName(50019));
        CheckString(failures, ref cases, "未知类型保留 id", "control-59999", ControlTypeName(59999));
        CheckTrue(failures, ref cases, "有名字的按钮 → 列",
            IsListable(true, 50000, "确定", ""));
        CheckTrue(failures, ref cases, "只有 automationId 也列",
            IsListable(true, 50004, "", "search-box"));
        CheckTrue(failures, ref cases, "名字与 id 都空 → 不列",
            !IsListable(true, 50000, "  ", ""));
        CheckTrue(failures, ref cases, "布局 pane 有名字也不列",
            !IsListable(true, 50033, "内容面板", ""));
        CheckTrue(failures, ref cases, "纯展示 text 不列",
            !IsListable(true, 50020, "一段说明文字", ""));
        CheckTrue(failures, ref cases, "不是 control element → 不列",
            !IsListable(false, 50000, "隐藏按钮", ""));
        CheckTrue(failures, ref cases, "custom 有名字要列（自定义控件常常才是唯一可点的）",
            IsListable(true, 50025, "自绘按钮", ""));

        // ⑥ maxItems / timeoutMs 的边界
        int maxItems;
        CheckTrue(failures, ref cases, "maxItems 缺省 200",
            NormalizeMaxItems(null, out maxItems) == null && maxItems == 200);
        CheckTrue(failures, ref cases, "maxItems 0 → 拒绝",
            NormalizeMaxItems("0", out maxItems) != null);
        CheckTrue(failures, ref cases, "maxItems 负数 → 拒绝",
            NormalizeMaxItems("-3", out maxItems) != null);
        CheckTrue(failures, ref cases, "maxItems 非数字 → 拒绝",
            NormalizeMaxItems("abc", out maxItems) != null);
        CheckTrue(failures, ref cases, "maxItems 50 → 50",
            NormalizeMaxItems("50", out maxItems) == null && maxItems == 50);
        CheckTrue(failures, ref cases, "maxItems 超过上限截到 500",
            NormalizeMaxItems("9999", out maxItems) == null && maxItems == 500);

        int timeoutMs;
        CheckTrue(failures, ref cases, "timeoutMs 缺省 5000",
            NormalizeTimeout(null, out timeoutMs) == null && timeoutMs == 5000);
        CheckTrue(failures, ref cases, "timeoutMs 50 → 拒绝",
            NormalizeTimeout("50", out timeoutMs) != null);
        CheckTrue(failures, ref cases, "timeoutMs 1000 → 1000",
            NormalizeTimeout("1000", out timeoutMs) == null && timeoutMs == 1000);
        CheckTrue(failures, ref cases, "timeoutMs 超过上限截到 20000",
            NormalizeTimeout("999999", out timeoutMs) == null && timeoutMs == 20000);
        CheckTrue(failures, ref cases, "timeoutMs 非数字 → 拒绝",
            NormalizeTimeout("abc", out timeoutMs) != null);

        // ⑦ 超时文案：验收时要能一眼搜到「UIA 调用超时」，模型要能照着换路
        string timeout = TimeoutMessage("uia-act", 5000);
        CheckTrue(failures, ref cases, "超时文案含「目标窗口没有响应（UIA 调用超时」",
            timeout.IndexOf("目标窗口没有响应（UIA 调用超时", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "超时文案给出先截图的下一步",
            timeout.IndexOf("computer_screenshot", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "超时文案给出像素退路",
            timeout.IndexOf("computer_click", StringComparison.Ordinal) >= 0);

        // ⑧ AutoSetFocus 的降级标记
        CheckTrue(failures, ref cases, "关掉 AutoSetFocus → 没有警告", DescribeAutoSetFocus(true) == null);
        string warning = DescribeAutoSetFocus(false);
        CheckTrue(failures, ref cases, "关不掉 → 警告点名 AutoSetFocus",
            warning != null && warning.IndexOf("AutoSetFocus", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "关不掉 → 警告说清会抢焦点",
            warning != null && warning.IndexOf("抢", StringComparison.Ordinal) >= 0);

        // ⑨ HRESULT → 人话
        CheckTrue(failures, ref cases, "元素失效 → 让人重新 uia-list",
            DescribeHresult(unchecked((int)0x80040201), "动作").IndexOf("重新 uia-list", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "不支持 → 给像素退路",
            DescribeHresult(unchecked((int)0x80040204), "动作").IndexOf("computer_click", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "拒绝访问 → 说清权限级别",
            DescribeHresult(unchecked((int)0x80070005), "动作").IndexOf("权限", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "未知 HRESULT → 带十六进制码",
            DescribeHresult(unchecked((int)0x80004005), "动作").IndexOf("0x80004005", StringComparison.Ordinal) >= 0);

        // ⑩ 回执 JSON：名字里的引号 / 反斜杠 / 中文都要转义正确
        UiaItemInfo sample = new UiaItemInfo();
        sample.Ref = 2;
        sample.Name = "保存\"并关闭\\";
        sample.ControlType = "button";
        sample.AutomationId = "save";
        sample.ClassName = "Button";
        sample.X = 10;
        sample.Y = 20;
        sample.W = 30;
        sample.H = 40;
        sample.Patterns.Add("invoke");
        sample.Enabled = true;
        sample.Offscreen = false;
        string itemJson = ItemJson(sample);
        CheckTrue(failures, ref cases, "项 JSON 带 ref / 坐标",
            itemJson.IndexOf("\"ref\":2", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"x\":10", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"h\":40", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "项 JSON 的模式数组",
            itemJson.IndexOf("\"patterns\":[\"invoke\"]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "项 JSON 转义引号与反斜杠",
            itemJson.IndexOf("保存\\\"并关闭\\\\", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "项 JSON 的布尔与中文都原样",
            itemJson.IndexOf("\"enabled\":true", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"offscreen\":false", StringComparison.Ordinal) >= 0);

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    private static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
    {
        Program.CheckTrue(failures, ref cases, name, condition);
    }

    private static void CheckString(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        Program.CheckString(failures, ref cases, name, expected, actual);
    }

    private static void CheckNumber(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        Program.CheckNumber(failures, ref cases, name, expected, actual);
    }

    /** 失败回执（与其它命令同形；error 已经是给模型读的人话） */
    private static string Fail(string error)
    {
        return "{\"ok\":false,\"error\":" + Program.JsonQuote(error) + "}";
    }

    /** CoCreateInstance 的小包装：返回 HRESULT（不抛），调用点自己决定怎么解释失败 */
    private static class Com
    {
        internal static int CoCreate(Guid clsid, Guid iid, out IntPtr instance)
        {
            Guid localClsid = clsid;
            Guid localIid = iid;
            return CoCreateInstance(ref localClsid, IntPtr.Zero, CLSCTX_INPROC_SERVER, ref localIid, out instance);
        }
    }
}
