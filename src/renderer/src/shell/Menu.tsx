import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { placeMenu, type MenuBox, type MenuPlacementSide } from "./menu-position";
import { useT } from "../locale.ts";

export interface MenuItem {
  id: string;
  label: string;
  /**
   * 行的第二行（小一号、tertiary）。只有模型卡片用它：主行是模型名、副行是它属于哪家——
   * 左栏按厂商过滤之后组头那一行就没了，厂商名得有地方待（2026-10-01 定）。
   * 路径卡片也用它：主行是工作区名、副行是全路径（`subLabelMono` + `subLabelEllipsis: "head"`）。
   */
  subLabel?: string;
  /** 副行的截断方向。默认 `tail`；路径这类「尾段才是名字」的用 `head`（与 hintEllipsis 同一口径） */
  subLabelEllipsis?: "tail" | "head";
  /** 副行是机器事实（路径）：mono 字体（设计系统：mono for machine facts） */
  subLabelMono?: boolean;
  /** 副行的尾巴：跟在副行后面、用正文字体的注脚（模型卡片「全部 / 星标」里的服务商名，副行本体是等宽的型号 id） */
  subLabelTrail?: string;
  /**
   * 搜索时**额外**匹配的文字。模型卡片的主行是显示名（「Kimi K3.1 Pro」），用户照样会按
   * id（k3.1-pro）或服务商名搜——只匹配 label 的话，换成显示名那天这两种搜法就静默失效了。
   */
  searchText?: string;
  icon?: IconName;
  /**
   * 行首的头像（模型卡片：型号头像，见 ModelAvatar）。给了它，行首这一格就是头像而不是对勾：
   * 选中改由头像一圈 accent 描边表示（styles.css 的 .model-avatar），底色与半粗照旧。
   */
  avatar?: React.ReactNode;
  /** 右侧的说明。菜单项自己解释后果，比事后弹一个确认框好 */
  hint?: string;
  /**
   * hint 被挤到装不下时从哪一头省略。默认 `tail`（尾部省略号）适合词；
   * **路径这类「尾段才是名字」的东西要 `head`**：`/Users/dama/Desktop/orbita`
   * 截成 `/Users/dama/Deskto…` 等于把唯一有信息量的那段切掉了。
   */
  hintEllipsis?: "tail" | "head";
  /** 最右端的徽标区（如模型项的 ctx 窗口与图片能力）。小而事实性的东西，不参与布局语义 */
  badge?: React.ReactNode;
  /**
   * 行右端的**独立控件**（今天的消费者只有星标）。它与「选这一行」不是一件事：
   * 点行 = 选中这个模型、卡片收起；点它 = 只切标记，不选任何东西、卡片也不关。
   * 所以它必须是行按钮的**兄弟**（见 MenuRow 的渲染）。
   */
  trailing?: React.ReactNode;
  /** 当前项。用 check 图标标出来，不用染色——状态优先图标与文字 */
  checked?: boolean;
  disabled?: boolean;
  /**
   * **这一行是事实，不是动作**（用量分项那几行）。不可选中、不抢键盘焦点，
   * 光标也不变成禁止符——`disabled` 说的是「你现在不能做这件事」，
   * 而这些行从来不是一件事。数字用 mono 字体（设计系统：mono for machine facts）。
   */
  fact?: boolean;
  /** 分组头：菜单里一节的小标题（如模型菜单的厂商名）。不可选、不抢焦点，样式同设置面的节标题 */
  header?: boolean;
  /** 破坏性动作：danger 色。**只给真的会丢东西的那一项** */
  danger?: boolean;
  /**
   * 选中之后菜单不关。给两段式确认用——「删除…」先把菜单换成一组确认项，
   * 第二下才真删。设计系统要求「先讲后果再动作」，而本分支还没有 Modal。
   */
  keepOpen?: boolean;
  onSelect?: () => void;
}

/**
 * 搜索过滤（searchable 菜单用）：命中行保留；组头跟着走——组内有命中就带组头，
 * 组头名自己命中（按厂商搜）就整组保留。q 为空原样返回。
 */
