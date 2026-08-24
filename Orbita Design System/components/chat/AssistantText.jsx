import React from "react";

/** Assistant reply: flat markdown-ish prose, no bubble, full content width. */
export function AssistantText({ children, style }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        color: "var(--color-text-primary)",
        fontSize: "var(--font-size-chat)",
        lineHeight: "var(--line-height-chat)",
        textWrap: "pretty",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
