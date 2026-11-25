// Metro 配置：手机端直接引仓库里的契约 `../src/shared/mobile.ts`（不抄第二份类型），
// 所以要把它所在的目录放进 watchFolders；依赖只从 mobile/node_modules 解析，不碰根目录的依赖。
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "..", "src", "shared");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
