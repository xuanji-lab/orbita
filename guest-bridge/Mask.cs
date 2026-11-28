// Mask.cs —— 密码框遮罩（桥 0.12.0）：截图出图之前把密码框涂黑。
//
// 要解决的场景：用户让 agent「登录这个网站」，agent 截一张图看一眼；页面上密码框里已经有
// 用户打进去的内容（或者用户正在打）。这张图会作为图片块进模型上下文——**密码不该进模型
// 上下文**。所以两条车道（screenshot 整桌面 / win-shot 按窗口）在出图之前，把密码框矩形涂黑。
//
// 数据从哪来：uia-list 本来就在遍历控件树，顺手读 UIA_IsPasswordPropertyId（30019）并把
// 每个密码控件的 BoundingRectangle 记进进程内的缓存（按 hwnd 索引）。**截图路径绝不重新
// 遍历控件树**：一轮 Descendants 遍历要几十到几百毫秒（跨进程 COM），而截图是每次动作之后
// 都要发一条的高频命令；把 UIA 遍历塞进截图路径等于让「看一眼」变慢一个数量级。
//
// 缓存过期策略（CacheMaxAgeMs = 30s）：过期就不遮，但回执里必须说清楚「这次没遮」——
// 让模型以为遮了比不遮更坏：它会放心地把图当成「已经安全的图」继续用。回执字段
// （maskedRegions / maskListed / maskStale / maskCacheAgeMs）在宿主上翻成一句人话。
//
// ── 坐标系（这一节是全部正确性所在，改之前先读完）────────────────────────────
//   · UIA 的 BoundingRectangle 是**物理像素**（UIA 永远按物理像素报，与 DPI 缩放无关）；
//   · 桥进程启动时调过 SetProcessDPIAware（Program.Main），所以 GetSystemMetrics /
//     CopyFromScreen / PrintWindow 拿到的也是**物理像素**；
//   · 于是两者**同一坐标系，绝对不做 DPI 换算**（没有 /96*scale 这种乘法）。谁在中间
//     加了一次缩放，遮罩块就会整体偏移——偏移量随 DPI 变，只有在 100% 缩放的机器上
//     恰好对，这正是最难被本地测试发现的一类错。
//   · 唯一的坐标变换是**平移**：整桌面截图的图像原点 = 屏幕原点 (0,0)；按窗口截图的
//     图像原点 = 那个窗口（PrintWindow 的 PW_CLIENTONLY 回退路径下是客户区）的屏幕原点。
//     平移是整数减法，不是缩放。
//   · 向外扩 PaddingPx 个**物理像素**：焦点框 / 抗锯齿的边缘可能落在控件矩形之外一点，
//     留 2px 是安全的（涂黑多一点只会少给模型 2px 的像素信息）。
//
// 纯函数部分（平移 / 裁剪 / 计划 / 归属判定）由 --selftest-mask 覆盖，不碰桌面、不碰 Bitmap。
// 注意：csc.exe v4.0.30319 是 C# 5 编译器，禁止字符串插值 / ?. / out var / using 声明。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;

/** 一个矩形（物理像素）。MaskRect 而不是 System.Drawing.Rectangle：那个的可变性与语义都不合用 */
internal sealed class MaskRect
{
    public int X;
    public int Y;
    public int W;
    public int H;

    public MaskRect()
    {
    }

    public MaskRect(int x, int y, int w, int h)
    {
        X = x;
        Y = y;
        W = w;
        H = h;
    }
}

/**
 * 缓存里的一条：某个窗口最近一次 uia-list 看到的密码框矩形 + 那份清单的年龄。
 * AgeMs 由取用时算（缓存本身只存 tick），这样「过期」这件事只有一个判据。
 *
 * `Title` 是**记这份清单时**那个窗口的标题（GetWindowText，与截图时读的同一个来源）：
 * 桌面截图把矩形画在屏幕坐标上，如果这中间页面已经换了（浏览器同一窗口换了标签页 / 导航），
 * 旧矩形就会把新内容罩住——标题变了就说明「这份清单说的已经不是屏幕上那一页了」。
 */
internal sealed class MaskCacheEntry
{
    public long Hwnd;
    public List<MaskRect> Rects = new List<MaskRect>();
    public int AgeMs;
    public string Title = "";
}

/**
 * 一个「可能是密码框」的控件：**稳定身份** + 矩形 + 本轮 uia-list 里它还是不是密码框。
 *
 * 为什么要身份：站点点「显示密码」只把 `type` 翻成 text，UIA 的 IsPassword 跟着变 false，
 * 但控件还是同一个控件。按「当前是不是 IsPassword」记缓存，翻转之后就再也不遮了。
 * 身份优先用 RuntimeId（Chromium 给），没有就 AutomationId，都没有才退化到矩形重合
 * （取舍见 SameControl）。
 */
internal sealed class MaskCandidate
{
    /** UIA RuntimeId（强身份，例如 "42.1234.5"）；取不到为空串 */
    public string RuntimeId = "";
    /** UIA AutomationId（弱一点，但通常页内唯一）；取不到为空串 */
    public string AutomationId = "";
    public MaskRect Rect = new MaskRect();
    /** 本轮 uia-list 里它还是密码框吗（false 也可能是「曾经是」——由 MergeCandidates 定） */
    public bool IsPassword;
}

/**
 * 一次截图的遮罩结果（回执字段与它一一对应：maskedRegions / maskListed / maskStale /
 * maskCacheAgeMs）。纯数据，selftest 直接逐字段比较。
 */
internal sealed class MaskPlan
{
    /** 涂黑计划（已经平移成图像坐标、已经裁剪到图像范围内、已经加过 padding） */
    public List<MaskRect> Rects = new List<MaskRect>();
    /** 有没有可用的控件清单（false = 从没做过 uia-list，我们根本不知道密码框在哪） */
    public bool Listed;
    /** 有清单但**全部过期**（这张图没遮，宿主必须告诉模型） */
    public bool Stale;
    /** 最近一份清单的年龄（毫秒；-1 = 没有任何清单） */
    public int AgeMs = -1;
    /**
     * 有清单、也没过期，但这些矩形被「可见性 / 页面已换」两道闸挡掉了几个。
     * 只进日志（现场排查要能回答「为什么这一张没遮」），不进回执——模型看到的
     * 「0 个密码框」已经是实话。
     */
    public int Hidden;
}

