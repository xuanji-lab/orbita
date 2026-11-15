/**
 * commit / PR 署名的字面量。**两个消费者**：agent 进程讲给模型的说明（git-attribution.ts）
 * 与设置页的效果预览（写出会追加的那两行）——两边必须是同一句话，各写一份迟早对不上。
 */
import type { Language } from "./settings.ts";

/** 标识落在哪。写死成常量是为了让「链接改了要改哪」只有一个答案。 */
export const ORBITA_URL = "https://github.com/XIAOZF99/orbita";

/**
 * commit trailer。**不随语言变**：git 只把 ASCII 键认作 trailer——`制作工具: Orbita` 在
 * `git interpret-trailers --parse` 里什么都解析不出来（2026-09-25 实测），
 * `git log --format=%(trailers)` 也就看不见它。trailer 是给工具读的元数据。
 *
 * 2026-11-15 用户裁决：从自造的 `Made-with` 换成标准的 `Co-authored-by`，收件人是 Orbita 的
 * bot 账号——GitHub 的 commit 页与参与者列表只认这个键，`Made-with` 在那边是一行没人读的文字。
 * 代价是它会被算进共作者/贡献统计（这正是用户要的效果：提交页能点进 bot 账号）。
 * 地址是 bot 的 noreply 形式，保号在 bot 账号上，不落到某个人的邮箱。
 */
export const COMMIT_TRAILER =
  "Co-authored-by: Orbita <356826154+xuanji-orbita[bot]@users.noreply.github.com>";

/**
 * 旧写法，只用于去重：中英/新旧混着提交过的仓库里，一条 message 不该新旧各一行。
 * **不要拿去加**——新提交一律用 COMMIT_TRAILER。
 */
export const LEGACY_COMMIT_TRAILER = "Made-with: Orbita";

/** PR / MR 描述末尾那一行（markdown）。给人读的，跟界面语言走 */
export function prAttributionLine(language: Language): string {
  return language === "zh" ? `使用 [Orbita](${ORBITA_URL}) 制作` : `Made with [Orbita](${ORBITA_URL})`;
}