function filterMenuItems(items: MenuItem[], q: string): MenuItem[] {
  if (q === "") return items;
  const hit = (label: string) => label.toLowerCase().includes(q);
  const out: MenuItem[] = [];
  let header: MenuItem | null = null;
  let all: MenuItem[] = [];
  let matched: MenuItem[] = [];
  const flush = () => {
    if (header !== null) {
      if (hit(header.label)) out.push(header, ...all);
      else if (matched.length > 0) out.push(header, ...matched);
    } else {
      out.push(...matched);
    }
    header = null;
    all = [];
    matched = [];
  };
  for (const item of items) {
    if (item.header === true) {
      flush();
      header = item;
    } else {
      all.push(item);
      if (hit(item.label) || (item.searchText !== undefined && hit(item.searchText))) matched.push(item);
    }
  }
  flush();
  return out;
}

/** 悬停打开的菜单：光标离开后多久关。够穿过那道缝，又不至于像粘住了 */
const HOVER_GRACE_MS = 160;

/**
 * 下拉（必要时上拉）菜单。**本分支唯一的弹层原语**。
 *
 * 三个决定：
 *
 * 1. **默认向下，下方装不下才翻上去。** 先按向下渲染但不可见，量到真实高度之后再定位——
 *    菜单高度取决于内容，不先量就只能猜。
 * 2. **portal 到 body + `position: fixed`。** 边界卡、内容面、侧栏都是 `overflow: hidden`，
 *    在原地渲染的菜单会被裁掉；fixed 定位还能免掉逐层累加滚动偏移。
 * 3. **layer 3 玻璃**：与输入卡同一层——它浮在内容之上，理应比内容更实。
 *    阴影用 `--shadow-popover`（设计系统 *Shadows*：menus, card hover）。
 */
