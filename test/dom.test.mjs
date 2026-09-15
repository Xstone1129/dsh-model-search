/**
 * DOM 行为单测：把插件真的挂到「获取模型列表」弹窗 / 模型菜单的夹具上，
 * 验证搜索框出现、过滤正确、批量勾选可用、结构消失后能干净卸载。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { boot, dialogHtml, menuHtml, MODELS, settle, type, press, visibleTexts } from "./helpers.mjs";

const FLASHES = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "qwen3-coder-flash", "gemini-2.5-flash"];

/** 起一个世界 + 弹窗夹具，并跑一遍 apply。 */
function withDialog({ models = MODELS, lang = "zh", options } = {}) {
  const env = boot({ html: dialogHtml(models, { lang }) });
  env.window.localStorage.setItem("dsh-model-search:options", JSON.stringify({ autoFocus: false, ...options }));
  env.exports.apply(env.ctx);
  const ul = env.document.querySelector("ul");
  const bar = env.document.querySelector('[data-dms-bar="dialog"]');
  return { ...env, ul, bar, input: bar?.querySelector(".dms-input") ?? null };
}

test("弹窗：挂上搜索框，插在候选列表之前且不破坏宿主节点", () => {
  const env = withDialog();
  const body = env.ul.parentElement;

  assert.ok(env.bar, "必须注入搜索条");
  assert.equal(body.firstElementChild, env.bar, "搜索条应是弹窗正文的第一个子节点");
  assert.equal(body.children.length, 3, "宿主自己的两个子节点必须原样保留（加上我们这一个）");
  assert.equal(env.document.querySelectorAll("li").length, MODELS.length, "候选行一个都不能少");
  assert.equal(env.bar.querySelector(".dms-input").placeholder, "搜索模型（空格分隔多个关键词）");
  assert.equal(env.ul.style.display, "", "列表本身不该被隐藏");
  env.dispose();
});

test("弹窗：autoFocus 打开即聚焦搜索框（且不抢正在打字的输入框）", async () => {
  // 默认选项 autoFocus = true；模拟「点了获取按钮后弹窗打开，焦点还停在按钮上」
  const env = boot({ html: dialogHtml() });
  env.document.body.insertAdjacentHTML("beforeend", '<button id="trigger">获取可用模型</button>');
  env.document.getElementById("trigger").focus();
  env.exports.apply(env.ctx);

  const input = env.document.querySelector('[data-dms-bar="dialog"] .dms-input');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(env.document.activeElement, input, "打开弹窗后焦点应落到搜索框，可以直接打字");

  // 反过来：如果用户正在别的输入框里打字，就不该被抢走
  const env2 = boot({ html: dialogHtml() });
  env2.document.body.insertAdjacentHTML("beforeend", '<input id="typing" type="text">');
  env2.document.getElementById("typing").focus();
  env2.exports.apply(env2.ctx);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(env2.document.activeElement.id, "typing", "用户正在打的输入框不该被抢焦点");

  env.dispose();
  env2.dispose();
});

test("弹窗：默认显示全部，计数正确", () => {
  const env = withDialog();
  assert.equal(visibleTexts(env.ul).length, MODELS.length);
  assert.equal(env.bar.querySelector(".dms-count").textContent, `显示 ${MODELS.length} / ${MODELS.length} · 已选 0`);
  assert.equal(env.bar.querySelector(".dms-actions").hasAttribute("hidden"), true, "没输入关键词时不显示批量按钮");
  env.dispose();
});

test("弹窗：输入 flash 后只剩 4 条，计数与空提示同步", () => {
  const env = withDialog();
  type(env.window, env.input, "flash");

  assert.deepEqual(visibleTexts(env.ul), FLASHES);
  assert.equal(env.bar.querySelector(".dms-count").textContent, `显示 4 / ${MODELS.length} · 已选 0`);
  assert.equal(env.bar.querySelector(".dms-actions").hasAttribute("hidden"), false);
  env.dispose();
});

test("弹窗：多关键词 AND 过滤", () => {
  const env = withDialog();
  type(env.window, env.input, "deepseek v4");
  assert.deepEqual(visibleTexts(env.ul), [
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4-pro",
    "deepseek-v4-pro-reasoning",
  ]);
  env.dispose();
});

