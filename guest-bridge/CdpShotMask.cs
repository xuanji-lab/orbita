// Orbita guest bridge —— 网页截图前的密码框遮罩（浏览器车道）。
//
// 像素车道（Mask.cs：UIA 记下的控件矩形 + 出图前涂黑）看不见网页里的密码框：
// 网页里的框是 DOM，不是 Win32 控件。所以浏览器车道要进页面自己盖一层——在
// `Page.captureScreenshot` 之前按帧注入 overlay，出图后撤掉。
//
// 三条真机 / 小样实测的事实（照抄，别重新发明）：
//   ① 真跨进程 iframe（OOPIF）**不出现在父帧的 `Page.getFrameTree` 里**，只能从
//      `Target.getTargets` 按 `type:"iframe"` 枚举 → `Target.attachToTarget{flatten:true}`
//      → 在那个 session 里 `Runtime.enable` → 用 `executionContextCreated` 报出的
//      **默认上下文**注入。只连 page session 的车道永远遮不到银行 / 支付 iframe。
//   ② `Page.createIsolatedWorld(子帧 frameId)` 是**假成功**：不报错，但上下文落在主帧
//      world——遮罩全打在 main frame 上，看起来"成功"，图里 iframe 明文照旧。所以这里
//      一次都不用它（自测就断言这一点）。
//   ③ 同一个 frameId 会有**多个** `isDefault:true` 的上下文（导航前的残留 world），
//      且 origin 可能写着父帧的源。按 frameId 取第一个会取错——必须再按 origin 过滤，
//      并取最新一个（见 PickContext）。
//
// 命中规则（按优先级，翻转 `type` 之后仍认得出）：
//   1. `input[autocomplete*=password i]` —— 「显示密码」只翻 type，不动 autocomplete；
//   2. `[data-sensitive]` —— 站点 / 我们自己打的标记；
//   3. `input[type=password]` —— 常规密码框；
//   4. `[data-orbita-masked]` —— 注入时给命中元素打的自有标记（兜底：只有 type 的框
//      被翻转成 text 之后，前三条全漏，这一条还记得它）。
//   盲区（如实说）：只有 `type=password`、无任何属性、也从未被我们遮过的框，一旦被
//   站点翻转成 text 就漏。遮罩只挡**像素**、不挡 DOM：`sandbox_extract` / DOM 仍读得到值。
//
// 编译约束（同全仓）：csc v4.0.30319 = C# 5 —— 禁字符串插值 / `?.` / `out var` / 枚举。

using System;
using System.Collections.Generic;
using System.Text;

/**
 * 一个帧的静态信息（来自 `Page.getFrameTree` 的 frame 对象）。
 * `Main` = 帧树里的第一个（根帧），注入顺序从它开始。
 */
internal sealed class MaskFrame
{
    internal string FrameId = "";
    internal string Url = "";
    internal string ParentFrameId = "";
    internal bool Main = false;
}

/**
 * 一个执行上下文（`Runtime.executionContextCreated` 的 context 对象）。
 * `SessionId` 空串 = 页面自己的 flatten session（主帧 / 同进程子帧的上下文都在它上面）；
 * 非空 = 某个 OOPIF target 自己的 session。
 */
internal sealed class MaskContext
{
    internal string SessionId = "";
    internal int Id = 0;
    internal string FrameId = "";
    internal string Origin = "";
    internal bool IsDefault = false;
}

/**
 * 一个帧这一轮遮罩的结果（回执与「撤遮罩」都靠它）。
 * `Injected` = 脚本跑成了（哪怕命中 0 块，也算覆盖到了这个帧）；
 * `Regions` = 盖了几块 overlay；`Error` = 这个帧没遮上的原因。
 */
internal sealed class MaskFrameOutcome
{
    internal string Url = "";
    internal string SessionId = "";
    internal int ContextId = 0;
    internal bool Main = false;
    internal bool Injected = false;
    internal int Regions = 0;
    internal string Error;
}

/**
 * 一次截图的遮罩总账：按帧记结果，回执字段由它派生。
 *
 * `maskCoverage` 只有两档（宿主与工具描述都按这两档说话）：
 *   `main+iframes` —— 枚举到的每个帧都注入成功了（页面没有 iframe 也算这一档：都遮了）；
 *   `main-only`    —— 至少一个帧没遮上（attach 不上 / 没有可用上下文 / 脚本报错 / 预算不足）。
 * 不写「部分遮了」第三档：模型只有两句话可说，「部分」会让它以为知道具体漏了哪块。
 */
