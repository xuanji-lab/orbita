/**
 * 「沙箱这次有没有出网」这件事，讲给模型听的说法。
 *
 * 背景（独立评审的遗留项）：设置里关掉出网后，沙箱渲染的 .wsb 带
 * `<Networking>Disable</Networking>`，任何页面都打不开。guest 桥从 Chromium 的错误页里
 * 抠出 `ERR_INTERNET_DISCONNECTED`，配的那句人话只能说「沙箱**可能**没有出网」——它看不见
 * 设置，只能猜。于是模型拿到一个含糊的原因，换地址、重试导航，白烧几轮超时。
 *
 * 这里的输入是**两个事实**，不是一个：
 *   allowNetwork        用户选了什么（settings.computerUse.allowNetwork，经 effectiveAllowNetwork 兑缺省）；
 *   networkControlled   这个后端能不能真的把出网关掉（backendNetworkControl，见 shared/computer-use.ts）。
 * 两个都随开轮命令的 `computerUse` 现场送进来（见 shared/agent-ipc.ts 的
 * ComputerUseTurnContext）。这一层只负责把它们翻成模型读得懂的话，**不读设置**：
 * 工具组随会话每轮新建，所以设置一改下一轮的说法就变。
 *
 * 三种情形，一一对应：
 *   开关开着                     → 什么都不讲（零噪音）：此刻断网只能用网站 / 宿主 / 地址解释；
 *   关着 **且** 后端做得到         → 「你没有出网，这是设置，不是网站」；
 *   关着 **但** 后端做不到         → 「用户要求断网，但这个后端断不了」——既不能让模型以为
 *                                  自己没网（它会拿着错的前提回答），也不能装作开关生效了。
 * 第二段与第三段的区分就靠 networkControlled 这一格；以前没有它，L2b 上说的全是第二段。
 */
import type { ComputerUseTurnContext } from "../shared/agent-ipc.ts";
import { computerUseToolsActive } from "../shared/computer-use-platform.ts";
import {
  COMPUTER_USE_HARD_LIMIT,
  COMPUTER_USE_SOFT_LIMIT,
  COMPUTER_USE_TURN_DEADLINE_MS,
} from "../shared/computer-guard.ts";

/**
 * 一个后端对「关掉出网」这两个事实的组合。两个布尔相邻传参太容易写反（`f(false, true)`
 * 与 `f(true, false)` 都是合法调用），所以成对传，名字跟着事实走。
 */
export interface SandboxNetworkFacts {
  /** 用户选了什么：false = 设置里关了「允许沙箱出网」 */
  allowNetwork: boolean;
  /** 这个后端能不能真的兑现：false = 关了也不起作用（L2b） */
  networkControlled: boolean;
}

/**
 * 出网确实被关掉了——**两个事实同时成立**才算。单看开关开着 / 关着都不够：
 * 关着但后端做不到时，说「你没网」是一句假话，比不说更坏。
 */
function outboundNetworkIsOff(facts: SandboxNetworkFacts): boolean {
  return facts.allowNetwork === false && facts.networkControlled;
}

/**
 * 工具描述里的一段（`sandbox_*` 的每个描述都拼它）。
 * 写英文是跟其它工具描述一致——模型读工具描述的语言不是用户界面语言。
 */
const SANDBOX_NO_NETWORK =
  "**This sandbox has no outbound network** (Settings › Computer use › " +
  "\"Allow network access\" is off): pages will not load, and that is the setting — not the site, not the URL, " +
  "and not your selectors. Do not retry the navigation or try other addresses, and do not blame the page. " +
  "Desktop and file work in the sandbox is unaffected. If the task really needs the web, ask the user to turn " +
  "that setting on (it applies the next time the sandbox starts) or — only if the user agrees — use the host " +
  "browser_* tools instead.";

/**
 * 开关关着、但这个后端断不了网时的那句话（L2b）。**短、且不声称任何它做不到的事**：
 * 不说「你没有出网」（它其实在用户本机的网络上），也不说「设置生效了」（没生效）。
 * 只讲三件真事：用户的要求、这台机器能否断网、以及由此该怎么做事。
 */
