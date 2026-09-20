/**
 * commit / PR 的 Orbita 标识 —— 讲给模型听的一段说明（拼进 system prompt，
 * 同 describePermissionMode 的注入方式）。**纯模块**：不 import electron，
 * 可被 `node --test` 直接加载。
 *
 * 为什么是提示词而不是 git 钩子：提交由模型自己用 bash 发起，message 也由它写。
 * 装 commit-msg 钩子等于替用户改他仓库里的 .git 配置——那是比「留一行 trailer」
 * 重得多的副作用，而且用户当次说「这条别加」时钩子拦不住，模型能。
 */

/** 标识落在哪。写死成常量是为了让「链接改了要改哪」只有一个答案。 */
const ORBITA_URL = "https://github.com/XIAOZF99/orbita";

/**
 * 关 = 空串（调用方按空串跳过这一段，不留空行）。
 *
 * 开时讲三件事，每一件都是实测踩过的：
 * - **trailer 唯一**：模型续写已有 message 时会把 trailer 再抄一遍，于是同一条
 *   commit 里两行 `Made-with`。
 * - **不用 Co-Authored-By、不改 author/committer**：那会把 agent 记成贡献者，
 *   污染 `git shortlog` 与仓库的贡献统计；trailer 只是一行元数据，不参与计数。
 * - **用户当次拒绝优先**：这是偏好不是规则，用户说「这条别加」就不加。
 */
export function gitAttributionGuideline(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "<orbita-git-attribution>",
    "When you create a commit on the user's behalf, append a single `Made-with: Orbita` trailer at " +
      "the end of the commit message. Do not use `Co-Authored-By`, and do not change the author or " +
      "committer — the trailer is metadata, not a contribution record.",
    `When you open a pull request or merge request, append a single \`Made with [Orbita](${ORBITA_URL})\` ` +
      "line at the end of its description.",
    "Both are once per commit and per description: if the text already carries the line, leave it as is " +
      "instead of adding a second one. If the user says not to add it this time, don't.",
    "</orbita-git-attribution>",
  ].join("\n");
}
