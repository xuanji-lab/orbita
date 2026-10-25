// Orbita guest bridge —— 可杀的 CDP worker（桥版本 0.7.0）。
//
// 为什么要有这一层：桥是**单线程轮询**的（Program.cs 的 CommandLoop）。0.6.0 里一条
// cdp-nav / cdp-shot 卡住（慢站点、死 socket、COM/UIA 调用）就把整条桥占住——其他会话的
// ping / 截图 / 点击全部排队。这是队头阻塞，不是「某条命令慢」。
//
// 0.7.0 起每个会话的 CDP 执行放进**它自己的 worker 子进程**：
//   * 主桥只做「确保 worker 在跑 → 把命令转写进它的目录 → 起一个后台等待线程」，
//     命令循环永远不被一条慢命令占住（**等待在后台线程里**，不在轮询循环里）；
//   * 一条命令超过 CommandTimeoutMs 还没有回执 → taskkill 那个 worker 的整棵进程树
//     （worker 的 Edge 是它的子进程，一起走）→ 回一句模型能照着做的人话；
//     这个会话的下一条命令自动拉起新 worker；
//   * worker 自己崩了（回执缺失 + 进程已退出）→ 同样回错误、允许下一条重启；
//   * 空闲 5 分钟 → 主桥回收 worker（连带 Edge 与 profile），与 0.6.0 的 ReapIdle 同义。
//
// 协议还是**映射文件夹里的文件**（理由见 Program.cs 头部：宿主↔沙箱的 TCP 不可测）：
//   主桥 → worker： <out>\worker\<会话>\cmd\<会话>-cmd-<6 位序号>.req.json（tmp+rename）
//   worker → 主桥： 同名 .resp.json；cdp-shot 的 JPEG 是同名 .jpg 兄弟文件（先于 resp 落盘）
//   worker 启动通告：<out>\worker\<会话>\worker.json = {pid, session, startedAt}
//
// 名字里带**会话前缀**是故意的：worker 的截图兄弟文件要**原样**搬回主 cmd\ 目录
// （宿主侧协议一个字都没变：resp 里的 jpeg 仍是纯文件名），而不同会话的序号都从 1 起，
// 不带前缀就会在 cmd\ 里撞名、把别人的图读走。
//
// 进程模型：同一个 exe，`--cdp-worker <outDir> <session>` 就是 worker 入口——它不再读
// cmd\ 的主命令流，只读自己目录里的请求。worker 内只有一个 CdpSession（一个会话一个
// Edge），单线程轮询足够：它只服务一个会话，不需要并发。
//
// 约束不变：csc v4.0.30319 = C# 5（禁字符串插值 / ?. / out var / using 声明 / 枚举 /
//   表达式体成员 / 数字分隔符），全部同步等待（桥本来就是阻塞式轮询，铺 async 没有收益）。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

internal static class WorkerHost
{
    // ---- 协议常量（目录名与后缀必须与 Program.cs / 宿主侧严格对齐）----
    internal const string WorkerDirName = "worker";
    private const string ReqSuffix = ".req.json";
    private const string RespSuffix = ".resp.json";
    private const string ShotSuffix = ".jpg";

    /** 等 worker 回执的轮询节奏（映射文件夹同步即时，这只是读盘节奏） */
    private const int RespPollIntervalMs = 200;
    /** worker 自己的命令轮询间隔（与主桥同款：只服务一个会话，不需要更快） */
    private const int WorkerPollIntervalMs = 250;
    /** worker 的慢路径对齐周期：16 × 250ms ≈ 4s（理由与 Program.PollOnce 相同） */
    private const int AlignEveryPolls = 16;
    /** worker 检查父进程还在不在的周期：8 × 250ms ≈ 2s */
    private const int ParentCheckPolls = 8;
    /** 等 worker 写出 worker.json 的上限（进程启动 + 建目录，真机上是几十毫秒） */
    private const int WorkerStartTimeoutMs = 10000;
    /** cdp-stop 给 worker 自己收尾的时间，超了就 taskkill */
    private const int StopWaitMs = 5000;
    /** taskkill 之后等它真的退出的上限（免得下一条命令撞上同一具尸体） */
    private const int KillWaitMs = 3000;
    /** 汇总 cdp-status 时问单个 worker 的上限（卡住的 worker 不该把汇总拖到天荒地老） */
    private const int AggregateStatusTimeoutMs = 3000;
    /**
     * 把 worker 的截图搬回主 cmd\\ 目录的重试窗口。**只有回执里点了名（cdp-shot）才会走到这里**，
     * 而且 worker 是先写 jpg 再写 resp，正常一次就命中；窗口只给「映射目录的元数据还没刷新」
     * 那种回落现场留余量。
     */
private const int ShotCopyWaitMs = 2000;

    /**
     * 一条 worker 命令的放弃线（杀线）。
     *
     * 宿主等**浏览器命令**的那条线是 COMPUTER_USE_CDP_TIMEOUT_MS（70s，见
     * shared/computer-use.ts），不是像素命令的 45s——因为杀掉之后这里写的回执还要走一跳
     * 才能到宿主（2026-10-25 真机满载：每一跳 8–19s）。40 + 19 = 59s < 70s，那句人话才送得到；
     * 45s 会在杀线之前就放弃（真机就是这样把那句人话丢掉的）。
     *
     * 40s 本身留给「杀进程 + 写回执」；cdp-* 自己的内部超时（导航 20s、截图 25s、下载 20s）
     * 都在它之下。**改这个数字要同步看 shared/computer-use.ts 的两条客线。**
     */
    internal static int CommandTimeoutMs = 40000;

    /** 测试缝（`--test-hooks`）：只有它才认 worker-ping / worker-hang / worker-stop，生产永不带 */
    internal static bool TestHooks = false;

    /** 一个会话的 worker。NextSeq 与 LastActivityUtc 只在 Gate 里改 */
    private sealed class WorkerHandle
    {
        internal string Key = "";
        internal string Dir = "";
        internal string CmdDir = "";
        internal int Pid;
        internal Process Process;
        internal int NextSeq = 1;
        internal DateTime LastActivityUtc = DateTime.UtcNow;
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<string, WorkerHandle> Workers =
        new Dictionary<string, WorkerHandle>(StringComparer.Ordinal);

    // ── 主桥入口 ────────────────────────────────────────────────────────────────

    /** worker 层的测试命令（只有 --test-hooks 的桥会路由它们，见 Program.Execute） */
    internal static bool IsWorkerTestCommand(string command)
    {
        return command == "worker-ping" || command == "worker-hang" || command == "worker-stop";
    }

    /**
     * 主桥收到一条 `cdp-*`（或测试缝的 `worker-*`）命令。
     *
     * 返回 null = **这条命令已经交给后台线程**，回执由它写：命令循环必须立刻回去轮询，
     * 去看别的会话的命令（这正是这条 PR 的全部意义）。返回字符串 = 立刻就能回的答案。
     */
    internal static string Execute(string command, string raw, string baseName)
    {
        string rawSession = Program.ExtractJsonString(raw, "session");
        bool hasSession = rawSession != null && rawSession.Length > 0;

        if (IsWorkerTestCommand(command))
            return Dispatch(CdpSessions.SafeSessionId(rawSession), command, raw, baseName);

        if (!CdpSessions.IsKnown(command)) return Fail("未知的 CDP 命令：" + command);
        // cdp-status 不带 session = 汇总所有会话（宿主在「缓存说到上限」时靠它拿真值）
        if (command == "cdp-status" && !hasSession) return AggregateStatus(baseName);

        string key = CdpSessions.SafeSessionId(rawSession);
        if (command == "cdp-stop") return StopSession(key);

        WorkerHandle worker = Find(key);
        // cdp-start 是**唯一**能让会话长出一个浏览器的命令：它不分条件地交给 worker（没有就拉一个）。
        // 其余命令在没有 worker 时直接在本进程答：没有 worker = 它的浏览器不可能在跑，
        // 与 0.6.0 的「临时实例」同义——参数校验照旧发生在碰 CDP 之前，
        // 而且**不占名额、不起进程**（一条 cdp-status 不该为了一次查询拉起一个 worker）。
        if (worker != null || command == "cdp-start") return Dispatch(key, command, raw, baseName);
        return new CdpSession(key).Execute(command, raw, baseName, Program.CmdDir);
    }

