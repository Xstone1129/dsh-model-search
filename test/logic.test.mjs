/**
 * 纯逻辑单测：关键词解析、子串/模糊匹配、语言判定、文案格式化。
 * 这些函数不碰 DOM，直接取插件产物里导出的内部面来测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { boot, MODELS } from "./helpers.mjs";

const env = boot();
test.after(() => env.dispose());
const { parseQuery, isSubsequence, matchesTerms, matchIds, format } = env.internals;

test("parseQuery：大小写不敏感、空格/全角空格分隔、忽略空词", () => {
  assert.deepEqual([...parseQuery("  DeepSeek   V4 ")], ["deepseek", "v4"]);
  assert.deepEqual([...parseQuery("qwen\u3000coder")], ["qwen", "coder"]);
  assert.deepEqual([...parseQuery("")], []);
  assert.deepEqual([...parseQuery(undefined)], []);
  assert.deepEqual([...parseQuery("   ")], []);
});

test("isSubsequence：子序列命中", () => {
  assert.equal(isSubsequence("deepseek-v4-flash", "dsv4"), true);
  assert.equal(isSubsequence("deepseek-v4-flash", "flash"), true);
  assert.equal(isSubsequence("deepseek-v4-flash", "zzz"), false);
  assert.equal(isSubsequence("abc", ""), true);
});

test("matchesTerms：空关键词视为全命中", () => {
  assert.equal(matchesTerms("anything", [], false), true);
  assert.equal(matchesTerms("DeepSeek-V4", ["deepseek"], false), true);
  assert.equal(matchesTerms("DeepSeek-V4", ["deepseek", "v4"], false), true);
  assert.equal(matchesTerms("DeepSeek-V4", ["deepseek", "v5"], false), false);
});

test("matchIds：空查询匹配全部且保持原顺序", () => {
  const { matches, fuzzy } = matchIds(MODELS, "");
  assert.equal(matches.length, MODELS.length);
  assert.equal(matches.every(Boolean), true);
  assert.equal(fuzzy, false);
});

test("matchIds：子串匹配（用户的核心诉求：100 个里找到 flash）", () => {
  const { matches, fuzzy } = matchIds(MODELS, "flash");
  assert.equal(fuzzy, false);
  const hits = MODELS.filter((_, index) => matches[index]);
  assert.deepEqual(hits, ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "qwen3-coder-flash", "gemini-2.5-flash"]);
});

test("matchIds：多关键词是 AND 关系", () => {
  const { matches } = matchIds(MODELS, "deepseek v4");
  const hits = MODELS.filter((_, index) => matches[index]);
  assert.equal(hits.length, 4);
  assert.equal(hits.every((id) => id.includes("deepseek") && id.includes("v4")), true);
});

test("matchIds：子串全空时自动降级为模糊匹配", () => {
  const { matches, fuzzy } = matchIds(MODELS, "dsv4flash");
  assert.equal(fuzzy, true);
  assert.equal(matches[0], true, "deepseek-v4-flash 应被 dsv4flash 命中");
  const { matches: direct } = matchIds(["no-such-model"], "dsv4flash");
  assert.equal(direct[0], false, "确实没有子序列关系时不应乱命中");
});

test("format：占位符替换", () => {
  assert.equal(format("显示 {shown} / {total}", { shown: 3, total: 100 }), "显示 3 / 100");
  assert.equal(format("无参数 {x}", undefined), "无参数 {x}");
});

test("产物契约：导出 apply / inject，且不注入任何宿主服务", () => {
  const { exports } = env;
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual([...exports.inject], []);
  assert.equal(exports.name, "dsh-model-search");
});
