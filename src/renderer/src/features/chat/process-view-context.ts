import { createContext } from "react";
import type { ProcessLayout, ProcessView } from "@shared/settings";

/** 设置 › 过程显示（AppSettings.processView，缺席 = 一轮一行）。App 在根上提供 */
export const ProcessViewContext = createContext<ProcessView>("turn");

/** 设置 › 一轮一行展开之后的排法（AppSettings.processLayout，缺席 = 按段）与改它的入口。App 在根上提供 */
export const ProcessLayoutContext = createContext<{ layout: ProcessLayout; setLayout: (next: ProcessLayout) => void }>({
  layout: "chapters",
  setLayout: () => undefined,
});
