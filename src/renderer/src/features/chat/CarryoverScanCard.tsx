import { Icon } from "../../shell/Icon";
import type { ScanMessage } from "./carryover-parse.ts";
import { useT } from "../../locale.ts";

/**
 * 收尾扫描回复的只读展示卡 —— 消息流内替代那条 fenced json 的 markdown 渲染。
 *
 * 扫描回答按 prompt 契约是一个 fenced json 块，直接渲染就是一大坨机器格式占屏
 * （2026-09-22 用户反馈）；人要看的只是「做完了哪几件、留下了哪几条」。命中判定在
 * matchScanMessage（严格形状，宁可不卡也不吞字），这里只负责展示。**只读**——可编辑的
 * 确认面在收尾确认卡（WrapupCard），两者职责不混。v1 的旧回答只有留下的事。
 *
 * 表面用消息流卡片的既有配方（chat 卡底 + 细边框），**不用玻璃**——玻璃是
 * 浮层配方（ApprovalBar 一类要求回答才继续的卡），这条卡只是流内内容。
 */
export function CarryoverScanCard(props: { scan: ScanMessage }) {
  const t = useT();
  const { done, left } = props.scan;
  return (
    <section
      aria-label={t.carryover.scanResult}
      style={{
        width: "100%",
        minWidth: 0,
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        background: "var(--color-chat-card-bg)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      {done !== null && (
        <Group icon="circle-check" heading={t.carryover.doneCount(done.length)}>
          {done.map((item, index) => (
            <Line
              key={index}
              title={item.title}
              note={item.turns === null ? "" : t.carryover.turns(item.turns[0], item.turns[1])}
            />
          ))}
        </Group>
      )}
      <Group icon="list-todo" heading={left.length > 0 ? t.carryover.itemsToCarry(left.length) : t.carryover.nothingToCarry}>
        {left.map((item, index) => (
          <Line key={index} title={item.title} note={item.detail} />
        ))}
      </Group>
    </section>
  );
}

function Group(props: { icon: "circle-check" | "list-todo"; heading: string; children: React.ReactNode[] }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}>
          <Icon name={props.icon} size={14} />
        </span>
        <strong style={{ fontSize: "var(--font-size-base)", fontWeight: 600 }}>{props.heading}</strong>
      </div>
      {props.children.length > 0 && (
        <div
          style={{
            display: "grid",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            background: "var(--color-chat-muted-bg)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

function Line(props: { title: string; note: string }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span
        style={{
          fontSize: "var(--font-size-base)",
          fontWeight: "var(--weight-medium)",
          color: "var(--color-text-primary)",
          overflowWrap: "anywhere",
        }}
      >
        {props.title}
      </span>
      {props.note !== "" && (
        <span
          title={props.note}
          style={{
            fontSize: "var(--font-size-xs)",
            lineHeight: "var(--line-height-ui)",
            color: "var(--color-text-tertiary)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            overflowWrap: "anywhere",
          }}
        >
          {props.note}
        </span>
      )}
    </div>
  );
}
