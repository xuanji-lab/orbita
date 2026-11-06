/**
 * 插件面板的「/ + 空格」选取态：行是插件页的行（同一套 .pl-grp / .pl-row / 头像），只多了选中高亮、
 * ↵ 提示、→ 展开的技能子行，以及底部那一条按键提示。排行与按键语义在 plugin-picker.ts（纯函数），
 * 这里只管画；键盘由 PluginsView 页头的搜索框接（焦点一直在那里，行不抢焦点）。
 */
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { KindTag } from "./AbilitySections.tsx";
import { PluginAvatar } from "./PluginParts.tsx";
import type { PickerGroup, PickerRow } from "./plugin-picker.ts";
import "./plugin-picker.css";

/** 一个分组：组头（图标 + 名 + 数量）+ 行。 */
export function PluginPickerGroup(props: {
  group: PickerGroup;
  workspaceName: string | null;
  /** 这一组第一行在展平列表里的下标 */
  offset: number;
  activeIndex: number;
  onActivate: (row: PickerRow) => void;
  onExpand: (id: string) => void;
}) {
  const t = useT().plugins;
  const { group } = props;
  const here = group.key === "usable";
  const title = here ? t.pickGroupHere(props.workspaceName) : t.pickGroupElsewhere;
  const count = group.rows.filter((row) => row.kind === "plugin").length;
  return (
    <section className="pl-grp" role="group" aria-label={title}>
      <div className="pl-gh">
        <Icon name={here ? "folder" : "circle-off"} size={14} strokeWidth={1.8} />
        <b>{title}</b>
        <span className="pl-gh-count">{t.groupCount(count)}</span>
      </div>
      {group.rows.map((row, index) => {
        const active = props.offset + index === props.activeIndex;
        return row.kind === "plugin" ? (
          <PluginPickRow key={row.id} row={row} active={active} onActivate={props.onActivate} onExpand={props.onExpand} />
        ) : (
          <SkillPickRow key={`${row.parentId}/${row.skill.slug}`} row={row} active={active} onActivate={props.onActivate} />
        );
      })}
    </section>
  );
}

/** ↵ 提示：只在高亮行上出，不可点（回车就是它） */
function EnterHint() {
  return (
    <kbd className="pl-kbd pl-pick-enter" aria-hidden="true">
      <Icon name="corner-down-left" size={12} />
    </kbd>
  );
}

function PluginPickRow(props: {
  row: Extract<PickerRow, { kind: "plugin" }>;
  active: boolean;
  onActivate: (row: PickerRow) => void;
  onExpand: (id: string) => void;
}) {
  const t = useT().plugins;
  const { row, active } = props;
  const { view } = row;
  const hint = row.expandable && !row.expanded && active;
  return (
    <>
      <div className="pl-row pl-pick-row" role="option" aria-selected={active} data-pick-active={active} data-usable={row.usable}>
        {/* 点行 = ↵；mousedown 不夺焦点（键盘还要接着 ↑↓） */}
        <button type="button" className="pl-row-main" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onActivate(row)}>
          <PluginAvatar view={view} />
          <span className="pl-name">
            <b>{view.name}</b>
            <small className={view.origin === "user-mcp" ? "mono" : undefined}>{view.description}</small>
          </span>
          <span className="pl-trail">
            <KindTag view={view} />
            {active && <EnterHint />}
          </span>
        </button>
      </div>
      {hint && (
        <div className="pl-pick-hint-row">
          <button type="button" className="pl-pick-hint" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onExpand(row.id)}>
            <Icon name="chevron-right" size={12} strokeWidth={2} />
            <span>
              {t.pickExpandHint}
              {view.skills.map((skill) => skill.slug).join(" · ")}
            </span>
          </button>
        </div>
      )}
    </>
  );
}

/** 展开后插件里的一条技能：缩进在插件名下，头像是技能的绿书 */
function SkillPickRow(props: { row: Extract<PickerRow, { kind: "skill" }>; active: boolean; onActivate: (row: PickerRow) => void }) {
  const t = useT().plugins;
  const { row, active } = props;
  return (
    <div className="pl-row pl-pick-row pl-pick-sub" role="option" aria-selected={active} data-pick-active={active} data-usable="true" title={t.pickSkillRow(row.skill.slug)}>
      <button type="button" className="pl-row-main" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onActivate(row)}>
        <PluginAvatar view={{ origin: "user-skill" }} />
        <span className="pl-name">
          <b>{row.skill.slug}</b>
          <small>{row.skill.description}</small>
        </span>
        {active && <EnterHint />}
      </button>
    </div>
  );
}

/** 底部一条按键提示（RightPanelFrame 的 footer）：↑↓ 选 · ↵ 插入插件 · → 展开技能（已展开时 ← 收起）· Esc 取消 */
export function PluginPickerBar(props: { expanded: boolean }) {
  const t = useT().plugins;
  return (
    <div className="pl-pickbar" aria-hidden="true">
      <span>
        <kbd className="pl-kbd">
          <Icon name="arrow-up" size={12} />
        </kbd>
        <kbd className="pl-kbd">
          <Icon name="arrow-down" size={12} />
        </kbd>
        {t.keyMove}
      </span>
      <span>
        <kbd className="pl-kbd">
          <Icon name="corner-down-left" size={12} />
        </kbd>
        {t.keyInsert}
      </span>
      <span>
        <kbd className="pl-kbd">
          <Icon name={props.expanded ? "arrow-left" : "arrow-right"} size={12} />
        </kbd>
        {props.expanded ? t.keyCollapse : t.keyExpand}
      </span>
      <span>
        <kbd className="pl-kbd">{t.keyEscCap}</kbd>
        {t.keyEsc}
      </span>
    </div>
  );
}