internal static class Mask
{
    // ---- 阈值（依据写在旁边，改之前先想清楚后果）----------------------------

    /**
     * 缓存过期线。取 30s：模型的动作节奏通常是「uia-list → 动作 → 截图 → 动作」，
     * 一轮下来在几秒内；30s 足够跨过两次慢命令（UIA 看门狗 5s + 截图），又不至于把
     * 「十分钟前那个页面」的密码框位置拿来遮现在的屏幕（页面早换了）。
     */
    internal const int CacheMaxAgeMs = 30000;

    /**
     * 向外扩的物理像素。焦点框 / 抗锯齿 / 一点点亚像素渲染都可能落在 UIA 报的矩形之外；
     * 多遮 2px 的代价是少给模型 2px 的像素信息，漏 1px 的代价是密码的一个笔画进模型上下文。
     */
    internal const int PaddingPx = 2;

    /**
     * 「用户此刻在不在打字」的判定窗：与 InputHook.PresenceLookbackMs 同一个数字（400ms），
     * 直接引用那份常量——两处各写一个 400，改了一处忘了另一处就是两个语义不同的 400。
     */
    internal const int UserTypingWindowMs = InputHook.PresenceLookbackMs;

    // ---- 纯函数 ------------------------------------------------------------

    /** 深拷贝一份矩形列表（缓存不许被调用方改到；测试也用它造输入） */
    internal static List<MaskRect> CopyOf(List<MaskRect> rects)
    {
        List<MaskRect> copy = new List<MaskRect>();
        if (rects == null) return copy;
        for (int i = 0; i < rects.Count; i++)
        {
            MaskRect r = rects[i];
            copy.Add(new MaskRect(r.X, r.Y, r.W, r.H));
        }
        return copy;
    }

    /**
     * 屏幕坐标 → 图像坐标：**只做整数减法**，不缩放（理由见文件头「坐标系」）。
     * 整桌面截图传 (0, 0)；按窗口截图传那个窗口的屏幕原点。
     */
    internal static List<MaskRect> Translate(List<MaskRect> rects, int originX, int originY)
    {
        List<MaskRect> moved = new List<MaskRect>();
        if (rects == null) return moved;
        for (int i = 0; i < rects.Count; i++)
        {
            MaskRect r = rects[i];
            moved.Add(new MaskRect(r.X - originX, r.Y - originY, r.W, r.H));
        }
        return moved;
    }

    /**
     * 加 padding + 裁剪到图像范围内（**纯函数**：输入输出都是整数矩形，不碰 Bitmap）。
     *   · 宽高 <= 0 的矩形直接丢（UIA 对不可见控件会报空矩形）；
     *   · 裁剪后为空的丢（完全在图外——窗口被移走了 / 控件在被滚动出视口的容器里）；
     *   · 越界部分是**裁掉**而不是跳过整块：半露的密码框照样得遮住露出来的那半。
     */
    internal static List<MaskRect> Clip(int imageWidth, int imageHeight, List<MaskRect> rects)
    {
        List<MaskRect> clipped = new List<MaskRect>();
        if (rects == null || imageWidth <= 0 || imageHeight <= 0) return clipped;
        for (int i = 0; i < rects.Count; i++)
        {
            MaskRect r = rects[i];
            if (r.W <= 0 || r.H <= 0) continue;
            int left = r.X - PaddingPx;
            int top = r.Y - PaddingPx;
            int right = r.X + r.W + PaddingPx;
            int bottom = r.Y + r.H + PaddingPx;
            if (left < 0) left = 0;
            if (top < 0) top = 0;
            if (right > imageWidth) right = imageWidth;
            if (bottom > imageHeight) bottom = imageHeight;
            if (right <= left || bottom <= top) continue;
            clipped.Add(new MaskRect(left, top, right - left, bottom - top));
        }
        return clipped;
    }

    /**
     * 一次截图的涂黑计划（**纯函数**：不碰缓存、不碰 Bitmap、不碰时钟）。
     *
     * entries 是「某个窗口最近一次 uia-list 的密码框矩形」（屏幕坐标）+ 年龄；
     * 整桌面截图传所有窗口，按窗口截图只传那一个窗口。规则：
     *   · 新鲜的（0 <= age <= maxAgeMs）→ 平移 + 裁剪 → 进涂黑计划；
     *   · 过期的**一个都不用**（页面可能早换了，拿旧位置遮新屏幕会遮住无关内容还说不出为什么）；
     *   · 有新鲜清单但里面没有密码框（Rects 空）→ Listed=true、Rects 空 = 「看过，没有密码框」；
     *   · 全都过期 → Stale=true、Listed=false、AgeMs=最年轻那份的年龄。
     */
    internal static MaskPlan Plan(int imageWidth, int imageHeight, int originX, int originY,
        List<MaskCacheEntry> entries, int maxAgeMs)
    {
        MaskPlan plan = new MaskPlan();
        if (entries == null || entries.Count == 0) return plan;
        bool anyFresh = false;
        bool anyEntry = false;
        int youngest = -1;
        for (int i = 0; i < entries.Count; i++)
        {
            MaskCacheEntry entry = entries[i];
            if (entry == null) continue;
            anyEntry = true;
            if (youngest < 0 || entry.AgeMs < youngest) youngest = entry.AgeMs;
            bool fresh = entry.AgeMs >= 0 && entry.AgeMs <= maxAgeMs;
            if (!fresh) continue;
            anyFresh = true;
            plan.Rects.AddRange(Clip(imageWidth, imageHeight, Translate(entry.Rects, originX, originY)));
        }
        if (anyEntry) plan.AgeMs = youngest;
        plan.Listed = anyFresh;
        plan.Stale = anyEntry && !anyFresh;
        return plan;
    }

    /**
     * 「用户此刻在不在打字」（**纯函数**）：桥的 input-status 里 lastRealAgeMs < 400ms 就算在打。
     * -1（从未观测到真实输入）不是「在打」——钩子没装上 / 桌面一直没人碰，两种都不该记成 true。
     */
    internal static bool UserTyping(long ageMs)
    {
        return ageMs >= 0 && ageMs < UserTypingWindowMs;
    }

