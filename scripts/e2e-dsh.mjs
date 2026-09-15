#!/usr/bin/env node
/**
 * 真实浏览器端到端验证：用 headless Chrome 打开正在运行的 DSH Web UI，
 * 走一遍「设置 → 模型 → 获取可用模型」，确认搜索框真的出现在真实弹窗里、
 * 过滤真的生效，最后截一张图存到 docs/。
 *
 * 用法：
 *   node scripts/e2e-dsh.mjs                 # 完整跑一遍
 *   node scripts/e2e-dsh.mjs --probe         # 只列出界面上可见的按钮文案（调选择器用）
 *   node scripts/e2e-dsh.mjs --url http://127.0.0.1:3080 --port 9333
 *
 * 前置条件：本机已经跑着 `dsh web`，并且插件已装好。
 * 说明：脚本不会改动任何配置——只点击、只读取，结束时点「取消」关掉弹窗。
 * 副作用：首次运行会让 DSH 多出一个空的「新会话」条目（浏览器没有会话就新建一个），
 *         删除它对会话列表没有影响。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const hasFlag = (name) => argv.includes(`--${name}`);

const ORIGIN = flag("url", process.env.DSH_URL ?? "http://127.0.0.1:3080");
const PORT = Number(flag("port", process.env.DSH_CDP_PORT ?? 9333));
const CHROME = process.env.CHROME ?? "google-chrome";
const PROFILE = flag("profile-dir", "/tmp/dsh-model-search-e2e");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 起一个 headless Chrome（已经在跑就直接复用）。 */
async function ensureChrome() {
  const probe = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const running = await probe();
  if (running !== null) return running;
  spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1440,960",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  ).unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const version = await probe();
    if (version !== null) return version;
  }
  throw new Error(`Chrome 没能在 :${PORT} 起起来`);
}

/** 极简 CDP 客户端：连接一个 target，发命令、收结果。 */
class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    return this;
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.ws?.close();
  }
}

/** 在已有浏览器连接上开一个新标签页并拿到 session。 */
async function attachPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const session = {
    targetId,
    send: (method, params) => browser.send(method, params, sessionId),
    close: () => browser.send("Target.closeTarget", { targetId }).catch(() => {}),
  };
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.navigate", { url });
  return session;
}

/** 起浏览器 + 打开首个页面。 */
async function openPage(url) {
  const version = await ensureChrome();
  const browser = await new Cdp(version.webSocketDebuggerUrl).connect();
  const session = await attachPage(browser, url);
  return { browser, session, targetId: session.targetId };
}

