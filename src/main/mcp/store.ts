/**
 * MCP 配置落盘 —— 一个 `<userData>/mcp.json`，Claude Desktop 兼容格式。
 *
 * **只读不写。** 这一刀不做「在界面里加一台 server」：那需要一整套命令、参数、
 * 环境变量的表单，而用户手上现成的配置粘进文件里就能用。管理面负责**看状态**
 * 与**开关**，加减 server 走编辑文件（同 skills 的「新建走文件管理器」）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import { parseMcpConfig, type McpServer } from "../../shared/mcp.ts";

const TEMPLATE = `{
  "mcpServers": {
  }
}
`;

export class McpStore {
  private readonly filePath: string;

  constructor(configDir: string) {
    this.filePath = join(configDir, "mcp.json");
  }

  path(): string {
    return this.filePath;
  }

  /**
   * 读配置。文件不存在 = 一台都没配（返回空）；**其它失败往上抛**——
   * 把「读不出来」说成「没配」会让用户以为自己的 server 丢了（D-3 同款）。
   *
   * JSON 坏了也抛：让用户看见「第 3 行少个逗号」，比默默当没配好得多。
   */
  async read(): Promise<Record<string, McpServer>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
    return parseMcpConfig(JSON.parse(raw));
  }

  /** 文件不存在时写一个空模板，好让「打开配置」有东西可开。 */
  async ensureFile(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) await writeFile(this.filePath, TEMPLATE, "utf8");
    }
  }
}
