import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { ImageLightbox } from "./ImageLightbox";
import { PaperclipMark } from "./PaperclipMark";
import { QuoteChip } from "./QuoteChip";
import { FileRefChip, PastedTextChip } from "./attachment-chips";
import type { TextQuote } from "@shared/quote";
import { isPastedTextLarge } from "@shared/prompt-attachments";
import { filesOf, imageSrc, type ComposerImage } from "./composer-images.ts";
import type { ComposerFileRef, ComposerPastedText } from "./composer-attachments.ts";
import { composerBoxHeight, COMPOSER_MIN_ROWS } from "./composer-height.ts";
import { isSubmitKey } from "./composer-keys.ts";
import { composerScript } from "./composer-script.ts";
import { api } from "../api";
import { filterSkills } from "../features/skills/skill-filter";
import type { SkillMeta } from "@shared/skill";
import { whiteoutSegments, type CompositionRange } from "./whiteout-segments.ts";
import type { DominantScript } from "../features/chat/dominant-script.ts";
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
  /** 输入框里待发的文件引用与粘贴文本块（同一把会话草稿键隔离） */
  files: readonly ComposerFileRef[];
  pasted: readonly ComposerPastedText[];
  onRemoveFile: (id: string) => void;
  onRemovePasted: (id: string) => void;
  /** 粘贴的一大段文字超过折叠阈值（shared 的 isPastedTextLarge），输入框拦下交给调用方成块 */
  onPasteLargeText: (text: string) => void;
  /** 当前模型看不了图：有附图时在缩略图下说一句（pi 会把图换成占位文字，不报错） */
  imageUnsupported?: boolean;
  /** 指令面板的动作项（/compact /new）：选中即执行，会话动作由调用方接（发送流不经这里） */
  onCommand?: (command: "compact" | "new") => void;
}) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // 输入法组词中的范围（没在组词是 null）。拼音字母会先进 value：字距判法在组词期间沿用
  // 上一次的结果，修正液不涂这一截
  const [composition, setComposition] = useState<CompositionRange | null>(null);
  // 以中文还是英文为主（composer-script.ts）：小学作业主题按它切字距。要记住上一次的结果——
  // 渲染中按新输入调整 state，React 会在提交前重渲一遍
  const [script, setScript] = useState<DominantScript>("cjk");
  const nextScript = composerScript(script, props.value, composition !== null);
  if (nextScript !== script) setScript(nextScript);
  // 修正液：小学作业主题下，textarea 下面垫一层同样排版的镜像，只给英文段画白底
  // （whiteout-segments.ts）。别的主题不渲染镜像，每次按键不白白分段
  const [whiteout, setWhiteout] = useState(isCopybook);
  const segments = useMemo(
    () => (whiteout ? whiteoutSegments(props.value, composition ?? undefined) : []),
    [whiteout, props.value, composition],
  );
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
  // 首字符是 / 且单行时亮；Esc 关掉后改动内容才重新亮。skill 列表首次展开拉一次
  // （skills 不参与聊天路径，不值得常驻；api.skill.list 与 Skills 面同一份 IPC）。
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [skillMetas, setSkillMetas] = useState<SkillMeta[] | null>(null);
  const panelOpen =
    props.value.startsWith("/") && !props.value.includes("\n") && !commandsDismissed;
  const commandQuery = panelOpen ? props.value.slice(1).trim().toLowerCase() : "";
  useEffect(() => {
    if (panelOpen && skillMetas === null) {
      void api.skill.list().then(setSkillMetas).catch(() => setSkillMetas([]));
    }
  }, [panelOpen, skillMetas]);
  useEffect(() => {
    if (!props.value.startsWith("/")) setCommandsDismissed(false);
  }, [props.value]);
  useEffect(() => setActiveCommand(0), [commandQuery]);
  type CommandRow =
    | { kind: "compact" | "new"; name: string; description: string }
    | { kind: "skill"; slug: string; name: string; description: string };
  const commandRows: CommandRow[] = useMemo(() => {
    if (!panelOpen) return [];
    const builtins: CommandRow[] = [
      { kind: "compact", name: "compact", description: t.composer.cmdCompact },
      { kind: "new", name: "new", description: t.composer.cmdNew },
    ];
    const matchSkill = (meta: SkillMeta): CommandRow => ({
      kind: "skill",
      slug: meta.slug,
      name: meta.name,
      description: meta.description,
    });
    if (commandQuery === "") {
      return [...builtins, ...(skillMetas ?? []).filter((meta) => !meta.missing).map(matchSkill)];
    }
    return [
      ...builtins.filter((row) => row.name.startsWith(commandQuery)),
      ...filterSkills(skillMetas ?? [], commandQuery)
        .filter((meta) => !meta.missing)
        .map(matchSkill),
    ];
  }, [panelOpen, commandQuery, skillMetas, t]);

  /** 面板选中：skill 插进输入框（可再补附加指示）；动作项交给调用方立即执行 */
  const runCommand = (row: CommandRow): void => {
    setCommandsDismissed(true);
    if (row.kind === "skill") {
      props.onChange(`/skill:${row.slug} `);
    } else if (props.onCommand !== undefined) {
      props.onCommand(row.kind);
    } else {
      props.onChange(`/${row.name}`);
    }
    textareaRef.current?.focus();
  };

  const disabled = props.disabled === true;
  const running = props.running === true;
  // 有字就能发——跑着的时候 Enter 是排队发送（C-1）。没字 + 跑着 = 停止键：
  // 同一个位置的两面，按输入态切换。想停止时清掉草稿即可，排队是高频动作、停止是少数。
  // 有图 / 有附件 / 有引用没字也能发——一张截图本身就是一句完整的话
  const sendable =
    !disabled &&
    (props.value.trim() !== "" ||
      props.attachments.length > 0 ||
      props.quotes.length > 0 ||
      props.files.length > 0 ||
      props.pasted.length > 0);
  const stopping = running && !sendable;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragging = props.dropActive === true;
  return (
    <div
      className="glass-card"
      style={{
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 8px",
        // 拖进来时的落点提示：中性虚线，不染 accent（accent 只给主操作）
        outline: dragging ? "1.5px dashed var(--color-border-strong)" : undefined,
        outlineOffset: -5,
      }}
    >
      {/* 截图叠在引用上面：图是一眼能认出来的，放在最上面当锚点；引用是一段段文字，贴着输入框 */}
      {props.attachments.length > 0 && (
        <AttachmentStrip
          items={props.attachments}
          onRemove={props.onRemoveAttachment}
          removeLabel={t.composer.removeImage}
          openLabel={t.lightbox.open}
        />
      )}
      {(props.files.length > 0 || props.pasted.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", minWidth: 0 }}>
          {props.files.map((file) => (
            <FileRefChip
              key={file.id}
              name={file.name}
              path={file.path}
              kind={file.kind}
              onRemove={() => props.onRemoveFile(file.id)}
            />
          ))}
          {props.pasted.map((block) => (
            <PastedTextChip
              key={block.id}
              text={block.text}
              lines={block.lines}
              onRemove={() => props.onRemovePasted(block.id)}
            />
          ))}
        </div>
      )}
      {props.attachments.length > 0 && props.imageUnsupported === true && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            fontSize: "var(--font-size-caption)",
            color: "var(--color-text-secondary)",
          }}
        >
          <Icon name="triangle-alert" size={12} strokeWidth={1.8} style={{ color: "var(--color-warning)", flex: "0 0 auto" }} />
          <span>{t.composer.noVision}</span>
        </div>
      )}
      {props.quotes.length > 0 && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {props.quotes.map((quote, index) => (
            <QuoteChip
              key={`${quote.messageId}:${index}`}
              index={index + 1}
              quote={quote}
              expanded
              onJump={props.jumpToQuote(quote)}
              onRemove={() => props.onRemoveQuote(index)}
            />
          ))}
        </div>
      )}
      {panelOpen && (
        <div
          role="listbox"
          style={{
            display: "grid",
            gap: 2,
            maxHeight: 240,
            overflowY: "auto",
            padding: 6,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border-subtle)",
            background: "var(--color-bg-muted)",
          }}
        >
          {commandRows.length === 0 ? (
            <div
              style={{
                padding: "6px 8px",
                fontSize: "var(--font-size-caption)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {t.composer.commandNoMatch}
            </div>
          ) : (
            commandRows.map((row, index) => (
              <button
                key={row.kind === "skill" ? `skill:${row.slug}` : row.kind}
                type="button"
                role="option"
                aria-selected={index === activeCommand}
                onClick={() => runCommand(row)}
                onMouseEnter={() => setActiveCommand(index)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "6px 8px",
                  borderRadius: "var(--radius-md)",
                  border: 0,
                  background: index === activeCommand ? "var(--color-bg-active)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  minWidth: 0,
                }}
              >
                <Icon
                  name={
                    row.kind === "skill"
                      ? "book-open"
                      : row.kind === "compact"
                        ? "fold-vertical"
                        : "message-square-dashed"
                  }
                  size={13}
                  strokeWidth={1.8}
                  style={{ color: "var(--color-text-secondary)", flex: "0 0 auto" }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-family-mono)",
                    fontSize: "var(--font-size-caption)",
                    color: "var(--color-text-primary)",
                    flex: "0 0 auto",
                  }}
                >
                  {row.kind === "skill" ? `/skill:${row.slug}` : `/${row.name}`}
                </span>
                <span
                  style={{
                    fontSize: "var(--font-size-caption)",
                    color: "var(--color-text-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.description}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <div className="composer-field">
        {whiteout && (
          // 镜像：与 textarea 同字体、同字距、同宽，字是透明的，只有英文段的白底看得见。
          // 末尾补一个零宽字符：textarea 末尾的换行会多出一行，div 里不会，滚动范围就对不上
          <div ref={mirrorRef} className="composer-input composer-mirror" data-script={script} aria-hidden="true">
            {segments.map((segment, index) =>
              segment.whiteout ? (
                <span key={index} className="composer-whiteout">
                  {segment.text}
                </span>
              ) : (
                segment.text
              ),
            )}
            {"\u200b"}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          data-script={script}
          rows={COMPOSER_MIN_ROWS}
          value={props.value}
          disabled={disabled}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
          onPaste={(event) => {
            // 剪贴板里有文件（截图、从别处复制的文件）才拦；分拣与报错在调用方。
            // 浏览器复制文件常常同时带一份 HTML/URL 文本——有文件时以文件为准，文本不贴
            const files = filesOf(event.clipboardData);
            if (files.length > 0) {
              event.preventDefault();
              props.onAttach(files);
              return;
            }
            // 纯文字粘贴：超过折叠阈值的一大段抽成粘贴块（全文进模型，永不截断），
            // 普通文字照常进输入框
            const text = event.clipboardData.getData("text/plain");
            if (text !== "" && isPastedTextLarge(text)) {
              event.preventDefault();
              props.onPasteLargeText(text);
            }
          }}
          onKeyDown={(event) => {
            // 面板开着时方向键与 Enter 归面板（Enter 选中即执行，不落进发送）；
            // Esc 关面板，内容照在。组词中的按键不动面板。
            if (panelOpen && !event.nativeEvent.isComposing) {
              if (event.key === "ArrowDown" && commandRows.length > 0) {
                event.preventDefault();
                setActiveCommand((index) => (index + 1) % commandRows.length);
                return;
              }
              if (event.key === "ArrowUp" && commandRows.length > 0) {
                event.preventDefault();
                setActiveCommand((index) => (index - 1 + commandRows.length) % commandRows.length);
                return;
              }
              if (event.key === "Enter" && commandRows.length > 0) {
                event.preventDefault();
                const row = commandRows[Math.min(activeCommand, commandRows.length - 1)];
                if (row !== undefined) runCommand(row);
                return;
              }
              if (event.key === "Escape") {
                setCommandsDismissed(true);
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
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/*
          芯片群包一层：flex:1 1 auto + min-width:0 让它先于发送键让路，
          overflow:hidden 兜底——窄到连图标态都装不下时裁掉多出来的，而不是把
          发送键挤出可见区（`.composer-bottom-bar` 的容器查询规则见 styles.css）。
        */}
        <IconButton
          label={t.composer.attachFiles}
          size={28}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          style={{ flex: "0 0 auto" }}
        >
          <Icon name="paperclip" size={15} strokeWidth={1.8} />
        </IconButton>
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
        <button
          type="button"
          className="btn-accent"
          data-tone={stopping ? "danger" : undefined}
          aria-label={sendable ? t.composer.send : stopping ? t.composer.stop : t.composer.send}
          title={sendable ? t.composer.send : stopping ? t.composer.stopTurn : t.composer.send}
          disabled={!sendable && !stopping}
          onClick={() => (sendable ? props.onSubmit() : props.onStop())}
          style={{
            marginInlineStart: "auto",
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
  );
}

/**
 * 待发附图的缩略图条。方形裁切（object-fit: cover）只为排得齐——原图完整地
 * 发出去，点缩略图看大图。移除键常显而不是悬停才出：键盘用户要能 Tab 到它。
 * 缩略图与移除键是兄弟不是嵌套：button 里不能再套 button。
 */
function AttachmentStrip(props: {
  items: readonly ComposerImage[];
  onRemove: (id: string) => void;
  removeLabel: string;
  openLabel: string;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
      {viewing !== null && (
        <ImageLightbox
          images={props.items.map((item) => item.image)}
          startIndex={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {props.items.map((item, index) => (
        <div
          key={item.id}
          title={item.name === "" ? undefined : item.name}
          style={{
            // 外层不裁切：回形针要半露在缩略图外面；裁切放在里面的按钮上
            position: "relative",
            width: 56,
            height: 56,
            flex: "0 0 auto",
          }}
        >
          <PaperclipMark size={18} />
          <button
            type="button"
            aria-label={props.openLabel}
            onClick={() => setViewing(index)}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              padding: 0,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border-subtle)",
              overflow: "hidden",
              background: "var(--color-bg-muted)",
              cursor: "zoom-in",
            }}
          >
            <img
              src={imageSrc(item.image)}
              alt={item.name}
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </button>
          <button
            type="button"
            aria-label={props.removeLabel}
            title={props.removeLabel}
            onClick={() => props.onRemove(item.id)}
            style={{
              position: "absolute",
              top: 3,
              right: 3,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              padding: 0,
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-bg-panel)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
