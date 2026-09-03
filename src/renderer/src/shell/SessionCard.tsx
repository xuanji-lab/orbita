import { useState } from "react";

/**
 * 首页的最近会话卡（设计系统 components/surfaces/SessionCard 的实现）：
 * layer-3 玻璃卡，**四行正好**——名字行 + 固定三个提问槽。槽位不足就留空、
 * 恒渲染三个：一排卡片才齐得平。hover 只从 composer 阴影抬到 popover 阴影，
 * 别的都不动（设计系统 *Hover, press, disabled*）。
 */
export function SessionCard(props: {
  /** 会话名，单行截断 */
  name: string;
  /** 最近 3 条用户提问（新→旧）；不足留空槽 */
  queries?: string[];
  /** 这条会话里有 agent 在跑：名字行尾一枚 accent 圆点 */
  running?: boolean;
  /** 列表还在读时的骨架态 */
  loading?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const queries = props.queries ?? [];
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        flex: 1,
        minWidth: 0,
        padding: "var(--space-3)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-xl)",
        background: "var(--glass-bg)",
        boxShadow: hover ? "var(--shadow-popover)" : "var(--shadow-composer)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
        fontFamily: "var(--font-family-base)",
        textAlign: "left",
        cursor: "pointer",
        ...props.style,
      }}
    >
      {props.loading === true ? (
        <>
          <SkeletonBar width="62%" />
          <SkeletonBar width="88%" />
          <SkeletonBar width="76%" />
          <SkeletonBar width="46%" />
        </>
      ) : (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: "var(--weight-strong)",
                fontSize: "var(--font-size-control)",
                color: "var(--color-text-primary)",
              }}
            >
              {props.name}
            </span>
            {props.running === true && (
              <span
                title="Running"
                className="orbita-breath"
                style={{
                  flex: "0 0 auto",
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--color-accent)",
                }}
              />
            )}
          </span>
          {[0, 1, 2].map((slot) => (
            <span
              key={slot}
              style={{
                minHeight: 16,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "var(--font-size-caption)",
                lineHeight: "var(--line-height-caption)",
                color: "var(--color-text-secondary)",
              }}
            >
              {queries[slot] ?? ""}
            </span>
          ))}
        </>
      )}
    </button>
  );
}

/** 骨架条：安静的中性灰块，不闪不 shimmer——要的是「还没读到」，不是动画 */
function SkeletonBar(props: { width: string }) {
  return (
    <span
      style={{
        width: props.width,
        height: 10,
        borderRadius: "var(--radius-xs)",
        background: "var(--color-bg-hover)",
      }}
    />
  );
}