    /**
     * 「屏幕上这一点现在是不是属于这个窗口」。**注入给纯函数**：
     * 生产实现是 WindowFromPoint + GetAncestor，自测用假函数，不碰桌面。
     */
    internal delegate bool PointOwnedByFn(long hwnd, int x, int y);

    /**
     * 两个框的重合度（交面积 / 较小那个的面积）。**纯函数**。
     * 用 min 而不是并集：同一个框被滚动 / 布局抖动稍微改了尺寸时，只要小的那个基本被
     * 包含住就算同一个（IoU 对小框抖动太敏感）。
     */
    internal static double OverlapRatio(MaskRect a, MaskRect b)
    {
        if (a == null || b == null) return 0;
        int left = a.X > b.X ? a.X : b.X;
        int top = a.Y > b.Y ? a.Y : b.Y;
        int right = (a.X + a.W) < (b.X + b.W) ? (a.X + a.W) : (b.X + b.W);
        int bottom = (a.Y + a.H) < (b.Y + b.H) ? (a.Y + a.H) : (b.Y + b.H);
        int w = right - left;
        int h = bottom - top;
        if (w <= 0 || h <= 0) return 0;
        long inter = (long)w * h;
        long small = (long)a.W * a.H;
        long other = (long)b.W * b.H;
        if (other < small) small = other;
        if (small <= 0) return 0;
        return (double)inter / small;
    }

    /**
     * 两个候选是不是**同一个控件**（显示密码翻转后靠它把旧身份认回来）。**纯函数**。
     *
     * 优先级（最硬的先）：
     *   ① 两边都有 RuntimeId → 相等才是同一个（不等就不是，**不**回退去比矩形：
     *      同一个位置换了控件是真实的，靠矩形认会把新控件误当成旧密码框）；
     *   ② 两边都有 AutomationId → 相等才算；
     *   ③ 两边都拿不到身份（有些自绘控件就真的没 id）→ 退化到**矩形重合**（>= 60%）。
     *      这一条会误判（同一格子里用户名框换成密码框），但它是「拿不到身份」时仅有的
     *      办法；取舍：宁可多遮一块，不要把可能还含着明文的框放过。
     */
    internal static bool SameControl(MaskCandidate a, MaskCandidate b)
    {
        if (a == null || b == null) return false;
        bool aHasRuntime = a.RuntimeId != null && a.RuntimeId.Length > 0;
        bool bHasRuntime = b.RuntimeId != null && b.RuntimeId.Length > 0;
        if (aHasRuntime && bHasRuntime) return string.Equals(a.RuntimeId, b.RuntimeId, StringComparison.Ordinal);
        bool aHasAuto = a.AutomationId != null && a.AutomationId.Length > 0;
        bool bHasAuto = b.AutomationId != null && b.AutomationId.Length > 0;
        if (aHasAuto && bHasAuto) return string.Equals(a.AutomationId, b.AutomationId, StringComparison.Ordinal);
        return OverlapRatio(a.Rect, b.Rect) >= 0.6;
    }

    /**
     * 把「这一轮 list 到的候选」与「上一轮的候选」合成缓存要记的东西。**纯函数**。
     *
     * 规则：
     *   · 这一轮还是 IsPassword → 留（矩形用**这一轮**的，位置可能变了）；
     *   · 这一轮不是密码框，但上一轮同一个控件是（点过「显示密码」）→ **也留**，位置取这一轮的；
     *   · 其余（新出现的普通输入框 / 上一轮有但这一轮没出现的）→ 不留。
     *
     * 第三类保证了「同一个矩形后来变成普通输入框」不会因为按位置记而被继续遮——除非两边
     * 都拿不到身份（那只能按矩形认，见 SameControl 的取舍）。
     */
    internal static List<MaskCandidate> MergeCandidates(List<MaskCandidate> before, List<MaskCandidate> now)
    {
        List<MaskCandidate> merged = new List<MaskCandidate>();
        if (now == null) return merged;
        for (int i = 0; i < now.Count; i++)
        {
            MaskCandidate candidate = now[i];
            if (candidate == null || candidate.Rect == null) continue;
            bool wasPassword = false;
            if (!candidate.IsPassword && before != null)
            {
                for (int j = 0; j < before.Count; j++)
                {
                    MaskCandidate old = before[j];
                    if (old == null || !old.IsPassword) continue;
                    if (!SameControl(candidate, old)) continue;
                    wasPassword = true;
                    break;
                }
            }
            if (!candidate.IsPassword && !wasPassword) continue;
            MaskCandidate copy = new MaskCandidate();
            copy.RuntimeId = candidate.RuntimeId == null ? "" : candidate.RuntimeId;
            copy.AutomationId = candidate.AutomationId == null ? "" : candidate.AutomationId;
            copy.Rect = new MaskRect(candidate.Rect.X, candidate.Rect.Y, candidate.Rect.W, candidate.Rect.H);
            copy.IsPassword = true; // 进了缓存就是「该遮的」
            merged.Add(copy);
        }
        return merged;
    }

    /**
     * 记清单时的窗口标题与现在的标题是否还能对上（页面换了旧矩形就不能用）。**纯函数**。
     * 任一边读不到标题时一律当「对得上」——读不到不是「换了」的证据，不能据此放掉遮罩。
     */
    internal static bool TitleStillMatches(string recorded, string current)
    {
        if (recorded == null || recorded.Length == 0) return true;
        if (current == null || current.Length == 0) return true;
        return string.Equals(recorded.Trim(), current.Trim(), StringComparison.Ordinal);
    }