const SANDBOX_NETWORK_UNCONTROLLED =
  "The user turned off Settings › Computer use › Sandbox › \"Allow network access\", " +
  "but this isolation backend runs in a separate logon session on the user's own computer and cannot block " +
  "its network — assume the machine's network is reachable. Don't browse unless the task needs it.";

/**
 * 失败文案里替换掉「可能」的那句确定性结论。
 *
 * 2026-11-28 起两种语言各一份：回执是给用户看的（模型也读），中文界面里挂一段英文（或反过来）
 * 都是夹生字。中文那份以前就是这里的中文常量。
 */
const NETWORK_FAILURE_OFF_ZH =
  "确定原因（宿主设置，不是猜测）：沙箱当前被设置为不允许出网（设置 › 电脑使用 › " +
  "允许沙箱出网 = 关），所以这个地址打不开——这是设置，不是网站的问题。不要换地址、不要换站点，" +
  "也不要改用宿主机浏览器绕过去：结果会一样。要用网络请让用户在设置里打开「允许沙箱出网」" +
  "（下次启动沙箱时生效）。";

const NETWORK_FAILURE_OFF_EN =
  "That is the cause (a host setting, not a guess): this sandbox is set to have no outbound network " +
  "(Settings › Computer use › Allow network access is off), so this address cannot load — it is the setting, " +
  "not the site. Do not try other addresses or other sites, and do not route around it with the host browser: " +
  "the result will be the same. If the task needs the web, ask the user to turn that setting on (it applies the " +
  "next time the sandbox starts).";

/**
 * guest 桥那句通用的「怎么确认」建议（guest-bridge/Cdp.cs 的 NavErrorMessage，两份代码各一份）。
 * 出网确定被关掉时它是**错的建议**：换地址只会再失败一次。改写时必须先把它摘掉再追加权威
 * 结论——两段话一正一反摆在一起，模型更容易照第一段做（2026-11-27 真机验收顺手项）。
 * 桥不重编也能生效：摘的是回执文本，与桥的二进制无关。
 */
const GUEST_CONFIRM_ADVICE =
  "确认方式：换一个一定能打开的地址试一次；如果所有站点都是这个错，那是网络的问题，不是这一页的问题。";

/**
 * 网络类错误码：guest 从浏览器错误页正文或 `Page.navigate` 的 errorText 里抠出来的那几族。
 * 只认这几族——`ERR_ABORTED` / `ERR_HTTP_RESPONSE_CODE_FAILURE` 之类不是「网断了」，
 * 把它们也算进来的话，真正是网站挂了的时候会被我们改口成「设置问题」。
 */
const NETWORK_ERROR_CODES = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_[A-Z_]+/;

/** 工具描述要尾随的那一段；不需要拼时是空串（调用方原样返回，零变化） */
export function sandboxNetworkNote(facts: SandboxNetworkFacts): string {
  if (outboundNetworkIsOff(facts)) return SANDBOX_NO_NETWORK;
  // 关着但断不了网：一句短话，钉住「用户要求断网 / 这个后端做不到」两个事实
  if (facts.allowNetwork === false) return SANDBOX_NETWORK_UNCONTROLLED;
  return "";
}

/**
 * system prompt 的一段（出网确实被关掉时才讲）。空串会被 runtime 的 filter 滤掉，
 * 所以「开着出网」的轮次里提示词一字不多。
 *
 * 与工具描述那段的分工：描述贴在工具旁边（模型每次挑工具都看得见），这段在提示词里
 * 先讲一次纪律——还没调工具就决定「换个地址再试」的模型，看不到失败文案也看得到它。
 */
