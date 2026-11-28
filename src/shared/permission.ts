/**
 * 工具调用的命令超时规则（契约层，主进程、agent 与 renderer 共用）。
 *
 * 以前这里是三档权限（plan / manual / skip）的唯一定义与工具分桶；2026-11-16 用户定「只留放行」：
 * 输入框、子会话、自动化都不再有档位，审批卡整套删掉（进度面板里的目标与计划替代了它：能看到、能改、能理解）。
 * 闸门（src/agent/permission.ts）只剩两件与档位无关的事：抬命令超时、拦受保护路径。
 * 剩下的这一份是闸门与 renderer 的「上限」显示共用的超时规则。
 *
 * 电脑使用（2026-11 自 cu/full 移植）在这里只保留**工具名单与分档**：谁是只读件、
 * 谁是写件、写件能否逸出沙箱。它们不再驱动任何档位判定（档位已删），消费者是
 * 每轮预算计数（src/agent/permission.ts 的闸门）、系统提示的讲述条件与分类测试——
 * 名单漏一个，那个工具就同时绕过预算与提示词口径（computer-gate.test.ts 表驱动核对）。
 */

/**
 * bash / powershell 的 timeout 下限（秒）：模型自填的小值会被闸门抬到这里
 * （只升不降；闸门改的是传进工具的入参对象、不回写会话记录，完整理由见
 * `src/agent/permission.ts`）。**放 shared 是为了 UI 同源**：renderer 的「上限」
 * 显示读的是模型原始入参，不套同一条规则的话，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上——界面对用户撒谎。两边都调下面的 `gatedCommandTimeout`。
 */
export const COMMAND_TIMEOUT_FLOOR_SECONDS = 600;

/**
 * 模型**没填** timeout 时，闸门替它补上的默认上限（秒）。pi 的 bash 工具没有系统超时，
 * 不填就是一直跑：命令自己卡死（启动脚本等输入、dev server 不退出）时整轮挂住，
 * 只能用户手动停（2026-10-25 任务 461c6fce）。到点由工具杀整棵进程树并把已有输出
 * 交回模型。
 *
 * 取 1 小时而不是更短（2026-10-30 用户拍板）：工具指引让模型跑依赖安装 / 构建 /
 * 测试时**别传** timeout，上限太短就会误杀正常的长命令；真要跑更久的，模型显式
 * 传更大的值，闸门尊重。
 */
export const COMMAND_TIMEOUT_DEFAULT_SECONDS = 3600;

/**
 * 闸门落到入参上的 timeout——闸门（改入参）与 renderer 的「上限」显示（读原始入参）
 * 共用这一条规则，同一个数不许有两处真源：
 * - 不填（undefined）→ 默认上限 `COMMAND_TIMEOUT_DEFAULT_SECONDS`；
 * - 有限正数且小于下限 → 抬到 `COMMAND_TIMEOUT_FLOOR_SECONDS`；
 * - 其余原样返回：填得比下限大是模型自己的判断；非法值（≤ 0、非有限数、字符串、null）
 *   不在这里修，工具自己会报「Invalid timeout」，不替它做第二套校验。
 */
export function gatedCommandTimeout(raw: unknown): unknown {
  if (raw === undefined) return COMMAND_TIMEOUT_DEFAULT_SECONDS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return raw;
  if (raw > 0 && raw < COMMAND_TIMEOUT_FLOOR_SECONDS) return COMMAND_TIMEOUT_FLOOR_SECONDS;
  return raw;
}

/**
 * computer use 的只读件：`computer_screenshot`（沙箱桌面）+ `sandbox_observe` /
 * `sandbox_extract` / `sandbox_screenshot` / `sandbox_wait`（沙箱里的网页）。
 *
 * 它们只向沙箱要图 / 要文本，不往沙箱里送任何输入，也不碰用户的文件与 shell。
 * `sandbox_wait` 只是等某个选择器出现（或等一段时间），不改变页面、不注入输入。
 * 名单同时是预算口径的一部分（读件也吃上下文，见 `isComputerUseTool`）。
 */
export const COMPUTER_USE_READ_TOOLS = [
  "computer_screenshot",
  "sandbox_observe",
  "sandbox_extract",
  "sandbox_screenshot",
  "sandbox_wait",
] as const;

export function isComputerUseReadTool(toolName: string): boolean {
  return (COMPUTER_USE_READ_TOOLS as readonly string[]).includes(toolName);
}

