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
 */
export const COMMIT_TRAILER = "Made-with: Orbita";

/** PR / MR 描述末尾那一行（markdown）。给人读的，跟界面语言走 */
export function prAttributionLine(language: Language): string {
  return language === "zh" ? `使用 [Orbita](${ORBITA_URL}) 制作` : `Made with [Orbita](${ORBITA_URL})`;
}
