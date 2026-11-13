import { createContext } from "react";
import type { BackgroundStripStyle } from "@shared/settings";

/** 设置 › 后台任务条（AppSettings.backgroundStrip，缺席 = 细条）。App 在根上提供 */
export const BackgroundStripStyleContext = createContext<BackgroundStripStyle>("line");