    /**
     * 把缓存条目变成「这一张图真的可以涂的矩形」。**纯函数**（可见性用注入的函数）。
     *
     * 两道闸：
     *   ① 页面已换（标题与记清单时不同）→ 整条不算（`hidden` 照实增加）；
     *   ② 桌面截图专用：矩形中心那一点现在不属于这个窗口（被别的窗口盖住了 / 窗口最小化了）
     *      → 这个矩形不算。
     *
     * ② 是那个真实 bug 的修法：整桌面截图会把**所有**窗口缓存的密码框画到屏幕坐标上，
     * 而被遮窗口不在前台时，那些坐标上是别的窗口——黑块就落到无关内容上了。
     * 按窗口截图不传 ②（图就是那个窗口自己的 surface，遮挡与它无关）。
     */
    internal static MaskCacheEntry VisiblePart(MaskCacheEntry entry, string currentTitle,
        PointOwnedByFn pointOwnedBy, out int hidden)
    {
        hidden = 0;
        MaskCacheEntry result = new MaskCacheEntry();
        if (entry == null) return result;
        result.Hwnd = entry.Hwnd;
        result.AgeMs = entry.AgeMs;
        result.Title = entry.Title == null ? "" : entry.Title;
        if (!TitleStillMatches(entry.Title, currentTitle))
        {
            hidden = entry.Rects == null ? 0 : entry.Rects.Count;
            return result;
        }
        if (entry.Rects == null) return result;
        for (int i = 0; i < entry.Rects.Count; i++)
        {
            MaskRect r = entry.Rects[i];
            if (pointOwnedBy != null)
            {
                int cx = r.X + r.W / 2;
                int cy = r.Y + r.H / 2;
                if (!pointOwnedBy(entry.Hwnd, cx, cy))
                {
                    hidden++;
                    continue;
                }
            }
            result.Rects.Add(new MaskRect(r.X, r.Y, r.W, r.H));
        }
        return result;
    }

    /** 候选列表 → 矩形列表（缓存对外只暴露矩形；身份只在合并时用） */
    internal static List<MaskRect> RectsOf(List<MaskCandidate> candidates)
    {
        List<MaskRect> rects = new List<MaskRect>();
        if (candidates == null) return rects;
        for (int i = 0; i < candidates.Count; i++)
        {
            MaskCandidate c = candidates[i];
            if (c == null || c.Rect == null) continue;
            rects.Add(new MaskRect(c.Rect.X, c.Rect.Y, c.Rect.W, c.Rect.H));
        }
        return rects;
    }

    /** 把涂黑计划画到图上（唯一碰 Bitmap 的地方；计划本身仍然是纯的） */
    internal static void Paint(Bitmap bitmap, List<MaskRect> rects)
    {
        if (bitmap == null || rects == null || rects.Count == 0) return;
        Graphics g = Graphics.FromImage(bitmap);
        try
        {
            // 纯黑，不做马赛克 / 模糊：黑块本身就是一个明确的信号（「这里有意遮住了」），
            // 而模糊块在 JPEG 压缩之后可能残留可辨认的形状。
            SolidBrush brush = new SolidBrush(Color.Black);
            try
            {
                for (int i = 0; i < rects.Count; i++)
                {
                    MaskRect r = rects[i];
                    g.FillRectangle(brush, r.X, r.Y, r.W, r.H);
                }
            }
            finally
            {
                brush.Dispose();
            }
        }
        finally
        {
            g.Dispose();
        }
    }

    /**
     * 回执里的五个字段（screenshot 与 win-shot 共用一份拼法：两处各拼一遍迟早拼出两种形状）。
     * 宿主的 parse 按这几个字段名取值，改名字就是两端脱钩。
     */
    internal static string CaptureFields(MaskPlan plan)
    {
        StringBuilder json = new StringBuilder();
        json.Append("\"maskedRegions\":").Append(plan.Rects.Count);
        json.Append(",\"maskListed\":").Append(plan.Listed ? "true" : "false");
        json.Append(",\"maskStale\":").Append(plan.Stale ? "true" : "false");
        json.Append(",\"maskCacheAgeMs\":").Append(plan.AgeMs);
        json.Append(",\"userTyping\":").Append(UserTyping(InputHook.RealInputAgeMs()) ? "true" : "false");
        return json.ToString();
    }

    /** bridge.log 的一行（现场排查要能回答「那张图遮了没有、为什么没遮」） */
    internal static string LogLine(string command, MaskPlan plan)
    {
        if (plan.Rects.Count > 0)
            return command + "：遮住 " + plan.Rects.Count + " 个密码框（清单 " + plan.AgeMs + "ms 前）"
                + (plan.Hidden > 0 ? "；另有 " + plan.Hidden + " 块因被遮挡 / 页面已换未遮" : "");
        if (plan.Stale)
            return command + "：**没有遮罩**——最近一份控件清单已 " + plan.AgeMs + "ms（> " + CacheMaxAgeMs
                + "ms），不知道密码框现在在哪；回执已写明";
        if (!plan.Listed)
            return command + "：" + "没有遮罩——这个窗口没有 uia-list 记录，不知道密码框在哪；回执已写明";
        if (plan.Hidden > 0)
            return command + "：没遮——清单里 " + plan.Hidden + " 个密码框被遮挡或页面已换，一个都不适合涂";
        return command + "：控件清单里没有密码框，无需遮罩";
    }

    // ---- 自测（--selftest-mask：纯函数，不碰桌面、不启进程、不碰 Bitmap）------

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // ① 平移 + padding + 裁剪：界内 / 越界 / 空 / 多个 / 零尺寸 / 全图
        List<MaskRect> plan1 = Clip(1280, 720, Translate(One(100, 200, 300, 40), 0, 0));
        CheckRect(failures, ref cases, "界内矩形：只向外扩 PaddingPx", 98, 198, 304, 44, plan1, 0);
        CheckInt(failures, ref cases, "界内矩形：只有一块", 1, plan1.Count);

