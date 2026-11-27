/**
 * 「沙箱这次有没有出网」这件事，讲给模型听的三种说法。
 *
 * 背景（独立评审的遗留项）：设置里关掉出网后，沙箱渲染的 .wsb 带
 * `<Networking>Disable</Networking>`，任何页面都打不开。guest 桥从 Chromium 的错误页里
 * 抠出 `ERR_INTERNET_DISCONNECTED`，配的那句人话只能说「沙箱**可能**没有出网」——它看不见
 * 设置，只能猜。于是模型拿到一个含糊的原因，换地址、重试导航，白烧几轮超时。
 *
 * 「关没关」只有主进程知道（settings.computerUse.allowNetwork，经 effectiveAllowNetwork
 * 兑缺省），随开轮命令的 `computerUse` 现场送进来（见 shared/agent-ipc.ts 的
 * ComputerUseTurnContext）。这一层只负责把它翻成模型读得懂的话，**不读设置**：
 * 工具组随会话每轮新建，所以设置一改下一轮的说法就变。
 *
 * **开着出网时三种说法全都退化成空 / 原样**：这时断网错误真的可能是网站挂了、宿主机没网、
 * 或者地址写错，把「设置问题」扣到它们头上就是谎言。零噪音、零改写由
 * computer-network.test.ts 钉着。
 */
import type { ComputerUseTurnContext } from "../shared/agent-ipc.ts";
import { computerUseToolsActive } from "../shared/computer-use-platform.ts";
import {
  COMPUTER_USE_HARD_LIMIT,
  COMPUTER_USE_SOFT_LIMIT,
  COMPUTER_USE_TURN_DEADLINE_MS,
} from "../shared/computer-guard.ts";

/**
 * 工具描述里的一段（`sandbox_*` 的每个描述都拼它，只在关掉出网时）。
 * 写英文是跟其它工具描述一致——模型读工具描述的语言不是用户界面语言。
 */
const SANDBOX_NO_NETWORK =
  "**This sandbox has no outbound network** (Settings › Experimental features › Computer use › Sandbox › " +
  "\"Allow network access\" is off): pages will not load, and that is the setting — not the site, not the URL, " +
  "and not your selectors. Do not retry the navigation or try other addresses, and do not blame the page. " +
  "Desktop and file work in the sandbox is unaffected. If the task really needs the web, ask the user to turn " +
  "that setting on (it applies the next time the sandbox starts) or — only if the user agrees — use the host " +
  "browser_* tools instead.";

/** 失败文案里替换掉「可能」的那句确定性结论（中文，跟 guest 桥回的人话同一种语言） */
const NETWORK_FAILURE_OFF =
  "确定原因（宿主设置，不是猜测）：沙箱当前被设置为**不允许出网**（设置 › 实验功能 › 电脑使用 › " +
  "允许沙箱出网 = 关），所以这个地址打不开——这是设置，不是网站的问题。上面那句「可能没有出网」与「换一个一定能打开的地址试一次」都不用再验证：" +
  "换地址、换站点都是同样的结果，也别改用宿主机浏览器绕过去。要用网络请让用户在设置里打开「允许沙箱出网」（下次启动沙箱时生效）。";

/**
 * 网络类错误码：guest 从浏览器错误页正文或 `Page.navigate` 的 errorText 里抠出来的那几族。
 * 只认这几族——`ERR_ABORTED` / `ERR_HTTP_RESPONSE_CODE_FAILURE` 之类不是「网断了」，
 * 把它们也算进来的话，真正是网站挂了的时候会被我们改口成「设置问题」。
 */
const NETWORK_ERROR_CODES = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_[A-Z_]+/;

/** 关掉出网时，`sandbox_*` 的描述要尾随这一段；开着时是空串（不拼） */
export function sandboxNetworkNote(allowNetwork: boolean): string {
  return allowNetwork ? "" : SANDBOX_NO_NETWORK;
}

/**
 * system prompt 的一段（关掉出网时才讲）。空串会被 runtime 的 filter 滤掉，
 * 所以「开着出网」的轮次里提示词一字不多。
 *
 * 与工具描述那段的分工：描述贴在工具旁边（模型每次挑工具都看得见），这段在提示词里
 * 先讲一次纪律——还没调工具就决定「换个地址再试」的模型，看不到失败文案也看得到它。
 */
export function computerUseNetworkGuideline(computerUse: ComputerUseTurnContext | undefined): string {
  // 工具组没注册（开关关着 / 不是 Windows）：讲出网是废话；缺席（旧夹具）= 什么都不讲
  if (computerUse === undefined || !computerUseToolsActive(computerUse)) return "";
  if (computerUse.allowNetwork) return "";
  return [
    "<orbita-sandbox-network>",
    "The Windows sandbox is set to **no outbound network** (the user turned off Settings › Experimental " +
      "features › Computer use › Sandbox › \"Allow network access\"). Web pages in it will not load: that is " +
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
 * 只在**两件事同时成立**时改口：主进程知道出网被关掉了（allowNetwork === false），
 * 且这条错误真的是网络类（NETWORK_ERROR_CODES）。其余一律原样返回——把「网站 500」
 * 说成「你的设置关了网」比不说更坏，模型会照着错的前提向用户提要求。
 *
 * 原样返回必须是**同一份字符串**：调用点直接抛它，开着出网时模型看到的一个字都不变。
 */
export function networkFailureError(message: string, allowNetwork: boolean): string {
  if (allowNetwork) return message;
  if (!NETWORK_ERROR_CODES.test(message)) return message;
  return `${message}\n\n${NETWORK_FAILURE_OFF}`;
}
