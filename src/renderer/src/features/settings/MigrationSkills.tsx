import type { ImportSkillGroup, ImportSkillItem, ImportSkillMode, ImportSkillScope } from "@shared/import";
import type { Workspace } from "@shared/workspace";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { InfoTip, useSettingTip } from "./InfoTip";
import { Step } from "./MigrationStep.tsx";
import type { StepState } from "./migration-page.ts";
import { abbreviateHome } from "./migration-groups.ts";
import {
  DEFAULT_SKILL_SCOPE,
  isSelectableSkill,
  sameSkillScope,
  selectableSkills,
  skillGroupLabel,
  skillGroupNote,
  skillScopeLabel,
  skillScopeOptions,
  skillStatusLabel,
} from "./migration-skills.ts";

/** 展开的组里先列这么多条，其余收进「Show N more」（与会话段同一个数） */
const SKILLS_BEFORE_MORE = 8;

/**
 * Migration 页第 3 步：Skills。按源目录分组（Proma 一个工作区一组），重名先到先得。
 * 段头一个 Copy / Link 开关管全部（默认 Copy，设计稿裁决 #6），两者的后果进悬停；
 * 每组一个作用域菜单（默认 All sessions，列头 Available in）。没有可导的组整行置灰，写明原因。
 */
export function SkillsSection(props: {
  state: StepState;
  /** null = 还没扫描 */
  groups: readonly ImportSkillGroup[] | null;
  home: string;
  workspaces: readonly Workspace[];
  selected: ReadonlySet<string>;
  mode: ImportSkillMode;
  scopes: ReadonlyMap<string, ImportSkillScope>;
  expanded: ReadonlySet<string>;
  showAll: ReadonlySet<string>;
  disabled: boolean;
  onMode: (mode: ImportSkillMode) => void;
  onSet: (skills: readonly ImportSkillItem[], on: boolean) => void;
  onScope: (dir: string, scope: ImportSkillScope) => void;
  onToggleExpand: (dir: string) => void;
  onShowAll: (dir: string) => void;
}) {
  // 一个 skill 都没有的目录不列：它既没有可导的，也没有要解释的重名
  const groups = (props.groups ?? []).filter((group) => group.skills.length > 0);
  const selectable = groups.flatMap(selectableSkills);
  const all = selectable.length > 0 && selectable.every((skill) => props.selected.has(skill.dir));
  return (
    <Step
      n={3}
      title="Skills"
      state={props.state}
      summary={
        <InfoTip label="About importing skills">
          Names already in orbita are left alone · a name found in two folders comes from the first one listed
        </InfoTip>
      }
      tools={
        selectable.length > 0 && (
          <span className="mg-tools">
            <span className="mg-seg" role="group" aria-label="How skills come over">
              {(["copy", "link"] as const).map((mode) => (
                <ModeButton
                  key={mode}
                  mode={mode}
                  pressed={props.mode === mode}
                  disabled={props.disabled}
                  onClick={() => props.onMode(mode)}
                />
              ))}
            </span>
            <span className="mg-sep" />
            <button type="button" className="mg-textbtn" disabled={props.disabled} onClick={() => props.onSet(selectable, !all)}>
              {all ? "Clear all" : "Select all"}
            </button>
          </span>
        )
      }
    >
      {props.groups === null ? (
        <p className="mg-caption">
          <Icon name="book-open" size={12} strokeWidth={1.8} />
          Grouped by skills folder · one scope per folder
        </p>
      ) : groups.length === 0 ? (
        <div className="mg-block mg-empty">
          <Icon name="circle-check" size={15} />
          No skills in the ticked sources
        </div>
      ) : (
        <>
          <div className="mg-colhead mg-grid-skills" aria-hidden="true">
            <span />
            <span>Folder</span>
            <span>Selected</span>
            <span>Available in</span>
          </div>
          <div className="mg-block">
            {groups.map((group) => (
              <SkillGroupBlock
                key={group.dir}
                group={group}
                groups={groups}
                home={props.home}
                workspaces={props.workspaces}
                selected={props.selected}
                scope={props.scopes.get(group.dir) ?? DEFAULT_SKILL_SCOPE}
                expanded={props.expanded.has(group.dir)}
                showAll={props.showAll.has(group.dir)}
                disabled={props.disabled}
                onSet={props.onSet}
                onScope={(scope) => props.onScope(group.dir, scope)}
                onToggleExpand={() => props.onToggleExpand(group.dir)}
                onShowAll={() => props.onShowAll(group.dir)}
              />
            ))}
          </div>
        </>
      )}
    </Step>
  );
}

