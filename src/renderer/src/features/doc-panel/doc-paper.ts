import { createContext, useContext } from "react";
import type { DocPaper } from "@shared/settings";

/**
 * 文档 / 演示文稿面板当前的「纸面」。App 从 settings 读、按主题折算后提供：
 * 纸面主题（Copybook / Typescript）自己就是一张稿纸，再叠一层纸面没有意义——那时恒为 quiet 并
 * `locked`，切换控件灰掉。浅色与玄（以及黛）下三套都成立。
 */
export interface DocPaperState {
  paper: DocPaper;
  locked: boolean;
  setPaper: (paper: DocPaper) => void;
}

export const DocPaperContext = createContext<DocPaperState>({
  paper: "quiet",
  locked: false,
  setPaper: () => undefined,
});

export function useDocPaper(): DocPaperState {
  return useContext(DocPaperContext);
}

/** 设置里的值 + 当前主题 → 生效的纸面（纯函数，单测钉） */
export function effectivePaper(
  saved: DocPaper | undefined,
  theme: "light" | "graphite" | "black" | "copybook" | "typescript",
): { paper: DocPaper; locked: boolean } {
  if (theme === "copybook" || theme === "typescript") return { paper: "quiet", locked: true };
  return { paper: saved ?? "quiet", locked: false };
}