internal sealed class ShotMaskReport
{
    internal List<MaskFrameOutcome> Frames = new List<MaskFrameOutcome>();
    /** 这一轮 `Runtime.enable` 成功的 session（收尾要把它们 disable 回去，见 ClearShotMask） */
    internal List<string> Sessions = new List<string>();
    /** 这一轮遮罩的整体失败原因（null = 没有整体性问题）。同一次回执里的 maskError */
    internal string Error;

    internal int Regions
    {
        get
        {
            int total = 0;
            for (int i = 0; i < Frames.Count; i++)
            {
                if (Frames[i].Injected) total += Frames[i].Regions;
            }
            return total;
        }
    }

    internal int FrameCount
    {
        get
        {
            int total = 0;
            for (int i = 0; i < Frames.Count; i++)
            {
                if (Frames[i].Injected) total++;
            }
            return total;
        }
    }

    internal string Coverage
    {
        get
        {
            if (Frames.Count == 0) return "main-only";
            for (int i = 0; i < Frames.Count; i++)
            {
                if (!Frames[i].Injected) return "main-only";
            }
            return "main+iframes";
        }
    }

    /** 记一条整体性原因（只留前两条，resp 是一整读整写的文件，不能让它长成一屏） */
    internal void Note(string reason)
    {
        if (reason == null || reason.Length == 0) return;
        if (Error == null) Error = reason;
        else if (Error.Length < 160) Error = Error + "；" + reason;
    }

    /** 回执字段：宿主按名字取值（maskedRegions / maskFrames / maskCoverage / maskError） */
    internal void AppendTo(JObj o)
    {
        o.Num("maskedRegions", Regions).Num("maskFrames", FrameCount).Str("maskCoverage", Coverage);
        if (Error != null) o.Str("maskError", Error);
    }
}

/**
 * 遮罩的纯函数与脚本（自测 `--selftest-shotmask` 直接验；不启进程、不碰 Edge、不碰桌面）。
 */
internal static class ShotMask
{
    /**
     * 命中选择器（唯一真源：脚本里插的就是它）。
     * 顺序有意义：`autocomplete` 先于 `type`，因为「显示密码」只翻 type。
     */
    internal const string Selector =
        "input[autocomplete*=password i], [data-sensitive], input[type=password], [data-orbita-masked]";

    /** overlay 自己的标记（撤遮罩按它找节点）与「这个元素曾经是密码框」的标记 */
    internal const string MaskAttr = "data-orbita-mask";
    internal const string MarkAttr = "data-orbita-masked";

