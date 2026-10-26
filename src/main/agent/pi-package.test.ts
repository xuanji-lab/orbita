import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGED_PI_DIR, piPackageDir } from "./pi-package.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

test("开发版指向 node_modules 里 pi 的包目录，那里真有 pi 的 package.json", () => {
  const dir = piPackageDir({ packaged: false, resourcesPath: "/unused", appPath: ROOT });
  const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.ok(typeof pkg === "object" && pkg !== null && "name" in pkg && "version" in pkg);
  assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
  // 与仓库钉死的版本一致：pi.dev 按这个版本号发目录
  const ours: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(typeof ours === "object" && ours !== null && "dependencies" in ours);
  const deps = ours.dependencies as Record<string, string>;
  assert.equal(pkg.version, deps["@earendil-works/pi-coding-agent"]);
});

test("打包版指向 resources 下的子目录，且 electron-builder 真的把 pi 的 package.json 拷到那里", () => {
  assert.equal(
    piPackageDir({ packaged: true, resourcesPath: "/r", appPath: "/unused" }),
    join("/r", PACKAGED_PI_DIR),
  );
  const ours: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(typeof ours === "object" && ours !== null && "build" in ours);
  const build = ours.build as { extraResources?: { from: string; to: string }[] };
  const entry = (build.extraResources ?? []).find((item) => item.to === `${PACKAGED_PI_DIR}/package.json`);
  assert.ok(entry, "package.json 的 build.extraResources 缺 pi 的 package.json");
  assert.equal(entry.from, "node_modules/@earendil-works/pi-coding-agent/package.json");
  assert.ok(existsSync(join(ROOT, entry.from)));
});