    /** 把命令写进该会话的 worker 目录，并在后台线程等回执。返回 null = 已交给后台 */
    private static string Dispatch(string key, string command, string raw, string baseName)
    {
        WorkerHandle worker = Find(key);
        if (worker == null)
        {
            int live = LiveCount();
            if (live >= CdpSessions.MaxBrowsers)
                return new JObj().Bool("ok", false).Str("session", key)
                    .Str("error", CdpSessions.TooManyMessage()).ToString();
            try
            {
                worker = StartWorker(key);
            }
            catch (Exception ex)
            {
                Program.Log("启动 CDP worker 失败（会话 " + key + "）：" + ex.Message);
                return Fail("沙箱里这个会话的浏览器通道起不来：" + ex.Message
                    + "。可以再试一次；连续失败就先 cdp-stop 这个会话，或改用 computer_screenshot / computer_click 像素工具");
            }
        }

        int seq = TakeSeq(worker);
        string workerBase = WorkerBase(key, seq);
        try
        {
            Program.AtomicWrite(Path.Combine(worker.CmdDir, workerBase + ReqSuffix), Encoding.UTF8.GetBytes(raw));
        }
        catch (Exception ex)
        {
            Program.Log("把命令转写给 CDP worker 失败（会话 " + key + "）：" + ex.Message);
            return Fail("把命令交给沙箱里的浏览器通道失败：" + ex.Message
                + "。可以再试一次，或改用 computer_screenshot / computer_click 像素工具");
        }

        Thread waiter = new Thread(delegate() { CompleteInBackground(worker, command, workerBase, baseName); });
        waiter.IsBackground = true;
        waiter.Start();
        return null;
    }

    /**
     * 后台等待线程：等 worker 的回执 → 把截图搬回来 → 写宿主要的 resp。
     *
     * 三条出口都是「给模型一句能照着做的话」：
     *   有回执 → 原样转交（宿主的协议没变）；
     *   没回执且进程已退 → 崩了，下一条命令会自动重新拉起；
     *   没回执且进程还活着 → 卡住了，**杀掉**（连带它的 Edge），下一条命令重新拉起。
     */
    private static void CompleteInBackground(WorkerHandle worker, string command, string workerBase, string hostBaseName)
    {
        Stopwatch clock = Stopwatch.StartNew();
        string respText = WaitWorkerResp(worker, workerBase, CommandTimeoutMs);
        long waitMs = clock.ElapsedMilliseconds;
        if (respText != null)
        {
            long visibleStartMs = clock.ElapsedMilliseconds;
            DateTime respMtimeUtc = DateTime.MinValue;
            try { respMtimeUtc = File.GetLastWriteTimeUtc(Path.Combine(worker.CmdDir, workerBase + RespSuffix)); }
            catch { }
            string visibleNote;
            long visibleMs = Program.PropagateFromMtime(respMtimeUtc, DateTime.UtcNow, out visibleNote);
            visibleMs -= clock.ElapsedMilliseconds - visibleStartMs; // 去掉上面这次 stat 自己的耗时（负数不算）
            if (visibleMs < 0) visibleMs = 0;
            // 顺序与桥自己的协议一致：**截图先落盘、resp 后落盘**；有没有图看 resp（见 CopySiblingFileIfAny）
            long copyMs = CopySiblingFileIfAny(worker.CmdDir, Program.CmdDir, respText, workerBase);
            long writeStartMs = clock.ElapsedMilliseconds;
            WriteHostResp(hostBaseName, respText);
            long writeMs = clock.ElapsedMilliseconds - writeStartMs;
            LogBridgeHop(command, waitMs, visibleMs, visibleNote, copyMs, writeMs);
            if (HasExited(worker))
            {
                Forget(worker.Key, worker.Pid);
                CleanupWorkerInfo(worker);
            }
        }
        else if (HasExited(worker))
        {
            Forget(worker.Key, worker.Pid);
            CleanupWorkerInfo(worker);
            Program.Log("CDP worker 已退出且没有回执：会话 " + worker.Key + "，pid " + worker.Pid + "，" + command);
            WriteHostResp(hostBaseName, Fail("沙箱里的浏览器通道意外退出（" + command + " 没有回执），"
                + "这个会话的下一条命令会自动重新拉起——可以用 cdp-status 确认会话状态，或改用像素工具"));
        }
        else
        {
            Program.Log("cdp worker 超时被杀：会话 " + worker.Key + "，pid " + worker.Pid + "，"
                + command + " 超过 " + CommandTimeoutMs + "ms");
            KillTree(worker.Pid);
            WaitExit(worker, KillWaitMs);
            Forget(worker.Key, worker.Pid);
            CleanupWorkerInfo(worker);
            WriteHostResp(hostBaseName, Fail("沙箱里的浏览器没有响应（" + command + " 超时），"
                + "已重启该会话的浏览器通道——可以用 cdp-status 确认，或改用像素工具"));
        }
        CleanupWorkerFiles(worker.CmdDir, workerBase);
    }

    /**
     * 桥侧的一行耗时：等 worker 回执多久，其中「worker 写出 → 本进程看见」占多少。
     *
     * 为什么要它（2026-10-25 真机）：宿主看到一条 warm 导航 2649ms，而 worker 自己的回执
     * 里 ms=343——那 2.3s 卡在 worker 写完回执之后。两个候选只能用这一行分开：
     *   ① 回执落在 `out\worker\<会话>\cmd`（映射目录，走 RDP 驱动器重定向）——
     *      `WaitWorkerResp` 的 File.Exists 拿到的是缓存过的旧答案，文件其实早就写好了；
     *   ② 回执写本身很慢（那就是 worker 侧那一行里的「回执落盘」）。
     * 只打日志，不加任何等待。
     */
    private static void LogBridgeHop(string command, long waitMs, long visibleMs, string visibleNote,
        long copyMs, long writeMs)
    {
        if (!Program.HopNeedsLog(Program.HopLogLineMs, new long[] { waitMs, copyMs, writeMs })) return;
        StringBuilder sb = new StringBuilder("worker 回执 ").Append(command).Append("：等 ").Append(waitMs)
            .Append("ms（其中 worker 写出→本进程看见 ").Append(visibleMs).Append("ms，").Append(visibleNote)
            .Append("；轮询节奏 ").Append(RespPollIntervalMs).Append("ms） + 搬图 ").Append(copyMs)
            .Append("ms + 写宿主回执 ").Append(writeMs).Append("ms");
        Program.Log(sb.ToString());
    }

