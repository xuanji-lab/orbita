/**
 * 实验功能清单：每个挂在实验开关（settings.experimental）后面的功能，连同它的开发日志。
 * 设置页「实验功能」开关下面按这张表列出来——用户打开开关之前就看得到里面有什么、
 * 每一版改了什么，打开即是自己愿意为这些功能接受不稳定（2026-10 用户裁决）。
 *
 * **怎么维护**（agent 照做）：
 * - 新功能挂到开关后面：在表里加一项，`changelog` 记第一条。
 * - 给实验功能加东西 / 修 bug 的 PR：在对应项的 `changelog` **末尾**追加一条
 *   （PR 号、日期、一句用户看得懂的话，中英各一）。PR 号开 PR 后回填。
 * - **转正**（用户说「把 X 移出实验功能」）：
 *   1. 去掉该功能所有 `useExperimental()` / `experimental` 门，入口常驻；
 *   2. 把这一项的 changelog 整理成正式版本的更新说明（`UPDATE_NOTES.md` 一节）；
 *   3. 从这张表里删掉这一项。
 *   表空了不删开关：下一个实验功能还要用它。
 *
 * 文案中英内联而不进 messages-*：一个功能的全部历史放在一处，转正时整段搬走。
 */

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
  /** 稳定标识（React key、测试用），不上屏 */
  id: string;
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
    ],
  },
  {
    id: "session-lifecycle",
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
    ],
  },
  {
    id: "pdf-citations",
    name: { zh: "PDF 引用", en: "PDF citations" },
    summary: {
      zh: "让智能体讲解 PDF 时，它引用的原文会先核对过，句子后面挂一个编号；点编号就在文件面板里打开 PDF，跳到那段原文并高亮。",
      en: "When the agent explains a PDF, every passage it quotes is checked first and marked with a number after the sentence; click it to open the PDF in the Files panel at that passage, highlighted.",
    },
    changelog: [
      {
        pr: null,
        date: "2026-10-11",
        note: {
          zh: "首版：引用前核对原文（找不到的引不进对话）、正文里的引用编号、文件面板里的 PDF 预览与原文高亮；拖进来的附件在文件面板里也能点开了。",
          en: "First version: quotes are checked before citing (ones not in the PDF never reach the chat), numbered citations in replies, PDF preview with the passage highlighted; dragged-in attachments now open in the Files panel too.",
        },
      },
    ],
  },
];
