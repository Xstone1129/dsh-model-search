/**
 * 在 Node 里把 `lib/client.js` 当成浏览器插件真实加载一遍：
 * 用 jsdom 起一个 window，把产物 eval 进去，从 `window.__ModuleLoader__`
 * 里取回工厂、跑出导出面，再拿真实的 DOM 夹具验证行为。
 *
 * 这条路径与浏览器里 client-modules 加载插件的方式一致，因此测试覆盖的
 * 就是会被真正执行的那份代码（而不是 src 里另抄一遍的实现）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 构建产物：由 `npm run build` 从 src/ 生成。 */
export const CODE = readFileSync(join(root, "lib/client.js"), "utf8");

/** 测试用的 100 个模型（≈用户真实场景：自定义提供方一次拉回上百个）。 */
export const MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "deepseek-v4-pro-reasoning",
  "deepseek-chat",
  "deepseek-reasoner",
  "qwen3-max",
  "qwen3-coder-plus",
  "qwen3-coder-flash",
  "qwen3-vl-235b",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "glm-4.6",
  "glm-4.5-air",
  "kimi-k2-0905-preview",
  "claude-sonnet-4.5",
  "claude-opus-4.1",
  "gpt-5-codex",
  "grok-4-fast",
  "llama-3.3-70b-instruct",
  ...Array.from({ length: 80 }, (_, index) => `community/model-${String(index + 1).padStart(3, "0")}`),
];

/** 造一个 jsdom 世界并把插件产物加载进去。 */
export function boot({ html = "", lang = "zh-CN" } = {}) {
  const messages = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => messages.push(`jsdomError: ${error.message}`));
  for (const level of ["error", "warn", "info", "log"]) {
    virtualConsole.on(level, (...args) => messages.push(`${level}: ${args.join(" ")}`));
  }
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  let registration;
  window.__ModuleLoader__ = {
    load(value) {
      registration = value;
    },
  };
  window.eval(CODE);
  assert.ok(registration !== undefined, "客户端产物必须通过 __ModuleLoader__.load 注册自己");
  assert.equal(registration.id, "dsh-model-search", "注册的模块 id 必须与包名一致（loader 条目名）");

  const exports = registration.factory((specifier) => {
    throw new Error(`客户端插件不应 require 外部模块，却请求了 ${specifier}`);
  });
  const disposers = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      disposers.push(typeof dispose === "function" ? dispose : () => {});
      return () => {};
    },
  };

  return {
    dom,
    window,
    document: window.document,
    exports,
    internals: exports.__internals,
    messages,
    ctx,
    /** 卸载插件（跑 ctx.effect 的清理函数）并关掉 jsdom。 */
    dispose() {
      for (const dispose of disposers) dispose();
      window.close();
    },
  };
}

/** 宿主「获取模型列表」弹窗的 DOM 夹具（结构与内建实现逐字对应）。 */
export function dialogHtml(models = MODELS, { lang = "zh" } = {}) {
  const title = lang === "zh" ? "选择要添加的模型" : "Choose models to add";
  const description =
    lang === "zh" ? "以下是模型提供方的可用模型，勾选要添加的模型。" : "These are the models this provider has available.";
  const rows = models
    .map(
      (id) =>
        `<li class="zGbnIq_candidate"><label class="zGbnIq_candidateLabel">` +
        `<input type="checkbox"><span class="zGbnIq_candidateId">${id}</span></label></li>`,
    )
    .join("");
  return (
    `<div class="root" role="presentation"><div class="mask" aria-hidden="true"></div>` +
    `<div class="dialog zGbnIq_fetchDialog" role="dialog" aria-modal="true" aria-label="${title}">` +
    `<div class="content">` +
    `<div class="header"><h2 class="title">${title}</h2><button type="button" class="close" aria-label="关闭">×</button></div>` +
    `<p class="description">${description}</p>` +
    `<div class="body">` +
    `<div class="zGbnIq_candidateActions"><button type="button" class="zGbnIq_linkButton">全选</button></div>` +
    `<ul class="zGbnIq_candidateList">${rows}</ul>` +
    `</div></div>` +
    `<div class="footer"><button type="button">取消</button><button type="button">添加所选</button></div>` +
    `</div></div>`
  );
}

/** 输入框旁模型菜单的 DOM 夹具（结构与内建实现逐字对应）。 */
export function menuHtml(groups, { aria = "模型与推理等级" } = {}) {
  const sections = groups
    .map(
      (group) =>
        `<section role="group" aria-labelledby="title-${group.name}">` +
        `<div class="groupTitle" id="title-${group.name}">${group.name}</div>` +
        group.models
          .map(
            (model) =>
              `<button type="button" role="menuitemradio" class="option">` +
              `<span class="modelName">${model}</span></button>`,
          )
          .join("") +
        `</section>`,
    )
    .join("");
  return (
    `<div class="root"><button type="button" class="trigger">模型</button>` +
    `<div class="menu" role="menu" aria-label="${aria}">` +
    `<div class="groups scrollable">${sections}</div></div></div>`
  );
}

/** 等观察器节流（80ms）跑完。 */
export const settle = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));

/** 某条搜索条里当前可见的行文本。 */
export function visibleTexts(ul) {
  return Array.from(ul.children)
    .filter((li) => li.style.display !== "none")
    .map((li) => li.textContent.trim());
}

/** 在输入框里打字（触发 input 事件，跟真人输入一致）。 */
export function type(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** 按下某个键。 */
export function press(window, target, key) {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