        List<MaskRect> leftTop = Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(1, 1, 50, 20) }));
        CheckRect(failures, ref cases, "左上角越界：裁到 0，宽高随之变化", 0, 0, 53, 23, leftTop, 0);

        List<MaskRect> rightBottom = Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(1270, 710, 100, 100) }));
        CheckRect(failures, ref cases, "右下角越界：裁到图宽 / 图高", 1268, 708, 12, 12, rightBottom, 0);

        CheckInt(failures, ref cases, "完全在图右外：丢弃",
            0, Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(2000, 100, 100, 40) })).Count);
        CheckInt(failures, ref cases, "完全在图上方：丢弃",
            0, Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(100, -100, 100, 40) })).Count);
        CheckInt(failures, ref cases, "空列表：回空列表", 0, Clip(1280, 720, new List<MaskRect>()).Count);
        CheckInt(failures, ref cases, "null 列表不炸：回空列表", 0, Clip(1280, 720, null).Count);
        CheckInt(failures, ref cases, "图像尺寸为 0：回空列表",
            0, Clip(0, 0, new List<MaskRect>(new MaskRect[] { new MaskRect(10, 10, 100, 40) })).Count);
        CheckInt(failures, ref cases, "宽为 0 的矩形：丢弃",
            0, Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(10, 10, 0, 40) })).Count);
        CheckInt(failures, ref cases, "负宽的矩形：丢弃",
            0, Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(10, 10, -30, 40) })).Count);

        List<MaskRect> several = Clip(1280, 720, new List<MaskRect>(new MaskRect[] {
            new MaskRect(100, 100, 200, 30),
            new MaskRect(500, 400, 200, 30),
            new MaskRect(3000, 3000, 50, 50),
        }));
        CheckInt(failures, ref cases, "多个矩形：图外的被丢，图内的都留", 2, several.Count);
        CheckRect(failures, ref cases, "多个矩形：第一个的位置", 98, 98, 204, 34, several, 0);
        CheckRect(failures, ref cases, "多个矩形：第二个的位置", 498, 398, 204, 34, several, 1);

        List<MaskRect> whole = Clip(1280, 720, new List<MaskRect>(new MaskRect[] { new MaskRect(-50, -50, 5000, 5000) }));
        CheckRect(failures, ref cases, "整屏越界的矩形：裁成整张图", 0, 0, 1280, 720, whole, 0);

        List<MaskRect> moved = Clip(1280, 720, Translate(One(600, 400, 100, 20), 500, 300));
        CheckRect(failures, ref cases, "窗口内坐标：减掉窗口原点（只平移）", 98, 98, 104, 24, moved, 0);

        List<MaskRect> movedClipped = Clip(640, 480, Translate(One(900, 400, 300, 200), 480, 380));
        CheckRect(failures, ref cases, "平移之后仍越界：按图裁掉", 418, 18, 222, 204, movedClipped, 0);

        // ② DPI：同一组数字换到 200% 缩放的屏上，**一个像素都不许变**
        //    2560×1440 是典型的 200% 屏物理尺寸；如果谁在中间加了 /96*192 之类的缩放，
        //    这里会立刻炸（x 从 1000 变成 2000）。这条断言就是「坐标不换算」的钉子。
        List<MaskRect> hidpi = Clip(2560, 1440, Translate(One(1000, 700, 300, 40), 0, 0));
        CheckRect(failures, ref cases, "200% DPI 屏：坐标不换算（宽度仍是 300+padding）",
            998, 698, 304, 44, hidpi, 0);
        CheckInt(failures, ref cases, "200% DPI 屏：宽度数字逐位相同（304，不是 608）", 304, hidpi[0].W);
        CheckInt(failures, ref cases, "padding 是物理像素常量", 2, PaddingPx);

        // ③ 「用户是不是在打字」
        CheckTrue(failures, ref cases, "从未观测到真实输入（-1）→ 不算在打字", !UserTyping(-1));
        CheckTrue(failures, ref cases, "刚刚（0ms）→ 在打字", UserTyping(0));
        CheckTrue(failures, ref cases, "399ms → 在打字（窗口内）", UserTyping(399));
        CheckTrue(failures, ref cases, "400ms → 不在打字（窗口边界是开区间）", !UserTyping(400));
        CheckTrue(failures, ref cases, "5000ms → 不在打字", !UserTyping(5000));

        // ④ 计划：新鲜 / 过期 / 没有清单 / 看过但没有密码框
        MaskPlan none = Plan(1280, 720, 0, 0, new List<MaskCacheEntry>(), CacheMaxAgeMs);
        CheckTrue(failures, ref cases, "没有任何清单：Listed=false", !none.Listed);
        CheckTrue(failures, ref cases, "没有任何清单：Stale=false", !none.Stale);
        CheckInt(failures, ref cases, "没有任何清单：年龄 -1", -1, none.AgeMs);
        CheckInt(failures, ref cases, "没有任何清单：不遮", 0, none.Rects.Count);

        MaskPlan fresh = Plan(1280, 720, 0, 0, Entries(Entry(7, 1200, oneRect(100, 100, 200, 30))), CacheMaxAgeMs);
        CheckTrue(failures, ref cases, "新鲜清单：Listed=true", fresh.Listed);
        CheckTrue(failures, ref cases, "新鲜清单：Stale=false", !fresh.Stale);
        CheckInt(failures, ref cases, "新鲜清单：年龄照实报", 1200, fresh.AgeMs);
        CheckInt(failures, ref cases, "新鲜清单：遮一块", 1, fresh.Rects.Count);

        MaskPlan noPwd = Plan(1280, 720, 0, 0, Entries(Entry(7, 500, new List<MaskRect>())), CacheMaxAgeMs);
        CheckTrue(failures, ref cases, "看过但没有密码框：Listed=true（不用吓唬模型）", noPwd.Listed);
        CheckTrue(failures, ref cases, "看过但没有密码框：Stale=false", !noPwd.Stale);
        CheckInt(failures, ref cases, "看过但没有密码框：不遮", 0, noPwd.Rects.Count);

        MaskPlan stale = Plan(1280, 720, 0, 0, Entries(Entry(7, CacheMaxAgeMs + 1, oneRect(100, 100, 200, 30))), CacheMaxAgeMs);
        CheckTrue(failures, ref cases, "过期清单：Stale=true（回执要说明没遮）", stale.Stale);
        CheckTrue(failures, ref cases, "过期清单：Listed=false", !stale.Listed);
        CheckInt(failures, ref cases, "过期清单：一个都不遮", 0, stale.Rects.Count);
        CheckInt(failures, ref cases, "过期清单：年龄照实报", CacheMaxAgeMs + 1, stale.AgeMs);

        MaskPlan edge = Plan(1280, 720, 0, 0, Entries(Entry(7, CacheMaxAgeMs, oneRect(100, 100, 200, 30))), CacheMaxAgeMs);
        CheckInt(failures, ref cases, "边界 30000ms：仍算新鲜", 1, edge.Rects.Count);
        CheckTrue(failures, ref cases, "边界 30000ms：不算过期", !edge.Stale);

        List<MaskCacheEntry> mixed = new List<MaskCacheEntry>();
        mixed.Add(Entry(11, 40000, oneRect(100, 100, 200, 30)));
        mixed.Add(Entry(12, 900, oneRect(500, 400, 200, 30)));
        MaskPlan mixedPlan = Plan(1280, 720, 0, 0, mixed, CacheMaxAgeMs);
        CheckInt(failures, ref cases, "一新一旧：只遮新鲜那一块", 1, mixedPlan.Rects.Count);
        CheckInt(failures, ref cases, "一新一旧：取最年轻那份的年龄", 900, mixedPlan.AgeMs);
        CheckTrue(failures, ref cases, "一新一旧：不算过期", !mixedPlan.Stale);

        List<MaskCacheEntry> allStale = new List<MaskCacheEntry>();
        allStale.Add(Entry(11, 50000, oneRect(100, 100, 200, 30)));
        allStale.Add(Entry(12, 45000, oneRect(500, 400, 200, 30)));
        MaskPlan allStalePlan = Plan(1280, 720, 0, 0, allStale, CacheMaxAgeMs);
        CheckTrue(failures, ref cases, "全都过期：Stale=true", allStalePlan.Stale);
        CheckInt(failures, ref cases, "全都过期：年龄取最年轻那份", 45000, allStalePlan.AgeMs);

        MaskPlan windowPlan = Plan(800, 600, 400, 300, Entries(Entry(9, 100, oneRect(500, 400, 100, 20))), CacheMaxAgeMs);
        CheckRect(failures, ref cases, "按窗口：屏幕坐标减窗口原点", 98, 98, 104, 24, windowPlan.Rects, 0);

        // ⑤ 缓存：记账 / 覆盖 / 未知 hwnd / 清空 / 外部改不到
        PasswordRects.Clear();
        CheckInt(failures, ref cases, "清空后查不到任何窗口", -1, AgeOf(4242));
        List<MaskRect> recorded = One(10, 20, 30, 40);
        PasswordRects.Record(4242, Cands(recorded, "rt:1"), "", 1000);
        MaskCacheEntry hit;
        bool found = PasswordRects.TryGet(4242, 1000, out hit);
        CheckTrue(failures, ref cases, "记过之后查得到", found);
        CheckInt(failures, ref cases, "刚记的年龄是 0", 0, hit == null ? -1 : hit.AgeMs);
        CheckRect(failures, ref cases, "记下的矩形原样读回", 10, 20, 30, 40, hit == null ? null : hit.Rects, 0);

        recorded[0].X = 9999; // 调用方拿到的是自己的副本，改它不该影响缓存
        PasswordRects.TryGet(4242, 1000, out hit);
        CheckInt(failures, ref cases, "缓存不被调用方的后续改动影响", 10, hit == null ? -1 : hit.Rects[0].X);

        PasswordRects.Record(4242, Cands(One(70, 80, 90, 100), "rt:1"), "", 2000);
        PasswordRects.TryGet(4242, 2000, out hit);
        CheckInt(failures, ref cases, "同一个窗口再记一次：覆盖旧矩形", 70, hit == null ? -1 : hit.Rects[0].X);
        CheckInt(failures, ref cases, "覆盖后年龄归零", 0, hit == null ? -1 : hit.AgeMs);
        CheckInt(failures, ref cases, "覆盖后只有一块（不是追加）", 1, hit == null ? -1 : hit.Rects.Count);
        CheckInt(failures, ref cases, "没记过的窗口仍是 -1", -1, AgeOf(999));

        PasswordRects.TryGet(4242, 2000 + 4321, out hit);
        CheckInt(failures, ref cases, "年龄按 tick 差值算", 4321, hit == null ? -1 : hit.AgeMs);

        PasswordRects.Clear();
        CheckInt(failures, ref cases, "清空后再次查不到", -1, AgeOf(4242));

        // ⑤b P2-2：「显示密码」翻转后仍要遮（按身份认，不按 IsPassword）
        MaskCandidate pw1 = Cand("rt:42.1", "", 50, 60, 200, 30, true);
        MaskCandidate name1 = Cand("rt:42.2", "", 50, 20, 200, 30, false);
        List<MaskCandidate> first = CandsList(pw1, name1);
        List<MaskCandidate> kept = MergeCandidates(null, first);
        CheckInt(failures, ref cases, "合并：首次只收密码框", 1, kept.Count);
        CheckTrue(failures, ref cases, "合并：首次留下的就是密码框", kept.Count > 0 && kept[0].IsPassword);

        // 翻转：同一个 RuntimeId，现在 IsPassword=false，位置也因布局动了 4px
        MaskCandidate flipped = Cand("rt:42.1", "", 50, 64, 200, 30, false);
        MaskCandidate plainNew = Cand("rt:42.3", "", 50, 100, 200, 30, false);
        List<MaskCandidate> second = CandsList(flipped, name1, plainNew);
        List<MaskCandidate> merged = MergeCandidates(kept, second);
        CheckInt(failures, ref cases, "翻转后：被翻开的那一个仍留在缓存里", 1, merged.Count);
        CheckInt(failures, ref cases, "翻转后：矩形取这一轮的位置（跟着控件动）", 64, merged.Count > 0 ? merged[0].Rect.Y : -1);
        Program.CheckString(failures, ref cases, "翻转后：身份仍是同一个", "rt:42.1", merged.Count > 0 ? merged[0].RuntimeId : null);

        // 同一位置换了一个**新控件**（身份不同）：不许把新控件当成旧密码框
        MaskCandidate replaced = Cand("rt:99.9", "", 50, 64, 200, 30, false);
        CheckTrue(failures, ref cases, "身份不同 → 不是同一个控件（不靠位置认）",
            !SameControl(replaced, flipped));
        CheckInt(failures, ref cases, "同一位置换了新控件：不是密码框就不遮", 0,
            MergeCandidates(kept, CandsList(replaced)).Count);

        // 拿不到身份时退化为矩形重合（写明的取舍）
        MaskCandidate noIdOld = Cand("", "", 10, 10, 200, 30, true);
        MaskCandidate noIdSame = Cand("", "", 12, 12, 200, 30, false);
        MaskCandidate noIdFar = Cand("", "", 400, 400, 200, 30, false);
        CheckTrue(failures, ref cases, "没身份 + 重合 → 同一个（退化判据）", SameControl(noIdSame, noIdOld));
        CheckTrue(failures, ref cases, "没身份 + 离得远 → 不是同一个", !SameControl(noIdFar, noIdOld));
        CheckInt(failures, ref cases, "没身份时按重合认回被翻开的框", 1,
            MergeCandidates(CandsList(noIdOld), CandsList(noIdSame)).Count);
        CheckTrue(failures, ref cases, "AutomationId 只在两边都没 RuntimeId 时当身份",
            SameControl(Cand("", "pw", 0, 0, 10, 10, false), Cand("", "pw", 900, 900, 10, 10, true)));

        // ⑤c P2-1：可见性 / 标题两道闸
        string currentTitle = "MASK TEST";
        int hiddenCount;
        MaskCacheEntry visEntry = EntryWithTitle("MASK TEST", 100, 200, 300, 40);
        MaskCacheEntry visible = VisiblePart(visEntry, currentTitle,
            delegate(long h, int x, int y) { return x == 250 && y == 220; }, out hiddenCount);
        CheckInt(failures, ref cases, "可见：点归自己 → 留", 1, visible.Rects.Count);
        CheckInt(failures, ref cases, "可见：挡掉的计数为 0", 0, hiddenCount);
        MaskCacheEntry covered = VisiblePart(visEntry, currentTitle,
            delegate(long h, int x, int y) { return false; }, out hiddenCount);
        CheckInt(failures, ref cases, "被别的窗口盖住 → 一块都不涂", 0, covered.Rects.Count);
        CheckInt(failures, ref cases, "被盖住时计数照实报", 1, hiddenCount);
        MaskCacheEntry oldPage = VisiblePart(visEntry, "新建标签页",
            delegate(long h, int x, int y) { return true; }, out hiddenCount);
        CheckInt(failures, ref cases, "页面已换（标题不同）→ 一块都不涂", 0, oldPage.Rects.Count);
        CheckInt(failures, ref cases, "页面已换时也计数", 1, hiddenCount);
        CheckTrue(failures, ref cases, "标题任一边为空 → 不据此放掉遮罩",
            TitleStillMatches("", "x") && TitleStillMatches("x", "") && TitleStillMatches(null, null));
        CheckTrue(failures, ref cases, "标题相同（含首尾空白）→ 对得上",
            TitleStillMatches("  MASK TEST ", "MASK TEST"));

        // ⑥ 回执字段（宿主按名字取值：名字写错就是两端脱钩）
        PasswordRects.Clear();
        PasswordRects.Record(31, Cands(One(100, 100, 200, 30), "rt:31"), "", Environment.TickCount);
        MaskPlan receiptPlan = Plan(1280, 720, 0, 0, SnapshotOf(31), CacheMaxAgeMs);
        string fields = CaptureFields(receiptPlan);
        CheckTrue(failures, ref cases, "回执字段含 maskedRegions", fields.IndexOf("\"maskedRegions\":1") >= 0);
        CheckTrue(failures, ref cases, "回执字段含 maskListed", fields.IndexOf("\"maskListed\":true") >= 0);
        CheckTrue(failures, ref cases, "回执字段含 maskStale", fields.IndexOf("\"maskStale\":false") >= 0);
        CheckTrue(failures, ref cases, "回执字段含 maskCacheAgeMs", fields.IndexOf("\"maskCacheAgeMs\":") >= 0);
        CheckTrue(failures, ref cases, "回执字段含 userTyping", fields.IndexOf("\"userTyping\":") >= 0);
        PasswordRects.Clear();

        // ⑦ 日志：三种「没遮」的理由必须各有一句（现场排查靠它）
        PasswordRects.Clear();
        string logNone = LogLine("screenshot", none);
        CheckTrue(failures, ref cases, "日志：没有清单时说「没有 uia-list 记录」",
            logNone.IndexOf("uia-list 记录") >= 0);
        string logStale = LogLine("screenshot", stale);
        CheckTrue(failures, ref cases, "日志：过期时说「没有遮罩」与过期线",
            logStale.IndexOf("没有遮罩") >= 0 && logStale.IndexOf(CacheMaxAgeMs.ToString()) >= 0);
        string logNoPwd = LogLine("screenshot", noPwd);
        CheckTrue(failures, ref cases, "日志：看过没有密码框时说明无需遮罩", logNoPwd.IndexOf("无需遮罩") >= 0);
        CheckTrue(failures, ref cases, "日志：遮住时给出块数与年龄",
            LogLine("screenshot", fresh).IndexOf("1 个密码框") >= 0);

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    // ---- 自测里用的小工具（生产路径不用它们）--------------------------------

    private static MaskCandidate Cand(string runtimeId, string automationId, int x, int y, int w, int h, bool isPassword)
    {
        MaskCandidate c = new MaskCandidate();
        c.RuntimeId = runtimeId;
        c.AutomationId = automationId;
        c.Rect = new MaskRect(x, y, w, h);
        c.IsPassword = isPassword;
        return c;
    }

    private static List<MaskCandidate> CandsList(params MaskCandidate[] items)
    {
        return new List<MaskCandidate>(items);
    }

    /** 一组矩形 → 候选（同一个 RuntimeId 前缀 + 下标，自测里当「密码框」） */
    private static List<MaskCandidate> Cands(List<MaskRect> rects, string runtimeIdSeed)
    {
        List<MaskCandidate> list = new List<MaskCandidate>();
        for (int i = 0; i < rects.Count; i++)
        {
            MaskRect r = rects[i];
            list.Add(Cand(runtimeIdSeed + "." + i, "", r.X, r.Y, r.W, r.H, true));
        }
        return list;
    }

    private static MaskCacheEntry EntryWithTitle(string title, int x, int y, int w, int h)
    {
        MaskCacheEntry entry = new MaskCacheEntry();
        entry.Hwnd = 77;
        entry.AgeMs = 100;
        entry.Title = title;
        entry.Rects = One(x, y, w, h);
        return entry;
    }

    private static List<MaskRect> One(int x, int y, int w, int h)
    {
        return new List<MaskRect>(new MaskRect[] { new MaskRect(x, y, w, h) });
    }

    private static MaskRect oneRect(int x, int y, int w, int h)
    {
        return new MaskRect(x, y, w, h);
    }

    private static MaskCacheEntry Entry(long hwnd, int ageMs, MaskRect rect)
    {
        List<MaskRect> rects = new List<MaskRect>();
        rects.Add(rect);
        return Entry(hwnd, ageMs, rects);
    }

    private static MaskCacheEntry Entry(long hwnd, int ageMs, List<MaskRect> rects)
    {
        MaskCacheEntry entry = new MaskCacheEntry();
        entry.Hwnd = hwnd;
        entry.AgeMs = ageMs;
        entry.Rects = CopyOf(rects);
        return entry;
    }

    private static List<MaskCacheEntry> Entries(MaskCacheEntry entry)
    {
        List<MaskCacheEntry> entries = new List<MaskCacheEntry>();
        entries.Add(entry);
        return entries;
    }

    /** 缓存里某个窗口的年龄（-1 = 没有） */
    private static int AgeOf(long hwnd)
    {
        MaskCacheEntry entry;
        return PasswordRects.TryGet(hwnd, Environment.TickCount, out entry) ? entry.AgeMs : -1;
    }

    /** 缓存里某个窗口的一条（自测里造计划用） */
    private static List<MaskCacheEntry> SnapshotOf(long hwnd)
    {
        List<MaskCacheEntry> entries = new List<MaskCacheEntry>();
        MaskCacheEntry entry;
        if (PasswordRects.TryGet(hwnd, Environment.TickCount, out entry)) entries.Add(entry);
        return entries;
    }

    private static void CheckInt(List<string> failures, ref int cases, string name, int expected, int actual)
    {
        cases++;
        if (expected != actual)
            failures.Add(name + "：期待 " + expected.ToString() + "，实得 " + actual.ToString());
    }

    private static void CheckRect(List<string> failures, ref int cases, string name,
        int x, int y, int w, int h, List<MaskRect> rects, int index)
    {
        cases++;
        if (rects == null || rects.Count <= index)
        {
            failures.Add(name + "：没有第 " + (index + 1) + " 块（共 "
                + (rects == null ? 0 : rects.Count) + " 块）");
            return;
        }
        MaskRect r = rects[index];
        if (r.X != x || r.Y != y || r.W != w || r.H != h)
            failures.Add(name + "：期待 " + x + "," + y + " " + w + "x" + h
                + "，实得 " + r.X + "," + r.Y + " " + r.W + "x" + r.H);
    }

    private static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
    {
        cases++;
        if (!condition) failures.Add(name + "：不成立");
    }
}

