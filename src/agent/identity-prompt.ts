/**
 * 身份段（2026-10-18 用户反馈）：模型不知道自己叫什么、在什么产品里干活——问它名字
 * 只能从工作目录名猜。这里补上产品身份。
 *
 * 位置：拼在 pi 基底（已过 adaptSystemPrompt）之后、权限段之前。顺序契约由
 * ./system-prompt.ts 的 composeSystemPrompt 集中保证（那边**恒定**拼这一段，
 * 调用方不需要、也无法漏掉它）。
 *
 * **一句话、英文写**（2026-10-18 合作者评审裁决）：
 * - 不放「危险操作先确认」那一句。权限模式段（./permission.ts 的 describePermissionMode）
 *   逐轮重讲当前档位下每个工具是直接跑 / 先问 / 直接拒——同一件事写两处，模型读到两个
 *   口径（身份段说一律先确认、权限段说 skip 档直接跑）就是自相矛盾；而且那类话属权限
 *   范畴，改口径时只该改一处。
 * - 不写「编程助手」（coding assistant）。用户大量拿它读论文、做研究，把自己限定成编码
 *   助手会让模型在非编程请求上自我设限（参考 pi 基底那句 "expert coding assistant" 正是
 *   我们不再复述它的原因）。用笼统的 "desktop AI agent"。
 * - 产品中文名「璇玑」必须出现：中文用户问「你叫什么」时，模型得知道璇玑就是它，
 *   而不是从工作目录名猜。整段仍是英文，中文名只在括号里出现一次，避免把回复语言
 *   往中文带——REPLY_LANGUAGE_GUIDELINE 恒定放最末是第二道保险。
 */
export const ORBITA_IDENTITY_GUIDELINE = "You are Orbita (璇玑), a local-first desktop AI agent.";
