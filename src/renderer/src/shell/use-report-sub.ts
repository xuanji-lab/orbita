import { useEffect, useRef } from "react";

/**
 * 面板把「自己停在哪一层」报给 App（右栏按会话记忆的受控 sub，见 right-panel-memory.ts）。
 *
 * 只在**内容变了**时报（按 JSON 比，不按引用）：面板每次渲染都会现算一份 sub，报的次数
 * 不能跟渲染次数走。回调放进 ref——调用方传内联箭头函数也不会让它重新报。
 * 挂载那一拍会报一次初值：App 端内容没变就不更新状态，所以不会造成多余渲染。
 */
export function useReportSub<S>(sub: S, onSubChange: ((sub: S) => void) | undefined): void {
  const callback = useRef(onSubChange);
  callback.current = onSubChange;
  const key = JSON.stringify(sub ?? null);
  useEffect(() => {
    callback.current?.(sub);
    // sub 的内容由 key 代表；对象引用每次渲染都新，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