/**
 * 「最近一次 uia-list 看到的密码框矩形」缓存（按 hwnd 索引，进程内）。
 *
 * 为什么是内存缓存而不是文件：它只是**同一台桥**里两条命令之间的便条（uia-list 写、
 * 截图读），桥重启就没了正好——沙箱重置后页面也没了。跨进程不共享（命令都在桥主进程的
 * 命令循环里跑，TCP 与文件协议两条通道都是）。
 *
 * 过期不在这里判（那是 Mask.Plan 的事）：这里只回答「有没有、多老了」。
 */
internal static class PasswordRects
{
    private sealed class Stored
    {
        public long Tick;
        /** 记这份清单时那个窗口的标题（截图时拿来判「页面是不是已经换了」） */
        public string Title;
        /** 合并后的「该遮的控件」：这一轮仍是密码框的 + 曾经是密码框、现在被翻成明文的 */
        public List<MaskCandidate> Candidates;
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<long, Stored> Entries = new Dictionary<long, Stored>();

    /**
     * uia-list 跑完一声：这个窗口现在哪些控件该遮（空的列表也要记——「看过，没有密码框」）。
     *
     * `candidates` 是这一轮 list 到的**所有可能是密码框的控件**（当前是密码框的，以及
     * 当前是普通输入框的——后者用来认出「上一轮是密码框、这一轮被显示密码翻开了」）。
     * 合并规则在 Mask.MergeCandidates；这里只负责把上一轮的身份交给它。
     */
    internal static void Record(long hwnd, List<MaskCandidate> candidates, string title, long tickNow)
    {
        Stored stored = new Stored();
        stored.Tick = tickNow;
        stored.Title = title == null ? "" : title;
        lock (Gate)
        {
            Stored previous;
            if (!Entries.TryGetValue(hwnd, out previous)) previous = null;
            stored.Candidates = Mask.MergeCandidates(previous == null ? null : previous.Candidates, candidates);
            Entries[hwnd] = stored;
        }
    }

