/**
 * MCP 配置落盘 —— 一个 `<userData>/mcp.json`，Claude Desktop 兼容格式。
 *
 * 4-2 起从只读改为**读-改-写**：应用内加删启停要写这个文件。写法是读原文
 * JSON → 只改 `mcpServers[name]` → 原子写回。**其它顶层键与未知字段原样保留**、
 * 键序不动（JSON.stringify 按解析序回写）——用户手写的配置结构不该因为我们
 * 加了一台 server 就被重塑。加减 server 的主体路径仍是编辑文件（表单是另一条
 * 同样合法的路，不是替代）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
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

  /**
   * 读-改-写的公共底座：读原文（文件不在 = 空配置起步），改 `mcpServers`，
   * 原子写回整棵树（其它顶层键原样、键序不动）。JSON 坏了往上抛——写路径上
   * 把坏文件悄悄重置成空等于删用户配置。
   */
  private async mutate(
    change: (servers: Record<string, unknown>) => void,
  ): Promise<void> {
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // 文件不在 = 空配置起步（预置 mcpServers）；文件在但形状不对是另一回事，往下抛
      root = { mcpServers: {} };
    }
    const servers = root["mcpServers"];
    if (
      typeof servers !== "object" ||
      servers === null ||
      Array.isArray(servers)
    ) {
      throw new Error("mcp.json has the wrong shape (expected a top-level mcpServers object) — not written");
    }
    change(servers as Record<string, unknown>);
    await writeJsonAtomic(this.filePath, root);
  }

  /** 加一台。重名拒绝——覆盖等于吃掉用户现有配置。 */
  async add(name: string, server: McpServer): Promise<void> {
    await this.mutate((servers) => {
      if (Object.prototype.hasOwnProperty.call(servers, name)) {
        throw new Error(`A server named "${name}" already exists`);
      }
      servers[name] = server;
    });
  }

  /** 删一台。不存在就抛（面板只对列表里有的行出删除钮，抛错即状态漂了，该如实暴露）。 */
  async remove(name: string): Promise<void> {
    await this.mutate((servers) => {
      if (!(name in servers)) {
        throw new Error(`No such server: ${name}`);
      }
      delete servers[name];
    });
  }

  /** 启停：改写 disabled 字段（true 落盘，false 直接删字段——保持文件干净）。 */
  async setDisabled(name: string, disabled: boolean): Promise<void> {
    await this.mutate((servers) => {
      const server = servers[name];
      if (typeof server !== "object" || server === null) {
        throw new Error(`No such server: ${name}`);
      }
      const next = { ...(server as Record<string, unknown>) };
      if (disabled) next["disabled"] = true;
      else delete next["disabled"];
      servers[name] = next;
    });
  }
}
