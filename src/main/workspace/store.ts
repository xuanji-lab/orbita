/**
 * 工作区 —— agent 能看到的那个文件夹。
 *
 * 为什么必须显式：`cwd` 之前写死 `"."`，在打包后的应用里指向哪儿是不确定的，
 * 而工具（read / write / bash）全都相对它工作。**用户必须一眼看得见 agent 能碰哪里。**
 *
 * 本轮只做「一个文件夹」。命名容器、多工作区、按项目记忆会话——都等有真实消费者再说
 * （落库纪律）。session 的 cwd 在 `createAgentSession` 时固定，所以换工作区 = 换会话，
 * 这一点在 UI 上要说清楚，不能让用户以为切了目录当前对话就跟着走。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";

interface WorkspaceFile {
  version: 1;
  current: string;
}

export class WorkspaceStore {
  private readonly filePath: string;
  private cache: string | null = null;

  constructor(dir: string) {
    this.filePath = join(dir, "workspace.json");
  }

  /**
   * 没有选定工作区时 agent 落在哪儿。**只在这里定义一次**——
   * `current()` 的兜底与渲染层显示给用户的那个「Home」必须是同一个值。
   */
  static defaultPath(): string {
    return homedir();
  }

  /** 当前工作区。没选过就是 home——显式、可见、一键可改，而不是一个说不清的 `"."`。 */
  async current(): Promise<string> {
    if (this.cache !== null) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as WorkspaceFile;
      if (typeof parsed.current === "string" && parsed.current !== "") {
        this.cache = parsed.current;
        return this.cache;
      }
    } catch {
      // 文件不存在或坏了都退回 home：工作区是可以随时重选的，不值得为此让应用起不来
    }
    this.cache = WorkspaceStore.defaultPath();
    return this.cache;
  }

  async set(path: string): Promise<void> {
    const payload: WorkspaceFile = { version: 1, current: path };
    await writeJsonAtomic(this.filePath, payload);
    this.cache = path;
  }
}
