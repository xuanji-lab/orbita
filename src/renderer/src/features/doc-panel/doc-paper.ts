import { createContext, useContext } from "react";
import type { DocPaper } from "@shared/settings";

/** 文档 / 演示文稿面板当前的「纸面」：只由自己的设置决定，与应用主题无关。 */
export interface DocPaperState {
  paper: DocPaper;
  setPaper: (paper: DocPaper) => void;
}

export const DocPaperContext = createContext<DocPaperState>({
  paper: "quiet",
  setPaper: () => undefined,
});

export function useDocPaper(): DocPaperState {
  return useContext(DocPaperContext);
}

/** 设置里的值 → 生效纸面；缺席 = quiet（纯函数，单测钉） */
export function effectivePaper(saved: DocPaper | undefined): DocPaper {
  return saved ?? "quiet";
}
