/**
 * CompactViz 的纯计算层。单独一个文件是因为它要被 `node --test` 直接加载
 * （`.tsx` 不行，见 AGENTS.md 「相对 import 必须带 .ts 后缀」那条的同一个理由），
 * 也不进 `src/shared/`——那里放两端（主进程与 renderer）共用的契约，这份计算只服务设置页这一个消费者。
 */
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名
import { COMPACTION_PERCENT } from "../../../../shared/settings.ts";

/** 自动压缩的档位（%）。与 COMPACTION_PERCENT 的合法区间 [5,50] 对齐，档距是「一眼分得清」的粒度 */
export const COMPACTION_CHOICES = [30, 25, 20, 15, 10, 5] as const;

/** 标签离右端多近就改成右对齐：再往右居中放，「5% left」会伸出条外 */
const LABEL_END_AT = 88;

/**
 * 上下文条上的折叠点。整条 = 一个上下文窗口，从左往右是对话在累积；
 * 剩余 `percent`% 时折叠，所以折叠点在 `100 - percent` 处。越界夹紧，不假设调用方
 * 已经按 COMPACTION_PERCENT 校验过（导入的旧设置可能是档位之外的值）。
 *
 * `labelAlign`：折叠点的「N% left」标签默认居中压在竖线上；竖线贴近右端时改成
 * 右边对齐竖线，标签整个留在条内。
 */
export function compactMark(percent: number): { at: number; labelAlign: "center" | "end" } {
  const { min, max } = COMPACTION_PERCENT;
  const clamped = Math.min(max, Math.max(min, percent));
  const at = 100 - clamped;
  return { at, labelAlign: at > LABEL_END_AT ? "end" : "center" };
}
