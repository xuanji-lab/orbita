/**
 * 实验功能清单：每个挂在实验开关后面的功能，连同它的开发日志与卡片图标。
 * 设置页「实验功能」Tab 按这张表铺卡片墙——每张卡自带开关（`experimentalFeatures`
 * 里那一项）与更新日志，用户打开一项之前就看得到里面有什么、每一版改了什么，
 * 打开即是自己愿意为这个功能接受不稳定（2026-10-12 用户裁决：逐项开关）。
 *
 * **怎么维护**（agent 照做）：
 * - 新功能挂进实验区：先在 `@shared/settings` 的 EXPERIMENTAL_FEATURE_IDS 加 id
 *   （id 的唯一来源在那里），再在这里加一项，`changelog` 记第一条；
 * - 给实验功能加东西 / 修 bug 的 PR：在对应项的 `changelog` **末尾**追加一条
 *   （PR 号、日期、一句用户看得懂的话，中英各一）。PR 号开 PR 后回填；
 * - **转正**（用户说「把 X 移出实验功能」）：
 *   1. 去掉该功能所有 `useExperimentalFeature("…")` 门，入口常驻；
 *   2. 把这一项的 changelog 整理成正式版本的更新说明（`UPDATE_NOTES.md` 一节）；
 *   3. 从这张表里删掉这一项，并把它在 EXPERIMENTAL_FEATURE_IDS 里的 id 一并删掉。
 *   表空了不删设置键：下一个实验功能还要用它。
 *
 * 文案中英内联而不进 messages-*：一个功能的全部历史放在一处，转正时整段搬走。
 */
import type { ExperimentalFeatureId } from "@shared/settings";
import type { IconName } from "./shell/Icon.tsx";

/** 中英两份文案（界面语言二选一） */
export interface LocalizedText {
  zh: string;
  en: string;
}

/** 一条开发日志 */
export interface ExperimentalChange {
  /** PR 号；PR 制度之前直接提交的改动为 null */
  pr: number | null;
  /** YYYY-MM-DD */
  date: string;
  note: LocalizedText;
}

export interface ExperimentalFeature {
  /** 稳定标识（React key、settings.experimentalFeatures 的键），不上屏 */
  id: ExperimentalFeatureId;
  /** 卡片头部的图标（lucide，需在 shell/Icon.tsx 登记） */
  icon: IconName;
  name: LocalizedText;
  /** 一句话：这个功能是什么、在哪里看得到 */
  summary: LocalizedText;
  /**
   * 与另一项互斥（今天只有黑洞 ↔ 俄罗斯方块这一对）：设置页打开这一项时连带
   * 把它关掉（SettingsView 的开关逻辑）。盘上手改出两个都开时 parseSettings
   * 以黑洞为准。双方都要声明（对称），文案里也要说清互斥。
   */
  exclusiveWith?: ExperimentalFeatureId;
  /** 按时间顺序（旧 → 新） */
  changelog: readonly ExperimentalChange[];
}

