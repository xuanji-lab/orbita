import { createContext, useContext } from "react";
import type { OfmEnv } from "./ofm-env.ts";

/** 阅读视图里的双链 / 图片组件读到的文档环境（react-markdown 的组件拿不到自定义 prop，只能走 context） */
export const OfmEnvContext = createContext<OfmEnv | null>(null);

export function useOfmEnv(): OfmEnv | null {
  return useContext(OfmEnvContext);
}
