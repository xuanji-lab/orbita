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
 */
internal sealed class MaskCacheEntry
{
    public long Hwnd;
    public List<MaskRect> Rects = new List<MaskRect>();
    public int AgeMs;
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
            return command + "：遮住 " + plan.Rects.Count + " 个密码框（清单 " + plan.AgeMs + "ms 前）";
        if (plan.Stale)
            return command + "：**没有遮罩**——最近一份控件清单已 " + plan.AgeMs + "ms（> " + CacheMaxAgeMs
                + "ms），不知道密码框现在在哪；回执已写明";
        if (!plan.Listed)
            return command + "：" + "没有遮罩——这个窗口没有 uia-list 记录，不知道密码框在哪；回执已写明";
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
        PasswordRects.Record(4242, recorded, 1000);
        MaskCacheEntry hit;
        bool found = PasswordRects.TryGet(4242, 1000, out hit);
        CheckTrue(failures, ref cases, "记过之后查得到", found);
        CheckInt(failures, ref cases, "刚记的年龄是 0", 0, hit == null ? -1 : hit.AgeMs);
        CheckRect(failures, ref cases, "记下的矩形原样读回", 10, 20, 30, 40, hit == null ? null : hit.Rects, 0);

        recorded[0].X = 9999; // 调用方拿到的是自己的副本，改它不该影响缓存
        PasswordRects.TryGet(4242, 1000, out hit);
        CheckInt(failures, ref cases, "缓存不被调用方的后续改动影响", 10, hit == null ? -1 : hit.Rects[0].X);

        PasswordRects.Record(4242, One(70, 80, 90, 100), 2000);
        PasswordRects.TryGet(4242, 2000, out hit);
        CheckInt(failures, ref cases, "同一个窗口再记一次：覆盖旧矩形", 70, hit == null ? -1 : hit.Rects[0].X);
        CheckInt(failures, ref cases, "覆盖后年龄归零", 0, hit == null ? -1 : hit.AgeMs);
        CheckInt(failures, ref cases, "覆盖后只有一块（不是追加）", 1, hit == null ? -1 : hit.Rects.Count);
        CheckInt(failures, ref cases, "没记过的窗口仍是 -1", -1, AgeOf(999));

        PasswordRects.TryGet(4242, 2000 + 4321, out hit);
        CheckInt(failures, ref cases, "年龄按 tick 差值算", 4321, hit == null ? -1 : hit.AgeMs);

        PasswordRects.Clear();
        CheckInt(failures, ref cases, "清空后再次查不到", -1, AgeOf(4242));

        // ⑥ 回执字段（宿主按名字取值：名字写错就是两端脱钩）
        PasswordRects.Clear();
        PasswordRects.Record(31, One(100, 100, 200, 30), Environment.TickCount);
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
        public List<MaskRect> Rects;
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<long, Stored> Entries = new Dictionary<long, Stored>();

    /** uia-list 跑完一声：这个窗口现在的密码框在哪（空的列表也要记——「看过，没有密码框」） */
    internal static void Record(long hwnd, List<MaskRect> rects, long tickNow)
    {
        Stored stored = new Stored();
        stored.Tick = tickNow;
        stored.Rects = Mask.CopyOf(rects);
        lock (Gate)
        {
            Entries[hwnd] = stored;
        }
    }

    /**
     * 取某个窗口的密码框矩形 + 年龄。没有记录回 false（age 无意义）。
     * tick 用 32 位模运算算差值（与 InputHook.ElapsedMs 同一条纪律：TickCount 会回绕）。
     */
    internal static bool TryGet(long hwnd, long tickNow, out MaskCacheEntry entry)
    {
        entry = null;
        lock (Gate)
        {
            Stored stored;
            if (!Entries.TryGetValue(hwnd, out stored)) return false;
            entry = new MaskCacheEntry();
            entry.Hwnd = hwnd;
            entry.AgeMs = (int)InputHook.ElapsedMs(tickNow, stored.Tick);
            entry.Rects = Mask.CopyOf(stored.Rects);
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
            {
                MaskCacheEntry entry = new MaskCacheEntry();
                entry.Hwnd = pair.Key;
                entry.AgeMs = (int)InputHook.ElapsedMs(tickNow, pair.Value.Tick);
                entry.Rects = Mask.CopyOf(pair.Value.Rects);
                list.Add(entry);
            }
        }
        return list;
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
