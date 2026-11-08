import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONNECTORS } from "../../../../shared/connectors.ts";

// 资源导入（?raw / svg / png）在 node 里加载不了，所以读源码核对：目录里每个标文件都被 ConnectorLogo 导入并登记
const source = readFileSync(new URL("./ConnectorLogo.tsx", import.meta.url), "utf8");

test("目录里每个品牌标文件都在 ConnectorLogo 里导入并登记；单色标走 ?raw、彩色标走 URL", () => {
  for (const entry of CONNECTORS) {
    const file = entry.logo.file;
    assert.ok(source.includes(`connector-logos/${file}${entry.logo.mono ? "?raw" : '"'}`), `${entry.id}: ${file} 没按${entry.logo.mono ? "单色（?raw）" : "彩色（URL）"}导入`);
    assert.ok(source.includes(`"${file}":`), `${entry.id}: ${file} 没登记`);
  }
});
