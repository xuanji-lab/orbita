import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Menu } from "./Menu";
import { MaterialStack } from "./composer-material-stack.tsx";
import { PastedTextCollapseContext } from "./attachment-chips";
import type { TextQuote } from "@shared/quote";
import { isPastedTextLarge, pastedTextSize } from "@shared/prompt-attachments";
import { filesOf, type ComposerImage } from "./composer-images.ts";
import type { ComposerFileRef } from "./composer-attachments.ts";
import {
  collapsePasteRange,
  expandPasteToken,
  insertPasteToken,
  parsePasteTokens,
  pasteTokenAfter,
  pasteTokenBefore,
  type ComposerPasteBlock,
} from "./paste-blocks.ts";
import { composerMaterials } from "./composer-materials.ts";
import { composerBoxHeight, COMPOSER_MIN_ROWS } from "./composer-height.ts";
import { isSubmitKey } from "./composer-keys.ts";
import { composerScript } from "./composer-script.ts";
import { replaceToken, slashMode, slashTokenAt } from "./slash-trigger.ts";
import { moveSlashSelection, slashPanelBox, slashRowCount, slashSections, slashRowAt, type SlashPanelBox, type SlashRow } from "./slash-panel.ts";
import { caretPoint } from "./caret-point.ts";
import { isSkillAvailable, type SkillMeta } from "@shared/skill";
import type { McpServerInfo } from "@shared/mcp";
import { chipRangeAfter, chipRangeBefore, mirrorSegments, parseChips } from "./composer-chips.ts";
import { whiteoutSegments, type CompositionRange } from "./whiteout-segments.ts";
import type { DominantScript } from "../features/chat/dominant-script.ts";
import { useDictation, type DictationPhase, type DictationProblem } from "../features/voice/useDictation.ts";
import type { DictationProvider } from "@shared/voice";
import { useT } from "../locale.ts";

/**
 * 输入框。**跨首页与聊天页是同一个组件、同一个宽度**（R8-01 ②：宽度连续性）——
 * 两边都由外层给 `min(100%, var(--content-max-width))`，这里只负责 100% 铺满。
 *
 * 它是第三层玻璃：浮在内容面之上，不在文档流里当一个方盒子。
 *
 * 圆角取 `--radius-xl`，**不取** `--radius-composer`(14px)。设计系统对这条自相矛盾：
 * readme 的 *Corners and borders* 说 composer 是唯一的例外，而 `Composer.jsx` 与
 * `spacing.css` 的注释说「它首先是玻璃卡，所以吃 --radius-xl」。取后者：
 * 玻璃卡就该有统一标准，一个例外换不来任何东西（2026-08-25 wafo 定）。
 */
/** 按内容把输入框的高度量好、设上。行高与 padding 从实际样式来（主题会换它们）。 */
function fitComposerHeight(el: HTMLTextAreaElement): void {
  // 先塌回 auto 才能量到真实内容高度，否则只涨不落
  el.style.height = "auto";
  const computed = getComputedStyle(el);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  const padding =
    Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
  const { height, scrollable } = composerBoxHeight(
    el.scrollHeight,
    Number.isFinite(lineHeight) ? lineHeight : 22,
    Number.isFinite(padding) ? padding : 0,
  );
  el.style.height = `${height}px`;
  el.style.overflowY = scrollable ? "auto" : "hidden";
}

/**
 * 镜像层跟着 textarea：滚动条占掉的宽度补成右内边距（换行位置才一致；镜像自己不出滚动条），
 * 滚动位置对齐。输入框长到上限、开始滚动时才有区别。
 */
function syncMirror(textarea: HTMLTextAreaElement, mirror: HTMLDivElement): void {
  const gutter = textarea.offsetWidth - textarea.clientWidth;
  const padding = Number.parseFloat(getComputedStyle(textarea).paddingRight);
  mirror.style.paddingRight = `${(Number.isFinite(padding) ? padding : 0) + gutter}px`;
  mirror.scrollTop = textarea.scrollTop;
}

/** 修正液只在小学作业主题下画。主题落在 <html data-theme> 上（useTheme.ts / main.tsx 写） */
function isCopybook(): boolean {
  return document.documentElement.dataset.theme === "copybook";
}

