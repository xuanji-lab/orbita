// 依赖解析：按包自己的 exports map（import/default 条件）解析到 dist 文件，
// 不经 require.resolve（它走 CJS 条件，解析不了 ESM-only 子路径）。
// 用法：resolvePkg(root, "@earendil-works/pi-durable/storage/sqlite/node") → 绝对路径
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** exports map 的一个节点可能是字符串或条件对象；import > default，嵌套取第一个命中 */
function pickTarget(node) {
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return undefined;
  return node.import ?? node.default ?? Object.values(node).map(pickTarget).find((v) => v !== undefined);
}

export function resolvePkg(root, spec) {
  const first = spec.indexOf("/");
  const scoped = spec.startsWith("@") && first > 0;
  const nameEnd = scoped ? spec.indexOf("/", first + 1) : first;
  const name = nameEnd < 0 ? spec : spec.slice(0, nameEnd);
  const subpath = spec.slice(name.length); // "" 或 "/sub/path"
  const base = join(root, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  if (subpath === "" || subpath === "/") {
    const target = typeof pkg.main === "string" ? pkg.main : pkg.main ?? pkg.module;
    return join(base, target);
  }
  const exports = pkg.exports ?? {};
  const key = `.${subpath}`;
  let node = exports[key];
  if (node === undefined) {
    // 通配（./storage/* 这类）：找最长前缀匹配
    for (const [k, v] of Object.entries(exports)) {
      const star = k.indexOf("*");
      if (star < 0) continue;
      const [pre, post] = [k.slice(0, star), k.slice(star + 1)];
      if (key.startsWith(pre) && key.endsWith(post)) {
        const mid = key.slice(pre.length, key.length - post.length);
        const target = pickTarget(v);
        if (typeof target === "string") return join(base, target.replaceAll("*", mid));
      }
    }
    throw new Error(`${spec} 不在 ${name} 的 exports 里`);
  }
  const target = pickTarget(node);
  if (typeof target !== "string") throw new Error(`${spec} 没有可用的 import 目标`);
  return join(base, target);
}
