/**
 * 电脑使用**工具回执正文**的中英两份（2026-11-28）。
 *
 * 为什么单独一个文件：回执正文是这套文案里最大的一块（十几条工具 × 成功/失败/提示），
 * 与设置页 / 状态那批混在一张接口里会让那张表读不下去。它们仍属于同一张表——
 * `computerUseUiTexts(language)` 把它拼进去，守卫测试遍历的是拼好的整张表。
 *
 * 口径与其它文案一致：
 *   · 回执**是给用户看的**（模型也读），所以跟界面语言走；
 *   · 中文那半边写完整的中文句（专名 WSB / QEMU / Edge / L2b / CDP 与工具名保持原样）；
 *   · 英文那半边写完整的英文句；
 *   · **不许丢掉下一步指引**（「先 sandbox_observe 再看」「CDP 起不来就退回像素工具」这类），
 *     两种语言都必须有——工具回执是模型唯一读得到的地方。
 *
 * 数字与标识（尺寸、毫秒、selector、hwnd、文件名）由调用方传入，两种语言里位置可以不同。
 */
export interface ComputerUseReceiptTexts {
  // ── 沙箱浏览器车道（cdp.ts）──────────────────────────────────────────
  /** 打开一个网址（url / 标题 / 用时 / 桥的 warning 都由调用方给，warning 原样拼） */
  rcptNavOpened(url: string, title: string, ms: string, warning: string): string;
  /** cdp-observe 的标题行（URL / 标题） */
  rcptObserveTitleLine(url: string, title: string): string;
  rcptObserveNoElements: string;
  rcptObserveNoText: string;
  rcptElementsHeader(count: number): string;
  rcptObserveTruncated(shown: number, total: number): string;
  rcptObserveFooter: string;
  /** 一条可交互元素 */
  rcptElementLine(tag: string, role: string, editable: boolean, selector: string, label: string, x: number, y: number): string;
  rcptClickDone(tag: string, label: string, selector: string, x: string, y: string, url: string): string;
  rcptTypeDone(chars: number, selector: string, appended: boolean, fieldChars: number | undefined, submitted: boolean): string;
  rcptExtractNoText: string;
  rcptExtractNothingMatched: string;
  rcptExtractTotal(total: number): string;
  rcptExtractTruncated(total: number, shown: number): string;
  rcptWaitSettled(waited: string): string;
  rcptWaitAppeared(selector: string, waited: string): string;
  rcptWaitMissing(selector: string, waited: string): string;
  rcptShotPage(url: string, title: string, width: number, height: number, nativeWidth: number, nativeHeight: number): string;
  rcptShotPageFooter: string;
  rcptUploadAttached(fileName: string, selector: string, guestName: string): string;
  rcptDownloadNone(selector: string, hostDir: string): string;
  rcptDownloadDone(count: number, selector: string, paths: string): string;
  rcptTabsHeader(count: number): string;
  rcptTabsUntitled: string;
  rcptTabsNone: string;
  rcptTabsSwitched(index: string): string;
  rcptTabsFooter: string;
  /** CDP 起不来时的退化指引（拼在失败句后面，两个语言各自完整） */
  cdpFallbackHint: string;

  // ── 像素 / UIA 车道（agent-requests.ts）──────────────────────────────
  rcptDesktopShot(width: number, height: number, nativeWidth: number, nativeHeight: number): string;
  rcptWindowShot(title: string, hwnd: number, width: number, height: number, nativeWidth: number, nativeHeight: number): string;
  rcptWindowRestored: string;
  rcptWindowShotFooter: string;
  rcptClickSent(kind: string, x: number, y: number): string;
  rcptTypedChars(chars: number): string;
  rcptKeyPressed(key: string): string;
  rcptScrolled(delta: number, x: number, y: number): string;
  /** 准入信息（桥 0.12.0）：verdict + 目标 exe + 一句解释 */
  rcptAdmission(verdict: string, targetExe: string, tail: string): string;
  rcptAdmissionBypassed: string;
  rcptAdmissionUnknown: string;
  rcptAdmissionOwned: string;
  /** 让路回执（用户正在用桌面，这条命令晚了一点） */
  rcptDeferred(waitedMs: number): string;
  rcptCandidates(rows: string): string;
  rcptWindowMinimized: string;
  /** uia-act 的抢焦点警告前缀（后面接桥的原文或默认那句） */
  rcptUiaActWarningLabel: string;
  /** diff 里消失的控件那一行 */
  rcptUiaGoneLine(controlType: string, name: string): string;
  rcptUiaGoneUnnamed: string;

