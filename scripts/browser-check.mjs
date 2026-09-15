#!/usr/bin/env node
/**
 * 浏览器自检：在**真实 Chrome**（真实布局引擎、真实焦点/指针行为）里跑
 * `test/harness.html`，验证那些只有真浏览器才量得准的事情：
 *
 *   - 切换线路时菜单外框尺寸是否纹丝不动（用户反馈的「一会儿长一会儿宽」）
 *   - 真实 mousedown + 焦点转移下，点线路会不会把菜单关掉
 *     （页内 element.click() 测不出这个，因为合成点击不移动焦点）
 *   - 长模型名有没有把面板撑开
 *
 * 它不依赖正在运行的 dsh web，所以插件没装、DSH 没重启时也能跑。
 *
 * 用法：node scripts/browser-check.mjs [--port 9335] [--keep]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const PORT = Number(flag("port", 9335));
const CHROME = process.env.CHROME ?? "google-chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** 起一个只服务本仓库的最小静态服务器（模块脚本/CSS 需要 http 协议）。 */
async function serveRepo() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

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
      `--user-data-dir=${flag("profile-dir", "/tmp/dsh-model-search-check")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  ).unref();
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    const version = await probe();
    if (version !== null) return version;
  }
  throw new Error(`Chrome 没能在 :${PORT} 起起来`);
}

/** 极简 CDP 客户端。 */
async function openPage(url) {
  const version = await ensureChrome();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        pending.delete(message.id);
        message.error !== undefined ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      }
      return;
    }
    events.push(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const session = { send: (method, params) => send(method, params, sessionId) };
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Log.enable");
  await session.send("Page.navigate", { url });
  return { ws, send, session, targetId, events };
}

const evaluate = async (session, expression) => {
  const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) {
    throw new Error(`页面脚本抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
};

const main = async () => {
  const { server, port } = await serveRepo();
  const page = await openPage(`http://127.0.0.1:${port}/test/harness.html`);
  try {
    let results = null;
    for (let i = 0; i < 100; i += 1) {
      await sleep(150);
      results = await evaluate(page.session, "window.__done === true ? window.__results : null");
      if (results !== null) break;
    }
    if (results === null) throw new Error("自检脚本没有跑完（页面里可能有报错）");
    let failed = 0;
    for (const item of results) {
      console.log(`${item.ok ? "✅" : "❌"} ${item.name}${item.detail ? `　${item.detail}` : ""}`);
      if (!item.ok) failed += 1;
    }
    const errors = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
    for (const error of errors) console.log(`⚠️ 页面异常：${error.params?.exceptionDetails?.exception?.description ?? ""}`);
    console.log(failed === 0 && errors.length === 0 ? "\n✅ 浏览器自检全部通过" : `\n❌ 浏览器自检失败（${failed} 项）`);
    process.exitCode = failed === 0 && errors.length === 0 ? 0 : 1;
  } finally {
    await page.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    page.ws.close();
    server.close();
  }
};

await main();
