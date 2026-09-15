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

const PROVIDERS = [
  { name: "DeepSeek 官方", models: ["deepseek-chat", "deepseek-reasoner"] },
  {
    name: "lingsuan",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5.3-flash",
      "qwen3.8-flash",
      "gpt-5.5",
      "claude-sonnet-4.5",
    ],
  },
  { name: "chatanywhere", models: MODELS.slice(0, 20) },
];

/** 起一个世界 + 模型菜单夹具，并跑一遍 apply。 */
function withMenu(groups = PROVIDERS, options = {}, { markChecked = null, html = null } = {}) {
  const env = boot({ html: html ?? menuHtml(groups) });
  if (markChecked !== null) {
    const section = Array.from(env.document.querySelectorAll('section[role="group"]')).find(
      (node) => node.querySelector(".groupTitle").textContent.trim() === markChecked.provider,
    );
    const buttons = Array.from(section.querySelectorAll('button[role="menuitemradio"]'));
    buttons[markChecked.index ?? 0].setAttribute("aria-checked", "true");
  }
  env.window.localStorage.setItem("dsh-model-search:options", JSON.stringify({ autoFocus: false, ...options }));
  env.exports.apply(env.ctx);
  const menu = env.document.querySelector('div[role="menu"]');
  // 复刻宿主的 onBlur：焦点一旦落到菜单外面，它就把整个菜单关掉。
  // （宿主用的是 React onBlur，也就是冒泡的 focusout；这里手写一份等价监听。）
  const host = { closed: false };
  menu.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next instanceof env.window.Node && menu.contains(next)) return;
    host.closed = true;
  });
  return {
    ...env,
    host,
    menu,
    bar: menu.querySelector('[data-dms-bar="menu"]'),
    vendors: menu.querySelector("[data-dms-vendors]"),
    models: menu.querySelector("[data-dms-models]"),
    split: menu.querySelector("[data-dms-split]"),
    legacy: menu.querySelector("[data-dms-legacy]"),
    groupsEl: menu.querySelector(".groups"),
  };
}

const vendorNames = (env) =>
  Array.from(env.vendors.querySelectorAll(".dms-vendor")).map((b) =>
    b.querySelector(".dms-vendorName").textContent.trim(),
  );
const activeVendor = (env) =>
  env.vendors.querySelector(".dms-vendorOn")?.querySelector(".dms-vendorName")?.textContent.trim() ?? null;
const modelRows = (env) =>
  Array.from(env.models.querySelectorAll(".dms-option")).map((b) =>
    b.querySelector(".dms-optionLabel").textContent.trim(),
  );
const familyHeads = (env) =>
  Array.from(env.models.querySelectorAll("[data-dms-grouphead]")).map((n) => n.textContent.trim());

test("菜单：一打开就是两栏——左栏线路、右栏该线路的模型", () => {
  const env = withMenu(PROVIDERS, {}, { markChecked: { provider: "lingsuan", index: 1 } });
  assert.ok(env.bar, "菜单里要有搜索框");
  assert.equal(env.split.hasAttribute("hidden"), false, "两栏容器要出现");
  assert.equal(env.legacy.hasAttribute("hidden"), true);
  assert.deepEqual(vendorNames(env), ["DeepSeek 官方", "lingsuan", "chatanywhere"]);
  assert.equal(activeVendor(env), "lingsuan", "默认落在当前模型所在的线路");
  assert.equal(env.groupsEl.style.display, "none", "宿主自己那份列表始终不露面");
  assert.equal(env.bar.querySelector(".dms-input").placeholder, "搜索线路或模型名（空格分隔）");
  env.dispose();
});

test("菜单：左栏线路带条数，选中项高亮，当前线路有标记", () => {
  const env = withMenu();
  const metas = Array.from(env.vendors.querySelectorAll(".dms-vendor")).map((b) =>
    b.querySelector(".dms-vendorMeta").textContent.trim(),
  );
  assert.deepEqual(metas, ["2", "6", "20"]);
  assert.equal(activeVendor(env), "DeepSeek 官方", "没有当前模型时退回第一条线路");
  assert.equal(env.vendors.querySelector(".dms-vendorOn").getAttribute("aria-pressed"), "true");
  assert.equal(env.vendors.querySelectorAll('[aria-pressed="true"]').length, 1);
  env.dispose();
});

