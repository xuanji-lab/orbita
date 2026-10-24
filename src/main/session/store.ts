/**
 * 会话落盘 —— 每条会话两个文件（设计与被否决的方案见
 * `docs/plans/2026-08-25-会话存储与命名工作区.md`）：
 *
 *   sessions/<id>.meta.json   可变（标题 / updatedAt / 权限档），原子写
 *   sessions/<id>.jsonl       只追加，一行一个 SessionRecord
 *
 * 分两个文件的理由：meta 会变而 transcript 只增。把可变记录塞进只追加的日志里，
 * 要么改个标题就重写全文，要么读取时全文扫描找最后一条 meta。分开之后
 * **列会话只需读 N 个小 meta 文件，完全不碰日志**。
 */
import { appendFile, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { writeBytesAtomic, writeJsonAtomic, writeTextAtomic } from "../atomic-write.ts";
import {
  isOriginalRef,
  mimeOfExtension,
  originalExtension,
  type PromptImage,
  type SentImage,
} from "../../shared/prompt-images.ts";
import { isNotFound } from "../fs-errors.ts";
import { headStringField, scanJsonlLines } from "../jsonl-scan.ts";
import { EXTERNAL_FILE_COPY_MAX_BYTES, type PromptFileRef, type SentFileRef } from "../../shared/prompt-attachments.ts";
import type { AgentStats, SessionWorkbenchStat } from "../../shared/agent-ipc.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { SessionWrapup } from "../../shared/wrapup.ts";
import { isClosingScanText } from "../../shared/wrapup-scan.ts";

/** 收尾扫描的机器提问（用户消息形，但不是用户说的话） */
function isMachinePrompt(record: SessionRecord): boolean {
  if (record.role !== "user") return false;
  const text = record.content.find((block) => block.type === "text");
  return text !== undefined && text.type === "text" && isClosingScanText(text.text);
}
import {
  childSessions,
  deriveSessionTitle,
  isChannelMarkRecord,
  isCompactedRecord,
  parseSessionMeta,
  pushRecentQuery,
  recentQueriesFromRecords,
  SESSION_PAGE_RECORDS,
  sortSessions,
  UNASSIGNED_PROVIDER_ID,
  type SessionCompletion,
  type SessionDetail,
  type SessionMeta,
  type SessionOlderPage,
  type SessionRecord,
  type SessionWindowDetail,
} from "../../shared/session.ts";
import type { ChannelStore } from "../channel/store.ts";
import { SnapshotStore } from "./snapshots.ts";
import {
  isFileTurnRecord,
  isRevertRecord,
  isUndoRecord,
  type FileChange,
  type FileChangePayload,
  type FileTurnRecord,
} from "../../shared/revert.ts";

/**
 * 会话 id 必须长得像 `randomUUID()`。
 *
 * **这是安全检查，不是洁癖**：id 从 renderer 经 IPC 传进来，直接拼进路径的话，
 * 一个 `../../` 就能读写 sessions 目录之外的文件。白名单比转义可靠。
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 会话 id 白名单，导出给 ChannelStore 用——通道账本的路径
 * `channels/<parentId>/<childId>.jsonl` 同样把 renderer 传来的 id 拼进路径，
 * 同一个安全等级，不重复这条正则。
 */
export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

const META_SUFFIX = ".meta.json";

/**
 * 一次分支的全部预制件（C-2）。prepareBranch 只读不写；pi 那边把分支文件落了
 * （agent 进程的 createBranchedSession），才由 commitBranch 落盘——顺序保证中途
 * 失败最多留下一个孤儿 pi 文件，而不是一条「看得见历史但 pi 没有前文」的半残会话。
 */
export interface BranchPlan {
  /** 新会话 id（新 meta 与新 JSONL 都用它） */
  newId: string;
  /** 源会话 id：commitBranch 拷贝工作台要用（`workbenches/<sourceId>` → `<newId>`） */
  sourceId: string;
  /** 源会话的 pi 本子——agent 进程要打开它裁分支 */
  sourcePiSessionFile: string;
  /** 前缀记录（含锚点回答）：新会话的初始 transcript */
  records: SessionRecord[];
  /** 前缀的 user/assistant 角色序列，发去 agent 进程与 pi 文件逐位对账 */
  roles: ("user" | "assistant")[];
  /** 新会话 meta（piSessionFile 空着占位，commitBranch 补真值） */
  meta: SessionMeta;
}

/**
 * 「空 error 回答」：status=error 且内容为空的 assistant 记录。auto_retry 的每次失败
 * 尝试会发这样一条终态帧；在非流式阶段（工具执行中 / 两次模型调用之间）被
 * interrupt 打断时，pi 产出的也是这个形状。**pi 自己的本子会收它**（message_end 上
 * 无条件 appendMessage，_prepareRetry 只从 agent state 里摸掉、刷不掉会话文件），
 * 而我们**刻意不收**——空条目不带任何上下文，不该出现在 transcript 里。两本账因此
 * 天然不等长，对齐靠对账侧同样排除（branch-cut.ts 的 isEmptyErrorAssistantEntry 对 pi
 * 条目用同一谓词）。谓词收敛在这里：落盘侧「不写」与对账侧（branchRoles）「照跳」
 * 必须同一标准，各写一份迟早漂移。
 */
export function isEmptyErrorAssistant(record: SessionRecord): boolean {
  return record.role === "assistant" && record.status === "error" && record.content.length === 0;
}

/**
 * 前缀的 user/assistant 角色序列——与 pi 文件里的消息条目按位对账用（两本账没有
 * id 映射，顺序是唯一桥梁）。跳过「空 error 回答」（isEmptyErrorAssistant）：落盘侧
 * 不写新记录，这里跳的是谓词收敛之前存的存量；pi 侧虽然收了这类条目，但
 * branch-cut.ts 对它们施加同一个排除谓词，两侧因此对得上。其余罕见漂移由 agent
 * 进程的对账守卫兜底——拒绝分支优于切错位置。
 *
 * **`channel-mark` 记为 `"user"`**（子会话 2026-09-23 不变量修正）：一条通道标记
 * 顶替的正是 pi 本子里的一条 user 消息（`ChannelMarkRecord` 的接收侧标记，见
 * `shared/session.ts`）——按位对账时这本账数的是「标记」而 pi 那本数的是「信封
 * user 消息」，不把它算作 user 的话，带通道投递的会话在这两本账之间会错位一位，
 * 之后的每一条都对不上，分支会被拒绝。
 */
export function branchRoles(records: readonly SessionRecord[]): ("user" | "assistant")[] {
  const roles: ("user" | "assistant")[] = [];
  for (const record of records) {
    if (record.role === "channel-mark") {
      roles.push("user");
      continue;
    }
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (isEmptyErrorAssistant(record)) continue;
    roles.push(record.role);
  }
  return roles;
}

/**
 * A-2：从分支前缀聚合 tokens / cost。branch 出来的新会话，「这个任务此前花了多少」
 * 是真实历史（终态帧都带 usage），该带就带。**只聚合累计值，contextUsage 恒为
 * null**：余量取决于 pi 按裁剪后上下文的现算，聚合不出来——meta 里如实没有，
 * UI 显示「未知」。前缀里没有任何带 usage 的回答（旧会话、纯提问、usage 缺席）
 * 返回 null（meta.stats 无账本）。
 */
export function aggregatePrefixUsage(records: readonly SessionRecord[]): AgentStats | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let cost = 0;
  let seen = false;
  for (const record of records) {
    if (record.role !== "assistant" || record.usage === undefined) continue;
    seen = true;
    input += record.usage.input ?? 0;
    output += record.usage.output ?? 0;
    cacheRead += record.usage.cacheRead ?? 0;
    cacheWrite += record.usage.cacheWrite ?? 0;
    total += record.usage.totalTokens ?? 0;
    cost += record.usage.cost?.total ?? 0;
  }
  if (!seen) return null;
  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    contextUsage: null,
  };
}

