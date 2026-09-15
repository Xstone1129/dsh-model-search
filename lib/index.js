/**
 * dsh-model-search — host half.
 *
 * 本插件的全部能力都在浏览器半边（`lib/client.js`），宿主半边刻意保持空壳：
 * `@deepseek-ai/dsh-client-modules` 正是通过**宿主 Loader 的条目**来发现带
 * `dsh.client` 声明的包，再把它的 `exports["./client"]` 排进 `window.__DSH_BOOT__`。
 * 换句话说，这个空壳条目的唯一职责就是让浏览器半边被加载。
 *
 * 因此本插件不碰任何宿主资源：不写配置文件、不起路由、不碰凭据。
 *
 * @module dsh-model-search
 */

/** Loader 条目名（与包名一致，客户端模块 id 也用它）。 */
export const name = "dsh-model-search";

/** 无宿主依赖。 */
export const inject = [];

/**
 * 宿主半边什么都不做。
 * @returns {void}
 */
export function apply() {}