test("菜单：点线路时焦点必须还在那颗按钮上（否则宿主会以为点到外面，把菜单关掉）", () => {
  const env = withMenu();
  const button = Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1];

  // 真人点击：mousedown 先把焦点给按钮，然后才派发 click
  button.focus();
  assert.equal(env.document.activeElement, button, "前置条件：按钮拿到了焦点");
  button.click();

  assert.equal(env.document.activeElement, button, "重绘后焦点不能丢（节点必须被复用）");
  assert.equal(env.host.closed, false, "宿主绝不能因此关掉菜单");
  assert.equal(activeVendor(env), "lingsuan");
  assert.equal(env.vendors.isConnected, true);
  env.dispose();
});

test("菜单：拖动/连续切换线路时焦点一直留在左栏", () => {
  const env = withMenu();
  const buttons = Array.from(env.vendors.querySelectorAll(".dms-vendor"));
  for (const index of [1, 2, 0, 1]) {
    const button = Array.from(env.vendors.querySelectorAll(".dms-vendor"))[index];
    button.focus();
    button.click();
    assert.equal(env.document.activeElement, button, `第 ${index} 条线路：焦点不该丢`);
    assert.equal(env.host.closed, false, `第 ${index} 条线路：菜单不该被关掉`);
  }
  env.dispose();
});

test("菜单：节点按名字复用，不会因为重绘重建（否则焦点必然丢）", () => {
  const env = withMenu();
  const before = Array.from(env.vendors.querySelectorAll(".dms-vendor"))[0];
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();
  const after = env.vendors.querySelector('[data-dms-provider="DeepSeek 官方"]');
  assert.equal(after, before, "同一线路必须是同一个 DOM 节点");
  env.dispose();
});

test("菜单：搜索把某条线路筛掉后，它才从 DOM 里消失", () => {
  const env = withMenu();
  type(env.window, env.bar.querySelector(".dms-input"), "flash");
  assert.equal(vendorNames(env).includes("DeepSeek 官方"), false);
  assert.equal(env.vendors.querySelector('[data-dms-provider="DeepSeek 官方"]'), null);
  type(env.window, env.bar.querySelector(".dms-input"), "");
  assert.deepEqual(vendorNames(env), ["DeepSeek 官方", "lingsuan", "chatanywhere"], "清空搜索后回来");
  env.dispose();
});

test("菜单：点另一条线路，右栏换成它的模型（左栏原地不动）", () => {
  const env = withMenu();
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();

  assert.equal(activeVendor(env), "lingsuan");
  assert.deepEqual(vendorNames(env), ["DeepSeek 官方", "lingsuan", "chatanywhere"], "左栏不能消失");
  // 右栏是按家族重排过的：DeepSeek → GPT → Claude → Qwen → GLM
  assert.deepEqual(modelRows(env), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "gpt-5.5",
    "claude-sonnet-4.5",
    "qwen3.8-flash",
    "glm-5.3-flash",
  ]);
  assert.equal(env.bar.querySelector(".dms-count").textContent, "显示 6 / 6");
  env.dispose();
});

test("菜单：右栏按家族分组（DeepSeek / GPT / Claude / Qwen / GLM / 其他）", () => {
  const env = withMenu();
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();

  assert.deepEqual(familyHeads(env), ["DeepSeek2", "GPT1", "Claude1", "Qwen1", "GLM1"]);
  assert.equal(env.models.querySelectorAll("[data-dms-grouphead]").length, 5);
  assert.equal(env.models.querySelector('[data-dms-grouphead="DeepSeek"]') !== null, true);
  env.dispose();
});

