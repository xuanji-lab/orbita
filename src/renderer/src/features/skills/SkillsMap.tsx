import { Icon } from "../../shell/Icon";
import type { SkillsState } from "./useSkills";
import type { SkillMeta } from "@shared/skill";

/**
 * Skills 韦恩图视图（4-4，= 原 2-1e）。几何与排版以 wafo 的
 * `skills-map-3circle-v2.html` 为准（viewBox 300×300、r=88、品字圆心、每区
 * 锚点表、点内缩名字允许伸出、10px 名字带 paint-order 玻璃底描边）；1/2 圆
 * 锚点按同一原则由本文件定（静态稿一并给 wafo 看）。
 *
 * 只看 + 点选：点 skill 进详情改集合；不做拖拽。每区最多 5 个，超出收
 * `+N more`（点击跳列表视图并滚到对应组）。Disabled 不进 SVG——普通列表行
 * （圆是「集合」的形状，不属于任何集合的东西画在圆里就是撒谎）。
 * ≥4 个 workspace 韦恩不可读（几何事实），退化为归属矩阵，仍占 map 视图档。
 */

/** 一行 skill：名字 + 修饰（global=环点 / missing=三角） */
interface MapRow {
  slug: string;
  name: string;
  missing: boolean;
  global: boolean;
}

/** 一区锚点：x、y、方向（c 居中 / l 名字向左伸 / r 向右伸 / u 名字在点下方居中） */
type Anchor = readonly [number, number, "c" | "l" | "r" | "u"];

/** 3 圆品字：圆心、标签位、锚点表（v2 原文） */
const CIRCLES_3: readonly (readonly [number, number])[] = [
  [150, 112],
  [104, 190],
  [196, 190],
];
const LABELS_3: readonly (readonly [number, number])[] = [
  [150, 16],
  [40, 293],
  [260, 293],
];
const ANCHORS_3: Readonly<Record<string, Anchor>> = {
  top: [150, 52, "c"],
  bl: [56, 202, "c"],
  br: [244, 202, "c"],
  topbl: [108, 142, "l"],
  topbr: [192, 142, "r"],
  blbr: [150, 226, "u"],
  center: [150, 170, "c"],
};

/** 2 圆 / 1 圆：执行方按同原则定（静态稿送审） */
const CIRCLES_2: readonly (readonly [number, number])[] = [
  [106, 140],
  [194, 140],
];
const LABELS_2: readonly (readonly [number, number])[] = [
  [70, 262],
  [230, 262],
];
const ANCHORS_2: Readonly<Record<string, Anchor>> = {
  left: [56, 120, "c"],
  right: [244, 120, "c"],
  shared: [150, 100, "c"],
  center: [150, 180, "c"],
};

const CIRCLES_1: readonly (readonly [number, number])[] = [[150, 140]];
const LABELS_1: readonly (readonly [number, number])[] = [[150, 276]];
const ANCHORS_1: Readonly<Record<string, Anchor>> = {
  only: [150, 104, "c"],
  center: [150, 168, "c"],
};

const R = 88;
const MAX_PER_REGION = 5;
/** 一区里的行距（v2：13px；竖向窄区 u 用 24px） */
const STEP = 13;
const STEP_U = 24;

function toRow(skill: SkillMeta): MapRow {
  return { slug: skill.slug, name: skill.name, missing: skill.missing, global: skill.global };
}