export class SessionStore {
  private readonly dir: string;
  /** 会话工作台的根（<userData>/workbenches）。缺席时从 sessions 目录的父目录派生，测试临时目录因此天然隔离 */
  private readonly workbenchesDir: string;

  /**
   * 快照正文仓（sessions/<id>.snapshots/，revert.ts）：轮尾账的 before / after
   * 正文按内容寻址存在这里，JSONL 只存引用。与会话同生共死（remove 一并删）。
   */
  readonly snapshots: SnapshotStore;

  /**
   * 每条会话的 meta 写入链（见 `queueMeta`）。会话删掉时清掉自己那条，
   * 不然长会话跑一天下来这里会攒下一堆已经没人要的 promise。
   */
  private readonly metaWrites = new Map<string, Promise<unknown>>();

  /**
   * 通道账本的持有者（子会话 2026-09-23）。**可选**——旧的调用点（测试、
   * 未接线的场景）不传它，remove() 就只删会话本身，不级联通道文件。
   */
  private readonly channels: ChannelStore | undefined;

  constructor(dir: string, workbenchesDir?: string, channels?: ChannelStore) {
    this.dir = dir;
    this.workbenchesDir = workbenchesDir ?? join(dirname(dir), "workbenches");
    this.channels = channels;
    this.snapshots = new SnapshotStore(dir);
  }

