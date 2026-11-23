import { requestOpenPanel } from "../../shell/open-panel.ts";

/** 聊天里点了指向本机音 / 视频文件的链接：在右侧文件面板打开（播放器在 MediaView.tsx） */
export function openLocalMedia(path: string): void {
  requestOpenPanel({ kind: "files", path, force: true });
}