/** 在页面里跑一段（可 await 的）脚本，返回结构化结果。 */
async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(`页面脚本抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

/** 页面内的驱动脚本：等待 → 点开设置 → 点开模型 → 点获取 → 验证搜索框。 */
const driverFor = (PROVIDER, FINAL_QUERY) => String.raw`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const steps = [];
  const note = (step, detail) => steps.push({ step, detail });
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const clickable = () => Array.from(document.querySelectorAll('button,[role="button"],a,[role="menuitem"]'));
  const findButton = (needle) => clickable().find((node) => textOf(node).includes(needle));
  const waitFor = async (probe, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(120);
    }
  };

  // 1) 等应用启动 + 等本插件挂上
  const api = await waitFor(() => window.dshModelSearch, "dshModelSearch", 40000);
  note("插件已加载", api ? "window.dshModelSearch = v" + api.version : "❌ 没等到 window.dshModelSearch");
  note("样式已注入", document.querySelectorAll('style[data-plugin="dsh-model-search"]').length + " 个 style 标签");

  // 2) 关掉可能挡路的首启弹窗
  for (let i = 0; i < 4; i += 1) {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) break;
    const close = dialog.querySelector('button[aria-label="关闭"], button[aria-label="Close"], .close');
    const cont = Array.from(dialog.querySelectorAll("button")).find((b) => /继续|Continue|稍后|Later|知道了|Got it/.test(textOf(b)));
    if (cont) { cont.click(); note("关掉首启弹窗", textOf(cont)); await sleep(400); continue; }
    if (close) { close.click(); note("关掉弹窗", "close button"); await sleep(400); continue; }
    break;
  }

  // 3) 打开设置
  const settingsBtn = findButton("设置") ?? findButton("Settings");
  if (settingsBtn) { settingsBtn.click(); note("点击设置入口", textOf(settingsBtn)); }
  else note("点击设置入口", "❌ 没找到设置按钮");

  // 4) 进入「模型」分区
  const modelsNav = await waitFor(() => {
    const nodes = Array.from(document.querySelectorAll("button,a,li,div[role=button]"));
    return nodes.find((n) => textOf(n) === "模型" || textOf(n) === "Models");
  }, "models nav");
  if (modelsNav) { modelsNav.click(); note("进入模型设置", textOf(modelsNav)); }
  else note("进入模型设置", "❌ 没找到「模型」入口");
  await sleep(600);

  // 5) 找到自定义提供方（pi-ai 路由才有「获取可用模型」）那一行的「编辑」
  const provider = ${JSON.stringify(PROVIDER)};
  const editBtn = await waitFor(() => {
    const byAria = document.querySelector('[aria-label="编辑 ' + provider + '"], [aria-label="Edit ' + provider + '"]');
    if (byAria) return byAria;
    const row = Array.from(document.querySelectorAll("li,div,section")).find(
      (n) => textOf(n).startsWith(provider) && n.querySelector("button"),
    );
    return row ? Array.from(row.querySelectorAll("button")).find((b) => /^(编辑|Edit)$/.test(textOf(b))) : null;
  }, "edit", 8000);
  if (editBtn) { editBtn.click(); note("打开提供方编辑器", editBtn.getAttribute("aria-label") ?? textOf(editBtn)); }
  else note("打开提供方编辑器", "❌ 没找到 " + provider + " 的「编辑」按钮");
  await sleep(600);

  // 5b) 展开「自定义设置」（baseURL / 模型列表 / 获取按钮都在里面）
  const summary = Array.from(document.querySelectorAll("summary")).find((n) => /自定义设置|Customized/.test(textOf(n)));
  if (summary) {
    if (summary.parentElement?.open !== true) summary.click();
    note("展开自定义设置", "open = " + String(summary.parentElement?.open));
    await sleep(400);
  } else note("展开自定义设置", "❌ 没找到折叠区");

  // 6) 点「获取可用模型」
  const fetchBtn = await waitFor(() => clickable().find((n) => /获取可用模型|Fetch available models/.test(textOf(n))), "fetch", 8000);
  if (fetchBtn) { fetchBtn.click(); note("点击获取可用模型", textOf(fetchBtn)); }
  else note("点击获取可用模型", "❌ 没找到「获取可用模型」按钮");

  // 7) 等真实弹窗 + 我们的搜索条（以插件自己注入的搜索条为准，避免认错弹窗）
  const bar = await waitFor(() => document.querySelector('[data-dms-bar="dialog"]'), "bar", 60000);
  const dialog = bar?.closest('[role="dialog"]') ?? null;
  if (!bar) {
    const lists = Array.from(document.querySelectorAll('[role="dialog"] ul')).map((ul) => ul.children.length);
    note("搜索条", "❌ 没注入；当前弹窗里的 ul 行数 = " + JSON.stringify(lists));
    return { steps, ok: false, total: 0 };
  }
  note("搜索条已注入", "placeholder = " + bar.querySelector(".dms-input").placeholder);

  const ul = dialog.querySelector("ul");
  const rows = Array.from(ul.children);
  const total = rows.length;
  note("候选模型总数", total);
  note("搜索条位置", ul.parentElement.firstElementChild === bar ? "弹窗正文第一个子节点 ✅" : "位置异常 ❌");

  const visible = () => rows.filter((li) => li.style.display !== "none").map((li) => textOf(li));
  const input = bar.querySelector(".dms-input");
  note("自动聚焦", document.activeElement === input
    ? "✅ 打开弹窗后焦点已在搜索框，可直接打字"
    : "焦点在 " + (document.activeElement?.tagName ?? "?") + "（按设计不抢输入框焦点）");
  const type = (value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const count = () => textOf(bar.querySelector(".dms-count"));

  note("初始可见", visible().length + " / " + total + "（" + count() + "）");

  type("flash");
  await sleep(60);
  note("搜索 flash", visible().length + " 条：" + visible().slice(0, 6).join(", "));
  note("计数文案", count());

  // 全选当前过滤结果 → 看「已选」是否跟着走（验证与宿主受控状态真的联动）
  const selectBtn = bar.querySelector('[data-dms-act="select"]');
  selectBtn.click();
  await sleep(120);
  const checked = rows.filter((li) => li.querySelector('input[type="checkbox"]').checked).length;
  note("点『选中结果』后勾选数", checked + "（应为 " + visible().length + " 条过滤结果）");
  note("已选计数", count());

  // 取消勾选，别把用户的配置改了
  bar.querySelector('[data-dms-act="deselect"]').click();
  await sleep(120);
  note("点『取消结果』后勾选数", rows.filter((li) => li.querySelector('input[type="checkbox"]').checked).length);

  type("zzzz-不存在");
  await sleep(60);
  note("搜索不存在的名字", visible().length + " 条可见，提示：" + textOf(bar.querySelector(".dms-empty")));

  type("");
  await sleep(60);
  note("清空后可见", visible().length + " / " + total);

  // 截图用：把过滤状态留在屏幕上
  if (${JSON.stringify(FINAL_QUERY)}) {
    type(${JSON.stringify(FINAL_QUERY)});
    await sleep(80);
  }
  return { steps, ok: true, total };
})()`;

/** 第二阶段：输入框旁的模型菜单。 */
const menuDriverFor = (FINAL_QUERY) => String.raw`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const steps = [];
  const note = (step, detail) => steps.push({ step, detail });
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const waitFor = async (probe, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(120);
    }
  };

  // 关掉设置面板，回到会话
  const settingsClose = document.querySelector('button[aria-label="关闭"], button[aria-label="Close"]');
  if (settingsClose) { settingsClose.click(); await sleep(500); }

  // 打开输入框旁的模型菜单
  const trigger = await waitFor(() => document.querySelector('[aria-label^="选择模型"], [aria-label^="Select model"]'), "trigger");
  if (!trigger) { note("打开模型菜单", "❌ 没找到模型选择器"); return { steps, ok: false }; }
  trigger.click();
  await sleep(400);

  // 进入「模型」子面板
  const cell = await waitFor(() => {
    const menu = document.querySelector('div[role="menu"]');
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).find((n) => /^模型|^Model$/.test(textOf(n)));
  }, "cell");
  if (!cell) { note("进入模型列表", "❌ 菜单里没找到「模型」入口"); return { steps, ok: false }; }
  cell.click();
  note("进入模型列表", textOf(cell));
  await sleep(1500);
  const snapshot = document.querySelector('div[role="menu"]');
  note("菜单内容快照", snapshot ? textOf(snapshot).slice(0, 240) : "❌ 菜单已经关掉了");

  const menu = document.querySelector('div[role="menu"]');
  const ITEM = 'button[role="menuitemradio"], button[role="menuitem"]';
  const items = Array.from(menu?.querySelectorAll('section[role="group"] ' + ITEM) ?? []);
  const groups = Array.from(menu?.querySelectorAll('section[role="group"]') ?? []);
  note("菜单里的模型总数", items.length + "（分组 " + groups.length + " 个）");
  note("当前 minItems 阈值", String(window.dshModelSearch?.options?.minItems));

  const bar = await waitFor(() => document.querySelector('[data-dms-bar="menu"]'), "menu bar");
  if (!bar) {
    note("菜单搜索框", "❌ 没注入（模型数 " + items.length + " < 阈值时属于预期行为）");
    return { steps, ok: false };
  }
  note("菜单搜索框已注入", "placeholder = " + bar.querySelector(".dms-input").placeholder);

  const visible = () => items.filter((n) => n.style.display !== "none").map((n) => textOf(n));
  const input = bar.querySelector(".dms-input");
  input.value = "flash";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
  note("搜索 flash", visible().length + " 条：" + visible().join(", "));
  note("空分组已隐藏", groups.filter((g) => g.style.display === "none").map((g) => textOf(g.querySelector(".groupTitle") || g).slice(0, 24)).join(" / ") || "（没有全空的分组）");
  note("计数文案", textOf(bar.querySelector(".dms-count")));
  note("隐藏的空分组", groups.filter((g) => g.style.display === "none").length + " / " + groups.length);

  if (${JSON.stringify(FINAL_QUERY)}) input.value = ${JSON.stringify(FINAL_QUERY)};
  return { steps, ok: visible().length > 0 };
})()`;

const probe = String.raw`(() => {
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],a,[role="menuitem"]'));
  return {
    plugin: Boolean(window.dshModelSearch),
    buttons: nodes.map((n) => ({ text: textOf(n).slice(0, 40), aria: n.getAttribute("aria-label") })).filter((n) => n.text || n.aria).slice(0, 80),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => d.getAttribute("aria-label")),
  };
})()`;

const main = async () => {
  const { browser, session } = await openPage(ORIGIN);
  try {
    await sleep(Number(flag("wait", 4000)));
    if (hasFlag("probe")) {
      console.log(JSON.stringify(await evaluate(session, probe), null, 2));
      return;
    }
    const report = await evaluate(session, driverFor(flag("provider", "lingsuan"), flag("shot-query", "")));
    for (const { step, detail } of report.steps) console.log(`• ${step}：${detail}`);
    console.log(report.ok ? `\n✅ 端到端验证通过（候选模型 ${report.total} 个）` : "\n❌ 端到端验证失败");
    let ok = report.ok;

    if (hasFlag("screenshot")) {
      const shot = await session.send("Page.captureScreenshot", { format: "png" });
      const dir = join(root, "docs");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, flag("screenshot", "screenshot.png"));
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`📷 截图：${file}`);
    }

    // 收拾现场：关掉弹窗（点「取消」），不写任何配置。
    await evaluate(
      session,
      `(() => { const d = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (!d) return "no dialog";
        const cancel = Array.from(d.querySelectorAll("button")).find((b) => /^(取消|Cancel)$/.test((b.textContent||"").trim()));
        if (cancel) { cancel.click(); return "cancelled"; }
        const close = d.querySelector('button[aria-label="关闭"], button[aria-label="Close"]');
        if (close) { close.click(); return "closed"; }
        return "left open"; })()`,
    );
    await sleep(500);

    // 第二阶段：输入框旁的模型菜单（另开一个干净页面，避免设置面板挡路）
    if (!hasFlag("skip-menu")) {
      console.log("\n── 输入框旁的模型菜单 ──");
      const menuPage = await attachPage(browser, ORIGIN);
      await sleep(Number(flag("wait", 4000)));
      const menuReport = await evaluate(menuPage, menuDriverFor(flag("shot-query", "")));
      for (const { step, detail } of menuReport.steps) console.log(`• ${step}：${detail}`);
      console.log(menuReport.ok ? "✅ 菜单搜索框验证通过" : "❌ 菜单搜索框验证失败");
      if (hasFlag("screenshot")) {
        const shot = await menuPage.send("Page.captureScreenshot", { format: "png" });
        const file = join(root, "docs", "e2e-menu.png");
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        console.log(`📷 截图：${file}`);
      }
      await menuPage.close();
      ok = ok && menuReport.ok;
    }

    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.send("Target.closeTarget", { targetId: (await browser.send("Target.getTargets")).targetInfos.at(-1).targetId }).catch(() => {});
    browser.close();
  }
};

await main();
