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
 *   2. 把这一项的 changelog 整理成正式版本的更新说明——UPDATE_NOTES.md 已移出仓库，
 *      写进转正那个 commit 的正文（会话生命周期 2026-10-24 即如此）；
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
    id: "intent-system",
    icon: "waypoints",
    name: { zh: "意图系统", en: "Intent system" },
    summary: {
      zh: "发消息前先召回相关旧对话：门卫拦截寒暄，过岗打分入选进上下文，拿不准的先问你。右栏「意图」看每一问的入选图谱；召回走本机 intent-lab 服务（自己 bun run serve 起）。",
      en: "Before answering, relevant past conversations are recalled: a gate skips small talk, scoring picks entries into context, and unsure ones are confirmed with you first. See each question's pick graph under Intent in the right rail; recall runs on a local intent-lab service you start yourself.",
    },
    changelog: [
      {
        pr: 221,
        date: "2026-10-13",
        note: {
          zh: "首版：意图闸门（门卫 → 理解 → 打分 → 理由 → 摘句 → 确认 → 上下文）插在回显与回答之间；回答前确认卡（对 / 不对 / 不表态 / 改字）；右栏意图图谱（六岗泳道 + 本问 + 历史联系）；会话级开关与渠道（Proma / DeepSeek）；token 记进 7 天用量；回退作废、每轮存档。",
          en: "First version: the intent gate (gate → understand → score → reasons → excerpt → confirm → context) sits between your message and the answer; a confirm-before-answering card (right / wrong / skip / reword); the Intent graph in the right rail (six slot lanes + this question + past links); per-task switch and pipeline (Proma / DeepSeek); recall tokens counted into the 7-day usage; revert invalidates, every turn archived.",
        },
      },
    ],
  },
  {
    id: "memory-system",
    icon: "brain",
    name: { zh: "记忆系统", en: "Memory system" },
    summary: {
      zh: "对话按事件整理成事实 / 偏好 / 经验三类原子记忆，每轮开始前召回相关的注入上下文（需要先在设置里配好家务活模型）。",
      en: "Conversations are distilled into atomic memories of fact / preference / insight by event, and relevant ones are recalled into context before each turn (needs a chore model configured first).",
    },
    changelog: [
      {
        pr: 374,
        date: "2026-10-29",
        note: {
          zh: "首版后端：独立记忆服务进程，对话按事件段切分、每段整理成事实 / 偏好 / 经验，每轮开始前召回注入；条目与注入记录的界面在后续版本里加。",
          en: "First backend version: a separate memory service process, conversations segmented by event and distilled into facts / preferences / insights, with per-turn recall injection; the UI for entries and injections comes later.",
        },
      },
    ],
  },
];
