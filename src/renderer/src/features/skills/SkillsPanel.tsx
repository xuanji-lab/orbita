import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { IconButton } from "../../shell/IconButton";
import { RowHoverAction } from "../../shell/RowHoverAction";
import { SetDots } from "../../shell/SetDots";
import { useHoverTooltip } from "../../shell/useHoverTooltip.ts";
import {
  PanelButton,
  PanelIconButton,
  PanelLine,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { api } from "../../api";
import type { SkillsState } from "./useSkills";
import type { SkillContent, SkillMeta } from "@shared/skill";
import { isSkillAvailable, isSkillSlug } from "@shared/skill";
import { filterSkills } from "./skill-filter.ts";
import {
  skillToken,
  type TokenPickerControl,
} from "../../shell/panel-token.ts";
import { useT } from "../../locale.ts";

/** 行 hover tooltip 出现的延迟——比 IconButton 的 200ms 更慢，快速划过列表不惊扰 */
const ROW_TOOLTIP_DELAY_MS = 350;

/**
 * Skills 面板（1-4 / 2-1d）：列表视图按集合分组 + 详情视图改归属与三段编辑。
 * 长在 S-0 的面板框架上。韦恩图视图（2-1e）曾接进来过，用户决定先撤下——
 * 4 个工作区起就退化成归属矩阵，空工作区也占一个圆，实际几乎看不到图；
 * 之后再议，面板现在只有列表这一档，不放假的切换器。
 *
 * 列表的分组本职是回答「这个集合现在有哪些 skill」，所以**多集合的行在每组
 * 都出现**（行尾的归属点阵说明它共享，见 SkillRow），不是对 skill 集合做划分。
 */
export function SkillsPanel(props: {
  skills: SkillsState;
  onClose: () => void;
  /** 表单默认归属的 workspace（会话当前所在）；null = 默认 Global */
  defaultWorkspaceId: string | null;
  /** Create skill…：新建会话并预填 composer，让 agent 用 create_skill 落盘 */
  onCreateSkill: () => void;
  /** 「/ + 空格」右栏选取模式（panel-token.ts）：只主槽的 App 提供，rail 开的面板不传 */
  picker?: TokenPickerControl;
  /** 行尾「选用」键：把 token 插到主槽输入框当前光标处（PanelInsertRequest） */
  onInsert: (token: string) => void;
}) {
  const { skills } = props;
  /** 当前面板视图：列表 / 详情 / 新建表单（4-1） */
  const [view, setView] = useState<"list" | "detail">("list");
  /** 当前详情的 slug；null = 列表。面板内状态，不进 useSkills（侧栏列表已删） */
  const [selected, setSelected] = useState<string | null>(null);
  const meta = selected === null ? null : (skills.skills.find((s) => s.slug === selected) ?? null);

  // 列表刷新后选中的那条没了（被清理）→ 回列表
  useEffect(() => {
    if (selected !== null && meta === null) setView("list");
  }, [selected, meta]);

  // 进入选取模式时回列表视图：详情页里没有可选取的行，「/ + 空格」要把人带到
  // 能选的地方（rail 正常开面板不受影响——那边 picker 恒 undefined）。靠 request
  // 重触发：面板可能已开着，选取态可能已在
  useEffect(() => {
    if (props.picker !== undefined) setSelected(null);
  }, [props.picker?.request]);

  // 名字原样显示——「名字 == 路径」的老数据在 store 读时已治，显示层不截尾
  const workspaceName = (id: string): string =>
    skills.workspaces.find((w) => w.id === id)?.name ?? id;

  if (meta !== null) {
    return (
      <SkillDetail
        skills={skills}
        meta={meta}
        workspaceName={workspaceName}
        onBack={() => setSelected(null)}
        onClose={props.onClose}
      />
    );
  }
  return (
    <SkillList
      skills={skills}
      workspaceName={workspaceName}
      onSelect={(slug) => {
        setSelected(slug);
        setView("detail");
      }}
      onCreateSkill={props.onCreateSkill}
      onClose={props.onClose}
      picker={props.picker}
      onInsert={props.onInsert}
    />
  );
}

/**
 * 组标题：mono/micro/大写/secondary（与侧栏 NodeLabel 同款字学）+ 计数。
 * 计数是**该组当前显示的行数**——搜索过滤时跟着变，不是集合里的总数。
 *
 * **自己带 `padding: 0 14px`**（不是外层 `.skill-group` 容器）：组间发丝线
 * （`.skill-group + .skill-group`）要通栏，缩进只能落在标题自己身上，不能
 * 落在包住发丝线的容器上——否则线也跟着缩进，两侧留白，不贴边。
 */
function GroupLabel(props: { children: React.ReactNode; count: number; danger?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 26,
        padding: "0 14px",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
    >
      {props.children}
      <span style={{ color: "var(--color-text-tertiary)" }}>&nbsp;· {props.count}</span>
    </span>
  );
}

function SkillList(props: {
  skills: SkillsState;
  workspaceName: (id: string) => string;
  onSelect: (slug: string) => void;
  onCreateSkill: () => void;
  onClose: () => void;
  picker?: TokenPickerControl;
  onInsert: (token: string) => void;
}) {
  const t = useT();
  const { skills } = props;
  const load = skills.load;
  const error = load.kind === "failed" ? load.message : null;
  /** + 的两项菜单（4-1）：面板内展开不弹窗；再点 + 收起 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 过滤行的查询词；分组仍在这个组件里做，过滤只决定哪些行留下（skill-filter.ts） */
  const [query, setQuery] = useState("");
  const picker = props.picker;
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 选取模式的高亮行（↑↓ 移动，Enter 选中）；-1 = 无高亮 */
  const [pickIndex, setPickIndex] = useState(-1);
  // 过滤与计数：列表 / 空态 / 加载三态共用（filterRow 的计数也在场）
  const total = skills.skills.length;
  const filtered = filterSkills(skills.skills, query);
  const filtering = query.trim() !== "";
  // 选取模式的可行行：扁平、按发起输入框的工作区可用（isSkillAvailable，与
  // 主进程发送端同一谓词——这里选得到的，发出去必然认）。拖拽源不在选取
  // 态也用同一份，与浏览视图的分组展示互不影响
  const pickRows = picker !== undefined ? filtered.filter((s) => isSkillAvailable(s, picker.workspaceId)) : [];
  // 进入选取模式：清词、聚焦过滤行、高亮首行。
  // 靠 request 重触发：第二次「/ + 空格」时面板可能已开、选取态可能已在
  useEffect(() => {
    if (picker === undefined) return;
    setQuery("");
    setPickIndex(-1);
    filterRef.current?.focus();
  }, [picker?.request]);
  // 面板刚开时清单还在读盘（空表），读回来后补上首行高亮；过滤后越界则夹回
  useEffect(() => {
    if (picker === undefined) return;
    setPickIndex((i) => (pickRows.length === 0 ? -1 : i === -1 ? 0 : Math.min(i, pickRows.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickRows.length]);
  // 高亮行滚进视野（block:"nearest"，只在需要时滚，不抖）
  useEffect(() => {
    listRef.current?.querySelector('[data-picker-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [pickIndex]);
  /** 选取模式的键盘导航：↑↓ 移动、Enter 选中、Tab 切到 MCP、Esc 清词→退出 */
  const onPickerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (picker === undefined) return;
    const count = pickRows.length;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setPickIndex((i) => (i === -1 ? 0 : (i + 1) % count));
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setPickIndex((i) => (i === -1 ? count - 1 : (i - 1 + count) % count));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = pickRows[pickIndex >= 0 ? pickIndex : 0];
      if (row !== undefined) picker.onSelect(skillToken(row.slug));
    } else if (event.key === "Tab") {
      // Tab 切面板（skills ↔ MCP）：搜索框里的 ←→ 仍归光标移动，不抢
      event.preventDefault();
      picker.onSwitch();
    } else if (event.key === "Escape") {
      // 两段式：先清词（人还在搜），词空了才退出选取
      event.stopPropagation();
      if (query !== "") setQuery("");
      else picker.onCancel();
    }
  };

  const header = (
    <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
      {t.skills.title}
    </strong>
  );
  // 过滤行（+ 选取模式的提示行）：列表 / 空态 / 加载三态共用同一份。**不能只长在
  // 列表分支里**——「/ + 空格」开面板时清单常还在读盘，先渲染加载态，过滤行不在
  // 场上，选取模式的聚焦就落空了
  const shownCount = picker !== undefined ? pickRows.length : filtered.length;
  const filterRow = (
    <>
      <div className="skills-filter-row">
        <Icon name="search" size={14} />
        <input
          ref={filterRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (picker !== undefined) {
              onPickerKeyDown(e);
              return;
            }
            // Esc 清空输入；已经空了就不拦截——让它照旧冒泡去关面板（App.tsx 的
            // 全局 Esc 处理），两次 Esc 才关面板的手感和大多数搜索框一致
            if (e.key === "Escape" && query !== "") {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={t.skills.filter}
          aria-label={t.skills.filterAria}
        />
        <span className="skills-filter-count">{filtering ? `${shownCount} / ${total}` : total}</span>
        {query !== "" && (
          <IconButton label={t.skills.clear} size={20} onClick={() => setQuery("")}>
            <Icon name="x" size={12} />
          </IconButton>
        )}
      </div>
      {picker !== undefined && (
        <div className="panel-picker-hint" aria-hidden="true">
          {t.skills.pickerHint}
        </div>
      )}
    </>
  );

  // 空态与加载：footer 的 reveal 行照常（新建的路一直在）
  if (load.kind === "loading" && skills.skills.length === 0) {
    return (
      <RightPanelFrame
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        {filterRow}
        <div style={{ padding: "var(--space-4)" }}>
          <PanelLine>{t.common.loading}</PanelLine>
        </div>
      </RightPanelFrame>
    );
  }
  if (skills.skills.length === 0) {
    return (
      <RightPanelFrame
        header={header}
        contentKey="list"
        onClose={props.onClose}
        headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
        footer={<FooterReveal skills={skills} />}
      >
        {filterRow}
        {/* 空态自己包一层内容版式（与 MCP 面板同款）：列表行的 hover 要通到面板
            两个侧缘（行自带内边距），所以壳的内容区不能统一加 padding——
            空态没有行，忘了这层就会整段贴着面板左缘 */}
        <div
          style={{
            padding: "var(--space-4)",
            display: "grid",
            gap: "var(--space-2)",
            alignContent: "start",
          }}
        >
          {error !== null && <PanelLine danger>{t.skills.readFailed} {error}</PanelLine>}
          <p style={{ margin: 0, fontSize: "var(--font-size-body)" }}>{t.skills.none}</p>
          <PanelLine>{t.skills.noneHint}</PanelLine>
        </div>
      </RightPanelFrame>
    );
  }

  const linked = filtered.filter((s) => s.global || s.workspaces.length > 0);
  const disabled = filtered.filter((s) => !s.global && s.workspaces.length === 0);
  const globalMembers = filtered.filter((s) => s.global);

  return (
    <RightPanelFrame
      header={header}
      contentKey="list"
      onClose={props.onClose}
      headerExtra={<AddMenu skills={skills} onCreateSkill={props.onCreateSkill} />}
      footer={<FooterReveal skills={skills} />}
    >
      <>
        {filterRow}
        {picker !== undefined ? (
          /* 选取模式：扁平列表（分组对 ↑↓ 导航只是噪声），点选即插 token */
          <div ref={listRef} style={{ display: "grid", alignContent: "start" }}>
            {error !== null && (
              <div style={{ padding: "var(--space-3)" }}>
                <PanelLine danger>{t.skills.readFailed} {error}</PanelLine>
              </div>
            )}
            {pickRows.length === 0 ? (
              <div style={{ padding: "var(--space-4)" }}>
                {/* 查询词空着且一个可用 skill 都没有：说工作区，不说「没有匹配」*/}
                <PanelLine>
                  {query.trim() === "" ? t.composer.skillNoneInWorkspace : t.skills.noMatch(query.trim())}
                </PanelLine>
              </div>
            ) : (
              pickRows.map((s, index) => (
                <SkillRow
                  key={s.slug}
                  skill={s}
                  onSelect={props.onSelect}
                  workspaceName={props.workspaceName}
                  onClean={skills.clean}
                  onInsert={props.onInsert}
                  pickerActive={index === pickIndex}
                  onPickerSelect={() => picker.onSelect(skillToken(s.slug))}
                />
              ))
            )}
          </div>
        ) : (
        <div style={{ display: "grid", alignContent: "start" }}>
          {error !== null && (
            <div style={{ padding: "var(--space-3)" }}>
              <PanelLine danger>{t.skills.readFailed} {error}</PanelLine>
            </div>
          )}
          {filtering && filtered.length === 0 ? (
            <div style={{ padding: "var(--space-4)" }}>
              <PanelLine>{t.skills.noMatch(query.trim())}</PanelLine>
            </div>
          ) : (
            <>
              {globalMembers.length > 0 && (
                <div className="skill-group">
                  <GroupLabel count={globalMembers.length}>{t.skills.global}</GroupLabel>
                  {globalMembers.map((s) => (
                    <SkillRow
                      key={`g:${s.slug}`}
                      skill={s}
                      onSelect={props.onSelect}
                      workspaceName={props.workspaceName}
                      onClean={skills.clean}
                      onInsert={props.onInsert}
                    />
                  ))}
                </div>
              )}
              {skills.workspaces.map((ws) => {
                const members = linked.filter((s) => !s.global && s.workspaces.includes(ws.id));
                if (members.length === 0) return null;
                return (
                  <div className="skill-group" key={ws.id}>
                    <GroupLabel count={members.length}>{ws.name}</GroupLabel>
                    {members.map((s) => (
                      <SkillRow
                        key={`${ws.id}:${s.slug}`}
                        skill={s}
                        onSelect={props.onSelect}
                        workspaceName={props.workspaceName}
                        onClean={skills.clean}
                        onInsert={props.onInsert}
                      />
                    ))}
                  </div>
                );
              })}
              {disabled.length > 0 && (
                <div className="skill-group">
                  <GroupLabel count={disabled.length}>{t.skills.disabled}</GroupLabel>
                  {disabled.map((s) => (
                    <SkillRow
                      key={s.slug}
                      skill={s}
                      dim
                      onSelect={props.onSelect}
                      workspaceName={props.workspaceName}
                      onClean={skills.clean}
                      onInsert={props.onInsert}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        )}
      </>
    </RightPanelFrame>
  );
}

/**
 * 一行 skill（Global / workspace 成员 / Disabled 三处共用，原先 `row()` 闭包与
 * `DisabledRow` 是同一份骨架抄了两遍，收成一个组件）。
 *
 * 外层是 `<div>` 不是 `<button>`：missing 行要在行内浮出一个真正可点的清理键
 * （trash IconButton），`<button>` 不能嵌 `<button>`（HTML 语义 + 浏览器会把
 * 内层按钮拆出去，点击语义直接坏掉）。点击语义因此拆成两层——`.skill-row-main`
 * 是「点这行开详情」的唯一入口，外层 `.skill-row` 只管 hover 背景与布局。
 *
 * 归属点阵（SetDots）只在「非 missing、非 disabled」时画：disabled 组的成员按
 * 定义 global=false 且 workspaces=[]（这就是它被分进 Disabled 组的原因），点阵
 * 本来也是空的；missing 走行首红三角 + 红名，两套符号不共存。
 *
 * **hover tooltip**：`useHoverTooltip` 的第二个消费者（第一个是 IconButton，
 * 200ms）。行内容够长——全名、一行描述、mono 的 slug · 集合名——单行 36px 装不下，
 * 描述仍然不进列表行本身（单行纪律不破），但要看得够得着。350ms 比 IconButton
 * 的 200ms 更慢：快速划过整个列表找一行不该处处弹牌子。视觉走实色面板 + 发丝边
 * + popover 阴影（现行 *Transparency* 规则：浮在内容之上的层不用 blur、不用
 * 半透明——设计稿画的是玻璃 tooltip，那是 2026-09-23 去 blur 之前的稿）。
 * `role="tooltip"` + 行按钮 `aria-describedby` 指回它，打开时才挂 id。
 *
 * **missing 就地清理**：断链是列表里唯一需要「处理」的状态，处理入口长在现场——
 * hover（或键盘聚焦到行内）浮出红色 trash（`.reveal`，同一套 hover 浮现机制），
 * 点击进入两段式确认（与 McpPanel 删除同款：一句后果说明 + 确认 / 取消），确认
 * 后才调 `onClean`。确认态替换整行内容而不是另起一行——单行 36px 的纪律不破。
 */
function SkillRow(props: {
  skill: SkillMeta;
  /** Disabled 组：name 降到 tertiary，其余同普通行 */
  dim?: boolean;
  onSelect: (slug: string) => void;
  workspaceName: (id: string) => string;
  onClean: (slug: string) => void;
  /** 行尾「选用」键：插 /skill:<slug> 进输入框（浏览态与选取态都在） */
  onInsert: (token: string) => void;
  /** 选取模式：本行是否高亮（↑↓ 键盘导航的位置） */
  pickerActive?: boolean;
  /** 选取模式：点选即插 token（替换「点开详情」） */
  onPickerSelect?: () => void;
}) {
  const t = useT();
  const { skill } = props;
  const dim = props.dim === true;
  const setNames = [skill.global ? t.skills.global : null, ...skill.workspaces.map(props.workspaceName)].filter(
    (name): name is string => name !== null,
  );
  // 下方、左对齐行左缘 + 10px（对稿 row-tip：top:34 相对行顶即「行下方」、left:10）；
  // IconButton 的默认值（上方、居中）不受影响——只有这个调用点传了 place
  const tooltip = useHoverTooltip<HTMLButtonElement>(ROW_TOOLTIP_DELAY_MS, true, {
    side: "below",
    align: "start",
    alignOffset: 10,
  });
  const tipId = `skill-tip-${skill.slug}`;
  const [confirming, setConfirming] = useState(false);

  if (skill.missing && confirming) {
    return (
      <div className="skill-row skill-row-missing">
        <span className="skill-row-confirm-text">{t.skills.cleanUpConfirm}</span>
        <PanelButton
          danger
          onClick={() => {
            setConfirming(false);
            props.onClean(skill.slug);
          }}
        >
          {t.skills.cleanUp}
        </PanelButton>
        <PanelButton onClick={() => setConfirming(false)}>{t.common.cancel}</PanelButton>
      </div>
    );
  }

  return (
    <div
      className={`skill-row${skill.missing ? " skill-row-missing" : dim ? " skill-row-dim" : ""}${
        props.pickerActive === true ? " picker-active" : ""
      }`}
      data-picker-active={props.pickerActive === true ? "true" : undefined}
    >
      <button
        ref={tooltip.anchorRef}
        type="button"
        className="skill-row-main"
        onClick={() =>
          props.onPickerSelect !== undefined ? props.onPickerSelect() : props.onSelect(skill.slug)
        }
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
        onFocus={tooltip.handlers.onFocus}
        onBlur={tooltip.handlers.onBlur}
        aria-describedby={tooltip.open ? tipId : undefined}
      >
        {skill.missing && (
          <Icon name="triangle-alert" size={13} style={{ color: "var(--color-danger)" }} />
        )}
        <span className="skill-row-name">{skill.name}</span>
      </button>
      {skill.missing && (
        <IconButton
          label={t.skills.cleanUpReferences}
          size={22}
          className="reveal"
          onClick={() => {
            // 打开确认前先收掉 tooltip：确认态整个换掉行内容，锚点按钮会被卸载，
            // 不关的话 tooltip 状态会挂在一个已经不存在的锚点上
            tooltip.handlers.onMouseLeave();
            setConfirming(true);
          }}
        >
          <Icon name="trash-2" size={14} style={{ color: "var(--color-danger)" }} />
        </IconButton>
      )}
      {!skill.missing && !dim && (
        <SetDots global={skill.global} workspaces={skill.workspaces.length} title={setNames.join(", ")} />
      )}
      {/* 「选用」键：悬停 / 键盘聚焦浮现，绝对定位盖在行尾（血线规则的悬停组合
          例外，归属点阵让位）。missing 的不给——token 落进输入框也展开不了 */}
      {!skill.missing && (
        <RowHoverAction
          icon="corner-down-left"
          title={t.skills.use}
          onClick={() => props.onInsert(skillToken(skill.slug))}
          right={2}
          top={8}
          className="reveal skill-row-act"
        />
      )}
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            id={tipId}
            role="tooltip"
            className="skill-row-tip"
            style={{
              top: tooltip.placement?.top ?? 0,
              left: tooltip.placement?.left ?? 0,
              // 未落位前不显形，落位后从透明过渡进来——同 IconButton 的首帧处理
              opacity: tooltip.placement === null ? 0 : 1,
            }}
          >
            <span className="skill-row-tip-name">{skill.name}</span>
            {skill.description !== "" && <span className="skill-row-tip-desc">{skill.description}</span>}
            <span className="skill-row-tip-sets">
              {skill.slug}
              {setNames.length > 0 ? ` · ${setNames.join(t.common.listSeparator)}` : ""}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** footer：中央目录 reveal（新建 / 删除仍走访达——它们是文件管理器最擅长的事）。 */
function FooterReveal(props: { skills: SkillsState }) {
  const t = useT();
  return (
    <>
      <code
        style={{
          fontSize: "var(--font-size-caption)",
          color: "var(--color-text-tertiary)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
        title={t.skills.centralDir}
      >
        skills/
      </code>
      <PanelButton onClick={() => props.skills.reveal(null)} title={t.skills.openDir}>
        <Icon name="folder" size={14} /> {t.skills.reveal}
      </PanelButton>
    </>
  );
}

function SkillDetail(props: {
  skills: SkillsState;
  meta: SkillMeta;
  workspaceName: (id: string) => string;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { skills, meta } = props;
  const [content, setContent] = useState<SkillContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 已落盘的那一份，用来判断失焦时有没有真的改过 */
  const saved = useRef<SkillContent | null>(null);

  useEffect(() => {
    let live = true;
    setContent(null);
    setError(null);
    void api.skill
      .read(meta.slug)
      .then((next) => {
        if (!live) return;
        saved.current = next;
        setContent(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [meta.slug]);

  const commit = (field: keyof SkillContent) => () => {
    const draft = content;
    const base = saved.current;
    if (draft === null || base === null || draft[field] === base[field]) return;
    setSaving(true);
    setError(null);
    void skills
      .save(meta.slug, { [field]: draft[field] })
      .then(() => {
        saved.current = { ...base, [field]: draft[field] };
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const badge = meta.missing
    ? t.skills.missing
    : meta.linkedPath !== null
      ? t.skills.linked
      : meta.global
        ? t.skills.global
        : meta.workspaces.length > 0
          ? t.skills.workspace
          : t.skills.disabled;
  const disabled = meta.missing;
  const disabledTitle = t.skills.missingTip;

  return (
    <RightPanelFrame
      contentKey={`detail:${meta.slug}`}
      onClose={props.onClose}
      header={
        <>
          <PanelIconButton title={t.skills.backToList} onClick={props.onBack}>
            <Icon name="chevron-left" size={16} />
          </PanelIconButton>
          <strong
            style={{
              fontSize: "var(--font-size-title)",
              fontWeight: "var(--weight-bold)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.name}
          </strong>
        </>
      }
      footer={
        meta.missing ? (
          <>
            <span style={{ flex: 1 }} />
            <PanelButton danger onClick={() => skills.clean(meta.slug)}>
              <Icon name="trash-2" size={14} /> {t.skills.cleanUpReferences}
            </PanelButton>
          </>
        ) : (
          <>
            <PanelButton onClick={() => skills.reveal(meta.slug)}>
              <Icon name="folder" size={14} /> {t.skills.showInFinder}
            </PanelButton>
            <span style={{ flex: 1 }} />
            <PanelLine>{saving ? t.skills.saving : t.skills.savedOnBlur}</PanelLine>
          </>
        )
      }
    >
      <div
        style={{
          padding: "var(--space-5) var(--space-4)",
          display: "grid",
          gap: "var(--space-5)",
          opacity: disabled ? 0.55 : undefined,
        }}
      >
        {meta.missing && (
          <PanelLine danger>{t.skills.folderMissing}</PanelLine>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <code
            style={{
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
            title={t.skills.folderNameTip}
          >
            {meta.slug}
          </code>
          {/* muted Badge：中性面 + 小字，不上 accent */}
          <span
            style={{
              padding: "1px 7px",
              background: "var(--color-bg-muted)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-pill)",
              fontSize: "var(--font-size-micro)",
              color: meta.missing ? "var(--color-danger)" : "var(--color-text-secondary)",
            }}
          >
            {badge}
          </span>
          {/* 导入的 skill：标 Linked 并显示真身路径（4-1）；「在访达里显示」揭示的也是真身 */}
          {meta.linkedPath !== null && (
            <span
              style={{
                fontSize: "var(--font-size-micro)",
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-family-mono)",
                overflowWrap: "anywhere",
              }}
              title={meta.linkedPath}
            >
              → {meta.linkedPath}
            </span>
          )}
        </span>

        {!meta.missing && (
          <>
            <Field label={t.skills.worksIn}>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Chip
                  active={meta.global}
                  title={t.skills.everyTask}
                  onClick={() =>
                    meta.global
                      ? skills.unlink(meta.slug, { kind: "global" })
                      : skills.link(meta.slug, { kind: "global" })
                  }
                >
                  {t.skills.global}
                </Chip>
                {skills.workspaces.map((ws) => {
                  const linked = meta.workspaces.includes(ws.id);
                  return (
                    <Chip
                      key={ws.id}
                      active={linked}
                      onClick={() =>
                        linked
                          ? skills.unlink(meta.slug, { kind: "workspace", workspaceId: ws.id })
                          : skills.link(meta.slug, { kind: "workspace", workspaceId: ws.id })
                      }
                    >
                      {ws.name}
                    </Chip>
                  );
                })}
              </span>
              {/* ★ 生效范围贴着动作常驻——用户改完可能很久才开新会话，toast 早没了 */}
              <span style={{ display: "block", marginTop: "var(--space-2)" }}>
                <PanelLine>
                  {t.skills.appliesNext}
                </PanelLine>
              </span>
            </Field>
          </>
        )}

        {error !== null && <PanelLine danger>{t.skills.saveFailed} {error}</PanelLine>}

        {content === null && !meta.missing && <PanelLine>{t.common.loading}</PanelLine>}
        {content !== null && (
          <div
            style={{ display: "grid", gap: "var(--space-4)", pointerEvents: disabled ? "none" : undefined }}
            title={disabled ? disabledTitle : undefined}
          >
            <Field label={t.skills.name} hint={t.skills.nameHint}>
              <PanelInput
                value={content.name}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                onChange={(name) => setContent({ ...content, name })}
                onBlur={commit("name")}
              />
            </Field>
            <Field label={t.skills.description} hint={t.skills.descriptionHint}>
              <textarea
                value={content.description}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                rows={3}
                onChange={(e) => setContent({ ...content, description: e.target.value })}
                onBlur={commit("description")}
                className="text-field"
                style={{ cursor: disabled ? "not-allowed" : undefined }}
              />
            </Field>
            <Field label={t.skills.instructions} hint={t.skills.instructionsHint}>
              <textarea
                value={content.body}
                disabled={disabled}
                title={disabled ? disabledTitle : undefined}
                rows={14}
                onChange={(e) => setContent({ ...content, body: e.target.value })}
                onBlur={commit("body")}
                className="text-field"
                style={{
                  fontFamily: "var(--font-family-mono)",
                  lineHeight: 1.6,
                  cursor: disabled ? "not-allowed" : undefined,
                }}
              />
            </Field>
          </div>
        )}
      </div>
    </RightPanelFrame>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "var(--space-2)" }}>
      <span style={{ fontSize: "var(--font-size-caption)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.hint}
        </span>
      )}
    </label>
  );
}

function PanelInput(props: {
  value: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <input
      value={props.value}
      disabled={props.disabled}
      title={props.title}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      className="text-field"
      style={{ cursor: props.disabled ? "not-allowed" : undefined }}
    />
  );
}

/** + 菜单：Create skill… / Link existing folder…。列表、空态、加载态三处共用。 */
function AddMenu(props: { skills: SkillsState; onCreateSkill: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <PanelIconButton title={t.skills.add} onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={16} />
      </PanelIconButton>
      {open && (
        <span
          style={{
            position: "absolute",
            top: 30,
            right: 0,
            display: "grid",
            gap: 2,
            padding: 4,
            background: "var(--color-bg-panel)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popover)",
            zIndex: 30,
            minWidth: 200,
          }}
        >
          <MenuItemRow
            onClick={() => {
              setOpen(false);
              props.onCreateSkill();
            }}
          >
            <Icon name="plus" size={14} /> {t.skills.create}
          </MenuItemRow>
          <MenuItemRow
            onClick={() => {
              setOpen(false);
              props.skills.importFolder(null);
            }}
          >
            <Icon name="folder-plus" size={14} /> {t.skills.linkFolder}
          </MenuItemRow>
        </span>
      )}
    </span>
  );
}

/** 菜单行（+ 展开的两项）：与面板按钮同语汇，hover 中性抬升。 */
function MenuItemRow(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--control-height-sm)",
        padding: "0 var(--space-3)",
        border: 0,
        background: "transparent",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        color: "var(--color-text-primary)",
        textAlign: "left",
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {props.children}
    </button>
  );
}
