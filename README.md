<div align="center">

# dsh-model-search

**给 DeepSeek Harness 的模型列表加上搜索框**

自定义提供方一次拉回上百个模型？不用再一行行找了。

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490?style=flat-square)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-1.0.0-green?style=flat-square)](package.json)

**简体中文** · [English](README.en.md)

</div>

---

## 这个插件解决什么问题

在 DSH 里加自定义提供方（OpenAI 兼容网关、自建服务、中转站）时，点「**获取可用模型**」会拉回一张勾选列表。模型动辄几十上百个，而那个弹窗**没有搜索框**——只能滚着找、翻着数，想勾的模型明明记得名字却找不到。

装好模型后还有第二处同样的痛：输入框旁的**模型菜单**按提供方分组列出全部模型，同样没有搜索。

本插件把这两处都补上搜索框：

<p align="center">
  <img src="docs/dialog-search.png" alt="「选择要添加的模型」弹窗里的搜索框" width="640">
</p>

<p align="center">
  <img src="docs/menu-search.png" alt="输入框旁模型菜单里的搜索框" width="560">
</p>

以上都是本机真实运行的 DSH 界面上截的图（由 `node scripts/e2e-dsh.mjs` 用无头浏览器跑出来）。

## 功能

**① 「获取可用模型」弹窗**

- 顶部自动出现搜索框，边打边过滤，插在候选列表上方，不动原有布局
- **多关键词**：空格分隔，全部命中才算匹配（`deepseek v4`）
- **模糊兜底**：子串一个都搜不到时自动降级为子序列匹配（`dsv4flash` → `deepseek-v4-flash`），并标注「模糊匹配」
- **实时计数**：`显示 6 / 19 · 已选 12`
- **选中结果 / 取消结果**：只对当前过滤出来的那几条批量勾选——把「先筛再全选」变成一次点击
- 快捷键：`/`… 直接打字即可；`Esc` 清空搜索（不会顺手把弹窗关掉）；`↑ ↓` 在结果之间移动；`Enter` 命中唯一结果时直接勾上

**② 输入框旁的模型菜单**

- 打开「模型」子面板即出现搜索框，过滤模型项、自动隐藏没有命中的整个分组
- 模型多到十几二十个时，截图上那一屏就能说明价值

**③ 不打扰**

- 列表本来就短（默认少于 8 条）时不显示搜索框，界面保持原样
- 两处可以分别关掉，阈值可调

## 安装

**方式一：官方命令（推荐）**

```bash
# 从 GitHub 安装（无需构建：产物已随仓库提交）
dsh plugin --profile web add github:Xstone1129/dsh-model-search
```

装完**刷新页面**；若没生效，重启 `dsh web`。

**方式二：手动（免重启，适合本机折腾）**

```bash
# 1. 放进 profile 的依赖里
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-model-search

# 2. 在该 profile 的 cordis.patch.yml 里插入插件条目（这个文件是热监听的，改完立即生效）
```

```yaml
- insert:
    - id: dsh-model-search
      name: 'dsh-model-search'
```

改完刷新页面即可，不用重启 `dsh web`。

> ⚠️ 两种方式**不要同时用**：同一个条目被插入两次会让插件被加载两遍。用方式一之前，先把方式二手写的那三行删掉。

## 使用

装好后不需要任何配置——打开「设置 → 模型 → 某个自定义提供方的编辑 → 获取可用模型」，搜索框就在那里。

打开弹窗时搜索框会**自动获得焦点**，可以直接开始打字（不想这样见下面的选项）。

## 选项

浏览器控制台里用 `dshModelSearch` 随时调整（写入 `localStorage`，刷新后保留）：

```js
dshModelSearch.options                      // 看当前选项
dshModelSearch.set({ autoFocus: false })    // 关掉自动聚焦
dshModelSearch.set({ minItems: 3 })         // 模型少到 3 条也显示搜索框
dshModelSearch.set({ menu: false })         // 只保留弹窗搜索，不要模型菜单那处
dshModelSearch.set({ lang: 'en' })          // 强制英文文案（默认 auto：跟着界面走）
dshModelSearch.reset()                      // 恢复默认
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `dialog` | `true` | 给「获取可用模型」弹窗加搜索框 |
| `menu` | `true` | 给输入框旁的模型菜单加搜索框 |
| `minItems` | `8` | 列表项少于该数量时不显示搜索框 |
| `autoFocus` | `true` | 弹窗打开时自动聚焦搜索框 |
| `lang` | `'auto'` | 文案语言：`auto` / `zh` / `en` |

存储键：`localStorage["dsh-model-search:options"]`。

## 它是怎么做到的（以及诚实说明）

模型候选列表和模型菜单都是 DSH 内建组件的**私有 DOM**，没有对外暴露插槽（slot），所以本插件走的是「DOM 增强」路线，并严守三条规矩：

1. **只增不改**：只往容器里插入自己的搜索条，从不移动、删除、重排宿主自己的节点；
2. **只碰宿主不管理的属性**：过滤靠 `style.display`（宿主没有 `style` prop，React 不会覆盖），不碰 `className`、不碰受控属性；
3. **结构性识别，不认哈希类名**：候选列表靠「只装 `<li>`、每个 `<li>` 里都有复选框的 `<ul>`」识别（全应用只有这一处），模型菜单靠 `div[role="menu"]` + `section[role="group"]` 识别。

**因此**：如果未来某个 DSH 版本改了这两处的结构，插件会**静默失效**（搜索框不再出现），而不会把界面改坏；出错路径上还有 `try/catch` 兜底，最多在控制台留一行警告。

开发时的验证目标是 `@deepseek-ai/dsh@0.1.1-rc.2`（DSH Web UI）。同期的 `role="menuitemradio"` 布局差异就是靠真实浏览器 E2E 抓出来的——单元测试的夹具已按真实 DOM 校正。

## 开发

本仓库零构建依赖：产物 `lib/client.js` 由脚本把 `src/client.js` 套进 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 外壳生成。

```bash
npm run build     # src/ → lib/client.js（内联 CSS、校验版本号）
npm test          # 30 个用例：纯逻辑 + jsdom 真实加载产物跑 DOM 行为
node scripts/e2e-dsh.mjs --screenshot out.png   # 真实浏览器端到端（需要本机跑着 dsh web）
```

目录：

```
src/client.js        客户端半边源码（工厂体：apply / inject）
src/client.css       注入的样式（走 DSH 主题变量，浅色/深色都适配）
scripts/build.mjs    打包脚本（无依赖，只套外壳 + 内联 CSS）
scripts/e2e-dsh.mjs  无头 Chrome 端到端：开设置 → 获取模型 → 验证过滤
lib/index.js         宿主半边（空壳：只为让浏览器半边被 Loader 发现）
lib/client.js        构建产物（已提交，装完即用，无需构建）
test/                node:test 用例（含 jsdom 夹具）
```

## 兼容性

- DSH Web UI（`dsh web`），桌面与移动端浏览器均可
- 纯客户端插件：不写配置、不起路由、不读凭据，卸载后自动还原一切

## 许可

[MIT](LICENSE) © 2026 Xstone1129
