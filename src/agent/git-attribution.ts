/**
 * commit / PR 的 Orbita 标识 —— 讲给模型听的一段说明（拼进 system prompt，
 * 同 describePermissionMode 的注入方式）。**纯模块**：不 import electron，
 * 可被 `node --test` 直接加载。
 *
 * 为什么是提示词而不是 git 钩子：提交由模型自己用 bash 发起，message 也由它写。
 * 装 commit-msg 钩子等于替用户改他仓库里的 .git 配置——那是比「留一行 trailer」
 * 重得多的副作用，而且用户当次说「这条别加」时钩子拦不住，模型能。
 */

import { COMMIT_TRAILER, LEGACY_COMMIT_TRAILER, prAttributionLine } from "../shared/attribution.ts";
import type { Language } from "../shared/settings.ts";

/**
 * 关 = 空串（调用方按空串跳过这一段，不留空行）。
 *
 * 开时讲四件事，每一件都是实测踩过的：
 * - **trailer 唯一**：模型续写已有 message 时会把 trailer 再抄一遍，于是同一条
 *   commit 里两行署名；老会话留下的 `Made-with: Orbita` 也算已经有了，不再补新的一行。
 * - **一行 co-author，不改 author/committer**：署名位置是 `Co-authored-by`（GitHub 按它认
 *   bot 账号），`Author:` / `Committer:` 仍是用户自己。
 * - **一字不改**：邮箱与键都是机器读的，抄错一个字符 GitHub 就不认那个人了。
 * - **用户当次拒绝优先**：这是偏好不是规则，用户说「这条别加」就不加。
 *
 * **署名跟着界面语言走**（`language`，主进程按 effectiveLanguage 算好）：
 * - PR / MR 描述里那一行是给人读的，中文界面就写中文。
 * - commit trailer **永远是英文**（理由见 shared/attribution.ts 的 COMMIT_TRAILER）。
 * - 去重认两种写法：中英切换过的仓库里，已有的英文行不该再补一行中文。
 */
export function gitAttributionGuideline(enabled: boolean, language: Language = "en"): string {
  if (!enabled) return "";
  const prLine = prAttributionLine(language);
  return [
    "<orbita-git-attribution>",
    `When you create a commit on the user's behalf, append a single \`${COMMIT_TRAILER}\` trailer as the ` +
      "last line of the commit message. Keep that line exactly as written — the key and the address are " +
      "read by GitHub, not by humans — even when the rest of the message is in another language. Do not " +
      "add a second co-author line, and do not change the author or committer.",
    `When you open a pull request or merge request, append a single \`${prLine}\` line at the end of its description.`,
    "Both are once per commit and per description: if the text already carries the line (in either " +
      `\`${prAttributionLine("en")}\` or \`${prAttributionLine("zh")}\` form), leave it as is instead of adding a second one. ` +
      `A commit message that already ends with the legacy \`${LEGACY_COMMIT_TRAILER}\` trailer (written by ` +
      "older sessions) counts as already signed too — leave it alone. " +
      "If the user says not to add it this time, don't.",
    "</orbita-git-attribution>",
  ].join("\n");
}