export function Menu(props: {
  items: MenuItem[];
  /** 触发器自己画。拿到 open 是为了画出「正被打开」的状态 */
  trigger: (state: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** 菜单与触发器哪一边对齐。默认左对齐；靠右的触发器（如三个点）用 end */
  align?: "start" | "end";
  /**
   * 悬停即开、移开即关——给「看一眼事实」的菜单用（底栏的用量环）。
   * 点击仍然能开：键盘与触屏没有悬停。**悬停打开的菜单不抢焦点**——
   * 光标只是路过输入框上方，正在打的字不该因此断掉；点开的才把焦点交给菜单。
   */
  hoverOpen?: boolean;
  /** 顶部渲染搜索框，按键实时过滤（模型菜单这类长清单）。打开即聚焦，关闭即清空 */
  searchable?: boolean;
  /** 开合的回声。给调用方复位自己的两段式状态用（菜单关了，确认态不该留着） */
  onOpenChange?: (open: boolean) => void;
  /**
   * 面板最小宽度（px）。全局默认 180 是给带描述/徽标的菜单定的；短词菜单
   * （思考档的 Low/High/Max）被它撑出一大截空白，显得轻浮。给**窄值**时面板
   * 收窄到内容，maxWidth 320 仍兜底。
   */
  panelMinWidth?: number;
  /**
   * 面板最大宽度（px）。默认 320 是给模型名、工作区路径这类长文本留的；
   * 侧栏会话行那种**动作清单**给窄值收住——它的每一项都是两三个词，
   * 撑到 320 只是在会话列表旁边糊一大块玻璃（2026-09-22 wafo：「卡片太大」）。
   */
  panelMaxWidth?: number;
  /**
   * 面板最大高度（px）。**这是卡片自己的上限，不是视口那一道**：视口能装多少由
   * `placeMenu` 算并封顶，这里管的是「内容再长也不超过这个高」——输入卡的两张卡片
   * 都取 520（2026-10-01 定）。两者取小，所以窗口矮时卡片照样跟着降。
   */
  panelMaxHeight?: number;
  /**
   * 菜单开在锚点的哪一边。默认下方；`right` 给侧栏会话行——
   * 开在下方会盖住紧挨着的下一条会话，想看别的会话就得先关菜单。
   * `above` 给输入卡底栏的芯片：首页输入卡悬在窗口中间，下方再空也朝上开，
   * 与钉底的聊天页同一朝向（规则见 menu-position.ts）。
   */
  placement?: MenuPlacementSide;
  /**
   * 左栏（弹层内容的**第一等结构**，不是装饰）：与行清单并排、自己不滚，
   * 清单在它右边滚。今天只有模型卡片用它——星标 / 全部 / 各厂商的过滤列。
   * 里面是什么由调用方给（本原语不管），但**键盘左右切栏**由这里实现：
   * 焦点在左栏时 `↑↓` 在格间走、`→` 交给清单；焦点在清单时 `←` 回左栏。
   */
  rail?: React.ReactNode;
  /**
   * 行清单的**定高**（显示几行的量）：给了它就是定高卡片。
   *
   * 为什么要有这一档：卡片的高度若跟着**内容**走，点一次左栏过滤就换一个尺寸——
   * 位置跟着跳，而且「刚才那个模型在哪」的肌肉记忆每次都被清掉（2026-10-01 用户实测）。
   * 定高之后，卡片大小只跟窗口有关，与筛剩几条无关。
   * 行高取 CSS 变量 `--menu-row-height`，不在这里写死一个数。
   */
  listRows?: number;
  /**
   * 宽度尺：**不过滤**的完整行清单。它们会被画成真实的行，但不可见、不占高——
   * 面板宽度因此由「全部配置好的模型」决定，与当前筛剩几条无关。
   *
   * 为什么不是「一串名字」：行宽 ≠ 名字宽，行还有图标槽、徽标、星（固定零件约 116px）。
   * 只摆名字的尺子在筛到短名字时会被**行本身**超过——实测尺子 183px、一行 226px，
   * 宽度照样跟着过滤变（2026-10-01 第二次返工）。所以尺子必须是整行，而且得是同一套
   * `MenuRow` 画出来的——手写一份「像行的东西」迟早会跟真行脱节。
   */
  widthItems?: readonly MenuItem[];
  /**
   * 搜索词的回声。搜索是**一切过滤的旁路**：调用方拿它把左栏的选中复位到「全部」，
   * 否则会出现「左栏亮着某家、列表里全是别家」这种自相矛盾的画面。
   */
  onSearch?: (query: string) => void;
  /**
   * 清单为空时写什么。**空不等于「搜不到」**：星标一格都没星过时列表也是空的，
   * 而那与搜索无关。所以那句话得由调用方给——它才知道现在是什么过滤状态。
   * 不给就退回「没有匹配的模型。」（只对搜索成立的说法）。
   */
  emptyText?: (query: string) => string;
  /**
   * 钉在面板底部的固定行（不跟着清单滚），拿到 `close` 自己决定关不关卡片。
   * 模型卡片的「配置模型」就住在这里：它是「我要的东西不在这里」的出口，
   * 最需要随时可达——放进滚动清单里就会被一屏外的东西带走。
   */
  footer?: (close: () => void) => React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /**
   * `cap` = 面板实际能占的高度（视口余量与卡片上限取小）。
   * `fixed` = 这是定高卡片：`cap` 写进 `height`（内容少也不缩）；否则写进 `maxHeight`
   * （内容少就矮，封顶只管内容多的时候）。
   */
  const [position, setPosition] = useState<{ top: number; left: number; cap: number; fixed: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 行清单（不含搜索框）——既是滚动容器，也是量自然高度的那个元素 */
  const listRef = useRef<HTMLDivElement>(null);
  /** 左栏容器：只为键盘切栏用 */
  const railRef = useRef<HTMLDivElement>(null);
  /** 装 [左栏 | 清单] 的那一行：量自然高度要用它，不能只用清单 */
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 这次是点开的还是悬停开的——决定要不要把焦点交给菜单 */
  const byClickRef = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    setQuery("");
  }, []);

  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  /** 从触发器挪到菜单要穿过那 6px 的缝，留一拍再关，免得半路就没了 */
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      if (!byClickRef.current) close();
    }, HOVER_GRACE_MS);
  };
  useEffect(() => cancelLeave, []);
  const { onOpenChange } = props;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  /**
   * 重定位：跟随锚点当前位置。**滚动不再关门**——模型回答时消息区一直在自动
   * 滚动，「滚动即关」等于「回答期间用量菜单永远开不住」（一闪一闪、点不开，
   * 2026-09-06 用户实测）。而输入卡钉在窗口底部，自动滚动根本不动锚点——
   * 位置没变就不 setState，流式期间的滚动风暴一次重渲染都不产生。
   */
  const positionMenu = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = menuRef.current;
    if (anchor === undefined || panel === null) return;
    const panelBox = panel.getBoundingClientRect();
    /**
     * 高度两种口径，分开算：
     *
     * - **定高卡片**（`listRows`）：外壳 + N 行。行高**量一行**而不写死数字——
     *   行高是 CSS 的事，在这边再写一个 48 就是同一件事两处写死。
     * - **按内容**：外壳 + 两栏里高的那一个。封顶生效后面板会被压矮，拿面板高去算
     *   就会越算越小；而内容自己的 scrollHeight 永远是真实内容高。
     *
     * 两种都用「面板高 − 两栏高」求外壳：搜索框、底部行、内边距都不随内容变。
     */
    const body = bodyRef.current;
    const bodyBox = body?.getBoundingClientRect().height ?? 0;
    const chrome = panelBox.height - bodyBox;
    /**
     * 一行多高：读**计算后的 minHeight**，不写 48。
     * 行高是两个地方的事（CSS 定 `--menu-row-height`，卡片定「显几行」），
     * 在 JS 里再写一遍数字，改了 CSS 这边就静默错位。
     *
     * 探针不能取「第一个子元素」：清单的第一个子元素是宽度尺（高 0），不是行。
     * 拿行按钮（空清单时退到空态那一段，它也有行高）。
     */
    const probe =
      listRef.current?.querySelector<HTMLElement>("button") ??
      (listRef.current?.lastElementChild as HTMLElement | null);
    const rowHeight = probe === null || probe === undefined ? 0 : parseFloat(getComputedStyle(probe).minHeight) || 0;
    const fixed = props.listRows !== undefined;
    const naturalHeight =
      body === null
        ? panelBox.height
        : fixed
          ? chrome + (props.listRows ?? 0) * rowHeight
          : chrome + Math.max(listRef.current?.scrollHeight ?? 0, railRef.current?.scrollHeight ?? 0);
    /**
     * 交给定位的必须是**面板真会长成的高度**，不是内容高。
     * 少了这一道 min，卡片会被推到离锚点很远的地方：定位按内容高（758）算「上面装得下」，
     * 而面板被 `panelMaxHeight`（520）卡住只长了 520——中间那 238px 的差就是那段空气
     * （2026-10-01 用户实测：「卡片没有贴住 chip」）。
     */
    const requested = Math.min(naturalHeight, props.panelMaxHeight ?? Number.POSITIVE_INFINITY);
    const box: MenuBox = {
      top: anchor.top,
      bottom: anchor.bottom,
      left: anchor.left,
      right: anchor.right,
      width: anchor.width,
      height: anchor.height,
    };
    const placed = placeMenu(
      box,
      { width: panelBox.width, height: requested },
      props.align,
      { width: window.innerWidth, height: window.innerHeight },
      props.placement,
    );
    if (!placed.visible) {
      close();
      return;
    }
    // 定高卡片的上限就是它自己那份高（六行），`panelMaxHeight` 对它没意义
    const cap = Math.min(placed.maxHeight, fixed ? naturalHeight : requested);
    setPosition((prev) =>
      prev !== null && prev.top === placed.top && prev.left === placed.left && prev.cap === cap && prev.fixed === fixed
        ? prev
        : { top: placed.top, left: placed.left, cap, fixed },
    );
  }, [props.align, props.placement, props.listRows, props.panelMaxHeight, close]);

  // 首次打开：先按旧位置渲染但不可见，量到真实高度之后再定位——菜单高度取决于
  // 内容，不先量就只能猜。这一步必须在浏览器绘制前做完，否则会看到菜单跳一下。
  // 搜索过滤改变行数时同样要重量——deps 里的 visible.length 就是为此
  const visible = filterMenuItems(props.items, query.trim().toLowerCase());
  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    // 点开的才拿焦点（键盘导航）；悬停开的把焦点留在原处。搜索框优先——
    // 打开就想打字，不该再点一下。滚动跟随不在这里走——焦点只在该拿到的那一刻
    // 给一次，跟着滚动反复 focus 会把用户的选区打飞
    if (byClickRef.current) {
      if (props.searchable === true) searchRef.current?.focus();
      else menuRef.current?.focus();
    }
  }, [open, visible.length, positionMenu, props.searchable]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      close();
    };
    // 滚动与改窗口大小：追着重定位而不是关门。锚点跟着界面动了，菜单跟着锚点走；
    // 锚点整个出屏（placeMenu 判 visible=false）才关门——那时跟着走是挂在天上
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, close, positionMenu]);

  /*
   * 面板的宽度在首次量完之后还可能长（宽度尺、字体、滚动条落定），而定位已经按
   * 旧宽度向右夹过——结果卡片贴死视口右缘（2026-10-02 实测：设置面模型卡片量时 366、
   * 落定 374，右缘正好顶到窗口边，副行说明被挤成省略号）。开着时盯尺寸变了就重定位；
   * positionMenu 对相同结果不 setState，不会自激。
   */
  useEffect(() => {
    if (!open) return;
    const panel = menuRef.current;
    if (panel === null) return;
    const observer = new ResizeObserver(() => positionMenu());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, positionMenu]);

  // 键盘导航与渲染都走**过滤后**的清单——搜索时 cursor 与 Enter 只在可见项里打转
  const enabled = visible.filter(
    (item) => item.disabled !== true && item.fact !== true && item.header !== true,
  );
  /** 打开时光标落在**当前项**上。落在第一项会让人以为选中的是第一项。 */
  const cursorAtChecked = () => Math.max(0, enabled.findIndex((item) => item.checked === true));

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    setActive((current) => (current + delta + enabled.length) % enabled.length);
  };

  /**
   * 过滤/搜索之后清单会变短，光标可能落在不再存在的行上——那时 `enabled[active]` 是
   * undefined，右上那一行不会亮，按上下看起来像「没反应」。回到第一行。
   */
  useEffect(() => {
    setActive((current) => (current < enabled.length ? current : 0));
  }, [enabled.length]);

  /**
   * 光标走到哪儿，列表就跟到哪儿。
   *
   * 少了这一步，键盘上下只是把一个看不见的光标在清单里推——超过一屏（模型卡片
   * 是六行）之后就完全不知道自己在哪了（2026-10-01 用户实测：上下带不动滚动条）。
   * `block: "nearest"` 是「已可见就不动」：光标在视野内时按上下，列表不跳。
   *
   * 打开时也跑一次：清单长时卡片直接停在**当前模型**那一行，而不是从头开始。
   */
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
    // visible.length 也在依赖里：过滤/搜索后光标落在另一行上，得重新把它带进视野
  }, [open, active, visible.length]);

  const choose = (item: MenuItem) => {
    if (item.keepOpen !== true) close();
    else setActive(0);
    item.onSelect?.();
  };

  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: "inline-flex", minWidth: 0 }}
        onPointerEnter={
          props.hoverOpen === true
            ? () => {
                cancelLeave();
                if (open) return;
                byClickRef.current = false;
                setActive(cursorAtChecked());
                setOpen(true);
              }
            : undefined
        }
        onPointerLeave={props.hoverOpen === true ? scheduleLeave : undefined}
      >
        {props.trigger({
          open,
          toggle: () => {
            cancelLeave();
            // 悬停开着的菜单被点了一下：不是要关，是要接管——拿焦点、移开光标也不关
            if (open && !byClickRef.current) {
              byClickRef.current = true;
              menuRef.current?.focus();
              return;
            }
            byClickRef.current = true;
            setActive(cursorAtChecked());
            setOpen((value) => !value);
          },
        })}
      </span>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            // menu-panel：Menu 是唯一真正浮在任意内容之上的（position: fixed portal），
            // 实色面板见 styles.css 的注释
            className="glass-card glass-float menu-panel"
            onPointerEnter={props.hoverOpen === true ? cancelLeave : undefined}
            onPointerLeave={props.hoverOpen === true ? scheduleLeave : undefined}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
              /*
               * 键盘只认上下（2026-10-01 用户定）：左右不切栏，卡片里就只有一条轴。
               * 左栏仍然可达——格子是按钮，Tab 能进去，Enter 应用过滤（无键盘陷阱）。
               * 焦点在左栏时上下走格子，不在左栏时上下推清单的光标（两件事不打架）。
               */
              const railEl = railRef.current;
              const inRail = railEl !== null && event.target instanceof Node && railEl.contains(event.target);
              if (inRail && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const buttons = [...railEl.querySelectorAll<HTMLButtonElement>("button")];
                if (buttons.length === 0) return;
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.key === "ArrowDown" ? 1 : -1;
                const next = at < 0 ? 0 : (at + step + buttons.length) % buttons.length;
                buttons[next]?.focus();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              }
              if (event.key === "Enter" || event.key === " ") {
                // 焦点在搜索框时空格是打字，不是选择
                if (event.key === " " && searchRef.current === document.activeElement) return;
                event.preventDefault();
                const item = enabled[active];
                if (item !== undefined) choose(item);
              }
            }}
            style={{
              position: "fixed",
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              // 量高度那一帧不可见，避开在错位置闪一下（首帧也不封顶，才量得到自然高度）
              visibility: position === null ? "hidden" : "visible",
              // 定高卡片给 height（内容少也不缩，卡片大小不跟着筛剩几条变）、
              // 按内容的给 maxHeight（封顶 + 内部滚）。position 为 null 时是在量自然高度，不设
              ...(position === null
                ? null
                : position.fixed
                  ? { height: position.cap }
                  : { maxHeight: position.cap }),
              zIndex: 40,
              minWidth: props.panelMinWidth ?? 180,
              // 上限夹一道视口（面板是 fixed 的，100vw 就是可用宽）——
              // 窄窗下宁可窄、也不让右边半截出屏
              maxWidth: `min(${props.panelMaxWidth ?? 320}px, calc(100vw - 48px))`,
              padding: "var(--space-1)",
              display: "flex",
              flexDirection: "column",
              // 行间不留缝：每行自己已有 minHeight 与 hover 底，1px 的缝只是
              // 把清单又拉高一截（8 项就是 8px），并不帮人分行
              outline: "none",
            }}
          >
            {props.searchable === true && (
              <div style={{ position: "relative", margin: "1px 1px var(--space-1)" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 8,
                    top: "50%",
                    translate: "0 -50%",
                    display: "inline-flex",
                    color: "var(--color-text-tertiary)",
                    pointerEvents: "none",
                  }}
                >
                  <Icon name="search" size={13} />
                </span>
                <input
                  ref={searchRef}
                  value={query}
                  placeholder={t.menu.searchModels}
                  spellCheck={false}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                    props.onSearch?.(e.target.value);
                  }}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    height: "var(--control-height-sm)",
                    padding: "0 10px 0 27px",
                    border: "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--color-bg-panel)",
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-family-base)",
                    fontSize: "var(--font-size-base)",
                    outline: "none",
                  }}
                />
              </div>
            )}
            {/*
              行清单是**唯一滚动的那一层**（搜索框钉在顶部不跟着滚）：封顶生效时
              面板变矮，这里 `overflow-y: auto` 接管，底部的模型因此永远够得到。
              它也是量自然高度的那个元素：scrollHeight 不受封顶影响。
              有左栏时两栏并排：左栏是几个格子，自己也能滚（厂商多的人），但两栏滚的是各自的。
            */}
            <div
              ref={bodyRef}
              style={{ display: "flex", flex: "1 1 auto", minWidth: 0, minHeight: 0, gap: "var(--space-1)" }}
            >
              {props.rail !== undefined && (
                <div
                  ref={railRef}
                  style={{ flex: "none", display: "flex", flexDirection: "column", overflowY: "auto" }}
                >
                  {props.rail}
                </div>
              )}
              <div
                ref={listRef}
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  minHeight: 0,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  /*
                   * 滚动条也占宽：不 reserve 的话，「能滚」与「不能滚」差一个滚动条宽——
                   * 而筛剩几条恰好决定了能不能滚，于是卡片宽度跟着过滤变（真机验收：
                   * 全部 379 → 筛到一家 369，正好 10px）。只给带宽度尺的卡片钉住，
                   * 其余菜单不能被白留一条 10px 的空缝。
                   */
                  ...(props.widthItems === undefined ? null : { scrollbarGutter: "stable" }),
                }}
              >
                {/*
                  宽度尺：不过滤的全部行（同一套 MenuRow 画的），不可见也不占高。
                  它们撑住面板宽度，所以左栏怎么筛都不换尺寸。
                */}
                {props.widthItems !== undefined && (
                  <div aria-hidden style={{ height: 0, overflow: "hidden", visibility: "hidden" }}>
                    {props.widthItems.map((item) => (
                      <MenuRow
                        key={`ruler:${item.id}`}
                        item={item}
                        cursor={false}
                        onHover={() => {}}
                        onSelect={() => {}}
                      />
                    ))}
                  </div>
                )}
              {visible.length === 0 && (
                <div
                  style={{
                    // 空态也占一行：卡片是定高的，空清单时它不能瘪下去
                    minHeight: "var(--menu-row-height)",
                    padding: "var(--space-2)",
                    fontFamily: "var(--font-family-base)",
                    fontSize: "var(--font-size-sm)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {(props.emptyText ?? (() => t.menu.noModels))(query)}
                </div>
              )}
              {visible.map((item) => (
                <MenuRow
                  key={item.id}
                  item={item}
                  cursor={enabled[active]?.id === item.id}
                  onHover={() => {
                    const index = enabled.findIndex((candidate) => candidate.id === item.id);
                    if (index >= 0) setActive(index);
                  }}
                  onSelect={() => choose(item)}
                />
              ))}
              </div>
            </div>
            {props.footer !== undefined && (
              <div
                style={{
                  flex: "none",
                  marginTop: "var(--space-1)",
                  paddingTop: "var(--space-1)",
                  borderTop: "1px solid var(--color-border-subtle)",
                }}
              >
                {props.footer(close)}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 菜单底栏的动作行样式（整行可点、图标 + 词）。底栏容器由 Menu 画，行的形状也归这里管：
 * 模型卡片的「配置模型」与路径卡片的「新建工作区 / 添加文件夹」共用这一份——
 * 两份逐字相同的样式各放一处，迟早漂（2026-10-02 wafo 评审）。
 */
export const menuFooterRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  minHeight: "var(--control-height-lg)",
  padding: "0 var(--space-2)",
  border: 0,
  borderRadius: "var(--radius-sm)",
  color: "var(--color-text-primary)",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-base)",
  textAlign: "left",
  cursor: "pointer",
};

function MenuRow(props: {
  item: MenuItem;
  /** 键盘 / 鼠标的停留位置。与「选中」是两件事——见 styles.css 的 `.option-row` */
  cursor: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { item } = props;
  const fact = item.fact === true;
  const header = item.header === true;
  const disabled = item.disabled === true || fact || header;
  const row = (
    <button
      type="button"
      role={fact || header ? "presentation" : "menuitem"}
      className="option-row"
      // 光标是键盘 / 鼠标共用的高亮位置，不是 :hover——鼠标进入只是把光标移过来
      // （onHover），键盘上下也移它，两者不能叠加成分别的高亮（否则键盘挪走后鼠标
      // 停的那行会跟着一起亮）
      data-cursor={props.cursor}
      aria-selected={item.checked === true || undefined}
      // 定宽卡片里名字可能被截断，title 是那个出口（副行、徽标不进 title：那是注释不是身份）
      title={item.label}
      disabled={disabled}
      onMouseEnter={props.onHover}
      onClick={props.onSelect}
      style={{
        display: "grid",
        // 图标槽 14px：里面的图标就是 13px，16 的槽只是每行白多一道缝。
        // label 和 hint 合用中间这一列（见下面的内层 flex）：hint 太长会把
        // label 挤没，就是这一行的宽度分配方式（2026-09-23 修复）。
        // 有头像的行（模型卡片）首列放 32px 头像，留 2px 给选中的那圈描边
        gridTemplateColumns: item.avatar === undefined ? "14px minmax(0,1fr) auto" : "34px minmax(0,1fr) auto",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        // 两行的行要高出一档（32 + 16 = 48）：副行不是浮着的小字，它是行的下半截
        minHeight:
          item.subLabel === undefined
            ? "var(--control-height-md)"
            : "var(--menu-row-height)",
        padding: "var(--space-1) var(--space-2)",
        border: 0,
        borderRadius: "var(--radius-sm)",
        // danger 只改文字色，不染底——底是选择态的地盘（.option-row）
        ...(item.danger === true && !disabled ? { color: "var(--color-danger)" } : null),
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-base)",
        textAlign: "left",
        // 事实行不是「禁止你点」，光标不该摆出禁止符
        cursor: fact || header ? "default" : disabled ? "not-allowed" : "pointer",
        // 事实行矮一档（xs）：一眼能看出它们不是可点的那一类
        ...(fact ? { minHeight: "var(--control-height-xs)" } : null),
        // 分组头 = 设置面节标题的同款语言：UI 字、sm、semibold、secondary
        ...(header
          ? {
              minHeight: "var(--control-height-sm)",
              paddingTop: "var(--space-2)",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-sm)",
              // 加粗：两家 provider 靠得近时要一眼分出哪行是头（2026-09-21 wafo）——
              // 去大写后（2026-10-14）只剩字号、字重、颜色三条信号，字重不能省。
              // 仍用二级文字色，不抢模型行的主角位。
              fontWeight: "var(--weight-semibold)",
              color: "var(--color-text-secondary)",
            }
          : null),
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          color: item.danger === true ? "var(--color-danger)" : "var(--color-text-secondary)",
        }}
      >
        {item.avatar !== undefined ? (
          item.avatar
        ) : item.checked === true ? (
          <Icon name="check" size={13} strokeWidth={2} />
        ) : item.icon !== undefined ? (
          <Icon name={item.icon} size={13} strokeWidth={1.8} />
        ) : null}
      </span>
      {/*
        label 优先、hint 收缩：两者以前各占一个 grid 列（label 是 fr、会被挤到 0；
        hint 是 auto、按满字宽占位，长 hint 因此把短 label 挤没——Title model 菜单
        首项「Same as session」显示成「Same ...」就是这样来的）。改成同一列内的
        flex：label `flex:"none"` 永远按内容宽度显示，`justify-content:"space-between"`
        在两者之间留白（没有多余空间时退化成紧贴），hint 才是那个会被压缩、
        用 ellipsis 截断的一方。
      */}
      <span
        style={{
          display: "flex",
          // 有副行时这一列竖过来（主行 + 副行）；没副行就还是「label — hint」一行
          flexDirection: item.subLabel === undefined ? "row" : "column",
          alignItems: item.subLabel === undefined ? "center" : "flex-start",
          justifyContent: "space-between",
          gap: item.subLabel === undefined ? "var(--space-2)" : 0,
          minWidth: 0,
        }}
      >
        <span
          style={{
            flex: "none",
            maxWidth: "100%",
            minWidth: 0,
            lineHeight: "var(--line-height-ui)",
            /*
             * 事实行且没有 hint 时，label 是唯一的叙事者：长句（压缩确认那句
             * 「…仍要压缩？」）必须换行说完——省略号切掉一半就成了另一句话。
             * 其余行照旧单行省略：名字被截断至少还是个名字。
             */
            ...(fact && item.hint === undefined
              ? { whiteSpace: "normal" }
              : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }),
          }}
        >
          {item.label}
        </span>
        {item.subLabel !== undefined && (
          <span
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-1)",
              maxWidth: "100%",
              minWidth: 0,
              // 选中行整行半粗（.option-row 的选中态）是给主行的；副行是注脚，不跟着加粗
              fontWeight: "var(--weight-regular)",
            }}
          >
          <span
            style={{
              flex: "0 1 auto",
              maxWidth: "100%",
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--color-text-tertiary)",
              // 副行是注脚（模型卡片的厂商名、路径卡片的全路径），比主行退两档
              fontSize: "var(--font-size-xs)",
              lineHeight: "var(--line-height-ui)",
              ...(item.subLabelMono === true ? { fontFamily: "var(--font-family-mono)" } : null),
              // 「保尾巴」同 hint：direction rtl 让溢出发生在左侧，内层再隔离回 LTR
              ...(item.subLabelEllipsis === "head"
                ? { direction: "rtl" as const, textAlign: "left" as const }
                : null),
            }}
          >
            {item.subLabelEllipsis === "head" ? (
              <span style={{ unicodeBidi: "isolate", direction: "ltr" }}>{item.subLabel}</span>
            ) : (
              item.subLabel
            )}
          </span>
          {item.subLabelTrail !== undefined && (
            <span
              style={{
                flex: "none",
                whiteSpace: "nowrap",
                color: "var(--color-text-tertiary)",
                fontSize: "var(--font-size-xs)",
                lineHeight: "var(--line-height-ui)",
              }}
            >
              · {item.subLabelTrail}
            </span>
          )}
          </span>
        )}
        {item.hint !== undefined && (
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--color-text-tertiary)",
              fontSize: "var(--font-size-xs)",
              whiteSpace: "nowrap",
              // 「保尾巴」的截断：direction: rtl 让溢出发生在左侧（省略号落到头部），
              // text-align 再把它拉回左缘。**不能加 unicode-bidi: plaintext**——
              // 那会按首个强字符把方向判回 LTR，省略号又跑回尾部
              ...(item.hintEllipsis === "head"
                ? { direction: "rtl" as const, textAlign: "left" as const }
                : null),
              ...(fact
                ? {
                    fontFamily: "var(--font-family-business)",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--color-text-secondary)",
                  }
                : null),
            }}
          >
            {/* 内层必须是 LTR 的隔离段：不然行首的 "/" 会被 RTL 段落搬到行尾
                （"/Users/dama" 显示成 "Users/dama/"，小样里踩过） */}
            {item.hintEllipsis === "head" ? (
              <span style={{ unicodeBidi: "isolate", direction: "ltr" }}>{item.hint}</span>
            ) : (
              item.hint
            )}
          </span>
        )}
      </span>
      {item.badge}
    </button>
  );
  /*
   * 尾控件（星标）是行按钮的**兄弟**，不是子节点：HTML 里 button 不能嵌 button，
   * 浏览器会把内层拆出去，点击行为跟着乱。整行的底由外面这一层给（见 styles.css 的
   * .menu-row-tail）——鼠标落在星上时，亮的是整行，不是只有一半。
   */
  if (item.trailing === undefined) return row;
  return (
    <div className="menu-row-tail" data-cursor={props.cursor} data-current={item.checked === true}>
      {row}
      {item.trailing}
    </div>
  );
}
