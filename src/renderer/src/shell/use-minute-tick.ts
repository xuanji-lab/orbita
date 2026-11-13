import { useEffect, useState } from "react";

/**
 * 每分钟让调用方重渲染一次（返回值是递增计数，调用方不必读）。
 *
 * 为什么要有：左栏行尾的「刚刚 / N 分钟」和时间范围筛选都按 Date.now() 在渲染时现算，
 * 列表因别的原因重渲染时自然纠正；但窗口一直挂着、什么都没发生时，「刚刚」会一直停在那。
 * 一分钟一拍已够（最细的刻度是分钟），不为它每秒刷。窗口藏起来时不拍（后台白白重渲染一整棵
 * 会话列表没有意义），回到前台立刻补一拍。
 */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1);
    const timer = window.setInterval(() => {
      if (!document.hidden) bump();
    }, 60_000);
    const onVisible = (): void => {
      if (!document.hidden) bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return tick;
}