  private metaPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}${META_SUFFIX}`);
  }

  private logPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}.jsonl`);
  }

  /**
   * 本会话记录文件（transcript JSONL）的路径，只算路径、不读不写。read_task 读子会话
   * 只给输出时拿它给模型指路：真要看过程就读这个文件（工具面对 sessions/ 只读可读）。
   */
  recordPath(id: string): string {
    return this.logPath(id);
  }

  /**
   * 本会话的工作台目录 `<workbenches>/<id>/`：plan / handoff / 草稿的落点，随开轮
   * 告诉模型。**目录不预建**（首次写入才由模型 mkdir，空会话不占目录）。
   * 不套在 sessions/ 里：protectedPaths 把整个 sessions/ 设为工具面只读，工作台必须可写。
   * id 同样过白名单——路径拼进开轮命令，和 metaPath/logPath 一个安全等级。
   */
  workbenchPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.workbenchesDir, id);
  }

  /**
   * 附图原图目录 `sessions/<id>.attachments/`。**放在 sessions/ 里**：原图是会话记录的一部分，
   * 跟着它一起对工具面只读（protectedPaths 已覆盖整个 sessions/）、一起删。
   * 不放工作台：那里模型可写，原图不该被工具改掉。目录不预建，首次存图才建。
   * list() 只认 `.meta.json`，这个子目录不会被当成会话。
   */
  attachmentsPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}.attachments`);
  }

  /**
   * 某会话的附图原图目录（绝对路径）。给 agent 进程随轮发（图片字节预算的占位
   * 要拼出可 read 回来的原图路径）；目录可能还不存在（首次存图才建）。
   */
  attachmentDirOf(id: string): string {
    return this.attachmentsPath(id);
  }

  /**
   * 存下一批附图的原图，返回挂上 `original` 引用的同一批图（发给 agent 进程的那份）。
   *
   * **存不下不拦发送**：原图只是给人放大看的，模型收到的是缩放图——磁盘满了就不带引用，
   * 看大图退回缩放图，原因落到 dev 终端。renderer 载荷里带来的 `original` 一律丢掉重铸：
   * 引用是路径，只能由主进程定。
   *
   * 存在发送之前，所以这一轮如果没跑起来，文件会留在会话目录里——删会话时一并清掉。
   */
  async saveOriginals(id: string, images: readonly PromptImage[]): Promise<SentImage[]> {
    const dir = this.attachmentsPath(id);
    const saved: SentImage[] = [];
    for (const image of images) {
      const bare: SentImage = { type: "image", data: image.data, mimeType: image.mimeType };
      const extension = originalExtension(image.mimeType);
      if (extension === null) {
        // 格式不对的图 agent 进程会拒掉整条；这里不存、不抢着报错
        saved.push(bare);
        continue;
      }
      const name = `${randomUUID()}.${extension}`;
      try {
        await writeBytesAtomic(join(dir, name), Buffer.from(image.data, "base64"));
        saved.push({ ...bare, original: `${id}/${name}` });
      } catch (error) {
        console.error("[session] 附图原图没存下，这张看大图时只有缩放图", error);
        saved.push(bare);
      }
    }
    return saved;
  }

  /**
   * 文件引用发送前的装配（`sentImages` 的文件版）：external 的复制进会话附件目录、
   * 引用改指副本——副本跟着会话一起删，回放不依赖原位置；workspace 的原位置引用，
   * 本来就在 agent 的目录清单里，复制一份只会过期。两类路径都 realpath 成本机规范形
   * 再发给模型（renderer 的树拼接在 win 上可能产出混合分隔符），文件还是目录按盘上
   * lstat 修正（renderer 分不清拖进来的是什么）。realpath 解析不到就原样带上——
   * 模型 read 会当场失败，比这里静默改写诚实。
   *
   * 副本存进**以 uuid 命名的子目录**、保留原文件名（`<uuid>/notes.txt`）：模型与
   * 回显 chip 看到的末段是真名（`<uuid>.txt` 谁也认不出是什么）；同一批拖进两个
   * 同名文件也各归各的子目录，天然不冲突。
   *
   * **存不下不拦发送**：与 saveOriginals 同一条规矩——副本只是外部文件的保险，
   * 失败时引用原位置并在 dev 终端说明。目录不复制（可能巨大），原位置引用；
   * **超过 EXTERNAL_FILE_COPY_MAX_BYTES 的文件同样不复制**（Proma Agent 同一阈值
   * 先例）：一份 100MB+ 的副本 noticeable 地吃磁盘与拷贝时间，而引用原路径对
   * 模型同样可用——代价是原件挪走后引用会断，这一点 renderer 在胶囊上明说。
   * `copyLimit` 只给测试注入小阈值用，生产不给。
   */
  async saveExternalFiles(
    id: string,
    refs: readonly PromptFileRef[],
    copyLimit: number = EXTERNAL_FILE_COPY_MAX_BYTES,
  ): Promise<SentFileRef[]> {
    const saved: SentFileRef[] = [];
    for (const ref of refs) {
      // realpath 既做规范化（win 混合分隔符）也做存在性检查；失败按「引用原样带上」处理
      let real = ref.path;
      try {
        real = await realpath(ref.path);
      } catch (cause) {
        console.error(`[session] 文件引用 realpath 失败，按原路径引用：${ref.path}`, cause);
      }
      let kind: SentFileRef["kind"] = ref.kind;
      let target = real;
      if (ref.origin === "external") {
        try {
          const stats = await lstat(real);
          kind = stats.isDirectory() ? "dir" : "file";
          if (!stats.isDirectory()) {
            if (stats.size > copyLimit) {
              // 超限不复制：按原位置引用，代价（原件挪走即断）由胶囊上的「未复制」说明
              console.error(`[session] 外部文件超过复制上限（${stats.size} > ${copyLimit}），按原位置引用：${real}`);
            } else {
              const dest = join(this.attachmentsPath(id), randomUUID(), basename(real));
              // copyFile 到临时名再 rename：半截副本不会被当成完整文件（writeBytesAtomic 的文件版）
              const staging = `${dest}.partial`;
              await mkdir(dirname(dest), { recursive: true });
              await copyFile(real, staging);
              await rename(staging, dest);
              target = dest;
            }
          } else {
            console.error(`[session] 外部目录不复制，按原位置引用：${real}`);
          }
        } catch (cause) {
          // 复制失败引用原位置：模型读得到就读，读不到在对话里看得见
          console.error(`[session] 外部文件没复制进会话，按原位置引用：${real}`, cause);
        }
      }
      saved.push({ path: target, name: ref.name, kind });
    }
    return saved;
  }

  /** 按引用读原图。引用不合格、文件不在（如分支的源会话已删）都是 null；其它读盘错照抛 */
  async readOriginal(ref: unknown): Promise<PromptImage | null> {
    if (!isOriginalRef(ref)) return null;
    const [sessionId = "", name = ""] = ref.split("/");
    const mimeType = mimeOfExtension(name.slice(name.lastIndexOf(".") + 1));
    if (mimeType === null) return null;
    try {
      const bytes = await readFile(join(this.attachmentsPath(sessionId), name));
      return { type: "image", data: bytes.toString("base64"), mimeType };
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  /**
   * 工作台的现状（`session:workbench-stat` 的回执）。按需现算、不进 meta——
   * 目录存不存在是磁盘上的事实，会话不该背着它的快照。递归数文件不计目录；
   * 符号链接不跟（跟的话链接环转不出来），链接算一个文件。
   * 读不了 ≠ 没有：除 ENOENT 外照抛，与 `list()` 同一条规矩。
   *
   * **级联求和**（子会话 2026-09-22 裁决）：fileCount 是自己 + 全部后代工作台
   * 文件数之和，exists 是自己或任一后代存在——唯一消费者是侧栏删除确认
   * （`stat.exists && stat.fileCount > 0` 才出提示），级联删要把子的文件也说出来。
   * path 仍是自己的：它是给「打开这个会话的工作台」用的，不该指向别人的目录。
   */
  async workbenchStat(id: string): Promise<SessionWorkbenchStat> {
    const path = this.workbenchPath(id);
    const countFiles = async (dir: string): Promise<number> => {
      let total = 0;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // Dirent 是 lstat 语义：符号链接 isDirectory() 恒 false，自然算一个文件
        total += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
      }
      return total;
    };
    const statOne = async (targetId: string): Promise<{ exists: boolean; fileCount: number }> => {
      try {
        return { exists: true, fileCount: await countFiles(this.workbenchPath(targetId)) };
      } catch (cause) {
        if (isNotFound(cause)) return { exists: false, fileCount: 0 };
        throw cause;
      }
    };
    let exists = false;
    let fileCount = 0;
    for (const targetId of [id, ...(await this.descendants(id))]) {
      const stat = await statOne(targetId);
      exists = exists || stat.exists;
      fileCount += stat.fileCount;
    }
    return { path, exists, fileCount };
  }

  /**
   * 确保这条会话在盘上，并把 pi 本子对齐到这一轮。标题空着，等第一条用户消息填。
   *
   * **整件事是写入链上的一个任务**，这是它不拆成「读一下 + 建」两步的全部理由：
   * 首轮建 meta 与首条用户消息的 `record` 是并发到达的两件事，不排进同一条链就会赛跑。
   * `record` 的存在性守卫先跑就读到「meta 还没有」，把首条用户消息整条丢掉
   * （2026-09-12 实测：新会话第一句不落盘，侧栏标题因此永远空着，重开会话比当时少一截）。
   *
   * 已存在时**只校准 `piSessionFile`**：标题、用量、置顶这些已经长出来的字段不能被一份
   * 刚拼的初始 meta 盖掉。
   */
  ensureSession(meta: SessionMeta): Promise<void> {
    return this.queueMeta(meta.id, async () => {
      const current = await this.readMeta(meta.id);
      if (current === null) {
        await writeJsonAtomic(this.metaPath(meta.id), meta);
        return;
      }
      if (current.piSessionFile === meta.piSessionFile) return;
      await writeJsonAtomic(this.metaPath(meta.id), {
        ...current,
        piSessionFile: meta.piSessionFile,
      });
    });
  }

  /**
   * 记一条 transcript 记录。**只在终态调用**——哪些帧算终态、abort 怎么算，
   * 全部由 `recorder.ts` 决定，这里只管写。
   */
  async record(id: string, item: SessionRecord): Promise<void> {
    // **存在性守卫必须排进写入链**：首轮的 `ensureSession` 也在这条链上，直接
    // `readMeta` 会和它赛跑——输了就把首条用户消息整条丢掉。这是一个只读任务，
    // 排到链尾即可，不嵌套在别的链内任务里，不会与下面的 `update` 死锁。
    const meta = await this.queueMeta(id, () => this.readMeta(id));
    if (meta === null) return; // 会话的 meta 没了就别再往日志里加，避免长出孤儿日志
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.logPath(id), `${JSON.stringify(item)}\n`, "utf8");

    // **基于链内刚读的 meta 算**，不用上面 appendFile 之前那份快照——
    // 写盘期间标题可能刚落、最近提问可能刚被别的消息推过
    await this.update(id, (current) => {
      const changes: Partial<SessionMeta> = { updatedAt: item.timestamp };
      // 标题只认第一条用户消息，之后不再改——否则会话会在侧栏里改名。
      // 手动改过名的会话 title 不为空，因此这条守卫自动让位给它。
      if (current.title === "" && item.role === "user") {
        const text = item.content.find((block) => block.type === "text");
        if (text !== undefined && text.type === "text") {
          changes.title = deriveSessionTitle(text.text);
        }
      }
      // 最近提问每条用户消息都记（首页会话卡的三槽吃它）；规则在 shared，两边一致。
      // 收尾扫描的机器提问不是用户的提问，不进最近提问（首页卡上会冒出一行「【Orbita 收尾扫描】」）
      if (item.role === "user") {
        const text = item.content.find((block) => block.type === "text");
        if (text !== undefined && text.type === "text" && !isClosingScanText(text.text)) {
          changes.recentQueries = pushRecentQuery(current.recentQueries, text.text);
        }
      }
      return changes;
    });
  }

  /**
   * 轮尾文件账落盘（主进程收到 fileTurn 事件时调）：正文写 blob、记录里只存
   * 引用。单个 blob 写失败降级成 unrecoverable（那一轮那一个文件回退不了，
   * 但整轮的账还在）——快照是回退能力的代价面，不是对话的依赖面。
   *
   * webArtifacts 是旁路网页产物（脚本生成、不在 changes 里、不参与撤销）：
   * 只有它、没有 changes 的轮也落记录——卡片要出，冷启动从 JSONL 重建时
   * 靠 isFileTurnRecord 把它原样读回来。webArtifactsBatch 同理：批量折叠的
   * 轮一个路径都不列，只有计数——没有计数的那轮卡片就什么都没有了。
   */
  async recordFileTurn(
    id: string,
    changes: readonly FileChangePayload[],
    webArtifacts: readonly string[] = [],
    webArtifactsBatch?: number,
  ): Promise<FileTurnRecord | null> {
    if (changes.length === 0 && webArtifacts.length === 0 && webArtifactsBatch === undefined) return null;
    const persisted: FileChange[] = [];
    for (const change of changes) {
      persisted.push({
        path: change.path,
        before: await this.persistSnapshot(id, change.before),
        after: await this.persistSnapshot(id, change.after),
        added: change.added,
        removed: change.removed,
      });
    }
    const record: FileTurnRecord = {
      role: "file-turn",
      id: randomUUID(),
      timestamp: Date.now(),
      changes: persisted,
      ...(webArtifacts.length > 0 ? { webArtifacts: [...webArtifacts] } : {}),
      ...(webArtifactsBatch !== undefined ? { webArtifactsBatch } : {}),
    };
    await this.record(id, record);
    return record;
  }

  private async persistSnapshot(
    id: string,
    payload: FileChangePayload["before"],
  ): Promise<FileChange["before"]> {
    if (payload.kind !== "text") return payload;
    try {
      return { kind: "text", blob: await this.snapshots.save(id, payload.content) };
    } catch (cause) {
      console.error("[session] 快照 blob 没存下，该文件这一轮无法回退", cause);
      return { kind: "unrecoverable" };
    }
  }

  /**
   * 用户会以为会话丢了（工作区改名走的是同一条规矩：空名退回路径末段）。
   * **任何显式改名（含改空）都记成 `user`**：auto-title 永不覆盖用户起的名字，
   * 连「用户清掉的名字」也不该在几条消息后自己长回来——那会被当成改名丢失。
   */
  async rename(id: string, title: string): Promise<void> {
    const wanted = deriveSessionTitle(title);
    const next = wanted !== "" ? wanted : derivedFrom(await this.readLog(id));
    await this.update(id, { title: next, titleSource: "user" });
  }

  /** 还需要自动生成标题吗（C-3 的发送门禁）。用户改过名 / 已生成过就不再试。 */
  async needsAutoTitle(id: string): Promise<boolean> {
    const meta = await this.readMeta(id);
    return meta !== null && meta.titleSource === "derived";
  }

  /**
   * 落一个模型生成的标题。**写入时再查一次 titleSource**——生成在途的几秒里
   * 用户可能刚改过名，读时是 derived 不算数，写前是 derived 才算。核验不过
   * （meta 没了 / 已 user / 已 auto）就整份丢弃：迟到的标题不该吵醒任何东西。
   */
  setAutoTitle(id: string, title: string): Promise<void> {
    const next = deriveSessionTitle(title);
    if (next === "") return Promise.resolve();
    // **这一次查必须和写在同一条写入链里**（见 `queueMeta`）：分开的话，读到的
    // derived 到写回之前可能已被别的写入改过，那句「写前再查」就是假的。
    return this.update(id, (meta) =>
      meta.titleSource === "derived" ? { title: next, titleSource: "auto" } : null,
    );
  }

  /**
   * 落一份用量快照（A1-Q1）。**只在 agent 带 `persist` 的那几帧调**——
   * 界面跟着每条消息走，磁盘只需要「上一次跑完时的样子」。
   */
  setStats(id: string, stats: AgentStats): Promise<void> {
    return this.update(id, { stats });
  }

  /**
   * 给导入的会话分配模型（设置 › 服务商的「分配模型」，model-assign.ts）。
   * **写入时再核一次占位**：预览到确认之间用户可能已经在某条会话里手动选过
   * 模型（provider 已是真实值），那时不覆盖、返回 false。importedModel 原样
   * 保留——分配不抹掉「原来用的是谁」的记录。
   */
  assignModel(id: string, providerId: string, modelId: string): Promise<boolean> {
    return this.queueMeta(id, async () => {
      const meta = await this.readMeta(id);
      if (meta === null || meta.providerId !== UNASSIGNED_PROVIDER_ID) return false;
      await writeJsonAtomic(this.metaPath(id), { ...meta, providerId, modelId });
      return true;
    });
  }

  /**
   * 改 meta 上的字段。**六处「读 → 改一个字段 → 原子写回」收成这一个**——
   * meta 不在就悄悄不做：会话可能刚被别处删掉，为此抛错没有意义。
   */
  private update(
    id: string,
    changes: Partial<SessionMeta> | ((meta: SessionMeta) => Partial<SessionMeta> | null),
  ): Promise<void> {
    return this.queueMeta(id, async () => {
      const meta = await this.readMeta(id);
      if (meta === null) return;
      const patch = typeof changes === "function" ? changes(meta) : changes;
      if (patch === null) return;
      await writeJsonAtomic(this.metaPath(id), { ...meta, ...patch });
    });
  }

  /**
   * 每条会话一条 meta 写入链。
   *
   * **原子写只保证单次写不撕裂，不保证两次「读-改-写」不互相覆盖。**
   * 真事故（wafo 2026-09-03 实测）：标题生成是一次 LLM 调用，要跑几秒；这几秒里
   * `record`（每条消息都调）与 `setStats`（每轮落定）已经各自读过 meta。标题写回
   * `titleSource: "auto"` 之后，它们手里那份旧快照一落盘就把它冲回 `derived`——
   * 于是下一条消息又生成一次标题，用户看到的是「已经命名好的会话又被重命名」。
   *
   * 这个竞态本来就在（record / setModel / setPiSessionFile 之间），只是都是低频事件、
   * 撞不上；A-1 加的 `setStats` 是高频的，把潜伏的变成了必现的。
   *
   * 链上某一环失败不该卡死后续写入，所以存回去的是吃掉异常的那一支；
   * 调用方拿到的仍是真实结果。
   */
  private queueMeta<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prev = this.metaWrites.get(id) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.metaWrites.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 记住 pi 这一次用的那份 session 文件——没有它，这条会话下次就只能读不能续 */
  setPiSessionFile(id: string, piSessionFile: string | null): Promise<void> {
    return this.update(id, { piSessionFile });
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.update(id, { mode });
  }

  /** 改思考档（照 setMode）：重开与下一轮开机的装配都读它 */
  setThinkingLevel(id: string, thinkingLevel: ThinkingLevel): Promise<void> {
    return this.update(id, { thinkingLevel });
  }

  /** 会话内切换模型（C-4）成功后落 meta——重开播种、分支继承、resume 对齐全读它 */
  setModel(id: string, providerId: string, modelId: string): Promise<void> {
    return this.update(id, { providerId, modelId });
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.update(id, { pinned });
  }

  /**
   * 星标：价值标记，与置顶（排序）正交——只动自己这一个字段，不参与排序，
   * 消费者是侧栏的行内标识与「Starred」筛选。
   */
  setStarred(id: string, starred: boolean): Promise<void> {
    return this.update(id, { starred });
  }

  /**
   * 完成状态：翻到 done / done_with_todos 的那一刻记下关闭时刻，reopen（回 open）
   * 时清掉——closedAt 与 completion 同进退，不留「open 却带着关闭时刻」的半态。
   * **同态幂等**：已是 done 再设 done 不刷新关闭时刻，「什么时候干完的」是历史
   * 事实，不是最后一次点击。非 open 两态之间切换（done → done_with_todos）算一次
   * 真实的翻档，刷新；本 PR 的 UI 只产生 open ↔ done，这条分支为 carryover 留着。
   */
  setCompletion(id: string, completion: SessionCompletion): Promise<void> {
    return this.update(id, (meta) =>
      (meta.completion ?? "open") === completion
        ? null
        : { completion, closedAt: completion === "open" ? null : Date.now() },
    );
  }

  /**
   * 收尾确认（session:wrapup-confirm）：一次 meta 写入里追加收尾记录、翻完成状态、取走这条会话
   * 在接着做的遗留事项 id（返回给调用方去标做完）。会话不存在返回 null。
   * 完成状态的翻法同 setCompletion：同态不刷新关闭时刻。
   */
  confirmWrapup(
    id: string,
    wrapup: SessionWrapup,
    completion: Exclude<SessionCompletion, "open">,
  ): Promise<{ resumed: string[] } | null> {
    return this.queueMeta(id, async () => {
      const meta = await this.readMeta(id);
      if (meta === null) return null;
      const resumed = meta.resumedCarryovers ?? [];
      const same = (meta.completion ?? "open") === completion;
      const next: SessionMeta = {
        ...meta,
        wrapups: [...(meta.wrapups ?? []), wrapup],
        completion,
        closedAt: same ? (meta.closedAt ?? Date.now()) : Date.now(),
      };
      delete next.resumedCarryovers;
      await writeJsonAtomic(this.metaPath(id), next);
      return { resumed };
    });
  }

  /** 记下这条会话在接着做某条遗留事项（遗留清单的「继续」）；重复的 id 不再记 */
  addResumedCarryover(id: string, carryoverId: string): Promise<void> {
    return this.update(id, (meta) =>
      (meta.resumedCarryovers ?? []).includes(carryoverId)
        ? null
        : { resumedCarryovers: [...(meta.resumedCarryovers ?? []), carryoverId] },
    );
  }

  /**
   * 未读标记（后台跑完还没看，2026-10-10 落盘）：`{ at, failed }` 标未读，null 清。
   * at / failed 由 renderer 在落定那一刻铸——什么时候跑完的、是不是挂了，是落定时
   * 的事实不是写盘时的事实。不做幂等判断：renderer 只在标 / 清那两次调，重复写
   * 同值无害（setCompletion 防的是“重刷新关闭时刻”那类历史改写，这里没有）。
   */
  setUnread(id: string, unread: { at: number; failed: boolean } | null): Promise<void> {
    return this.update(id, { unread });
  }

  /** 意图召回的会话级开关（实验功能 intent-system）：只落 meta，下一轮开轮现读 */
  setIntentEnabled(id: string, enabled: boolean): Promise<void> {
    return this.update(id, { intentEnabled: enabled });
  }

  /** 归档：从主列表移走，收进侧栏底部的 Archived。**不是删除**，随时能拿回来 */
  setArchived(id: string, archived: boolean): Promise<void> {
    return this.update(id, { archived });
  }

  /** 换归属工作区；null = 移出所有工作区，回到 TASKS */
  move(id: string, workspaceId: string | null): Promise<void> {
    return this.update(id, { workspaceId });
  }

  /**
   * 准备一次分支（C-2）：定位锚点、截前缀、抽角色序列、起好新 meta。
   * 锚点必须是 assistant 记录（界面只在轮末 agent 回答下给入口，这里是信任边界
   * 的再校验）。**只读不写**，落盘在 commitBranch。
   */
  async prepareBranch(id: string, anchorItemId: string): Promise<BranchPlan> {
    const meta = await this.readMeta(id);
    if (meta === null) throw new Error(`session ${id} not found`);
    if (meta.piSessionFile === null) {
      throw new Error("This task predates resumable sessions and can be read but not continued or branched");
    }
    const records = await this.readLog(id);
    const anchorIndex = records.findIndex(
      (record) => record.role !== "compacted" && record.id === anchorItemId,
    );
    const anchor = records[anchorIndex];
    if (anchor === undefined) throw new Error(`Branch anchor message not found: ${anchorItemId}`);
    if (anchor.role !== "assistant") throw new Error("Branch anchor must be an agent reply");

    const prefix = records.slice(0, anchorIndex + 1);
    const newId = randomUUID();
    const now = Date.now();
    return {
      newId,
      sourceId: id,
      sourcePiSessionFile: meta.piSessionFile,
      records: prefix,
      roles: branchRoles(prefix),
      // 标题沿用原标题加后缀（截断规则复用 deriveSessionTitle）；不置顶、
      // 不继承归档——分支的目的就是去那边继续说话
      meta: {
        id: newId,
        title: deriveSessionTitle(`${meta.title} (branch)`),
        titleSource: "derived",
        cwd: meta.cwd,
        workspaceId: meta.workspaceId,
        providerId: meta.providerId,
        modelId: meta.modelId,
        mode: meta.mode,
        thinkingLevel: meta.thinkingLevel,
        piSessionFile: null,
        pinned: false,
        archived: false,
        // 分支的新会话带着前缀里的最近提问——它的历史是真的，卡片不该显示空槽
        recentQueries: recentQueriesFromRecords(prefix.filter((record) => !isMachinePrompt(record))),
        // A-2（2026-09-17 裁决）：聚合前缀的 tokens/cost——「这条分支此前花了多少」
        // 是真实历史。**contextUsage 恒为 null**：pi 那本是裁过的，余量算不出来，
        // UI 如实显示「未知」，等它自己跑一轮就有真值
        stats: aggregatePrefixUsage(prefix),
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  /**
   * 分支落盘：新 meta（补上 pi 分支文件）+ 前缀整写为初始 JSONL（原子写）
   * + 工作台整体拷贝。
   */
  async commitBranch(plan: BranchPlan, piSessionFile: string | null): Promise<void> {
    if (piSessionFile === null) throw new Error("pi produced no branch session file; branch was not persisted");
    // 工作台拷贝放最前（meta 落盘之前）：拷贝失败时这里什么都不落，残留只是 pi
    // 那头的孤儿文件；放最后则失败会留一条「看得见却没带文件」的半残分支。
    // 源不存在就跳过（工作台不预建，空会话不占目录），新会话的也保持不存在。
    try {
      await cp(this.workbenchPath(plan.sourceId), this.workbenchPath(plan.newId), {
        recursive: true,
      });
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    await writeJsonAtomic(this.metaPath(plan.meta.id), { ...plan.meta, piSessionFile });
    if (plan.records.length > 0) {
      await writeTextAtomic(
        this.logPath(plan.meta.id),
        `${plan.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
  }

  /**
   * 导入落盘：一份现成的 meta + 整份 transcript（Proma pi 同构导入，importer.ts）。
   * 与 commitBranch 同形状（meta + 全量 JSONL 原子写），不复用它是因为 BranchPlan
   * 的形状是分支语义（roles/piSessionFile 占位）；两处耦合会把「分支的落盘约束」
   * 泄进导入。id 由导入器铸（randomUUID），此处不重复校验存在性——同 id 撞库
   * 概率为零，导入是离线批处理，不值得为它排写入链。
   */
  async commitImported(meta: SessionMeta, records: readonly SessionRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.metaPath(meta.id), meta);
    if (records.length > 0) {
      await writeTextAtomic(
        this.logPath(meta.id),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
  }

  /**
   * 再次导入的追加落盘（importer.ts 的 updated 条目）：Proma 里有新消息、orbita 这边没接着聊的
   * 会话，整份 transcript 换成从新源派生的（旧记录 id 由 entry id 派生，换完仍是同一批 id），
   * meta 只动派生字段——标题、置顶、星标、归档、工作区、模型都是 orbita 这边的，不被源覆盖。
   *
   * **排进这条会话的写入链**：同一时刻 record() 可能在往日志里追加，不排队就会互相覆盖。
   * 链内先确认 meta 还在：扫描与执行之间会话可能刚被删掉，这时不该把它写回来。
   * transcript 先写、meta 后写：中间崩了留下的是「内容新、列表时间旧」，下次重扫它已与源
   * 一致（pi 副本在调用方就换好了），只是卡片的最近提问晚一拍——可见且无害。
   */
  commitImportUpdate(
    id: string,
    records: readonly SessionRecord[],
    patch: Pick<SessionMeta, "recentQueries" | "stats" | "updatedAt">,
  ): Promise<void> {
    return this.queueMeta(id, async () => {
      const current = await this.readMeta(id);
      if (current === null) throw new Error("the session was deleted before the update landed");
      await writeTextAtomic(this.logPath(id), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      await writeJsonAtomic(this.metaPath(id), { ...current, ...patch });
    });
  }

  /** 会话列表：置顶在前，其余最近的在前。**坏掉的 meta 直接跳过**，不让一条坏记录挡住整张列表。 */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      // 目录还不存在 = 一条会话都没有；**读不了 ≠ 没有**——权限、ENOTDIR 等照抛，
      // 吞成空列表会让用户以为会话全没了（D-3 的根因）
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const meta = await this.readMeta(name.slice(0, -META_SUFFIX.length)).catch(() => null);
      if (meta !== null) metas.push(meta);
    }
    return sortSessions(metas);
  }

  async load(id: string): Promise<SessionDetail | null> {
    const meta = await this.readMeta(id);
    if (meta === null) return null;
    return { meta, transcript: await this.readLog(id) };
  }

  /**
   * 打开一条会话的**尾窗**（IPC 的 session:load 走这条）。
   *
   * **主进程仍然全量读盘 + `foldReverts`**（实测 25MB / 2948 条的会话读盘解析折叠
   * 约 120ms，可接受）——瓶颈是 IPC 传输量与 renderer 的渲染量，那两处才是分页的对象。
   * 折叠语义一个字不动：切片发生在**生效视图**上（见 `readLog`），回退界碑之后的记录
   * 本来就不在这条链上。
   *
   * 窗口起点对齐到轮边界（`alignToTurnStart`）：从一轮的中间切会把半轮的工具行留在
   * 窗口开头，renderer 的分组里它们是无主的（用户气泡不在）。
   *
   * 要**全量**的消费者照旧走 `load`：导出、回退、intent 归档、read_task。
   */
  async loadWindow(id: string, limit: number = SESSION_PAGE_RECORDS): Promise<SessionWindowDetail | null> {
    const meta = await this.readMeta(id);
    if (meta === null) return null;
    const effective = await this.readLog(id);
    const start = alignToTurnStart(effective, Math.max(0, effective.length - pageRecords(limit)));
    return {
      meta,
      transcript: effective.slice(start),
      window: { total: effective.length, hasMore: start > 0 },
    };
  }

  /**
   * 再往前一页（renderer 滚动触顶时调）：返回生效视图里 `before` 那条记录之前的一段。
   *
   * `before` 是**已加载窗口的第一条记录的 id**（renderer 手里那个），按它在生效视图里
   * 定位。排不进视图（会话刚被回退 / 删除，窗口已经不对应盘上的世界）就回空页 +
   * hasMore=false——宁可不给，也不按旧下标切一段可能是别人的历史回去。
   * 起点同样对齐到轮边界；hasMore 按**对齐后**的起点算（对齐吃掉的那几条下一页还会取到）。
   */
  async loadOlder(
    id: string,
    before: string,
    limit: number = SESSION_PAGE_RECORDS,
  ): Promise<SessionOlderPage> {
    const effective = await this.readLog(id);
    const end = effective.findIndex((record) => record.id === before);
    if (end < 0) {
      console.error(`[session] 分页锚点在生效视图里找不到（会话可能刚被回退）：${id} / ${before}`);
      return { records: [], hasMore: false };
    }
    const start = alignToTurnStart(effective, Math.max(0, end - pageRecords(limit)));
    return { records: effective.slice(start, end), hasMore: start > 0 };
  }

  /**
   * 某条会话的全部后代 id（不含自己），基于 `list()` 按 parentId 递归收集。
   * 消费者：`remove()` 的级联、`workbenchStat()` 的求和、`session:delete` 的
   * dispose（先释放全部后代 + 自己在 runtime 里的活跑轮，再删文件）。
   *
   * **防环**：parentId 成环只可能来自手改 meta 文件（正常路径——delegate、
   * 导入器——都不会造出环），但手改是真实存在的输入源，递归不能因此无限展开
   * 撑爆栈。`visited` 记的是「已经收进结果的 id」，撞到已收过的就跳过、不再
   * 往下递归——环上的节点只会被收一次。
   */
  async descendants(id: string): Promise<string[]> {
    return this.descendantsOf(id, await this.list(), new Set([id]));
  }

  private descendantsOf(id: string, metas: readonly SessionMeta[], visited: Set<string>): string[] {
    const result: string[] = [];
    for (const child of childSessions(metas, id)) {
      if (visited.has(child.id)) continue; // 环：已经收过，不重复收、不再递归
      visited.add(child.id);
      result.push(child.id);
      result.push(...this.descendantsOf(child.id, metas, visited));
    }
    return result;
  }

  /**
   * 删一条会话。**先删 transcript，后删 meta**——顺序不是随意的：
   * 两次 rm 之间崩了的话，
   *   先删 meta：留下一个**列不出来也删不掉**的 .jsonl，永远占着盘；
   *   先删 transcript：留下一条打得开但空的会话，用户看得见、能自己再删一次。
   * 可见的残留优于隐形的残留。
   *
   * **级联删**（子会话 2026-09-22 裁决）：子会话是母会话的附属物，删母连带删子。
   * **基于 `descendants()` 的结果而不是自己递归**（自己递归会在成环的 meta 上
   * 无限展开，descendants 已经把防环做掉了，不该有第二份递归逻辑）：先收集
   * 「自己 + 全部后代」这份定死的清单，再逐个做单条清理。
   *
   * **清理顺序是后代先、自己最后**——这条和上面「先删 transcript 后删 meta」
   * 是同一条纪律（可见的残留优于隐形的残留）。反过来先删自己的话：两条
   * `removeOne` 之间崩溃，没删完的后代 meta 还在，但它们 parentId 链头指向的
   * 会话已经不在了——从此既进不了左栏（rootSessions 按 parentId 过滤掉带
   * parentId 的）也摸不到父的 Sub-sessions 入口，变成一份看不见也够不着的
   * 隐形残留。先删后代、自己最后：中途崩溃时还没删到的那些后代，它们的父
   * 依然还在，仍然摸得到、看得见——即便这一整套删除操作没跑完，用户至少
   * 能在界面上发现并再删一次。`descendants()` 是 DFS 前序（自己在前、子孙
   * 在后），`.reverse()` 换来的正是「子孙先于自己」的序：任一节点在反转后
   * 的列表里，永远排在它自己的全部后代之后（孙先于子、子先于父），最后
   * 再把 `id` 本身接到末尾。
   */
  async remove(id: string): Promise<void> {
    const order = [...(await this.descendants(id)).reverse(), id];
    for (const targetId of order) {
      await this.removeOne(targetId);
    }
  }

  /** `remove()` 对单条会话的清理：读自己的 meta（要拿 parentId 去找自己那条通道）→ 删通道 → 删自己三份文件。 */
  private async removeOne(id: string): Promise<void> {
    const meta = await this.readMeta(id);
    await this.channels?.removeForParent(id);
    if (meta?.parentId !== undefined) {
      await this.channels?.removeChannel({ parentId: meta.parentId, childId: id });
    }
    // 先等它自己那条写入链排完，再删——否则在途的 `update` 会在删完之后
    // 把 meta 文件又写回去（`update` 内部读不到才跳过，它已经读到了）。
    await this.queueMeta(id, async () => undefined);
    this.metaWrites.delete(id);
    await rm(this.logPath(id), { force: true });
    await rm(this.metaPath(id), { force: true });
    // 原图在 meta 之后删：删失败最多残留一个没人引用的目录，不会出现「会话还在、图没了」
    await rm(this.attachmentsPath(id), { recursive: true, force: true });
    // 快照正文仓同理（回退能力的代价面，跟会话一起走）
    await rm(join(this.dir, `${id}.snapshots`), { recursive: true, force: true });
    // 工作台最后删：它删失败最多残留一个无引用目录（不进列表、不吵任何人）；
    // 若排在前头、账本还没删就崩，则留一条「有工作台却列不出来」的半残会话。
    await rm(this.workbenchPath(id), { recursive: true, force: true });
  }

  /**
   * 读一条会话的 meta（逐字段校验）；null = 不存在。原是 private，文件面板的根
   * 清单只需要标题——用 `load` 会连带把整份 transcript 读进来，为一个字段付全量读盘不划算。
   */
  async readMeta(id: string): Promise<SessionMeta | null> {
    try {
      return parseSessionMeta(JSON.parse(await readFile(this.metaPath(id), "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * 读日志的**原始全量**（不做回退折叠）。唯一的消费者是审查面板的 task 来源
   * （`main/review/task-source.ts`）：基线 = 本任务首次改该文件前的快照，**含已
   * 撤回轮次**——回退不抹掉「这个任务动过哪些文件」的事实，面板看的是盘上现状
   * 与最初基线的净差。其余读者（load / export / branch / read_task）都要生效视图，
   * 用 readLog。
   */
  readRawLog(id: string): Promise<SessionRecord[]> {
    return this.readLogEntries(id);
  }

  /**
   * 只读用量相关的记录：assistant 与 intent-recall，按盘上顺序，不做回退折叠（与 readRawLog 同口径——
   * 回退不抹掉已经花掉的 token）。任务账本回填专用（审核 F-3）：**流式按行读、按行首的 role 粗筛**，
   * 工具结果这类几 MB 的大行不解码不解析，内存只跟留下的小行走（见 main/jsonl-scan.ts）。
   * 行首看不到 role 的行保守地整行解析，解析后再按 role 精筛，所以结果与
   * `readRawLog` 再筛这两种 role 逐条一致。读失败返回空，与 readLogEntries 同一兜底。
   */
  async readUsageLog(id: string): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];
    try {
      await scanJsonlLines(
        this.logPath(id),
        (head) => {
          const role = headStringField(head, "role");
          return role === undefined || role === "assistant" || role === "intent-recall";
        },
        (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return; // 半截行跳过
          }
          const role = (parsed as { role?: unknown } | null)?.role;
          if (role === "assistant" || role === "intent-recall") records.push(parsed as SessionRecord);
        },
      );
    } catch {
      return [];
    }
    return records;
  }

  /**
   * 读日志（**生效视图**）：逐行解析、坏行跳过——只追加的文件最后一行可能因为
   * 断电写了一半，为此丢掉整条会话的记录是不划算的。回退界碑（revert 记录）在
   * 这里折叠生效列表：截到它的 targetMessageId 之前，界碑本身留下（界面画
   * 「已回退」+ 还原卡）。目标不在生效列表里（自身已被更早的回退折掉）只留界碑，
   * 不折叠——坏记录不该连带丢掉后面的真历史。
   */
  private async readLog(id: string): Promise<SessionRecord[]> {
    // 生效视图 = 原始全量 + 回退界碑折叠（见 readRawLog 的注释：只有 task 来源要全量）
    return this.foldReverts(await this.readLogEntries(id));
  }

  /** 原始逐行解析（不折叠）。readLog / readRawLog 共用这一个循环。 */
  private async readLogEntries(id: string): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath(id), "utf8");
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        // 界碑逐字段校验；**长着界碑的脸但字段不齐的行跳过**——
        // 半截摘要当消息渲染，比少渲染一行更糟
        if (isCompactedRecord(parsed)) {
          records.push(parsed);
          continue;
        }
        // 通道标记同一条纪律：字段齐的收下，长着它的脸但不齐的跳过——
        // 半截标记被当成消息强转，下游访问 content 就是 undefined
        if (isChannelMarkRecord(parsed)) {
          records.push(parsed);
          continue;
        }
        // 文件账三件（revert.ts）同一条纪律：字段齐的收下，不齐的跳过
        if (isFileTurnRecord(parsed) || isRevertRecord(parsed) || isUndoRecord(parsed)) {
          records.push(parsed);
          continue;
        }
        const suspect = parsed as { role?: unknown } | null;
        if (suspect !== null && typeof suspect === "object" && suspect.role === "compacted") continue;
        if (suspect !== null && typeof suspect === "object" && suspect.role === "channel-mark") continue;
        if (
          suspect !== null &&
          typeof suspect === "object" &&
          (suspect.role === "file-turn" || suspect.role === "revert" || suspect.role === "undo")
        ) {
          continue;
        }
        records.push(parsed as TranscriptItem);
      } catch {
        // 半截行：跳过它，前面读到的照常返回
      }
    }
    return records;
  }

  /**
   * 回退界碑折叠：界碑把生效列表截到它的 targetMessageId 之前（该消息及之后全部
   * 撤出），界碑自己留下（界面画「已回退」+ 还原卡）。目标不在列表里（自身已被更早
   * 的回退折掉）只留界碑、不折叠——坏记录不该连带丢掉后面的真历史。
   */
  private foldReverts(records: readonly SessionRecord[]): SessionRecord[] {
    const effective: SessionRecord[] = [];
    for (const record of records) {
      if (isRevertRecord(record)) {
        const target = effective.findIndex((item) => item.id === record.targetMessageId);
        if (target >= 0) effective.length = target;
      }
      effective.push(record);
    }
    return effective;
  }
}

