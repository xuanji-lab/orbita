import React from "react";
import { GlassCard } from "./GlassCard.jsx";

/** Home-screen session card: title line + up to three recent user queries. */
export function SessionCard({ name, queries = [], running = false, loading = false, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <GlassCard
      as="button"
      layer={3}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        cursor: "pointer",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        font: "inherit",
        transition: "box-shadow var(--duration-instant) var(--ease-out-quint)",
        boxShadow: hover ? "var(--shadow-popover)" : "var(--shadow-composer)",
        ...style,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "var(--weight-semibold)", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }}>
        <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        {running ? <span title="Session running" style={{ width: 6, height: 6, flex: "0 0 auto", borderRadius: "var(--radius-pill)", background: "var(--color-accent)" }} /> : null}
      </span>
      {[0, 1, 2].map((i) =>
        loading ? (
          <span key={i} style={{ height: "var(--line-height-micro)", borderRadius: "var(--radius-xs)", background: "var(--color-bg-hover)", animation: "orbita-skeleton 1.2s ease-in-out infinite" }} />
        ) : (
          <span key={i} style={{ height: "var(--line-height-micro)", fontSize: "var(--font-size-control)", lineHeight: "var(--line-height-micro)", color: "var(--color-text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {queries[i] ?? ""}
          </span>
        ),
      )}
    </GlassCard>
  );
}
