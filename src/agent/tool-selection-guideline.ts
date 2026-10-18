/**
 * 工具选型段 + 非编程能力引导（2026-10-18，用户反馈）。
 *
 * **工具选型**：10-04 补上 grep / find / ls 之后，pi 那句「Use bash for file operations」
 * 的触发条件不再成立，但工具「在」不等于模型知道**何时用哪个**——本机真实会话统计：
 * 搜内容用 bash 跑 grep 5,171 次 vs grep 工具 175 次；读文件 sed -n + cat 4,538 次 vs
 * read 2,675 次；bash 里搜索 / 查看类占比修复前 46.6%。这段话就是把默认通道钉死。
 *
 * 内建工具恒在（`permission.ts` 的 ENABLED_BUILTIN_TOOLS 每轮都给 pi），所以这段用
 * **固定文本**、不按工具面条件生成——条件生成要现场取名单，反而多一处会漂的地方。
 *
 * **非编程能力引导**：用户反馈「好像我不明说，你很少这样操作。我都不知道你有这个功能」。
 * 一句话让模型在能力相关而用户可能不知道时主动提一句，而不是默默略过。
 *
 * 分工：runtime 里的 TOOL_GUIDELINES / EXPECTED_SECONDS_GUIDELINE 讲 bash 的**参数**
 * （timeout、expected_seconds），这两段讲**选哪个工具 / 主动提能力**，落点不同、不重复。
 *
 * 单独成模块是为了可测：runtime.ts 顶层有副作用（没有 parentPort 就 exit），测试
 * import 不了它——文案留在那里的数组里就没人能钉住。
 */

/** 选哪个工具：搜索 / 找文件 / 读文件各钉一条默认通道，bash 只跑真命令。 */
export const TOOL_SELECTION_GUIDELINE =
  "Tool selection: use the grep tool to search file contents (not grep/rg via bash), the find tool to " +
  "locate files by name (not find via bash), and the read tool to read files (not cat, head, tail or " +
  "sed -n via bash). Reserve bash/powershell for real commands — builds, tests, git, package managers — " +
  "not for looking at files.";

/**
 * 有相关能力而用户可能不知道时，主动说一句，而不是默默略过。
 * 放在工具选型段末尾（离「怎么用工具」最近）。
 */
export const PROACTIVE_CAPABILITY_GUIDELINE =
  "When a capability you have would help the user but they may not know it exists, say so in one sentence " +
  "rather than staying silent about it.";
