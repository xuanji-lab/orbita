/**
 * commit / PR 的 Orbita 标识 —— 讲给模型听的一段说明（拼进 system prompt，
 * 同 describePermissionMode 的注入方式）。**纯模块**：不 import electron，
 * 可被 `node --test` 直接加载。
 *
 * 为什么是提示词而不是 git 钩子：提交由模型自己用 bash 发起，message 也由它写。
 * 装 commit-msg 钩子等于替用户改他仓库里的 .git 配置——那是比「留一行 trailer」
 * 重得多的副作用，而且用户当次说「这条别加」时钩子拦不住，模型能。
 */

import { COMMIT_TRAILER, prAttributionLine } from "../shared/attribution.ts";
import type { Language } from "../shared/settings.ts";

/**
 * 关 = 空串（调用方按空串跳过这一段，不留空行）。
 *
 * 开时讲三件事，每一件都是实测踩过的：
 * - **trailer 唯一**：模型续写已有 message 时会把 trailer 再抄一遍，于是同一条
 *   commit 里两行 `Made-with`。
 * - **不用 Co-Authored-By、不改 author/committer**：那会把 agent 记成贡献者，
 *   污染 `git shortlog` 与仓库的贡献统计；trailer 只是一行元数据，不参与计数。
 * - **用户当次拒绝优先**：这是偏好不是规则，用户说「这条别加」就不加。
 *
 * **署名跟着界面语言走**（`language`，主进程按 effectiveLanguage 算好）：
 * - PR / MR 描述里那一行是给人读的，中文界面就写中文。
 * - commit trailer **键永远是英文**（理由见 shared/attribution.ts 的 COMMIT_TRAILER）。
 * - 去重认两种写法：中英切换过的仓库里，已有的英文行不该再补一行中文。
 */
export function gitAttributionGuideline(enabled: boolean, language: Language = "en"): string {
  if (!enabled) return "";
  const prLine = prAttributionLine(language);
  return [
    "<orbita-git-attribution>",
    `When you create a commit on the user's behalf, append a single \`${COMMIT_TRAILER}\` trailer at ` +
      "the end of the commit message. Do not use `Co-Authored-By`, and do not change the author or " +
      "committer — the trailer is metadata, not a contribution record. Keep the trailer exactly as " +
      "written even when the rest of the message is in another language: git only parses ASCII trailer keys.",
    `When you open a pull request or merge request, append a single \`${prLine}\` line at the end of its description.`,
    "Both are once per commit and per description: if the text already carries the line (in either " +
      `\`${prAttributionLine("en")}\` or \`${prAttributionLine("zh")}\` form), leave it as is instead of adding a second one. ` +
      "If the user says not to add it this time, don't.",
    "</orbita-git-attribution>",
  ].join("\n");
}