  // ── UIA 控件树（agent-requests.ts）───────────────────────────────────
  rcptUiaNoTitle: string;
  /** 控件行里的两个小标签（两种语言的语序不同，所以也是文案） */
  rcptUiaItemSupports: string;
  rcptUiaItemAt: string;
  rcptUiaListHead(title: string, hwnd: number, generation: number, listed: number, truncated: boolean): string;
  rcptUiaDiffHead(
    title: string,
    hwnd: number,
    generation: number,
    changed: number,
    gone: number,
    unchanged: number,
    moved: number,
    since: string,
    truncated: boolean,
  ): string;
  rcptUiaNoControls: string;
  rcptUiaNothingChanged: string;
  rcptUiaTail(generation: number, diff: boolean): string;
  rcptUiaPasswordNote(fields: number): string;
  rcptUiaEditNote(fields: number): string;
  rcptUiaNoteLine(note: string): string;
  rcptUiaItemUnnamed(automationId: string): string;
  rcptUiaItemNoPattern: string;
  /** 控件行里状态标签的分隔符（中文「，」「、」，英文 ", "） */
  rcptUiaStateSeparator: string;
  rcptUiaFlagJoiner: string;
  rcptUiaFlagPassword: string;
  rcptUiaFlagDisabled: string;
  rcptUiaFlagOffscreen: string;
  rcptUiaChangeNew: string;
  rcptUiaChangeChanged(changed: string): string;
  /** UIA 动作的动词（invoke / setValue / selection 三种，语序不同所以是文案） */
  rcptUiaVerbInvoke: string;
  rcptUiaVerbSetValue: string;
  rcptUiaVerbSelection: string;
  rcptUiaActHead(action: string, name: string, controlType: string, hwnd: number, pattern: string, elapsedMs: number): string;
  rcptUiaActUnnamed: string;
  rcptUiaActFooter(hwnd: number): string;
  rcptUiaActAutoFocusDefault: string;

  // ── 遮罩（shared/computer-use.ts 的 captureNote / shotgun 说明）─────
  rcptCaptureMasked(fields: number): string;
  rcptCaptureStale(ageSeconds: number, ttlSeconds: number): string;
  rcptCaptureNotListed: string;
  rcptCaptureDesktopLane: string;
  rcptCaptureUserTyping: string;
  rcptShotMaskUnchecked: string;
  rcptShotMaskClean(frames: string): string;
  rcptShotMaskNothingCovered(frames: string): string;
  rcptShotMaskCovered(frames: string, fields: string): string;
  rcptShotMaskMissing(list: string): string;
  rcptShotMaskBridgeSaid(error: string): string;

  // ── 工具层的参数校验（agent 进程：computer-tools.ts / sandbox-tools.ts）──
  // ── 工具层参数校验（agent 进程）：这些错误也会出现在回执里 ──────────
  vldBothOrNeither: string;
  vldXY: string;
  vldTextRequired: string;
  vldKeyRequired: string;
  vldDeltaRequired: string;
  vldSincePositive: string;
  vldActionEnum: string;
  vldRefOrName: string;
  vldRefShape: string;
  vldSetValueNeedsValue: string;
  vldUrlRequired: string;
  vldSelectorRequired: string;
  vldPathRequired: string;
  vldWaitNeedsSelectorOrMs: string;
  vldTabsOp: string;
  rcptBrowserShotMissingImage: string;
  rcptNeedsScreenshot: string;
  rcptWindowOrHwnd: string;
  rcptPointOutside(x: number, y: number, width: number, height: number): string;
  rcptTextEmpty: string;
  rcptKeyEmpty: string;
  rcptShotMissingImage: string;
  rcptBrowserNoPage: string;
}

