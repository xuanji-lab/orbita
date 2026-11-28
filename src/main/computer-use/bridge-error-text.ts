/**
 * guest 桥（C#）回的中文错误 → 英文界面的那句话（2026-11-28）。
 *
 * 为什么需要这一层：`guest-bridge/` 里的错误文案是中文（给中文界面 / 日志用的），它们会
 * 原样进 `resp.error`，再一路变成聊天里的工具回执。英文界面下这就是夹生字——而把 500 多条
 * C# 字符串翻一遍要重编桥 exe，日志那边又该是中文，代价与收益都不对。
 *
 * 所以翻译放在**宿主侧**，规则只有三条：
 *   1. 认得出的错误 → 一句**完整英文**（带下一步该做什么，因为这些回执是给模型读的）；
 *      中文原文进日志（细节不丢，只是不出现在界面上）；
 *   2. 认不出的中文错误 → 一句通用英文（「沙箱报了一个错误，细节见应用日志」），原文同样进日志；
 *   3. 中文界面 → 原样返回，一个字都不改。
 *
 * 「永远不漏」靠的是最后那道自检：任何规则渲染出来的英文只要**还含 CJK**，就退回通用句
 * （`renderEn` 末尾的 `CJK.test`）。规则写得再糙也不会把中文漏进英文界面。
 *
 * 不翻译 C# 的日志（`Log(...)`）：日志本来就该是中文（AGENTS.md），而且它们根本不进回执。
 */
import { computerUseUiTexts } from "../../shared/computer-use-texts.ts";
import type { CuLanguage } from "./ui-language.ts";

const CJK = /[\u4e00-\u9fff]/;
/** 网络错误码：这类 ASCII 串是「为什么打不开」的关键证据（networkFailureError 也要它），必须留着 */
const NET_CODE = /\b(ERR_[A-Z_]+|net::ERR_[A-Z_]+)\b/;
/** 提到「没有在运行」的说法：cdp.ts 的自愈判据靠它（英文侧认 `is not running`） */
const NOT_RUNNING = /没有在运行|没有启动|通道起不来|通道意外退出|没有响应/;

/**
 * 一个错误家族 → 英文那句话。`match` 只负责「认出来」，`en` 负责把话说完整。
 * 顺序有意义：具体的写在前面（「选择器…没有匹配到输入框」不能被「选择器…」那条抢走也无妨，
 * 两种说法给的是同一件事的下一步）。
 */
interface Rule {
  /** 家族的识别依据（中文关键词 / 句式） */
  readonly match: RegExp;
  readonly en: (raw: string, m: RegExpMatchArray) => string;
}

