import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableKernelEnabled, KernelHost } from "./kernel-host.ts";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("durableKernelEnabled", () => {
  it("只认字面量 1", () => {
    assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: "1" }), true);
    for (const value of ["0", "", "true", "yes", " 1"]) assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: value }), false);
    assert.equal(durableKernelEnabled({}), false);
  });
});

describe("KernelHost", () => {
  it("drop：删库文件（含 WAL 旁文件），别的树不动；库不在也算成功；库名带路径拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-host-"));
    dirs.push(dir);
    for (const name of ["t.sqlite", "t.sqlite-wal", "t.sqlite-shm", "other.sqlite"]) await writeFile(join(dir, name), "x");
    const host = new KernelHost(dir);
    await host.drop("t.sqlite");
    assert.deepEqual(await readdir(dir), ["other.sqlite"]);
    await host.drop("never.sqlite");
    await assert.rejects(host.drop("../x.sqlite"));
  });
});
