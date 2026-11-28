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
// 支持的动作只有三条，与宿主契约 ComputerUseUiaAction 一一对应：
//   invoke    → InvokePattern.Invoke()           按钮 / 链接 / 菜单项 / 标签页
//   setValue  → ValuePattern.SetValue(BSTR)      输入框 / 文档（直接设值，不经 IME）
//   selection → SelectionItemPattern.Select()    列表项 / 标签项 / 菜单项的单选
//
// **focus（Element.SetFocus）被删掉了**（2026-10-27）：它是这条车道唯一的桌面级副作用——
// 键盘焦点是整块桌面共享的单一资源，A 一次 focus 就会把并发会话的 SendInput 吸进被聚焦的
// 控件。而车道的前提就是「不碰桌面」，所以宁可少一个动作，也不留一条能打破前提的边。
// 要移动焦点用 computer_click 点到目标，或者直接 invoke（通常同时给焦点）/ setValue
// （不需要焦点）；被拒时 ValidateAct 回的话里带着这句替代建议。
//
// 不支持的控件（模式取不到）一律回人话，并点名它支持哪些模式、改用 computer_click /
// computer_type 的像素路径——模型看不见 UI，不会自己想到这一点。
//
// 0.12.0 起 uia-list 多干一件事：读 UIA_IsPasswordPropertyId（30019）并在**过滤之前**把
// 每个密码框的 BoundingRectangle 记进进程内缓存（Mask.PasswordRects，按 hwnd 索引、30s 过期）。
// 为什么要在过滤之前：Chromium 的 <input type=password> 常常既没 name 也没 automationId，
// 它会被 IsListable 滤掉——而它正是截图遮罩唯一必须命中的东西。每一项的 isPassword 字段也
// 因此有了：模型要知道「这条是密码框，别往里写秘密」。
//
// 0.14.0 起 ref 带**代次**、uia-list 能只回**变化**（这一刀解决两个真实痛点）：
//   ① 每次都回全量：长任务里模型每轮读一遍几乎相同的清单，白烧上下文。现在每一项的 ref 写成
//      "g<代次>:r<序号>"，并且 uia-list 可以带 since 只回变化（新增 / 消失 / 改了 / unchanged 计数）。
//   ② ref 是位置式的：窗口一变（页面跳转、弹框、列表滚动），旧 ref 指向的就是**另一个控件**，
//      而模型看不出来。现在 uia-act 要求 ref 的代次 == 该窗口**最近一次** list 的代次，旧代次
//      明确拒绝并让它重新 list——宁可多一次往返，也不能静默点到别的东西上。
//   控件身份用 UIA 的 RuntimeId（IUIAutomationElement::GetRuntimeId）当稳定 id，取不到时退回
//   「ControlType + ClassName + Name + AutomationId」的哈希（本代内重名再补 #2 / #3）。diff 只按它比。
//   每个窗口只留最近 5 代（UiaHistoryStore.Retain），更早的 since 回全量并说明记不住了。
//
// 0.15.0 起 setValue **自己带证据**：设完之后读回该元素的当前值（ValuePattern.Current.Value
//   → TextPattern.DocumentRange.GetText），相等回 confirmed、不等回 suspected_noop，两者都带
//   evidence{kind:"value",detail}；读回拿不到回 unverifiable（不猜成任何一档）。
//   为什么：以前桥从不发证据，宿主那道「没证据不许 confirmed」的闸门把每一条 setValue 都降成
//   unverifiable，模型永远等不到确认。密码框的 evidence 只写「一致 / 不一致」，**绝不带值本身**。
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
    /** 这一条在**自己那一代**清单里的序号（1 基）。只对这一代有效 */
    public int Ref;
    /** 这一条属于第几代清单（同一窗口每 list 一次 +1）。uia-act 校验它 */
    public int Generation;
    /** ref 的对外写法 "g12:r3"：模型照抄，不要自己拼 */
    public string RefToken = "";
    /** 稳定 id（RuntimeId 优先，退化为属性哈希）。同一棵树里两次 list 必须一致；diff 只按它比 */
    public string StableId = "";
    /** diff 专用（全量回执里是 null）：added = 新出现的，changed = 还在但变了 */
    public string Change;
    /** Change == "changed" 时变了哪些字段（name / patterns / enabled / offscreen / rect / ...） */
    public List<string> ChangedFields;
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
    /** 密码框（UIA_IsPasswordPropertyId = 30019）。宿主据此把这一行标成 password，截图遮罩也靠它 */
    public bool IsPassword;
}

/**
 * 一代清单的快照。**只留元数据**：元素指针（Pointers）只在它是最新一代时有效——
 * 新一代 list 一发生，上一代的指针立刻 Release 并清空。理由：ref 只对最新一代有效，
 * 旧指针没有任何用处，留着就是泄漏（而且跨代释放要等 5 代以后，等于多占 5 倍 COM 引用）。
 */
internal sealed class UiaSnapshot
{
    public int Generation;
    public List<UiaItemInfo> Items = new List<UiaItemInfo>();
    public List<IntPtr> Pointers = new List<IntPtr>();
    /** 稳定 id → 项（diff 的查表） */
    public Dictionary<string, UiaItemInfo> ById = new Dictionary<string, UiaItemInfo>();
    public bool Truncated;
    public int PasswordFields;
    /**
     * 树里有多少个输入框（`edit` 类型，含密码框）。**为什么单列这个数**：密码遮罩靠
     * `uia-list` 记下的密码框位置，可页面刚加载时控件树还没长完（实测 +2.5s 只有 17 条、
     * 0 个密码框，+4.5s 才是 20 条、1 个），这时截图不会遮、也不报警——登录页刚打开就
     * 「list 一次再截图」有一个约 2 秒的裸奔窗口。宿主据此在「有输入框但没认出密码框」
     * 时给模型一句警告（2026-11-15 验收获证）。
     */
    public int EditFields;
    /**
     * 整棵可动作控件树的指纹（stable id + 名字 + 类型 + 模式 + enabled/offscreen + 矩形）。
     * **只用来判断「这一次与上一代是不是同一张清单」**：相同就复用上一代的代次，
     * 让刚发出去的 ref 不作废。见 FingerprintOf 的注释。
     */
    public string Fingerprint = "";
    public string Title = "";
    public string ClassName = "";
}

/** 一个窗口的清单历史（保留最近 Retain 代，最旧的丢弃） */
internal sealed class UiaHistory
{
    public int Latest;
    public List<UiaSnapshot> Snapshots = new List<UiaSnapshot>();
}

/**
 * 按窗口保存的清单历史。**只在 STA 线程上读写**（Run 里那条线程），除了一处例外：
 * 看门狗超时后 `Run` 会把整个 store 换掉（不是清空它）——放弃那条线程时它可能还在往
 * **旧对象**里写，写到新对象里就会跨线程 Release 它没持有的指针（可能卡在单元锁上，
 * 那正是看门狗要避开的东西）。换对象之后旧线程写到的是一个没人读的孤儿。
 */
internal sealed class UiaHistoryStore
{
    /** 每个窗口保留几代（够回答「刚才那一次变了什么」，又不把内存当无限） */
    internal const int Retain = 5;
    private readonly Dictionary<long, UiaHistory> _histories = new Dictionary<long, UiaHistory>();

    internal UiaHistory Ensure(long hwnd)
    {
        UiaHistory history;
        if (!_histories.TryGetValue(hwnd, out history))
        {
            history = new UiaHistory();
            _histories[hwnd] = history;
        }
        return history;
    }

    /** 最近一代快照；从没 list 过（或历史被重置）回 null */
    internal UiaSnapshot Latest(long hwnd)
    {
        UiaHistory history;
        if (!_histories.TryGetValue(hwnd, out history)) return null;
        if (history.Snapshots.Count == 0) return null;
        return history.Snapshots[history.Snapshots.Count - 1];
    }

    /** 按代次找快照；已被淘汰（更早的代次）回 null——调用方据此回全量 + 说明 */
    internal UiaSnapshot ByGeneration(long hwnd, int generation)
    {
        UiaHistory history;
        if (!_histories.TryGetValue(hwnd, out history)) return null;
        for (int i = 0; i < history.Snapshots.Count; i++)
        {
            if (history.Snapshots[i].Generation == generation) return history.Snapshots[i];
        }
        return null;
    }

    /** 最近一次 list 的代次；0 = 这个窗口还没有清单 */
    internal int LatestGeneration(long hwnd)
    {
        UiaHistory history;
        if (!_histories.TryGetValue(hwnd, out history)) return 0;
        return history.Latest;
    }

    /**
     * 收下一次 list 的快照：先把上一代的元素指针释放掉（ref 只对最新一代有效），
     * 再把超过 Retain 的最旧快照丢掉。release 由调用方给（COM 的 Release 在 Uia 里）。
     */
    internal void Push(long hwnd, UiaSnapshot snapshot, Action<IntPtr> release)
    {
        UiaHistory history = Ensure(hwnd);
        if (history.Snapshots.Count > 0)
        {
            UiaSnapshot previous = history.Snapshots[history.Snapshots.Count - 1];
            for (int i = 0; i < previous.Pointers.Count; i++) release(previous.Pointers[i]);
            previous.Pointers = new List<IntPtr>();
            // 树没变时沿用同一代：**替换**而不是追加，否则同一代会有两张快照，
            // 而 ByGeneration 只返回第一个（那份的指针已经被释放了）。
            if (previous.Generation == snapshot.Generation)
            {
                history.Snapshots[history.Snapshots.Count - 1] = snapshot;
                history.Latest = snapshot.Generation;
                return;
            }
        }
        history.Latest = snapshot.Generation;
        history.Snapshots.Add(snapshot);
        while (history.Snapshots.Count > Retain) history.Snapshots.RemoveAt(0);
    }
}

/**
 * 每个窗口已发出的最大代次。**故意独立于 UiaHistoryStore**：看门狗超时会换掉 store
 * （历史全丢），但代次号绝不能回退——回到 1 之后，模型手里上一轮的 "g1:r2" 会静默匹配上
 * 一张全新的清单，正是这一刀要消灭的那个错。所以代次只增不减，历史丢了就让它「查不到」。
 */
internal sealed class UiaGenerations
{
    private readonly Dictionary<long, int> _issued = new Dictionary<long, int>();

    internal int Next(long hwnd)
    {
        int value;
        if (!_issued.TryGetValue(hwnd, out value)) value = 0;
        value++;
        _issued[hwnd] = value;
        return value;
    }
}

/** 一次 diff 的结果（纯数据，selftest 直接验） */
internal sealed class UiaDiffResult
{
    /** 新增 + 变化的项（每项的 Change / ChangedFields 已填好；ref 是**新一代**的写法） */
    public List<UiaItemInfo> Items = new List<UiaItemInfo>();
    /** 上一代有、这一代没有的项（只带 stableId / name / controlType，不带 ref） */
    public List<UiaItemInfo> Removed = new List<UiaItemInfo>();
    /** 完全没变的条数 */
    public int Unchanged;
    /**
     * 只有矩形变了、别的都没变的条数（2026-11-14）。**不逐个列**：Edge 的控件 rect 一直在
     * 微动，逐条列出来会让 diff 比全量还大（实测 21 条里 16 条），而模型拿到 ref 就能动作，
     * 不需要知道它挪了几个像素——真要按坐标点，看截图更准。
     */
    public int RectMoved;
}

/** 这一次 list 回全量还是 diff（PlanList 的结论） */
internal sealed class UiaDiffPlan
{
    /** "full" / "diff" */
    public string Mode = "full";
    /** diff 的基准快照（Mode == "diff" 时非 null） */
    public UiaSnapshot Base;
    /** 回给模型的 since（0 = 没带） */
    public int Since;
    /** 为什么回全量（人话；null = 不需要解释） */
    public string Note;
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

    /**
     * 读 UIA_IsPassword 的结果怎么解释（**纯函数**，selftest 直接验）。三件事：
     *   ① 读不到（HRESULT 失败 / 老控件不支持这条属性）→ false：宁可不遮也不能拿脏值去遮；
     *   ② 0 / -1 / 1 是 BOOL 的两种合法写法（VARIANT_FALSE/FALSE、VARIANT_TRUE/TRUE）→ 照实；
     *   ③ 其余的怪值 → false（不是布尔值就当 false，不猜）。
     */
    internal static bool InterpretPassword(bool readOk, int raw)
    {
        if (!readOk) return false;
        if (raw == 0) return false;
        if (raw == 1 || raw == -1) return true;
        return false;
    }