/** 只保留 ASCII 细节（选择器 / 窗口标题 / 路径）：带中文的细节一律丢掉，由日志承接 */
function asciiDetail(text: string | undefined, maxLength = 120): string {
  if (text === undefined) return "";
  const trimmed = text.trim();
  if (trimmed === "" || CJK.test(trimmed)) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

/** 把细节拼进句子里（没有细节时返回空串） */
function detailSuffix(detail: string, format: (detail: string) => string): string {
  return detail === "" ? "" : format(detail);
}

const RULES: readonly Rule[] = [
  // ── 浏览器名额定满 ────────────────────────────────────────────────
  {
    match: /同时最多\s*(\d+)\s*个浏览器/,
    en: (_raw, m) =>
      `The sandbox can run at most ${m[1] ?? "a few"} browsers at once. Stop one with cdp-stop before starting ` +
      "another; idle instances are reclaimed automatically. If you only want a different page, open it with " +
      "sandbox_navigate instead of starting another browser.",
  },

  // ── 页面加载 / 导航 ──────────────────────────────────────────────
  {
    match: /^页面没有加载[:：]/,
    en: (raw) => {
      const code = NET_CODE.exec(raw)?.[1];
      const reason = code === undefined ? "the address could not be reached" : `the browser reported ${code}`;
      return (
        `The page did not load: ${reason}. The sandbox may have no outbound network, the host may be offline, or ` +
        "this address may be unreachable. Try an address you know loads; if every site fails the same way it is " +
        "the network, not this page. If you still need to work on what is on screen, use the pixel tools " +
        "(computer_screenshot / computer_click)."
      );
    },
  },
  {
    match: /^页面加载失败（没有拿到内容）/,
    en: () =>
      "The page failed to load (no content was received). The sandbox may have no outbound network, the host may " +
      "be offline, or this address may be unreachable. Try an address you know loads, then retry.",
  },
  {
    match: /^页面没有返回可读内容/,
    en: () =>
      "The page returned no readable content: it may still be loading, or it is a blank page. Wait a moment or " +
      "use sandbox_wait, then observe the page again.",
  },
  {
    match: /^无法打开这个网址/,
    en: (raw, m) => {
      const url = asciiDetail(m[1]);
      const code = NET_CODE.exec(raw)?.[1];
      return (
        `Could not open${detailSuffix(url, (value) => ` ${value}`)}.` +
        (code === undefined ? "" : ` The browser reported ${code}.`) +
        " Check the address, or open another one; if every site fails the same way the network is the problem, " +
        "not the page."
      );
    },
  },
  {
    match: /^页面里的脚本报错/,
    en: () =>
      "A script on the page reported an error. The page may have failed partway; observe it again, and reload " +
      "with sandbox_navigate if what you see does not match what you expect.",
  },

  // ── 选择器 / 元素找不到 ──────────────────────────────────────────
  {
    match: /^选择器「(.*?)」(.*)$/,
    en: (_raw, m) => {
      const selector = asciiDetail(m[1]);
      const tail = m[2] ?? "";
      const what = /输入框/.test(tail)
        ? "input field"
        : /下载链接/.test(tail)
          ? "download link"
          : /没有匹配到元素/.test(tail)
            ? "element"
            : "visible element";
      return (
        `No ${what} on the page matches the selector${detailSuffix(selector, (value) => ` "${value}"`)}. ` +
        "Run sandbox_observe again to see the current page structure and use the selector it returns; an old " +
        "selector stops working after the page navigates."
      );
    },
  },
  {
    match: /没找到标题包含「(.*?)」的窗口/,
    en: (_raw, m) => {
      const title = asciiDetail(m[1]);
      return (
        `No window whose title contains${detailSuffix(title, (value) => ` "${value}"`)} was found. List the ` +
        "windows first (computer_screenshot with no target, or the window list) and pass a title or hwnd that is " +
        "actually there."
      );
    },
  },
  {
    match: /找不到标题包含「(.*?)」的窗口/,
    en: (_raw, m) => {
      const title = asciiDetail(m[1]);
      return (
        `No window whose title contains${detailSuffix(title, (value) => ` "${value}"`)} was found. List the ` +
        "windows first and use a title or hwnd that is actually there."
      );
    },
  },
  {
    match: /没找到名字包含「(.*?)」的控件/,
    en: (_raw, m) => {
      const name = asciiDetail(m[1]);
      return (
        `No control whose name contains${detailSuffix(name, (value) => ` "${value}"`)} was found. Run uia-list ` +
        "on that window first and act on one of the refs or names it returns (the match is a case-insensitive " +
        "substring)."
      );
    },
  },

  // ── 通道 / 浏览器没起来 ─────────────────────────────────────────
  {
    match: /浏览器通道起不来|把命令交给沙箱里的浏览器通道失败|浏览器通道意外退出|浏览器没有响应/,
    en: () =>
      "The sandbox browser's command channel is not usable right now (it is down or not answering). The next " +
      "command starts a fresh channel automatically; you can retry, check the session with cdp-status, or fall " +
      "back to the pixel tools (computer_screenshot / computer_click).",
  },
  {
    match: NOT_RUNNING,
    en: () =>
      "The browser in the sandbox is not running (or has exited). It has been cleared from the host's cache; " +
      "calling sandbox_navigate again starts a fresh one.",
  },

  // ── 超时 ────────────────────────────────────────────────────────
  {
    match: /CDP 命令超时|CDP 发送超时|CDP 发送失败|连接超时（|CDP 通道刚断过/,
    en: () =>
      "The sandbox browser stopped responding (the CDP call timed out). Retry once; if it keeps timing out, " +
      "check the session with cdp-status, or fall back to the pixel tools (computer_screenshot / computer_click).",
  },

  // ── UIA 控件树 ──────────────────────────────────────────────────
  {
    match: /UIAutomation 失败|没有 UIA 元素|控件树|ControlView 条件|UIA 调用超时|目标窗口没有响应/,
    en: () =>
      "The window's UI Automation tree is not available (the call failed or timed out). The window may not be a " +
      "standard window, or it may have closed. Run uia-list again, or look at the window with a screenshot and " +
      "drive it through the pixel tools (computer_click / computer_type).",
  },
  {
    match: /控件已经不在了|控件没有独立的窗口句柄|只读的|WM_CHAR|WM_LBUTTONDOWN|控件的矩形是空的|窗口已经不在了/,
    en: () =>
      "That control cannot take this action right now (it is gone, read-only, has no window handle of its own, " +
      "or is not visible). Run uia-list again and pick a current control; if the control stays unusable, use the " +
      "pixel tools (computer_click / computer_type) instead.",
  },

  // ── 窗口截图 ────────────────────────────────────────────────────
  {
    match: /这个窗口拍不到|拿不到窗口矩形|窗口尺寸为 0/,
    en: () =>
      "That window cannot be captured (no usable rectangle, or it has no size). Take a full-desktop screenshot " +
      "with computer_screenshot instead, and use its coordinates.",
  },

  // ── 整屏截图 / 编码 ─────────────────────────────────────────────
  {
    match: /无法获取主屏尺寸|整个桌面会话|系统缺少 JPEG 编码器|截图失败|像素统计失败/,
    en: () =>
      "The sandbox could not produce a screenshot (it may not be on an interactive desktop session yet, or the " +
      "image could not be encoded). Check that the sandbox is running and try again.",
  },

  // ── 文件映射（上传 / 下载）──────────────────────────────────────
  {
    match: /沙箱里没有这个文件|沙箱里看不到这个文件|允许上传的目录|下载目录必须是映射目录|落到下载目录/,
    en: () =>
      "The sandbox cannot see that file. Uploads and downloads only work through the mapped folder, which is " +
      "copied into the sandbox: pass a host file to sandbox_upload (the host copies it in for you) and let " +
      "downloads land in the mapped download folder. If you just uploaded, wait a moment and retry.",
  },
  {
    match: /设置上传文件失败|设置下载行为失败|建下载目录失败|取页面根节点失败/,
    en: () =>
      "The sandbox browser could not set up that file operation. Retry once; if it keeps failing, observe the " +
      "page again and make sure the target element is still a file input / download link.",
  },

  // ── 输入（像素车道）─────────────────────────────────────────────
  {
    match: /SendInput 只送达|补发松开|点击失败|输入失败|按键失败|滚动失败|错误码 5 = 拒绝访问/,
    en: () =>
      "The sandbox refused part or all of that input (the session may not be ready or may have expired). Take a " +
      "screenshot to see the current state before retrying; if it keeps failing, restart the sandbox.",
  },
  {
    match: /不认识的按键名|没有可用的按键名/,
    en: () =>
      "That key name is not recognised. Use a name like enter, tab, escape, ctrl+a, alt+f4 (letters, digits and " +
      "the usual modifier names), or type the text with computer_type instead.",
  },

  // ── 进程（launch / kill）────────────────────────────────────────
  {
    match: /taskkill|终止 pid|进程没有起来|launch 需要/,
    en: () =>
      "The sandbox could not start or stop that process. Check the path you passed (it must be inside the " +
      "sandbox and exist there) and the pid (it must be one a launch reply returned), then try again.",
  },
  {
    match: /请求里缺 command 字段|未知命令|未知的 CDP 命令/,
    en: () =>
      "The sandbox did not recognise that command. It may be older than this app build: update the app (the " +
      "bridge ships with it), or use the pixel tools while the command is unsupported.",
  },

  // ── 标签页 ──────────────────────────────────────────────────────
  {
    match: /op 只能是 list 或 switch|没有第\s*\d+\s*个标签页/,
    en: () =>
      "That tab does not exist (or the operation name is wrong). List the tabs with sandbox_tabs first, then " +
      "switch to one of the indexes it returned.",
  },

  // ── 参数校验（兜底里最具体的一类）──────────────────────────────
  {
    match: /需要 .*(字段|其中一个)|必须是|只能是|不能是 0/,
    en: () =>
      "The sandbox rejected that command because one of its arguments is missing or invalid. Check the arguments " +
      "against the tool's description, fix them, and retry.",
  },
];

/**
 * 桥回的错误串 → 界面语言的那句话。
 *
 * @param raw      桥给的原文（可能是中文、可能是纯 ASCII 的 `ERR_*`，也可能已经被宿主本地化过）
 * @param language 界面语言；中文原样返回
 * @param log      原文的落点（默认 console.warn；测试注入数组）
 */
export function guestErrorText(
  raw: string,
  language: CuLanguage = "zh",
  log: (message: string) => void = (message) => console.warn(message),
): string {
  if (language === "zh") return raw;
  // 本来就是英文（桥里少数纯 ASCII 的报错、宿主自己写的话、已经映射过的）→ 一个字不动
  if (!CJK.test(raw)) return raw;

  for (const rule of RULES) {
    const matched = rule.match.exec(raw);
    if (matched === null) continue;
    const english = rule.en(raw, matched);
    if (CJK.test(english)) continue; // 规则自检：渲染结果还夹中文就当下一条规则（见文件头的第 3 条）
    log(`[computer-use] guest 桥错误（原文）：${raw}`);
    return english;
  }

  // 兜底：认不出的中文错误。**原文只进日志**，界面拿到一句通用英文——这是「英文界面永远不露中文」的保证
  log(`[computer-use] guest 桥错误（未映射，原文）：${raw}`);
  const code = NET_CODE.exec(raw)?.[1];
  // 兜底句**按传入的 language 取**（不是 cuTexts()）：这个函数要能独立测试，也不该假设
  // 全局语言就是这次要用的那一档
  const texts = computerUseUiTexts(language);
  return code === undefined ? texts.guestErrorGeneric : texts.guestErrorGenericCode(code);
}

/**
 * 桥回在**成功**回执里的那句补充说明（`resp.note`，目前只有一种：SendInput 只送进去一部分）。
 *
 * 失败回执走 `guestErrorText`；这一条是成功回执上的「但是」——不翻译它，英文界面下就会在
 * 一条英文回执尾巴上挂一句中文。认不出的一律**丢掉**（它不是必需信息，只是额外的提示），
 * 原文进日志。
 */
export function guestNoteText(
  raw: string,
  language: CuLanguage = "zh",
  log: (message: string) => void = (message) => console.warn(message),
): string {
  if (language === "zh") return raw;
  if (!CJK.test(raw)) return raw;
  const partial = /SendInput 只插入了 (\d+)\/(\d+)/.exec(raw);
  if (partial !== null) {
    const inserted = partial[1];
    const requested = partial[2];
    const released = /已补发松开(.*?)——/.exec(raw)?.[1];
    const releasedText = asciiDetail(released);
    log(`[computer-use] guest 桥 note（原文）：${raw}`);
    return (
      ` Only ${inserted} of ${requested} input events were actually inserted; the rest were not sent` +
      (releasedText === "" ? "" : `, and the keys still held down were released (${releasedText})`) +
      ". Take a screenshot to see the current state, then decide whether to redo it — do not replay the same " +
      "action as-is (that would repeat the part that did go through)."
    );
  }
  log(`[computer-use] guest 桥 note（未映射，已丢弃）：${raw}`);
  return "";
}

/** 这条错误里有没有会被界面看到的 CJK（守卫与诊断用） */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}
