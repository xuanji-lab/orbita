import { createContext } from "react";
import type { ProcessView } from "@shared/settings";

/** 设置 › 过程显示（AppSettings.processView，缺席 = 一轮一行）。App 在根上提供 */
export const ProcessViewContext = createContext<ProcessView>("turn");