test("菜单：宿主没给出可辨识家族时归入「其他」，且永远排在最后", () => {
  const env = withMenu([
    {
      name: "relay",
      models: [
        "mystery-model-a",
        "gpt-5.5",
        "deepseek-v4-pro",
        "mystery-model-b",
        "mystery-model-c",
        "mystery-model-d",
        "mystery-model-e",
        "mystery-model-f",
      ],
    },
  ]);
  assert.deepEqual(familyHeads(env), ["DeepSeek1", "GPT1", "其他6"]);
  env.dispose();
});

test("菜单：点模型行 = 点宿主的那个按钮（选择仍然只有宿主一条路径）", () => {
  const env = withMenu();
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();
  const hostButtons = Array.from(env.menu.querySelectorAll('section[role="group"] button[role="menuitemradio"]'));
  const clicked = [];
  for (const button of hostButtons) button.addEventListener("click", () => clicked.push(button.textContent.trim()));

  const row = Array.from(env.models.querySelectorAll(".dms-option"))[2];
  const label = row.querySelector(".dms-optionLabel").textContent.trim();
  row.click();
  assert.deepEqual(clicked, [label], "点右栏某一行 → 宿主对应那颗按钮被点到");
  env.dispose();
});

test("菜单：当前模型在右栏打勾", () => {
  const env = withMenu(PROVIDERS, {}, { markChecked: { provider: "lingsuan", index: 0 } });
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();
  const row = env.models.querySelector(".dms-optionOn");
  assert.equal(row.querySelector(".dms-optionLabel").textContent.trim(), "deepseek-v4-flash");
  assert.equal(row.getAttribute("aria-selected"), "true");
  assert.equal(env.models.querySelectorAll(".dms-optionOn").length, 1);
  env.dispose();
});

test("菜单：搜索同时筛两栏，跨线路时可切到「所有线路」", () => {
  const env = withMenu();
  type(env.window, env.bar.querySelector(".dms-input"), "flash");

  assert.deepEqual(vendorNames(env), ["所有线路", "lingsuan", "chatanywhere"]);
  assert.equal(env.bar.querySelector(".dms-count").textContent, "显示 3 / 6", "右栏跟着过滤");

  env.vendors.querySelector('[data-dms-provider="*"]').click();
  assert.equal(activeVendor(env), "所有线路");
  const heads = Array.from(env.models.querySelectorAll(".dms-providerHead")).map((n) => n.textContent.trim());
  assert.deepEqual(heads, ["lingsuan3", "chatanywhere4"], "跨线路时按线路分块");
  assert.deepEqual(familyHeads(env).slice(0, 3), ["DeepSeek1", "Qwen1", "GLM1"], "线路内部再按家族分");
  env.dispose();
});

test("菜单：搜不到时右栏给提示，且不误伤左栏", () => {
  const env = withMenu();
  type(env.window, env.bar.querySelector(".dms-input"), "zzzz");
  assert.equal(env.models.querySelectorAll(".dms-option").length, 0);
  assert.equal(env.bar.querySelector(".dms-empty").textContent, "没有匹配的模型");
  assert.equal(env.vendors.querySelectorAll(".dms-vendor").length, 0, "左栏也没有命中");
  env.dispose();
});

test("菜单：Esc 先清空搜索，再退出「所有线路」，最后才让宿主关菜单", () => {
  const env = withMenu();
  let bubbled = 0;
  env.document.addEventListener("keydown", () => {
    bubbled += 1;
  });
  const input = env.bar.querySelector(".dms-input");
  Array.from(env.vendors.querySelectorAll(".dms-vendor"))[1].click();
  assert.equal(activeVendor(env), "lingsuan");
  type(env.window, input, "flash");
  env.vendors.querySelector('[data-dms-provider="*"]').click();

  press(env.window, input, "Escape");
  assert.equal(input.value, "");
  assert.equal(bubbled, 0);
  assert.equal(activeVendor(env), "所有线路", "清空搜索不该顺手退出所有线路");

  press(env.window, input, "Escape");
  assert.equal(activeVendor(env), "lingsuan", "再按一次退回单条线路");
  assert.equal(bubbled, 0);

  press(env.window, input, "Escape");
  assert.equal(bubbled, 1, "已经没什么可退的了，放行给宿主");
  env.dispose();
});

