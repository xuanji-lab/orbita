/**
 * CompactViz 的纯计算层。单独一个文件是因为它要被 `node --test` 直接加载
 * （`.tsx` 不行，见 AGENTS.md 「相对 import 必须带 .ts 后缀」那条的同一个理由），
 * 也不进 `src/shared/`——那里放两端（主进程与 renderer）共用的契约，这份计算只服务设置页这一个消费者。
 */
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名
import { COMPACTION_PERCENT } from "../../../../shared/settings.ts";

/** 自动压缩的档位（%）。与 COMPACTION_PERCENT 的合法区间 [5,50] 对齐，档距是「一眼分得清」的粒度 */
export const COMPACTION_CHOICES = [30, 25, 20, 15, 10, 5] as const;

/**
 * 百分比 → 刻度槽上的位置，0 = 左端、1 = 右端。**方向是反的**：左端对应区间
 * 上界（50%，保留量最大，最早触发压缩），右端对应下界（5%，最晚触发）——
 * 槽画的是「什么时候压缩」这件事的时间线，不是百分比数值本身的大小顺序。
 * 越界夹紧，不假设调用方已经按 COMPACTION_PERCENT 校验过。
 */
export function compactPosition(percent: number): number {
  const { min, max } = COMPACTION_PERCENT;
  const clamped = Math.min(max, Math.max(min, percent));
  return (max - clamped) / (max - min);
}
