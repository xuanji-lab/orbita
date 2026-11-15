/**
 * 构建阅读器 web 版时用的 webpack 外包配置（由 scripts/fetch-pdf-reader.mjs 拷进 reader 的克隆根目录再跑）。
 * 不改 reader 源码一行：取它自己的 `web` 配置，只加两样——
 * 1. 把所有指向 `structured-document-text/` 的模块换成我们的空桩（那个子模块没有许可证，我们构建时不拉它）；
 * 2. `exportsPresence: "error"`：桩里少了 reader 要 import 的名字就当场失败，升级 reader 多出新 import 时不会静默变成 undefined。
 */
const path = require("path");
const webpack = require("webpack");
const configs = require("./webpack.config.js");

const web = configs.find((config) => config.name === "web");
if (web === undefined) throw new Error("reader 的 webpack 配置里没有 web 这一份");

const stub = path.resolve(__dirname, "orbita-sdt-stub.mjs");
web.plugins.push(
  new webpack.NormalModuleReplacementPlugin(/structured-document-text[\\/]/, (resource) => {
    resource.request = stub;
    if (resource.createData !== undefined) resource.createData.resource = stub;
  }),
);
web.module.parser = { ...(web.module.parser || {}), javascript: { exportsPresence: "error" } };

module.exports = web;