    /**
     * 取某个窗口的密码框矩形 + 年龄 + 记清单时的标题。没有记录回 false（age 无意义）。
     * tick 用 32 位模运算算差值（与 InputHook.ElapsedMs 同一条纪律：TickCount 会回绕）。
     */
    internal static bool TryGet(long hwnd, long tickNow, out MaskCacheEntry entry)
    {
        entry = null;
        lock (Gate)
        {
            Stored stored;
            if (!Entries.TryGetValue(hwnd, out stored)) return false;
            entry = ToEntry(hwnd, stored, tickNow);
            return true;
        }
    }

    /** 整桌面截图要所有窗口的（顺序与纳入顺序无关：涂黑没有先后） */
    internal static List<MaskCacheEntry> Snapshot(long tickNow)
    {
        List<MaskCacheEntry> list = new List<MaskCacheEntry>();
        lock (Gate)
        {
            foreach (KeyValuePair<long, Stored> pair in Entries)
                list.Add(ToEntry(pair.Key, pair.Value, tickNow));
        }
        return list;
    }

    private static MaskCacheEntry ToEntry(long hwnd, Stored stored, long tickNow)
    {
        MaskCacheEntry entry = new MaskCacheEntry();
        entry.Hwnd = hwnd;
        entry.AgeMs = (int)InputHook.ElapsedMs(tickNow, stored.Tick);
        entry.Title = stored.Title == null ? "" : stored.Title;
        entry.Rects = Mask.RectsOf(stored.Candidates);
        return entry;
    }

    /** 清空（自测用；生产不需要——桥进程随沙箱消失） */
    internal static void Clear()
    {
        lock (Gate)
        {
            Entries.Clear();
        }
    }
}