test("弹窗：一个都搜不到时提示，并自动尝试模糊匹配", () => {
  const env = withDialog();
  type(env.window, env.input, "zzzz");
  assert.equal(visibleTexts(env.ul).length, 0);
  assert.equal(env.bar.querySelector(".dms-empty").textContent, "没有匹配的模型");
  assert.equal(env.bar.querySelector(".dms-empty").hasAttribute("hidden"), false);

  type(env.window, env.input, "dsv4flash");
  assert.deepEqual(visibleTexts(env.ul), ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
  assert.equal(env.bar.querySelector(".dms-empty").textContent, "模糊匹配");
  assert.equal(env.bar.querySelector(".dms-count").textContent, `显示 2 / ${MODELS.length} · 已选 0`);
  env.dispose();
});

test("弹窗：『选中结果』只勾当前过滤出来的行", () => {
  const env = withDialog();
  type(env.window, env.input, "flash");
  env.bar.querySelector('[data-dms-act="select"]').click();

  const checked = Array.from(env.ul.querySelectorAll("li"))
    .filter((li) => li.querySelector("input").checked)
    .map((li) => li.textContent.trim());
  assert.deepEqual(checked, FLASHES);
  assert.equal(env.bar.querySelector(".dms-count").textContent, `显示 4 / ${MODELS.length} · 已选 4`);

  env.bar.querySelector('[data-dms-act="deselect"]').click();
  assert.equal(env.ul.querySelectorAll("input:checked").length, 0);
  env.dispose();
});

test("弹窗：清空按钮复位过滤，但不影响已勾选", () => {
  const env = withDialog();
  type(env.window, env.input, "flash");
  env.ul.querySelector("input").click();
  env.bar.querySelector(".dms-clear").click();

  assert.equal(env.input.value, "");
  assert.equal(visibleTexts(env.ul).length, MODELS.length);
  assert.equal(env.ul.querySelectorAll("input:checked").length, 1, "已勾选的模型必须保留");
  assert.equal(env.bar.querySelector(".dms-actions").hasAttribute("hidden"), true);
  env.dispose();
});

test("弹窗：回车命中唯一结果时直接勾上", () => {
  const env = withDialog();
  type(env.window, env.input, "community/model-042");
  assert.equal(visibleTexts(env.ul).length, 1);
  press(env.window, env.input, "Enter");
  assert.equal(env.ul.querySelectorAll("input:checked").length, 1);
  assert.equal(env.ul.querySelector('input[type="checkbox"]').checked, false, "第一条不该被误勾");
  env.dispose();
});

test("弹窗：Esc 清空输入且不冒泡（宿主弹窗不会被顺带关掉）", () => {
  const env = withDialog();
  let bubbled = false;
  env.document.addEventListener("keydown", () => {
    bubbled = true;
  });

  type(env.window, env.input, "flash");
  press(env.window, env.input, "Escape");
  assert.equal(env.input.value, "", "Esc 应清空搜索内容");
  assert.equal(bubbled, false, "有内容时 Esc 必须拦在搜索框内");
  assert.equal(visibleTexts(env.ul).length, MODELS.length);

  bubbled = false;
  press(env.window, env.input, "Escape");
  assert.equal(bubbled, true, "搜索框已空时 Esc 应放行，让宿主自己处理（关弹窗）");
  env.dispose();
});

test("弹窗：↑↓ 在结果之间移动焦点", () => {
  const env = withDialog();
  type(env.window, env.input, "flash");
  press(env.window, env.input, "ArrowDown");
  assert.equal(env.document.activeElement.closest("li").textContent.trim(), FLASHES[0]);

  press(env.window, env.document.activeElement, "ArrowDown");
  assert.equal(env.document.activeElement.closest("li").textContent.trim(), FLASHES[1]);

  press(env.window, env.document.activeElement, "ArrowUp");
  assert.equal(env.document.activeElement.closest("li").textContent.trim(), FLASHES[0]);
  env.dispose();
});

test("弹窗：候选列表被宿主移除后，控制器跟着卸载", async () => {
  const env = withDialog();
  assert.equal(env.internals.mounted.size, 1);

  env.document.querySelector('[role="dialog"]').remove();
  await settle();
  assert.equal(env.internals.mounted.size, 0, "宿主弹窗关闭后不能留下悬挂的控制器");
  env.dispose();
});

test("弹窗：模型太少（< minItems）时不打扰用户", () => {
  const env = withDialog({ models: ["a", "b", "c"] });
  assert.equal(env.document.querySelector('[data-dms-bar="dialog"]'), null);
  env.dispose();
});

test("弹窗：minItems 可由选项调整", () => {
  const env = withDialog({ models: ["a", "b", "c"], options: { minItems: 2 } });
  assert.ok(env.document.querySelector('[data-dms-bar="dialog"]'));
  env.dispose();
});

test("弹窗：英文界面用英文文案（语言跟着界面走）", () => {
  const env = withDialog({ lang: "en" });
  assert.equal(env.bar.querySelector(".dms-input").placeholder, "Search models (space separates keywords)");
  env.dispose();
});

test("菜单：模型菜单挂上搜索框，过滤后隐藏空分组", () => {
  const env = boot({
    html: menuHtml([
      { name: "lingsuan", models: MODELS.slice(0, 60) },
      { name: "deepseek-official", models: ["deepseek-chat", "deepseek-reasoner"] },
    ]),
  });
  env.window.localStorage.setItem("dsh-model-search:options", JSON.stringify({ autoFocus: false }));
  env.exports.apply(env.ctx);

  const menu = env.document.querySelector('div[role="menu"]');
  const bar = menu.querySelector('[data-dms-bar="menu"]');
  assert.ok(bar, "菜单里也要有搜索框");
  assert.equal(menu.firstElementChild, bar);

  const input = bar.querySelector(".dms-input");
  type(env.window, input, "flash");

  const visible = (selector) => Array.from(menu.querySelectorAll(selector)).filter((n) => n.style.display !== "none");
  assert.deepEqual(
    visible('button[role="menuitemradio"]').map((n) => n.textContent.trim()),
    FLASHES,
  );
  assert.equal(visible('section[role="group"]').length, 1, "没有命中的分组要整体隐藏");
  assert.equal(bar.querySelector(".dms-count").textContent, `显示 4 / 62`);
  env.dispose();
});

test("菜单：切到别的面板（分组消失）后自动撤掉搜索框", async () => {
  const env = boot({ html: menuHtml([{ name: "p", models: MODELS.slice(0, 30) }]) });
  env.window.localStorage.setItem("dsh-model-search:options", JSON.stringify({ autoFocus: false }));
  env.exports.apply(env.ctx);
  const menu = env.document.querySelector('div[role="menu"]');
  assert.ok(menu.querySelector('[data-dms-bar="menu"]'));

  menu.querySelector(".groups").innerHTML = '<button type="button" role="menuitem">返回</button>';
  await settle();
  assert.equal(menu.querySelector('[data-dms-bar="menu"]'), null, "面板切走后搜索框必须撤掉");
  assert.equal(env.document.querySelectorAll('[role="menuitem"]').length, 1, "宿主自己的项不能被动过");
  env.dispose();
});

test("控制台开关：dshModelSearch.set({ dialog: false }) 立即生效", () => {
  const env = withDialog();
  assert.ok(env.document.querySelector('[data-dms-bar="dialog"]'));
  assert.equal(typeof env.window.dshModelSearch.set, "function");

  env.window.dshModelSearch.set({ dialog: false });
  assert.equal(env.document.querySelector('[data-dms-bar="dialog"]'), null);
  assert.equal(JSON.parse(env.window.localStorage.getItem("dsh-model-search:options")).dialog, false);

  env.window.dshModelSearch.reset();
  assert.ok(env.document.querySelector('[data-dms-bar="dialog"]'), "恢复默认后搜索框应回来");
  env.dispose();
});

test("卸载：ctx 释放后搜索框、控制台开关与观察器一起撤走", async () => {
  const env = withDialog();
  assert.ok(env.document.querySelector('[data-dms-bar="dialog"]'));

  env.dispose();
  assert.equal(env.document.querySelector('[data-dms-bar="dialog"]'), null);
  assert.equal(env.window.dshModelSearch, undefined, "控制台开关应随插件卸载一起消失");
  assert.equal(env.internals.mounted.size, 0, "不能留下悬挂的控制器");
});

test("样式：只注入一次，并带上插件标识", () => {
  const env = withDialog();
  env.exports.apply(env.ctx);
  const tags = env.document.querySelectorAll('style[data-plugin="dsh-model-search"]');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].dataset.pluginCss, "dsh-model-search/styles.css");
  assert.ok(tags[0].textContent.includes(".dms-input"));
  env.dispose();
});

test("运行期不产生任何报错/警告", async () => {
  const env = withDialog();
  type(env.window, env.input, "flash");
  env.bar.querySelector('[data-dms-act="select"]').click();
  env.bar.querySelector('[data-dms-act="deselect"]').click();
  await settle();
  // 只看插件自己发出的声音：jsdom 对现代 CSS 的解析告警与本插件无关。
  const noisy = env.messages.filter((line) => line.startsWith("warn:") || line.startsWith("error:"));
  assert.deepEqual(noisy, []);
  env.dispose();
});
