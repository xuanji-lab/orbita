import { createContext } from "react";
import type { ProcessView } from "@shared/settings";

/** 设置 › 过程显示（AppSettings.processView，缺席 = 按块）。App 在根上提供；按块 / 铺开 / 逐步铺开三档，展开后的排法也由它定 */
export const ProcessViewContext = createContext<ProcessView>("chapters");