const ZH: ComputerUseReceiptTexts = {
  rcptNavOpened: (url, title, ms, warning) =>
    `已在沙箱浏览器里打开 ${url}${title === "" ? "" : `（${title}）`}${ms === "" ? "" : `，用时 ${ms}`}。` +
    `${warning === "" ? "" : `${warning} `}` +
    "用 sandbox_observe 看看页面上有什么——它的选择器在页面导航之前一直有效。" +
    "这个浏览器是隔离沙箱里的：没有用户的登录状态，也不帮你过验证码。",
  rcptObserveTitleLine: (url, title) => `网址：${url}\n标题：${title}`,
  rcptObserveNoElements:
    "（没有匹配到可交互元素——页面可能还在加载：用 sandbox_wait 等一个选择器，或用 sandbox_screenshot 看一眼）",
  rcptObserveNoText: "（页面上没有可见文字）",
  rcptElementsHeader: (count) => `可交互元素（${count} 个）：`,
  rcptObserveTruncated: (shown, total) => `[页面文字被截断：显示 ${shown} / ${total} 个字符]`,
  rcptObserveFooter:
    "把选择器传给 sandbox_click / sandbox_type / sandbox_extract。选择器是按位置生成的，页面一导航就失效——导航之后重新 observe。",
  rcptElementLine: (tag, role, editable, selector, label, x, y) =>
    `- ${tag}${role}${editable ? " [可输入]" : ""}：选择器 ${selector}${label}，位置 (${x}, ${y})`,
  rcptClickDone: (tag, label, selector, x, y, url) =>
    `已点击 ${tag === "" ? "这个元素" : `<${tag}>`}${label === "" ? "" : `「${label}」`}（选择器 ${selector}），` +
    `位置 (${x}, ${y})。页面现在在 ${url}。用 sandbox_observe 看看变了什么——点击之前拿到的选择器可能已经匹配不上了。`,
  rcptTypeDone: (chars, selector, appended, fieldChars, submitted) =>
    `已向 ${selector} 输入 ${chars} 个字符${appended ? "（追加，旧内容保留）" : ""}。` +
    (fieldChars === undefined || fieldChars < 0
      ? "输入框现在装着刚输入的文本（内容不回显）。"
      : `输入框现在装着 ${fieldChars} 个字符（内容不回显）。`) +
    (submitted ? "已按回车提交。" : "") +
    " 用 sandbox_observe（或用 sandbox_wait 等下一页）看结果。",
  rcptExtractNoText: "页面上没有可见文字（可能还在加载——试试 sandbox_wait）。",
  rcptExtractNothingMatched: "（没有匹配到文字）",
  rcptExtractTotal: (total) => `[共 ${total} 个字符]`,
  rcptExtractTruncated: (total, shown) => `[共 ${total} 个字符，显示前 ${shown} 个]`,
  rcptWaitSettled: (waited) => `已等待 ${waited}，页面应该已经稳定——现在用 sandbox_observe 看它。`,
  rcptWaitAppeared: (selector, waited) => `元素 ${selector} 在 ${waited} 后出现了。用 sandbox_observe 拿到它的选择器与相邻元素。`,
  rcptWaitMissing: (selector, waited) =>
    `元素 ${selector} 在 ${waited} 内没有出现。要么选择器不对（sandbox_observe 会列出真实存在的那些），` +
    "要么页面还需要时间（再调一次 sandbox_wait，或用 sandbox_screenshot 看屏幕上是什么）。",
  rcptShotPage: (url, title, width, height, nativeWidth, nativeHeight) =>
    `页面截图，当前在 ${url}${title === "" ? "" : `（${title}）`}：图是 ${width}×${height}，` +
    `页面视口是 ${nativeWidth}×${nativeHeight} CSS 像素。`,
  rcptShotPageFooter:
    "读页面上有什么，优先用 sandbox_observe / sandbox_click（DOM 层）而不是从图上认字；" +
    "computer_click 也能打到浏览器窗口，但那是最后一招——它不知道指针底下是什么。",
  rcptUploadAttached: (fileName, selector, guestName) =>
    `已把「${fileName}」附到文件输入框 ${selector} 上（页面看到的名字是「${guestName}」）。` +
    "文件是先拷进沙箱的映射目录再附上去的——宿主机上的原件没动。页面要按提交按钮的话，用 sandbox_click。",
  rcptDownloadNone: (selector, hostDir) =>
    `已点击 ${selector}，但 20 秒内下载目录（${hostDir}）里没有文件落下来。` +
    "这个链接可能是打开一个页面而不是下载——用 sandbox_observe 看看它，或者 sandbox_screenshot 看一眼。",
  rcptDownloadDone: (count, selector, paths) =>
    `点击 ${selector} 下载了 ${count} 个文件，它们现在在宿主机上：\n${paths}\n直接用文件工具读它们（read_pdf、read 等）。`,
  rcptTabsHeader: (count) => `沙箱浏览器里有 ${count} 个标签页（* 是你正在操作的那个）：`,
  rcptTabsUntitled: "（无标题）",
  rcptTabsNone: "（没有标签页）",
  rcptTabsSwitched: (index) => `已切到第 ${index} 个标签页。`,
  rcptTabsFooter:
    "弹窗或 target=_blank 的链接会新开一个标签页、但不切过去——在这里列出来，真的要用那一页时再切。" +
    "旧标签页上的选择器对新标签页不适用：重新 observe。",
  cdpFallbackHint:
    "如果 CDP 一直失败，就退回像素工具：用 computer_screenshot 看沙箱桌面，用 computer_click / " +
    "computer_type / computer_key 操作它。它们不需要 Edge 的调试口。",

  rcptDesktopShot: (width, height, nativeWidth, nativeHeight) =>
    `沙箱桌面截图：图是 ${width}×${height}，物理屏是 ${nativeWidth}×${nativeHeight}。` +
    "你传给 computer_click / computer_scroll 的坐标是这张图的像素。" +
    "每次动作之后重新截一张图看变化。",
  rcptWindowShot: (title, hwnd, width, height, nativeWidth, nativeHeight) =>
    `沙箱里窗口「${title}」（hwnd ${hwnd}）的截图：图是 ${width}×${height}，窗口本身是 ` +
    `${nativeWidth}×${nativeHeight} 物理像素。这张图取自窗口自己的画面，别的窗口盖在上面也不影响。`,
  rcptWindowRestored: "它之前被最小化了，现在已经恢复（没有抢焦点）。",
  rcptWindowShotFooter:
    "这张图的坐标是窗口像素、不是桌面像素：不要拿去当 computer_click 的坐标——点击之前先截一张不带 window 的" +
    " computer_screenshot。",
  rcptClickSent: (kind, x, y) => `已在沙箱桌面上执行${kind}，位置 (${x}, ${y})。`,
  rcptTypedChars: (chars) => `已向沙箱桌面上当前聚焦的窗口输入 ${chars} 个字符。`,
  rcptKeyPressed: (key) => `已在沙箱桌面上按下 ${key}。`,
  rcptScrolled: (delta, x, y) => `已在沙箱桌面上 (${x}, ${y}) 处滚动 ${delta} 格（正值向下）。`,
  rcptAdmission: (verdict, targetExe, tail) =>
    ` 准入信息（guest 侧判定）："admission":"${verdict}","targetExe":"${targetExe}"——${tail}。`,
  rcptAdmissionBypassed: "目标是沙箱会话自己进程树之外的进程；这一轮只观察并记日志（不拦）",
  rcptAdmissionUnknown: "那一刻没能定位到目标窗口",
  rcptAdmissionOwned: "目标属于沙箱会话自己的浏览器 / 进程树",
  rcptDeferred: (waitedMs) =>
    `它先被推迟了 ${waitedMs}ms：沙箱里有人正在打字或点击，真人输入优先于 agent 的动作，所以这条命令等到桌面安静下来才执行。` +
    "如果用户还在用，还会有延迟——优先用不接管桌面的车道（sandbox_* 浏览器命令、computer_uia 操作控件、单窗口截图）。",
  rcptWindowMinimized: "，已最小化",
  rcptUiaActWarningLabel: "警告：",
  rcptUiaGoneLine: (controlType, name) => `已消失 · ${controlType} ${name}——这个窗口里已经没有了（它不再有 ref）`,
  rcptUiaGoneUnnamed: "（无名）",
  rcptCandidates: (rows) =>
    `\n\n现在可以截图的窗口：${rows}。把其中一个 hwnd，或其中一个标题的一部分，传给 window。`,

  rcptUiaNoTitle: "（无标题）",
  rcptUiaItemSupports: "支持",
  rcptUiaItemAt: "位置",
  rcptUiaListHead: (title, hwnd, generation, listed, truncated) =>
    `窗口「${title}」（hwnd ${hwnd}，第 ${generation} 代）里的 UI Automation 控件：列了 ${listed} 个` +
    `${truncated ? "（还有更多——调大 maxItems 才能看到）" : ""}。` +
    "每一行的格式是：ref · 控件类型「名字」· 支持的 pattern · 位置/尺寸 · automationId。",
  rcptUiaDiffHead: (title, hwnd, generation, changed, gone, unchanged, moved, since, truncated) =>
    `窗口「${title}」（hwnd ${hwnd}，第 ${generation} 代）里的 UI Automation 控件：自第 ${since} 代以来 ` +
    `${changed} 个变化、${gone} 个消失、${unchanged} 个没变${moved > 0 ? `、${moved} 个只是挪了位置` : ""}` +
    `${truncated ? "（还有更多——调大 maxItems 才能看到）" : ""}。只列变化的部分。`,
  rcptUiaNoControls: "这个窗口里没有找到可操作的控件。",
  rcptUiaNothingChanged: "自那次列表以来没有任何变化。",
  rcptUiaTail: (generation, diff) =>
    "用 computer_uia 操作其中一个（action 取 invoke / setValue / selection，并用 ref 或 name 指它）。" +
    "这些动作直接进控件：窗口不需要在前台，所以不会占住沙箱桌面，别的会话可以继续用。" +
    "没有 focus 动作：要移动键盘焦点，用 computer_click 点到目标上，或者直接用 invoke（通常同时给焦点）/" +
    " setValue（不需要焦点）。" +
    `ref 只属于它来的那张列表（这一张是第 ${generation} 代）；旧列表的 ref 会被拒绝，窗口变了就重新 list。` +
    (diff
      ? "没变的控件不在这个列表里：用 name 操作它们，或者不带 since 再列一次拿它们当前的 ref。"
      : `下次传 since=${generation} 就只拿到变化的部分。`) +
    "上面一个 pattern 都不支持的控件，只能用 computer_click / computer_type（像素）驱动。",
  rcptUiaPasswordNote: (fields) =>
    ` 这个窗口里有 ${fields} 个密码框：绝不要往里放秘密，也不要去读它们。它们的位置被记住了，这个窗口的截图会把它们涂黑。`,
  rcptUiaEditNote: (fields) =>
    ` 这个窗口里有 ${fields} 个输入框，但没有认出密码框：如果这是刚打开的登录页，控件树可能还在长——过一会儿再列一次，` +
    "否则截图时密码框还没被涂黑。",
  rcptUiaNoteLine: (note) => `\n说明：${note}`,
  rcptUiaItemUnnamed: (automationId) => `（没有名字，automationId ${automationId}）`,
  rcptUiaItemNoPattern: "不支持任何 pattern（只能用像素）",
  rcptUiaStateSeparator: "，",
  rcptUiaFlagJoiner: "、",
  rcptUiaFlagPassword: "密码框",
  rcptUiaFlagDisabled: "已禁用",
  rcptUiaFlagOffscreen: "在屏幕外",
  rcptUiaChangeNew: "新增 · ",
  rcptUiaChangeChanged: (changed) => `变化（${changed}） · `,
  rcptUiaVerbInvoke: "执行 invoke：",
  rcptUiaVerbSetValue: "设置文本：",
  rcptUiaVerbSelection: "选择：",
  rcptUiaActHead: (action, name, controlType, hwnd, pattern, elapsedMs) =>
    `已通过 UI Automation 对窗口 hwnd ${hwnd} 里的${name}（${controlType}）执行 ${action}` +
    `（pattern ${pattern}，用时 ${elapsedMs}ms）。窗口不需要在前台，所以没有占住沙箱桌面。`,
  rcptUiaActUnnamed: "（无名控件）",
  rcptUiaActFooter: (hwnd) =>
    ` 要移动键盘焦点，用 computer_click 点目标。用 computer_screenshot（window ${hwnd}）看变了什么。`,
  rcptUiaActAutoFocusDefault:
    "这个系统上关不掉 AutoSetFocus，所以这次动作可能把窗口带到了前台。",

  rcptCaptureMasked: (fields) =>
    ` 这张图里有 ${fields} 个密码框被涂黑了——密码绝不能进你的上下文，黑块是故意的。不要去读它；需要密码就问用户。`,
  rcptCaptureStale: (ageSeconds, ttlSeconds) =>
    ` 警告：这张图没有遮罩。上一次 computer_uia 列表已经是 ${ageSeconds}s 前的，而密码框位置只记 ${ttlSeconds}s——` +
    "如果图里有密码框，不要读它。对这个窗口重新跑一次 computer_uia list，再重新截图。",
  rcptCaptureNotListed:
    " 警告：这张图没有遮罩——还没有用 computer_uia 列过任何窗口，所以找不到也盖不住密码框。" +
    "如果图里有密码框，不要读它。先对这个窗口跑一次 computer_uia list，再重新截图。",
  rcptCaptureDesktopLane:
    " 这是桌面车道：它只从最近一次 computer_uia list 认识密码框，所以网页里在此之前就点了「显示密码」的输入框它看不见——" +
    "网页请用 sandbox_screenshot，它按 DOM 遮。",
  rcptCaptureUserTyping:
    " 截图时有人在沙箱里打字（真人的输入优先于你的），所以图里的部分内容可能已经过时。",
  rcptShotMaskUnchecked:
    " 截图之前它跳过了密码框检查；这张图没有被检查过有没有密码框。",
  rcptShotMaskClean: (frames) => ` 截图之前它检查了 ${frames}，没有发现需要遮的密码框。`,
  rcptShotMaskNothingCovered: (frames) => ` 截图之前它检查了 ${frames}，没有遮任何密码框。`,
  rcptShotMaskCovered: (frames, fields) => ` 截图之前它检查了 ${frames}，用不透明遮罩盖住了 ${fields}。`,
  rcptShotMaskMissing: (list) => ` 它没能到达的帧（这些帧里可见的东西在这张图里也可见）：${list}。`,
  rcptShotMaskBridgeSaid: (error) => ` 桥说：${error}`,

  vldBothOrNeither: "x 与 y 要么都给，要么都不给（都不给 = 屏幕正中）。",
  vldXY: "给 x 与 y——坐标是你最近那张 computer_screenshot 里的像素。",
  vldTextRequired: "text 是必填的（要输入的文本）。",
  vldKeyRequired: "key 是必填的（按键名，如 enter / ctrl+a / alt+f4）。",
  vldDeltaRequired: "deltaY 是必填的（正值向下滚）。",
  vldSincePositive: "since 必须是正整数：上一次列那个窗口时的代次。",
  vldActionEnum: "action 只能是 list / invoke / setValue / selection 之一。要移动键盘焦点，用 computer_click 点目标。",
  vldRefOrName: "给 ref（最近一次列那个窗口时拿到的 token，如 \"g12:r3\"）或 name（控件名字的一部分）。",
  vldRefShape:
    "ref 是从最近一次列表里抄下来的 token，如 \"g12:r3\"（g = 那个窗口的第几次列表，r = 它在列表里的位置）。" +
    "光一个数字已经不是 ref 了：对那个窗口跑一次 action list，把 token 抄过来。",
  vldUrlRequired: "url 是必填的（要打开的网址）。",
  vldSelectorRequired: "selector 是必填的。先调 sandbox_observe——它会列出页面上存在的选择器。",
  vldPathRequired: "path 是必填的（要上传的宿主机文件路径）。",
  vldWaitNeedsSelectorOrMs: "给 selector，或者给 ms 只等时间。两者都不给就没有可等的东西。",
  vldTabsOp: "op 只能是 \"list\" 或 \"switch\"。",
  rcptBrowserShotMissingImage: "sandbox-screenshot 回执里没有图（主进程与契约不一致）。",
  vldSetValueNeedsValue: "setValue 需要 value：要写进控件里的文本（空串 = 清空）。",
  rcptNeedsScreenshot: "先调一次 computer_screenshot：没有它就没有可供换算的图像坐标。",
  rcptWindowOrHwnd: "传 window（目标窗口标题的一部分）或 hwnd——两者取一个，数值从 computer_screenshot 或上一次回执里拿。",
  rcptPointOutside: (x, y, width, height) =>
    `(${x}, ${y}) 不在你上次那张截图里（那张图是 ${width}×${height} 像素）：重新截一张，用这张图上的坐标。`,
  rcptTextEmpty: "要输入的文本是空的。",
  rcptKeyEmpty: "按键名是空的。",
  rcptShotMissingImage: "截图回执里没有图（主进程与契约不一致）。",
  rcptBrowserNoPage:
    "沙箱里的浏览器还没有打开任何页面。先调用 sandbox_navigate 打开一个网址——它会把 Edge 拉起来，" +
    "之后 sandbox_observe / sandbox_click 才能用。CDP 起不来时再退回 computer_screenshot 像素工具。",
};