    /** 读一个元素的 IsPassword：HRESULT 与 BOOL 一起交给 InterpretPassword（读不到不抛，当 false） */
    private static bool ReadIsPassword(IntPtr element)
    {
        int value;
        int hr = Slot<GetIntFn>(element, SlotCurrentIsPassword)(element, out value);
        return InterpretPassword(hr >= 0, hr < 0 ? 0 : value);
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

    /**
     * ref 的对外写法：`g<代次>:r<序号>`。
     *
     * 为什么把代次拼进**同一个 token**、而不是加一个并列的 generation 字段：模型要把两者配对
     * 传回来，配对就一定会错（传了新 ref 配旧代次）；一个格子照抄则错不了。代价是它不再是数字，
     * 而是一段不透明文本——这正是想要的：位置 + 代次本来就不该被模型拆开理解。
     */
    internal static string RefToken(int generation, int refNo)
    {
        return "g" + generation.ToString(CultureInfo.InvariantCulture)
            + ":r" + refNo.ToString(CultureInfo.InvariantCulture);
    }

    /** 模型给了一个上代格式的裸数字时的话（0.10–0.13 的 ref 是纯序号） */
    internal static string RefFormatMessage()
    {
        return "ref 现在长这样 \"g12:r3\"（g 后面是这个窗口最近一次 uia-list 的代次，r 后面是那一代里的序号），"
            + "照抄 uia-list 回执里的那个值就行，不要自己拼、也不要再用纯数字——先重新 list 一次。";
    }

    /**
     * 解 ref token（纯函数，selftest 直接验）。回 null = 通过；否则回一句给模型的人话。
     * 大小写不敏感（模型可能把它写成 G12:R3），但回给调用方的永远是代次 + 序号两个数字。
     */
    internal static string ParseRefToken(string raw, out int generation, out int refNo)
    {
        generation = 0;
        refNo = 0;
        if (raw == null || raw.Trim().Length == 0) return RefFormatMessage();
        string value = raw.Trim();
        int colon = value.IndexOf(':');
        if (colon < 2 || colon >= value.Length - 2) return RefFormatMessage();
        string genPart = value.Substring(0, colon).Trim();
        string refPart = value.Substring(colon + 1).Trim();
        if (genPart.Length < 2 || (genPart[0] != 'g' && genPart[0] != 'G')) return RefFormatMessage();
        if (refPart.Length < 2 || (refPart[0] != 'r' && refPart[0] != 'R')) return RefFormatMessage();
        if (!int.TryParse(genPart.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out generation)
            || generation <= 0) return RefFormatMessage();
        if (!int.TryParse(refPart.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out refNo)
            || refNo <= 0) return RefFormatMessage();
        return null;
    }

    /**
     * 把一个 ref token 对到**最近一代**快照上（纯逻辑：只看历史，不碰 COM，selftest 直接验）。
     * 回 null = 可用（snapshot / index 已填）；否则回一句给模型的人话，**必须带「重新 list」**。
     */
    internal static string ResolveRefToken(UiaHistoryStore store, long hwnd, string raw,
        out UiaSnapshot snapshot, out int index)
    {
        snapshot = null;
        index = -1;
        int generation;
        int refNo;
        string bad = ParseRefToken(raw, out generation, out refNo);
        if (bad != null) return bad;
        UiaSnapshot latest = store.Latest(hwnd);
        if (latest == null)
            return "ref " + raw.Trim() + " 已经失效（这个窗口没有可用的控件清单）——先重新 list 一次，再用新的 ref。";
        if (generation != latest.Generation)
            return "ref " + raw.Trim() + " 属于第 " + generation + " 次清单，现在是第 " + latest.Generation
                + " 次——窗口内容已经变过，同一个序号现在可能指向另一个控件。先重新 list 再动作。";
        if (!TryResolveRef(refNo, latest.Items.Count, out index))
            return "ref " + raw.Trim() + " 超出范围（第 " + generation + " 次清单只有 "
                + latest.Items.Count + " 个控件）——重新 list 看新的序号。";
        snapshot = latest;
        return null;
    }

    /**
     * 稳定 id 的主路径：UIA 的 RuntimeId（IUIAutomationElement::GetRuntimeId）。
     * 它是一个 int 数组（首元素常是 UIA_AppendRuntimeId = 42，后面是提供者自己编的），
     * 同一个元素在整块桌面上唯一、且在元素的整个生命周期里不变——正是「两次 list 同一个控件
     * 必须得到同一个 id」要的东西。写成十六进制串（负数不会变成带减号的怪值）。
     */
    internal static string StableIdFromRuntimeId(int[] ids)
    {
        if (ids == null || ids.Length == 0) return null;
        StringBuilder sb = new StringBuilder("rt:");
        for (int i = 0; i < ids.Length; i++)
        {
            if (i > 0) sb.Append('.');
            sb.Append(ids[i].ToString("x", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    /**
     * 取不到 RuntimeId 时的退化：ControlType + ClassName + Name + AutomationId 的 FNV-1a 32 位哈希。
     * 这四个属性是 UIA 里跨两次枚举最稳定的四个；退化 id 前缀是 `h:`，一眼能看出不是 RuntimeId。
     * **代价写在明处**：Name 一变，退化 id 就变——那次变化会呈现成「消失 + 新增」而不是
     * 「name 变了」。这比「认错控件」好，而且退化本身只发生在没有 RuntimeId 的提供者上。
     */
    internal static string FallbackStableId(string controlType, string className, string name, string automationId)
    {
        string seed = (controlType ?? "") + "\u0001" + (className ?? "") + "\u0001"
            + (name ?? "") + "\u0001" + (automationId ?? "");
        uint hash = 2166136261;
        for (int i = 0; i < seed.Length; i++)
        {
            hash = hash ^ seed[i];
            hash = hash * 16777619;
        }
        return "h:" + hash.ToString("x8", CultureInfo.InvariantCulture);
    }

    /** 同一代里出现两个一模一样的稳定 id 时补序号（#2 / #3）；第 1 个不加后缀 */
    internal static string DisambiguateStableId(string stableId, int seenCount)
    {
        if (seenCount <= 1) return stableId;
        return stableId + "#" + seenCount.ToString(CultureInfo.InvariantCulture);
    }

    /**
     * 一个元素的稳定 id：RuntimeId 优先，退化为属性哈希，再按本代内出现次数消歧。
     * **生产路径（CollectItem）与 selftest 用的是这同一个函数**——「同一棵树两次 list
     * 必须得到同一串 id」这条核心正确性才答应得住。
     */
    internal static string StableIdFor(int[] runtimeId, string controlType, string className, string name,
        string automationId, Dictionary<string, int> seen)
    {
        string id = StableIdFromRuntimeId(runtimeId);
        if (id == null) id = FallbackStableId(controlType, className, name, automationId);
        int count;
        if (!seen.TryGetValue(id, out count)) count = 0;
        count++;
        seen[id] = count;
        return DisambiguateStableId(id, count);
    }

    /**
     * 整棵可动作控件树的指纹（纯函数：selftest 直接验）。
     *
     * **为什么需要它**：代次的本意是「控件树变了，旧 ref 作废」。原来每查一次就 +1，
     * 于是「查询」被当成「变化」——模型 list 完拿到 g2:r1，中间为了看变化又 list 一次
     * （变 g3），再想用 g2:r1 就被拒。可它手里的引用**一秒前才拿到**，树根本没变。
     *
     * 指纹覆盖：stable id、名字、类型、支持模式、enabled/offscreen、矩形。
     * 位置变了也算变化（模型据此知道控件挪了）；只改颜色之类不算（我们看不到）。
     */
    internal static string FingerprintOf(UiaSnapshot snapshot)
    {
        StringBuilder seed = new StringBuilder();
        for (int i = 0; i < snapshot.Items.Count; i++)
        {
            UiaItemInfo it = snapshot.Items[i];
            seed.Append(it.StableId).Append('')
                .Append(it.Name).Append('')
                .Append(it.ControlType).Append('')
                // AutomationId 必须进指纹：CompareItems 会比对它，指纹漏了就会出现
                // 「代次判为没变（复用）、diff 却说它变了」的自相矛盾（2026-11-14 真机撞到）
                .Append(it.AutomationId).Append('')
                .Append(it.Enabled ? '1' : '0').Append(it.Offscreen ? '1' : '0').Append('');
            // **矩形不进指纹**：位置挪动不代表「控件树变了」。ref 按 stableId 映射，挪 20 像素
            // 它还是同一个控件——让代次因位置抖动而推进，就会误伤刚发出去的 ref
            // （Edge 实测 21 条里 16 条的 rect 一直在微动，2026-11-14）。位置变化由 diff 的
            // rectMoved 单独计数，那才是模型真正需要的信号。
            for (int p = 0; p < it.Patterns.Count; p++) seed.Append(it.Patterns[p]).Append(',');
            seed.Append('');
        }
        uint hash = 2166136261;
        for (int i = 0; i < seed.Length; i++)
        {
            hash = hash ^ seed[i];
            hash = hash * 16777619;
        }
        return "f:" + hash.ToString("x8", CultureInfo.InvariantCulture) + ":" + snapshot.Items.Count;
    }

    /** 两个同名列表是不是同一组模式（顺序无关：UIA 的模式集合本身就是无序的） */
    private static bool SamePatterns(List<string> before, List<string> after)
    {
        if (before == null) before = new List<string>();
        if (after == null) after = new List<string>();
        if (before.Count != after.Count) return false;
        for (int i = 0; i < before.Count; i++)
        {
            if (!after.Contains(before[i])) return false;
        }
        return true;
    }

    /**
     * 同一个控件（同一个稳定 id）在两代之间变了哪些字段。空列表 = 没变。
     * 名字 / 模式 / 可用性 / 可见区 / 矩形 / 类型 / automationId 都算——模型看不到 UI，
     * 位置变了往往是它最需要知道的那一条（按钮被一个新弹框挤走了）。
     */
    internal static List<string> CompareItems(UiaItemInfo before, UiaItemInfo after)
    {
        List<string> fields = new List<string>();
        if (before.Name != after.Name) fields.Add("name");
        if (before.ControlType != after.ControlType) fields.Add("controlType");
        if (before.AutomationId != after.AutomationId) fields.Add("automationId");
        if (!SamePatterns(before.Patterns, after.Patterns)) fields.Add("patterns");
        if (before.Enabled != after.Enabled) fields.Add("enabled");
        if (before.Offscreen != after.Offscreen) fields.Add("offscreen");
        if (before.X != after.X || before.Y != after.Y || before.W != after.W || before.H != after.H)
            fields.Add("rect");
        return fields;
    }

    /**
     * 两代快照的 diff（纯逻辑，selftest 直接验）。
     * **按稳定 id 比，不按序号比**：序号一变（中间少了一个控件）整串都会错位，
     * 那就成了「所有控件都变了」，模型会被噪音掩住真正的那一条。
     */
    internal static UiaDiffResult DiffSnapshots(UiaSnapshot before, UiaSnapshot after)
    {
        UiaDiffResult diff = new UiaDiffResult();
        for (int i = 0; i < after.Items.Count; i++)
        {
            UiaItemInfo now = after.Items[i];
            UiaItemInfo old;
            if (!before.ById.TryGetValue(now.StableId, out old))
            {
                now.Change = "added";
                diff.Items.Add(now);
                continue;
            }
            List<string> changed = CompareItems(old, now);
            if (changed.Count == 0)
            {
                diff.Unchanged++;
                continue;
            }
            // 只挪了位置（别的都没变）：计入 rectMoved，不逐条塞进 items
            if (changed.Count == 1 && changed[0] == "rect")
            {
                diff.RectMoved++;
                continue;
            }
            now.Change = "changed";
            now.ChangedFields = changed;
            diff.Items.Add(now);
        }
        for (int i = 0; i < before.Items.Count; i++)
        {
            UiaItemInfo old = before.Items[i];
            if (!after.ById.ContainsKey(old.StableId)) diff.Removed.Add(old);
        }
        return diff;
    }

    /**
     * 这一次 list 回全量还是 diff（纯逻辑：只看历史与请求）。
     * 三种情况：没带 since → 全量；since 那一代还在 → diff；不在（太旧 / 不是这个窗口的） → 全量 + 说明。
     */
    internal static UiaDiffPlan PlanList(UiaHistoryStore store, long hwnd, bool hasSince, int sinceGen)
    {
        UiaDiffPlan plan = new UiaDiffPlan();
        if (!hasSince) return plan;
        UiaSnapshot baseSnap = store.ByGeneration(hwnd, sinceGen);
        if (baseSnap != null)
        {
            plan.Mode = "diff";
            plan.Base = baseSnap;
            plan.Since = sinceGen;
            return plan;
        }
        int newest = store.LatestGeneration(hwnd);
        if (sinceGen > newest)
            plan.Note = "since=" + sinceGen + " 不是这个窗口的清单代次（最近一次是第 " + newest
                + " 次）——since 只接这个窗口之前 list 过的 generation，这次给的是全量。";
        else
            plan.Note = "记不住那么早的清单了（每个窗口只保留最近 " + UiaHistoryStore.Retain
                + " 代）——这是全量。";
        return plan;
    }

    /** 动作 → 真正要调的 UIA 模式名；未知动作（含已删除的 focus）回 null */
    internal static string PatternNameForAction(string action)
    {
        if (action == "invoke") return "invoke";
        if (action == "setValue") return "value";
        if (action == "selection") return "selectionItem";
        return null;
    }

    /** 动作 → 模式 id；-1 = 动作不认识（含已删除的 focus） */
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
        return value;
    }

    /**
     * focus 被删掉之后给模型的话。三件事必须同时在：
     *   ① 这个动作不再存在；② 它为什么不行（动的是整块桌面的键盘焦点）；
     *   ③ 换成什么（computer_click 点过去，或 invoke / setValue——它们不需要焦点）。
     * 宿主侧 shared/computer-use.ts 的 computerUseUiaErrors.focusRemoved 是同一句话的副本
     * （两层各有一道闸），改文案时两处一起改。
     */
    internal static string FocusRemovedMessage()
    {
        return "focus 动作已删除：Element.SetFocus 会移动整块桌面的键盘焦点，与这条车道「不碰桌面」的前提冲突。"
            + "要移动焦点，用 computer_click 点到目标控件；或者直接用 invoke（通常同时给焦点）/ setValue（不需要焦点）。";
    }

    /**
     * 动作参数校验（纯函数）。回 null = 通过；否则回一句给模型的人话。
     * 放在这里而不是散在执行路径上：同一套话术要能被 selftest 逐条钉住。
     */
    internal static string ValidateAct(string action, bool hasRef, bool hasName, bool hasValue)
    {
        // focus 单独一句：不是「打错字」，而是一个被删掉的动作，模型需要知道换成什么
        if (action == "focus") return FocusRemovedMessage();
        if (action == null || PatternNameForAction(action) == null)
            return "action 必须是 invoke / setValue / selection 之一（大小写不敏感）";
        if (action == "setValue")
        {
            if (!hasRef && !hasName)
                return "setValue 需要 ref（上一次 uia-list 回执里的 \"g12:r3\"）或 name 指定目标控件（先 uia-list 看有哪些）";
            if (!hasValue) return "setValue 需要 value（要写进控件的新文本；可以直接清空：value 传空字符串）";
            return null;
        }
        if (!hasRef && !hasName)
            return "uia-act 需要 ref（上一次 uia-list 回执里的 \"g12:r3\" 那种写法，照抄就行）或 name（控件名字的一部分）";
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
        return ItemJson(item, null, null);
    }

    /**
     * 一项的 JSON。change != null 时多一对 diff 字段：`"change":"added"|"changed"`，
     * 以及 changed 时变了哪些字段。ref 永远是**所在那一代**的 token（"g12:r3"）。
     */
    internal static string ItemJson(UiaItemInfo item, string change, List<string> changedFields)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ref\":").Append(Program.JsonQuote(item.RefToken))
            .Append(",\"stableId\":").Append(Program.JsonQuote(item.StableId))
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
            .Append(",\"isPassword\":").Append(item.IsPassword ? "true" : "false");
        if (change != null)
        {
            json.Append(",\"change\":").Append(Program.JsonQuote(change));
            if (changedFields != null && changedFields.Count > 0)
            {
                json.Append(",\"changed\":[");
                for (int i = 0; i < changedFields.Count; i++)
                {
                    if (i > 0) json.Append(",");
                    json.Append(Program.JsonQuote(changedFields[i]));
                }
                json.Append("]");
            }
        }
        json.Append("}");
        return json.ToString();
    }

    /** diff 里「消失的控件」的 JSON：只给 stableId / name / controlType，**不给 ref**（它已经没有那一代里的位置了） */
    internal static string RemovedJson(UiaItemInfo item)
    {
        return "{\"stableId\":" + Program.JsonQuote(item.StableId)
            + ",\"name\":" + Program.JsonQuote(item.Name)
            + ",\"controlType\":" + Program.JsonQuote(item.ControlType) + "}";
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
    /**
     * IUIAutomationElement 第 33 个方法 get_CurrentIsPassword（UIAutomationClient.h 的
     * UIA_IsPasswordPropertyId = 30019，类型 BOOL）。槽号是**内插**出来的：已验证的邻居是
     * 第 31 IsControlElement 与第 36 IsOffscreen，头文件里这两条之间正是
     * IsContentElement / **IsPassword** / NativeWindowHandle / ItemType——
     * 数错一个槽就会读到 HWND（非 0）而把每个元素都当成密码框，所以这里把依据写下来。
     */
    private const int SlotCurrentIsPassword = 3 + 33 - 1;
    /**
     * IUIAutomationElement 第 34 个方法 get_CurrentNativeWindowHandle（UIA_NativeWindowHandlePropertyId
     * = 30020，类型 int）。槽号依据与 IsPassword 同一串：31 IsControlElement → 32 IsContentElement
     * → 33 IsPassword → **34 NativeWindowHandle** → 35 ItemType → 36 IsOffscreen（已实测）。
     * PostMessage 车道靠它把控件对到一个真实 HWND 上。
     */
    private const int SlotCurrentNativeWindowHandle = 3 + 34 - 1;
    /** IUIAutomationElement 第 41 个方法 get_CurrentBoundingRectangle */
    private const int SlotCurrentBoundingRectangle = 3 + 41 - 1;
    /**
     * IUIAutomationElement 第 2 个方法 GetRuntimeId(SAFEARRAY(int)**)：稳定 id 的主路径。
     * 对头文件数：《UIAutomationClient.h》里 IUIAutomationElement 的方法次序是
     * SetFocus(1) / **GetRuntimeId(2)** / FindFirst(3) / FindAll(4——已验证) / …，
     * 与下面已实测的 FindAll = 4 一肋对得上，所以槽 = 3 + 2 - 1 = 4。
     */
    private const int SlotGetRuntimeId = 3 + 2 - 1;
    /** IUIAutomationElementArray 第 1 个方法 get_Length */
    private const int SlotArrayLength = 3 + 1 - 1;
    /** IUIAutomationElementArray 第 2 个方法 GetElement(index, IUIAutomationElement**) */
    private const int SlotArrayGetElement = 3 + 2 - 1;
    /** IUIAutomationInvokePattern 第 1 个方法 Invoke() */
    private const int SlotInvoke = 3 + 1 - 1;
    /** IUIAutomationValuePattern 第 1 个方法 SetValue(BSTR) */
    private const int SlotSetValue = 3 + 1 - 1;
    /** IUIAutomationValuePattern 第 2 个方法 get_CurrentValue(BSTR*) —— setValue 读回的主路径 */
    private const int SlotValueCurrentValue = 3 + 2 - 1;
    /** IUIAutomationValuePattern 第 3 个方法 get_CurrentIsReadOnly */
    private const int SlotValueIsReadOnly = 3 + 3 - 1;
    /** UIA_TextPatternId = 10014（UIAutomationClient.h）；读回的退路 */
    private const int TextPatternId = 10014;
    /**
     * IUIAutomationTextPattern 第 5 个方法 get_DocumentRange(IUIAutomationTextRange**)。
     * 槽号依据（UIAutomationClient.h 10.0.26100.0，IUIAutomationTextPatternVtbl 的方法次序）：
     *   1 RangeFromPoint                      → IUIAutomationTextRange**
     *   2 RangeFromChild                      → IUIAutomationTextRange**
     *   3 GetSelection                        → IUIAutomationTextRangeArray**
     *   4 GetVisibleRanges                    → IUIAutomationTextRangeArray**（**跳过**：返回的是
     *                                           数组不是单个 TextRange，本车道读整篇文本用不到它；
     *                                           但它占一个槽，数槽时不能漏）
     *   5 **get_DocumentRange**               → IUIAutomationTextRange**
     *   6 get_SupportedTextSelection          → SupportedTextSelection*
     * 曾经写成 3 + 4 - 1 = 6：漏掉第 4 个 GetVisibleRanges，于是实际调到它，把返回的数组指针
     * 当 TextRange 用、再对它调槽 12（GetText）——vtable 越界。下面的 TextPatternMethods 表与
     * selftest 的「槽号 → 方法名」断言会把这种漏项钉红。
     */
    private const int SlotTextDocumentRange = 3 + 5 - 1;
    /**
     * IUIAutomationTextRange 第 10 个方法 GetText(int maxLength, BSTR*)。
     * 槽号依据（IUIAutomationTextRange 的方法表）：1 Clone → 2 Compare → 3 CompareEndpoints
     * → 4 ExpandToEnclosingUnit → 5 FindAttribute → 6 FindText → 7 GetAttributeValue
     * → 8 GetBoundingRectangles → 9 GetEnclosingElement → **10 GetText**。
     */
    private const int SlotTextRangeGetText = 3 + 10 - 1;
    /** evidence.detail 的硬上限（给模型看的证据，不该把回执撑爆）；超了截断并注明 */
    private const int EvidenceDetailMax = 200;
    /** IUIAutomationSelectionItemPattern 第 1 个方法 Select() */
    private const int SlotSelect = 3 + 1 - 1;

    // ---- 槽号的机器可核对表 ----
    //
    // 为什么需要它：上面每个常量都是「3 + 序号 - 1」的手工内插，注释里数错一个方法，常量与注释
    // 仍然「自洽」——selftest 只比对字面值 6 时照样绿（TextPattern 漏 GetVisibleRanges 就是这么
    // 溜过去的）。所以把每个接口的 vtable 方法次序逐字抄成表，selftest 断言「槽号解析出的方法名
    // == 这个常量想调的方法」，并对整张表做逐字比对（有人删掉一项让数字对上，表本身会先红）。
    // 下标 i（0 基）对应槽号 3 + (i + 1)。

    /** IUIAutomationTextPattern 的 6 个方法（UIAutomationClient.h:8100–8121） */
    private static readonly string[] TextPatternMethods =
    {
        "RangeFromPoint",
        "RangeFromChild",
        "GetSelection",
        "GetVisibleRanges",
        "get_DocumentRange",
        "get_SupportedTextSelection",
    };

    /** IUIAutomationValuePattern 的 5 个方法（UIAutomationClient.h:6808–6823） */
    private static readonly string[] ValuePatternMethods =
    {
        "SetValue",
        "get_CurrentValue",
        "get_CurrentIsReadOnly",
        "get_CachedValue",
        "get_CachedIsReadOnly",
    };

    /** IUIAutomationTextRange 的 18 个方法（UIAutomationClient.h:7174 起） */
    private static readonly string[] TextRangeMethods =
    {
        "Clone",
        "Compare",
        "CompareEndpoints",
        "ExpandToEnclosingUnit",
        "FindAttribute",
        "FindText",
        "GetAttributeValue",
        "GetBoundingRectangles",
        "GetEnclosingElement",
        "GetText",
        "Move",
        "MoveEndpointByUnit",
        "MoveEndpointByRange",
        "Select",
        "AddToSelection",
        "RemoveFromSelection",
        "ScrollIntoView",
        "GetChildren",
    };

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayGetDim(IntPtr psa);

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayGetLBound(IntPtr psa, uint nDim, out int lower);

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayGetUBound(IntPtr psa, uint nDim, out int upper);

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayAccessData(IntPtr psa, out IntPtr data);

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayUnaccessData(IntPtr psa);

    [DllImport("oleaut32.dll")]
    private static extern int SafeArrayDestroy(IntPtr psa);

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
    private delegate int FindAllFn(IntPtr self, int scope, IntPtr condition, out IntPtr array);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetCurrentPatternFn(IntPtr self, int patternId, out IntPtr pattern);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetSafeArrayFn(IntPtr self, out IntPtr array);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ArrayLengthFn(IntPtr self, out int length);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ArrayGetFn(IntPtr self, int index, out IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int InvokeFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetValueFn(IntPtr self, IntPtr value);
    /** get_DocumentRange(TextRange**)：与 GetConditionFn 同形，但语义不同，单列一个以防混用 */
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetDocumentRangeFn(IntPtr self, out IntPtr range);
    /** IUIAutomationTextRange::GetText(int maxLength, BSTR**)：maxLength = -1 表示全部 */
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetTextFn(IntPtr self, int maxLength, out IntPtr text);

    /** 读槽位并包成委托（每次调用重读一次 vtable：对象换了也不会拿到旧函数指针） */
    /**
     * 槽号 → 方法名：槽号 = 3 + 序号 - 1，所以序号 = 槽号 - 3 + 1。
     * 越界时不抛，返回带序号的占位串——让 selftest 的断言把真实错位打印出来。
     * 只给 selftest 用（不碰 COM）。
     */
    private static string MethodNameAt(string[] methods, int slot)
    {
        int ordinal = slot - 3 + 1;
        if (ordinal < 1 || ordinal > methods.Length)
        {
            return "<越界:" + ordinal.ToString(CultureInfo.InvariantCulture) + ">";
        }
        return methods[ordinal - 1];
    }

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
    /**
     * 清单历史（按 hwnd）。**只在 STA 线程上读写**；看门狗超时时整个换掉（不是清空）：
     * 被放弃的那条线程可能还在往它自己捕到的旧对象里写（见 BuildListJson 开头的 store 局部变量），
     * 换对象之后它写到的是一个没人读的孤儿，不会跨线程 Release 新对象里的指针。
     */
    private static UiaHistoryStore _store = new UiaHistoryStore();
    /** 代次号只增不减：历史丢了就让它查不到，绝不让旧 "g1:r2" 静默匹配上一张新清单 */
    private static readonly UiaGenerations Generations = new UiaGenerations();

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
            // 线程意外死掉（未捕获的异常 / 运行时把后台线程停了）：_worker 还挂着，但再没人消费
            // 队列——不在这里换一条，后面每条命令都要白等满一个 timeout。ref 映射属于死掉的单元，
            // 一并作废（下一次 uia-act 会回「ref 已失效」）。
            if (_worker != null && !_worker.IsAlive)
            {
                Program.Log("UIA：STA 线程已经退出，重启一条（旧控件清单作废）");
                _generation++;
                _worker = null;
                _store = new UiaHistoryStore();
            }
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
                Program.Log("UIA：调用超时（" + timeoutMs + "ms），放弃当前 STA 线程；控件清单作废");
                _generation++;
                _worker = null;
                _pending = null;
                _store = new UiaHistoryStore();
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

    /**
     * 读一个元素的 RuntimeId（稳定 id 的主路径）。失败 / 形状不对一律回 null（调用方退化到属性哈希）——
     * 稳定 id 读不到是一个**可以接受的降级**，而为一个非关键字段抛异常会毁掉整次 list。
     * SAFEARRAY 由我们负责 Destroy（头文件里的 [out, retval] 语义），里面是 VT_I4 的紧凑数组。
     */
    private static int[] ReadRuntimeId(IntPtr element)
    {
        IntPtr array;
        int hr = Slot<GetSafeArrayFn>(element, SlotGetRuntimeId)(element, out array);
        if (hr < 0 || array == IntPtr.Zero) return null;
        try
        {
            if (SafeArrayGetDim(array) != 1) return null;
            int lower;
            int upper;
            if (SafeArrayGetLBound(array, 1, out lower) < 0) return null;
            if (SafeArrayGetUBound(array, 1, out upper) < 0) return null;
            int count = upper - lower + 1;
            // RuntimeId 正常情况下就几个 int；异常长度不当数据用（防止脏 SAFEARRAY 拉爆内存）
            if (count <= 0 || count > 16) return null;
            IntPtr data;
            if (SafeArrayAccessData(array, out data) < 0) return null;
            try
            {
                int[] ids = new int[count];
                for (int i = 0; i < count; i++) ids[i] = Marshal.ReadInt32(data, i * 4);
                return ids;
            }
            finally
            {
                SafeArrayUnaccessData(array);
            }
        }
        finally
        {
            SafeArrayDestroy(array);
        }
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

    // ---- setValue 的读回证据（0.15.0）-----------------------------------------
    //
    // 为什么要有这一段：宿主那道「没有读回证据就不许 confirmed」的闸门（settleComputerUseDelivery）
    // 本身是对的，但桥以前从来不**发**证据，于是每一条 setValue 都被降成 unverifiable——模型
    // 永远等不到确认，一个「设值没生效」的 bug 也没人发现。读回是这条车道上唯一算数的证据。

    /** 一次 setValue 之后读回判定的结果（纯数据；--selftest-uia 直接验） */
    internal sealed class ReadbackVerdict
    {
        /** confirmed / suspected_noop / unverifiable —— 与宿主 contract 同一套名字 */
        public string Delivery = "unverifiable";
        /** evidence.detail；null = 没有证据（unverifiable 不许发一份空证据） */
        public string Detail;
        /** 读回走的哪条路：value / text / none（写进回执便于真机排查） */
        public string Source = "none";
    }

    /**
     * 读回一个控件「现在真实的值」。
     *
     * 顺序按可用性：ValuePattern.Current.Value → TextPattern.DocumentRange.GetText(-1)。
     * 都没有 / 都读失败 → null（source = "none"），调用方回 unverifiable，**不猜**。
     * 为什么 TextPattern 只当退路：它给的是文档文本，边界比 ValuePattern 宽（可能带段落符），
     * 比较时要容忍尾部换行；ValuePattern 给的就是控件自己的值，能逐字比。
     */
    private static string ReadCurrentValue(IntPtr element, out string source)
    {
        source = "none";
        IntPtr pattern;
        int hr = Slot<GetCurrentPatternFn>(element, SlotGetCurrentPattern)(element, ValuePatternId, out pattern);
        if (hr >= 0 && pattern != IntPtr.Zero)
        {
            try
            {
                IntPtr bstr;
                int readHr = Slot<GetStringFn>(pattern, SlotValueCurrentValue)(pattern, out bstr);
                if (readHr >= 0 && bstr != IntPtr.Zero)
                {
                    try
                    {
                        string value = Marshal.PtrToStringBSTR(bstr);
                        if (value != null)
                        {
                            source = "value";
                            return value;
                        }
                    }
                    finally { Marshal.FreeBSTR(bstr); }
                }
            }
            finally { Release(pattern); }
        }

        hr = Slot<GetCurrentPatternFn>(element, SlotGetCurrentPattern)(element, TextPatternId, out pattern);
        if (hr >= 0 && pattern != IntPtr.Zero)
        {
            try
            {
                IntPtr range;
                int rangeHr = Slot<GetDocumentRangeFn>(pattern, SlotTextDocumentRange)(pattern, out range);
                if (rangeHr >= 0 && range != IntPtr.Zero)
                {
                    try
                    {
                        IntPtr bstr;
                        int textHr = Slot<GetTextFn>(range, SlotTextRangeGetText)(range, -1, out bstr);
                        if (textHr >= 0 && bstr != IntPtr.Zero)
                        {
                            try
                            {
                                string text = Marshal.PtrToStringBSTR(bstr);
                                if (text != null)
                                {
                                    source = "text";
                                    return text;
                                }
                            }
                            finally { Marshal.FreeBSTR(bstr); }
                        }
                    }
                    finally { Release(range); }
                }
            }
            finally { Release(pattern); }
        }
        return null;
    }

    /**
     * setValue 读回的判定（纯函数，--selftest-uia 直接验）。三档：
     *   读回 == 期望 → confirmed（带 evidence）
     *   读回 != 期望 → suspected_noop（带 evidence）——值真的没变成我们要的
     *   拿不到读回   → unverifiable（**没有** evidence）——不猜成任何一档
     *
     * 密码框：detail 只写「一致 / 不一致」，绝不带值本身——密码不该因为一次确认就进模型上下文。
     */
    internal static ReadbackVerdict JudgeSetValueReadback(string expected, string actual, string source,
        bool isPassword)
    {
        ReadbackVerdict verdict = new ReadbackVerdict();
        verdict.Source = source == "value" || source == "text" ? source : "none";
        if (verdict.Source == "none")
        {
            // 没有读回就没有证据：unverifiable 是「已经做了但证明不了」，不是失败
            verdict.Delivery = "unverifiable";
            verdict.Detail = null;
            return verdict;
        }
        bool same = ReadbackMatches(expected, actual, verdict.Source);
        verdict.Delivery = same ? "confirmed" : "suspected_noop";
        if (isPassword)
        {
            verdict.Detail = same ? "密码框：读回值与期望一致" : "密码框：读回值与期望不一致";
            return verdict;
        }
        string where = verdict.Source == "value"
            ? "ValuePattern.Current.Value"
            : "TextPattern.DocumentRange.GetText";
        // **不回显值本身**：这是模型 / 用户填进去的原文，回执会进会话 JSONL。
        // 只给「长度 + 一致与否」——那才是读回要回答的问题。
        verdict.Detail = ClipDetail("期望 " + DescribeValueForDetail(expected) + "，读回 "
            + DescribeValueForDetail(actual) + "（" + where + "）");
        return verdict;
    }

    /**
     * 读回值与期望值算不算同一个。ValuePattern 逐字比；TextPattern 给的文档文本常常在末尾多
     * 一个段落符（\r / \n / \r\n），那是**读回通道的固有噪声**，不是「值没设进去」——
     * 为了不把它误判成 suspected_noop（一条新的谎报），只在 text 通道上容忍尾部换行。
     */
    private static bool ReadbackMatches(string expected, string actual, string source)
    {
        if (actual == null) return false;
        if (string.Equals(expected, actual, StringComparison.Ordinal)) return true;
        if (source != "text") return false;
        int end = actual.Length;
        while (end > 0 && (actual[end - 1] == '\r' || actual[end - 1] == '\n')) end--;
        return string.Equals(expected, actual.Substring(0, end), StringComparison.Ordinal);
    }

    /**
     * detail 里怎么描述一个值：**只说形状，不说内容**（长度 + 打码）。**纯函数**。
     *
     * 为什么不回显原文：模型 / 用户往框里填的东西可能就是密码、token、验证码；回执会写进
     * 会话 JSONL，落盘就无法收回。读回要回答的是「设进去了没有」，长度对上就够了。
     */
    private static string DescribeValueForDetail(string value)
    {
        if (value == null) return "（读回失败）";
        if (value.Length == 0) return "（空）";
        return "••••（" + value.Length + " 字符）";
    }

    /** evidence.detail 总长硬上限：超了截断并注明（不塞超长文本，理由见 A 的规格） */
    private static string ClipDetail(string detail)
    {
        if (detail.Length <= EvidenceDetailMax) return detail;
        string note = "…（已截断）";
        int keep = EvidenceDetailMax - note.Length;
        if (keep < 0) keep = 0;
        return detail.Substring(0, keep) + note;
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
     * uia-list {hwnd?, title?, maxItems?, since?, timeoutMs?}
     *   → `{ok:true,hwnd,generation,mode,window:{...},items:[...],removed:[...],
     *      unchanged,truncated,passwordFields,note?}`
     *
     * 只读：从 hwnd 取 UIA 根元素 → 在 ControlView 里 FindAll(Descendants) → 过滤 →
     * 读名字/类型/id/矩形/可用性/稳定 id → 探测三个模式。全程不 SetFocus、不调任何写模式，
     * 也不把窗口带到前台（AutoSetFocus 只影响模式调用，读属性不受它影响）。
     *
     * **since（0.14.0）**：不带 = 全量（与改之前逐字同行为）；带了而且是这个窗口还留着的
     * 某一代 = 只回变化（新增 / 消失 / 改了 + unchanged 计数）；太旧（已被淘汰）= 全量 + 一句说明。
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

        // since：只回变化。给它的是回执里的 generation（那个窗口第几次清单），不是控件编号
        bool hasSince = false;
        int sinceGen = 0;
        string sinceRaw = Program.ExtractNumber(raw, "since");
        if (sinceRaw != null)
        {
            if (!int.TryParse(sinceRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out sinceGen) || sinceGen <= 0)
                return Fail("since 必须是正整数（上一次 uia-list 回执里的 generation）");
            hasSince = true;
        }

        bool timedOut;
        string json;
        int passwordFields = 0;
        int editFields = 0;
        string className = "";
        int truePasswords = 0;
        try
        {
            json = Run(delegate
            {
                return BuildListJson(hwnd, maxItems, hasSince, sinceGen,
                    out passwordFields, out editFields, out className, out truePasswords);
            }, timeoutMs, out timedOut);
        }
        catch (Exception ex)
        {
            Program.Log("uia-list 失败：" + ex.Message);
            return Fail(ex.Message);
        }
        if (timedOut) return Fail(TimeoutMessage("uia-list", timeoutMs));

        // **登录页第一次 list 只有浏览器外壳**（真机 2026-11：第一次 0 个密码框，第二次才有）：
        // 浏览器窗口里「有输入框、却没认出密码框」时，多半是页面控件树还在长。补一次（带小延迟），
        // 模型就不用把「list 两次」当成常识。付这 450ms 的条件很窄：必须是 Chromium 窗口类
        // + 有输入框 + 一个密码框都没认到；普通网页（没有输入框）与已经认出密码框的页面都不补。
        if (!timedOut && truePasswords == 0 && editFields > 0 && IsChromiumWindowClass(className))
        {
            Program.Log("uia-list：浏览器窗口有 " + editFields + " 个输入框但没认出密码框，"
                + BrowserGrowWaitMs + "ms 后补一次枚举（登录页控件树可能还在长）");
            Thread.Sleep(BrowserGrowWaitMs);
            try
            {
                json = Run(delegate
                {
                    return BuildListJson(hwnd, maxItems, hasSince, sinceGen,
                        out passwordFields, out editFields, out className, out truePasswords);
                }, timeoutMs, out timedOut);
            }
            catch (Exception ex)
            {
                Program.Log("uia-list 补枚举失败（保留第一次的结果）：" + ex.Message);
            }
        }
        return json;
    }

    /** UIA_EditControlTypeId = 50004：收候选时「所有输入框」都收（理由见 CollectItem） */
    private const int UiaEditControlTypeId = 50004;

    /** RuntimeId → 可比较的字符串（"42.1234.5"）；没有就空串（退到 AutomationId / 矩形重合） */
    private static string RuntimeIdOf(int[] ids)
    {
        if (ids == null || ids.Length == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < ids.Length; i++)
        {
            if (i > 0) sb.Append('.');
            sb.Append(ids[i].ToString(CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    /** 这一轮真正是密码框的候选有几个（回执的 passwordFields 与「登录页还没长完」的提示都用它） */
    private static int CountPasswordFields(List<MaskCandidate> candidates)
    {
        int count = 0;
        if (candidates == null) return 0;
        for (int i = 0; i < candidates.Count; i++)
        {
            if (candidates[i] != null && candidates[i].IsPassword) count++;
        }
        return count;
    }

    /** 登录页第一次 list 常常只拿到浏览器外壳：补一次枚举前等这么久（真机 ~300-700ms 长完） */
    private const int BrowserGrowWaitMs = 450;

    /** Chromium 系浏览器（Edge / Chrome / Brave / Chromium）的主窗口类名 */
    private static bool IsChromiumWindowClass(string className)
    {
        return className != null && string.Equals(className, "Chrome_WidgetWin_1", StringComparison.Ordinal);
    }

    private static string BuildListJson(IntPtr hwnd, int maxItems, bool hasSince, int sinceGen,
        out int passwordFieldsOut, out int editFieldsOut, out string classNameOut, out int truePasswordsOut)
    {
        passwordFieldsOut = 0;
        editFieldsOut = 0;
        classNameOut = "";
        truePasswordsOut = 0;
        // **先捕获这一次调用用的历史对象**：看门狗超时会把静态字段整个换掉（_store = new ...），
        // 而被放弃的那条线程还可能继续跑到这里——它必须往自己这一个（已经没人读的）对象里写。
        // 写到新对象里就是跨线程 Release 别人的指针，正是看门狗要避开的那个坑。
        UiaHistoryStore store = _store;
        long key = hwnd.ToInt64();
        // 代次要等**收集完**才定：树没变就复用上一代（见 FingerprintOf）。
        // 原来在这里无条件 Generations.Next(key)，于是「查询」被当成「变化」——
        // 模型 `list → list(since) → act(第一次的 ref)` 这条最自然的顺序必然失败
        // （2026-11-14 真机撞到：刚拿到的 g2:r1，下一次 list 之后就成了过期引用）。
        int generation = 0;

        IntPtr automation = EnsureAutomation();
        IntPtr window = ElementFromHandle(automation, hwnd);
        UiaSnapshot snapshot = new UiaSnapshot();
        snapshot.Generation = generation;
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
            // 「该遮的控件」单独收：**不管它列不列得进清单**（理由见 CollectItem 里的注释）。
            // 它们就是截图遮罩的数据源（Mask.cs 的 PasswordRects）：当前是密码框的，
            // 加上所有输入框（后者用来认出被「显示密码」翻开的那些）。
            List<MaskCandidate> maskCandidates = new List<MaskCandidate>();
            // 稳定 id 的消歧表（同一代里两个一模一样的控件 → 补 #2 / #3）
            Dictionary<string, int> seenIds = new Dictionary<string, int>();
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
                        UiaItemInfo info = CollectItem(element, maskCandidates, seenIds);
                        if (info != null)
                        {
                            info.Ref = RefOf(snapshot.Items.Count);
                            // Generation / RefToken 要等这一代定下来再填（见下面的指纹判定）
                            snapshot.Items.Add(info);
                            snapshot.ById[info.StableId] = info;
                            retained.Add(element);
                            keep = true;
                            if (snapshot.Items.Count >= maxItems)
                            {
                                truncated = i + 1 < total;
                                break;
                            }
                            // 指针要留给 uia-act 用（ref 解析）；不 Release
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

            snapshot.Title = windowTitle;
            snapshot.ClassName = windowClass;
            snapshot.Truncated = truncated;
            snapshot.PasswordFields = CountPasswordFields(maskCandidates);
            int editFields = 0;
            for (int i = 0; i < snapshot.Items.Count; i++)
            {
                if (string.Equals(snapshot.Items[i].ControlType, "edit", StringComparison.OrdinalIgnoreCase))
                    editFields++;
            }
            snapshot.EditFields = editFields;
            snapshot.Pointers = retained;

            // **代次在这里定**：树没变就复用上一代。
            // 这样连续 list（哪怕中间插一次 diff 查询）不会把刚发出去的 ref 作废；
            // 真的变了才 +1，旧 ref 才失效——代次的本意就是「树变了」。
            string fingerprint = FingerprintOf(snapshot);
            UiaSnapshot prior = store.Latest(key);
            if (prior != null && prior.Fingerprint.Length > 0 && prior.Fingerprint == fingerprint)
            {
                generation = prior.Generation;
            }
            else
            {
                generation = Generations.Next(key);
            }
            snapshot.Generation = generation;
            snapshot.Fingerprint = fingerprint;
            for (int i = 0; i < snapshot.Items.Count; i++)
            {
                snapshot.Items[i].Generation = generation;
                snapshot.Items[i].RefToken = RefToken(generation, snapshot.Items[i].Ref);
            }

            // 清单跑完了：把这次看到的密码框位置记下（截图命令靠它遮罩）。
            // 空列表也记 —— 「看过，这个窗口没有密码框」与「从没看过」是两件事：
            // 前者截图不用吓唬模型，后者必须告诉它「这张图没遮，因为你还没 list 过」。
            PasswordRects.Record(key, maskCandidates, WindowTitle(hwnd), InputHook.NowTick());

            // 回执里的 passwordFields 说「截图时会遮几个」——**与截图回执同源**（缓存里合并后的条数），
            // 不是「这一轮还是 IsPassword 的个数」：点过「显示密码」之后前者比后者多，回执必须
            // 与下一张图上真的被涂黑的块数对得上。真密码数另出一个变量，只给「登录页还没长完」的重试用。
            truePasswordsOut = snapshot.PasswordFields;
            MaskCacheEntry cachedEntry;
            int maskable = PasswordRects.TryGet(key, InputHook.NowTick(), out cachedEntry) ? cachedEntry.Rects.Count : 0;
            snapshot.PasswordFields = maskable;

            // diff 要拿「这一代之前」的历史说话：先定基准、先算差异，再把新快照收进去
            UiaDiffPlan plan = PlanList(store, key, hasSince, sinceGen);
            UiaDiffResult diff = plan.Mode == "diff" ? DiffSnapshots(plan.Base, snapshot) : null;
            // **diff 不省时就别硬用**：2026-11-14 真机，一次导航让每个控件的 rect 都变，
            // 56 条 changed 的回执 7822B 比全量 6721B 还大——模型读得更多，而且 diff 里
            // 没有未变控件的 ref（想动它们还得再 list 一次）。变化过半就回全量，并说清原因。
            if (diff != null && (diff.Items.Count + diff.Removed.Count) * 2 > snapshot.Items.Count)
            {
                plan.Note = JoinNotes(plan.Note, "这次变化过半（" + (diff.Items.Count + diff.Removed.Count)
                    + "/" + snapshot.Items.Count + " 个控件），回全量比 diff 更省。");
                plan.Mode = "full";
                plan.Since = 0;
                plan.Base = null;
                diff = null;
            }
            store.Push(key, snapshot, Release);

            List<UiaItemInfo> shown = diff == null ? snapshot.Items : diff.Items;
            List<UiaItemInfo> removed = diff == null ? new List<UiaItemInfo>() : diff.Removed;

            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"hwnd\":").Append(key)
                .Append(",\"generation\":").Append(generation)
                .Append(",\"mode\":").Append(Program.JsonQuote(plan.Mode));
            if (plan.Mode == "diff") json.Append(",\"since\":").Append(plan.Since);
            json.Append(",\"window\":{\"title\":").Append(Program.JsonQuote(windowTitle))
                .Append(",\"className\":").Append(Program.JsonQuote(windowClass))
                .Append("},\"items\":[");
            for (int i = 0; i < shown.Count; i++)
            {
                if (i > 0) json.Append(",");
                json.Append(ItemJson(shown[i], shown[i].Change, shown[i].ChangedFields));
            }
            json.Append("],\"removed\":[");
            for (int i = 0; i < removed.Count; i++)
            {
                if (i > 0) json.Append(",");
                json.Append(RemovedJson(removed[i]));
            }
            json.Append("],\"unchanged\":").Append(diff == null ? 0 : diff.Unchanged)
                .Append(",\"rectMoved\":").Append(diff == null ? 0 : diff.RectMoved)
                .Append(",\"truncated\":").Append(truncated ? "true" : "false")
                .Append(",\"passwordFields\":").Append(snapshot.PasswordFields)
                .Append(",\"editFields\":").Append(snapshot.EditFields);

            string note = plan.Note;
            if (diff != null && truncated)
                note = JoinNotes(note, "这次清单被 maxItems 截断了，diff 只覆盖列出来的部分。");
            else if (diff != null && plan.Base.Truncated)
                note = JoinNotes(note, "上一次清单被 maxItems 截断了，diff 只覆盖列出来的部分。");
            if (note != null) json.Append(",\"note\":").Append(Program.JsonQuote(note));
            json.Append("}");

            passwordFieldsOut = snapshot.PasswordFields;
            editFieldsOut = snapshot.EditFields;
            classNameOut = windowClass == null ? "" : windowClass;
            Program.Log("uia-list hwnd " + key + "「" + windowTitle + "」第 " + generation + " 代："
                + snapshot.Items.Count + " 个可动作控件" + (truncated ? "（还有更多，已截断）" : "")
                + "，密码框 " + snapshot.PasswordFields + " 个（已记下位置，截图会遮），mode=" + plan.Mode
                + (diff == null ? "" : "，变化 " + diff.Items.Count + " / 消失 " + diff.Removed.Count
                    + " / 没变 " + diff.Unchanged + " / 只挪位置 " + diff.RectMoved));
            return json.ToString();
        }
        finally
        {
            Release(window);
        }
    }

    /** 两段人话拼一条（note 只可能在 diff 路径上出现，最多两段） */
    private static string JoinNotes(string first, string second)
    {
        if (first == null || first.Length == 0) return second;
        if (second == null || second.Length == 0) return first;
        return first + " " + second;
    }

    /**
     * 一个候选元素要不要留下；留下就返回这一条的元数据（ref / 代次 / token 由调用方填）。
     * 返回 null 时调用方负责 Release（留下的指针要留给 ref 解析）。
     *
     * **密码框在读过滤之前判**：Chromium 里的 <input type=password> 常常既没有 name 也没有
     * automationId，它会被 IsListable 过滤掉——按「列进清单的控件」收集就会漏掉真正的密码框，
     * 而这正是遮罩唯一必须命中的东西。所以 IsPassword 与它的矩形在过滤之前就取，
     * 与「这一条要不要列给模型」完全解耦。
     */
    private static UiaItemInfo CollectItem(IntPtr element, List<MaskCandidate> candidates,
        Dictionary<string, int> seenIds)
    {
        bool isControl = ReadBool(element, SlotCurrentIsControlElement);
        int controlTypeId = ReadInt(element, SlotCurrentControlType);
        string name = ReadString(element, SlotCurrentName);
        string automationId = ReadString(element, SlotCurrentAutomationId);
        bool isPassword = ReadIsPassword(element);
        if (isPassword || controlTypeId == UiaEditControlTypeId)
        {
            // 密码框自己，以及**所有输入框**：后者是为了「点过显示密码、type 翻成 text」之后
            // 还能按身份把它认回来（Mask.MergeCandidates）。非输入框一律不收，免得把按钮也记进缓存。
            RECT secret = ReadRect(element);
            if (secret.Right > secret.Left && secret.Bottom > secret.Top)
            {
                MaskCandidate candidate = new MaskCandidate();
                candidate.RuntimeId = RuntimeIdOf(ReadRuntimeId(element));
                candidate.AutomationId = automationId == null ? "" : automationId;
                candidate.Rect = new MaskRect(secret.Left, secret.Top,
                    secret.Right - secret.Left, secret.Bottom - secret.Top);
                candidate.IsPassword = isPassword;
                candidates.Add(candidate);
            }
        }
        if (!IsListable(isControl, controlTypeId, name, automationId)) return null;

        UiaItemInfo info = new UiaItemInfo();
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
        info.IsPassword = isPassword;
        info.Patterns = ProbePatterns(element);
        // 稳定 id：RuntimeId 优先（同一个元素跨两次枚举不变），取不到退化为属性哈希
        info.StableId = StableIdFor(ReadRuntimeId(element), info.ControlType, info.ClassName,
            info.Name, info.AutomationId, seenIds);
        return info;
    }

    // ---- uia-act -------------------------------------------------------------

    /**
     * 会话内 PostMessage 车道（P2 / L2b）：把字符或一对鼠标消息直接投给控件自己的 HWND。
     *
     * 目标解析与 uia-act 完全同一套（ref 代次校验 / name 包含匹配），因为这一条存在的
     * 理由就是「UIA 有元素、但没有可用模式」——定位能力是它的前提。
     *
     * 为什么必须由桥来发：宿主跨会话 PostMessage = ERROR_ACCESS_DENIED（真机实测），
     * 而会话里的 SendInput 返回成功却毫无效果（光标冻在 0,0）。三条路里只剩这一条。
     */
    internal static string ExecuteWm(string raw)
    {
        string action = NormalizeAction(Program.ExtractJsonString(raw, "action"));
        string text = Program.ExtractJsonString(raw, "text");
        string name = Program.ExtractJsonString(raw, "name");
        if (name != null) name = name.Trim();

        string refRaw = Program.ExtractJsonString(raw, "ref");
        bool hasRef = refRaw != null && refRaw.Trim().Length > 0;
        if (hasRef)
        {
            int genCheck;
            int refCheck;
            string badRef = ParseRefToken(refRaw, out genCheck, out refCheck);
            if (badRef != null) return Fail(badRef);
        }
        bool hasName = name != null && name.Length > 0;
        string bad = WmPost.Validate(action, hasRef || hasName, text);
        if (bad != null) return Fail(bad);

        string error;
        IntPtr hwnd = ResolveTarget(raw, "wm-act", out error);
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
                return BuildWmJson(hwnd, action, hasRef, refRaw, hasName, name, text);
            }, timeoutMs, out timedOut);
        }
        catch (Exception ex)
        {
            Program.Log("wm-act 失败：" + ex.Message);
            return Fail(ex.Message);
        }
        if (timedOut) return Fail(TimeoutMessage("wm-act", timeoutMs));
        return json;
    }

    private static string BuildWmJson(IntPtr hwnd, string action, bool hasRef, string refToken, bool hasName,
        string name, string text)
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
                UiaHistoryStore store = _store;
                UiaSnapshot snapshot;
                int index;
                string badRef = ResolveRefToken(store, hwnd.ToInt64(), refToken, out snapshot, out index);
                if (badRef != null) throw new InvalidOperationException(badRef);
                if (index < 0 || index >= snapshot.Pointers.Count)
                    throw new InvalidOperationException("ref " + refToken + " 指向的控件已经不在了——重新 list 再动作。");
                target = snapshot.Pointers[index];
            }
            else
            {
                target = FindByName(window, automation, name);
                if (target == IntPtr.Zero)
                    throw new InvalidOperationException("没找到名字包含「" + name + "」的控件——先用 uia-list 看这个窗口里有哪些控件。");
                ownsTarget = true;
            }

            string targetName = ReadString(target, SlotCurrentName);
            string controlType = ControlTypeName(ReadInt(target, SlotCurrentControlType));
            int nativeRaw = ReadInt(target, SlotCurrentNativeWindowHandle);
            if (nativeRaw == 0)
                throw new InvalidOperationException("这个控件没有独立的窗口句柄（" + controlType
                    + "）——PostMessage 送不进去；改用 uia-act（invoke / setValue）或截图看一眼。");
            IntPtr native = new IntPtr(nativeRaw);

            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"hwnd\":").Append(hwnd.ToInt64())
                .Append(",\"action\":").Append(Program.JsonQuote(action))
                .Append(",\"targetHwnd\":").Append(native.ToInt64())
                .Append(",\"name\":").Append(Program.JsonQuote(targetName))
                .Append(",\"controlType\":").Append(Program.JsonQuote(controlType));

            if (action == "type")
            {
                int posted = WmPost.PostText(native, text);
                int expected = WmPost.CharPayload(text).Length;
                json.Append(",\"posted\":").Append(posted)
                    .Append(",\"expected\":").Append(expected);
                if (posted != expected)
                    throw new InvalidOperationException("只投出去 " + posted + "/" + expected
                        + " 条 WM_CHAR——目标窗口可能已经销毁；重新 list 确认它还在。");
            }
            else
            {
                RECT rect = ReadRect(target);
                int centerX;
                int centerY;
                if (!WmPost.CenterOf(rect.Left, rect.Top, rect.Right, rect.Bottom, out centerX, out centerY))
                    throw new InvalidOperationException("这个控件的矩形是空的（" + rect.Left + "," + rect.Top + "–"
                        + rect.Right + "," + rect.Bottom + "）——它可能不可见；先截图或换一个控件。");
                int clientX;
                int clientY;
                bool sent = WmPost.PostClick(native, centerX, centerY, out clientX, out clientY);
                json.Append(",\"x\":").Append(centerX).Append(",\"y\":").Append(centerY)
                    .Append(",\"clientX\":").Append(clientX).Append(",\"clientY\":").Append(clientY);
                if (!sent)
                    throw new InvalidOperationException("WM_LBUTTONDOWN/UP 没投出去——目标窗口可能已经销毁。");
            }
            json.Append(",\"elapsedMs\":").Append(clock.ElapsedMilliseconds).Append("}");
            Program.Log("wm-act hwnd " + native.ToInt64() + " " + action + " → 「" + targetName + "」（"
                + controlType + "，" + clock.ElapsedMilliseconds + "ms）");
            return json.ToString();
        }
        finally
        {
            if (ownsTarget) Release(target);
            Release(window);
        }
    }

    /**
     * 控件不支持 ValuePattern 时改走会话内 PostMessage（uia-act setValue 的兜底）。
     * **只在 L2b 有意义**（那一档没有真实键盘），但在 WSB 里同样可用：
     * 一批自绘 / 第三方 Win32 控件本来就没有 ValuePattern，以前只能报「不支持」。
     * 回实际投出去的字符数；控件没有独立 HWND 时回 -1（调用方照旧报不支持）。
     */
    internal static int PostTextFallback(IntPtr target, string text)
    {
        int nativeRaw = ReadInt(target, SlotCurrentNativeWindowHandle);
        if (nativeRaw == 0) return -1;
        return WmPost.PostText(new IntPtr(nativeRaw), text);
    }

    /**
     * uia-act {hwnd?, title?, ref?, name?, action, value?, timeoutMs?}
     *   → `{ok:true,hwnd,action,usedPattern,name,controlType,autoSetFocus,elapsedMs}`
     *
     * 目标：ref（"g12:r3"，必须属于该窗口**最近一次** list 的那一代）优先，否则按 name 现枚举
     * 一遍（精确匹配优先，其次包含匹配）。动作按契约的三条走；模式取不到就回人话，不静默失败。
     * focus 不在这三条里：ValidateAct 会回一句点名替代路径的话（见 FocusRemovedMessage）。
     *
     * **ref 的代次校验是这一刀的核心**：旧 ref 在窗口变过之后指向的是另一个控件，而模型看不出来。
     * 代次对不上就**明确拒绝**（文案带「先重新 list」），绝不允许它静默地点到别的东西上。
     */
    internal static string ExecuteAct(string raw)
    {
        string action = NormalizeAction(Program.ExtractJsonString(raw, "action"));
        string value = Program.ExtractJsonString(raw, "value");
        string name = Program.ExtractJsonString(raw, "name");
        if (name != null) name = name.Trim();

        // ref 是字符串 token（"g12:r3"）：代次与序号在同一个格子里，模型没法配错对
        string refRaw = Program.ExtractJsonString(raw, "ref");
        bool hasRef = false;
        if (refRaw == null || refRaw.Trim().Length == 0)
        {
            // 上代格式的裸数字（0.10–0.13 是纯序号）：单独一句话教它照抄新的 ref，
            // 不要混进「参数缺失」里——它是**知道有 ref 这回事**的模型，只是格式旧了。
            string numeric = Program.ExtractNumber(raw, "ref");
            if (numeric != null) return Fail(RefFormatMessage());
        }
        else
        {
            int genCheck;
            int refCheck;
            string badRef = ParseRefToken(refRaw, out genCheck, out refCheck);
            if (badRef != null) return Fail(badRef);
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

        // 应用级准入（0.11.0）：目标窗口属于谁？观察模式，不拒，只标注进回执。
        // 在 STA 线程之外算（进程表快照与 UIA 无关），结果作为字符串交给 BuildActJson 拼进 JSON。
        Admission.Decision admit = Admission.JudgeWindow(hwnd.ToInt64(), Admission.Snapshot(),
            Admission.Roots(), Admission.MergeAllowExe(Program.ExtractString(raw, "allowExe")));
        Admission.Log("uia-act", admit);
        string admitJson = Admission.JsonFields(admit);

        bool timedOut;
        string json;
        try
        {
            json = Run(delegate
            {
                return BuildActJson(hwnd, action, hasRef, refRaw, hasName, name, value, admitJson);
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

    private static string BuildActJson(IntPtr hwnd, string action, bool hasRef, string refToken, bool hasName,
        string name, string value, string admitJson)
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
                // 代次校验 + 取元素指针。UiaSnapshot / 历史只在 STA 线程上读写，这里就在 STA 线程上。
                UiaHistoryStore store = _store;
                UiaSnapshot snapshot;
                int index;
                string badRef = ResolveRefToken(store, hwnd.ToInt64(), refToken, out snapshot, out index);
                if (badRef != null) throw new InvalidOperationException(badRef);
                if (index < 0 || index >= snapshot.Pointers.Count)
                    throw new InvalidOperationException("ref " + refToken + " 指向的控件已经不在了——重新 list 再动作。");
                target = snapshot.Pointers[index];
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
            int patternId = PatternIdForAction(action);
            // setValue 遇上**没有 ValuePattern** 的控件：改走会话内 PostMessage（WM_CHAR）。
            // 这条兜底在 L2b 里是主路（那一档没有真实键盘），在 WSB 里也救了一批自绘控件。
            // 只对 setValue 开这个口子：invoke / selection 用消息伪造会改错语义。
            if (action == "setValue" && !patterns.Contains("value"))
            {
                int posted = PostTextFallback(target, value);
                if (posted < 0)
                    throw new InvalidOperationException(UnsupportedMessage(action, controlType, patterns));
                int expected = WmPost.CharPayload(value).Length;
                if (posted != expected)
                    throw new InvalidOperationException("只投出去 " + posted + "/" + expected
                        + " 条 WM_CHAR——目标窗口可能已经销毁；重新 list 确认它还在。");
                hr = 0;
                usedPattern = "postMessage";
            }
            else
            {
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
            // setValue 的证据（0.15.0）：设完再读一次，**读回本身失败不抛异常**——动作已经做了，
            // 读不到只说明证明不了（unverifiable），不该把一次真实写操作变成工具错误。
            string readbackJson = "";
            if (action == "setValue")
            {
                // 读回**不能**把一次已成功的 SetValue 变成错误（元素可能在设完值后消失，
                // COM 也可能在那一刻失效）：读不到就是读不到，回 unverifiable。
                string readbackSource = "none";
                string readback = null;
                bool isPassword = false;
                try
                {
                    readback = ReadCurrentValue(target, out readbackSource);
                    isPassword = ReadIsPassword(target);
                }
                catch (Exception readbackError)
                {
                    Program.Log("uia-act setValue 读回失败（按拿不到证据处理）：" + readbackError.Message);
                    readbackSource = "none";
                    readback = null;
                    isPassword = false;
                }
                ReadbackVerdict verdict = JudgeSetValueReadback(value, readback, readbackSource, isPassword);
                readbackJson = ",\"delivery\":" + Program.JsonQuote(verdict.Delivery)
                    + ",\"readback\":" + Program.JsonQuote(verdict.Source);
                if (verdict.Detail != null)
                    readbackJson += ",\"evidence\":{\"kind\":\"value\",\"detail\":"
                        + Program.JsonQuote(verdict.Detail) + "}";
                // 日志只说读回走的哪条路与结论；密码框**不记录值**（这里本来也没输出过值）
                Program.Log("uia-act setValue 读回（" + verdict.Source + "）→ " + verdict.Delivery
                    + (isPassword ? "（密码框）" : ""));
            }
            StringBuilder json = new StringBuilder();
            json.Append("{\"ok\":true,\"hwnd\":").Append(hwnd.ToInt64())
                .Append(",\"action\":").Append(Program.JsonQuote(action))
                .Append(",\"usedPattern\":").Append(Program.JsonQuote(usedPattern))
                .Append(",\"name\":").Append(Program.JsonQuote(targetName))
                .Append(",\"controlType\":").Append(Program.JsonQuote(controlType))
                .Append(",\"autoSetFocus\":").Append(warning == null ? "true" : "false")
                .Append(",\"elapsedMs\":").Append(clock.ElapsedMilliseconds)
                .Append(readbackJson)
                .Append(admitJson);
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
        CheckTrue(failures, ref cases, "focus 已删除，没有模式", PatternNameForAction("focus") == null);
        CheckTrue(failures, ref cases, "未知动作没有模式", PatternNameForAction("click") == null);
        CheckNumber(failures, ref cases, "invoke 用 UIA_InvokePatternId", "10000",
            PatternIdForAction("invoke").ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "setValue 用 UIA_ValuePatternId", "10002",
            PatternIdForAction("setValue").ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "selection 用 UIA_SelectionItemPatternId", "10010",
            PatternIdForAction("selection").ToString(CultureInfo.InvariantCulture));
        CheckTrue(failures, ref cases, "规范化之后 setValue 校验仍认 value", ValidateAct("setValue", true, false, true) == null);
        CheckString(failures, ref cases, "动作名规范化（大小写 / 空白）", "invoke", NormalizeAction("  Invoke "));
        CheckString(failures, ref cases, "动作名规范化：setValue 回规范写法（不是全小写）", "setValue",
            NormalizeAction(" SetValue "));
        CheckString(failures, ref cases, "规范化之后能选中 value 模式", "value",
            PatternNameForAction(NormalizeAction("SETVALUE")));
        CheckString(failures, ref cases, "规范化之后 focus 仍是 focus（好让校验认出并给替代方案）",
            "focus", NormalizeAction(" FOCUS "));

        // ③ 参数校验：错在哪儿就说哪儿
        CheckTrue(failures, ref cases, "缺 action → 报三个动作",
            ValidateAct(null, false, true, true) != null
            && ValidateAct(null, false, true, true).IndexOf("invoke / setValue / selection", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "未知 action → 拒绝", ValidateAct("click", false, true, true) != null);
        CheckTrue(failures, ref cases, "invoke 缺 ref 与 name → 拒绝",
            ValidateAct("invoke", false, false, false) != null);
        CheckTrue(failures, ref cases, "invoke 给了 ref → 通过", ValidateAct("invoke", true, false, false) == null);
        CheckTrue(failures, ref cases, "invoke 给了 name → 通过", ValidateAct("invoke", false, true, false) == null);
        CheckTrue(failures, ref cases, "setValue 缺 value → 拒绝（文案点名 value）",
            ValidateAct("setValue", true, false, false) != null
            && ValidateAct("setValue", true, false, false).IndexOf("value", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "setValue 空串也算给了 value", ValidateAct("setValue", true, false, true) == null);
        // focus 是一个被删掉的动作：拒绝的同时必须给两条替代路径（模型看不见 UI，不会自己想到）
        string focusRemoved = ValidateAct("focus", true, false, false);
        CheckTrue(failures, ref cases, "focus → 拒绝（即使 ref 齐全）", focusRemoved != null);
        CheckTrue(failures, ref cases, "focus 的拒绝文案给 pixel 退路（computer_click）",
            focusRemoved != null && focusRemoved.IndexOf("computer_click", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "focus 的拒绝文案给 UIA 退路（invoke / setValue）",
            focusRemoved != null && focusRemoved.IndexOf("invoke", StringComparison.Ordinal) >= 0
            && focusRemoved.IndexOf("setValue", StringComparison.Ordinal) >= 0);

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
        sample.Generation = 3;
        sample.RefToken = RefToken(3, 2);
        sample.StableId = "rt:2a.4d2";
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
        CheckTrue(failures, ref cases, "项 JSON 带 ref（代次 token）/ 稳定 id / 坐标",
            itemJson.IndexOf("\"ref\":\"g3:r2\"", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"stableId\":\"rt:2a.4d2\"", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"x\":10", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"h\":40", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "全量回执的项不带 diff 字段",
            itemJson.IndexOf("\"change\"", StringComparison.Ordinal) < 0);
        CheckTrue(failures, ref cases, "项 JSON 的模式数组",
            itemJson.IndexOf("\"patterns\":[\"invoke\"]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "项 JSON 转义引号与反斜杠",
            itemJson.IndexOf("保存\\\"并关闭\\\\", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "项 JSON 的布尔与中文都原样",
            itemJson.IndexOf("\"enabled\":true", StringComparison.Ordinal) >= 0
            && itemJson.IndexOf("\"offscreen\":false", StringComparison.Ordinal) >= 0);

        // ⑪ 密码框：isPassword 的读取判定（**遮罩的唯一数据源**，读错就是漏密码）
        CheckTrue(failures, ref cases, "IsPassword 读得到：BOOL TRUE(1) → true", InterpretPassword(true, 1));
        CheckTrue(failures, ref cases, "IsPassword 读得到：VARIANT_TRUE(-1) → true", InterpretPassword(true, -1));
        CheckTrue(failures, ref cases, "IsPassword 读得到：FALSE(0) → false", !InterpretPassword(true, 0));
        CheckTrue(failures, ref cases, "IsPassword 读不到（老控件不支持）→ false",
            !InterpretPassword(false, 1));
        CheckTrue(failures, ref cases, "IsPassword 读不到且脏值 → false", !InterpretPassword(false, -1));
        CheckTrue(failures, ref cases, "IsPassword 非布尔值(7) → 当 false，不拿它去遮",
            !InterpretPassword(true, 7));
        CheckTrue(failures, ref cases, "IsPassword 非布尔值(2) → 当 false", !InterpretPassword(true, 2));
        // 槽号是内插出来的：它必须**夹在两条已验证的邻居之间**（IsControlElement 31 < IsPassword 35 < IsOffscreen 36）
        CheckTrue(failures, ref cases, "IsPassword 槽号夹在 IsControlElement 与 IsOffscreen 之间",
            SlotCurrentIsControlElement < SlotCurrentIsPassword
            && SlotCurrentIsPassword < SlotCurrentIsOffscreen);
        CheckNumber(failures, ref cases, "IsPassword 槽号 = 3 + 33 - 1",
            "35", SlotCurrentIsPassword.ToString(CultureInfo.InvariantCulture));

        UiaItemInfo plain = new UiaItemInfo();
        plain.Ref = 1;
        plain.Name = "用户名";
        plain.ControlType = "edit";
        CheckTrue(failures, ref cases, "普通控件默认不是密码框", !plain.IsPassword);
        plain.IsPassword = true;
        plain.Name = "";
        plain.AutomationId = "";
        CheckTrue(failures, ref cases, "项 JSON 带 isPassword",
            ItemJson(plain).IndexOf("\"isPassword\":true", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "非密码框写 false（不是省略）",
            ItemJson(new UiaItemInfo()).IndexOf("\"isPassword\":false", StringComparison.Ordinal) >= 0);

        // ⑫ ref 带代次：一个格子照抄，拆开就会配错对
        CheckString(failures, ref cases, "ref token 的写法", "g12:r3", RefToken(12, 3));
        int genNo;
        int refNo;
        CheckTrue(failures, ref cases, "ref token 解析 g12:r3",
            ParseRefToken("g12:r3", out genNo, out refNo) == null && genNo == 12 && refNo == 3);
        CheckTrue(failures, ref cases, "ref token 解析：大小写与空白都容忍",
            ParseRefToken(" G7:R2 ", out genNo, out refNo) == null && genNo == 7 && refNo == 2);
        CheckTrue(failures, ref cases, "裸数字不再被当成 ref（教它照抄 token）",
            ParseRefToken("3", out genNo, out refNo) != null
            && RefFormatMessage().IndexOf("g12:r3", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "代次 0 拒绝", ParseRefToken("g0:r1", out genNo, out refNo) != null);
        CheckTrue(failures, ref cases, "序号 0 拒绝", ParseRefToken("g1:r0", out genNo, out refNo) != null);
        CheckTrue(failures, ref cases, "两半颠倒拒绝", ParseRefToken("r3:g12", out genNo, out refNo) != null);
        CheckTrue(failures, ref cases, "缺一半拒绝", ParseRefToken("g12", out genNo, out refNo) != null);
        CheckTrue(failures, ref cases, "非数字拒绝", ParseRefToken("gx:ry", out genNo, out refNo) != null);
        CheckTrue(failures, ref cases, "空 ref 拒绝", ParseRefToken("   ", out genNo, out refNo) != null);

        // ⑬ 稳定 id：RuntimeId 优先，退化到属性哈希；同一棵树两次 list 必须一致（本 PR 的核心正确性）
        int[] runtimeA = new int[] { 42, 1234, 99 };
        CheckString(failures, ref cases, "RuntimeId → rt: 十六进制", "rt:2a.4d2.63", StableIdFromRuntimeId(runtimeA));
        CheckTrue(failures, ref cases, "RuntimeId 空数组 → null（调用方退化）", StableIdFromRuntimeId(new int[0]) == null);
        CheckTrue(failures, ref cases, "RuntimeId null → null", StableIdFromRuntimeId(null) == null);
        CheckTrue(failures, ref cases, "同一组 RuntimeId 值（新数组实例）→ 同一个 id",
            StableIdFromRuntimeId(new int[] { 42, 1234, 99 }) == StableIdFromRuntimeId(runtimeA));
        CheckTrue(failures, ref cases, "不同 RuntimeId → 不同 id",
            StableIdFromRuntimeId(runtimeA) != StableIdFromRuntimeId(new int[] { 42, 1234, 100 }));
        string fallbackA = FallbackStableId("button", "Button", "保存", "save");
        string fallbackB = FallbackStableId("button", "Button", "保存", "save");
        CheckTrue(failures, ref cases, "退化 id 稳定（同属性 → 同 id）并带 h: 前缀",
            fallbackA == fallbackB && fallbackA.StartsWith("h:", StringComparison.Ordinal));
        CheckTrue(failures, ref cases, "退化 id 固定 8 位十六进制", fallbackA.Length == 10);
        CheckTrue(failures, ref cases, "退化 id 随名字变",
            fallbackA != FallbackStableId("button", "Button", "保存并关闭", "save"));
        CheckTrue(failures, ref cases, "退化 id 随控件类型变",
            fallbackA != FallbackStableId("edit", "Button", "保存", "save"));
        CheckTrue(failures, ref cases, "退化 id 随 automationId 变",
            fallbackA != FallbackStableId("button", "Button", "保存", "save2"));
        CheckTrue(failures, ref cases, "退化 id 随类名变",
            fallbackA != FallbackStableId("button", "Button2", "保存", "save"));
        CheckString(failures, ref cases, "同代第一个不加后缀", "h:abc", DisambiguateStableId("h:abc", 1));
        CheckString(failures, ref cases, "同代第二个补 #2", "h:abc#2", DisambiguateStableId("h:abc", 2));
        // **同一棵树枚举两次**：同一批元素（同顺序、同属性）走两次 StableIdFor，得到同一串 id
        Dictionary<string, int> seenFirst = new Dictionary<string, int>();
        Dictionary<string, int> seenSecond = new Dictionary<string, int>();
        List<string> idsFirst = new List<string>();
        List<string> idsSecond = new List<string>();
        for (int i = 0; i < 4; i++)
        {
            idsFirst.Add(StableIdFor(new int[] { 42, 700 + i }, "button", "Button", "按钮" + i, "", seenFirst));
            idsSecond.Add(StableIdFor(new int[] { 42, 700 + i }, "button", "Button", "按钮" + i, "", seenSecond));
        }
        CheckTrue(failures, ref cases, "同一棵树两次 list：稳定 id 逐条一致（RuntimeId 路径）",
            string.Join("|", idsFirst.ToArray()) == string.Join("|", idsSecond.ToArray()));
        CheckTrue(failures, ref cases, "同一棵树两次 list：稳定 id 互不相同（没串号）",
            idsFirst[0] != idsFirst[1] && idsFirst[1] != idsFirst[2] && idsFirst[2] != idsFirst[3]);
        // 没有 RuntimeId 的提供者（退化路径）也一样稳定
        Dictionary<string, int> seenFallback1 = new Dictionary<string, int>();
        Dictionary<string, int> seenFallback2 = new Dictionary<string, int>();
        List<string> fallbackIds1 = new List<string>();
        List<string> fallbackIds2 = new List<string>();
        for (int i = 0; i < 3; i++)
        {
            fallbackIds1.Add(StableIdFor(null, "button", "Button", "同名" + i, "", seenFallback1));
            fallbackIds2.Add(StableIdFor(null, "button", "Button", "同名" + i, "", seenFallback2));
        }
        CheckTrue(failures, ref cases, "同一棵树两次 list：退化 id 也一致",
            string.Join("|", fallbackIds1.ToArray()) == string.Join("|", fallbackIds2.ToArray()));
        // 两个一模一样的控件（同属性）不能共用一个 id，否则 diff 会把它们当成同一个
        Dictionary<string, int> seenTwin = new Dictionary<string, int>();
        string twin1 = StableIdFor(null, "button", "Button", "确定", "", seenTwin);
        string twin2 = StableIdFor(null, "button", "Button", "确定", "", seenTwin);
        CheckTrue(failures, ref cases, "同代里两个一模一样的控件 → 补 #2 消歧", twin1 != twin2 && twin2.EndsWith("#2", StringComparison.Ordinal));

        // ⑭ 历史与代次：每 list 一次 +1；只留最近 5 代；过期 ref 被明确拒绝
        UiaGenerations generations = new UiaGenerations();
        long hwndKey = 900001;
        CheckTrue(failures, ref cases, "代次从 1 起", generations.Next(hwndKey) == 1);
        CheckTrue(failures, ref cases, "签发时逐个递增（复用由收集层按指纹决定，不走这里）",
            generations.Next(hwndKey) == 2 && generations.Next(hwndKey) == 3);

        // 指纹：树没变 → 同一串；改任何一处 → 变。收集层据此**复用代次**，
        // 让「list 完刚拿到的 ref」不会因为又查了一次就作废（2026-11-14 真机撞到）。
        UiaSnapshot fpSnap1 = new UiaSnapshot();
        UiaItemInfo fpItem1 = new UiaItemInfo();
        fpItem1.StableId = "rt:1";
        fpItem1.Name = "确定";
        fpItem1.ControlType = "button";
        fpItem1.Patterns.Add("invoke");
        fpItem1.Enabled = true;
        fpItem1.X = 10;
        fpItem1.Y = 20;
        fpItem1.W = 80;
        fpItem1.H = 30;
        fpSnap1.Items.Add(fpItem1);
        string fpBase = FingerprintOf(fpSnap1);
        UiaSnapshot fpSnap2 = new UiaSnapshot();
        UiaItemInfo fpItem2 = new UiaItemInfo();
        fpItem2.StableId = "rt:1";
        fpItem2.Name = "确定";
        fpItem2.ControlType = "button";
        fpItem2.Patterns.Add("invoke");
        fpItem2.Enabled = true;
        fpItem2.X = 10;
        fpItem2.Y = 20;
        fpItem2.W = 80;
        fpItem2.H = 30;
        fpSnap2.Items.Add(fpItem2);
        CheckTrue(failures, ref cases, "指纹：同一棵树（新对象、同属性）→ 同一串", fpBase == FingerprintOf(fpSnap2));
        CheckTrue(failures, ref cases, "指纹带 f: 前缀并附条数", fpBase.StartsWith("f:", StringComparison.Ordinal) && fpBase.EndsWith(":1", StringComparison.Ordinal));
        fpItem2.Enabled = false;
        CheckTrue(failures, ref cases, "指纹：enabled 变了 → 变了", fpBase != FingerprintOf(fpSnap2));
        fpItem2.Enabled = true;
        fpItem2.X = 11;
        // 矩形**不进指纹**（2026-11-14 决定）：位置挪动不代表控件树变了，ref 按 stableId 映射，
        // 让代次因 rect 微动而推进，就会误伤刚发出去的 ref（Edge 实测 21 条里 16 条 rect 在动）。
        // 位置变化由 diff 的 rectMoved 单独计数。
        CheckTrue(failures, ref cases, "指纹：位置挪了 → 指纹不变（ref 仍有效）", fpBase == FingerprintOf(fpSnap2));
        fpItem2.X = 10;
        fpItem2.Patterns.Add("value");
        CheckTrue(failures, ref cases, "指纹：支持的模式变了 → 变了", fpBase != FingerprintOf(fpSnap2));
        fpItem2.Patterns.RemoveAt(1);
        UiaItemInfo itemC = new UiaItemInfo();
        itemC.StableId = "rt:2";
        itemC.Name = "取消";
        itemC.ControlType = "button";
        fpSnap2.Items.Add(itemC);
        CheckTrue(failures, ref cases, "指纹：多了一个控件 → 变了（条数也进指纹）", fpBase != FingerprintOf(fpSnap2));

        UiaHistoryStore store = new UiaHistoryStore();
        List<IntPtr> releasedPointers = new List<IntPtr>();
        Action<IntPtr> release = delegate(IntPtr pointer) { releasedPointers.Add(pointer); };
        UiaSnapshot snapA = TestSnapshot(1, new string[] { "rt:1", "rt:2" }, new string[] { "确定", "取消" });
        snapA.Pointers.Add(new IntPtr(11));
        snapA.Pointers.Add(new IntPtr(12));
        store.Push(hwndKey, snapA, release);
        CheckTrue(failures, ref cases, "最新一代就是刚收的那一代", store.Latest(hwndKey) == snapA);
        CheckTrue(failures, ref cases, "按代次能找回",
            store.ByGeneration(hwndKey, 1) == snapA && store.ByGeneration(hwndKey, 2) == null);

        // 过期 ref：第 2 代已经发出去了，手上还拿着第 1 代的 token
        UiaSnapshot snapB = TestSnapshot(2, new string[] { "rt:1", "rt:3" }, new string[] { "确定", "复制" });
        store.Push(hwndKey, snapB, release);
        CheckTrue(failures, ref cases, "新一代收下时上一代的元素指针被释放（不泄漏 COM 引用）",
            releasedPointers.Count == 2 && releasedPointers[0] == new IntPtr(11) && releasedPointers[1] == new IntPtr(12));
        CheckTrue(failures, ref cases, "上一代的指针已经清空（ref 只对最新一代有效）",
            snapA.Pointers.Count == 0 && snapB.Pointers.Count == 0);
        UiaSnapshot resolved;
        int resolvedIndex;
        string staleError = ResolveRefToken(store, hwndKey, "g1:r1", out resolved, out resolvedIndex);
        CheckTrue(failures, ref cases, "过期 ref 被拒（不是静默放行）", staleError != null && resolved == null);
        CheckTrue(failures, ref cases, "过期 ref 的文案说清「属于第 1 次 / 现在是第 2 次」",
            staleError != null && staleError.IndexOf("第 1 次", StringComparison.Ordinal) >= 0
            && staleError.IndexOf("第 2 次", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "过期 ref 的文案让模型重新 list（真机验收要搜这句）",
            staleError != null && staleError.IndexOf("重新 list", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "当前代的 ref 能解析到快照与下标",
            ResolveRefToken(store, hwndKey, "g2:r2", out resolved, out resolvedIndex) == null
            && resolved == snapB && resolvedIndex == 1);
        CheckTrue(failures, ref cases, "当前代越界的序号被拒（文案带重新 list）",
            ResolveRefToken(store, hwndKey, "g2:r9", out resolved, out resolvedIndex) != null
            && ResolveRefToken(store, hwndKey, "g2:r9", out resolved, out resolvedIndex).IndexOf("重新 list", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "从没 list 过的窗口：任何 ref 都被拒（文案带重新 list）",
            ResolveRefToken(store, 900002, "g1:r1", out resolved, out resolvedIndex) != null
            && ResolveRefToken(store, 900002, "g1:r1", out resolved, out resolvedIndex).IndexOf("重新 list", StringComparison.Ordinal) >= 0);

        // 只留最近 5 代：第 6 代收进来之后第 1 代就被淘汰
        long hwndTrim = 900003;
        for (int i = 1; i <= UiaHistoryStore.Retain + 1; i++)
        {
            UiaSnapshot snap = TestSnapshot(i, new string[] { "rt:" + i }, new string[] { "控件" + i });
            store.Push(hwndTrim, snap, release);
        }
        CheckTrue(failures, ref cases, "只保留最近 5 代（最旧的丢掉）",
            store.ByGeneration(hwndTrim, 1) == null && store.ByGeneration(hwndTrim, 2) != null);
        CheckTrue(failures, ref cases, "保留的最新一代没被丢掉",
            store.Latest(hwndTrim) != null && store.Latest(hwndTrim).Generation == UiaHistoryStore.Retain + 1);

        // ⑮ diff：按稳定 id 比，不按序号比
        UiaSnapshot beforeDiff = TestSnapshot(4, new string[] { "rt:a", "rt:b", "rt:c" }, new string[] { "确定", "取消", "帮助" });
        UiaSnapshot afterDiff = TestSnapshot(5, new string[] { "rt:a", "rt:c", "rt:d" }, new string[] { "确定", "帮助", "保存" });
        afterDiff.ById["rt:c"].Enabled = false;
        UiaDiffResult diffBoth = DiffSnapshots(beforeDiff, afterDiff);
        CheckTrue(failures, ref cases, "diff：没变的控件不出现，只计数",
            diffBoth.Unchanged == 1 && diffBoth.Items.Count == 2);
        CheckTrue(failures, ref cases, "diff：新出现的控件标 added",
            diffBoth.Items.Count == 2 && diffBoth.Items[0].StableId == "rt:c" && diffBoth.Items[0].Change == "changed"
            && diffBoth.Items[1].StableId == "rt:d" && diffBoth.Items[1].Change == "added");
        CheckTrue(failures, ref cases, "diff：变了哪些字段说得出来（enabled）",
            diffBoth.Items[0].ChangedFields != null && diffBoth.Items[0].ChangedFields.Contains("enabled"));
        CheckTrue(failures, ref cases, "diff：消失的控件单独报出来（只 1 条）",
            diffBoth.Removed.Count == 1 && diffBoth.Removed[0].StableId == "rt:b"
            && diffBoth.Removed[0].Name == "取消");
        CheckTrue(failures, ref cases, "diff：消失的项不带 ref（它已经没有那一代里的位置）",
            RemovedJson(diffBoth.Removed[0]).IndexOf("\"ref\"", StringComparison.Ordinal) < 0
            && RemovedJson(diffBoth.Removed[0]).IndexOf("rt:b", StringComparison.Ordinal) >= 0);
        // 下面的「没变」用例要拿一个干净的一代当基准：上面刚刚把 rt:c 改成 disabled 了
        afterDiff.ById["rt:c"].Enabled = true;
        UiaDiffResult diffSame = DiffSnapshots(afterDiff, TestSnapshot(6, new string[] { "rt:a", "rt:c", "rt:d" },
            new string[] { "确定", "帮助", "保存" }));
        CheckTrue(failures, ref cases, "diff：完全没变 → 0 条变化 + unchanged 计数为全部",
            diffSame.Items.Count == 0 && diffSame.Removed.Count == 0 && diffSame.Unchanged == 3);
        UiaSnapshot renamed = TestSnapshot(6, new string[] { "rt:a", "rt:c", "rt:d" }, new string[] { "确认", "帮助", "保存" });
        UiaDiffResult diffRenamed = DiffSnapshots(afterDiff, renamed);
        CheckTrue(failures, ref cases, "diff：名字变了算同一条的 name 变化（不是消失 + 新增）",
            diffRenamed.Items.Count == 1 && diffRenamed.Items[0].Change == "changed"
            && diffRenamed.Items[0].ChangedFields.Contains("name") && diffRenamed.Removed.Count == 0);
        UiaSnapshot moved = TestSnapshot(6, new string[] { "rt:a", "rt:c", "rt:d" }, new string[] { "确定", "帮助", "保存" });
        moved.ById["rt:a"].X = 123;
        UiaDiffResult diffMoved = DiffSnapshots(afterDiff, moved);
        CheckTrue(failures, ref cases, "diff：只挪了位置 → 不逐条列，计入 rectMoved",
            diffMoved.Items.Count == 0 && diffMoved.RectMoved == 1);
        // 位置 + 别的字段一起变：仍按「变了」列出来（rect 在 ChangedFields 里，但那条有真变化）
        moved.ById["rt:c"].Enabled = false;
        UiaDiffResult diffBoth2 = DiffSnapshots(afterDiff, moved);
        // rt:c 只有 enabled 变（它的 rect 没动）→ 按 changed 列出；rt:a 只挪位置 → 仍计 rectMoved。
        // 两条互不干扰：这是「真变化」与「纯位置变化」分流的直接证据。
        CheckTrue(failures, ref cases, "diff：真变化那条按 changed 列出，纯位置那条仍只计 rectMoved",
            diffBoth2.Items.Count == 1 && diffBoth2.Items[0].ChangedFields.Contains("enabled")
            && !diffBoth2.Items[0].ChangedFields.Contains("rect") && diffBoth2.RectMoved == 1);

        // ⑯ since 的三种处境：没带 → 全量；带且还在 → diff；太旧 / 不是这个窗口的 → 全量 + 说明
        UiaSnapshot probe = TestSnapshot(2, new string[] { "rt:x" }, new string[] { "X" });
        UiaHistoryStore planStore = new UiaHistoryStore();
        planStore.Push(900010, probe, release);
        UiaDiffPlan noSince = PlanList(planStore, 900010, false, 0);
        CheckTrue(failures, ref cases, "since 缺省 → 全量（与改之前同一行为）",
            noSince.Mode == "full" && noSince.Base == null && noSince.Note == null);
        UiaDiffPlan sameSince = PlanList(planStore, 900010, true, 2);
        CheckTrue(failures, ref cases, "since 命中还留着的那一代 → diff",
            sameSince.Mode == "diff" && sameSince.Base == probe && sameSince.Since == 2);
        UiaDiffPlan futureSince = PlanList(planStore, 900010, true, 99);
        CheckTrue(failures, ref cases, "since 不是这个窗口的代次 → 全量 + 说明这次是全量",
            futureSince.Mode == "full" && futureSince.Note != null
            && futureSince.Note.IndexOf("全量", StringComparison.Ordinal) >= 0);
        UiaHistoryStore oldStore = new UiaHistoryStore();
        for (int i = 1; i <= UiaHistoryStore.Retain + 2; i++)
            oldStore.Push(900011, TestSnapshot(i, new string[] { "rt:y" }, new string[] { "Y" }), release);
        UiaDiffPlan tooOld = PlanList(oldStore, 900011, true, 1);
        CheckTrue(failures, ref cases, "since 太旧（已被淘汰）→ 全量 + 「记不住那么早」",
            tooOld.Mode == "full" && tooOld.Note != null
            && tooOld.Note.IndexOf("记不住那么早的清单了", StringComparison.Ordinal) >= 0
            && tooOld.Note.IndexOf("全量", StringComparison.Ordinal) >= 0);

        // ⑰ diff 项与全量项的 JSON 形状：change / changed 只在 diff 项上
        UiaItemInfo changedItem = TestSnapshot(7, new string[] { "rt:z" }, new string[] { "设置" }).Items[0];
        string plainJson = ItemJson(changedItem);
        string diffJson = ItemJson(changedItem, "changed", new List<string>() { "enabled", "rect" });
        CheckTrue(failures, ref cases, "diff 项带 change 与 changed 列表",
            diffJson.IndexOf("\"change\":\"changed\"", StringComparison.Ordinal) >= 0
            && diffJson.IndexOf("\"changed\":[\"enabled\",\"rect\"]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "added 项没有 changed 列表",
            ItemJson(changedItem, "added", null).IndexOf("\"changed\"", StringComparison.Ordinal) < 0);
        CheckTrue(failures, ref cases, "diff 项的 ref 仍是本代 token",
            diffJson.IndexOf("\"ref\":\"g7:r1\"", StringComparison.Ordinal) >= 0
            && plainJson.IndexOf("\"change\"", StringComparison.Ordinal) < 0);

        // ⑧ setValue 的读回证据（0.15.0）：三档 + 密码框不带值 + detail 不超长
        ReadbackVerdict same = JudgeSetValueReadback("新建文本.txt", "新建文本.txt", "value", false);
        CheckString(failures, ref cases, "读回与期望一致 → confirmed", "confirmed", same.Delivery);
        CheckTrue(failures, ref cases, "一致时带 evidence（kind=value，写清读回通道）",
            same.Detail != null && same.Detail.IndexOf("ValuePattern.Current.Value", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "**evidence 不回显原文**（只给长度）",
            same.Detail != null && same.Detail.IndexOf("新建文本.txt", StringComparison.Ordinal) < 0
            && same.Detail.IndexOf("8 字符", StringComparison.Ordinal) >= 0);
        CheckString(failures, ref cases, "读回的来源原样写进回执", "value", same.Source);

        ReadbackVerdict changed = JudgeSetValueReadback("hello", "hello world", "value", false);
        CheckString(failures, ref cases, "读回与期望不一致 → suspected_noop", "suspected_noop", changed.Delivery);
        CheckTrue(failures, ref cases, "不一致时 evidence 给出两个长度（不回显原文）",
            changed.Detail != null && changed.Detail.IndexOf("5 字符", StringComparison.Ordinal) >= 0
            && changed.Detail.IndexOf("11 字符", StringComparison.Ordinal) >= 0
            && changed.Detail.IndexOf("hello", StringComparison.Ordinal) < 0);

        // 大小写各试一次：任何形式的原文都不许出现在证据里
        ReadbackVerdict leak = JudgeSetValueReadback("SeCrEt-Zq9-KEY", "SeCrEt-Zq9-KEY", "value", false);
        CheckTrue(failures, ref cases, "证据里没有原文（大小写都不许出现）",
            leak.Detail != null
            && leak.Detail.IndexOf("secret", StringComparison.OrdinalIgnoreCase) < 0
            && leak.Detail.IndexOf("Zq9", StringComparison.Ordinal) < 0);
        CheckTrue(failures, ref cases, "证据里给出长度 13", leak.Detail != null
            && leak.Detail.IndexOf("14 字符", StringComparison.Ordinal) >= 0);

        ReadbackVerdict missing = JudgeSetValueReadback("x", null, "none", false);
        CheckString(failures, ref cases, "拿不到读回 → unverifiable（不猜 confirmed）", "unverifiable", missing.Delivery);
        CheckTrue(failures, ref cases, "拿不到读回时**不发**空证据（没证据就是没证据）", missing.Detail == null);
        CheckString(failures, ref cases, "拿不到读回时 source = none", "none", missing.Source);

        ReadbackVerdict secretOk = JudgeSetValueReadback("hunter2", "hunter2", "value", true);
        CheckString(failures, ref cases, "密码框一致 → confirmed", "confirmed", secretOk.Delivery);
        CheckString(failures, ref cases, "密码框的 evidence 只写「一致」，不带值",
            "密码框：读回值与期望一致", secretOk.Detail);
        ReadbackVerdict secretBad = JudgeSetValueReadback("hunter2", "hunter3", "value", true);
        CheckString(failures, ref cases, "密码框不一致 → suspected_noop", "suspected_noop", secretBad.Delivery);
        CheckTrue(failures, ref cases, "密码框不一致的证据不带值（两个值都不许出现）",
            secretBad.Detail != null && secretBad.Detail.IndexOf("hunter2", StringComparison.Ordinal) < 0
            && secretBad.Detail.IndexOf("hunter3", StringComparison.Ordinal) < 0
            && secretBad.Detail.IndexOf("不一致", StringComparison.Ordinal) >= 0);

        ReadbackVerdict textTail = JudgeSetValueReadback("abc", "abc\r\n", "text", false);
        CheckString(failures, ref cases, "TextPattern 尾部的段落符不算「没设进去」", "confirmed", textTail.Delivery);
        ReadbackVerdict valueTail = JudgeSetValueReadback("abc", "abc\r\n", "value", false);
        CheckString(failures, ref cases, "ValuePattern 是逐字比（尾部换行也算不一致）", "suspected_noop",
            valueTail.Delivery);

        StringBuilder longValue = new StringBuilder();
        for (int i = 0; i < 400; i++) longValue.Append('x');
        ReadbackVerdict clipped = JudgeSetValueReadback(longValue.ToString(), longValue.ToString(), "value", false);
        CheckTrue(failures, ref cases, "超长值只报长度（detail 本身不会被原文撑爆）",
            clipped.Detail.Length <= EvidenceDetailMax
            && clipped.Detail.IndexOf("400 字符", StringComparison.Ordinal) >= 0);
        ReadbackVerdict multiline = JudgeSetValueReadback("a\nb", "a\nb", "value", false);
        CheckTrue(failures, ref cases, "证据是单行、且不回显原文（只给长度）",
            multiline.Detail.IndexOf((char)10) < 0 && multiline.Detail.IndexOf("3 字符", StringComparison.Ordinal) >= 0);

        // 槽号是内插出来的：三个新槽必须**夹在已知邻居之间**，数错一格就是调错函数
        CheckNumber(failures, ref cases, "ValuePattern get_CurrentValue 槽号 = 3 + 2 - 1", "4",
            SlotValueCurrentValue.ToString(CultureInfo.InvariantCulture));
        CheckTrue(failures, ref cases, "ValuePattern 三个槽的顺序（SetValue < CurrentValue < IsReadOnly）",
            SlotSetValue < SlotValueCurrentValue && SlotValueCurrentValue < SlotValueIsReadOnly);
        CheckNumber(failures, ref cases, "TextPattern get_DocumentRange 槽号 = 3 + 5 - 1", "7",
            SlotTextDocumentRange.ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "TextRange GetText 槽号 = 3 + 10 - 1", "12",
            SlotTextRangeGetText.ToString(CultureInfo.InvariantCulture));
        CheckNumber(failures, ref cases, "UIA_TextPatternId = 10014", "10014",
            TextPatternId.ToString(CultureInfo.InvariantCulture));

        // 槽号 → 方法名：只比字面值 6 会跟错的注释一起自洽，所以按头文件次序写成表再对名。
        // TextPattern 曾经漏掉 GetVisibleRanges（数组返回），槽 6 于是落到它身上、把数组当 TextRange 用。
        CheckString(failures, ref cases, "IUIAutomationTextPattern 方法次序与头文件一致",
            "RangeFromPoint|RangeFromChild|GetSelection|GetVisibleRanges|get_DocumentRange|get_SupportedTextSelection",
            string.Join("|", TextPatternMethods));
        CheckString(failures, ref cases, "SlotTextDocumentRange 解析出 get_DocumentRange（不是 GetVisibleRanges）",
            "get_DocumentRange", MethodNameAt(TextPatternMethods, SlotTextDocumentRange));
        CheckString(failures, ref cases, "SlotTextDocumentRange 的邻居是 GetVisibleRanges（漏一项就会错位到这里）",
            "GetVisibleRanges", MethodNameAt(TextPatternMethods, SlotTextDocumentRange - 1));
        CheckString(failures, ref cases, "IUIAutomationValuePattern 方法次序与头文件一致",
            "SetValue|get_CurrentValue|get_CurrentIsReadOnly|get_CachedValue|get_CachedIsReadOnly",
            string.Join("|", ValuePatternMethods));
        CheckString(failures, ref cases, "SlotValueCurrentValue 解析出 get_CurrentValue",
            "get_CurrentValue", MethodNameAt(ValuePatternMethods, SlotValueCurrentValue));
        CheckString(failures, ref cases, "SlotValueIsReadOnly 解析出 get_CurrentIsReadOnly",
            "get_CurrentIsReadOnly", MethodNameAt(ValuePatternMethods, SlotValueIsReadOnly));
        CheckString(failures, ref cases, "IUIAutomationTextRange 方法次序与头文件一致",
            "Clone|Compare|CompareEndpoints|ExpandToEnclosingUnit|FindAttribute|FindText|GetAttributeValue"
            + "|GetBoundingRectangles|GetEnclosingElement|GetText|Move|MoveEndpointByUnit|MoveEndpointByRange"
            + "|Select|AddToSelection|RemoveFromSelection|ScrollIntoView|GetChildren",
            string.Join("|", TextRangeMethods));
        CheckString(failures, ref cases, "SlotTextRangeGetText 解析出 GetText（不是 GetEnclosingElement）",
            "GetText", MethodNameAt(TextRangeMethods, SlotTextRangeGetText));

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    /** selftest 用：造一代快照（ids / names 平行；不碰 COM，所以能在宿主上跑） */
    private static UiaSnapshot TestSnapshot(int generation, string[] stableIds, string[] names)
    {
        UiaSnapshot snapshot = new UiaSnapshot();
        snapshot.Generation = generation;
        for (int i = 0; i < stableIds.Length; i++)
        {
            UiaItemInfo item = new UiaItemInfo();
            item.Ref = RefOf(i);
            item.Generation = generation;
            item.RefToken = RefToken(generation, item.Ref);
            item.StableId = stableIds[i];
            item.Name = names[i];
            item.ControlType = "button";
            item.Enabled = true;
            item.Patterns.Add("invoke");
            snapshot.Items.Add(item);
            snapshot.ById[item.StableId] = item;
        }
        return snapshot;
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
