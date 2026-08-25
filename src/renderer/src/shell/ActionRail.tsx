import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

/**
 * 右图标条，32px。与左栏对称：**同样没有自己的面**，直接坐在 layer 1 上。
 * 只在有会话时出现——它承载的是「对这个会话做点什么」，首页没有会话可做。
 *
 * 文件面板属于右抽屉，本分支明确不做（guideline「明确不做」），
 * 所以按设计系统的规矩留在这里、禁用、标注 planned，而不是删掉假装没有。
 */
export function ActionRail(props: { onCopyTranscript: () => void; canCopy: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <aside
      style={{
        flex: "0 0 auto",
        width: 32,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-2) 0",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <IconButton
        variant="soft"
        label={copied ? "Transcript copied" : "Copy transcript"}
        disabled={!props.canCopy}
        onClick={() => {
          props.onCopyTranscript();
          setCopied(true);
        }}
      >
        {/* 复制成功用图标换字形，不用颜色——颜色是第二信号 */}
        <Icon name={copied ? "check" : "copy"} size={16} />
      </IconButton>
      <IconButton variant="soft" label="Files panel (planned)" disabled>
        <Icon name="panel-right" size={16} />
      </IconButton>
    </aside>
  );
}
