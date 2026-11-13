import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { builtinPluginsDir } from "./builtin.ts";

describe("builtinPluginsDir", () => {
  test("打包版读 resources/builtin-plugins（asar 之外），开发版读仓库里的 resources/builtin-plugins", () => {
    assert.equal(builtinPluginsDir({ packaged: true, resourcesPath: "/app/Resources", appPath: "/app/Resources/app.asar" }), join("/app/Resources", "builtin-plugins"));
    assert.equal(builtinPluginsDir({ packaged: false, resourcesPath: "/electron/Resources", appPath: "/repo" }), join("/repo", "resources", "builtin-plugins"));
  });
});