    /**
     * 注入脚本：在**帧自己的**上下文里跑，按 `getBoundingClientRect()` 给每个命中元素
     * 钉一块 `position:fixed` 的深色块。
     *
     * 为什么不改元素自身的样式：改 `background` / `color` 会跟站点自己的样式打架，
     * 也可能被 `!important` 盖回去；overlay 是独立节点，`pointer-events:none` 不挡点击，
     * `position:fixed` 不占文档流（对照图里布局逐像素一致）。
     * 开头先清掉上一轮遗留的 overlay：万一上次撤除失败（页面卡住 / 连接断了），
     * 这一次不会把两块叠在一起。
     */
    internal const string MaskScript = @"(function () {
  var SEL = 'input[autocomplete*=password i], [data-sensitive], input[type=password], [data-orbita-masked]';
  var stale = document.querySelectorAll('[data-orbita-mask]');
  for (var s = 0; s < stale.length; s++) stale[s].parentNode.removeChild(stale[s]);
  var root = document.documentElement || document.body;
  if (!root) return { hits: 0, kinds: '', frame: 'none' };
  var els = document.querySelectorAll(SEL);
  var hits = 0;
  var kinds = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el.getBoundingClientRect) continue;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    el.setAttribute('data-orbita-masked', '1');
    var d = document.createElement('div');
    d.setAttribute('data-orbita-mask', '1');
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
      'margin:0;padding:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
      'width:' + r.width + 'px;height:' + r.height + 'px;background:#15181d;color:#cfd6dd;' +
      'font:12px monospace;display:flex;align-items:center;justify-content:center;' +
      'letter-spacing:2px;border-radius:4px;';
    d.textContent = '已遮罩';
    root.appendChild(d);
    hits++;
    if (el.matches && el.matches('input[autocomplete*=password i]')) kinds.push('autocomplete');
    else if (el.hasAttribute && el.hasAttribute('data-sensitive')) kinds.push('data-sensitive');
    else if (el.matches && el.matches('input[type=password]')) kinds.push('type=password');
    else kinds.push('marked');
  }
  return { hits: hits, kinds: kinds.join(','), frame: (window === window.top ? 'main' : 'sub') };
})()";

    /** 撤遮罩：只删自己插的 overlay（`data-orbita-masked` 标记留着，它是下一次的线索） */
    internal const string CleanupScript = @"(function () {
  var stale = document.querySelectorAll('[data-orbita-mask]');
  var n = 0;
  for (var i = 0; i < stale.length; i++) { stale[i].parentNode.removeChild(stale[i]); n++; }
  return n;
})()";

    /** `Runtime.evaluate` 的参数（returnByValue 才能拿到 hits；contextId 指定帧的默认世界） */
    internal static string EvalParams(int contextId, string expression)
    {
        return "{\"expression\":" + Program.JsonQuote(expression)
            + ",\"returnByValue\":true,\"contextId\":" + contextId + "}";
    }

    /**
     * 一个 URL 的 origin（`scheme://host:port`，scheme 与 host 小写）。**纯函数**。
     * 拿不到可比 origin（`about:blank` / `data:` / 空）时回空串 = 「不按 origin 过滤」。
     */
    internal static string OriginOf(string url)
    {
        if (url == null) return "";
        string v = url.Trim();
        int schemeAt = v.IndexOf("://", StringComparison.Ordinal);
        if (schemeAt <= 0) return "";
        int start = schemeAt + 3;
        int end = start;
        while (end < v.Length && "/?#".IndexOf(v[end]) < 0) end++;
        if (end <= start) return "";
        return v.Substring(0, schemeAt).ToLowerInvariant() + "://"
            + v.Substring(start, end - start).ToLowerInvariant();
    }

    /**
     * 解析 `Page.getFrameTree` 的回执：按 `{"frame":` 切块，每块取它自己的 id / url。
     * 块的顺序就是树的深度优先顺序，**第一个是根帧**（`Main`）。**纯函数**。
     *
     * 为什么切块就够：一个 frame 对象的字段顺序是 id → parentId? → loaderId → url …，
     * 块内第一次出现的 `"id"` / `"url"` 一定是这个 frame 自己的（子帧是再往后的独立块）。
     */
    internal static List<MaskFrame> ParseFrameTree(string reply)
    {
        List<MaskFrame> frames = new List<MaskFrame>();
        if (reply == null) return frames;
        string marker = "{\"frame\":";
        int at = reply.IndexOf(marker, StringComparison.Ordinal);
        while (at >= 0)
        {
            int next = reply.IndexOf(marker, at + marker.Length, StringComparison.Ordinal);
            string chunk = next > 0 ? reply.Substring(at, next - at) : reply.Substring(at);
            MaskFrame f = new MaskFrame();
            f.FrameId = Program.ExtractString(chunk, "id");
            f.Url = Program.ExtractString(chunk, "url");
            f.ParentFrameId = Program.ExtractString(chunk, "parentId");
            if (f.FrameId != null && f.FrameId.Length > 0)
            {
                if (f.Url == null) f.Url = "";
                if (f.ParentFrameId == null) f.ParentFrameId = "";
                f.Main = frames.Count == 0;
                frames.Add(f);
            }
            if (next < 0) break;
            at = next;
        }
        return frames;
    }

    /**
     * 从收集到的 `executionContextCreated` 事件里解析上下文。**纯函数**。
     * `sessionId` 是发 `Runtime.enable` 的那个 session（空串 = 页面自己的）。
     *
     * 只认 `auxData.isDefault == true` 的：隔离世界里的上下文碰不到页面自己的 DOM。
     */
    internal static void ParseContexts(List<string> events, string sessionId, List<MaskContext> into)
    {
        if (events == null || into == null) return;
        for (int i = 0; i < events.Count; i++)
        {
            string e = events[i];
            if (e == null) continue;
            if (e.IndexOf("Runtime.executionContextCreated", StringComparison.Ordinal) < 0) continue;
            int at = e.IndexOf("{\"context\":", StringComparison.Ordinal);
            if (at < 0) continue;
            // 事件自己带着它来自哪个 flatten session（同一条 socket 上多层 session 混在一起）：
            // 不是我们要的那个 session 的报告就当没看见（否则主帧会拿到 iframe 的上下文）
            string eventSession = Program.ExtractString(e, "sessionId");
            string owner = sessionId == null ? "" : sessionId;
            if (eventSession == null || eventSession.Length == 0) eventSession = owner;
            else if (owner.Length > 0 && !string.Equals(eventSession, owner, StringComparison.Ordinal)) continue;
            string chunk = e.Substring(at);
            MaskContext c = new MaskContext();
            c.SessionId = eventSession;
            c.Id = (int)ParseLongSafe(Program.ExtractNumber(chunk, "id"), 0);
            c.Origin = Program.ExtractString(chunk, "origin");
            c.FrameId = Program.ExtractString(chunk, "frameId");
            c.IsDefault = chunk.IndexOf("\"isDefault\":true", StringComparison.Ordinal) >= 0;
            if (c.Id <= 0) continue;
            if (c.Origin == null) c.Origin = "";
            if (c.FrameId == null) c.FrameId = "";
            into.Add(c);
        }
    }

    /**
     * 给一个帧挑默认上下文：`frameId` 必须对上，`isDefault` 必须为真，
     * 并且 origin 要等于帧自己的 URL origin（同一 frameId 的旧 world 会写着别的源）。
     * 多个候选时取**最后一个**（事件顺序 = 最新创建的那个）。**纯函数**。
     */
    internal static MaskContext PickContext(List<MaskContext> contexts, string frameId, string frameUrl, string sessionId)
    {
        if (contexts == null || frameId == null || frameId.Length == 0) return null;
        string origin = OriginOf(frameUrl);
        MaskContext found = null;
        for (int i = 0; i < contexts.Count; i++)
        {
            MaskContext c = contexts[i];
            if (c == null || !c.IsDefault) continue;
            if (c.FrameId != frameId) continue;
            if (sessionId != null && sessionId.Length > 0 && c.SessionId != sessionId) continue;
            if (origin.Length > 0 && c.Origin.Length > 0
                && !string.Equals(c.Origin, origin, StringComparison.OrdinalIgnoreCase)) continue;
            found = c;
        }
        return found;
    }

    /**
     * 兜底：OOPIF 的 executionContext 里 frameId 未必等于 targetId（Chrome 版本差异），
     * 那就按「这个 session 里 origin 与 target URL 一致的默认上下文，取最新一个」。
     * **纯函数**。
     */
    internal static MaskContext PickSessionContext(List<MaskContext> contexts, string sessionId, string url)
    {
        if (contexts == null) return null;
        string origin = OriginOf(url);
        MaskContext found = null;
        for (int i = 0; i < contexts.Count; i++)
        {
            MaskContext c = contexts[i];
            if (c == null || !c.IsDefault) continue;
            if (sessionId != null && sessionId.Length > 0 && c.SessionId != sessionId) continue;
            if (origin.Length > 0 && c.Origin.Length > 0
                && !string.Equals(c.Origin, origin, StringComparison.OrdinalIgnoreCase)) continue;
            found = c;
        }
        return found;
    }

    /**
     * 从 `Target.getTargets` 里挑**属于这个标签页**的 iframe target。**纯函数**。
     *
     * 归属靠 `parentFrameId`：它在 `knownFrames`（本标签页的帧树 + 已认领的 OOPIF）里才算。
     * 不这么过滤就会把**别的标签页**的 iframe 也遮上（getTargets 是全浏览器的）：那边的
     * 遮罩没人撤，且会虚报 blocked 数。循环到不再增长是为了嵌套 OOPIF（iframe 里再套 iframe）。
     */
    internal static List<TargetInfo> PickIframeTargets(List<TargetInfo> targets, List<string> knownFrames)
    {
        List<TargetInfo> picked = new List<TargetInfo>();
        if (targets == null || knownFrames == null) return picked;
        List<string> known = new List<string>(knownFrames);
        bool grew = true;
        while (grew)
        {
            grew = false;
            for (int i = 0; i < targets.Count; i++)
            {
                TargetInfo t = targets[i];
                if (t == null || t.Type != "iframe" || t.Id == null || t.Id.Length == 0) continue;
                if (Has(known, t.Id)) continue;
                if (t.ParentFrameId == null || t.ParentFrameId.Length == 0) continue;
                if (!Has(known, t.ParentFrameId)) continue;
                picked.Add(t);
                known.Add(t.Id);
                grew = true;
            }
        }
        return picked;
    }

    /** 脚本回执里的错误（页面异常 / CDP error）。null = 跑成了。**纯函数** */
    internal static string ScriptError(string reply)
    {
        if (reply == null) return "没有回执";
        if (reply.IndexOf("\"exceptionDetails\":", StringComparison.Ordinal) >= 0) return "页面里的脚本报错";
        if (reply.IndexOf("\"error\":{", StringComparison.Ordinal) >= 0)
        {
            string message = Program.ExtractString(reply, "message");
            return message == null || message.Length == 0 ? "CDP 返回了错误但没有 message" : message;
        }
        return null;
    }

    /** 注入脚本返回的 hits（盖了几块）。脚本没回这个字段时按 0。**纯函数** */
    internal static int RegionsOf(string reply)
    {
        if (reply == null) return 0;
        return (int)ParseLongSafe(Program.ExtractNumber(reply, "hits"), 0);
    }

    /** 这个 session 已经失效了吗（缓存下来的 iframe session 会被浏览器悄悄干掉）。**纯函数** */
    internal static bool IsStaleSessionError(string message)
    {
        if (message == null) return false;
        return message.IndexOf("Session with given id", StringComparison.OrdinalIgnoreCase) >= 0
            || message.IndexOf("No target with given id", StringComparison.OrdinalIgnoreCase) >= 0
            || message.IndexOf("Session closed", StringComparison.OrdinalIgnoreCase) >= 0
            || message.IndexOf("Target closed", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static bool Has(List<string> list, string value)
    {
        if (value == null) return false;
        for (int i = 0; i < list.Count; i++)
        {
            if (string.Equals(list[i], value, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static long ParseLongSafe(string text, long fallback)
    {
        long value;
        if (text == null || !long.TryParse(text, out value)) return fallback;
        return value;
    }

    // ---- 自测（--selftest-shotmask：纯函数，不启进程、不碰 Edge、不碰桌面）----

    internal static int RunSelfTest()
    {
        List<string> failures = new List<string>();
        int cases = 0;

        // ① 选择器清单：三条规则 + 自有标记，且 autocomplete 排在 type 之前
        //    （「显示密码」只翻 type；顺序反了就会在翻转后漏掉）
        CheckTrue(failures, ref cases, "选择器含 autocomplete*=password",
            Selector.IndexOf("input[autocomplete*=password i]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "选择器含 [data-sensitive]",
            Selector.IndexOf("[data-sensitive]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "选择器含 input[type=password]",
            Selector.IndexOf("input[type=password]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "选择器含兜底标记 [data-orbita-masked]",
            Selector.IndexOf("[data-orbita-masked]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "autocomplete 先于 type=password（翻转后仍命中）",
            Selector.IndexOf("autocomplete", StringComparison.Ordinal)
                < Selector.IndexOf("type=password", StringComparison.Ordinal));

        // ② 注入脚本：用的是同一份选择器；overlay 的几何 / 层级 / 不挡点击；打标兜底
        CheckTrue(failures, ref cases, "脚本里插的就是同一份选择器",
            MaskScript.IndexOf("input[autocomplete*=password i], [data-sensitive], input[type=password], [data-orbita-masked]",
                StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "脚本按 getBoundingClientRect 定位",
            MaskScript.IndexOf("getBoundingClientRect()", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "overlay 是 position:fixed（不占文档流）",
            MaskScript.IndexOf("position:fixed", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "overlay 层级最高",
            MaskScript.IndexOf("z-index:2147483647", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "overlay 不挡点击（pointer-events:none）",
            MaskScript.IndexOf("pointer-events:none", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "给命中元素打 data-orbita-masked",
            MaskScript.IndexOf("setAttribute('data-orbita-masked', '1')", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "overlay 节点带 data-orbita-mask（撤遮罩靠它）",
            MaskScript.IndexOf("setAttribute('data-orbita-mask', '1')", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "注入前先清上一轮遗留的 overlay",
            MaskScript.IndexOf("querySelectorAll('[data-orbita-mask]')", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "脚本有可见的遮罩文案",
            MaskScript.IndexOf("已遮罩", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "**不用** Page.createIsolatedWorld（对子帧是假成功）",
            MaskScript.IndexOf("createIsolatedWorld", StringComparison.Ordinal) < 0);

        // ③ 撤遮罩：只删自己的节点
        CheckTrue(failures, ref cases, "撤遮罩按 data-orbita-mask 找节点",
            CleanupScript.IndexOf("[data-orbita-mask]", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "撤遮罩用 removeChild 移除",
            CleanupScript.IndexOf("removeChild", StringComparison.Ordinal) >= 0);

        // ④ EvalParams：contextId 指定帧的默认世界，returnByValue 才能读 hits
        string paramsJson = EvalParams(7, "1");
        CheckTrue(failures, ref cases, "EvalParams 带 contextId",
            paramsJson.IndexOf("\"contextId\":7", StringComparison.Ordinal) >= 0);
        CheckTrue(failures, ref cases, "EvalParams 带 returnByValue",
            paramsJson.IndexOf("\"returnByValue\":true", StringComparison.Ordinal) >= 0);

        // ⑤ origin 提取（上下文按它过滤；大小写与端口都要照实）
        CheckString(failures, ref cases, "origin: 带端口与路径",
            "http://localhost:39182", OriginOf("http://localhost:39182/frame.html"));
        CheckString(failures, ref cases, "origin: 端口之外无路径",
            "https://a.example.com:8443", OriginOf("https://a.example.com:8443/x?y=1#z"));
        CheckString(failures, ref cases, "origin: 大小写归一",
            "https://a.example.com", OriginOf("HTTPS://A.Example.COM/Path"));
        CheckString(failures, ref cases, "origin: about:blank 不可比 → 空串", "", OriginOf("about:blank"));
        CheckString(failures, ref cases, "origin: null → 空串", "", OriginOf(null));

        // ⑥ 帧树解析：根在前、父子关系、url 各归各
        string treeReply = "{\"frameTree\":{\"frame\":{\"id\":\"MAIN\",\"loaderId\":\"L1\",\"url\":\"http://127.0.0.1:39181/\","
            + "\"domainAndRegistry\":\"\"},\"childFrames\":[{\"frame\":{\"id\":\"SUB1\",\"parentId\":\"MAIN\","
            + "\"loaderId\":\"L2\",\"url\":\"http://127.0.0.1:39181/a.html\"}}]}}";
        List<MaskFrame> tree = ParseFrameTree(treeReply);
        CheckInt(failures, ref cases, "帧树：两个帧", 2, tree.Count);
        CheckString(failures, ref cases, "帧树：第一个是根帧 id", "MAIN", tree.Count > 0 ? tree[0].FrameId : null);
        CheckTrue(failures, ref cases, "帧树：第一个标成 Main", tree.Count > 0 && tree[0].Main);
        CheckString(failures, ref cases, "帧树：根帧 url", "http://127.0.0.1:39181/", tree.Count > 0 ? tree[0].Url : null);
        CheckString(failures, ref cases, "帧树：子帧 parentId", "MAIN", tree.Count > 1 ? tree[1].ParentFrameId : null);
        CheckTrue(failures, ref cases, "帧树：子帧不是 Main", tree.Count > 1 && !tree[1].Main);
        CheckInt(failures, ref cases, "帧树：空回执不炸", 0, ParseFrameTree("{}").Count);

        // ⑦ 上下文解析 + 挑帧：同一 frameId 的旧世界（origin 写父帧的源）必须被跳过
        List<string> events = new List<string>();
        events.Add("{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":3,"
            + "\"origin\":\"http://127.0.0.1:39181\",\"name\":\"\",\"auxData\":{\"isDefault\":true,"
            + "\"type\":\"default\",\"frameId\":\"MAIN\"}}},\"sessionId\":\"S-PAGE\"}");
        events.Add("{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":4,"
            + "\"origin\":\"http://localhost:39182\",\"name\":\"\",\"auxData\":{\"isDefault\":true,"
            + "\"type\":\"default\",\"frameId\":\"IFRAME1\"}}},\"sessionId\":\"S-OOPIF\"}");
        events.Add("{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":5,"
            + "\"origin\":\"http://localhost:39182\",\"name\":\"\"}}}");
        List<MaskContext> pageContexts = new List<MaskContext>();
        ParseContexts(events, "S-PAGE", pageContexts);
        CheckInt(failures, ref cases, "上下文：页面 session 收到两个（含非默认那个）", 2, pageContexts.Count);
        CheckTrue(failures, ref cases, "上下文：非默认不参与挑选", !pageContexts[1].IsDefault);
        MaskContext mainCtx = PickContext(pageContexts, "MAIN", "http://127.0.0.1:39181/page.html", "");
        CheckInt(failures, ref cases, "挑上下文：主帧拿到 id 3", 3, mainCtx == null ? -1 : mainCtx.Id);

        List<string> staleEvents = new List<string>();
        staleEvents.Add("{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":9,"
            + "\"origin\":\"http://other.example.com\",\"name\":\"\",\"auxData\":{\"isDefault\":true,"
            + "\"type\":\"default\",\"frameId\":\"MAIN\"}}}}");
        staleEvents.Add("{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":10,"
            + "\"origin\":\"http://127.0.0.1:39181\",\"name\":\"\",\"auxData\":{\"isDefault\":true,"
            + "\"type\":\"default\",\"frameId\":\"MAIN\"}}}}");
        List<MaskContext> twoWorlds = new List<MaskContext>();
        ParseContexts(staleEvents, "", twoWorlds);
        MaskContext picked = PickContext(twoWorlds, "MAIN", "http://127.0.0.1:39181/", "");
        CheckInt(failures, ref cases, "挑上下文：origin 对的那个（取最新，不是第一个）", 10,
            picked == null ? -1 : picked.Id);
        CheckTrue(failures, ref cases, "挑上下文：frameId 对不上 → null",
            PickContext(twoWorlds, "NOPE", "http://127.0.0.1:39181/", "") == null);

        List<MaskContext> oopifContexts = new List<MaskContext>();
        ParseContexts(events, "S-OOPIF", oopifContexts);
        CheckInt(failures, ref cases, "挑上下文：OOPIF 按 targetId 找（frameId=targetId）", 4,
            PickContext(oopifContexts, "IFRAME1", "http://localhost:39182/", "S-OOPIF") == null
                ? -1 : PickContext(oopifContexts, "IFRAME1", "http://localhost:39182/", "S-OOPIF").Id);
        CheckInt(failures, ref cases, "挑上下文：OOPIF frameId 对不上时按 session+origin 兜底", 4,
            PickSessionContext(oopifContexts, "S-OOPIF", "http://localhost:39182/") == null
                ? -1 : PickSessionContext(oopifContexts, "S-OOPIF", "http://localhost:39182/").Id);
        CheckTrue(failures, ref cases, "挑上下文：别的 session 的同源上下文不认",
            PickSessionContext(oopifContexts, "S-OTHER", "http://localhost:39182/") == null);

        // ⑧ iframe target 归属：本标签页的认，别的标签页的不认，嵌套的认
        List<TargetInfo> targets = new List<TargetInfo>();
        targets.Add(Target("P1", "page", "https://shop.example.com/", ""));
        targets.Add(Target("F-OURS", "iframe", "http://pay.example.net/", "MAIN"));
        targets.Add(Target("F-OTHER-TAB", "iframe", "http://ads.example.org/", "OTHER-MAIN"));
        targets.Add(Target("F-NESTED", "iframe", "http://pay-nested.example.net/", "F-OURS"));
        List<string> known = new List<string>();
        known.Add("MAIN");
        List<TargetInfo> pickedIframes = PickIframeTargets(targets, known);
        CheckInt(failures, ref cases, "iframe 归属：本页 iframe + 嵌套的两个", 2, pickedIframes.Count);
        CheckString(failures, ref cases, "iframe 归属：第一个是本页的", "F-OURS",
            pickedIframes.Count > 0 ? pickedIframes[0].Id : null);
        CheckTrue(failures, ref cases, "iframe 归属：别的标签页的不在内",
            IndexOfTarget(pickedIframes, "F-OTHER-TAB") < 0);
        CheckInt(failures, ref cases, "iframe 归属：没有已知帧时一个都不认", 0,
            PickIframeTargets(targets, new List<string>()).Count);

        // ⑨ 回执映射：字段名是宿主按名字取的（写错就是两端脱钩）；覆盖两档都要出现
        ShotMaskReport good = new ShotMaskReport();
        good.Frames.Add(Outcome("https://a/", true, 2, true));
        good.Frames.Add(Outcome("https://b/", true, 1, false));
        JObj goodJson = new JObj().Bool("ok", true);
        good.AppendTo(goodJson);
        string goodFields = goodJson.ToString();
        CheckTrue(failures, ref cases, "回执含 maskedRegions=3", goodFields.IndexOf("\"maskedRegions\":3") >= 0);
        CheckTrue(failures, ref cases, "回执含 maskFrames=2", goodFields.IndexOf("\"maskFrames\":2") >= 0);
        CheckTrue(failures, ref cases, "回执含 maskCoverage=main+iframes",
            goodFields.IndexOf("\"maskCoverage\":\"main+iframes\"") >= 0);
        CheckTrue(failures, ref cases, "全遮住时不写 maskError", goodFields.IndexOf("maskError") < 0);
        CheckString(failures, ref cases, "覆盖档位：全遮住 = main+iframes", "main+iframes", good.Coverage);
        CheckInt(failures, ref cases, "块数按注入成功的帧求和", 3, good.Regions);

        ShotMaskReport degraded = new ShotMaskReport();
        degraded.Frames.Add(Outcome("https://a/", true, 1, true));
        degraded.Frames.Add(Outcome("https://pay/", false, 0, false));
        degraded.Note("iframe 未遮：attachToTarget 没有回 sessionId");
        JObj badJson = new JObj().Bool("ok", true);
        degraded.AppendTo(badJson);
        string badFields = badJson.ToString();
        CheckTrue(failures, ref cases, "iframe 没遮上 → maskCoverage=main-only",
            badFields.IndexOf("\"maskCoverage\":\"main-only\"") >= 0);
        CheckTrue(failures, ref cases, "iframe 没遮上 → maskError 带原因",
            badFields.IndexOf("attachToTarget") >= 0);
        CheckInt(failures, ref cases, "iframe 没遮上 → maskFrames 只算成功的", 1, degraded.FrameCount);

        ShotMaskReport nothing = new ShotMaskReport();
        CheckString(failures, ref cases, "一块都没跑 → 不许声称 main+iframes", "main-only", nothing.Coverage);
        nothing.Note("时间预算不足");
        JObj noneJson = new JObj().Bool("ok", true);
        nothing.AppendTo(noneJson);
        CheckTrue(failures, ref cases, "整轮没跑也要写 maskError",
            noneJson.ToString().IndexOf("\"maskError\":") >= 0);

        // ⑩ 脚本回执：异常 / CDP error / hits
        CheckTrue(failures, ref cases, "脚本异常被认出",
            ScriptError("{\"exceptionDetails\":{\"text\":\"boom\"}}") != null);
        CheckTrue(failures, ref cases, "CDP error 被认出（原文回给调用方）",
            ScriptError("{\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Session with given id not found.\"}}")
                .IndexOf("Session with given id") >= 0);
        CheckTrue(failures, ref cases, "跑成时没有错误", ScriptError("{\"result\":{\"result\":{\"value\":{\"hits\":2}}}}") == null);
        CheckInt(failures, ref cases, "hits 解析", 2, RegionsOf("{\"result\":{\"result\":{\"value\":{\"hits\":2}}}}"));
        CheckInt(failures, ref cases, "没有 hits 字段按 0", 0, RegionsOf("{\"result\":{}}"));
        CheckTrue(failures, ref cases, "失效 session 被认出", IsStaleSessionError("Session with given id not found."));
        CheckTrue(failures, ref cases, "页面脚本报错不算 session 失效", !IsStaleSessionError("页面里的脚本报错"));

        Console.WriteLine(Program.BuildSelfTestJson(failures, cases));
        return failures.Count == 0 ? 0 : 1;
    }

    // ---- 自测里用的小工具（生产路径不用它们）--------------------------------

    private static TargetInfo Target(string id, string type, string url, string parentFrameId)
    {
        TargetInfo info = new TargetInfo();
        info.Id = id;
        info.Type = type;
        info.Url = url;
        info.ParentFrameId = parentFrameId;
        return info;
    }

    private static MaskFrameOutcome Outcome(string url, bool injected, int regions, bool main)
    {
        MaskFrameOutcome outcome = new MaskFrameOutcome();
        outcome.Url = url;
        outcome.Injected = injected;
        outcome.Regions = regions;
        outcome.Main = main;
        return outcome;
    }

    private static int IndexOfTarget(List<TargetInfo> list, string id)
    {
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i].Id == id) return i;
        }
        return -1;
    }

    private static void CheckInt(List<string> failures, ref int cases, string name, int expected, int actual)
    {
        cases++;
        if (expected != actual) failures.Add(name + "：期待 " + expected + "，实得 " + actual);
    }

    private static void CheckTrue(List<string> failures, ref int cases, string name, bool condition)
    {
        cases++;
        if (!condition) failures.Add(name + "：不成立");
    }

    private static void CheckString(List<string> failures, ref int cases, string name, string expected, string actual)
    {
        cases++;
        bool same = expected == null ? actual == null : string.Equals(expected, actual, StringComparison.Ordinal);
        if (!same) failures.Add(name + "：期待 " + (expected == null ? "null" : expected)
            + "，实得 " + (actual == null ? "null" : actual));
    }
}
