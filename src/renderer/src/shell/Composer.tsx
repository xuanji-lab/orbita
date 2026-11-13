import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { caretPoint } from "./caret-point.ts";
import {
  slashSpaceOpensPanel,
} from "./panel-token.ts";
import {
  chipRangeAfter,
  chipRangeBefore,
  chipRemovalRange,
  chipIconName,
  mirrorSegments,
  parseChips,
  snapSelection,
  type ChipKind,
  type TextSelection,
} from "./composer-chips.ts";
import { whiteoutSegments, type CompositionRange } from "./whiteout-segments.ts";
import type { DominantScript } from "../features/chat/dominant-script.ts";
import { useDictation } from "../features/voice/useDictation.ts";
import { DictationStatus } from "../features/voice/DictationStatus.tsx";
import { useT } from "../locale.ts";
import { pluginChipName } from "../features/plugins/plugin-names.ts";
import { usePluginNames } from "../features/plugins/usePluginNames.ts";

/**
 * 输入框。**跨首页与聊天页是同一个组件、同一个宽度**（R8-01 ②：宽度连续性）——
 * 两边都由外层给 `min(100%, var(--content-max-width))`，这里只负责 100% 铺满。
 *
 * 它是第三层玻璃：浮在内容面之上，不在文档流里当一个方盒子。
 *
 * 圆角取 `--radius-xl`：它首先是玻璃卡，玻璃卡就该有统一标准，一个例外换不来任何东西
 * （2026-08-25 wafo 定；readme *Corners and borders* 已同步，14px 只留给用户气泡）。
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

/**
 * 指针下是哪颗胶囊的 ×（返回那颗 chip 的起点）。textarea 盖在镜像上，× 收不到指针事件——
 * 按坐标对镜像里的 × 量。外扩 2px：12px 的字形太小，点偏一点也算。
 */
function chipCloseAt(mirror: HTMLDivElement | null, x: number, y: number): number | null {
  if (mirror === null) return null;
  for (const close of mirror.querySelectorAll<HTMLElement>(".composer-chip-x")) {
    const box = close.getBoundingClientRect();
    if (x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2) {
      const start = Number(close.dataset["chipStart"]);
      return Number.isInteger(start) ? start : null;
    }
  }
  return null;
}

/**
 * 胶囊的脸：类别图标 + 名字 + ×，盖在 token 原文自己的格子上（原文透明、只占位）。
 * **不贡献任何文字**：镜像的 textContent 必须与 textarea 逐字一致（caret-point 的
 * locateText 靠它）——图标是无文本的 SVG，名字走 ::before 的 attr(data-name)。
 * 名字继承输入框的字（同字体、同字号、同字距），所以它的宽度就是原文里名字那一截的宽度，
 * 藏掉的 `/skill:`（34px）/ `/mcp:`（37.5px）正好让给图标、× 与左右留白。
 * 插件 chip 写的是**显示名**（可能是中文，宽度与标识不同）：名字槽可收缩、放不下时省略号截断，
 * 胶囊永远不超出 token 原文占的格子（超出会盖住后面的字）。
 */