test("菜单：只有一条线路时照样两栏，不折腾用户", () => {
  const env = withMenu([{ name: "lingsuan", models: MODELS.slice(0, 12) }]);
  assert.deepEqual(vendorNames(env), ["lingsuan"]);
  assert.equal(activeVendor(env), "lingsuan");
  assert.equal(modelRows(env).length, 12);
  env.dispose();
});

test("菜单：drilldown: false 退回老的一栏列表", () => {
  const env = withMenu(PROVIDERS, { drilldown: false });
  assert.equal(env.split.hasAttribute("hidden"), true);
  assert.equal(env.legacy.hasAttribute("hidden"), false);
  assert.equal(env.vendors.children.length, 0);
  assert.equal(env.groupsEl.style.display, "none", "老模式也是我们画，宿主那份照样藏着");
  assert.equal(env.legacy.querySelectorAll(".dms-option").length, 28);
  assert.deepEqual(
    Array.from(env.legacy.querySelectorAll(".dms-providerHead")).map((n) => n.textContent.trim()),
    ["DeepSeek 官方2", "lingsuan6", "chatanywhere20"],
  );

  type(env.window, env.bar.querySelector(".dms-input"), "flash");
  assert.equal(env.legacy.querySelectorAll(".dms-option").length, 7);
  env.dispose();
});

test("菜单：不同线路里的同名模型各占一行，不会互相顶掉", () => {
  // 夹具里 chatanywhere 的模型列表和 DeepSeek 官方有重名（deepseek-chat / deepseek-reasoner）
  const env = withMenu(PROVIDERS, { drilldown: false });
  const rows = Array.from(env.legacy.querySelectorAll(".dms-option")).map((n) =>
    n.querySelector(".dms-optionLabel").textContent.trim(),
  );
  const total = PROVIDERS.reduce((sum, provider) => sum + provider.models.length, 0);
  assert.equal(rows.length, total, "每个模型都要有自己的行");
  assert.equal(rows.filter((label) => label === "deepseek-chat").length, 2, "同名模型出现两次才对");
  env.dispose();
});

test("菜单：切到别的面板（分组消失）后自动撤掉注入的所有节点", async () => {
  const env = withMenu();
  assert.ok(env.menu.querySelector('[data-dms-bar="menu"]'));

  env.groupsEl.innerHTML = '<button type="button" role="menuitem">返回</button>';
  await settle();
  assert.equal(env.menu.querySelector('[data-dms-bar="menu"]'), null);
  assert.equal(env.menu.querySelector("[data-dms-split]"), null);
  assert.equal(env.menu.querySelectorAll('[role="menuitem"]').length, 1, "宿主自己的项不能被动过");
  env.dispose();
});

test("菜单：模型少于 minItems 时完全不介入", () => {
  const env = withMenu([{ name: "small", models: ["a", "b", "c"] }]);
  assert.equal(env.menu.querySelector('[data-dms-bar="menu"]'), null);
  assert.equal(env.groupsEl.style.display, "", "宿主的列表不能被我们藏起来");
  env.dispose();
});

test("菜单：宿主刚插入菜单的同一批微任务里就被接管（用户看不到原始列表）", async () => {
  const env = boot();
  env.window.localStorage.setItem("dsh-model-search:options", JSON.stringify({ autoFocus: false }));
  env.exports.apply(env.ctx);
  assert.equal(env.document.querySelector("div[role=menu]"), null);

  // 模拟「点了模型选择器」：宿主把菜单插进 DOM
  env.document.body.insertAdjacentHTML("beforeend", menuHtml(PROVIDERS));
  assert.equal(env.document.querySelector("[data-dms-split]"), null, "插入的瞬间我们还没动手");

  // 只推进微任务（不睡 80ms 的节流扫描）
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  assert.ok(env.document.querySelector("[data-dms-split]"), "观察器回调里必须已经接管");
  assert.equal(env.document.querySelector(".groups").style.display, "none", "宿主的原始列表同帧被收起");
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