    /**
     * cdp-stop：先让 worker 自己收尾（它知道要杀哪个 Edge），5s 不退就 taskkill，
     * 然后删 profile 目录。
     *
     * **只按 worker.json 里记下的 pid 杀**（仓规：绝不按镜像名杀）。已经停过就幂等回 ok
     * ——宿主停沙箱时会逐会话无脑调用一次。
     */
    private static string StopSession(string key)
    {
        WorkerHandle worker = Find(key);
        if (worker == null)
        {
            CdpSessions.DeleteProfile(key); // 超时被杀掉的 worker 也会留下 profile：顺手清掉
            return new JObj().Bool("ok", true).Str("session", key).Bool("alreadyStopped", true).ToString();
        }

        int seq = TakeSeq(worker);
        string workerBase = WorkerBase(key, seq);
        try
        {
            Program.AtomicWrite(Path.Combine(worker.CmdDir, workerBase + ReqSuffix),
                Encoding.UTF8.GetBytes("{\"command\":\"worker-stop\"}"));
        }
        catch (Exception ex)
        {
            Program.Log("给 CDP worker 发 worker-stop 失败（会话 " + key + "）：" + ex.Message);
        }

        // 回执不代表退出（worker 先写 resp 再收尾），真正要等的是进程消失
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(StopWaitMs);
        while (DateTime.UtcNow < deadline && !HasExited(worker)) Thread.Sleep(100);
        if (!HasExited(worker))
        {
            Program.Log("CDP worker " + StopWaitMs + "ms 内没有退出，taskkill：pid " + worker.Pid);
            KillTree(worker.Pid);
            WaitExit(worker, KillWaitMs);
        }

        Forget(key, worker.Pid);
        CleanupWorkerFiles(worker.CmdDir, workerBase);
        CleanupWorkerFiles(worker.CmdDir, null);
        CleanupWorkerInfo(worker);
        CdpSessions.DeleteWorkerCmdDir(worker.CmdDir);
        CdpSessions.DeleteProfile(key);
        return new JObj().Bool("ok", true).Str("session", key).ToString();
    }

    /**
     * cdp-status 不带 session = 汇总所有会话。**每个 worker 单独问、各自限时**：
     * 一个卡住的 worker 不该把整份汇总拖死，它那一行如实标 `unresponsive`（它还占着名额）。
     * 与其他 cdp-* 一样走后台线程——汇总也要逐个等，不能占住命令循环。
     */
    private static string AggregateStatus(string hostBaseName)
    {
        List<WorkerHandle> all = Snapshot();
        List<WorkerHandle> live = new List<WorkerHandle>();
        for (int i = 0; i < all.Count; i++)
        {
            if (HasExited(all[i]))
            {
                Forget(all[i].Key, all[i].Pid);
                continue;
            }
            live.Add(all[i]);
        }
        if (live.Count == 0)
            return new JObj().Bool("ok", true).Bool("running", false).Num("count", 0).Raw("sessions", "[]").ToString();

        Thread waiter = new Thread(delegate() { AggregateInBackground(live, hostBaseName); });
        waiter.IsBackground = true;
        waiter.Start();
        return null;
    }

    private static void AggregateInBackground(List<WorkerHandle> live, string hostBaseName)
    {
        StringBuilder list = new StringBuilder("[");
        bool anyRunning = false;
        for (int i = 0; i < live.Count; i++)
        {
            WorkerHandle worker = live[i];
            int seq = TakeSeq(worker);
            string workerBase = WorkerBase(worker.Key, seq);
            string entry = null;
            try
            {
                Program.AtomicWrite(Path.Combine(worker.CmdDir, workerBase + ReqSuffix),
                    Encoding.UTF8.GetBytes("{\"command\":\"cdp-status\",\"session\":"
                        + Program.JsonQuote(worker.Key) + "}"));
                entry = WaitWorkerResp(worker, workerBase, AggregateStatusTimeoutMs);
            }
            catch (Exception ex)
            {
                Program.Log("汇总状态时转发失败（会话 " + worker.Key + "）：" + ex.Message);
            }
            CleanupWorkerFiles(worker.CmdDir, workerBase);

            if (entry == null)
            {
                // 卡在某条命令里：如实说「它还在跑」，别让宿主以为名额空出来了
                entry = new JObj().Str("session", worker.Key).Bool("running", true).Num("port", 0)
                    .Bool("unresponsive", true).ToString();
                anyRunning = true;
            }
            else if (entry.IndexOf("\"running\":true", StringComparison.Ordinal) >= 0)
            {
                anyRunning = true;
            }
            if (i > 0) list.Append(",");
            list.Append(entry);
        }
        list.Append("]");
        string json = new JObj().Bool("ok", true).Bool("running", anyRunning).Num("count", live.Count)
            .Raw("sessions", list.ToString()).ToString();
        WriteHostResp(hostBaseName, json);
    }

    /**
     * 空闲回收：命令循环每轮调一次（没有 worker 时立刻返回）。
     * worker 的 LastActivityUtc 在**每次转发**时刷新，所以卡住的 worker 不会被误回收——
     * 它自己的超时会先把它带走。
     */
    internal static void ReapIdle()
    {
        List<WorkerHandle> all = Snapshot();
        if (all.Count == 0) return;
        for (int i = 0; i < all.Count; i++)
        {
            WorkerHandle worker = all[i];
            double idleMs = (DateTime.UtcNow - worker.LastActivityUtc).TotalMilliseconds;
            if (idleMs < CdpSessions.IdleReapMs) continue;
            Program.Log("CDP 会话 " + worker.Key + " 空闲 " + (long)(idleMs / 1000)
                + " 秒，回收（停 worker + Edge + 删 profile）");
            KillTree(worker.Pid);
            WaitExit(worker, KillWaitMs);
            Forget(worker.Key, worker.Pid);
            CleanupWorkerFiles(worker.CmdDir, null);
            CleanupWorkerInfo(worker);
            CdpSessions.DeleteWorkerCmdDir(worker.CmdDir);
            CdpSessions.DeleteProfile(worker.Key);
        }
    }

    // ── worker 生命周期 ────────────────────────────────────────────────────────

    /**
     * 起一个 worker：**同一个 exe**，`--cdp-worker <outDir> <session>`。
     * pid 只认它自己写的 worker.json——之后所有 taskkill 都用那个数字。
     */
    private static WorkerHandle StartWorker(string key)
    {
        string dir = Path.Combine(Program.OutDir, WorkerDirName, key);
        // 命令目录可能在 guest 本地盘（见 CdpSessions.WorkerCmdDir）：只用它本身，不再假定它在 dir 下面
        string cmdDir = CdpSessions.WorkerCmdDir(Program.OutDir, key);
        try
        {
            Directory.CreateDirectory(dir);
            Directory.CreateDirectory(cmdDir);
        }
        catch (Exception ex)
        {
            throw new Exception("worker 目录建不起来（" + cmdDir + "）：" + ex.Message);
        }
        if (!string.Equals(cmdDir, Path.Combine(dir, "cmd"), StringComparison.OrdinalIgnoreCase))
            Program.Log("worker 命令目录在 guest 本地盘：" + cmdDir + "（不经映射文件夹，避开重定向的元数据缓存）");
        // 上一局的残留（同会话重启 / 桥被重启过）：先清空，新 worker 的序号从 1 起。
        // 不清的话它的直探会撞上旧 req，把一条上辈子的命令再执行一遍。
        CleanupWorkerFiles(cmdDir, null);
        try { File.Delete(Path.Combine(dir, "worker.json")); } catch { }

        StringBuilder args = new StringBuilder();
        args.Append("--cdp-worker ").Append(QuoteArg(Program.OutDir)).Append(" ").Append(QuoteArg(key));
        args.Append(" --parent-pid ").Append(Process.GetCurrentProcess().Id.ToString());
        // 命令目录由主桥选定（本地盘 / 回落映射目录），worker 不许自己再算一遍
        args.Append(" --worker-cmd-dir ").Append(QuoteArg(cmdDir));
        // 测试模式必须传下去：worker 才是真正会 Process.Start msedge.exe 的那个进程
        if (Program.BrowserDisabled) args.Append(" --no-browser");
        if (TestHooks) args.Append(" --test-hooks");

        ProcessStartInfo info = new ProcessStartInfo(ExecutablePath(), args.ToString());
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        // **不加 RedirectStandardOutput/Error**：那是同步管道，父进程（单线程轮询循环）不读干子进程就会阻。
        // worker 自己的日志由**它自己**写进映射目录（Program.RedirectWorkerLog），这里只记一笔路标。
        Program.Log("启动 worker：会话 " + key + "，日志 " + Path.Combine(dir, "worker.log"));
        Process process = Process.Start(info);
        if (process == null) throw new Exception("进程没有起来（Process.Start 返回 null）");

        string infoPath = Path.Combine(dir, "worker.json");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(WorkerStartTimeoutMs);
        int pid = 0;
        while (DateTime.UtcNow < deadline)
        {
            string text = TryReadText(infoPath);
            if (text != null)
            {
                string pidText = Program.ExtractNumber(text, "pid");
                if (pidText != null && int.TryParse(pidText, out pid) && pid > 0) break;
                pid = 0;
            }
            if (HasExitedProcess(process)) break;
            Thread.Sleep(100);
        }
        if (pid <= 0)
        {
            int childPid = OwnPid(process);
            try { process.Kill(); } catch { }
            if (childPid > 0) KillTree(childPid);
            try { process.Dispose(); } catch { }
            throw new Exception("worker 起来了但没有通告 worker.json（" + infoPath + "）");
        }

        WorkerHandle handle = new WorkerHandle();
        handle.Key = key;
        handle.Dir = dir;
        handle.CmdDir = cmdDir;
        handle.Pid = pid;
        handle.Process = process;
        handle.NextSeq = 1;
        handle.LastActivityUtc = DateTime.UtcNow;
        lock (Gate)
        {
            WorkerHandle existing;
            if (Workers.TryGetValue(key, out existing) && existing.Pid != pid) Forget(existing.Key, existing.Pid);
            Workers[key] = handle;
        }
        Program.Log("CDP worker 已启动：会话 " + key + "，pid " + pid + "，目录 " + dir);
        return handle;
    }