export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 打断当前这一轮。没字 + 跑着时发送键变停止键；有字时永远是发送（跑着 = 排队） */
  onStop: () => void;
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  bottomSlot?: React.ReactNode;
  /** 有文件正拖在聊天面板上方：亮起落点虚线。拖放由外层 ChatView 接（整个面板都是落点） */
  dropActive?: boolean;
  /** 输入框里待发的文字引用（按会话隔离，状态在 useChatSession）；展开显示全文 */
  quotes: readonly TextQuote[];
  onRemoveQuote: (index: number) => void;
  /** 跳回被引用的原文；返回 null 表示这条引用的原文不在当前转录里（不画成可点） */
  jumpToQuote: (quote: TextQuote) => (() => void) | undefined;
  /** 输入框里待发的附图（按会话隔离，状态在 useChatSession） */
  attachments: readonly ComposerImage[];
  /** 挑选 / 粘贴 / 拖放进来的文件。分拣与报错在调用方，这里只管收 */
  onAttach: (files: readonly File[]) => void;
  onRemoveAttachment: (id: string) => void;
  /** 回形针菜单的「添加文件夹」：主进程目录选择器（Windows 不能与选文件同框，分两个入口） */
  onPickFolders: () => void;
  /** 输入框里待发的文件引用（同一把会话草稿键隔离） */
  files: readonly ComposerFileRef[];
  onRemoveFile: (id: string) => void;
  /** 草稿里的粘贴块（方案 C）：收起态是句中胶囊（token），展开态是铺底色可编辑的区间 */
  pasted: readonly ComposerPasteBlock[];
  /** 大段粘贴成块：建块并返回 seq（token 要带上它）。插入由 Composer 在光标处做 */
  onAddPasteBlock: (text: string) => number;
  /** 展开：块从收起转展开，区间由这里写回块状态（纯函数算好的新区间） */
  onExpandPaste: (seq: number, range: { start: number; end: number }) => void;
  /** 收起：把区间里的现文（可能已编辑过）存回块，折回收起态 */
  onCollapsePaste: (seq: number, text: string, lines: number) => void;
  /** 当前模型看不了图：有附图时在缩略图下说一句（pi 会把图换成占位文字，不报错） */
  imageUnsupported?: boolean;
  /** 指令面板的动作项（/compact /new）：选中即执行，会话动作由调用方接（发送流不经这里） */
  onCommand?: (command: "compact" | "new") => void;
  /** 指令面板的 skill 清单（ChatView 层 useSkillIndex 的同一份——徽标与面板共用，Composer 不自己拉）。
   * 面板只列对 workspaceId 可用的那部分（isSkillAvailable，与发送端同一谓词） */
  skills: readonly SkillMeta[];
  /** 当前草稿所属的工作区：面板的可用性调词吃它（首页 = picker 选中的；无工作区 = 只剩 global） */
  workspaceId: string | null;
  /** 面板每次打开时触发重拉：新建 / 删除的 skill 下一次打开立即可见 */
  onReloadSkills: () => void;
  /** 指令面板 MCP 栏的 server 清单与重拉（同 skills 的规矩：面板打开时重拉） */
  servers: readonly McpServerInfo[];
  onReloadServers: () => void;
}) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 粘贴文本折叠开关（设置 › collapsePastedText）：关掉后大段粘贴不成 chip，直接进输入框
  const collapsePasted = useContext(PastedTextCollapseContext);
  // 输入卡本体：指令面板（斜杠）绝对定位在卡内，定位与边界的参照系
  const cardRef = useRef<HTMLDivElement>(null);
  // 听写（features/voice/useDictation.ts）：识别文字直接写进这个输入框。听写中输入框只读——
  // 手打的字会被下一次识别结果覆盖；回车 = 结束听写（不发送），Esc = 取消
  const dictation = useDictation({ value: props.value, onChange: props.onChange, textareaRef });
  const dictating = dictation.phase !== "idle";
  const commandListRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // 输入法组词中的范围（没在组词是 null）。拼音字母会先进 value：字距判法在组词期间沿用
  // 上一次的结果，修正液不涂这一截
  const [composition, setComposition] = useState<CompositionRange | null>(null);
  // 以中文还是英文为主（composer-script.ts）：小学作业主题按它切字距。要记住上一次的结果——
  // 渲染中按新输入调整 state，React 会在提交前重渲一遍
  const [script, setScript] = useState<DominantScript>("cjk");
  const nextScript = composerScript(script, props.value, composition !== null);
  if (nextScript !== script) setScript(nextScript);
  // 镜像层（全主题常驻，垫在 textarea 下面）：句中 chip 画在这一层（composer-chips.ts
  // 切区间）；小学作业主题的修正液也画在同一层（whiteout-segments.ts，主题开启时才分段）。
  // 两层区间叠在同一份文本上，chip 区间优先于修正液（mirrorSegments）
  const [whiteout, setWhiteout] = useState(isCopybook);
  // textarea 的滚动位置：展开段的收起标签跟着内容滚（标签在镜像上量坐标，量法吃它）
  const [scrollTop, setScrollTop] = useState(0);
  const chips = useMemo(() => parseChips(props.value), [props.value]);
  // ── 句中粘贴块（方案 C，paste-blocks.ts）──────────────────────────────
  // token 只画有主的：块已沉默（删了又没发）或手打的 token 形状只是普通文字，
  // 不给它们 chip 的假象。展开区间单独一份（空区间已折回收起，不会出现在这里）
  const pasted = props.pasted;
  const pasteBySeq = useMemo(
    () => new Map(pasted.map((block) => [block.seq, block])),
    [pasted],
  );
  const paintedPasteTokens = useMemo(
    () =>
      parsePasteTokens(props.value).filter((token) => {
        const block = pasteBySeq.get(token.seq);
        return block !== undefined && block.range === null;
      }),
    [props.value, pasteBySeq],
  );
  const pasteRuns = useMemo(
    () => pasted.flatMap((block) => (block.range !== null ? [block.range] : [])),
    [pasted],
  );
  // 画成胶囊的区间：skill / mcp 的 token + 收着的粘贴 token（同一副药方）
  const chipSpans = useMemo(() => [...chips, ...paintedPasteTokens], [chips, paintedPasteTokens]);
  const segments = useMemo(
    () =>
      mirrorSegments(
        whiteout ? whiteoutSegments(props.value, composition ?? undefined) : [{ text: props.value, whiteout: false }],
        chipSpans,
        pasteRuns,
      ),
    [whiteout, props.value, composition, chipSpans, pasteRuns],
  );
  /** 展开一块：token 换回全文（execCommand 保撤销栈），区间写回块状态。
   *  区间里的文字从块存的全文来——收起态下它就是唯一真相 */
  const expandPaste = (seq: number): void => {
    const block = pasteBySeq.get(seq);
    if (block === undefined || block.range !== null) return;
    const token = parsePasteTokens(props.value).find((hit) => hit.seq === seq);
    if (token === undefined) return;
    const next = expandPasteToken(props.value, token, block.text);
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(token.start, token.end);
    if (el === null || !document.execCommand("insertText", false, block.text)) {
      props.onChange(next.text);
    }
    props.onExpandPaste(seq, next.range);
  };
  /** 收起一块：区间里的现文（可能已编辑）存回块，换回新 token（行数现算） */
  const collapsePaste = (block: ComposerPasteBlock): void => {
    if (block.range === null) return;
    const rangeText = props.value.slice(block.range.start, block.range.end);
    const { lines } = pastedTextSize(rangeText);
    const token = t.composer.pasteToken(block.seq, lines);
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(block.range.start, block.range.end);
    if (el === null || !document.execCommand("insertText", false, token)) {
      props.onChange(collapsePasteRange(props.value, block.range, token));
    }
    props.onCollapsePaste(block.seq, rangeText, lines);
  };
  // 随内容长高：撤回能把好几条排队消息堆进来，写死两行就只能盲着改。
  // useLayoutEffect 而非 useEffect——量完就改高度，放到绘制后会闪一帧。
  // script 变了也要重量：字距一换行数就变，而组词结束时切换的那一下 value 没有变。
  // 高度一变可能出现或收起滚动条，镜像跟着同步；镜像刚挂上（whiteout 变 true）时也要同步一次
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    fitComposerHeight(el);
    if (mirrorRef.current !== null) syncMirror(el, mirrorRef.current);
  }, [props.value, script, whiteout]);
  // 换主题也要重量：纸面两档的行高是 24px，浅 / 暗是 22px——只跟着 value 量，切主题后高度
  // 停在上一档，方格的末行会被切掉半行（2026-09-25 实测）。同一个信号决定画不画修正液
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    const observer = new MutationObserver(() => {
      fitComposerHeight(el);
      setWhiteout(isCopybook());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  // ── 指令面板（/ 触发）──────────────────────────────────────────────
  // 触发规则在 slash-trigger.ts：光标所在的「指令 token」。两种模式：
  //   主模式（token 在消息开头，之前只有空白）——PR #146 已验收的语义：列动作项
  //   + skill、空态可显示、默认高亮首行、Enter 选中；
  //   补全模式（句中 token）——只列前缀命中的 skill / MCP、无命中不弹、默认不高亮
  //   （Enter 原样落下，打路径时不抢键），Esc 后同一 token 内不再弹（Codex 的
  //   dismissed token 同款）。
  // 面板往下开、分节（指令 / Skills / MCP）、几何不伸出输入卡——模型在
  // slash-panel.ts，/ 字符坐标的量法在 caret-point.ts（2026-10-03 用户裁决）。
  // 主模式的关闭态分两种语义（用户实测：选中/ESC 后再打 / 前缀文字，面板不弹，
  // Enter 把半截指令当普通消息发出去了）：
  //   "esc"——Esc 关闭或动作项执行完：继续输入就重开（人还在 / 模式里，面板是输入辅助）
  //   "insert"——skill / mcp 插入后：保持关闭直到离开 / 前缀（用户在补
  //   附加指示，弹出「没有匹配的指令」空态只会挡视线）
  const [commandsClosed, setCommandsClosed] = useState<"esc" | "insert" | null>(null);
  // 选中行（跨节全局行号；-1 = 无高亮——补全模式默认，↑↓ 才开始选中）
  const [slashRow, setSlashRow] = useState(-1);
  // 补全模式的 Esc 记忆：被关掉的 token 起点不重弹，换 token / 离开才重弹
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  // 光标位置是触发条件之一（面板只在光标处于 token 内时亮）。纯移动不经过 onChange，
  // 所以还要 onSelect 跟；value 被外部改写（草稿恢复、指令插入）后从 DOM 回同步一次
  const [cursor, setCursor] = useState(0);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el !== null) setCursor(el.selectionStart);
  }, [props.value]);
  const token = slashTokenAt(props.value, cursor);
  // token 每次渲染都是新对象，effect / memo 的依赖只能吃稳定标量，否则无限重渲
  // （2026-10-03 真机抓到：面板一开就 Maximum update depth）
  const tokenStart = token?.start ?? -1;
  const tokenAtStart = token?.atMessageStart === true;
  const startToken = token !== null && token.atMessageStart ? token : null;
  const commandQuery = token?.query ?? "";
  // 行先于开关算（不带 panelOpen 门控）：补全模式无命中时面板要**整个不弹**，
  // 开关反过来要看行数，顺序颠倒就循环了。token 为 null 时直接空表，不自费
  // 当前工作区可用的 skill（isSkillAvailable 与主进程发送端同一份——面板认的，
  // 发送时必然认；两个满不在同一处，面板就会列出发出去只报「不存在」的 skill）
  const availableSkills = useMemo(
    () => props.skills.filter((meta) => isSkillAvailable(meta, props.workspaceId)),
    [props.skills, props.workspaceId],
  );
  // Skills 节空态：主模式、还没打查询词时补一句「这个工作区没有可用 skill」——
  // 面板不静默少一节，用户才知道是归属问题而不是面板坏了。打了查询词就回到
  // 「没有匹配的指令」的整体空态，不为过滤结果另起一套文案
  const skillsEmptyHint =
    tokenAtStart && commandQuery.trim() === "" && availableSkills.length === 0;
  const commandSections = useMemo(
    () =>
      slashSections({
        atMessageStart: tokenAtStart,
        query: commandQuery,
        commands: [
          { kind: "compact", name: "compact", description: t.composer.cmdCompact },
          { kind: "new", name: "new", description: t.composer.cmdNew },
        ],
        skills: availableSkills,
        servers: props.servers
          .filter((server) => server.status.kind !== "disabled")
          .map((server) => ({ name: server.name, detail: server.detail })),
      }),
    [tokenAtStart, commandQuery, availableSkills, props.servers, t],
  );
  const commandRowsTotal = slashRowCount(commandSections);
  const panelOpen =
    startToken !== null
      ? commandsClosed === null
      : token !== null && token.start !== dismissedStart && commandRowsTotal > 0;
  useEffect(() => {
    if (panelOpen) {
      props.onReloadSkills();
      props.onReloadServers();
    }
  }, [panelOpen, props.onReloadSkills, props.onReloadServers]);
  // 依赖是**值**而不是「是否在 / 模式」那个布尔：Esc 关闭后继续打字要重开面板，
  // 而多打一个字不会让布尔变——拿布尔当依赖，"esc" 就永远清不掉（2026-10-01 真机验收抓到）
  useEffect(() => {
    if (!slashMode(props.value)) setCommandsClosed(null);
    // "esc" 类关闭在继续输入时重开；"insert" 保持（只有离开 / 前缀才重置）
    else setCommandsClosed((closed) => (closed === "esc" ? null : closed));
  }, [props.value]);
  // 离开 token（删掉 / 或移走光标）后补全模式的 Esc 记忆重新武装
  useEffect(() => {
    if (token === null) setDismissedStart(null);
  }, [token === null]);
  // 查询词或模式变了选中态归位：主模式高亮首行，补全模式无高亮（Enter 不抢键）
  useEffect(() => {
    setSlashRow(startToken !== null ? 0 : -1);
  }, [commandQuery, startToken !== null]);
  // 面板几何：面板开着就量 `/` 字符的坐标（打字会挪行、换行会变行）。量完在
  // 同一个 commit 里落位，不闪。面板关了就作废，下次开重量
  const [slashBox, setSlashBox] = useState<SlashPanelBox | null>(null);
  useLayoutEffect(() => {
    if (!panelOpen || token === null) {
      setSlashBox(null);
      return;
    }
    const ta = textareaRef.current;
    const card = cardRef.current;
    if (ta === null || card === null) return;
    const point = caretPoint(ta, token.start);
    if (point === null) return;
    const taRect = ta.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    const borderLeft = Number.parseFloat(cardStyle.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(cardStyle.borderTopWidth) || 0;
    setSlashBox(
      slashPanelBox({
        // 卡的 padding box 坐标系（面板绝对定位的参照系）
        slashLeft: taRect.left + point.left - (cardRect.left + borderLeft),
        lineBottom: taRect.top + point.top + point.height - (cardRect.top + borderTop),
        cardWidth: card.clientWidth,
        // 底部留 4px：可以盖住底栏（+、模型名、发送键），但不伸出卡外
        cardBottom: card.clientHeight - 4,
      }),
    );
    // 依赖全部是标量：token 对象每渲染都是新的，直接当依赖会无限重渲
  }, [panelOpen, tokenStart, props.value, cursor, script]);
  // 键盘选中滚出可视区时带动面板滚动（↑↓ 跨节续行、←→ 跳节都靠它把目标滚连来）。
  // block:"nearest" 只在需要时滚，不抖。无高亮（-1）时无选中项，自然不滚
  useEffect(() => {
    commandListRef.current
      ?.querySelector(`[data-row="${slashRow}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slashRow, commandSections]);

  /** 选中指令后把光标钉在插入文本之后：onChange 改的是父级状态，等 React 提交完再设选区 */
  const pinCursor = (position: number): void => {
    setCursor(position);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(position, position);
      }
    });
  };
  /** 面板选中。skill / mcp：只替换 token 本身，前后文（含同行的附加指示、后续行）
   * 原样保留，光标钉在插入之后——主模式与补全模式同一规则；主模式另落 "insert"
   * 关闭态（补全模式插入后光标在尾随空格后，天然不在任何 token 上，不需要）。
   * /mcp:<server> 的发送端语义在另一刀（src/shared/skill.ts 那侧），这里只负责把
   * token 插进去。动作项只在主模式列出，选中即执行，并清掉半截指令残留——"/c"
   * 留在框里，下一次回车就又是一条误发 */
  const runRow = (row: SlashRow): void => {
    // 点击/回车时重算一次：面板开着必有 token，但闭包里的这份可能已陈旧
    const token = slashTokenAt(props.value, cursor);
    if (row.kind === "skill" || row.kind === "mcp") {
      if (token === null) return;
      if (token.atMessageStart) setCommandsClosed("insert");
      const inserted = row.kind === "skill" ? `/skill:${row.slug} ` : `/mcp:${row.server} `;
      props.onChange(replaceToken(props.value, token, inserted));
      pinCursor(token.start + inserted.length);
    } else {
      setCommandsClosed("esc");
      if (props.onCommand !== undefined) {
        props.onCommand(row.action);
        // 全清而不是只丢指令行：/new 的语义就是「清草稿清附件再开会话」，
        // ChatView 在 onCommand 里已经 setDraft("")，这里再写回剩余行会把
        // 清掉的东西复活到新会话的草稿里
        props.onChange("");
        pinCursor(0);
      } else if (token !== null) {
        // row.name 已带前导 /（面板里显示的就是插入形态）
        const inserted = `${row.name} `;
        props.onChange(replaceToken(props.value, token, inserted));
        pinCursor(token.start + inserted.length);
      }
    }
    textareaRef.current?.focus();
  };

  const disabled = props.disabled === true;
  const running = props.running === true;
  // 材料清单（composer-materials.ts 的唯一数据来源）：叠放层与后续排布都吃它。
  // useMemo 的依赖按值给全——清单是每次渲染重建的数组，闭包里的 remove 回调才新鲜
  const materials = useMemo(
    () =>
      composerMaterials({
        attachments: props.attachments,
        files: props.files,
        quotes: props.quotes,
        onRemoveAttachment: props.onRemoveAttachment,
        onRemoveFile: props.onRemoveFile,
        onRemoveQuote: props.onRemoveQuote,
        t,
      }),
    [props.attachments, props.files, props.quotes, props.onRemoveAttachment, props.onRemoveFile, props.onRemoveQuote, t],
  );
  // 有字就能发——跑着的时候 Enter 是排队发送（C-1）。没字 + 跑着 = 停止键：
  // 同一个位置的两面，按输入态切换。想停止时清掉草稿即可，排队是高频动作、停止是少数。
  // 有图 / 有附件 / 有引用没字也能发——一张截图本身就是一句完整的话
  // 有主的粘贴让文本非空（token / 展开区间都是文字），纯图 / 文件 / 引用照旧能发
  const sendable =
    !disabled &&
    (props.value.trim() !== "" ||
      props.attachments.length > 0 ||
      props.quotes.length > 0 ||
      props.files.length > 0);
  const stopping = running && !sendable;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragging = props.dropActive === true;
  return (
    // 材料叠放（B 定稿）：四路附件全部移出输入卡，叠在卡片上方——截图一行、胶囊一行、
    // 引用一张卡，都坐在聊天面上；输入卡只剩输入本身（叠放层在 composer-materials.tsx）。
    // composer-stack 同时是引用卡两列版式的 container query 容器（窄窗 / 抽屉里回落一列）
    <div className="composer-stack" style={{ width: "100%", minWidth: 0, display: "grid", gap: "var(--space-2)" }}>
      <MaterialStack materials={materials} imageUnsupported={props.imageUnsupported} jumpToQuote={props.jumpToQuote} />
      <div
        ref={cardRef}
        className="glass-card"
        style={{
          width: "100%",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px 8px",
          // 指令面板（commit 3 起）绝对定位在卡内，盖着底栏开——不伸到卡外
          position: "relative",
          // 拖进来时的落点提示：中性虚线，不染 accent（accent 只给主操作）
          outline: dragging ? "1.5px dashed var(--color-border-strong)" : undefined,
          outlineOffset: -5,
        }}
      >
      {panelOpen && (
        <div
          ref={commandListRef}
          role="listbox"
          aria-label={t.composer.commandPanel}
          className="slash-panel"
          style={
            slashBox === null
              ? // 几何还没量出来（首次开的第一个 commit）：先藏起来占位，量完即落位
                { visibility: "hidden", left: 0, top: 0, width: 0, maxHeight: 0 }
              : {
                  left: slashBox.left,
                  top: slashBox.top,
                  width: slashBox.width,
                  maxHeight: slashBox.maxHeight,
                }
          }
        >
          {commandSections.length === 0 ? (
            <div className="slash-empty">{t.composer.commandNoMatch}</div>
          ) : (
            (() => {
              let rowNumber = 0;
              return commandSections.map((section) => {
                const kicker =
                  section.id === "commands"
                    ? t.composer.slashSectionCommands
                    : section.id === "skills"
                      ? t.composer.slashSectionSkills
                      : t.composer.slashSectionMcp;
                return (
                  <Fragment key={section.id}>
                  <div role="group" aria-label={kicker}>
                    <div className="slash-kicker" aria-hidden="true">
                      {kicker}
                    </div>
                    {section.rows.map((row) => {
                      const current = rowNumber++;
                      return (
                        <button
                          key={row.name}
                          type="button"
                          role="option"
                          data-row={current}
                          aria-selected={current === slashRow}
                          onClick={() => runRow(row)}
                          onMouseEnter={() => setSlashRow(current)}
                          // 选中/悬停底色走 .option-row 配方（styles.css 的 aria-selected 规则，
                          // 与菜单/抽屉同一实现——wafo 二轮：状态样式不写在 inline 三元里）
                          className="option-row slash-row"
                        >
                          <Icon
                            name={
                              row.kind === "skill"
                                ? "book-open"
                                : row.kind === "mcp"
                                  ? "plug"
                                  : row.action === "compact"
                                    ? "fold-vertical"
                                    : "message-square-dashed"
                            }
                            size={13}
                            strokeWidth={1.8}
                            style={{ color: "var(--color-text-secondary)", flex: "0 0 auto" }}
                          />
                          <span className="slash-name">{row.name}</span>
                          {/* 说明只在面板够宽时显示（几何在 slash-panel.ts 里量过）；藏掉时
                              title 兜底，鼠标悬停还能看 */}
                          {slashBox?.showDescription !== false && (
                            <span className="slash-desc" title={row.description}>
                              {row.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Skills 空态提示跟在指令节后面（skillsEmptyHint 只在查询词为空时成立，
                      而 q=空时指令节必然在）；不可选中、不占行号——它不是选项 */}
                  {section.id === "commands" && skillsEmptyHint && (
                    <div role="group" aria-label={t.composer.slashSectionSkills}>
                      <div className="slash-kicker" aria-hidden="true">
                        {t.composer.slashSectionSkills}
                      </div>
                      <div className="slash-empty">{t.composer.skillNoneInWorkspace}</div>
                    </div>
                  )}
                  </Fragment>
                );
              });
            })()
          )}
        </div>
      )}
      <div className={`composer-field${pasteRuns.length > 0 ? " has-paste-run" : ""}`}>
        {/*
          镜像层（全主题常驻）：与 textarea 同字体、同字距、同宽，字是透明的，只画 chip 与
          （copybook 的）修正液。句中 token 在这里包成 .composer-chip——chip 的视觉垫在
          textarea 的字底下，两者共用同一套排版才逐像素对齐（选型报告 §3-D）。
          末尾补一个零宽字符：textarea 末尾的换行会多出一行，div 里不会，滚动范围就对不上
        */}
        <div ref={mirrorRef} className="composer-input composer-mirror" data-script={script} aria-hidden="true">
          {segments.map((segment, index) =>
            segment.chip ? (
              <span key={index} className="composer-chip">
                {segment.text}
              </span>
            ) : segment.pasteRun ? (
              <span key={index} className="composer-paste-run">
                {segment.text}
              </span>
            ) : segment.whiteout ? (
              <span key={index} className="composer-whiteout">
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
          {"\u200b"}
        </div>
        {/* 展开段的收起标签：浮在区间头上（.composer-field 内绝对定位，叠在 textarea
            之上可点击）。不在镜像层里——镜像的 textContent 必须与 textarea 逐字一致
            （caret-point 的 locateText 靠它），多一颗按钮就全乱了 */}
        {pasted.map((block) =>
          block.range !== null && block.range.end > block.range.start ? (
            <PasteRunLabel
              key={block.id}
              textareaRef={textareaRef}
              range={block.range}
              textLength={props.value.length}
              scrollTop={scrollTop}
              label={t.composer.pasteRunLabel(pastedTextSize(props.value.slice(block.range.start, block.range.end)).lines)}
              onCollapse={() => collapsePaste(block)}
            />
          ) : null,
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          data-script={script}
          rows={COMPOSER_MIN_ROWS}
          value={props.value}
          disabled={disabled}
          readOnly={dictating}
          placeholder={props.placeholder}
          onChange={(event) => {
            // 上一次听写的问题说过了：用户动手打字就收起来
            if (dictation.problem !== null) dictation.clearProblem();
            setCursor(event.target.selectionStart);
            props.onChange(event.target.value);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onClick={(event) => {
            // 点在句中粘贴胶囊上 = 展开（方案 C：点开 = 全文真正回到输入框里）。
            // 点击把光标落在 token 内（含两端），非空选区（拖选 / 双击选词）不算。
            // 只认有主且收起着的块——沉默的 token 是普通文字
            const el = event.currentTarget;
            if (el.selectionStart !== el.selectionEnd) return;
            const caret = el.selectionStart;
            const hit = paintedPasteTokens.find(
              (token) => caret >= token.start && caret <= token.end,
            );
            if (hit !== undefined) expandPaste(hit.seq);
          }}
          onPaste={(event) => {
            // 剪贴板里有文件（截图、从别处复制的文件）才拦；分拣与报错在调用方。
            // 浏览器复制文件常常同时带一份 HTML/URL 文本——有文件时以文件为准，文本不贴
            const files = filesOf(event.clipboardData);
            if (files.length > 0) {
              event.preventDefault();
              props.onAttach(files);
              return;
            }
            // 纯文字粘贴：超过折叠阈值的一大段在**光标处**收成句中胶囊（方案 C：鼠标光标
            // 在哪，粘贴就在哪），全文进粘贴块永不截断；普通文字照常进输入框。设置关掉
            // 折叠后不拦截——大段文字也直接进输入框。插入走 execCommand：撤销一步连
            // 胶囊带全文一起还原
            const text = event.clipboardData.getData("text/plain");
            if (collapsePasted && text !== "" && isPastedTextLarge(text)) {
              event.preventDefault();
              const el = event.currentTarget;
              const caret = el.selectionStart ?? el.value.length;
              const seq = props.onAddPasteBlock(text);
              const token = t.composer.pasteToken(seq, pastedTextSize(text).lines);
              el.focus();
              el.setSelectionRange(caret, caret);
              if (!document.execCommand("insertText", false, token)) {
                props.onChange(insertPasteToken(el.value, caret, token));
              }
            }
          }}
          onKeyDown={(event) => {
            // 听写中：回车结束听写，文字留在框里等你再看一眼——不直接发出去（Esc 在 useDictation 里接）
            if (dictating) {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                dictation.finish();
              }
              return;
            }
            // 句中 chip 的整块删除：光标贴在 chip 尾按 Backspace（chip 头按 Delete）删整个
            // token——逐字删一个 chip 像撕票根。skill / mcp 的 token 与句中粘贴胶囊同一套
            // 判定与机制。选区非空、组词中、带修饰键（Ctrl+Backspace 是删词）都走原生。
            // 选区整块选中后用 execCommand 删：它走原生输入路径，撤销栈保住（Ctrl+Z
            // 一步还原整个 token，原型验证）；execCommand 已 deprecated 但
            // Chromium/Electron 可用，失败时退 setRangeText（牺牲撤销粒度，行为不坏）。
            // 删除触发的 input 事件照常走 onChange，光标状态由它同步；被删的粘贴块不
            // 立刻清——Ctrl+Z 要能还原，块在发送 / 清草稿时结算（paste-blocks.ts）
            if (
              (event.key === "Backspace" || event.key === "Delete") &&
              !event.nativeEvent.isComposing &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              const el = event.currentTarget;
              if (el.selectionStart === el.selectionEnd) {
                const backspace = event.key === "Backspace";
                const chip = backspace
                  ? chipRangeBefore(el.value, el.selectionStart)
                  : chipRangeAfter(el.value, el.selectionEnd);
                const paste = backspace
                  ? pasteTokenBefore(el.value, el.selectionStart)
                  : pasteTokenAfter(el.value, el.selectionEnd);
                // 粘贴 token 只整删有主且收起着的（沉默 / 展开中的 token 不是胶囊）
                const owner = paste !== null ? pasteBySeq.get(paste.seq) : undefined;
                const pasteOwned =
                  paste !== null && owner !== undefined && owner.range === null ? paste : null;
                const span =
                  chip !== null
                    ? { start: chip.start, end: chip.end }
                    : pasteOwned !== null
                      ? { start: pasteOwned.start, end: pasteOwned.end }
                      : null;
                if (span !== null) {
                  event.preventDefault();
                  el.setSelectionRange(span.start, span.end);
                  if (!document.execCommand("delete")) {
                    el.setRangeText("", span.start, span.end, "end");
                  }
                }
              }
            }
            // 面板开着时方向键与 Enter 归面板；Esc 关面板，内容照在。组词中的按键不动面板。
            // ↑↓ 跨节线性移动（节边界自然续到下一节、两端循环）；←→ 跳相邻节并选中
            // 它的第一项——**只在已有高亮时接管**：补全模式默认无高亮，←→ 先留给光标
            // （同「Enter 不抢键」的道理：打路径时面板在场，箭头不能凭空变成选单导航）。
            // 主模式默认高亮首行，←→ 从一开始就是切节。补全模式无高亮（-1）时 ↑↓ 才
            // 开始选中、Enter 不抢键（原样发送/换行）——Cursor 被官方认定成 UX bug
            // 的正是这类事
            if (panelOpen && !event.nativeEvent.isComposing) {
              if (event.key === "ArrowDown" && commandRowsTotal > 0) {
                event.preventDefault();
                setSlashRow((row) => moveSlashSelection(commandSections, row, "down"));
                return;
              }
              if (event.key === "ArrowUp" && commandRowsTotal > 0) {
                event.preventDefault();
                setSlashRow((row) => moveSlashSelection(commandSections, row, "up"));
                return;
              }
              if (
                (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
                commandRowsTotal > 0 &&
                slashRow >= 0
              ) {
                event.preventDefault();
                setSlashRow((row) => moveSlashSelection(commandSections, row, event.key === "ArrowLeft" ? "left" : "right"));
                return;
              }
              if (event.key === "Enter" && slashRow >= 0 && slashRow < commandRowsTotal) {
                event.preventDefault();
                const row = slashRowAt(commandSections, slashRow);
                if (row !== undefined) runRow(row);
                return;
              }
              if (event.key === "Escape") {
                // 主模式沿用既有语义（继续输入就重开）；补全模式记住被关的 token，
                // 同一 token 内不再弹，换 token / 离开才重弹（Codex 同款）
                if (startToken !== null) setCommandsClosed("esc");
                else setDismissedStart(token?.start ?? null);
                return;
              }
            }
            // 组词中的 Enter 是「确认候选词」，不是发送——规则与用例在 composer-keys.ts
            if (!isSubmitKey({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            })) return;
            event.preventDefault();
            if (sendable) props.onSubmit();
          }}
          onCompositionStart={(event) => {
            const start = event.currentTarget.selectionStart;
            setComposition({ start, end: start });
          }}
          onCompositionUpdate={(event) => {
            const length = event.data.length;
            setComposition((current) => (current === null ? null : { start: current.start, end: current.start + length }));
          }}
          onCompositionEnd={() => setComposition(null)}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            if (mirrorRef.current !== null) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          style={{
            width: "100%",
            border: 0,
            // 高度由上面的 layout effect 接管；把手会和自增高打架
            resize: "none",
            overflowY: "hidden",
            outline: "none",
            color: "var(--color-text-primary)",
          }}
        />
      </div>
      {(dictating || dictation.problem !== null) && (
        <DictationStatus phase={dictation.phase} problem={dictation.problem} provider={dictation.provider} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/*
          芯片群包一层：flex:1 1 auto + min-width:0 让它先于发送键让路，
          overflow:hidden 兜底——窄到连图标态都装不下时裁掉多出来的，而不是把
          发送键挤出可见区（`.composer-bottom-bar` 的容器查询规则见 styles.css）。
        */}
        <Menu
          items={[
            {
              id: "files",
              label: t.composer.attachFileAction,
              icon: "file",
              onSelect: () => fileInputRef.current?.click(),
            },
            {
              id: "folders",
              label: t.composer.attachFolderAction,
              icon: "folder-plus",
              onSelect: () => void props.onPickFolders(),
            },
          ]}
          // 底栏芯片一律朝上开（同 menu-position 的 above 规则）：菜单盖住输入框，
          // 不盖住底下正在看的内容
          placement="above"
          panelMinWidth={170}
          trigger={({ open, toggle }) => (
            <IconButton
              label={t.composer.attachFiles}
              size={28}
              active={open}
              disabled={disabled}
              onClick={toggle}
              style={{ flex: "0 0 auto" }}
            >
              <Icon name="paperclip" size={15} strokeWidth={1.8} />
            </IconButton>
          )}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            props.onAttach(Array.from(event.target.files ?? []));
            // 清掉选择：同一张图移除后再选一次，change 才会再触发
            event.target.value = "";
          }}
        />
        <div className="composer-bottom-bar">{props.bottomSlot}</div>
        <IconButton
          label={dictating ? t.voice.dictateFinish : t.voice.dictate}
          size={28}
          active={dictation.phase === "listening"}
          disabled={disabled || dictation.phase === "finishing"}
          onClick={dictation.toggle}
          style={{ marginInlineStart: "auto", flex: "0 0 auto" }}
        >
          {dictation.phase === "connecting" || dictation.phase === "finishing" ? (
            <Icon name="loader-circle" size={15} spin />
          ) : (
            <Icon name="mic" size={15} strokeWidth={1.8} className={dictation.phase === "listening" ? "orbita-breath" : undefined} />
          )}
        </IconButton>
        <button
          type="button"
          className="btn-accent"
          data-tone={stopping ? "danger" : undefined}
          aria-label={sendable ? t.composer.send : stopping ? t.composer.stop : t.composer.send}
          title={sendable ? t.composer.send : stopping ? t.composer.stopTurn : t.composer.send}
          // 听写中不发送：识别文字还在变，先结束听写（回车或再点麦克风）再发
          disabled={dictating || (!sendable && !stopping)}
          onClick={() => (sendable ? props.onSubmit() : props.onStop())}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            flex: "0 0 auto",
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-pill)",
          }}
        >
          <Icon name={sendable ? "arrow-up" : "square"} size={sendable ? 16 : 12} />
        </button>
      </div>
      </div>
    </div>
  );
}

/**
 * 展开段的收起标签（方案 C）：一枚小胶囊浮在粘贴段开头一行之上，图标 + 「N 行 ·
 * 收起」，点它把段收回句中胶囊。坐标在常驻镜像层上量（caret-point），随滚动 /
 * 打字 / 换行重 量：段头滚出视野上方时钉在顶边（不用滚回去就能收）；滚到视野
 * 下方时藏起（还不相干）。右缘不伸出输入框（行尾血线：浮层也是用户可见面）。
 */
function PasteRunLabel(props: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  range: { start: number; end: number };
  /** 量坐标的重 量信号：文字变了换行可能变 */
  textLength: number;
  scrollTop: number;
  label: string;
  onCollapse: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // null = 还没量出来或段头在视野下方——按钮藏在文档流外占位，宽度仍可量
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  // 窗口改尺寸换行会变，重 量一次（与斜杠面板同一补法）
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const onResize = (): void => setResizeTick((tick) => tick + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useLayoutEffect(() => {
    const ta = props.textareaRef.current;
    if (ta === null) return;
    const point = caretPoint(ta, props.range.start);
    if (point === null) {
      setBox(null);
      return;
    }
    const width = ref.current?.offsetWidth ?? 0;
    const height = 18;
    const left = Math.max(Math.min(point.left, ta.clientWidth - width), 0);
    // point 是 textarea 边盒坐标，标签定位在 field（含头部空间带）——加 offsetTop
    // 换到同一坐标系；有头部空间时标签正好落在带里，不压字
    const base = point.top + ta.offsetTop;
    // 段头在视野上方 → 钉顶；在视野下方 → 藏起；否则浮在段头一行之上
    if (point.top > ta.clientHeight) {
      setBox(null);
    } else {
      setBox({ left, top: base - height <= 0 ? 0 : base - height });
    }
  }, [props.textareaRef, props.range.start, props.range.end, props.textLength, props.scrollTop, props.label, resizeTick]);
  return (
    <button
      ref={ref}
      type="button"
      className="composer-paste-label"
      title={props.label}
      onClick={props.onCollapse}
      style={
        box === null
          ? { visibility: "hidden", left: 0, top: 0 }
          : { left: box.left, top: box.top }
      }
    >
      <Icon name="file-text" size={12} strokeWidth={1.8} />
      <span>{props.label}</span>
    </button>
  );
}

/**
 * 听写的一行状态：进行中说「在干什么、怎么结束」，出了问题说原因（服务端的原话用等宽跟在后面）。
 * 状态用图标 + 文字，红色只给失败（设计系统：颜色是第二信号）。厂商名跟着这次听写用的那家。
 */
function DictationStatus(props: {
  phase: DictationPhase;
  problem: DictationProblem | null;
  provider: DictationProvider | null;
}) {
  const t = useT();
  const problem = props.problem;
  const text =
    problem !== null
      ? problem.kind === "mic-denied"
        ? t.voice.micDenied
        : problem.kind === "mic-unavailable"
          ? t.voice.micUnavailable
          : t.voice.failures[problem.reason](problem.provider)
      : props.phase === "connecting"
        ? t.voice.connecting(props.provider ?? "doubao")
        : props.phase === "finishing"
          ? t.voice.finishing
          : t.voice.listening;
  const detail = problem !== null && problem.kind === "service" ? problem.detail : undefined;
  return (
    <div
      role={problem !== null ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        minWidth: 0,
        fontSize: "var(--font-size-caption)",
        color: problem !== null ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
    >
      <Icon name={problem !== null ? "triangle-alert" : "mic"} size={12} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
      <span style={{ minWidth: 0 }}>{text}</span>
      {detail !== undefined && (
        <code
          title={detail}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-family-mono)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {detail}
        </code>
      )}
    </div>
  );
}
