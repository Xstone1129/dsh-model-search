/**
 * 推理强度能量条单测。
 *
 * 这里模拟的是宿主真实的 `modelDirectories` 服务形态：
 * - `localStorage["dsh.sessions.current"]` 里存着当前会话 id
 * - `ctx.get("modelDirectories").directoryFor(id)` 给回一个目录
 * - 目录上有 `store.getSnapshot()/subscribe()` 与 `select(selection)`
 * 假目录的 select 会像宿主一样更新快照并通知订阅者，
 * 所以「拖一下条子 → 快照变了 → 条子跟着变」这条链路是被真跑过的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { boot, menuHtml, MODELS } from "./helpers.mjs";

const SESSION = "session-test-1";

const PROVIDERS = [
  { name: "lingsuan", models: MODELS.slice(0, 12) },
  { name: "官方", models: ["deepseek-chat", "deepseek-reasoner"] },
];

const DEEPSEEK_MODELS = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: {
      defaultEffort: "high",
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
        { id: "max", name: "Max" },
      ],
    },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: {
      defaultEffort: undefined,
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
  },
  { id: "community/model-001", name: "no reasoning" },
];

/** 造一个像宿主的模型目录（含快照订阅与 select）。 */
function fakeDirectory(initial = {}) {
  let snapshot = {
    status: "ready",
    error: null,
    routable: true,
    failures: [],
    current: { provider: "lingsuan", model: "deepseek-v4-flash", reasoningEffort: "high" },
    groups: [
      { id: "lingsuan", name: "lingsuan", models: DEEPSEEK_MODELS },
      { id: "官方", name: "官方", models: [{ id: "deepseek-chat", name: "chat" }] },
    ],
    ...initial,
  };
  const listeners = new Set();
  const calls = [];
  const directory = {
    calls,
    failNext: false,
    store: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async select(selection) {
      calls.push(selection);
      if (directory.failNext === true) {
        directory.failNext = false;
        throw new Error("UNSUPPORTED_REASONING_EFFORT: nope");
      }
      snapshot = {
        ...snapshot,
        current: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
      };
      for (const listener of listeners) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
    setSnapshot(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    get snapshot() {
      return snapshot;
    },
  };
  return directory;
}

/** jsdom 没有 PointerEvent：用 MouseEvent 顶上（插件只用 clientX / pointerId）。 */
function pointer(env, node, type) {
  node.dispatchEvent(new env.window.MouseEvent(type, { bubbles: true, cancelable: true }));
}

/** 起一个带假服务的菜单世界。 */
function withEffort({ directory = fakeDirectory(), session = SESSION, options = {} } = {}) {
  const env = boot({ html: menuHtml(PROVIDERS) });
  if (session !== null) {
    env.window.localStorage.setItem("dsh.sessions.current", JSON.stringify({ sessionId: session }));
  }
  env.window.localStorage.setItem("dsh-model-cascade:options", JSON.stringify({ autoFocus: false, ...options }));
  if (directory !== null) {
    env.ctx.services.set("modelDirectories", {
      directoryFor: (id) => {
        assert.equal(id, session, "必须用当前会话 id 去取目录");
        return directory;
      },
    });
  }
  env.exports.apply(env.ctx);
  const menu = env.document.querySelector('div[role="menu"]');
  const effort = menu.querySelector("[data-dms-effort]");
  return {
    ...env,
    directory,
    menu,
    effort,
    track: effort.querySelector("[data-dms-track]"),
    segs: () => Array.from(effort.querySelectorAll("[data-dms-seg]")),
    value: () => effort.querySelector(".dms-effortValue").textContent,
    enterProvider: () => Array.from(menu.querySelectorAll(".dms-vendor"))[0].click(),
  };
}

test("能量条：按宿主目录里的档位渲染（DeepSeek 是 low/high/max 三档）", () => {
  const env = withEffort();
  assert.equal(env.effort.hasAttribute("hidden"), false, "档位已知时必须显示");
  assert.equal(env.segs().length, 3);
  assert.deepEqual(
    env.segs().map((seg) => seg.getAttribute("title")),
    ["Low", "High", "Max"],
  );
  assert.equal(env.value(), "High", "当前档位来自快照里的 reasoningEffort");
  assert.deepEqual(
    env.segs().map((seg) => seg.classList.contains("dms-segOn")),
    [true, true, false],
    "能量条要填到当前档",
  );
  assert.equal(env.track.getAttribute("role"), "slider");
  assert.equal(env.track.getAttribute("aria-valuenow"), "2");
  assert.equal(env.track.getAttribute("aria-valuetext"), "High");
  env.dispose();
});

test("能量条：点某一格 → 提交给宿主的 select，并跟着快照自己更新", async () => {
  const env = withEffort();
  pointer(env, env.segs()[2], "pointerdown");
  pointer(env, env.segs()[2], "pointerup");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 插件在 jsdom 领域里跑，对象原型跨领域，先序列化再比
  assert.deepEqual(JSON.parse(JSON.stringify(env.directory.calls)), [
    { provider: "lingsuan", model: "deepseek-v4-flash", reasoningEffort: "max" },
  ]);
  assert.deepEqual(
    env.segs().map((seg) => seg.classList.contains("dms-segOn")),
    [true, true, true],
  );
  assert.equal(env.value(), "Max");
  env.dispose();
});

test("能量条：拖动（按下→移动→松手）只在松手时提交一次", async () => {
  const env = withEffort();
  const track = env.track;
  pointer(env, env.segs()[0], "pointerdown");
  assert.equal(env.value(), "Low", "拖动过程要实时预览");

  pointer(env, env.segs()[1], "pointermove");
  assert.equal(env.value(), "High");
  assert.equal(env.directory.calls.length, 0, "没松手就不该落库");

  pointer(env, env.segs()[2], "pointermove");
  pointer(env, env.segs()[2], "pointerup");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.directory.calls.length, 1, "松手时只提交一次");
  assert.equal(env.directory.calls[0].reasoningEffort, "max");
  assert.equal(env.value(), "Max");
  void track;
  env.dispose();
});

test("能量条：左右方向键调一档并立即提交", async () => {
  const env = withEffort();
  const press = (key) =>
    env.track.dispatchEvent(new env.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  press("ArrowLeft");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.directory.calls[0].reasoningEffort, "low");

  press("ArrowRight");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.directory.calls[1].reasoningEffort, "high");
  env.dispose();
});