/** PR 链接：仓库的 PR 页 */
export function pullRequestUrl(pr: number): string {
  return `https://github.com/xuanji-lab/orbita/pull/${pr}`;
}

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  {
    id: "paper-themes",
    icon: "notebook-pen",
    name: { zh: "纸面皮肤", en: "Paper themes" },
    summary: {
      zh: "小学作业（中文稿纸）与打字稿（英文打字机）两档主题，在外观 › 主题里选。",
      en: "Copybook (Chinese manuscript paper) and Typescript (English typewriter) themes, under Appearance › Theme.",
    },
    changelog: [
      {
        pr: 74,
        date: "2026-09-25",
        note: {
          zh: "稿纸两档主题：中文稿纸的绿格红笔，英文打字稿的打字机字与红页边线。",
          en: "Two paper themes: green grid and red pen for Chinese, typewriter face and red margin for English.",
        },
      },
      {
        pr: 76,
        date: "2026-09-25",
        note: {
          zh: "界面语言跟主题走：稿纸主题下界面全中文，打字稿全英文。",
          en: "Interface language follows the theme: all Chinese on manuscript paper, all English on Typescript.",
        },
      },
      {
        pr: 78,
        date: "2026-09-25",
        note: {
          zh: "首页门面：红田字格里的标语、打字稿的英文标语与红笔批语。",
          en: "Home screen: the slogan in red practice grids, an English slogan on Typescript, and a red-pen remark.",
        },
      },
      {
        pr: 80,
        date: "2026-09-25",
        note: {
          zh: "稿纸主题改名「小学作业」，输入框里的英文垫修正液；首页批语落当天日期。",
          en: "Manuscript renamed Copybook; English in the composer sits on correction fluid; the home remark carries today's date.",
        },
      },
      {
        pr: 184,
        date: "2026-10-10",
        note: {
          zh: "挂到实验开关后面：关着时主题选择卡不列这两档，已选的照常生效。",
          en: "Moved behind the experimental switch: hidden from the theme picker when off; a theme already chosen keeps applying.",
        },
      },
      {
        pr: 184,
        date: "2026-10-12",
        note: {
          zh: "改为单独开关：这一项自己有开 / 关，不再跟总开关。",
          en: "Given its own switch: on and off by itself, no longer tied to a master switch.",
        },
      },
    ],
  },
  {
    id: "session-lifecycle",
    icon: "circle-check",
    name: { zh: "会话生命周期", en: "Session lifecycle" },
    summary: {
      zh: "给会话加星标、标记完成；完成时扫描遗留事项，挂在右栏「遗留事项」里。",
      en: "Star sessions and mark them done; marking done scans for carryovers, listed under Carryovers in the right rail.",
    },
    changelog: [
      {
        pr: null,
        date: "2026-09-22",
        note: {
          zh: "首版：星标、完成状态与闲置收尾建议；完成时扫描遗留事项，扫描结果渲染成卡片。",
          en: "First version: stars, done state and idle nudges; marking done scans for carryovers, shown as a card.",
        },
      },
      {
        pr: 76,
        date: "2026-09-25",
        note: {
          zh: "遗留事项入口常驻，0 条时点进去看空态。",
          en: "The Carryovers entry is always there; with none, it opens to an empty state.",
        },
      },
      {
        pr: 94,
        date: "2026-09-27",
        note: {
          zh: "修复：设置页里点右栏的已归档 / 遗留事项入口没反应。",
          en: "Fix: the Archived and Carryovers entries in the right rail did nothing while Settings was open.",
        },
      },
      {
        pr: 130,
        date: "2026-10-02",
        note: {
          zh: "收尾扫描要求模型交卷前自检格式，扫描结果不再偶发解析失败。",
          en: "The carryover scan asks the model to check its own output, so scans stop failing to parse now and then.",
        },
      },
      {
        pr: 184,
        date: "2026-10-10",
        note: {
          zh: "挂到实验开关后面：关着时星标、完成、遗留事项的入口全部隐藏，数据原样保留。",
          en: "Moved behind the experimental switch: stars, done and carryover entries hide when off; the data stays.",
        },
      },
      {
        pr: 184,
        date: "2026-10-12",
        note: {
          zh: "改为单独开关：这一项自己有开 / 关，不再跟总开关。",
          en: "Given its own switch: on and off by itself, no longer tied to a master switch.",
        },
      },
    ],
  },
  {
    id: "composer-blackhole",
    icon: "orbit",
    exclusiveWith: "composer-tetris",
    name: { zh: "输入框黑洞", en: "Input box black hole" },
    summary: {
      zh: "拖进来的文件被吸进输入框中心，再从聊天区顶上的舷窗掉进输入框上方的隐形盒子，堆起来；发送后消息顶上留一份缩小的快照。只在浅色、黛、玄三套主题生效。与『俄罗斯方块』互斥：打开这个会关掉俄罗斯方块。",
      en: "Dropped files are pulled into the centre of the composer, then fall from a porthole at the top of the chat into an invisible box above it and pile up; sent messages keep a shrunken snapshot. Light, Slate and Onyx themes only. Mutually exclusive with Tetris: turning this on turns Tetris off.",
    },
    changelog: [
      {
        pr: 188,
        date: "2026-10-11",
        note: {
          zh: "首版：中心变黑、吸入、舷窗掉落、重力堆叠与删除补位，发送后消息里留缩小快照。",
          en: "First version: the centre darkens, files are pulled in, fall from the porthole, stack under gravity and settle when one is removed; sent messages keep a shrunken snapshot.",
        },
      },
      {
        pr: 184,
        date: "2026-10-11",
        note: {
          zh: "挂到实验开关后面：关着时设置里不出这个开关，存过的选择也不生效。",
          en: "Moved behind the experimental switch: the toggle is hidden when off, and a saved choice has no effect.",
        },
      },
      {
        pr: 184,
        date: "2026-10-12",
        note: {
          zh: "改为单独开关：这一项自己有开 / 关，不再跟总开关。",
          en: "Given its own switch: on and off by itself, no longer tied to a master switch.",
        },
      },
      {
        pr: 212,
        date: "2026-10-12",
        note: {
          zh: "与『俄罗斯方块』互斥：打开这个会连带关掉俄罗斯方块（同一个材料盒的两种形态）。",
          en: "Mutually exclusive with Tetris: turning this on now turns Tetris off (two styles of the same material box).",
        },
      },
    ],
  },
  {
    id: "composer-tetris",
    icon: "blocks",
    exclusiveWith: "composer-blackhole",
    name: { zh: "俄罗斯方块", en: "Tetris" },
    summary: {
      zh: "拖进来的文件不演黑洞特效，从输入框上方的隐形盒子口随机落下、堆起来，删除后重力补位，发送后消息顶上留一份缩小快照。只在浅色、黛、玄三套主题生效。与『输入框黑洞』互斥：打开这个会关掉黑洞。",
      en: "Dragged files skip the black-hole theatrics: they drop at random from the mouth of the invisible box above the input and stack up, settle under gravity when removed, and sent messages keep a shrunken snapshot. Light, Slate and Onyx themes only. Mutually exclusive with the input box black hole: turning this on turns the black hole off.",
    },
    changelog: [
      {
        pr: 212,
        date: "2026-10-12",
        note: {
          zh: "首版：材料从盒口纯随机落点落下（确定性种子，同一份清单永远同一个布局）。",
          en: "First version: materials drop from the mouth of the box to purely random spots (deterministic seeds; the same list always yields the same layout).",
        },
      },
    ],
  },
  {
    id: "pdf-citations",
    icon: "quote",
    name: { zh: "PDF 引用", en: "PDF citations" },
    summary: {
      zh: "拖个 PDF 进来让 agent 讲解：引用原文前先核验，点正文里的编号就在文件面板里跳到那一段并高亮。",
      en: "Drop a PDF in and ask the agent about it: quotes are verified before they appear, and clicking a citation number jumps to the passage in the Files panel and highlights it.",
    },
    changelog: [
      {
        pr: 191,
        date: "2026-10-11",
        note: {
          zh: "首版：引用前先核验原文，核验过的才发编号；点编号跳到原文并荧光笔高亮。",
          en: "First version: quotes are verified against the PDF before they appear; clicking a number jumps to the source and highlights it.",
        },
      },
      {
        pr: 191,
        date: "2026-10-12",
        note: {
          zh: "改为单独开关：这一项自己有开 / 关；关着时编号退回纯文本、PDF 不进预览。",
          en: "Given its own switch: on and off by itself; when off, citation numbers fall back to plain text and PDFs stay out of the preview.",
        },
      },
    ],
  },
  {
    id: "computer-use",
    icon: "monitor",
    name: { zh: "电脑使用", en: "Computer use" },
    summary: {
      zh: "设置里多出「电脑使用」页：检测这台电脑能不能跑沙箱、启动 / 关闭沙箱、手动看一眼沙箱桌面——agent 在沙箱里干活的那部分还在路上。",
      en: "Adds a Computer use page to Settings: probe whether this machine can run the sandbox, start / stop it, and peek at its desktop — the agent working inside it is still on the way.",
    },
    changelog: [
      {
        pr: 220,
        date: "2026-10-12",
        note: {
          zh: "首版：能力检测、沙箱启停与手动「看一眼」，先作为沙箱管理的入口。",
          en: "First version: capability probe, sandbox start / stop and a manual peek — the sandbox management entry for now.",
        },
      },
    ],
  },
];
