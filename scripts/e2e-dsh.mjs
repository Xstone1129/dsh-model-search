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
 * 副作用：
 *   1. 首次运行会让 DSH 多出一个空的「新会话」条目（浏览器没有会话就新建一个），
 *      删除它对会话列表没有影响。
 *   2. 拖动推理强度那一步会真的改设置：空会话上选模型/档位会写进 `settings.yaml`
 *      的 `agent-default-model`。脚本结束会把档位还原成开始时读到的那个；
 *      不想让它碰设置就加 `--skip-effort`。
 *
 * 额外模式：`--set-effort High` 只做一件事——把推理强度拖到指定档位（维护用）。
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

/** 第二阶段：模型菜单的两级选择 + 推理强度能量条。 */
const menuDriverFor = (SKIP_EFFORT, ONLY_EFFORT) => String.raw`(async () => {
  const SKIP_EFFORT = ${JSON.stringify(SKIP_EFFORT)};
  const ONLY_EFFORT = ${JSON.stringify(ONLY_EFFORT)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const steps = [];
  const note = (step, detail) => steps.push({ step, detail });
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const waitFor = async (probe, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(120);
    }
  };

  // 关掉设置面板，回到会话（另开页面时本就没有，兜底一下）
  const settingsClose = document.querySelector('button[aria-label="关闭"], button[aria-label="Close"]');
  if (settingsClose) { settingsClose.click(); await sleep(400); }

  const trigger = await waitFor(() => document.querySelector('[aria-label^="选择模型"], [aria-label^="Select model"]'), "trigger");
  if (!trigger) { note("打开模型菜单", "❌ 没找到模型选择器"); return { steps, ok: false }; }
  const beforeAria = trigger.getAttribute("aria-label");
  trigger.click();
  await sleep(500);

  // 宿主根面板（模型 / 推理等级）→ 插件自动进「模型」面板 → 第一层是线路列表
  // 打开菜单的瞬间做几帧采样：看宿主的原始列表有没有先露出来（用户反馈的「闪一下」）
  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    const host = document.querySelector('[role="menu"] section[role="group"]')?.parentElement;
    const ours = document.querySelector("[data-dms-split]");
    frames.push((host ? (host.style.display === "none" ? "宿主已收起" : "宿主可见") : "无宿主列表") + "/" + (ours ? "已接管" : "未接管"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  const flashed = frames.some((frame) => frame.startsWith("宿主可见"));
  note("打开瞬间逐帧采样", frames.join(" → ") + (flashed ? " ⚠️ 有一帧露出了宿主原始列表" : " ✅ 全程没有露出原始列表"));

  const vendors = await waitFor(() => {
    const list = Array.from(document.querySelectorAll("[data-dms-vendors] .dms-vendor"));
    return list.length > 0 ? list : null;
  }, "vendors");
  if (!vendors) { note("第一层线路列表", "❌ 没出现（可能模型总数少于 minItems）"); return { steps, ok: false }; }
  note("第一层：先选线路", vendors.map((node) => textOf(node)).join(" ｜ "));
  note("宿主的模型列表此刻", (() => {
    const host = document.querySelector('[role="menu"] section[role="group"]')?.parentElement;
    if (!host) return "没有分组（宿主此刻不在模型面板）";
    return host.style.display === "none" ? "已收起（第一层不摊开）✅" : "仍可见 ❌";
  })());

  // 选模型最多的那条线路
  const best = vendors
    .map((node) => ({ node, n: Number((textOf(node).match(/(\d+)/) ?? [0, 0])[1]) }))
    .sort((a, b) => b.n - a.n)[0];
  best.node.click();
  await sleep(300);

  const bar = await waitFor(() => document.querySelector('[data-dms-bar="menu"]'), "menu bar");
  if (!bar) { note("菜单搜索框", "❌ 没注入"); return { steps, ok: false }; }
  const colLeft = document.querySelectorAll("[data-dms-vendors] .dms-vendor").length;
  const colRight = document.querySelectorAll("[data-dms-models] .dms-option").length;
  const activeVendor = textOf(document.querySelector("[data-dms-vendors] .dms-vendorOn"));
  note("两栏：左栏线路 / 右栏模型", "左 " + colLeft + " 条（选中：" + activeVendor + "）｜ 右 " + colRight + " 个模型，两栏同时可见=" + (colLeft > 0 && colRight > 0));
  note("右栏家族分组", Array.from(document.querySelectorAll("[data-dms-models] [data-dms-grouphead]")).map((n) => textOf(n)).join(" ｜ "));

  function visibleItems() {
    return Array.from(document.querySelectorAll("[data-dms-models] .dms-option"));
  }

  // 搜索（仍在第二层内过滤）
  const input = bar.querySelector(".dms-input");
  input.value = "flash";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  note("第二层搜索 flash", visibleItems().length + " 条：" + visibleItems().map((n) => textOf(n)).join(", ").slice(0, 120));
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);

  // ── 推理强度能量条 ──
  if (SKIP_EFFORT) {
    const hidden = document.querySelector("[data-dms-effort]");
    note("推理强度能量条", hidden ? "已跳过拖动测试（--skip-effort）" : "❌ 没渲染");
    return { steps, ok: Boolean(hidden) };
  }
  const effort = document.querySelector("[data-dms-effort]");
  if (!effort || effort.hasAttribute("hidden")) {
    note("推理强度能量条", "❌ 没渲染（宿主服务不可用，或这个模型没有推理档位）");
    return { steps, ok: false };
  }
  const track = effort.querySelector("[data-dms-track]");
  const segs = Array.from(effort.querySelectorAll("[data-dms-seg]"));
  const value = () => textOf(effort.querySelector(".dms-effortValue"));
  const original = value();
  note("能量条：档位", segs.map((seg) => seg.getAttribute("title")).join(" → ") + "（当前 " + original + "）");
  note("能量条：无障碍语义", "role=" + track.getAttribute("role") + " aria-valuenow=" + track.getAttribute("aria-valuenow") + "/" + track.getAttribute("aria-valuemax"));

  // 真实几何拖动：从当前档拖到另一端，再把档位还原回去
  if (segs.length < 2) { note("拖动测试", "跳过（只有一档）"); return { steps, ok: true }; }
  const lastIndex = segs.length - 1;

  if (ONLY_EFFORT) {
    const at = segs.findIndex((seg) => String(seg.getAttribute("title")).toLowerCase() === ONLY_EFFORT.toLowerCase());
    if (at === -1) { note("--set-effort", "❌ 没有这个档位：" + ONLY_EFFORT + "（可选：" + segs.map((s2) => s2.getAttribute("title")).join(" / ") + "）"); return { steps, ok: false }; }
    const r = track.getBoundingClientRect();
    const x = r.left + (r.width * (at + 0.5)) / segs.length;
    for (const type of ["pointerdown", "pointerup"]) {
      track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 9, isPrimary: true }));
      await sleep(150);
    }
    await sleep(700);
    note("--set-effort", "已设为 " + value() + (value() === segs[at].getAttribute("title") ? " ✅" : " ❌"));
    return { steps, ok: value() === segs[at].getAttribute("title") };
  }
  const currentIndex = segs.findIndex((seg) => seg.getAttribute("title") === original);
  const targetIndex = currentIndex === lastIndex ? 0 : lastIndex;

  const rect = track.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const xAt = (index) => rect.left + (rect.width * (index + 0.5)) / segs.length;
  const fire = (type, x, id = 1) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, isPrimary: true }));

  fire("pointerdown", xAt(currentIndex));
  await sleep(60);
  note("按下当前档（预览应不变）", value());
  fire("pointermove", xAt(targetIndex));
  await sleep(60);
  note("拖到「" + segs[targetIndex].getAttribute("title") + "」的预览（还没松手）", value());
  fire("pointerup", xAt(targetIndex));
  await sleep(700);
  const after = value();
  note("松手后（已提交给宿主）", after + "；模型选择器 aria：" + (document.querySelector('[aria-label^="选择模型"]')?.getAttribute("aria-label") ?? "?"));

  // 还原成原来的档位，别动用户的设置
  const backIndex = segs.findIndex((seg) => seg.getAttribute("title") === original);
  if (backIndex !== -1 && after !== original) {
    const rect2 = track.getBoundingClientRect();
    const backX = rect2.left + (rect2.width * (backIndex + 0.5)) / segs.length;
    const y2 = rect2.top + rect2.height / 2;
    for (const type of ["pointerdown", "pointerup"]) {
      track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: backX, clientY: y2, pointerId: 2, isPrimary: true }));
      await sleep(120);
    }
    await sleep(700);
    note("还原回「" + original + "」", value() + (value() === original ? " ✅" : " ❌ 没还原成功"));
  }
  return { steps, ok: value() === original && after !== original };
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
      const menuReport = await evaluate(menuPage, menuDriverFor(hasFlag("skip-effort"), flag("set-effort", "")));
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
