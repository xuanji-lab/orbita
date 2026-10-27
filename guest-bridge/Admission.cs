// Orbita guest bridge —— 应用级准入（0.11.0）
//
// 为什么必须在 guest 里判：Windows Sandbox 是**一台完整 VM**，guest 里的进程在宿主任务
// 管理器里看不到，PID 也不跨这道边界映射。所以「这一下点的是不是我们自己起的窗口」只有
// 桥能回答——它启动了 worker，worker 又启动了 Edge，父链就留在 guest 的进程表里。
//
// 判定链：
//   目标 hwnd → GetWindowThreadProcessId → guest 内 PID
//   → Toolhelp 快照里沿父链走到「我们注册过的根」（桥自己 + 每个 worker / launch 的 pid）
//     → owned；
//   → 否则看 exe 是否在白名单（内置 msedge.exe ∪ 宿主随请求下发的 allowExe）→ allowlisted；
//   → 都不在 → bypassed。
//
// **bypassed 不拒绝**（本轮是观察模式，2026-10 用户裁决）：VM 是一次性的，沙箱里任意应用
// 都算安全是合理的产品假设；先把模型实际会点哪些 exe 量清楚，再决定要不要拒。标记写进
// 回执（`{"admission":"bypassed","targetExe":"notepad.exe"}`）与 bridge.log，宿主再把它抬进
// 工具回执。**默认不拒绝**是刻意的：这一轮只做「可见 + 可配」。
//
// 纯函数部分（父链判定、白名单匹配、JSON 片段）用 `--selftest-admission` 在宿主上跑，
// 不需要起沙箱、不碰任何真实窗口。
//
// 编译约束：csc v4.0.30319 = C# 5。禁字符串插值 / ?. / out var / using 声明。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

internal static class Admission
{
    // ---- 判定结果的字面值：与宿主 shared/computer-use.ts 的 COMPUTER_USE_ADMISSION_VERDICTS 逐字一致 ----
    internal const string VerdictOwned = "owned";
    internal const string VerdictAllowlisted = "allowlisted";
    internal const string VerdictBypassed = "bypassed";
    internal const string VerdictUnknown = "unknown";

    /**
     * 内置白名单：只认沙箱里的 Edge。
     *
     * 为什么 Edge 要显式放行：树判定靠父链，而 Edge 的 launcher / 网络进程有机会被重新
     * 拉起或换父，父链一断就落到 bypassed——它不是「宿主的东西逸出」，是自家浏览器。
     * 宿主侧的同一条默认值在 shared/computer-use.ts 的 COMPUTER_USE_DEFAULT_ALLOWED_APPS。
     */
    internal static readonly string[] DefaultAllowExe = new string[] { "msedge.exe" };

    /** 父链最多走这么多层（防止一个坏掉的进程表把一次点击拖成死循环） */
    private const int MaxChainDepth = 64;

    /** 进程表的一行（Toolhelp 快照的最小投影，纯数据，自测里直接造） */
    internal sealed class ProcRow
    {
        public int Pid;
        public int ParentPid;
        public string ExeName;

        public ProcRow(int pid, int parentPid, string exeName)
        {
            Pid = pid;
            ParentPid = parentPid;
            ExeName = exeName == null ? "" : exeName;
        }
    }

    /** 一次判定的结果（回执里那三个字段 + 目标 hwnd） */
    internal sealed class Decision
    {
        public string Admission;
        public string TargetExe;
        public int TargetPid;
        public long TargetHwnd;

        public Decision(string admission, string targetExe, int targetPid, long targetHwnd)
        {
            Admission = admission;
            TargetExe = targetExe == null ? "" : targetExe;
            TargetPid = targetPid;
            TargetHwnd = targetHwnd;
        }
    }

    // ---- 我们自己启动的进程（树根）-------------------------------------------

    private static readonly List<int> _roots = new List<int>();
    private static readonly object _rootsGate = new object();