function ChipFace(props: { kind: ChipKind; name: string; start: number }) {
  return (
    <span className="composer-chip-face" aria-hidden="true">
      <Icon name={chipIconName(props.kind)} size={12} strokeWidth={1.8} />
      <span className="composer-chip-name" data-name={props.name} />
      <span className="composer-chip-x" data-chip-start={props.start}>
        <Icon name="x" size={12} strokeWidth={2} />
      </span>
    </span>
  );
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
  /**
   * 「/ + 空格」打开右栏选取（panel-token.ts）：行首或空白后孤立的 / 按下空格时
   * （句中同样触发，2026-10-11 用户裁定），Composer 删掉这个 / 并把插入锚点
   * 交给调用方（App 开面板）。返回 false 或
   * 不传 = 没人接，空格照常逃字。只有主槽的
   * ChatView 提供；抽屉 / 面板内的 Composer 不参与（那边没有右栏选取可接）。
   */
  onSlashSpace?: (position: number) => boolean;
}) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 粘贴文本折叠开关（设置 › collapsePastedText）：关掉后大段粘贴不成 chip，直接进输入框
  const collapsePasted = useContext(PastedTextCollapseContext);
  // 听写（features/voice/useDictation.ts）：识别文字直接写进这个输入框。听写中输入框只读——
  // 手打的字会被下一次识别结果覆盖；回车 = 结束听写（不发送），Esc = 取消
  const dictation = useDictation({ value: props.value, onChange: props.onChange, textareaRef });
  const dictating = dictation.phase !== "idle";
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
  // 插件 chip 写显示名（中文）；表由插件页与首次订阅填
  const pluginNames = usePluginNames();
  // 镜像里的 chip 段按起点找回那颗 chip（胶囊的名字、× 的归属都要它）
  const chipAt = useMemo(() => new Map(chips.map((chip) => [chip.start, chip])), [chips]);
  // 指针停在哪颗胶囊的 × 上（chip 起点）：× 提亮、指针变手
  const [closeHover, setCloseHover] = useState<number | null>(null);
  // 光标吸附（snapSelection）要的上一次选区：键盘移动靠它判方向；按着鼠标时不吸（拖选中），
  // 松手再按「指针」口径吸一次
  const lastSelectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const pointerDownRef = useRef(false);
  /** 把选区的端点吸到胶囊边上（端点不在胶囊中间就不动），并记下这一次的选区 */
  const snapToChips = (el: HTMLTextAreaElement, prev: TextSelection | null): void => {
    const next = { start: el.selectionStart, end: el.selectionEnd };
    const snapped = snapSelection(parseChips(el.value), next, prev);
    if (snapped.start !== next.start || snapped.end !== next.end) {
      el.setSelectionRange(snapped.start, snapped.end, el.selectionDirection);
    }
    lastSelectionRef.current = snapped;
  };
  /** 点胶囊的 ×：删整颗（连带一个空格，chipRemovalRange）。走 execCommand 保撤销栈；被拒退 setRangeText */
  const removeChip = (el: HTMLTextAreaElement, start: number): void => {
    const chip = parseChips(el.value).find((each) => each.start === start);
    if (chip === undefined) return;
    const range = chipRemovalRange(el.value, chip);
    el.focus({ preventScroll: true });
    el.setSelectionRange(range.start, range.end);
    if (!document.execCommand("delete")) el.setRangeText("", range.start, range.end, "end");
    lastSelectionRef.current = { start: range.start, end: range.start };
    setCloseHover(null);
  };
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
  // 画成胶囊的区间：skill / mcp 的 token（带 kind，按类别上色）+ 收着的粘贴
  // token（不带 kind，中性配方）——同一副药方，两种墨
  const chipSpans = useMemo(
    () => [
      ...chips.map((chip) => ({ start: chip.start, end: chip.end, kind: chip.kind })),
      ...paintedPasteTokens.map((token) => ({ start: token.start, end: token.end })),
    ],
    [chips, paintedPasteTokens],
  );
  const segments = useMemo(
    () =>
      mirrorSegments(
        whiteout ? whiteoutSegments(props.value, composition ?? undefined) : [{ text: props.value, whiteout: false }],
        chipSpans,
        pasteRuns,
      ),
    [whiteout, props.value, composition, chipSpans, pasteRuns],
  );
  // 每段在原文里的起点：chip 段靠它对上 chipAt（名字、× 归哪颗）
  const segmentsWithOffsets = useMemo(() => {
    let offset = 0;
    return segments.map((segment) => {
      const at = offset;
      offset += segment.text.length;
      return { segment, offset: at };
    });
  }, [segments]);
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
    const mirror = mirrorRef.current;
    if (mirror === null) return;
    syncMirror(el, mirror);
    // 比一行还长的 token 会被折成两行：胶囊盖不住两截，退回「原文 + 淡底」的写法
    // （data-wrapped，styles.css）。只量有类别的 chip，一般就几颗
    for (const chip of mirror.querySelectorAll<HTMLElement>(".composer-chip[data-kind]")) {
      chip.toggleAttribute("data-wrapped", chip.getClientRects().length > 1);
    }
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
  // ── 光标位置（「/ + 空格」开右栏选取的触发条件在 panel-token.ts）──────
  // 纯移动不经过 onChange，所以还要 onSelect 跟；value 被外部改写（草稿恢复、
  // token 插入）后从 DOM 回同步一次
  const [cursor, setCursor] = useState(0);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el !== null) setCursor(el.selectionStart);
  }, [props.value]);

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
  const submit = (): void => props.onSubmit();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragging = props.dropActive === true;
  return (
    // 材料叠放（B 定稿）：四路附件全部移出输入卡，叠在卡片上方——截图一行、胶囊一行、
    // 引用一张卡，都坐在聊天面上；输入卡只剩输入本身（叠放层在 composer-materials.tsx）。
    // composer-stack 同时是引用卡两列版式的 container query 容器（窄窗 / 抽屉里回落一列）
    <div className="composer-stack" style={{ width: "100%", minWidth: 0, display: "grid", gap: "var(--space-2)" }}>
      <MaterialStack materials={materials} imageUnsupported={props.imageUnsupported} jumpToQuote={props.jumpToQuote} />
      <div
        className="glass-card composer-card"
        style={{
          width: "100%",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px 8px",
          position: "relative",
          // 文件 / 图片拖在聊天面板上方时的落点提示（dropActive）：中性虚线，
          // 不染 accent（accent 只给主操作）
          outline: dragging ? "1.5px dashed var(--color-border-strong)" : undefined,
          outlineOffset: -5,
        }}
      >
      <div className={`composer-field${pasteRuns.length > 0 ? " has-paste-run" : ""}`}>
        {/*
          镜像层（全主题常驻）：与 textarea 同字体、同字距、同宽。**字由它画**（2026-10-30 起）：
          textarea 的字透明，只管光标、选区、输入法与撤销。句中 token 在这里包成 .composer-chip：
          原文透明占位，上面盖一颗胶囊（ChipFace）——两层共用同一套排版，光标与字才逐像素对齐；
          修正液（copybook）、粘贴展开段的底色也画在这一层。
          末尾补一个零宽字符：textarea 末尾的换行会多出一行，div 里不会，滚动范围就对不上
        */}
        <div ref={mirrorRef} className="composer-input composer-mirror" data-script={script} aria-hidden="true">
          {segmentsWithOffsets.map(({ segment, offset }, index) => {
            const chip = segment.chipKind !== undefined ? chipAt.get(offset) : undefined;
            return segment.chip ? (
              <span
                key={index}
                className="composer-chip"
                data-kind={segment.chipKind ?? undefined}
                data-close-hover={chip !== undefined && closeHover === offset ? "" : undefined}
              >
                {segment.text}
                {chip !== undefined && (
                  <ChipFace kind={chip.kind} name={chip.kind === "plugin" ? pluginChipName(pluginNames, chip.target) : chip.target} start={chip.start} />
                )}
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
            );
          })}
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
          // 拼写检查的红波浪线画在 textarea 的原文上：token 不是词（`mcp`、`git` 都会被划），
          // 而且划在胶囊底边上。textarea 没法按区间关拼写，只好草稿里有 skill / MCP 胶囊时整个关掉，
          // 胶囊删光了再打开（没有胶囊时与以前一样）
          spellCheck={chips.length === 0}
          placeholder={props.placeholder}
          onChange={(event) => {
            // 上一次听写的问题说过了：用户动手打字就收起来
            if (dictation.problem !== null) dictation.clearProblem();
            setCursor(event.target.selectionStart);
            props.onChange(event.target.value);
          }}
          onSelect={(event) => {
            // 胶囊中间没有可见的位置：键盘移动落进去就按方向跨过去。组词中不动（输入法的光标
            // 归它管）；按着鼠标时不动（拖选中，松手再吸）——这两种只记下选区
            const el = event.currentTarget;
            if (composition === null && !pointerDownRef.current) snapToChips(el, lastSelectionRef.current);
            else lastSelectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
            setCursor(el.selectionStart);
          }}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            const el = event.currentTarget;
            // 点在胶囊的 × 上：不动光标、不开始拖选，直接删整颗
            const close = chipCloseAt(mirrorRef.current, event.clientX, event.clientY);
            if (close !== null && !disabled && !dictating) {
              event.preventDefault();
              removeChip(el, close);
              return;
            }
            pointerDownRef.current = true;
            // 按下的那一下光标可能落在胶囊中间：下一帧就挂到最近的一边，不等松手（继续拖的话
            // 浏览器仍从自己的锚点扩选，松手时再整颗吸）
            requestAnimationFrame(() => {
              if (el.selectionStart === el.selectionEnd) snapToChips(el, null);
            });
            window.addEventListener(
              "mouseup",
              () => {
                pointerDownRef.current = false;
                if (document.activeElement === el) snapToChips(el, null);
              },
              { once: true },
            );
          }}
          onMouseMove={(event) => {
            const close = chipCloseAt(mirrorRef.current, event.clientX, event.clientY);
            if (close !== closeHover) setCloseHover(close);
          }}
          onMouseLeave={() => {
            if (closeHover !== null) setCloseHover(null);
          }}
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
            // 「/ + 空格」打开右栏 Skills 面板选取（panel-token.ts）：行首或空白后
            // 孤立的 /（句中同样触发，2026-10-11 用户裁定；a/ 、/tmp/ 这类由
            // slashTokenAt 的闸门拦下）。删 / 走 execCommand("delete") 保撤销栈；
            // 被拒退回 onChange 直写。组词中不触发
            if (
              event.key === " " &&
              !event.nativeEvent.isComposing &&
              composition === null &&
              props.onSlashSpace !== undefined
            ) {
              const position = slashSpaceOpensPanel(props.value, cursor);
              if (position !== null && props.onSlashSpace(position)) {
                event.preventDefault();
                const el = textareaRef.current;
                if (el !== null) {
                  el.setSelectionRange(position, position + 1);
                  if (document.execCommand("delete")) {
                    // execCommand 后光标就落在删除点；只同步 cursor state，不回抢
                    // 焦点（下一拍右栏搜索框要接管焦点）
                    setCursor(position);
                    return;
                  }
                }
                props.onChange(props.value.slice(0, position) + props.value.slice(position + 1));
                // 退回路径不回抢焦点（下一拍右栏搜索框要接管）；光标只落在删除点
                setCursor(position);
                requestAnimationFrame(() => {
                  textareaRef.current?.setSelectionRange(position, position);
                });
                return;
              }
            }
            // ← → 一步跨过整颗胶囊（不让原生先挨一格地移进去再吸出来，光标会在胶囊里闪一下）。
            // 只管不带修饰键、没有选区的情形；Shift / 按词跳 / ↑↓ 交给原生，onSelect 再吸
            if (
              (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
              !event.nativeEvent.isComposing &&
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey
            ) {
              const el = event.currentTarget;
              const caret = el.selectionStart;
              if (caret === el.selectionEnd) {
                const hop =
                  event.key === "ArrowLeft"
                    ? chipRangeBefore(el.value, caret)?.start
                    : chipRangeAfter(el.value, caret)?.end;
                if (hop !== undefined) {
                  event.preventDefault();
                  el.setSelectionRange(hop, hop);
                  lastSelectionRef.current = { start: hop, end: hop };
                  setCursor(hop);
                  return;
                }
              }
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
            // 组词中的 Enter 是「确认候选词」，不是发送——规则与用例在 composer-keys.ts
            if (!isSubmitKey({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            })) return;
            event.preventDefault();
            if (sendable) submit();
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
            // 字的颜色不在这里：textarea 的字透明、由镜像层画（styles.css 的 .composer-field > textarea）
            cursor: closeHover !== null ? "pointer" : undefined,
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
          onClick={() => (sendable ? submit() : props.onStop())}
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
          {/* 停止方块只在真能停的时候画：空输入框上的禁用键画「停止」，读起来像「可以停」，
              点了却没反应（2026-10-29 精装审计）。禁用态仍是发送，只是压暗 */}
          <Icon name={stopping ? "square" : "arrow-up"} size={stopping ? 12 : 16} />
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
  // 窗口改尺寸换行会变，重 量一次
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