export function SkillsMap(props: {
  skills: SkillsState;
  onOpenDetail: (slug: string) => void;
  /** +N more 的出口：跳列表视图并滚到对应组（组 id：global 或 workspaceId） */
  onJumpToGroup: (groupId: string) => void;
}) {
  const { skills } = props;
  const workspaces = skills.workspaces;
  const wsIndex = new Map(workspaces.map((ws, i) => [ws.id, i] as const));
  const disabled = skills.skills.filter((s) => !s.global && s.workspaces.length === 0);

  if (skills.skills.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
        No skill yet. Create a folder with a SKILL.md in the skills directory.
      </p>
    );
  }

  if (workspaces.length >= 4) {
    return <MembershipMatrix skills={skills} onOpenDetail={props.onOpenDetail} />;
  }

  const count = workspaces.length;
  const circles = count === 3 ? CIRCLES_3 : count === 2 ? CIRCLES_2 : CIRCLES_1;
  const labels = count === 3 ? LABELS_3 : count === 2 ? LABELS_2 : LABELS_1;

  /** region key（成员圆的下标集，或 "global"）→ 锚点 */
  const anchorOf = (key: string): Anchor | undefined => {
    if (key === "global") {
      return count === 3 ? ANCHORS_3.center : count === 2 ? ANCHORS_2.center : ANCHORS_1.center;
    }
    const indices = key.split("-").map(Number);
    if (count === 3) {
      // 下标集 → 方位名：0=top 1=bl 2=br；两两交集与三区交集各有铭牌
      const names: Record<string, string> = {
        "0": "top",
        "1": "bl",
        "2": "br",
        "0-1": "topbl",
        "0-2": "topbr",
        "1-2": "blbr",
        "0-1-2": "center",
      };
      const name = names[key];
      return name === undefined ? undefined : ANCHORS_3[name];
    }
    if (count === 2) {
      if (indices.length === 2) return ANCHORS_2.shared;
      return indices[0] === 0 ? ANCHORS_2.left : ANCHORS_2.right;
    }
    return ANCHORS_1.only;
  };

  // 分区：global 恒进 center 区；其余按「在哪些圆里」；disabled 不进图
  const regions = new Map<string, MapRow[]>();
  for (const skill of skills.skills) {
    if (skill.global) {
      const list = regions.get("global") ?? [];
      list.push(toRow(skill));
      regions.set("global", list);
      continue;
    }
    if (skill.workspaces.length === 0) continue;
    const indices = [...new Set(skill.workspaces.map((id) => wsIndex.get(id)))]
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b);
    const key = indices.join("-");
    const list = regions.get(key) ?? [];
    list.push(toRow(skill));
    regions.set(key, list);
  }

  /** 渲染单元：一区的锚点 + 可见行 + 收纳数 + 列表组落点 */
  interface Region {
    anchor: Anchor;
    shown: MapRow[];
    extra: number;
    group: string;
  }
  const rendered: Region[] = [];
  for (const [key, list] of regions) {
    const anchor = anchorOf(key);
    if (anchor === undefined || list.length === 0) continue;
    const shown = list.slice(0, MAX_PER_REGION);
    const indices = key === "global" ? [] : key.split("-").map(Number);
    const group =
      key === "global" ? "global" : (workspaces[indices[0] ?? 0]?.id ?? key);
    rendered.push({ anchor, shown, extra: list.length - shown.length, group });
  }

  return (
    <div>
      <svg
        viewBox="0 0 300 300"
        style={{ display: "block", width: "100%", height: "auto" }}
        role="img"
        aria-label="Skill set map"
      >
        {circles.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={R} className="venn-ws" />
        ))}
        {labels.map(([x, y], i) => (
          <text key={i} x={x} y={y} textAnchor="middle" className="venn-ws-label">
            {(workspaces[i]?.name ?? "Global").toUpperCase()}
          </text>
        ))}
        {rendered.map((region) => {
          const [ax, ay, dir] = region.anchor;
          const step = dir === "u" ? STEP_U : STEP;
          // 总行数含 +more 那一行；从锚点居中往下排（v2 同款）
          const total = region.shown.length + (region.extra > 0 ? 1 : 0);
          const startY = ay - ((total - 1) * step) / 2;
          return (
            <g key={`${region.anchor.join(",")}-${region.group}`}>
              {region.shown.map((row, i) => (
                <MapRowGlyph
                  key={row.slug}
                  x={ax}
                  y={startY + i * step}
                  dir={dir}
                  row={row}
                  onOpen={props.onOpenDetail}
                />
              ))}
              {region.extra > 0 && (
                <text
                  className="venn-more"
                  x={dir === "l" ? ax - 9 : dir === "r" ? ax + 9 : ax}
                  y={startY + region.shown.length * step + 3.5}
                  textAnchor={dir === "l" ? "end" : dir === "r" ? "start" : "middle"}
                  onClick={() => props.onJumpToGroup(region.group)}
                >
                  +{region.extra} more
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <DisabledBand disabled={disabled} onOpen={props.onOpenDetail} />
    </div>
  );
}

/** 一行：符号（点/环/三角）严格落在 (x,y)；名字按方向伸出，带玻璃底描边 */
function MapRowGlyph(props: {
  x: number;
  y: number;
  dir: Anchor[2];
  row: MapRow;
  onOpen: (slug: string) => void;
}) {
  const { x, y, dir, row } = props;
  const nameWidth = row.name.length * 5.3;
  let dotX = x;
  let textX = x;
  let anchorAttr: "start" | "middle" | "end" = "middle";
  let textY = y + 3.5;
  if (dir === "l") {
    textX = x - 9;
    anchorAttr = "end";
  } else if (dir === "r") {
    textX = x + 9;
    anchorAttr = "start";
  } else if (dir === "u") {
    textY = y + 14;
  } else {
    dotX = x - nameWidth / 2 - 2;
    textX = dotX + 9;
    anchorAttr = "start";
  }
  return (
    <g
      className={row.missing ? "venn-skill venn-missing" : "venn-skill"}
      style={{ cursor: "pointer" }}
      onClick={() => props.onOpen(row.slug)}
    >
      {row.missing ? (
        <path
          className="venn-tri"
          d={`M${dotX} ${y - 4.2} L${dotX + 4.2} ${y + 3.2} L${dotX - 4.2} ${y + 3.2} Z`}
        />
      ) : row.global ? (
        <>
          <circle className="venn-ring" cx={dotX} cy={y} r={5} />
          <circle className="venn-dot" cx={dotX} cy={y} r={2.2} />
        </>
      ) : (
        <circle className="venn-dot" cx={dotX} cy={y} r={3} />
      )}
      <text className="venn-nm" x={textX} y={textY} textAnchor={anchorAttr}>
        {row.name}
      </text>
    </g>
  );
}

/** Disabled 条带：不进 SVG 的普通列表行 */
function DisabledBand(props: { disabled: SkillMeta[]; onOpen: (slug: string) => void }) {
  if (props.disabled.length === 0) return null;
  return (
    <div
      style={{
        marginTop: "var(--space-3)",
        paddingTop: "var(--space-2)",
        borderTop: "1px solid var(--color-border-subtle)",
        display: "grid",
        gap: 2,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-micro)",
          letterSpacing: "0.06em",
          color: "var(--color-text-tertiary)",
          textTransform: "uppercase",
        }}
      >
        Disabled
      </span>
      {props.disabled.map((skill) => (
        <button
          key={skill.slug}
          type="button"
          onClick={() => props.onOpen(skill.slug)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 26,
            padding: 0,
            border: 0,
            background: "transparent",
            font: "inherit",
            fontSize: "var(--font-size-caption)",
            color: skill.missing ? "var(--color-danger)" : "var(--color-text-tertiary)",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          {skill.missing && <Icon name="triangle-alert" size={13} style={{ color: "var(--color-danger)" }} />}
          {skill.name}
        </button>
      ))}
    </div>
  );
}

/** ≥4 workspace 的归属矩阵：行 = skill（点击进详情），单元格不可编辑 */
function MembershipMatrix(props: { skills: SkillsState; onOpenDetail: (slug: string) => void }) {
  const { skills } = props;
  const inMap = skills.skills.filter((s) => s.global || s.workspaces.length > 0);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
        <thead>
          <tr>
            <th style={thStyle}>Skill</th>
            <th style={thStyle}>Global</th>
            {skills.workspaces.map((ws) => (
              <th key={ws.id} style={thStyle} title={ws.name}>
                {ws.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {inMap.map((skill) => (
            <tr key={skill.slug}>
              <td style={tdNameStyle(skill)}>
                <button
                  type="button"
                  onClick={() => props.onOpenDetail(skill.slug)}
                  style={{ all: "unset", cursor: "pointer", color: "inherit" }}
                >
                  {skill.name}
                </button>
              </td>
              <td style={tdCellStyle}>{memberMark(skill, skill.global)}</td>
              {skills.workspaces.map((ws) => (
                <td key={ws.id} style={tdCellStyle}>
                  {memberMark(skill, skill.workspaces.includes(ws.id))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 成员格：missing 用三角；命中画实心点，未命中空着 */
function memberMark(skill: SkillMeta, member: boolean): React.ReactNode {
  if (!member) return null;
  if (skill.missing) {
    return <Icon name="triangle-alert" size={12} style={{ color: "var(--color-danger)" }} />;
  }
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--color-text-primary)",
        display: "inline-block",
      }}
    />
  );
}

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--glass-bg)",
  textAlign: "left",
  padding: "0 var(--space-2)",
  height: 28,
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
  letterSpacing: "0.06em",
  color: "var(--color-text-tertiary)",
  fontWeight: "var(--weight-regular)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  maxWidth: 120,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tdNameStyle = (skill: SkillMeta): React.CSSProperties => ({
  padding: "0 var(--space-2)",
  height: 28,
  fontSize: "var(--font-size-caption)",
  color: skill.missing ? "var(--color-danger)" : "var(--color-text-primary)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 140,
});

const tdCellStyle: React.CSSProperties = {
  padding: "0 var(--space-2)",
  height: 28,
  textAlign: "center",
};
