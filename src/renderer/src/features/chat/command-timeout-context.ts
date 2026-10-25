/**
 * 命令超时的三档策略（设置项 `commandTimeoutMaxSeconds` 推导，见 shared 的
 * `commandTimeoutPolicy`）。
 *
 * **为什么走 Context 而不是逐级透传 props**：消费点只有工具行里的「/ 上限 30:00」
 * 这一处，但它坐在 ChatView → EntryView → ToolGroupLine → ToolLine 这条很深的链上，
 * 为一个小数字给每一层加一个参数，等于让每一层都知道「命令超时有策略」这件事。
 *
 * 兜底值是**出厂策略**（与 `timeoutSecondsOf` 的默认参数一致）：App 之外单独渲染
 * ToolLine 的场景（组件测试、未来的示例页）不会因为缺 Provider 报错。
 */
import { createContext } from "react";
import { commandTimeoutPolicy, type CommandTimeoutPolicy } from "../../../../shared/permission.ts";

export const CommandTimeoutPolicyContext = createContext<CommandTimeoutPolicy>(commandTimeoutPolicy());
