/**
 * Claude 订阅（OAuth）请求里自报的 Claude Code 版本——全应用只有这一个口径。
 *
 * 用在三处，必须同一个值：
 * - agent 真会话：pi-ai 的 `claudeCodeVersion`（user-agent `claude-cli/<v>`），
 *   由 patches/@earendil-works%2Fpi-ai@0.84.3.patch 改写；
 * - agent 真会话的计费头 `x-anthropic-billing-header: cc_version=<v>.000`（cc-billing-patch.ts）；
 * - 主进程「测试连接 / 发现模型」的请求头（provider/oauth.ts）。
 * 同一应用一种请求报一个版本、另一种报另一个，本身就是「不是 Claude Code」的信号；
 * 版本过低时新型号直接拒（opus-5-5 曾拒 2.1.261 以下，报 claude_code_version_too_old）。
 *
 * 升级：取 npm `@anthropic-ai/claude-code` 的 latest，与上游 pi
 * （packages/ai/src/api/anthropic-messages.ts 的 claudeCodeVersion）对照，三处一起改；
 * claude-code-version.test.ts 会核对补丁后的 pi-ai 与这里一致。
 */
export const CLAUDE_CODE_VERSION = "2.1.322";