export function computerUseNetworkGuideline(computerUse: ComputerUseTurnContext | undefined): string {
  // 工具组没注册（开关关着 / 不是 Windows）：讲出网是废话；缺席（旧夹具）= 什么都不讲
  if (computerUse === undefined || !computerUseToolsActive(computerUse)) return "";
  if (computerUse.allowNetwork) return "";
  if (!computerUse.networkControlled) {
    // 关着但后端断不了网（L2b）：一句诚实的短话。**不说**「你没有出网」——那是假的。
    return ["<orbita-sandbox-network>", SANDBOX_NETWORK_UNCONTROLLED, "</orbita-sandbox-network>"].join("\n");
  }
  return [
    "<orbita-sandbox-network>",
    "This sandbox is set to **no outbound network** (the user turned off Settings › Computer use › " +
      "\"Allow network access\"). Web pages in it will not load: that is " +
      "the setting, not the site. Do not retry a failed sandbox_navigate, do not try other URLs to see whether " +
      "the network is back, and do not silently move the same web task to another tool. Tell the user the " +
      "sandbox has no network and that turning it on applies the next time the sandbox starts. Local desktop " +
      "and file work in the sandbox is unaffected — keep using computer_* and the mapped folders for that.",
    "</orbita-sandbox-network>",
  ].join("\n");
}

/**
 * 「每轮动作预算」讲给模型听的一段（system prompt，只在电脑使用工具组注册时拼）。
 * 数字与闸门同源（shared/computer-guard.ts 的常量 + agent/permission.ts 的计数）：
 * 提示词说一套、闸门做一套，模型就会在撞墙前低估墙的位置。「只留放行」之后这是
 * 沙箱写动作仅剩的硬护栏——预算与急停都不问人，越线直接挡下 / 断轮。
 */
export function computerUseBudgetGuideline(): string {
  return [
    "<orbita-computer-use-budget>",
    "Computer use: each turn has an action budget — the first " + COMPUTER_USE_SOFT_LIMIT +
      " computer_*/sandbox_* calls run; beyond that they are blocked with a message until the turn’s " +
      COMPUTER_USE_HARD_LIMIT + "th call or " + Math.round(COMPUTER_USE_TURN_DEADLINE_MS / 60000) +
      " minutes since the first one, which aborts the turn. When the soft limit is hit, do not retry — " +
      "summarize what is left for the user instead. The budget resets every turn.",
    "</orbita-computer-use-budget>",
  ].join("\n");
}

/**
 * 失败回执里的一句人话 → 给模型看的那句。
 *
 * 只在**三件事同时成立**时改口：主进程知道出网被关掉了（allowNetwork === false）、
 * 这个后端真的做得到（networkControlled === true）、且这条错误真的是网络类
 * （NETWORK_ERROR_CODES）。其余一律原样返回——把「网站 500」说成「你的设置关了网」比
 * 不说更坏，模型会照着错的前提向用户提要求；L2b 上把「可能没网」改成「确定没网」同理。
 *
 * 原样返回必须是**同一份字符串**：调用点直接抛它，开着出网时模型看到的一个字都不变。
 */
export function networkFailureError(
  message: string,
  facts: SandboxNetworkFacts,
  uiLanguage: "zh" | "en" = "en",
): string {
  if (!outboundNetworkIsOff(facts)) return message;
  if (!NETWORK_ERROR_CODES.test(message)) return message;
  // 先摘掉 guest 那句「换一个一定能打开的地址试一次」，再追加确定结论：留它在前面就是自相矛盾
  //（换地址必然再失败一次），而模型先读到的往往是第一段。桥那句是中文（桥不跟语言走）：
  // 中文界面下摘得掉；英文界面下桥的回执已被宿主映射成英文，那句不会出现——两种情形都不留矛盾。
  const cleaned = message.split(GUEST_CONFIRM_ADVICE).join("");
  const conclusion = uiLanguage === "zh" ? NETWORK_FAILURE_OFF_ZH : NETWORK_FAILURE_OFF_EN;
  // 两句之间空一行（与 guest 回执的排版一致）：用 join 而不是模板串，免得换行符被编辑器吃掉
  return [cleaned, conclusion].join(String.fromCharCode(10, 10));
}