test("能量条：提交失败时给出错误并回滚显示", async () => {
  const env = withEffort();
  env.directory.failNext = true;
  pointer(env, env.segs()[2], "pointerdown");
  pointer(env, env.segs()[2], "pointerup");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const error = env.effort.querySelector(".dms-effortErr");
  assert.equal(error.hasAttribute("hidden"), false);
  assert.match(error.textContent, /设置失败：UNSUPPORTED_REASONING_EFFORT/);
  assert.equal(env.value(), "High", "失败后回到快照里的档位");
  assert.deepEqual(
    env.segs().map((seg) => seg.classList.contains("dms-segOn")),
    [true, true, false],
  );
  env.dispose();
});

test("能量条：宿主已把「提供方默认」排在首位时，档位与选择一起对齐", async () => {
  const directory = fakeDirectory({
    current: { provider: "lingsuan", model: "deepseek-v4-pro" },
  });
  const env = withEffort({ directory });
  env.enterProvider();
  assert.equal(env.segs().length, 3, "默认 + low + high");
  assert.deepEqual(
    env.segs().map((seg) => seg.getAttribute("title")),
    ["默认", "Low", "High"],
  );
  assert.equal(env.value(), "默认");
  assert.deepEqual(
    env.segs().map((seg) => seg.classList.contains("dms-segOn")),
    [true, false, false],
  );

  pointer(env, env.segs()[2], "pointerdown");
  pointer(env, env.segs()[2], "pointerup");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(env.directory.calls[0])), {
    provider: "lingsuan",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
  });
  env.dispose();
});

test("能量条：模型没有推理能力时整条隐藏", () => {
  const directory = fakeDirectory({
    current: { provider: "lingsuan", model: "community/model-001" },
  });
  const env = withEffort({ directory });
  assert.equal(env.effort.hasAttribute("hidden"), true);
  env.dispose();
});

test("能量条：拿不到服务 / 会话未知时安静缺席，其余功能不受影响", () => {
  const noService = withEffort({ directory: null });
  assert.equal(noService.effort.hasAttribute("hidden"), true);
  assert.ok(noService.menu.querySelector('[data-dms-bar="menu"]'), "搜索框照常在");
  assert.ok(noService.menu.querySelector("[data-dms-vendors]"));
  noService.dispose();

  const noSession = withEffort({ session: null });
  assert.equal(noSession.effort.hasAttribute("hidden"), true);
  assert.ok(noSession.menu.querySelector("[data-dms-bar=\"menu\"]"));
  noSession.dispose();
});

test("能量条：宿主快照变化时（比如在别处换了模型）条子自己跟着变", () => {
  const env = withEffort();
  assert.equal(env.value(), "High");
  env.directory.setSnapshot({ current: { provider: "lingsuan", model: "deepseek-v4-pro" } });
  assert.equal(env.value(), "默认", "换了模型 → 换成那个模型的档位");
  assert.equal(env.segs().length, 3);
  env.dispose();
});

test("能量条：菜单卸载时退订，不留悬挂监听", () => {
  const env = withEffort();
  assert.equal(env.directory.listenerCount, 1);
  env.dispose();
  assert.equal(env.directory.listenerCount, 0, "卸载后必须退订");
});