    private static WorkerHandle Find(string key)
    {
        WorkerHandle worker;
        lock (Gate)
        {
            if (!Workers.TryGetValue(key, out worker)) return null;
        }
        if (HasExited(worker))
        {
            Forget(key, worker.Pid);
            CleanupWorkerFiles(worker.CmdDir, null);
            CleanupWorkerInfo(worker);
            return null;
        }
        return worker;
    }

    /** 从表里摘掉**这一个** worker。pid 必须对上：迟到的超时收尾不能误删刚重启的那一个 */
    private static void Forget(string key, int pid)
    {
        lock (Gate)
        {
            WorkerHandle existing;
            if (Workers.TryGetValue(key, out existing) && existing.Pid == pid) Workers.Remove(key);
        }
    }

    private static List<WorkerHandle> Snapshot()
    {
        lock (Gate)
        {
            if (Workers.Count == 0) return new List<WorkerHandle>();
            return new List<WorkerHandle>(Workers.Values);
        }
    }

    private static int LiveCount()
    {
        List<WorkerHandle> all = Snapshot();
        int live = 0;
        for (int i = 0; i < all.Count; i++)
        {
            if (!HasExited(all[i])) live++;
        }
        return live;
    }

    private static int TakeSeq(WorkerHandle worker)
    {
        lock (Gate)
        {
            int seq = worker.NextSeq;
            worker.NextSeq = seq + 1;
            worker.LastActivityUtc = DateTime.UtcNow;
            return seq;
        }
    }

    /**
     * worker 侧的命令文件名：`<会话>-cmd-<6 位序号>`。
     *
     * 带会话前缀是为了它能**原样**出现在主 cmd\ 目录里（截图兄弟文件不改名、resp 不用改字）：
     * 每个 worker 的序号都从 1 起，不前缀就会两个会话都写 `cmd-000001.jpg`。
     */
    private static string WorkerBase(string key, int seq)
    {
        return key + "-cmd-" + seq.ToString("000000");
    }

    // ── 文件搬运与进程小工具 ───────────────────────────────────────────────────

    private static string WaitWorkerResp(WorkerHandle worker, string workerBase, int timeoutMs)
    {
        string path = Path.Combine(worker.CmdDir, workerBase + RespSuffix);
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            string text = TryReadText(path);
            if (text != null) return text;
            if (HasExited(worker)) return null;
            Thread.Sleep(RespPollIntervalMs);
        }
        return TryReadText(path);
    }

    /**
     * 回执里点了名的兄弟文件（cdp-shot 的 jpg）搬回主 cmd 目录；**没有就一步都不走**。
     *
     * 判据是 **resp 字段**，不是命令名：
     *   * 协议里「这条命令有没有一张要搬的图」的唯一权威就是回执的 `jpeg` 字段；
     *   * 命令名白名单会在下一个产文件的命令上重新踩一遍这个坑；
     *   * 反过来「先探文件在不在」也不行——映射目录上探一次就可能几秒，而这正是要省的。
     * 以后真有命令产出别的兄弟文件，在这里按字段名登记，而不是放宽成无条件搬。
     *
     * 返回搬图耗时（日志里的「搬图 Xms」；跳过时是 0，也照打——下次一眼能看出有没有白等）。
     *
     * 真机 2026-10-25：这里原来对**每条**命令都无条件调 CopyShotBack，而它在等一张只有
     * cdp-shot 才会产生的 jpg，于是等满 ShotCopyWaitMs：
     *   worker 回执 cdp-start：等 3290ms + 搬图 2057ms + 写宿主回执 3ms
     *   worker 回执 cdp-nav  ：等 203ms  + 搬图 2102ms + 写宿主回执 3ms
     * cdp-start / cdp-nav / cdp-status 全部白付 2 秒——那 2.6 秒的主项就是它。
     */
    internal static long CopySiblingFileIfAny(string workerCmdDir, string hostCmdDir, string respText, string workerBase)
    {
        string jpegName = Program.ExtractJsonString(respText, "jpeg");
        if (jpegName == null || jpegName.Length == 0) return 0; // 这条命令没有兄弟文件
        Stopwatch clock = Stopwatch.StartNew();
        CopyShotBack(workerCmdDir, hostCmdDir, workerBase);
        return clock.ElapsedMilliseconds;
    }

