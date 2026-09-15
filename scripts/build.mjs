#!/usr/bin/env node
/**
 * 把 `src/client.js` + `src/client.css` 打成一个 DSH 客户端插件包：`lib/client.js`。
 *
 * DSH 的浏览器半边是 `window.__ModuleLoader__.load({ id, factory })` 形式的
 * 「工厂包」，`factory(require)` 的返回值就是插件模块的导出（`apply` / `inject`）。
 * 本插件的源码本身就是工厂体，所以这里不需要打包器、不需要任何依赖，
 * 只做三件事：套外壳、内联 CSS、校验版本号与 id。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(join(root, "src/client.js"), "utf8");
const css = readFileSync(join(root, "src/client.css"), "utf8");

// 版本号只有一个真相来源：package.json。源码里写死了就校验，防止发版漏改。
const declared = /const VERSION = "([^"]+)"/.exec(source)?.[1];
if (declared === undefined) throw new Error("build: src/client.js 缺少 `const VERSION` 声明");
if (declared !== pkg.version) {
  throw new Error(`build: 版本不一致 —— src/client.js 是 ${declared}，package.json 是 ${pkg.version}`);
}

const banner = `/**
 * ${pkg.name} v${pkg.version} — browser half (generated).
 *
 * 由 scripts/build.mjs 从 src/client.js + src/client.css 生成，请勿直接编辑。
 * 重新生成：\`npm run build\`（或 \`node scripts/build.mjs\`）。
 *
 * @see https://github.com/${pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "")}
 */`;

const output = `${banner}
window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region styles（由 src/client.css 内联）
		const STYLES = ${JSON.stringify(css)};
		//#endregion

${source.replace(/^/gm, "\t\t")}

		return module.exports;
	}
});
`;

mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib/client.js"), output);
console.log(`build: lib/client.js ← src/client.js + src/client.css  (${output.length} bytes, v${pkg.version})`);
