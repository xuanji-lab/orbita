import type React from "react";

/**
 * 名字 + 目录尾 `/`：名字先省略（吃掉宽度），斜杠紧跟其后、不参与省略。
 * 输入框胶囊（FileChip）、Session·附件行（FilesPanel）、气泡回显（FileRefChip）
 * 三处**共用这一段结构**（2026-10 验收 K：各写各的曾让气泡里的 `/` 隔着容器
 * gap 飘出半个字宽）。`wrapStyle` 决定这段在行里占多宽（胶囊里随内容收缩、
 * 面板行里占满剩余宽），名字的字号 / 颜色由调用方给（className 或 style），
 * 省略号规则固定在这里。
 */
export function DirMarkName(props: {
  name: string;
  dir: boolean;
  /** 这一段（名字 + 斜杠）在行里的占宽方式 */
  wrapStyle?: React.CSSProperties;
  /** 名字元素的追加 class（如胶囊的 material-chip-name） */
  nameClassName?: string;
  /** 名字元素的追加 style */
  nameStyle?: React.CSSProperties;
}) {
  return (
    <span style={{ minWidth: 0, display: "flex", alignItems: "center", ...props.wrapStyle }}>
      <span
        className={props.nameClassName}
        style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...props.nameStyle }}
      >
        {props.name}
      </span>
      {props.dir && (
        <span className="dir-mark-slash" aria-hidden="true">
          /
        </span>
      )}
    </span>
  );
}
