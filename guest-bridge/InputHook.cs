// Orbita guest bridge —— 输入让路（0.11.0）：谁是「人」，谁是「注入」。
//
// 为什么需要它：沙箱是一台完整的 VM，用户可以直接进去打字 / 点鼠标。而 agent 的像素动作
// （click / type / key / scroll）走 SendInput，注入的是**当前桌面的真实输入流**——两边同时
// 动手就是互相串输入：agent 的按键落进用户正在敲的搜索框，或者用户的回车提交了 agent 刚填
// 到一半的表单。本仓的既有裁决是**用户优先**：用户真在输入时，agent 的动作让路。
//
// 为什么不用 GetLastInputInfo：微软文档明写那个 tick 会被 SendInput **自己**推进
// （"…or an event raised by SendInput, which supplies its own tick count"）。用它就把
// agent 自己的注入当成用户输入，判定退化成「永远让路」——闸门会一直等到上限，什么都做不了。
// 所以判定必须来自**能区分注入与真实**的信号：低级钩子（WH_MOUSE_LL / WH_KEYBOARD_LL），
// 读 MSLLHOOKSTRUCT.flags & LLMHF_INJECTED / KBDLLHOOKSTRUCT.flags & LLKHF_INJECTED。
// 再加一层保险：我们自己的注入带一个固定的 dwExtraInfo 魔数（InjectMagic），钩子里见到魔数
// 就当成我们自己的——有些注入路径（UIA 内部、跨进程 IPC、远程桌面）并不总是可靠地打
// INJECTED 标记，只认标记会把他们误当成人。
//
// 为什么是一条专用线程：低级钩子的回调**只在装钩子的那条线程泵消息时**被调用
// （SetWindowsHookEx 的文档：the hook is called … by sending a message to the thread that
// installed it）。桥主体是 while(true) 轮询命令，没有消息泵，所以在它身上装钩子等于装了个
// 永不触发的钩子。于是这里起一条后台线程：装钩子 → GetMessage 循环；钩子回调里只做一件事
// ——更新一个 volatile 时间戳（回调阻塞超过系统的 LowLevelHooksTimeout≈300ms 会让**用户的
// 输入**变迟钝，所以这里面绝不能有 I/O、加锁或任何可能等的事）。
//
// 判定与等待分离：DecideYield 是**纯函数**（输入 = 两个 tick + now + 常量，输出 = 让不让路、
// 还要等多久、要不要放弃），--selftest-yield 在宿主上用几十组人造 tick 钉住它；
// GateForPixelAction 只负责用真时钟把 DecideYield 跑成一个等待循环。宿主上不装任何钩子。
//
// 给下一个 PR（feat/sandbox-login-mask-audit）用的判定接口：
//   ClassifyMouseEvent / ClassifyKeyboardEvent  → EventReal / EventOurs / EventForeign
//   LastRealTick / LastInjectedTick / RealInputAgeMs  → 最近一次的真实与注入时刻
//   DecideYield 的 YieldVerdict.InjectedAfterRealInput → 「最后一次真实输入之后我们是否又注入过」
// 它们都是纯函数或只读快照，审计归属直接拿去用，不要再写第二份。
//
// 注意：csc.exe v4.0.30319 是 C# 5 编译器——禁字符串插值 / ?. / out var / using 声明 / 枚举 / 元组。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class InputHook
{
    // ── 阈值（单位毫秒；依据见每一段注释，改之前先把 --selftest-yield 的判定表读一遍）──

    /**
     * 「用户的手还在动」的判定窗。只在动作边界用一次：最近 400ms 内有真实输入才进让路流程，
     * 否则直接执行——agent 独占沙箱是最常见的路径，这条路径的代价必须是 0。
     *
     * 400ms 的依据：人连续打字的字符间隔中位 60–250ms（60wpm≈200ms/字符，120wpm≈100ms），
     * 400ms 相当于「上一键之后还能再敲 2–4 个字符」——超过了它，说明手已经离开键盘。
     */
    internal const int PresenceLookbackMs = 400;

    /**
     * 让路之后要求的**静默时长**：连续 900ms 没有真实输入才允许注入。
     *
     * 依据：人类打字的词内间隔 60–250ms、词间（空格/标点）150–350ms、句末或思考 300–800ms。
     * 取 900ms 落在「词间停顿」之上、「思考间隙」之下——不会切进同一串输入里，
     * 也不会因为用户只是看了一眼屏幕就白等好几秒。
     * 不变式：QuietMs > PresenceLookbackMs（进入让路流程之后，要求一定比进门条件更严，
     * 否则会出现「决定让路但一秒都不用等」这种自相矛盾的状态）。
     */
    internal const int QuietMs = 900;

    /**
     * 一次像素动作的等待上限。超过它还不静下来 = 用户真的在用这个桌面，交还给模型：
     * 回一句人话（稍后重试 / 换不占桌面的车道），而不是硬把事件打进去。
     *
     * 依据：宿主侧像素命令的放弃线是 45s（shared/computer-use.ts 的 GUEST_COMMAND_TIMEOUT_MS），
     * 而文件协议真机实测每一跳 2.9–7.5s、最坏两跳约 15s；4s 的等待 + 15s 的传播仍远在 45s 之内，
     * 模型看到的一定是这句人话，而不是笼统的「超时」。反面：长到 10s 以上就会挤掉这条预算，
     * 把「用户优先」变成「模型只看到超时」。
     */
    internal const int MaxWaitMs = 4000;

    /** 等静默时的睡眠分片：用户随时可能再敲一下，睡太长会让「停手」被发现得太晚 */
    internal const int WaitSliceMs = 50;

    // ── 魔数：我们自己注入的事件在 dwExtraInfo 里带的标记 ─────────────────────

    /**
     * 本进程注入事件的 dwExtraInfo 魔数（"ORB" + 0x01 版本位）。
     * 为什么要有它：INJECTED 标记不是每条注入路径都会打（UIA 内部注入、某些 IPC/远程路径
     * 会绕过 SendInput 的标记），只认 flags 会把这些误判成「人」。魔数是我们自己说了算的，
     * 优先级高于标志位：见到魔数就是我们的，不管 flags 怎么写。
     * 值要小到在 32 / 64 位下都能原样往返（ULONG_PTR）。
     */
    internal const long InjectMagic = 0x4F524201;

    /** 「从未观测到」的哨兵。Environment.TickCount 51 天回绕时刚好路过 0，那一瞬的样本会丢一次，无害 */
    internal const int NeverTick = 0;

    // ── 事件归属（给审计 PR 复用的判定结果；没有 enum：C# 5 约束 + 直接当 int 用）──

    /** 真实用户输入（没有人注入它） */
    internal const int EventReal = 0;
    /** 我们自己的注入（dwExtraInfo 带魔数） */
    internal const int EventOurs = 1;
    /** 别的程序注入的（带 INJECTED 但没有我们的魔数：UIA / 远程 / 其它自动化工具） */
    internal const int EventForeign = 2;

    // 低级钩子的标志位（winuser.h）
    private const uint LLMHF_INJECTED = 0x00000001;
    private const uint LLMHF_LOWER_IL_INJECTED = 0x00000002;
    private const uint LLKHF_INJECTED = 0x00000010;
    // 键盘也有它自己的 LOWER_IL_INJECTED（0x02），与鼠标同值但不同结构里的字段
    private const uint LLKHF_LOWER_IL_INJECTED = 0x00000002;

    // ── 共享状态：只读时间戳，不加锁 ─────────────────────────────────────────
    //
    // 钩子线程写、命令线程读。**故意不加锁**：在钩子回调里抢锁会把用户的输入拖慢，
    // 而 int 的读写在 .NET 的内存模型里是原子的，volatile 保证读得到最新值。
    // 代价是「可能看到一个稍旧的 tick」——让路判定对它不敏感（差一两次轮询不改变结论）。
    private static volatile int _lastRealTick = NeverTick;
    private static volatile int _lastInjectedTick = NeverTick;

    /** 测试模式（宿主上跑 bridge.test.mjs）：**绝不装全局输入钩子**——那会碰到用户的真实键盘 */
    internal static bool Disabled = false;

    // 分类计数（Interlocked：钩子回调里不许抢锁，这里也不需要锁）。
    // 它们不是给让路判定用的，而是给 input-status 用的——真机验收要回答
    // 「我在沙箱里打的字，到底被当成真实输入还是被当成注入」（RDP 转发进来的输入有可能带
    // INJECTED 标记，那就得把判定的语义改一下，而这需要一个能看得见的证据）。
    private static int _realEvents;
    private static int _oursEvents;
    private static int _foreignEvents;
    /** 最近一次真实 / 别人注入事件的原始 flags（十六进制给排查看：0x10 = LLKHF_INJECTED） */
    private static volatile int _lastRealFlags = -1;
    private static volatile int _lastForeignFlags = -1;

    private static volatile bool _installed;
    private static volatile bool _stopRequested;
    private static Thread _thread;
    private static uint _threadId;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static IntPtr _keyboardHook = IntPtr.Zero;
    private static readonly ManualResetEvent _installDone = new ManualResetEvent(false);

    // 委托必须用静态字段活着：被 GC 回收之后系统再回调就是野指针（经典低级钩子崩溃）
    private static HookProc _mouseProc;
    private static HookProc _keyboardProc;

    // ── Win32 ────────────────────────────────────────────────────────────────

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public int x;
        public int y;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint PM_NOREMOVE = 0x0000;
    private const uint WM_QUIT = 0x0012;

    // ── 判定（纯函数：--selftest-yield 逐条钉住）─────────────────────────────

    /** DecideYield 的输出。字段全公开：它是给 selftest 与下一个 PR 读的值对象，不是状态 */
    internal struct YieldVerdict
    {
        /** 还要让路（用户在场，且还没静够） */
        public bool Yield;
        /** 等到了上限：放弃这条动作，回一句人话（Yield 同时为 false） */
        public bool GiveUp;
        /** 这一轮还要等多久（1..quietMs；不让路时为 0） */
        public long WaitMs;
        /** 距最后一次真实输入的毫秒；从未观测到 = -1 */
        public long RealInputAgoMs;
        /** 最后一次真实输入之后，我们（或别的程序）是否又注入过——审计归属 PR 直接用 */
        public bool InjectedAfterRealInput;
    }

    /**
     * 32 位 tick 的差值（Environment.TickCount 是 int，49.7 天回绕一次）。
     * 用 uint 模运算算差值，回绕前后都成立：now 与 then 必须是同一个 tick 源的值。
     * 若 then 比 now 还「新」（时钟被拨回去 / 传了脏值），结果会是个巨大的数——
     * 含义退化成「很久以前」，判定上等价于「不让路」，这是安全的退化方向。
     */
    internal static long ElapsedMs(long now, long then)
    {
        unchecked
        {
            return (long)(uint)(now - then);
        }
    }

    /** 事件归属：魔数优先于 INJECTED 标志（理由见 InjectMagic） */
    internal static int ClassifyEvent(uint hookFlags, long extraInfo, uint injectedMask)
    {
        if (extraInfo == InjectMagic) return EventOurs;
        if ((hookFlags & injectedMask) != 0) return EventForeign;
        return EventReal;
    }

    internal static int ClassifyMouseEvent(uint flags, long extraInfo)
    {
        return ClassifyEvent(flags, extraInfo, LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED);
    }

    internal static int ClassifyKeyboardEvent(uint flags, long extraInfo)
    {
        return ClassifyEvent(flags, extraInfo, LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED);
    }

    /**
     * 该不该让路（**纯函数**：只看入参，不读时钟、不碰钩子）。
     *
     * 判定表（presence < quiet ≤ max 为前提）：
     *   lastReal 从未观测到            → 放行（沙箱里从没人动过）
     *   age >= presenceMs              → 放行（手已经离开：agent 独占的常规路径）
     *   age <  presenceMs 且 waited≥max → 放弃（用户一直在动，交还给模型）
     *   age <  presenceMs              → 让路，本轮还等 quietMs - age
     *
     * 注意 lastInjected **不参与**让不让路：agent 自己的注入从来不该被当成「人在使用」，
     * 那正是 GetLastInputInfo 的坑。它只用来回答「最后一次真实输入之后我们有没有动过手」。
     */
    internal static YieldVerdict DecideYield(
        long now,
        long lastReal,
        long lastInjected,
        long presenceMs,
        long quietMs,
        long maxWaitMs,
        long waitedMs)
    {
        YieldVerdict verdict = new YieldVerdict();
        verdict.RealInputAgoMs = -1;
        if (quietMs <= presenceMs) quietMs = presenceMs + 1; // 不变式兜底（selftest 也钉住它）

        if (lastReal == NeverTick) return verdict; // 从没观测到真实输入

        long age = ElapsedMs(now, lastReal);
        verdict.RealInputAgoMs = age;
        verdict.InjectedAfterRealInput = lastInjected != NeverTick && ElapsedMs(now, lastInjected) < age;

        if (age >= presenceMs) return verdict;      // 手已经离开

        if (waitedMs >= maxWaitMs)
        {
            verdict.GiveUp = true;                   // 等到上限了，不硬打进去
            return verdict;
        }

        long wait = quietMs - age;
        if (wait < 1) wait = 1;
        verdict.Yield = true;
        verdict.WaitMs = wait;
        return verdict;
    }

    // ── 真时钟与状态快照 ─────────────────────────────────────────────────────

    /** 单调毫秒 tick（Environment.TickCount 的原始 32 位域，回绕由 ElapsedMs 处理） */
    internal static long NowTick()
    {
        return (long)Environment.TickCount;
    }

    internal static int LastRealTick
    {
        get { return _lastRealTick; }
    }

    internal static int LastInjectedTick
    {
        get { return _lastInjectedTick; }
    }

    /** 距最后一次真实输入的毫秒；从未观测到 = -1。审计归属 PR 的「这一下离人动手多久」用它 */
    internal static long RealInputAgeMs()
    {
        int last = _lastRealTick;
        if (last == NeverTick) return -1;
        return ElapsedMs(NowTick(), last);
    }

    /** 钩子是否真的装上了（装不上 = 让路闸门停用，像素命令行为与改前一致） */
    internal static bool Installed
    {
        get { return _installed; }
    }

    /**
     * 只读诊断（`input-status`，生产也有）：让路闸门现在看到了什么。
     *
     * 为什么它不是测试专用：真机验收必须能回答一个问题——**用户在沙箱窗口里真实敲的字，
     * 到底被归成真实输入还是注入**。Windows Sandbox 的输入是从宿主经 RDP 转发进 guest 的，
     * 那条链上的事件完全可能带着 LLKHF_INJECTED。真出现那种情况，这里就会看到
     * realEvents 一直是 0、foreignEvents 随敲字上涨、lastForeignFlags="0x10"——
     * 那就得把判定改成「非本进程注入即人」，而不是对着一个永远不让路的闸门猜。
     * 它不注入、不等待、不改任何状态，模型侧永远不调它。
     *
     * **实测（2026-10-28，Windows 11 26200 / WSB，验证脚本 p1-rdp-injected-probe.mjs）**：
     * 从宿主向沙箱窗口连发 10 个 'a'（走 RDP 转发，与真人敲键同一条链）后，
     * `realEvents` 涨 38–61、`foreignEvents` 始终为 0，`lastRealFlags` = "0x80"（LLKHF_ALPHANUMERIC）。
     * 即 **RDP 转发不带 INJECTED 标志**，「非注入 = 人」的判定成立，不需要翻转。
     * 这条结论就是在本次实测里被钉住的，不是推断。
     */
    internal static string StatusJson()
    {
        return "{\"ok\":true," + StatusFields() + "}";
    }

    /** input-status 的字段部分（验收缝把 mode 之类拼在它前面，免得多打一层括号） */
    internal static string StatusFields()
    {
        StringBuilder json = new StringBuilder();
        long realAge = RealInputAgeMs();
        int lastInjected = _lastInjectedTick;
        long injectedAge = lastInjected == NeverTick ? -1 : ElapsedMs(NowTick(), lastInjected);
        json.Append("\"installed\":").Append(_installed ? "true" : "false");
        json.Append(",\"lastRealAgeMs\":").Append(realAge);
        json.Append(",\"lastInjectedAgeMs\":").Append(injectedAge);
        json.Append(",\"realEvents\":").Append(_realEvents);
        json.Append(",\"oursEvents\":").Append(_oursEvents);
        json.Append(",\"foreignEvents\":").Append(_foreignEvents);
        json.Append(",\"lastRealFlags\":").Append(_lastRealFlags < 0 ? "null" : "\"0x" + _lastRealFlags.ToString("x") + "\"");
        json.Append(",\"lastForeignFlags\":").Append(_lastForeignFlags < 0 ? "null" : "\"0x" + _lastForeignFlags.ToString("x") + "\"");
        json.Append(",\"presenceMs\":").Append(PresenceLookbackMs);
        json.Append(",\"quietMs\":").Append(QuietMs);
        json.Append(",\"maxWaitMs\":").Append(MaxWaitMs);
        json.Append(",\"simulatedTyping\":").Append(_simulatedTyping ? "true" : "false");
        return json.ToString();
    }

    // ── 验收缝（`yield-probe`，**只有 --test-hooks 的桥认它**，生产永远到不了这一行）──
    //
    // 为什么需要一条伪造「人在输入」的缝：脚本里没有任何办法产生一个**不带 INJECTED 标记**的
    // 输入事件——SendInput / mouse_event / keybd_event 发出的事件都由系统自己打上这个标记。
    // 所以「人在打字」这一半在宿主上无法自动化：它要么靠这个缝直接推时间戳（不注入任何事件），
    // 要么在真机里由人去敲（验收脚本的 --manual 模式，配合 input-status 的计数）。

    private static volatile bool _simulatedTyping;

    /** 伪造「刚刚发生了一次真实输入」：把时间戳改成 ageMs 之前 */
    internal static void ProbeTouch(int ageMs)
    {
        if (ageMs < 0) ageMs = 0;
        _lastRealTick = unchecked(Environment.TickCount - ageMs);
    }

    /** 清掉两个时间戳（回到「谁都没动过」的干净状态） */
    internal static void ProbeClear()
    {
        _simulatedTyping = false;
        _lastRealTick = NeverTick;
        _lastInjectedTick = NeverTick;
    }

    /**
     * 伪造「有人在连续打字」：每 intervalMs 打一次「真实输入」，持续 durationMs。
     * 用来验等待上限那条路——只在 durationMs 内不停地动，才会走到 4s 后放弃。
     */
    internal static void ProbeTyping(int durationMs, int intervalMs)
    {
        if (durationMs < 1) durationMs = 1;
        if (intervalMs < 1) intervalMs = 1;
        if (_simulatedTyping) return; // 一次只跑一条，免得两股假输入互相掩盖
        _simulatedTyping = true;
        Thread thread = new Thread(delegate()
        {
            try
            {
                long start = NowTick();
                while (ElapsedMs(NowTick(), start) < durationMs && _simulatedTyping)
                {
                    _lastRealTick = Environment.TickCount;
                    Thread.Sleep(intervalMs);
                }
            }
            finally
            {
                _simulatedTyping = false;
            }
        });
        thread.IsBackground = true;
        thread.Name = "orbita-yield-probe";
        thread.Start();
    }

    /** 伪造打字是否还在跑（验收脚本从 input-status 的 simulatedTyping 读；这段注释跟着它走） */
    internal static bool SimulatedTyping
    {
        get { return _simulatedTyping; }
    }

    /**
     * 本进程送出一批注入事件之前的记账。SendInput 是在**同一次调用内**同步经过钩子的，
     * 所以先记时刻再送：万一某条路径没被钩子看见，这一笔也已经落下了。
     */
    internal static void NoteInjected()
    {
        _lastInjectedTick = Environment.TickCount;
    }

    // ── 钩子线程：装、泵、收 ─────────────────────────────────────────────────

    /**
     * 装钩子并起消息泵线程。返回是否装成功。
     * 失败只是「没有让路」：像素命令照常执行（与改前逐字一致），绝不能让桥因为钩子不可用而不可用。
     */
    internal static bool Start()
    {
        if (Disabled)
        {
            Program.Log("输入钩子：测试模式（--no-input-hook / --no-firewall），不装——让路闸门停用");
            return false;
        }
        if (_thread != null) return _installed;

        _mouseProc = new HookProc(MouseProc);
        _keyboardProc = new HookProc(KeyboardProc);
        _thread = new Thread(Pump);
        _thread.IsBackground = true; // 桥被 taskkill 时不用等它
        _thread.Name = "orbita-input-hook";
        _thread.Start();

        if (!_installDone.WaitOne(2000))
        {
            Program.Log("输入钩子：2s 内没装好，让路闸门停用（像素命令行为与改前一致）");
            return false;
        }
        return _installed;
    }

    /** 收线程：PostThreadMessage(WM_QUIT) 让 GetMessage 返回 0，随后 finally 里解钩子 */
    internal static void Stop()
    {
        Thread thread = _thread;
        if (thread == null) return;
        _stopRequested = true;
        if (_threadId != 0) PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        if (!thread.Join(1500)) Program.Log("输入钩子线程 1.5s 内没退出（进程结束后钩子随进程消失，不再等）");
        _thread = null;
        _threadId = 0;
    }

    /**
     * 钩子线程本体。顺序有讲究：
     *   ① 先 PeekMessage 一次，**强制建立本线程的消息队列**——PostThreadMessage 对没有队列的
     *      线程会失败，WM_QUIT 丢掉就等于退出时白等 1.5s；
     *   ② 再装两个钩子（低级钩子可以进程内装，hMod 传本模块句柄是通行做法；线程 0 = 全局，
     *      即这个桌面上的所有输入）；
     *   ③ 再进 GetMessage 循环。**必须阻塞在 GetMessage 里**：低级钩子的回调是系统把消息投给
     *      这条线程来触发的，线程睡在别处（比如自己 sleep 轮询）会让回调最多迟到一整个周期，
     *      而系统的 LowLevelHooksTimeout≈300ms 一到就把钩子摘掉——等于用户的输入变卡。
     */
    private static void Pump()
    {
        try
        {
            _threadId = GetCurrentThreadId();
            MSG warmup;
            PeekMessage(out warmup, IntPtr.Zero, 0, 0, PM_NOREMOVE);

            IntPtr module = GetModuleHandle(null);
            _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, module, 0);
            int mouseError = Marshal.GetLastWin32Error();
            _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, module, 0);
            int keyboardError = Marshal.GetLastWin32Error();

            bool ok = _mouseHook != IntPtr.Zero && _keyboardHook != IntPtr.Zero;
            _installed = ok;
            if (!ok)
            {
                Program.Log("输入钩子装不上：mouse=" + mouseError + " keyboard=" + keyboardError
                    + "（让路闸门停用，像素命令行为与改前一致）");
                return; // finally 里把装上的那一个解掉
            }
            Program.Log("输入钩子已装上（WH_MOUSE_LL / WH_KEYBOARD_LL）：让路窗 " + PresenceLookbackMs
                + "ms，静默 " + QuietMs + "ms，上限 " + MaxWaitMs + "ms");
            _installDone.Set();

            MSG msg;
            while (!_stopRequested && GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch (Exception ex)
        {
            Program.Log("输入钩子线程异常：" + ex.Message);
        }
        finally
        {
            _installed = false;
            if (_mouseHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_mouseHook);
                _mouseHook = IntPtr.Zero;
            }
            if (_keyboardHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_keyboardHook);
                _keyboardHook = IntPtr.Zero;
            }
            _installDone.Set(); // 启动等待 / 装失败两条路都要放行
        }
    }

    // ── 钩子回调：只更新两个时间戳 ───────────────────────────────────────────
    //
    // 这里不允许出现 I/O、日志、锁、Sleep。系统的 LowLevelHooksTimeout（默认 300ms）一到就把
    // 钩子摘掉，而受害者是**用户自己的输入**——它会变迟钝。所以两件事：判归属、写 tick、放行。

    private static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            NoteEvent(ClassifyMouseEvent(data.flags, data.dwExtraInfo.ToInt64()), data.flags, Environment.TickCount);
        }
        // 永远继续传下去：低级钩子一旦吞掉事件，用户的鼠标键盘就少了一下
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            NoteEvent(ClassifyKeyboardEvent(data.flags, data.dwExtraInfo.ToInt64()), data.flags, Environment.TickCount);
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    /** 回调里除了两个 tick 之外唯一的事：分类计数（都是无锁写） */
    private static void NoteEvent(int kind, uint flags, int now)
    {
        if (kind == EventReal)
        {
            _lastRealFlags = (int)flags;
            _lastRealTick = now;
            Interlocked.Increment(ref _realEvents);
            return;
        }
        if (kind == EventOurs)
        {
            _lastInjectedTick = now;
            Interlocked.Increment(ref _oursEvents);
            return;
        }
        _lastForeignFlags = (int)flags;
        _lastInjectedTick = now;
        Interlocked.Increment(ref _foreignEvents);
    }

    // ── 让路闸门（真时钟版：把 DecideYield 跑成一个等待循环）─────────────────

    /** 闸门的结论：能不能执行、等了多久、回执要追加什么 */
    internal struct GateResult
    {
        /** false = 放弃：一个输入事件都没送，GiveUpJson 是给模型的人话回执 */
        public bool Allowed;
        /** 实际推迟了多少毫秒（0 = 没让路） */
        public long WaitedMs;
        /** 成功回执里要追加的字段（没让路时是空串，回执形状与改前逐字一致） */
        public string ReplySuffix;
        /** 放弃时的完整回执 JSON */
        public string GiveUpJson;
    }

    /**
     * 像素动作（click / type / key / scroll）**开始之前**问一次「用户是不是正在用这个桌面」。
     *
     * 语义边界：只推迟**下一个动作的边界**，不打断已经送出去的事件——一条命令的注入是原子的，
     * 让路发生在它开送之前。等待期间用户可能又敲了一下，所以每一轮都重新判定（不是睡死一次）。
     */
    internal static GateResult GateForPixelAction(string command)
    {
        GateResult result = new GateResult();
        result.Allowed = true;
        result.WaitedMs = 0;
        result.ReplySuffix = "";
        result.GiveUpJson = null;

        if (!_installed) return result; // 钩子没装上：不让路（与改前同一行为）

        long start = NowTick();
        while (true)
        {
            long now = NowTick();
            long waited = ElapsedMs(now, start);
            YieldVerdict verdict = DecideYield(
                now, _lastRealTick, _lastInjectedTick,
                PresenceLookbackMs, QuietMs, MaxWaitMs, waited);

            if (verdict.GiveUp)
            {
                result.Allowed = false;
                result.WaitedMs = waited;
                result.GiveUpJson = "{\"ok\":false,\"error\":"
                    + Program.JsonQuote(GiveUpMessage(command, waited))
                    + ",\"yielded\":true,\"waitedMs\":" + waited + "}";
                Program.Log("让路放弃：" + command + " 等了 " + waited + "ms 用户还在输入（最近一次真实输入 "
                    + verdict.RealInputAgoMs + "ms 前），一个事件都没送");
                return result;
            }

            if (!verdict.Yield)
            {
                if (waited > 0)
                {
                    result.WaitedMs = waited;
                    result.ReplySuffix = ",\"yielded\":true,\"waitedMs\":" + waited;
                    Program.Log("让路：" + command + " 推迟 " + waited + "ms 后执行（最近一次真实输入 "
                        + verdict.RealInputAgoMs + "ms 前）");
                }
                return result;
            }

            long slice = verdict.WaitMs < WaitSliceMs ? verdict.WaitMs : WaitSliceMs;
            Thread.Sleep((int)slice); // 分片睡：用户随时可能再敲一下，睡死会把「停手」发现得太晚
        }
    }

    /**
     * 放弃时给模型的人话。三件事必须都在：谁在用（人）、动作没发生（别以为点过了）、下一步（换车道 / 稍后重试）。
     */
    internal static string GiveUpMessage(string command, long waitedMs)
    {
        return "用户正在使用沙箱桌面，" + command + " 已暂缓 " + waitedMs + "ms 仍未等到停手，"
            + "已放弃（一个输入事件都没送）。用户的操作优先于 agent 的注入。"
            + "请稍后重试这一次，或改用不占桌面的车道：sandbox_* 浏览器命令、computer_uia 按控件动作、"
            + "带 window 的按窗口截图。";
    }

    // ── 自测（--selftest-yield：纯函数，不装钩子、不碰桌面、不启进程）──────────

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;
        const long P = PresenceLookbackMs;
        const long Q = QuietMs;
        const long M = MaxWaitMs;
        const long now = 1000000; // 一个普通的中段时刻

        // ① 常量本身：手滑改掉阈值时必须有人看见（依据写在常量注释里）
        CheckNumber(failures, ref cases, "让路窗 400ms", "400", PresenceLookbackMs.ToString());
        CheckNumber(failures, ref cases, "静默窗 900ms", "900", QuietMs.ToString());
        CheckNumber(failures, ref cases, "等待上限 4000ms", "4000", MaxWaitMs.ToString());
        CheckTrue(failures, ref cases, "不变式：静默窗 > 让路窗（进门后要求更严）", Q > P);
        CheckTrue(failures, ref cases, "不变式：等待上限 > 静默窗", M > Q);
        CheckTrue(failures, ref cases, "分片 ≤ 静默窗（否则「停手」发现得太晚）", WaitSliceMs <= Q);

        // ② 用户刚打完字：让路，还要等够静默窗
        YieldVerdict v = DecideYield(now, now - 50, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "50ms 前刚输入 → 让路", v.Yield && !v.GiveUp);
        CheckNumber(failures, ref cases, "50ms 前刚输入 → 再等 850ms", "850", v.WaitMs.ToString());
        CheckNumber(failures, ref cases, "50ms 前刚输入 → 报告 age=50", "50", v.RealInputAgoMs.ToString());

        v = DecideYield(now, now - (P - 1), NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "399ms（让路窗内最后一毫秒）→ 还让路", v.Yield);
        CheckNumber(failures, ref cases, "399ms → 再等 501ms", "501", v.WaitMs.ToString());

        // ③ 边界：刚好到让路窗 / 刚好到静默窗 / 停了很久
        v = DecideYield(now, now - P, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "刚好 400ms（等于让路窗）→ 放行", !v.Yield && !v.GiveUp);
        CheckNumber(failures, ref cases, "放行时 WaitMs=0", "0", v.WaitMs.ToString());
        CheckNumber(failures, ref cases, "放行时 age 照实报告", "400", v.RealInputAgoMs.ToString());
        v = DecideYield(now, now - Q, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "刚好 900ms（静默窗）→ 放行", !v.Yield);
        v = DecideYield(now, now - 60000, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "停了 60s → 放行", !v.Yield && !v.GiveUp);

        // ④ 只有我们自己的注入：绝不让路（GetLastInputInfo 的坑就在这儿）
        v = DecideYield(now, NeverTick, now - 10, P, Q, M, 0);
        CheckTrue(failures, ref cases, "只有注入、用户从未输入 → 放行", !v.Yield && !v.GiveUp);
        CheckNumber(failures, ref cases, "从未观测到真实输入 → age=-1", "-1", v.RealInputAgoMs.ToString());

        // ⑤ 注入与真实交错：让不让路只看真实输入；注入只影响审计字段
        v = DecideYield(now, now - 200, now - 50, P, Q, M, 0);
        CheckTrue(failures, ref cases, "真实后我们注入过 → 仍让路（注入不算人在用）", v.Yield);
        CheckTrue(failures, ref cases, "真实后注入过 → InjectedAfterRealInput=true", v.InjectedAfterRealInput);
        v = DecideYield(now, now - 50, now - 200, P, Q, M, 0);
        CheckTrue(failures, ref cases, "注入在真实之前 → InjectedAfterRealInput=false", v.Yield && !v.InjectedAfterRealInput);
        v = DecideYield(now, now - 200, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "从未注入过 → InjectedAfterRealInput=false", !v.InjectedAfterRealInput);

        // ⑥ 等待上限：到点放弃，不许硬打进去
        v = DecideYield(now, now - 50, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "刚开始等 → 不放弃", !v.GiveUp);
        v = DecideYield(now, now - 50, NeverTick, P, Q, M, M - 1);
        CheckTrue(failures, ref cases, "等了 3999ms → 还等一轮", v.Yield && !v.GiveUp);
        v = DecideYield(now, now - 50, NeverTick, P, Q, M, M);
        CheckTrue(failures, ref cases, "等满 4000ms → 放弃", v.GiveUp && !v.Yield);
        v = DecideYield(now, now - 50, NeverTick, P, Q, M, M + 5000);
        CheckTrue(failures, ref cases, "超过上限（时钟抖动）→ 仍放弃", v.GiveUp);
        CheckNumber(failures, ref cases, "放弃时不再给等待时长", "0", v.WaitMs.ToString());
        v = DecideYield(now, now - (P - 1), NeverTick, P, Q, M, 9);
        CheckNumber(failures, ref cases, "第 9ms 还在让路 → 本轮只补 501ms", "501", v.WaitMs.ToString());

        // ⑦ tick 回绕（Environment.TickCount 49.7 天一圈）与 0 值
        long afterWrap = (long)int.MinValue + 100;   // 回绕之后 100ms
        long beforeWrap = (long)int.MaxValue - 50;   // 回绕之前 50ms
        CheckNumber(failures, ref cases, "回绕差值：跨 int 边界算成 151ms", "151",
            ElapsedMs(afterWrap, beforeWrap).ToString());
        v = DecideYield(afterWrap, beforeWrap, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "回绕后 151ms → 让路", v.Yield);
        CheckNumber(failures, ref cases, "回绕后 → 再等 749ms", "749", v.WaitMs.ToString());
        v = DecideYield((long)int.MinValue + 500, beforeWrap, NeverTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "回绕后 551ms（> 让路窗）→ 放行", !v.Yield);
        CheckNumber(failures, ref cases, "回绕后 age 报告 551", "551",
            DecideYield((long)int.MinValue + 500, beforeWrap, NeverTick, P, Q, M, 0).RealInputAgoMs.ToString());
        v = DecideYield(0, 0, 0, P, Q, M, 0);
        CheckTrue(failures, ref cases, "tick 恰为 0（= 从未观测到）→ 放行", !v.Yield && !v.GiveUp);
        CheckNumber(failures, ref cases, "tick 为 0 时 age=-1", "-1", v.RealInputAgoMs.ToString());

        // ⑧ 归属判定（审计 PR 的接口）：魔数 > INJECTED > 真实
        CheckNumber(failures, ref cases, "无标志无魔数 → 真实输入", EventReal.ToString(),
            ClassifyMouseEvent(0, 0).ToString());
        CheckNumber(failures, ref cases, "LLMHF_INJECTED → 别家注入", EventForeign.ToString(),
            ClassifyMouseEvent(LLMHF_INJECTED, 0).ToString());
        CheckNumber(failures, ref cases, "LLMHF_LOWER_IL_INJECTED → 别家注入", EventForeign.ToString(),
            ClassifyMouseEvent(LLMHF_LOWER_IL_INJECTED, 0).ToString());
        CheckNumber(failures, ref cases, "带魔数（即使没有 INJECTED）→ 我们自己的", EventOurs.ToString(),
            ClassifyMouseEvent(0, InjectMagic).ToString());
        CheckNumber(failures, ref cases, "带魔数又有 INJECTED → 仍是我们自己的（魔数优先）", EventOurs.ToString(),
            ClassifyMouseEvent(LLMHF_INJECTED, InjectMagic).ToString());
        CheckNumber(failures, ref cases, "键盘 LLKHF_INJECTED → 别家注入", EventForeign.ToString(),
            ClassifyKeyboardEvent(LLKHF_INJECTED, 0).ToString());
        CheckNumber(failures, ref cases, "键盘真实按键（flags=0）→ 真实输入", EventReal.ToString(),
            ClassifyKeyboardEvent(0, 0).ToString());
        CheckNumber(failures, ref cases, "键盘带魔数 → 我们自己的", EventOurs.ToString(),
            ClassifyKeyboardEvent(LLKHF_INJECTED, InjectMagic).ToString());
        CheckTrue(failures, ref cases, "鼠标别的标志位（0x10）不影响归属", ClassifyMouseEvent(0x10, 0) == EventReal);
        CheckTrue(failures, ref cases, "键盘其它标志位（LLKHF_ALTDOWN 0x20）仍是真实输入",
            ClassifyKeyboardEvent(0x20, 0) == EventReal);
        CheckTrue(failures, ref cases, "魔数本身就是我们的注入值（不是 0）", InjectMagic != 0);

        // ⑨ 放弃文案：谁在用、没发生、下一步，三件都在
        string giveUp = GiveUpMessage("click", 4000);
        CheckTrue(failures, ref cases, "放弃文案点名「用户正在使用沙箱桌面」",
            giveUp.IndexOf("用户正在使用沙箱桌面", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "放弃文案说清等了多久", giveUp.IndexOf("4000ms", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "放弃文案说清一个事件都没送",
            giveUp.IndexOf("一个输入事件都没送", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "放弃文案给出不占桌面的车道",
            giveUp.IndexOf("sandbox_", StringComparison.Ordinal) >= 0
            && giveUp.IndexOf("computer_uia", StringComparison.Ordinal) >= 0);

        // ⑩ 诊断回执（input-status）：形状能被 JSON.parse，没人动过时 age = -1
        string status = StatusJson();
        CheckTrue(failures, ref cases, "input-status 带上三个阈值（排查时一眼看到用的是哪档）",
            status.IndexOf("\"presenceMs\":400", StringComparison.Ordinal) >= 0
            && status.IndexOf("\"quietMs\":900", StringComparison.Ordinal) >= 0
            && status.IndexOf("\"maxWaitMs\":4000", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "input-status 带 installed 与三类计数",
            status.IndexOf("\"installed\":", StringComparison.Ordinal) >= 0
            && status.IndexOf("\"realEvents\":", StringComparison.Ordinal) >= 0
            && status.IndexOf("\"oursEvents\":", StringComparison.Ordinal) >= 0
            && status.IndexOf("\"foreignEvents\":", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "input-status 从未观测到输入时 age = -1",
            status.IndexOf("\"lastRealAgeMs\":-1", StringComparison.Ordinal) >= 0);

        // ⑪ 验收缝（yield-probe）：推时间戳之后，闸门真的会看到「人刚动过」
        ProbeClear();
        ProbeTouch(120);
        long touchedAge = RealInputAgeMs();
        CheckTrue(failures, ref cases, "ProbeTouch(120) → 报告约 120ms",
            touchedAge >= 100 && touchedAge <= 400);
        YieldVerdict afterTouch = DecideYield(NowTick(), _lastRealTick, _lastInjectedTick, P, Q, M, 0);
        CheckTrue(failures, ref cases, "ProbeTouch 之后闸门会让人等（不是白推一个时间戳）",
            afterTouch.Yield && afterTouch.WaitMs >= Q - 400);
        ProbeTouch(5000);
        CheckTrue(failures, ref cases, "ProbeTouch(5000) → 超过让路窗，闸门放行",
            !DecideYield(NowTick(), _lastRealTick, _lastInjectedTick, P, Q, M, 0).Yield);
        ProbeClear();
        CheckTrue(failures, ref cases, "ProbeClear 回到从未观测到（age=-1）", RealInputAgeMs() == -1);

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
