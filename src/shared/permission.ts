/**
 * 工具调用的命令超时规则（契约层，主进程、agent 与 renderer 共用）。
 *
 * 以前这里是三档权限（plan / manual / skip）的唯一定义与工具分桶；2026-11-16 用户定「只留放行」：
 * 输入框、子会话、自动化都不再有档位，审批卡整套删掉（进度面板里的目标与计划替代了它：能看到、能改、能理解）。
 * 闸门（src/agent/permission.ts）只剩两件与档位无关的事：抬命令超时、拦受保护路径。
 * 剩下的这一份是闸门与 renderer 的「上限」显示共用的超时规则。
 */

/**
 * bash 的 timeout 下限（秒）：模型自填的小值会被闸门抬到这里
 * （只升不降；闸门改的是传进工具的入参对象、不回写会话记录，完整理由见
 * `src/agent/permission.ts`）。**放 shared 是为了 UI 同源**：renderer 的「上限」
 * 显示读的是模型原始入参，不套同一条规则的话，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上——界面对用户撒谎。两边都调下面的 `gatedCommandTimeout`。
 */
export const COMMAND_TIMEOUT_FLOOR_SECONDS = 600;

/**
 * 模型**没填** timeout 时，闸门替它补上的默认上限（秒）。bash 工具没有系统超时，
 * 不填就是一直跑：命令自己卡死（启动脚本等输入、dev server 不退出）时整轮挂住，
 * 只能用户手动停（2026-10-25 任务 461c6fce）。到点杀整棵进程树并把已有输出
 * 连同「Command timed out after 3600 seconds」交回模型。
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