    /**
     * 记下「这是我们自己起的进程」。桥自己、每个 worker、launch 起的 exe 都要登记——
     * 只要目标进程沿父链能走到其中任何一个，就判 owned。
     *
     * 为什么既登记 pid 又走父链：登记的根是「确定的起点」，父链是「起点之后长出来的子树」
     * （worker → Edge → Edge 的子进程），缺一样都会漏。重复登记幂等。
     */
    internal static void RegisterRoot(int pid)
    {
        if (pid <= 0) return;
        lock (_rootsGate)
        {
            if (!_roots.Contains(pid)) _roots.Add(pid);
        }
    }

    /** 当前登记过的树根（快照一份，调用方不用持锁） */
    internal static List<int> Roots()
    {
        lock (_rootsGate)
        {
            return new List<int>(_roots);
        }
    }

    // ---- 进程表快照 --------------------------------------------------------

    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    /** guest 进程表快照（一次 Toolhelp 枚举，毫秒级；失败回空表 → 判定落到 unknown） */
    internal static List<ProcRow> Snapshot()
    {
        List<ProcRow> rows = new List<ProcRow>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == InvalidHandleValue) return rows;
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (!Process32FirstW(snap, ref entry)) return rows;
            do
            {
                rows.Add(new ProcRow((int)entry.th32ProcessID, (int)entry.th32ParentProcessID,
                    entry.szExeFile));
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            } while (Process32NextW(snap, ref entry));
        }
        finally
        {
            CloseHandle(snap);
        }
        return rows;
    }

    // ---- 纯判定 ------------------------------------------------------------

    /** 这个 pid 的 exe 名（快照里没有回空串） */
    internal static string ExeOf(int pid, IList<ProcRow> rows)
    {
        for (int i = 0; i < rows.Count; i++)
        {
            if (rows[i].Pid == pid) return rows[i].ExeName;
        }
        return "";
    }

    /**
     * pid 是否在我们自己起的进程树里：沿父链往上走，遇到任何一个登记的根就算命中。
     * 父链断了（父进程已退出、快照里查不到）或成环就停——环用 visited 集合挡，
     * 深度另有 MaxChainDepth 上限，两层都是为了「一次点击绝不能挂住」。
     */
    internal static bool IsInTree(int targetPid, IList<ProcRow> rows, IList<int> roots)
    {
        if (targetPid <= 0) return false;
        HashSet<int> visited = new HashSet<int>();
        int current = targetPid;
        for (int depth = 0; depth < MaxChainDepth; depth++)
        {
            if (current <= 0) return false;
            for (int i = 0; i < roots.Count; i++)
            {
                if (roots[i] == current) return true;
            }
            if (!visited.Add(current)) return false;
            int parent = 0;
            bool found = false;
            for (int i = 0; i < rows.Count; i++)
            {
                if (rows[i].Pid == current)
                {
                    parent = rows[i].ParentPid;
                    found = true;
                    break;
                }
            }
            if (!found) return false;
            current = parent;
        }
        return false;
    }

    /** exe 是否在白名单里（不区分大小写；白名单项可以带路径，按末段比） */
    internal static bool Allowlisted(string exeName, IList<string> allowExe)
    {
        string name = NormalizeExe(exeName);
        if (name.Length == 0) return false;
        for (int i = 0; i < allowExe.Count; i++)
        {
            if (NormalizeExe(allowExe[i]) == name) return true;
        }
        return false;
    }

    /**
     * 宿主下发的 `allowExe` 字段（逗号分隔的 exe 名 / 路径）→ 规范化列表。
     * 内置默认**总是**并进来（宿主可以只发用户加的那些，也可以发合并后的整张表）。
     */
    internal static List<string> MergeAllowExe(string csv)
    {
        List<string> outList = new List<string>();
        for (int i = 0; i < DefaultAllowExe.Length; i++) AddIfNew(outList, DefaultAllowExe[i]);
        if (csv != null)
        {
            string[] parts = csv.Split(',');
            for (int i = 0; i < parts.Length; i++) AddIfNew(outList, parts[i]);
        }
        return outList;
    }

    private static void AddIfNew(List<string> list, string raw)
    {
        string name = NormalizeExe(raw);
        if (name.Length == 0) return;
        if (!list.Contains(name)) list.Add(name);
    }

    /**
     * exe 名规范化：去空白、取路径末段（反斜杠与正斜杠都认）、小写、只认 `*.exe`。
     * 坏值回空串（调用方当作「不在白名单里」，不写进列表）。
     */
    internal static string NormalizeExe(string raw)
    {
        if (raw == null) return "";
        string value = raw.Trim();
        if (value.Length == 0) return "";
        int cut = value.LastIndexOf('\\');
        int cut2 = value.LastIndexOf('/');
        if (cut2 > cut) cut = cut2;
        if (cut >= 0 && cut + 1 < value.Length) value = value.Substring(cut + 1);
        value = value.Trim().ToLowerInvariant();
        if (value.Length <= 4) return "";
        if (!value.EndsWith(".exe", StringComparison.Ordinal)) return "";
        return value;
    }

    /**
     * 判定一个 guest 内 pid（**纯函数**：快照与根都是入参，自测直接造假表）。
     * 优先级：owned > allowlisted > bypassed；pid 或 exe 查不到 = unknown。
     */
    internal static Decision Judge(int targetPid, IList<ProcRow> rows, IList<int> roots, IList<string> allowExe)
    {
        if (targetPid <= 0) return new Decision(VerdictUnknown, "", 0, 0);
        string exe = ExeOf(targetPid, rows);
        if (exe.Length == 0) return new Decision(VerdictUnknown, "", targetPid, 0);
        if (IsInTree(targetPid, rows, roots)) return new Decision(VerdictOwned, exe, targetPid, 0);
        if (Allowlisted(exe, allowExe)) return new Decision(VerdictAllowlisted, exe, targetPid, 0);
        return new Decision(VerdictBypassed, exe, targetPid, 0);
    }

    // ---- 窗口 / 坐标 → pid（真机路径；自测只绕过它直接测 Judge）------------------

    private const uint GA_ROOT = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    /**
     * hwnd → 顶层窗口 → guest 内 PID。先用 GetAncestor(GA_ROOT) 归一：
     * 点到的是子窗口（按钮 / 输入框）也没关系，它们属于同一个进程。
     * 返回 0 表示解析不出来（窗口已关 / 假 hwnd）。
     */
    internal static int ProcessOfWindow(long hwndValue)
    {
        if (hwndValue == 0) return 0;
        IntPtr hwnd = new IntPtr(hwndValue);
        IntPtr root = GetAncestor(hwnd, GA_ROOT);
        if (root == IntPtr.Zero) root = hwnd;
        uint pid;
        GetWindowThreadProcessId(root, out pid);
        return unchecked((int)pid);
    }

    /** 坐标 → 那一点的窗口 → 判定。点在桌面 / 托盘空白处时 WindowFromPoint 回 0 → unknown */
    internal static Decision JudgePoint(int x, int y, IList<ProcRow> rows, IList<int> roots,
        IList<string> allowExe)
    {
        POINT point = new POINT();
        point.X = x;
        point.Y = y;
        IntPtr hwnd = WindowFromPoint(point);
        return JudgeWindow(hwnd.ToInt64(), rows, roots, allowExe);
    }

    /** 已知 hwnd 的判定（UIA 动作与点击共用）：hwnd 原样带进回执，便于事后对号 */
    internal static Decision JudgeWindow(long hwndValue, IList<ProcRow> rows, IList<int> roots,
        IList<string> allowExe)
    {
        int pid = ProcessOfWindow(hwndValue);
        Decision decision = Judge(pid, rows, roots, allowExe);
        decision.TargetHwnd = hwndValue;
        return decision;
    }

    // ---- 输出 --------------------------------------------------------------

    /**
     * 回执里的字段片段（**以逗号开头**，直接拼在 `{"ok":true` 后面）。
     * 键名与宿主的解析（shared/computer-use.ts 的 parseComputerUseAdmission）逐字一致。
     */
    internal static string JsonFields(Decision decision)
    {
        StringBuilder json = new StringBuilder();
        json.Append(",\"admission\":").Append(Program.JsonQuote(decision.Admission))
            .Append(",\"targetExe\":").Append(Program.JsonQuote(decision.TargetExe))
            .Append(",\"targetPid\":").Append(decision.TargetPid);
        if (decision.TargetHwnd != 0) json.Append(",\"targetHwnd\":").Append(decision.TargetHwnd);
        return json.ToString();
    }

    /** 一行日志：真机上排查「模型到底点了谁」的第一手证据（bridge.log 落在宿主 out/） */
    internal static void Log(string action, Decision decision)
    {
        string line = "[admission] " + action + " → " + decision.Admission + " targetExe="
            + (decision.TargetExe.Length == 0 ? "(unknown)" : decision.TargetExe)
            + " pid=" + decision.TargetPid;
        if (decision.TargetHwnd != 0) line = line + " hwnd=" + decision.TargetHwnd;
        Program.Log(line);
    }

    // ---- 自测（--selftest-admission：纯函数，不碰真实窗口 / 不起进程）------------

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // 假进程表：桥(100) → worker(200) → Edge 浏览器(300)
        //          explorer(500) → 记事本(400)：记事本在树外，但父链是完整的
        // 600 ↔ 501 互为父进程：父链成环，必须停下而不是转圈
        List<ProcRow> rows = new List<ProcRow>();
        rows.Add(new ProcRow(100, 0, "orbita-guest-bridge.exe"));
        rows.Add(new ProcRow(200, 100, "orbita-guest-bridge.exe"));
        rows.Add(new ProcRow(300, 200, "msedge.exe"));
        rows.Add(new ProcRow(400, 500, "notepad.exe"));
        rows.Add(new ProcRow(500, 0, "explorer.exe"));
        rows.Add(new ProcRow(600, 501, "loop-a.exe"));
        rows.Add(new ProcRow(501, 600, "loop-b.exe"));
        List<int> roots = new List<int> { 100 };
        List<string> none = new List<string>();

        Decision d;
        d = Judge(300, rows, roots, none);
        Program.CheckString(failures, ref cases, "树里的 Edge（曾孙）→ owned", VerdictOwned, d.Admission);
        Program.CheckString(failures, ref cases, "owned 时 targetExe 是 msedge.exe", "msedge.exe", d.TargetExe);
        Program.CheckNumber(failures, ref cases, "owned 时 targetPid 是 guest 内 pid", "300",
            d.TargetPid.ToString());

        d = Judge(100, rows, roots, none);
        Program.CheckString(failures, ref cases, "树根自己 → owned", VerdictOwned, d.Admission);

        d = Judge(400, rows, roots, none);
        Program.CheckString(failures, ref cases, "树外的记事本 → bypassed（观察模式，不拒）",
            VerdictBypassed, d.Admission);
        Program.CheckString(failures, ref cases, "bypassed 带上正确的 targetExe", "notepad.exe",
            d.TargetExe);

        d = Judge(500, rows, roots, none);
        Program.CheckString(failures, ref cases, "任务栏 / 桌面（explorer.exe）→ bypassed",
            VerdictBypassed, d.Admission);

        d = Judge(400, rows, roots, new List<string> { "notepad.exe" });
        Program.CheckString(failures, ref cases, "白名单命中 → allowlisted", VerdictAllowlisted,
            d.Admission);

        d = Judge(400, rows, roots, new List<string> { "NOTEPAD.EXE" });
        Program.CheckString(failures, ref cases, "白名单大小写不敏感", VerdictAllowlisted, d.Admission);

        d = Judge(300, rows, roots, new List<string> { "msedge.exe" });
        Program.CheckString(failures, ref cases, "owned 优先于 allowlisted", VerdictOwned, d.Admission);

        d = Judge(999, rows, roots, none);
        Program.CheckString(failures, ref cases, "快照里没有的 pid → unknown", VerdictUnknown,
            d.Admission);
        Program.CheckString(failures, ref cases, "unknown 时 targetExe 是空串", "", d.TargetExe);

        d = Judge(0, rows, roots, none);
        Program.CheckString(failures, ref cases, "pid 0 → unknown", VerdictUnknown, d.Admission);

        d = Judge(600, rows, roots, none);
        Program.CheckString(failures, ref cases, "父链成环时不挂、落到 bypassed", VerdictBypassed,
            d.Admission);

        Program.CheckNumber(failures, ref cases, "空快照：pid 留在回执里供排查，exe 为 unknown", "300",
            Judge(300, new List<ProcRow>(), roots, none).TargetPid.ToString());

        // 父链本身
        Program.CheckTrue(failures, ref cases, "IsInTree 认孙进程", IsInTree(300, rows, roots));
        Program.CheckTrue(failures, ref cases, "IsInTree 不认树外的进程", !IsInTree(500, rows, roots));
        Program.CheckTrue(failures, ref cases, "IsInTree 多根：任一命中即可",
            IsInTree(300, rows, new List<int> { 555, 100 }));
        Program.CheckTrue(failures, ref cases, "IsInTree 父链断了就停（pid 700 不在快照）",
            !IsInTree(700, rows, roots));

        // 白名单规范化与合并
        List<string> merged = MergeAllowExe(" notepad.exe , C:\\Windows\\System32\\calc.exe ,bad ,,MSEDGE.EXE ");
        Program.CheckNumber(failures, ref cases, "合并后条数（默认 msedge + 两个有效项）", "3",
            merged.Count.ToString());
        Program.CheckString(failures, ref cases, "内置默认总在第一位", "msedge.exe", merged[0]);
        Program.CheckString(failures, ref cases, "路径取末段 + 小写", "calc.exe", merged[2]);
        Program.CheckString(failures, ref cases, "null 也回内置默认", "1",
            MergeAllowExe(null).Count.ToString());
        Program.CheckString(failures, ref cases, "坏值（不带 .exe）丢掉", "", NormalizeExe("notepad"));
        Program.CheckString(failures, ref cases, "纯空白丢掉", "", NormalizeExe("   "));
        Program.CheckTrue(failures, ref cases, "Allowlisted 也认带路径的白名单项",
            Allowlisted("calc.exe", new List<string> { "C:\\Windows\\System32\\calc.exe" }));

        // 回执片段：宿主按这几个键名解析，键名漂了回执就静默丢准入信息
        string json = JsonFields(new Decision(VerdictBypassed, "notepad.exe", 400, 0x1234));
        Program.CheckString(failures, ref cases, "回执片段以逗号开头（拼在 {\"ok\":true 后面）",
            ",\"admission\":\"bypassed\",\"targetExe\":\"notepad.exe\",\"targetPid\":400,\"targetHwnd\":4660",
            json);
        string unknownJson = JsonFields(new Decision(VerdictUnknown, "", 0, 0));
        Program.CheckString(failures, ref cases, "unknown 不带 targetHwnd", ",\"admission\":\"unknown\",\"targetExe\":\"\",\"targetPid\":0",
            unknownJson);

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        if (failures.Count > 0)
        {
            for (int i = 0; i < failures.Count; i++) Console.Error.WriteLine("FAIL " + failures[i]);
            return 1;
        }
        return 0;
    }
}