/**
 * computer use 写件的**档**：按「副作用能不能逸出沙箱」分两档。
 *
 * 判据（一句话）：**扔进一次性 VM 就消失的副作用 = 沙箱内；把宿主的东西带进 / 带出这道
 * 边界的 = 逸出。** 沙箱是一次性的完整 VM，VM 销毁之后沙箱里点过的按钮、打过的字、改过的
 * 页面都不复存在；而 `sandbox_upload` 把用户宿主机的文件内容读进沙箱交给一个网页、
 * `sandbox_download` 把沙箱里的下载物落进宿主的下载目录——这两件的结果跨过了边界，
 * 不会随着 VM 消失。
 *
 * 「只留放行」之后，这个分档**不再驱动确认流程**（没有审批卡），保留的理由有二：
 * 1. 它是写桶内部分的**唯一真源**——预算与桌面租约口径按名单走，漏归类会当场被
 *    `src/agent/computer-gate.test.ts` 的表驱动核对抓红（名单真源 =
 *    `COMPUTER_USE_TOOL_NAMES` + `SANDBOX_BROWSER_TOOL_NAMES`）；
 * 2. 若日后要给逸出件重新立一道**非档位**的确认（如工具内原生的文件进出确认），
 *    判据已经写在这里，不用重新裁决。
 */
export const COMPUTER_USE_WRITE_TIERS = {
  /** 副作用留在一次性 VM 里：VM 一扔就没了 */
  confined: [
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_scroll",
    "sandbox_navigate",
    "sandbox_click",
    "sandbox_type",
    /**
     * sandbox_tabs 是 list / switch 两个参数动作：list 只读、switch 换活动标签页（仍在 VM 里）。
     * 与 computer_uia 同一条口径——**名单是工具级的、不含参数**，所以整体算写件。
     * 它此前不在这两档里（名单是后加工具时漏的），于是同时绕过了预算与急停口径；
     * 分类测试（computer-gate.test.ts）就是为了让下一次漏归类当场红。
     */
    "sandbox_tabs",
    "computer_uia",
  ],
  /** 能把宿主的东西带进 / 带出沙箱：结果不随 VM 消失 */
  escaping: ["sandbox_upload", "sandbox_download"],
} as const;

/** 沙箱内的写件（像素四件 + 网页导航 / 点击 / 打字 + UIA 动作） */
export const COMPUTER_USE_CONFINED_WRITE_TOOLS = COMPUTER_USE_WRITE_TIERS.confined;

/** 能逸出沙箱的写件：上传（宿主 → 沙箱）与下载（沙箱 → 宿主） */
export const COMPUTER_USE_ESCAPING_WRITE_TOOLS = COMPUTER_USE_WRITE_TIERS.escaping;

/**
 * computer use 的写件：**凡能改变沙箱状态、往沙箱里送输入、或让文件进出的工具**都在这里。
 * 名单按「有没有副作用」判，不按车道判——像素（computer_*）、网页 CDP（sandbox_*）、
 * UIA（computer_uia）三条车道的写动作同一待遇；内部再按能否逸出分两档（判据见上）。
 * 像素组与沙箱浏览器组各有一份工具名真源（computer-tools.ts / sandbox-tools.ts），
 * 这里是跨车道的汇总口径（预算、审计与分类测试读它）。
 */
export const COMPUTER_USE_WRITE_TOOLS = [
  ...COMPUTER_USE_CONFINED_WRITE_TOOLS,
  ...COMPUTER_USE_ESCAPING_WRITE_TOOLS,
] as const;

export function isComputerUseWriteTool(toolName: string): boolean {
  return (COMPUTER_USE_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 这件写工具能不能逸出沙箱。只在这里认一次名字，别在别处重新列一遍名单。
 * 不是写件返回 false（读件与无关工具都不进逸出口径）。
 */
export function isComputerUseEscapingTool(toolName: string): boolean {
  return (COMPUTER_USE_ESCAPING_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/** 写件的档；不是 computer use 写件返回 null（调用方据此区分「不在写桶里」与「逸出档」） */
export function computerUseWriteTier(toolName: string): "confined" | "escaping" | null {
  if (isComputerUseEscapingTool(toolName)) return "escaping";
  if ((COMPUTER_USE_CONFINED_WRITE_TOOLS as readonly string[]).includes(toolName)) return "confined";
  return null;
}

/** 工具组全体（读取 + 写入）：预算按这个口径计——截图也吃上下文，必须计入 */
export function isComputerUseTool(toolName: string): boolean {
  return isComputerUseReadTool(toolName) || isComputerUseWriteTool(toolName);
}
