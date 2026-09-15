# 发布与上架（维护者用）

本仓库已经是一个可以直接发布的完整插件包：`lib/client.js` 是提交进仓库的构建产物，
从 GitHub 安装**不需要任何构建步骤**（没有 `prepare` 脚本，也不会触发 pnpm 的构建授权）。

---

## 一、发布到 GitHub

### 1. 在网页上建一个**空**仓库

打开 <https://github.com/new>：

- Repository name：`dsh-model-cascade`
- 可见性随意（Public 才能被插件目录收录）
- **不要**勾选 Add a README / .gitignore / license（本地已经有内容了）

### 2. 推送

```bash
cd ~/xstone/dsh-model-cascade
git remote add origin git@github.com:Xstone1129/dsh-model-search.git   # 只需一次
git push -u origin main
```

> 本机 git 已配置 `url.git@github.com:.insteadof=https://github.com/`，并且
> `~/.ssh/id_ed25519` 已对 GitHub 认证通过，所以用 SSH 地址最省事
> （用 HTTPS 地址会被自动改写成 SSH）。

### 3. 打上 `dsh-plugin` topic（**这一步决定能不能被插件市场收录**）

DSH Plugin Hub（[dsh-plugin.org](https://dsh-plugin.org)）是按 GitHub topic 自动发现插件的：
仓库必须带 **`dsh-plugin`** 这个 topic。

网页操作：仓库主页右侧 **About** 齿轮 ⚙️ → **Topics** → 填 `dsh-plugin`（建议再加
`deepseek-harness`、`dsh`）→ Save changes。

命令行（需要 `gh` 或一个带 `repo` 权限的令牌）：

```bash
gh repo edit Xstone1129/dsh-model-search --add-topic dsh-plugin --add-topic deepseek-harness --add-topic dsh
```

之后再按官网的[提交插件](https://dsh-plugin.org/zh/submit)流程提交一次，可加快人工收录。

---

## 二、发布到 npm（可选）

npm 装法的好处是别人可以 `dsh plugin --profile web add dsh-model-cascade`（不用写 GitHub 地址）。
不发布也完全能用——README 里给的是 `github:Xstone1129/dsh-model-search` 安装法。

### 1. 拿一个 npm token

1. 注册/登录 <https://www.npmjs.com>（需要邮箱验证）；
2. 打开 <https://www.npmjs.com/settings/~/tokens>；
3. **Generate New Token**：
   - 推荐 **Automation** 类型（专供 CI/脚本发布，**可跳过两步验证**），Name 填 `dsh-model-cascade-publish`；
   - 想更细就选 **Granular Access Token**：Expiration 7 天、Permissions **Read and write**、
     Packages and scopes 勾这个包名或 All packages。
4. 生成的 token 形如 `npm_xxxxxxxx...`，**只显示一次**，复制下来。

> 网页上登录 npmjs.com 只是浏览器里的会话，**CLI 发布不认**：本机 `~/.npmrc` 里必须有
> token（`npm login` 生成）或直接写入 `//registry.npmjs.org/:_authToken=<token>`。

### 2. 发布

```bash
cd ~/xstone/dsh-model-cascade
npm pack --dry-run        # 先看一眼清单：应包含 lib/ src/ scripts/ docs/ cordis.patch.yml README LICENSE
npm publish --access public
```

`npm publish` 会先跑 `prepublishOnly`（本包没配这个钩子），发布前请确保：

```bash
npm run build && npm test     # 产物与源码版本号一致、30 个用例通过
```

发布后立刻回到 tokens 页面把那个 token **Revoke** 掉。

### 3. 发新版本

```bash
npm version patch            # 或 minor / major：同时改 package.json 与打 tag
# 记得同步 src/client.js 里的 const VERSION（构建脚本会校验不一致并报错）
npm run build && npm test
git push --follow-tags
npm publish --access public
```

---

## 三、本地验证（发布前建议跑一遍）

```bash
npm run build
npm test                                   # 30 个用例
node scripts/e2e-dsh.mjs                   # 需要本机跑着 dsh web 且插件已装
node scripts/e2e-dsh.mjs --skip-effort     # 不碰推理强度设置的那一轮
node scripts/e2e-dsh.mjs --set-effort High # 把推理强度拖到指定档位（维护用）
node scripts/e2e-dsh.mjs --probe           # 界面选择器变了时用来重新勘察
```

`scripts/e2e-dsh.mjs` 会在真实浏览器里走「设置 → 模型 → 自定义提供方 → 编辑 →
获取可用模型」，逐条断言搜索框注入位置、过滤结果、计数、批量勾选；接着另开一页
验证模型菜单的两栏级联、家族分组、打开瞬间不闪（逐帧采样），并真的拖一次推理强度
能量条（结束会还原）。任一环节失败进程退出码非 0。

⚠️ 能量条的拖动会写设置：**空会话**上选模型/档位会落到 `settings.yaml` 的
`agent-default-model`。脚本会把档位还原成开始时读到的那个；不想让它碰设置就加
`--skip-effort`。**改动宿主结构相关的选择器后，这个脚本是最快发现回归的地方**——
本项目 `role="menuitemradio"` 的坑就是它抓出来的。