/** Copy / Link 两个按钮：各自的后果进悬停（原来是 title）。 */
function ModeButton(props: { mode: ImportSkillMode; pressed: boolean; disabled: boolean; onClick: () => void }) {
  const tip = useSettingTip<HTMLButtonElement>(
    props.mode === "copy"
      ? "Copied into orbita · they keep working if the other app is removed · later edits there don't carry over"
      : "Linked to the other app's folder · edits there show up here · removing the app breaks them",
  );
  return (
    <>
      <button
        type="button"
        className="quiet-control mg-seg-btn"
        aria-pressed={props.pressed}
        disabled={props.disabled}
        onClick={props.onClick}
        {...tip.anchor}
      >
        {props.mode === "copy" ? "Copy" : "Link"}
      </button>
      {tip.layer}
    </>
  );
}

function SkillGroupBlock(props: {
  group: ImportSkillGroup;
  groups: readonly ImportSkillGroup[];
  home: string;
  workspaces: readonly Workspace[];
  selected: ReadonlySet<string>;
  scope: ImportSkillScope;
  expanded: boolean;
  showAll: boolean;
  disabled: boolean;
  onSet: (skills: readonly ImportSkillItem[], on: boolean) => void;
  onScope: (scope: ImportSkillScope) => void;
  onToggleExpand: () => void;
  onShowAll: () => void;
}) {
  const { group } = props;
  const selectable = selectableSkills(group);
  const picked = selectable.filter((skill) => props.selected.has(skill.dir)).length;
  const all = selectable.length > 0 && picked === selectable.length;
  const empty = selectable.length === 0;
  const scopeItems: MenuItem[] = skillScopeOptions(props.workspaces).map((option, index) => ({
    id: `${index}`,
    label: option.label,
    ...(option.hint === undefined ? null : { hint: option.hint }),
    icon: option.scope.kind === "global" ? "globe" : option.scope.kind === "off" ? "circle-off" : "folder",
    checked: sameSkillScope(option.scope, props.scope),
    onSelect: () => props.onScope(option.scope),
  }));
  const visible = props.showAll ? group.skills : group.skills.slice(0, SKILLS_BEFORE_MORE);
  const label = skillGroupLabel(group);

  return (
    <div className="mg-group">
      <div className="mg-grow mg-grid-skills" data-disabled={empty || undefined} onClick={empty ? undefined : props.onToggleExpand}>
        <span className="mg-lead">
          <input
            type="checkbox"
            aria-label={`Import skills from ${label}`}
            checked={picked > 0}
            ref={(element) => {
              if (element !== null) element.indeterminate = picked > 0 && !all;
            }}
            disabled={props.disabled || empty}
            onClick={(event) => event.stopPropagation()}
            onChange={() => props.onSet(selectable, !all)}
          />
          <button
            type="button"
            className="mg-chev"
            aria-expanded={props.expanded}
            aria-label={props.expanded ? "Collapse" : "Expand"}
            disabled={empty}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleExpand();
            }}
          >
            <Icon name="chevron-right" size={12} />
          </button>
        </span>
        <span className="mg-gcopy">
          <span className="mg-gname">
            <Icon name="book-open" size={14} strokeWidth={1.8} />
            <span className="mg-name">{label}</span>
            <span className="mg-meta">{skillGroupNote(group)}</span>
          </span>
          <span className="mg-gpath" title={group.dir}>
            {abbreviateHome(group.dir, props.home)}
          </span>
        </span>
        {empty ? (
          <span />
        ) : (
          <span className="mg-count mg-num">
            <b>{picked}</b>
            {all ? "" : ` of ${selectable.length}`}
          </span>
        )}
        <span className="mg-dest" onClick={(event) => event.stopPropagation()}>
          {empty ? (
            <span className="mg-status">Nothing new</span>
          ) : (
            <Menu
              items={scopeItems}
              align="end"
              panelMinWidth={200}
              trigger={({ open, toggle }) => (
                <Chip active={open} chevron disabled={props.disabled} title="Which sessions can use these skills" onClick={toggle}>
                  {skillScopeLabel(props.scope, props.workspaces)}
                </Chip>
              )}
            />
          )}
        </span>
      </div>

      {props.expanded && !empty && (
        <div className="mg-kids">
          {visible.map((skill) => {
            const status = skillStatusLabel(skill, props.groups);
            const can = isSelectableSkill(skill);
            return (
              <label key={skill.dir} className="mg-kid mg-skill" data-disabled={!can || undefined}>
                <input
                  type="checkbox"
                  checked={can && props.selected.has(skill.dir)}
                  disabled={props.disabled || !can}
                  onChange={(event) => props.onSet([skill], event.target.checked)}
                />
                <span className="mg-line1">
                  <span className="mg-title">{skill.slug}</span>
                  {skill.description !== "" && (
                    <span className="mg-desc" title={skill.description}>
                      {skill.description}
                    </span>
                  )}
                </span>
                <span className="mg-trail">{status !== null && <span className="mg-status">{status}</span>}</span>
              </label>
            );
          })}
          {group.skills.length > SKILLS_BEFORE_MORE && (
            <div className="mg-more">
              <button type="button" className="mg-textbtn" onClick={props.onShowAll}>
                {props.showAll ? "Show fewer" : `Show ${group.skills.length - SKILLS_BEFORE_MORE} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