    /**
     * cdp-shot 的 JPEG 从 worker 目录搬到主 cmd\ 目录（**同名**：resp 里引用的名字因此不用改）。
     *
     * 目标名仍按我们自己的 workerBase 拼，不采信 resp 里的字符串（那是 guest 自己写的内容；
     * 路径只能由我们这边的序号决定）。窗口只服务「图已经在、元数据还没刷新」这种现场
     *（命令目录回落到映射目录时就是那样），正常一次就命中：worker 是先写 jpg 再写 resp 的。
     */
    internal static void CopyShotBack(string workerCmdDir, string hostCmdDir, string workerBase)
    {
        string src = Path.Combine(workerCmdDir, workerBase + ShotSuffix);
        string dst = Path.Combine(hostCmdDir, workerBase + ShotSuffix);
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ShotCopyWaitMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (File.Exists(src))
                {
                    File.Copy(src, dst, true);
                    return;
                }
            }
            catch (Exception ex)
            {
                Program.Log("搬运截图失败（" + src + "）：" + ex.Message);
                return;
            }
            Thread.Sleep(100);
        }
    }

    private static void WriteHostResp(string hostBaseName, string json)
    {
        try
        {
            Program.AtomicWrite(Path.Combine(Program.CmdDir, hostBaseName + RespSuffix),
                Encoding.UTF8.GetBytes(json));
        }
        catch (Exception ex)
        {
            Program.Log("写回执失败（" + hostBaseName + "）：" + ex.Message);
        }
    }

    /** baseName == null 时清空命令目录里所有文件（上一局残留 / 回收一个 worker） */
    private static void CleanupWorkerFiles(string cmdDir, string baseName)
    {
        try
        {
            if (baseName != null)
            {
                File.Delete(Path.Combine(cmdDir, baseName + ReqSuffix));
                File.Delete(Path.Combine(cmdDir, baseName + RespSuffix));
                File.Delete(Path.Combine(cmdDir, baseName + ShotSuffix));
                return;
            }
            foreach (string path in Directory.GetFiles(cmdDir)) File.Delete(path);
        }
        catch
        {
            // 清理是尽力而为：残留文件不影响协议（名字不重），下一局 start 会整个清掉
        }
    }

    /** worker.json 是「这个会话有一个 worker」的告示：worker 走了就要撤掉，别留一份假的 */
    private static void CleanupWorkerInfo(WorkerHandle worker)
    {
        try { File.Delete(Path.Combine(worker.Dir, "worker.json")); } catch { }
    }

    private static string TryReadText(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            return File.ReadAllText(path, Encoding.UTF8);
        }
        catch
        {
            return null; // 对端 tmp+rename 途中的瞬时点，下一轮再读
        }
    }

    /**
     * 读一个**别人还开着写**的文件（worker.log 就是这样：worker 活着的整个期间都持着句柄）。
     * `File.ReadAllText` 的共享模式是 FileShare.Read，撞上可写的对端就是一个共享冲突；
     * 这里要 FileShare.ReadWrite。宿主侧读 out\worker\<会话>\worker.log 也得用同款共享模式
     * （PowerShell Get-Content / git bash cat 默认就是，不用特别处理）。
     */
    private static string TryReadShared(string path)
    {
        try
        {
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader r = new StreamReader(fs, Encoding.UTF8))
                return r.ReadToEnd();
        }
        catch
        {
            return null;
        }
    }

    private static bool HasExited(WorkerHandle worker)
    {
        if (worker.Process == null) return true;
        return HasExitedProcess(worker.Process);
    }

    private static bool HasExitedProcess(Process process)
    {
        try { return process.HasExited; }
        catch { return true; }
    }

    private static void WaitExit(WorkerHandle worker, int timeoutMs)
    {
        try
        {
            if (worker.Process != null) worker.Process.WaitForExit(timeoutMs);
        }
        catch
        {
            // 已经退出 / 句柄没了：都算等到
        }
    }

    /** taskkill 整棵树（/T 必须有：Edge 的 renderer / gpu 都是 worker 的孙子进程） */
    private static void KillTree(int pid)
    {
        if (pid <= 0) return;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Process killer = Process.Start(info);
            if (killer == null) return;
            // 必须把两个流读干，否则 taskkill 可能卡在写管道上
            killer.StandardOutput.ReadToEnd();
            killer.StandardError.ReadToEnd();
            killer.WaitForExit(15000);
            killer.Dispose();
        }
        catch (Exception ex)
        {
            Program.Log("taskkill " + pid + " 失败：" + ex.Message);
        }
    }

    private static int OwnPid(Process process)
    {
        try { return process.Id; }
        catch { return 0; }
    }

    /** 自己的 exe 路径（worker 用的是同一个 exe） */
    private static string ExecutablePath()
    {
        try
        {
            string path = Assembly.GetExecutingAssembly().Location;
            if (path != null && path.Length > 0) return path;
        }
        catch
        {
            // 退到下一条
        }
        return Process.GetCurrentProcess().MainModule.FileName;
    }

    /**
     * 给 ProcessStartInfo.Arguments 用的 Windows 引号：包一层双引号，并把
     * **紧挨着收尾引号的反斜杠**倍增（cmd 的解析规则）。outDir 在沙箱里是
     * `C:\orbita-out`（没有空格），这一层是给宿主上跑测试 / 换挂载路径留的余量。
     */
    private static string QuoteArg(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                backslashes++;
                sb.Append(c);
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append(c);
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static string Fail(string message)
    {
        return new JObj().Bool("ok", false).Str("error", message).ToString();
    }

    // ── worker 入口：`--cdp-worker <outDir> <session>` ─────────────────────────

    internal static int RunWorker(string outDir, string session, bool testHooks, int parentPid, string cmdDir)
    {
        WorkerRuntime runtime = new WorkerRuntime(outDir, session, testHooks, parentPid, cmdDir);
        return runtime.Run();
    }

    /**
     * worker 进程本体。**只服务一个会话**：一个 CdpSession（一个 Edge）、一条命令流。
     *
     * 父进程（主桥）退出就跟着退：桥被换掉 / 沙箱收尾时不该留一个永远轮询的孤儿进程
     * （宿主上跑测试时尤其明显——一个孤儿的 out 目录可能已经被删了）。
     */
    private sealed class WorkerRuntime
    {
        private readonly string _outDir;
        private readonly string _key;
        private readonly string _dir;
        private readonly string _cmdDir;
        private readonly bool _testHooks;
        private readonly int _parentPid;
        private CdpSession _cdp;
        private int _polls = 0;

        internal WorkerRuntime(string outDir, string session, bool testHooks, int parentPid, string cmdDir)
        {
            _outDir = outDir;
            _key = CdpSessions.SafeSessionId(session);
            _dir = Path.Combine(outDir, WorkerDirName, _key);
            // 老主桥不带 --worker-cmd-dir：回落到 0.7.x 的位置（部署错配时仍能干活）
            _cmdDir = cmdDir != null && cmdDir.Trim().Length > 0 ? cmdDir : Path.Combine(_dir, "cmd");
            _testHooks = testHooks;
            _parentPid = parentPid;
        }

        internal int Run()
        {
            try
            {
                Directory.CreateDirectory(_cmdDir);
            }
            catch (Exception ex)
            {
                Program.Log("worker 命令目录建不起来（" + _cmdDir + "）：" + ex.Message);
                return 1;
            }
            _cdp = new CdpSession(_key);
            WriteInfo();
            // 开局一行心跳：它同时是「worker.log 真的落在了宿主读得到的地方」的看门狗
            Program.Log("worker 启动：会话 " + _key + "，pid " + Process.GetCurrentProcess().Id
                + "，命令目录 " + _cmdDir + (_testHooks ? "（test-hooks）" : ""));

            int next = 1;
            while (true)
            {
                bool stop = false;
                bool processed = false;
                try
                {
                    string expected = Path.Combine(_cmdDir, WorkerBase(_key, next) + ReqSuffix);
                    if (File.Exists(expected)) processed = ProcessOne(expected, ref stop);
                    if (!processed)
                    {
                        _polls++;
                        if (_polls % AlignEveryPolls == 0) Align(ref next, ref stop);
                        if (!stop && _parentPid > 0 && _polls % ParentCheckPolls == 0 && ParentGone())
                        {
                            Program.Log("worker 的父进程（pid " + _parentPid + "）已经退出，跟着退出");
                            break;
                        }
                        if (!stop) Thread.Sleep(WorkerPollIntervalMs);
                    }
                    else
                    {
                        next++;
                    }
                }
                catch (Exception ex)
                {
                    // 单轮失败不许弄死 worker（映射目录抖动等），记下继续
                    Program.Log("worker 轮询异常（会话 " + _key + "）：" + ex.Message);
                    Thread.Sleep(WorkerPollIntervalMs);
                }
                if (stop) break;
            }

            // 停之前把自己起的那个 Edge 收掉（taskkill 只认它自己记的 pid）
            _cdp.Shutdown();
            Program.Log("worker 退出：会话 " + _key);
            return 0;
        }

        private void WriteInfo()
        {
            StringBuilder json = new StringBuilder("{");
            json.Append("\"pid\":").Append(Process.GetCurrentProcess().Id);
            json.Append(",\"session\":").Append(Program.JsonQuote(_key));
            json.Append(",\"startedAt\":").Append(Program.JsonQuote(DateTime.UtcNow.ToString("o")));
            json.Append("}");
            Program.AtomicWrite(Path.Combine(_dir, "worker.json"), Encoding.UTF8.GetBytes(json.ToString()));
            Program.Log("worker 已就绪：会话 " + _key + "，pid " + Process.GetCurrentProcess().Id + "，命令目录 " + _cmdDir);
        }

        /** 处理一个请求：读 → 执行 → 写 resp → 删 req。读不到就留给下一轮（静默） */
        private bool ProcessOne(string reqPath, ref bool stop)
        {
            string name = Path.GetFileName(reqPath);
            string baseName = name.Substring(0, name.Length - ReqSuffix.Length);
            // 计量：只服务日志，一段都不进控制流（时钟与方法见 Program 的文件往返计量）
            Stopwatch clock = Stopwatch.StartNew();
            DateTime reqMtimeUtc = DateTime.MinValue;
            try { reqMtimeUtc = File.GetLastWriteTimeUtc(reqPath); }
            catch { }
            DateTime seenUtc = DateTime.UtcNow;
            long mtimeQueryMs = clock.ElapsedMilliseconds;
            string raw;
            try
            {
                raw = File.ReadAllText(reqPath, Encoding.UTF8);
            }
            catch
            {
                return false; // 对端 rename 途中的瞬时点，下轮再来
            }
            long readMs = clock.ElapsedMilliseconds - mtimeQueryMs;

            long execStartMs = clock.ElapsedMilliseconds;
            string command = Program.ExtractString(raw, "command");
            string resp;
            if (command == null)
            {
                resp = Fail("请求里缺 command 字段");
            }
            else if (command == "worker-ping")
            {
                resp = new JObj().Bool("ok", true).Str("session", _key)
                    .Num("pid", Process.GetCurrentProcess().Id).ToString();
            }
            else if (command == "worker-stop")
            {
                // 先写回执再收尾：主桥看到 ok 就知道「它收到了」，进程退出另有等待
                resp = new JObj().Bool("ok", true).Str("session", _key).ToString();
                stop = true;
            }
            else if (command == "worker-hang")
            {
                // 测试缝：睡足 60s，用来证明主桥会到点杀掉整个 worker
                if (!_testHooks)
                {
                    resp = Fail("未知命令：worker-hang");
                }
                else
                {
                    Program.Log("worker 收到 worker-hang：故意睡 60 秒（测试缝）");
                    Thread.Sleep(60000);
                    resp = new JObj().Bool("ok", true).ToString();
                }
            }
            else if (command == "cdp-stop")
            {
                // 主桥会把 cdp-stop 自己接住（它还要删 profile），真落到这里也把话说对：
                // 停掉自己的 Edge、写完回执就退，只留一个没人管的 worker 比报错更糟
                _cdp.Shutdown();
                resp = new JObj().Bool("ok", true).Str("session", _key).ToString();
                stop = true;
            }
            else if (command.Length > 4 && command.Substring(0, 4) == "cdp-")
            {
                resp = _cdp.Execute(command, raw, baseName, _cmdDir);
                // 起不来（找不到 msedge / 端口没开 / 测试缝）的会话不占着 worker：
                // 与 0.6.0 一致——启动失败不占名额，下一次命令要能重新试
                if (command == "cdp-start" && !_cdp.HasLiveProcess()) stop = true;
            }
            else
            {
                resp = Fail("未知命令：" + command);
            }
            long execMs = clock.ElapsedMilliseconds - execStartMs;

            long persistStartMs = clock.ElapsedMilliseconds;
            Program.AtomicWrite(Path.Combine(_cmdDir, baseName + RespSuffix), Encoding.UTF8.GetBytes(resp));
            long persistMs = clock.ElapsedMilliseconds - persistStartMs;
            try { File.Delete(reqPath); } catch { }
            LogWorkerHop(command, reqMtimeUtc, seenUtc, mtimeQueryMs, readMs, execMs, persistMs);
            return true;
        }

        /**
         * worker 侧的一行耗时：req 看见延迟 / 读 / 执行 / 回执落盘。
         *
         * req 看见延迟用 mtime 法（桥写 req → 本进程看见）：桥与 worker 都在 guest 里，时基相同，
         * 这个差值是可信的。2026-10-25 真机：一条导航宿主量到 2649ms，而 worker 回执里 ms=343
         * ——那 2.3s 只能在这两跳里（桥写 req / worker 写回执），这一行就是来指认到底是哪一跳。
         */
        private void LogWorkerHop(string command, DateTime reqMtimeUtc, DateTime seenUtc, long mtimeQueryMs,
            long readMs, long execMs, long persistMs)
        {
            string seenNote;
            long seenMs = Program.PropagateFromMtime(reqMtimeUtc, seenUtc, out seenNote);
            if (!Program.HopNeedsLog(Program.HopLogLineMs, new long[] { seenMs, readMs, execMs, persistMs })) return;
            StringBuilder sb = new StringBuilder("worker 命令 ").Append(command).Append("：");
            sb.Append("req 看见延迟 ").Append(seenMs >= 0 ? seenMs + "ms" : "未知")
              .Append("（").Append(seenNote).Append("） + 读 ").Append(readMs).Append("ms（mtime 查询 ")
              .Append(mtimeQueryMs).Append("ms） + 执行 ").Append(execMs).Append("ms + 回执落盘 ")
              .Append(persistMs).Append("ms（命令目录 ").Append(_cmdDir).Append("）");
            Program.Log(sb.ToString());
        }

        /**
         * 慢路径对齐：全量枚举一次，把序号拉回真实位置。
         * 与主桥 PollOnce 同一个理由——直探只认「下一个」，跳号时得靠它兜底；
         * 而映射文件夹的**目录枚举**会被 RDP 驱动器重定向缓存卡住（真机实测 20s），
         * 所以它只能当兜底，不能当主路。
         */
        private void Align(ref int next, ref bool stop)
        {
            string[] reqs = Directory.GetFiles(_cmdDir, "*" + ReqSuffix);
            Array.Sort(reqs, StringComparer.Ordinal);
            for (int i = 0; i < reqs.Length; i++)
            {
                bool childStop = false;
                if (!ProcessOne(reqs[i], ref childStop)) continue;
                if (childStop) stop = true;
                string name = Path.GetFileName(reqs[i]);
                // <会话>-cmd-000042.req.json → 序号在倒数第 14..18 位
                int at = name.LastIndexOf("-cmd-", StringComparison.Ordinal);
                int seen;
                if (at >= 0 && name.Length >= at + 5 + 6
                    && int.TryParse(name.Substring(at + 5, 6), out seen) && seen >= next)
                    next = seen + 1;
            }
        }

        private bool ParentGone()
        {
            try
            {
                Process parent = Process.GetProcessById(_parentPid);
                bool gone = parent.HasExited;
                parent.Dispose();
                return gone;
            }
            catch (ArgumentException)
            {
                return true; // 没有这个进程 = 父进程已经不在了
            }
            catch
            {
                return false; // 查询失败（权限等）不当作退出：宁可多活一会儿
            }
        }
    }

    // ── worker 层的自测（`--selftest-worker`，在宿主上跑，不需要沙箱、不碰 Edge）────
    //
    // 为什么必须有一个真跑进程的自测：这一层的能力全部是「进程能起、能被杀、崩了能再起」，
    // 纯函数测不到。用例只碰 worker 自己的 exe 与临时目录：
    //   ① 拉起 worker 并应答 worker-ping（worker.json 的 pid 就是回执里的那个）
    //   ② 转发超时 → worker 真的被杀（worker-hang 睡 60s，主桥 2.5s 就动手）
    //   ③ worker 崩了 → 下一条命令重新拉起（新 pid）
    //   ④ worker-stop → worker 自己退出（不靠 taskkill）
    //   ⑤ 没有 worker 时汇总 cdp-status 只回 0 个、不拉进程
    // 全程不启动 Edge（子桥带 --no-browser）。

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        string tmp = Path.Combine(Path.GetTempPath(), "orbita-worker-selftest-" + Guid.NewGuid().ToString("N"));
        string cmdDir = Path.Combine(tmp, "cmd");
        Process bridge = null;
        StringBuilder childLog = new StringBuilder();

        try
        {
            Directory.CreateDirectory(cmdDir);
            ProcessStartInfo info = new ProcessStartInfo(ExecutablePath(),
                "--out-dir " + QuoteArg(tmp) + " --no-browser --test-hooks");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            bridge = Process.Start(info);
            if (bridge == null)
            {
                Program.CheckTrue(failures, ref cases, "子桥能起来", false);
                return Finish(failures, cases);
            }
            // 子桥的日志要读干（不读会卡住它的 stdout 管道），但不能混进本进程的 JSON 输出
            DataReceivedEventHandler collect = delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (childLog) childLog.AppendLine(e.Data);
            };
            bridge.OutputDataReceived += collect;
            bridge.ErrorDataReceived += collect;
            bridge.BeginOutputReadLine();
            bridge.BeginErrorReadLine();

            if (!WaitForFile(Path.Combine(tmp, "bridge.json"), 15000))
            {
                Program.CheckTrue(failures, ref cases, "子桥通告 bridge.json", false);
                return Finish(failures, cases);
            }
            Program.CheckTrue(failures, ref cases, "子桥通告 bridge.json", true);

            int seq = 0;
            string ping1 = Ask(cmdDir, ref seq, "{\"command\":\"worker-ping\",\"session\":\"st\"}");
            int pid1 = ReadWorkerPid(tmp, "st");
            Program.CheckTrue(failures, ref cases, "① worker 被拉起并应答 worker-ping",
                ping1 != null && ping1.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "① worker.json 通告了 pid（之后只按它杀）", pid1 > 0);
            Program.CheckTrue(failures, ref cases, "① 回执里的会话就是转过去的那个",
                ping1 != null && ping1.IndexOf("\"session\":\"st\"", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "① 回执里的 pid 与 worker.json 一致",
                ping1 != null && ping1.IndexOf("\"pid\":" + pid1, StringComparison.Ordinal) >= 0);

            // ①' worker 自己的日志必须落在映射目录里（2026-10-25 真机：worker 的话一行都没人收，
            // 导致「错误页取不到正文」猜了三轮）。这里在 worker 还活着、句柄还开着的时候读——
            // 宿主就是这么读的（FileShare.ReadWrite）。
            string workerLogPath = Path.Combine(tmp, WorkerDirName, "st", "worker.log");
            string workerLog = TryReadShared(workerLogPath);
            Program.CheckTrue(failures, ref cases, "①' worker 日志落在 out\\worker\\<会话>\\worker.log（宿主读得到）",
                workerLog != null && workerLog.IndexOf("worker 启动：会话 st", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "①' 日志行带时间与 [bridge] 前缀（与 bridge.log 同款）",
                workerLog != null && workerLog.IndexOf("[bridge]", StringComparison.Ordinal) >= 0);

            // ② 超时：主桥到点 taskkill（CommandTimeoutMs 在 --test-hooks 下是 2.5s）
            string hang = Ask(cmdDir, ref seq, "{\"command\":\"worker-hang\",\"session\":\"st\"}");
            Program.CheckTrue(failures, ref cases, "② 超时回执是「没有响应（<命令> 超时）」并给出下一步",
                hang != null && hang.IndexOf("没有响应（worker-hang 超时）", StringComparison.Ordinal) >= 0
                && hang.IndexOf("cdp-status", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "② 超时的 worker 进程已被杀掉", !ProcessAlive(pid1));

            // ③ 崩溃 + 重启：先确认超时后能拉起新的，再把它打死，看下一条还能拉起
            string ping2 = Ask(cmdDir, ref seq, "{\"command\":\"worker-ping\",\"session\":\"st\"}");
            int pid2 = ReadWorkerPid(tmp, "st");
            Program.CheckTrue(failures, ref cases, "③ 超时之后的下一条命令拉起了新 worker",
                ping2 != null && pid2 > 0 && pid2 != pid1);
            KillTree(pid2);
            Program.CheckTrue(failures, ref cases, "③ 模拟崩溃：worker 进程确实退出了", !ProcessAlive(pid2));
            string ping3 = Ask(cmdDir, ref seq, "{\"command\":\"worker-ping\",\"session\":\"st\"}");
            int pid3 = ReadWorkerPid(tmp, "st");
            Program.CheckTrue(failures, ref cases, "③ 崩溃之后仍然能重新拉起",
                ping3 != null && pid3 > 0 && pid3 != pid2);

            // ④ worker-stop：它自己退出（不是被 taskkill 带走的）
            string stop = Ask(cmdDir, ref seq, "{\"command\":\"worker-stop\",\"session\":\"st\"}");
            Thread.Sleep(1000);
            Program.CheckTrue(failures, ref cases, "④ worker-stop 回 ok",
                stop != null && stop.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "④ worker 自己退出了", !ProcessAlive(pid3));

            // ⑤ 没有 worker 的汇总 status：0 个会话，且**不拉**新进程
            string status = Ask(cmdDir, ref seq, "{\"command\":\"cdp-status\"}");
            Program.CheckTrue(failures, ref cases, "⑤ 没有 worker 时汇总 status = 0 个会话",
                status != null && status.IndexOf("\"count\":0", StringComparison.Ordinal) >= 0);
            Program.CheckTrue(failures, ref cases, "⑤ 汇总 status 不拉起新 worker", ReadWorkerPid(tmp, "st") == 0);

            // ⑥ 超时杀掉 worker 之后重开同一个会话：**旧的 DevToolsActivePort 不许被复用**。
            //
            // 真机事故（2026-10-25）：40s 超时杀 worker 只杀进程树、不删 profile（故意的，
            // 登录态要留），于是 <profile>\DevToolsActivePort 里还留着上一只 Edge 的端口；
            // 新 Edge 起来后 WaitForPortFile 一进循环就看见「文件已存在」立刻回 true，
            // 把旧端口当成新端口 → cdp-start 回「Unable to connect to the remote server」。
            // 这一段只验纯函数（删旧文件 / 解析端口），**不启动任何 Edge**。
            string profileDir = Path.Combine(tmp, "profile", "wa");
            Directory.CreateDirectory(profileDir);
            string portPath = Path.Combine(profileDir, "DevToolsActivePort");
            Program.AtomicWrite(portPath, Encoding.UTF8.GetBytes("50000\n/devtools/browser/old-dead-edge"));
            Program.CheckTrue(failures, ref cases, "⑥ 端口文件能解析出上一只 Edge 的端口",
                CdpSession.ParsePortFileContent("50000\n/devtools/browser/old-dead-edge") == 50000);
            Program.CheckTrue(failures, ref cases, "⑥ 端口文件是垃圾时解析成 0（不猜）",
                CdpSession.ParsePortFileContent("not-a-port\n/x") == 0
                && CdpSession.ParsePortFileContent("") == 0
                && CdpSession.ParsePortFileContent(null) == 0);
            Program.CheckTrue(failures, ref cases, "⑥ 起 Edge 前旧端口文件被清掉（不复用旧端口）",
                CdpSession.ClearStalePortFile(profileDir) && !File.Exists(portPath));
            Program.CheckTrue(failures, ref cases, "⑥ 清第二次也是成功（幂等：文件本来就不在了）",
                CdpSession.ClearStalePortFile(profileDir));
            Program.CheckTrue(failures, ref cases, "⑥ 清掉之后读不出任何端口（新 Edge 写的才是真值）",
                CdpSession.ParsePortFileContent(TryReadText(portPath)) == 0);

            // ⑦ --worker-cmd-dir：worker 只认主桥给的那一个目录。
            //
            // 真机上主桥会把这一跳放到 guest 本地盘（C:\orbita-browser\worker\<键>），
            // 避开映射文件夹的元数据缓存；自测里换成另一个临时目录，证明的是同一件事：
            // **命令从给定目录进、回执往给定目录出**，而 out\worker\<键>\cmd 一个字都不写。
            // 这一段起的是真 worker 进程（--no-browser，不碰 Edge），不经过主桥。
            string altCmdDir = Path.Combine(tmp, "alt-local", "st");
            Directory.CreateDirectory(altCmdDir);
            Process alt = null;
            try
            {
                ProcessStartInfo altInfo = new ProcessStartInfo(ExecutablePath(),
                    "--cdp-worker " + QuoteArg(tmp) + " st --no-browser --test-hooks"
                    + " --worker-cmd-dir " + QuoteArg(altCmdDir));
                altInfo.UseShellExecute = false;
                altInfo.CreateNoWindow = true;
                altInfo.RedirectStandardOutput = true;
                altInfo.RedirectStandardError = true;
                alt = Process.Start(altInfo);
                if (alt != null)
                {
                    // 两个流都要读干（不读会卡住子进程的管道）
                    alt.BeginOutputReadLine();
                    alt.BeginErrorReadLine();
                }
                bool up = alt != null && WaitForFile(Path.Combine(tmp, WorkerDirName, "st", "worker.json"), 15000);
                Program.CheckTrue(failures, ref cases, "⑦ 给了 --worker-cmd-dir 也能起来（worker.json 照旧在 out\\worker\\<会话>）", up);
                string altName = "st-cmd-000001";
                Program.AtomicWrite(Path.Combine(altCmdDir, altName + ReqSuffix),
                    Encoding.UTF8.GetBytes("{\"command\":\"worker-ping\",\"session\":\"st\"}"));
                bool answered = WaitForFile(Path.Combine(altCmdDir, altName + RespSuffix), 15000);
                string altResp = answered ? TryReadText(Path.Combine(altCmdDir, altName + RespSuffix)) : null;
                Program.CheckTrue(failures, ref cases, "⑦ 命令从给定的命令目录进、回执也写回那里",
                    altResp != null && altResp.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0);
                Program.CheckTrue(failures, ref cases, "⑦ 映射目录下那个 cmd\\ 没被用来收命令",
                    !File.Exists(Path.Combine(tmp, WorkerDirName, "st", "cmd", altName + ReqSuffix))
                    && !File.Exists(Path.Combine(tmp, WorkerDirName, "st", "cmd", altName + RespSuffix)));
            }
            finally
            {
                if (alt != null)
                {
                    try { if (!alt.HasExited) alt.Kill(); } catch { }
                    try { alt.WaitForExit(5000); } catch { }
                    try { alt.Dispose(); } catch { }
                }
            }

            // ⑧ 搬图只看 resp：不产图的命令一步都不走。
            //
            // 真机 2026-10-25：这里原来对每条命令都无条件等一张只有 cdp-shot 才会产生的 jpg，
            // 于是 cdp-start / cdp-nav / cdp-status 全部白付 2 秒（日志里「搬图 2057ms」）。
            // 这两条断言钉的是「判据是 resp 字段」与「命中就立刻 copy、名字不变」。
            string sibWorkerDir = Path.Combine(tmp, "sib-worker");
            string sibHostDir = Path.Combine(tmp, "sib-host");
            Directory.CreateDirectory(sibWorkerDir);
            Directory.CreateDirectory(sibHostDir);
            string noJpegResp = "{\"ok\":true,\"session\":\"st\",\"url\":\"https://example.com/\"}";
            long idleCopyMs = CopySiblingFileIfAny(sibWorkerDir, sibHostDir, noJpegResp, "st-cmd-000009");
            Program.CheckTrue(failures, ref cases, "⑧ 回执里没有 jpeg：搬图 0ms（不再白等 2s 窗口）",
                idleCopyMs < 50);
            Program.CheckTrue(failures, ref cases, "⑧ 回执里没有 jpeg：宿主目录里什么都没多出来",
                Directory.GetFiles(sibHostDir).Length == 0);
            Program.CheckTrue(failures, ref cases, "⑧ 空 jpeg 字段 / 缺 resp 也算没有图",
                CopySiblingFileIfAny(sibWorkerDir, sibHostDir, "{\"ok\":true,\"jpeg\":\"\"}", "st-cmd-000009") == 0
                && CopySiblingFileIfAny(sibWorkerDir, sibHostDir, null, "st-cmd-000009") == 0
                && Directory.GetFiles(sibHostDir).Length == 0);

            byte[] jpegBytes = new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9 };
            string shotBase = "st-cmd-000010";
            File.WriteAllBytes(Path.Combine(sibWorkerDir, shotBase + ShotSuffix), jpegBytes);
            string shotResp = "{\"ok\":true,\"jpeg\":\"" + shotBase + ".jpg\",\"width\":640}";
            long shotCopyMs = CopySiblingFileIfAny(sibWorkerDir, sibHostDir, shotResp, shotBase);
            string shotDst = Path.Combine(sibHostDir, shotBase + ShotSuffix);
            byte[] copied = File.Exists(shotDst) ? File.ReadAllBytes(shotDst) : new byte[0];
            bool sameBytes = copied.Length == jpegBytes.Length;
            for (int i = 0; sameBytes && i < jpegBytes.Length; i++)
            {
                if (copied[i] != jpegBytes[i]) sameBytes = false;
            }
            Program.CheckTrue(failures, ref cases, "⑧ cdp-shot 的 jpg 仍被搬回宿主目录（名字不变、内容一致）",
                File.Exists(shotDst) && sameBytes);
            Program.CheckTrue(failures, ref cases, "⑧ 图已经在时一次就命中（不等窗口）", shotCopyMs < 500);
        }
        catch (Exception ex)
        {
            Program.CheckTrue(failures, ref cases, "自测本身不抛异常（" + ex.Message + "）", false);
        }
        finally
        {
            if (bridge != null)
            {
                try { if (!bridge.HasExited) bridge.Kill(); } catch { }
                try { bridge.WaitForExit(5000); } catch { }
                try { bridge.Dispose(); } catch { }
            }
            // 兜底：子桥万一没把 worker 收掉，按 worker.json 的 pid 逐个清（只认自己写的 pid）
            KillWorkersUnder(tmp);
            try { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); } catch { }
        }

        return Finish(failures, cases);
    }

    private static int Finish(List<string> failures, int cases)
    {
        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    /** 写一条命令进主命令目录并等回执（自测里扮演宿主） */
    private static string Ask(string cmdDir, ref int seq, string body)
    {
        seq++;
        string name = "cmd-" + seq.ToString("000000");
        Program.AtomicWrite(Path.Combine(cmdDir, name + ReqSuffix), Encoding.UTF8.GetBytes(body));
        if (!WaitForFile(Path.Combine(cmdDir, name + RespSuffix), 30000)) return null;
        return TryReadText(Path.Combine(cmdDir, name + RespSuffix));
    }

    private static bool WaitForFile(string path, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (File.Exists(path)) return true;
            Thread.Sleep(100);
        }
        return File.Exists(path);
    }

    private static int ReadWorkerPid(string outDir, string key)
    {
        string text = TryReadText(Path.Combine(outDir, WorkerDirName, key, "worker.json"));
        if (text == null) return 0;
        string pidText = Program.ExtractNumber(text, "pid");
        int pid;
        if (pidText == null || !int.TryParse(pidText, out pid) || pid <= 0) return 0;
        return pid;
    }

    private static bool ProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            Process p = Process.GetProcessById(pid);
            bool alive = !p.HasExited;
            p.Dispose();
            return alive;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch
        {
            return false;
        }
    }

    /** 清掉一个临时 out 目录下所有 worker（pid 只从它自己写的 worker.json 来） */
    private static void KillWorkersUnder(string outDir)
    {
        string root = Path.Combine(outDir, WorkerDirName);
        try
        {
            if (!Directory.Exists(root)) return;
            foreach (string dir in Directory.GetDirectories(root))
            {
                int pid = ReadWorkerPid(outDir, Path.GetFileName(dir));
                if (pid > 0) KillTree(pid);
            }
        }
        catch
        {
            // 清理失败不影响结论（临时目录在系统 temp 下）
        }
    }
}