const EN: ComputerUseReceiptTexts = {
  rcptNavOpened: (url, title, ms, warning) =>
    `Opened ${url}${title === "" ? "" : ` ("${title}")`} in the sandbox browser${ms === "" ? "" : ` in ${ms}`}. ` +
    `${warning === "" ? "" : `${warning} `}` +
    "Call sandbox_observe to see what is on the page; its selectors stay valid until the page navigates. " +
    "This browser is the isolated sandbox one — it has none of the user's sign-in state and no CAPTCHA help.",
  rcptObserveTitleLine: (url, title) => `URL: ${url}\nTitle: ${title}`,
  rcptObserveNoElements:
    "(no interactive elements matched — the page may still be loading: sandbox_wait for a selector, " +
    "or sandbox_screenshot to look at it)",
  rcptObserveNoText: "(the page has no visible text)",
  rcptElementsHeader: (count) => `Interactive elements (${count}):`,
  rcptObserveTruncated: (shown, total) => `[page text truncated: showing ${shown} of ${total} characters]`,
  rcptObserveFooter:
    "Pass a selector to sandbox_click / sandbox_type / sandbox_extract. Selectors are positional and " +
    "expire when the page navigates — observe again after a navigation.",
  rcptElementLine: (tag, role, editable, selector, label, x, y) =>
    `- ${tag}${role}${editable ? " [editable]" : ""}: selector ${selector}${label} at (${x}, ${y})`,
  rcptClickDone: (tag, label, selector, x, y, url) =>
    `Clicked ${tag === "" ? "the element" : `<${tag}>`}${label === "" ? "" : ` "${label}"`} ` +
    `(selector ${selector}) at (${x}, ${y}). The page is now at ${url}. Call sandbox_observe to see what ` +
    "changed — selectors from before the click may no longer match.",
  rcptTypeDone: (chars, selector, appended, fieldChars, submitted) =>
    `Typed ${chars} character(s) into ${selector}${appended ? " (appended, the old value was kept)" : ""}. ` +
    (fieldChars === undefined || fieldChars < 0
      ? "The field now holds the typed text (its content is not echoed back)."
      : `The field now holds ${fieldChars} character(s) (the content is not echoed back).`) +
    (submitted ? " Enter was pressed to submit." : "") +
    " Call sandbox_observe (or sandbox_wait for the next page) to see the result.",
  rcptExtractNoText: "The page has no visible text (it may still be loading — try sandbox_wait).",
  rcptExtractNothingMatched: "(no text matched)",
  rcptExtractTotal: (total) => `[${total} character(s) in total]`,
  rcptExtractTruncated: (total, shown) => `[${total} character(s) in total, showing the first ${shown}]`,
  rcptWaitSettled: (waited) => `Waited ${waited}. The page has had time to settle — sandbox_observe it now.`,
  rcptWaitAppeared: (selector, waited) =>
    `Element ${selector} appeared after ${waited}. Call sandbox_observe to get its selector and neighbours.`,
  rcptWaitMissing: (selector, waited) =>
    `Element ${selector} did not appear within ${waited}. Either the selector is wrong (sandbox_observe shows ` +
    "the ones that exist) or the page needs more time (call sandbox_wait again, or sandbox_screenshot to see " +
    "what is on screen).",
  rcptShotPage: (url, title, width, height, nativeWidth, nativeHeight) =>
    `Screenshot of the page at ${url}${title === "" ? "" : ` ("${title}")`}: the image is ${width}×${height}, ` +
    `the page viewport is ${nativeWidth}×${nativeHeight} CSS pixels.`,
  rcptShotPageFooter:
    "Prefer sandbox_observe / sandbox_click (DOM level) over reading things off the image; computer_click can " +
    "also hit the browser window as a last resort, but it has no idea what is under the pointer.",
  rcptUploadAttached: (fileName, selector, guestName) =>
    `Attached "${fileName}" to the file input ${selector} (the page sees it as "${guestName}"). ` +
    "The file was copied into the sandbox's mapped folder first — the original on the host is untouched. " +
    "If the page needs a submit button pressed, do that with sandbox_click.",
  rcptDownloadNone: (selector, hostDir) =>
    `Clicked ${selector} but no file landed in the download folder (${hostDir}) within 20 s. ` +
    "The link may open a page instead of downloading one — sandbox_observe it, or check sandbox_screenshot.",
  rcptDownloadDone: (count, selector, paths) =>
    `Downloaded ${count} file(s) by clicking ${selector}. They are on the host at:\n${paths}\n` +
    "Use them directly with your file tools (read_pdf, read, …).",
  rcptTabsHeader: (count) => `${count} tab(s) in the sandbox browser (the * is the one you are acting on):`,
  rcptTabsUntitled: "(untitled)",
  rcptTabsNone: "(none)",
  rcptTabsSwitched: (index) => `Switched to tab ${index}. `,
  rcptTabsFooter:
    "A popup or a target=_blank link opens a new tab without switching to it — list them here and switch when " +
    "you actually need that page. Selectors from the old tab do not apply to the new one: observe again.",
  cdpFallbackHint:
    "If CDP keeps failing, fall back to the pixel tools: computer_screenshot to see the sandbox desktop, " +
    "computer_click / computer_type / computer_key to drive it. They do not need Edge's debugging port.",

  rcptDesktopShot: (width, height, nativeWidth, nativeHeight) =>
    `Screenshot of the sandbox desktop: the image is ${width}×${height}, the physical screen is ` +
    `${nativeWidth}×${nativeHeight}. Coordinates you pass to computer_click / computer_scroll are pixels of ` +
    "this image. Take a fresh screenshot after every action to see what changed.",
  rcptWindowShot: (title, hwnd, width, height, nativeWidth, nativeHeight) =>
    `Screenshot of the window "${title}" (hwnd ${hwnd}) in the sandbox: the image is ${width}×${height}, the ` +
    `window itself is ${nativeWidth}×${nativeHeight} physical pixels. It is captured from the window's own ` +
    "surface, so other windows covering it do not matter.",
  rcptWindowRestored: " It had been minimized and has been restored (without taking focus).",
  rcptWindowShotFooter:
    "Coordinates from THIS image are window pixels, not desktop pixels: do not pass them to computer_click — " +
    "take a normal computer_screenshot (without a window) before clicking.",
  rcptClickSent: (kind, x, y) => `Sent a ${kind} at (${x}, ${y}) on the sandbox desktop.`,
  rcptTypedChars: (chars) => `Typed ${chars} characters into the focused window on the sandbox desktop.`,
  rcptKeyPressed: (key) => `Pressed ${key} on the sandbox desktop.`,
  rcptScrolled: (delta, x, y) =>
    `Scrolled by ${delta} wheel notch(es) at (${x}, ${y}) on the sandbox desktop (positive = down).`,
  rcptAdmission: (verdict, targetExe, tail) =>
    ` Admission (guest-side): "admission":"${verdict}","targetExe":"${targetExe}" — ${tail}.`,
  rcptAdmissionBypassed:
    "the target is outside the sandbox session's own process tree; this turn only observes and logs it " +
    "(nothing is blocked)",
  rcptAdmissionUnknown: "no target window could be resolved at that point",
  rcptAdmissionOwned: "the target belongs to the sandbox session's own browser / process tree",
  rcptDeferred: (waitedMs) =>
    ` It was held back for ${waitedMs}ms first: a person was typing or clicking in the sandbox, and a real ` +
    "user's input takes priority over the agent's, so the action waited until the desktop went quiet. If the " +
    "user keeps working, expect further delays — prefer the lanes that do not take over the desktop " +
    "(sandbox_* browser commands, computer_uia on controls, screenshots of a single window).",
  rcptWindowMinimized: ", minimized",
  rcptUiaActWarningLabel: "Warning: ",
  rcptUiaGoneLine: (controlType, name) =>
    `gone · ${controlType} ${name} — no longer in this window (it has no ref any more)`,
  rcptUiaGoneUnnamed: "(unnamed)",
  rcptCandidates: (rows) =>
    `\n\nWindows you can capture right now: ${rows}. Pass one of these hwnds, or part of one of these titles, as window.`,

  rcptUiaNoTitle: "(no title)",
  rcptUiaItemSupports: "supports",
  rcptUiaItemAt: "at",
  rcptUiaListHead: (title, hwnd, generation, listed, truncated) =>
    `UI Automation controls in window "${title}" (hwnd ${hwnd}, generation ${generation}): ${listed} listed` +
    `${truncated ? " (there are more — raise maxItems to see them)" : ""}. ` +
    'Lines are: ref · control type "name" · supported patterns · position/size · automationId.',
  rcptUiaDiffHead: (title, hwnd, generation, changed, gone, unchanged, moved, since, truncated) =>
    `UI Automation controls in window "${title}" (hwnd ${hwnd}, generation ${generation}): ` +
    `${changed} changed, ${gone} gone, ${unchanged} unchanged${moved > 0 ? `, ${moved} moved only` : ""} ` +
    `since generation ${since}${truncated ? " (there are more — raise maxItems to see them)" : ""}. ` +
    "Only the changes are listed.",
  rcptUiaNoControls: "No actionable controls were found in this window.",
  rcptUiaNothingChanged: "Nothing changed since that list.",
  rcptUiaTail: (generation, diff) =>
    "Act on one with computer_uia (action invoke / setValue / selection, and ref or name). These actions go " +
    "straight into the control: the window does not need the foreground, so the sandbox desktop is not taken " +
    'over and another session can keep using it. There is no "focus" action: to move the keyboard focus, click ' +
    "the target with computer_click (pixels), or just use invoke (it usually focuses too) / setValue (it does " +
    `not need focus). Refs belong to the list they came from (this one is generation ${generation}); a ref from ` +
    "an older list is rejected, so re-list after the window changes. " +
    (diff
      ? "A control that did not change is not listed here: act on it by name, or list again without since to " +
        "get its current ref. "
      : `Next time, pass since=${generation} to get only what changed. `) +
    "Controls that support no pattern above can only be driven through computer_click / computer_type (pixels).",
  rcptUiaPasswordNote: (fields) =>
    ` ${fields} password field(s) are in this window: never put a secret in them and do not try to read them. ` +
    "Their positions are remembered, so screenshots of this window will black them out.",
  rcptUiaEditNote: (fields) =>
    ` This window has ${fields} input field(s) but no password field was recognised: if this is a login page ` +
    "that just opened, its control tree may still be growing — list again a moment later before screenshotting, " +
    "or the password box will not be blacked out yet.",
  rcptUiaNoteLine: (note) => `\nNote: ${note}`,
  rcptUiaItemUnnamed: (automationId) => `(automationId ${automationId})`,
  rcptUiaItemNoPattern: "no pattern (pixels only)",
  rcptUiaStateSeparator: ", ",
  rcptUiaFlagJoiner: ", ",
  rcptUiaFlagPassword: "password",
  rcptUiaFlagDisabled: "disabled",
  rcptUiaFlagOffscreen: "offscreen",
  rcptUiaChangeNew: "new · ",
  rcptUiaChangeChanged: (changed) => `changed (${changed}) · `,
  rcptUiaVerbInvoke: "Invoked",
  rcptUiaVerbSetValue: "Set the text of",
  rcptUiaVerbSelection: "Selected",
  rcptUiaActHead: (action, name, controlType, hwnd, pattern, elapsedMs) =>
    `${action} ${name} (${controlType}) in window hwnd ${hwnd} through UI Automation ` +
    `(pattern ${pattern}, ${elapsedMs}ms). The window did not need the foreground, so the sandbox desktop was ` +
    "not taken over.",
  rcptUiaActUnnamed: "(unnamed control)",
  rcptUiaActFooter: (hwnd) =>
    ` To move the keyboard focus, click the target with computer_click. Take a computer_screenshot (window ${hwnd}) ` +
    "to see what changed.",
  rcptUiaActAutoFocusDefault:
    "AutoSetFocus could not be turned off on this system, so this action may have brought the window to the foreground.",

  rcptCaptureMasked: (fields) =>
    ` ${fields} password ${fields === 1 ? "field" : "fields"} in this image ${fields === 1 ? "was" : "were"} ` +
    "blacked out — a password must never reach you, and the black block is deliberate. Do not try to read it; " +
    "if you need a password, ask the user.",
  rcptCaptureStale: (ageSeconds, ttlSeconds) =>
    " WARNING: this image is NOT masked. The last computer_uia list of what you captured is " +
    `${ageSeconds}s old, and password field positions are only remembered for ${ttlSeconds}s — so if a password ` +
    "field is visible in this image, do not read it. Run computer_uia list on that window again, then take the " +
    "screenshot again.",
  rcptCaptureNotListed:
    " WARNING: this image is NOT masked — nothing has been listed with computer_uia yet, so password fields " +
    "could not be found and covered. If a password field is visible in this image, do not read it. " +
    "Run computer_uia list on that window first, then take the screenshot again.",
  rcptCaptureDesktopLane:
    " This is the desktop lane: it knows password fields only from the last computer_uia list, so a web page " +
    'field already switched to plain text by "show password" before that list is invisible to it — for web ' +
    "pages use sandbox_screenshot, which masks by DOM.",
  rcptCaptureUserTyping:
    " A person was typing in the sandbox while this was captured (their input takes priority over yours), " +
    "so parts of the image may already be out of date.",
  rcptShotMaskUnchecked:
    " Before the capture it skipped the password-field check; this image has not been checked for password fields.",
  rcptShotMaskClean: (frames) => ` Before the capture it checked ${frames} and found no password field to cover.`,
  rcptShotMaskNothingCovered: (frames) => ` Before the capture it checked ${frames} and covered no password field.`,
  rcptShotMaskCovered: (frames, fields) =>
    ` Before the capture it checked ${frames} and covered ${fields} with an opaque overlay.`,
  rcptShotMaskMissing: (list) =>
    ` Frames it could not reach (everything visible inside them is visible in this image): ${list}.`,
  rcptShotMaskBridgeSaid: (error) => ` The bridge said: ${error}`,

  vldBothOrNeither: "Pass both x and y, or neither (neither = the middle of the screen).",
  vldXY: "Pass x and y — pixels in your latest computer_screenshot.",
  vldTextRequired: "text is required (the text to type).",
  vldKeyRequired: "key is required (a key name such as enter / ctrl+a / alt+f4).",
  vldDeltaRequired: "deltaY is required (positive scrolls down).",
  vldSincePositive: "since must be a positive integer: the generation from your last list of that window.",
  vldActionEnum:
    "action must be one of: list, invoke, setValue, selection. To move the keyboard focus, click the target with " +
    "computer_click.",
  vldRefOrName:
    'Pass ref (the token from the latest list of that window, like "g12:r3") or name (part of the control name).',
  vldRefShape:
    'ref is a token copied from the latest list, like "g12:r3" (g = which list of that window, r = position in ' +
    "it). A bare number is not a ref any more: run action list on that window and copy the token.",
  vldUrlRequired: "url is required (the address to open).",
  vldSelectorRequired: "selector is required. Call sandbox_observe first — it lists the selectors that exist on the page.",
  vldPathRequired: "path is required (the host file to upload).",
  vldWaitNeedsSelectorOrMs: "Pass a selector, or ms to just wait. Without either there is nothing to wait for.",
  vldTabsOp: 'op must be "list" or "switch".',
  rcptBrowserShotMissingImage:
    "The sandbox-screenshot reply carried no image (the main process and the contract disagree).",
  vldSetValueNeedsValue: "setValue needs value: the text to write into the control (empty string clears it).",
  rcptNeedsScreenshot: "Call computer_screenshot first: without one there are no image coordinates to convert.",
  rcptWindowOrHwnd:
    "Pass window (part of the target window's title) or hwnd — take one from computer_screenshot or a previous result.",
  rcptPointOutside: (x, y, width, height) =>
    `(${x}, ${y}) is outside the screenshot you last took (${width}×${height} pixels): take a fresh screenshot and ` +
    "use coordinates from that image.",
  rcptTextEmpty: "The text to type is empty.",
  rcptKeyEmpty: "The key name is empty.",
  rcptShotMissingImage: "The screenshot reply carried no image (the main process and the contract disagree).",
  rcptBrowserNoPage:
    "The sandbox browser has not opened any page yet. Call sandbox_navigate with a URL first — that starts Edge, " +
    "and only then do sandbox_observe / sandbox_click work. If CDP cannot start, fall back to the pixel tools " +
    "(computer_screenshot).",
};

/** 回执正文的那一份（zh / en）。认不出的语言按英文，与整张表的兜底一致 */
export function computerUseReceiptTexts(language: string | undefined): ComputerUseReceiptTexts {
  return language === "zh" ? ZH : EN;
}