/** IPC 进来的 limit 在这条线上夹住：它来自 renderer，不设上限就是给了一条自选的传输量 */
const PAGE_RECORDS_MAX = 2000;

/** 一页的条数：坏值 / 缺席退默认，再夹在 [1, PAGE_RECORDS_MAX] */
function pageRecords(limit: number): number {
  if (!Number.isFinite(limit)) return SESSION_PAGE_RECORDS;
  return Math.min(Math.max(1, Math.floor(limit)), PAGE_RECORDS_MAX);
}

/**
 * 轮边界：窗口只能从一条 user 记录（或同级的通道标记）开始。
 *
 * `channel-mark` 计入（理由同 `branchRoles`）：它顶替的正是 pi 本子里的一条 user
 * 消息，renderer 的分组 / 折叠也把它当边界——不从它切，工具栏就同样无主。
 */
function isTurnStart(record: SessionRecord | undefined): boolean {
  return record !== undefined && (record.role === "user" || record.role === "channel-mark");
}

/**
 * 把窗口起点对齐到轮边界（源侧分页的切片点，`loadWindow` / `loadOlder` 共用）。
 *
 * 从 start 往后找第一条轮边界：半轮的工具行不能留在窗口开头（renderer 的分组里
 * 它们归到上一个不在窗口里的 user 名下）。往后找不到（窗口里一条 user 都没有，
 * 例如最后 600 条都在同一轮里）就往回找最近的那条——宁可窗口比一页稍大，
 * 也不给一段无主的历史。两边都没有（整条会话一条 user 记录也没有）只能按 start 切。
 */
function alignToTurnStart(records: readonly SessionRecord[], start: number): number {
  if (start <= 0) return 0;
  if (isTurnStart(records[start])) return start;
  for (let i = start; i < records.length; i += 1) {
    if (isTurnStart(records[i])) return i;
  }
  for (let i = start - 1; i >= 0; i -= 1) {
    if (isTurnStart(records[i])) return i;
  }
  return start;
}

/** 从记录里推导标题：第一条用户消息的第一行。改名清空时退回它。 */
function derivedFrom(transcript: readonly SessionRecord[]): string {
  for (const item of transcript) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      const title = deriveSessionTitle(block.text);
      if (title !== "") return title;
    }
  }
  return "";
}
