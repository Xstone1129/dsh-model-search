/**
 * dsh-model-cascade — browser half.
 *
 * DeepSeek Harness 的模型列表搜索增强：给「获取模型列表」对话框和输入框旁的
 * 模型菜单加上搜索框，让上百个模型也能秒定位。
 *
 * 为什么用 DOM 增强而不是插槽（slot）注册：模型候选列表与模型菜单都是
 * 框架内部组件（`@deepseek-ai/dsh-client-ui-settings-models` /
 * `@deepseek-ai/dsh-client-ui-model-selection`）的私有 DOM，没有对外暴露插槽，
 * 所以本插件在既有 DOM 上做「只增不改」的增强：
 *
 *   - 只往容器里插入自己的搜索条，从不移动、删除、重排框架自己的节点；
 *   - 只写框架不管理的属性（`li.style.display`），不碰 className / 受控属性；
 *   - 结构性识别（复选框列表 / role="menu" 分组），不依赖哈希过的 CSS 类名，
 *     识别失败时静默退出，绝不会把界面改坏。
 *
 * 本文件是「工厂体」源码，由 `scripts/build.mjs` 包进
 * `window.__ModuleLoader__.load({ id, factory })` 外壳后产出 `lib/client.js`。
 * 这里写成 CommonJS 风格（`exports.xxx`），构建脚本只做包裹，不做转译。
 */

/** 插件版本（与 package.json 保持一致，构建时校验）。 */
const VERSION = "1.3.0";

/** 注入样式的标签标识，避免重复注入。 */
const STYLE_TAG_ID = "dsh-model-cascade/styles.css";

/** 选项在 localStorage 中的键名。 */
const OPTIONS_KEY = "dsh-model-cascade:options";

/** 改名前（dsh-model-search）的键名：只读一次用于迁移。 */
const LEGACY_OPTIONS_KEY = "dsh-model-search:options";

/** 默认选项。 */
const DEFAULT_OPTIONS = {
	/** 给「获取模型列表」对话框加搜索框。 */
	dialog: true,
	/** 给输入框旁的模型菜单加搜索框。 */
	menu: true,
	/** 列表项少于该数量时不显示搜索框（列表本来就没几条，加了反而碍事）。 */
	minItems: 8,
	/** 对话框打开时自动聚焦搜索框，打开就能直接打字。 */
	autoFocus: true,
	/**
	 * 模型菜单改成两级选择：先选线路（提供方），再选模型。
	 * 关掉就退回成「一屏列出所有模型 + 搜索框」的老样子。
	 */
	drilldown: true,
	/**
	 * 打开菜单时自动进入「模型」面板，省掉「模型 / 推理等级」那次多余的点击。
	 * 代价是想改推理等级要先按 Esc 回上一层；不想要就设成 false。
	 */
	openToModels: true,
	/** 界面语言：auto / zh / en。 */
	lang: "auto",
};

/**
 * 模型菜单里「一个可选项」的选择器。
 * 宿主用 `role="menuitemradio"` 标记模型（可选中的项），根面板的入口用 `menuitem`；
 * 两种都收，而且只取分组（`section[role=group]`）里面的，根面板入口不会被误当成模型。
 */
const MENU_ITEM_SELECTOR = 'button[role="menuitemradio"], button[role="menuitem"]';

/**
 * 模型家族识别：按顺序匹配模型 id / 名称里的关键词，命中第一个就归入该家族。
 * 用途是模型菜单第二层那一排「DeepSeek / GPT / 其他…」筛选标签——中转站里
 * 同一个家族常常散落在好几条线路上，先按家族收拢再挑具体型号最省事。
 */
const FAMILY_RULES = [
	["deepseek", /deepseek|deep-?seek|(^|[^a-z])ds[-_. ]?v?\d/i],
	["gpt", /gpt|chatgpt|codex|(^|[^a-z])o[1-4]([^a-z]|$)/i],
	["claude", /claude|sonnet|opus|haiku/i],
	["gemini", /gemini|palm|learnlm/i],
	["qwen", /qwen|qwq|tongyi/i],
	["glm", /glm|chatglm|zhipu/i],
	["kimi", /kimi|moonshot/i],
	["grok", /grok/i],
	["llama", /llama/i],
	["mistral", /mistral|mixtral|codestral|magistral/i],
	["minimax", /minimax|abab/i],
	["doubao", /doubao|seed-?oss|ep-20/i],
	["ernie", /ernie|wenxin/i],
	["hunyuan", /hunyuan/i],
	["step", /step-?\d|stepfun/i],
	["spark", /spark|xfyun|iflytek/i],
];

/** 家族显示名（品牌名中英一致，只有「其他」需要翻译）。 */
const FAMILY_LABELS = {
	deepseek: "DeepSeek",
	gpt: "GPT",
	claude: "Claude",
	gemini: "Gemini",
	qwen: "Qwen",
	glm: "GLM",
	kimi: "Kimi",
	grok: "Grok",
	llama: "Llama",
	mistral: "Mistral",
	minimax: "MiniMax",
	doubao: "Doubao",
	ernie: "Ernie",
	hunyuan: "Hunyuan",
	step: "Step",
	spark: "Spark",
	other: "Other",
};

/**
 * 一个模型 id 属于哪个家族，认不出来一律归 `other`。
 * @param {string} id 模型 id 或名称。
 * @returns {string} 家族键。
 */
function familyOf(id) {
	const text = String(id);
	for (const [key, pattern] of FAMILY_RULES) {
		if (pattern.test(text)) return key;
	}
	return "other";
}

/**
 * 家族键 → 展示名。
 * @param {string} key 家族键。
 * @param {"zh" | "en"} lang 语言。
 * @returns {string} 展示名。
 */
function familyLabel(key, lang) {
	if (key === "other") return COPY[lang].familyOther;
	return FAMILY_LABELS[key] ?? key;
}

/**
 * 家族排序权重：DeepSeek、GPT 在最前（用户最常用的两类），其余按自定义顺序，
 * 认不出来的「其他」永远垫底。
 * @param {string} key 家族键。
 * @returns {number} 排序权重。
 */
function familyRank(key) {
	if (key === "other") return 99;
	const at = FAMILY_RULES.findIndex(([name]) => name === key);
	return at === -1 ? 98 : at;
}

/**
 * 统计一组模型项各自的家族。
 * @param {readonly {id: string}[]} items 模型项。
 * @returns {Map<string, number>} 家族 → 数量。
 */
function familyCounts(items) {
	const counts = new Map();
	for (const item of items) {
		const key = familyOf(item.id);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** 文案字典。`dialogTitle` / `menuAria` 同时是识别界面语言的锚点。 */
const COPY = {
	zh: {
		dialogTitle: "选择要添加的模型",
		menuAria: "模型与推理等级",
		searchAria: "搜索模型",
		placeholder: "搜索模型（空格分隔多个关键词）",
		clear: "清空搜索",
		selectResults: "选中结果",
		deselectResults: "取消结果",
		count: "显示 {shown} / {total}",
		selected: "已选 {picked}",
		fuzzy: "模糊匹配",
		empty: "没有匹配的模型",
		all: "显示全部 {total} 个",
		placeholderProviders: "搜索线路或模型名（空格分隔）",
		placeholderModels: "搜索模型（空格分隔多个关键词）",
		providers: "{shown} / {total} 条线路",
		modelsIn: "{n} 个模型",
		matchesIn: "{n} 个匹配",
		currentBadge: "当前",
		allProviders: "所有线路",
		noProvider: "没有匹配的线路",
		modelsAria: "模型子列表",
		familyAll: "全部",
		familyOther: "其他",
		providersAria: "模型线路",
		effortLabel: "推理强度",
		effortDefault: "默认",
		effortAria: "推理强度（拖动或左右方向键调节）",
		effortPending: "设置中…",
		effortFailed: "设置失败：{message}",
	},
	en: {
		dialogTitle: "Choose models to add",
		menuAria: "Model and reasoning effort",
		searchAria: "Search models",
		placeholder: "Search models (space separates keywords)",
		clear: "Clear search",
		selectResults: "Select results",
		deselectResults: "Deselect results",
		count: "{shown} / {total} shown",
		selected: "{picked} selected",
		fuzzy: "fuzzy match",
		empty: "No matching model",
		all: "Showing all {total}",
		placeholderProviders: "Search providers or model names",
		placeholderModels: "Search models (space separates keywords)",
		providers: "{shown} / {total} providers",
		modelsIn: "{n} models",
		matchesIn: "{n} matches",
		currentBadge: "current",
		allProviders: "All providers",
		noProvider: "No matching provider",
		modelsAria: "Models",
		familyAll: "All",
		familyOther: "Other",
		providersAria: "Model providers",
		effortLabel: "Reasoning",
		effortDefault: "Default",
		effortAria: "Reasoning effort (drag or use arrow keys)",
		effortPending: "Applying…",
		effortFailed: "Failed: {message}",
	},
};

/** 把 `{name}` 占位符替换成参数。 */
function format(text, params) {
	return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
		params !== undefined && key in params ? String(params[key]) : whole,
	);
}

/** 读取选项：非法或损坏的存储值一律回退默认，绝不让插件因为坏配置失效。 */
function readOptions() {
	const base = { ...DEFAULT_OPTIONS };
	let raw = null;
	try {
		raw = window.localStorage.getItem(OPTIONS_KEY);
		// 从 dsh-model-search 改名过来：老配置读一次就迁移，别让用户的设置凭空消失。
		if (raw === null) raw = window.localStorage.getItem(LEGACY_OPTIONS_KEY);
	} catch {
		return base;
	}
	let stored;
	try {
		stored = JSON.parse(String(raw ?? ""));
	} catch {
		return base;
	}
	if (stored === null || typeof stored !== "object") return base;
	if (typeof stored.dialog === "boolean") base.dialog = stored.dialog;
	if (typeof stored.menu === "boolean") base.menu = stored.menu;
	if (typeof stored.autoFocus === "boolean") base.autoFocus = stored.autoFocus;
	if (typeof stored.drilldown === "boolean") base.drilldown = stored.drilldown;
	if (typeof stored.openToModels === "boolean") base.openToModels = stored.openToModels;
	if (typeof stored.minItems === "number" && Number.isFinite(stored.minItems) && stored.minItems >= 1) {
		base.minItems = Math.floor(stored.minItems);
	}
	if (stored.lang === "auto" || stored.lang === "zh" || stored.lang === "en") base.lang = stored.lang;
	return base;
}

/** 写入选项（只写已知字段，保持存储干净）。 */
function writeOptions(options) {
	try {
		window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
	} catch {
		/* 隐私模式下 localStorage 可能不可写：本次会话内仍然生效即可 */
	}
}

/* ────────────────────────── 纯逻辑（可单测） ────────────────────────── */

/**
 * 把输入框内容切成关键词：大小写不敏感、空格（含全角空格）分隔、忽略空词。
 * @param {unknown} raw 原始输入。
 * @returns {string[]} 小写关键词数组。
 */
function parseQuery(raw) {
	return String(raw === undefined || raw === null ? "" : raw)
		.toLowerCase()
		.split(/[\s\u3000]+/)
		.filter((term) => term.length > 0);
}

/**
 * `needle` 是否为 `haystack` 的子序列（用于模糊匹配：`dsv4` 命中 `deepseek-v4`）。
 * @param {string} haystack 已小写的待查文本。
 * @param {string} needle 已小写的关键词。
 * @returns {boolean} 是否命中。
 */
function isSubsequence(haystack, needle) {
	let at = 0;
	for (let i = 0; i < haystack.length && at < needle.length; i += 1) {
		if (haystack[i] === needle[at]) at += 1;
	}
	return at === needle.length;
}

/**
 * 单条文本是否命中全部关键词。
 * @param {string} text 待查文本（模型 id）。
 * @param {string[]} terms 小写关键词。
 * @param {boolean} fuzzy 是否使用子序列模糊匹配。
 * @returns {boolean} 是否命中。
 */
function matchesTerms(text, terms, fuzzy) {
	if (terms.length === 0) return true;
	const haystack = String(text).toLowerCase();
	return terms.every((term) => (fuzzy ? isSubsequence(haystack, term) : haystack.includes(term)));
}

/**
 * 对一批模型 id 求匹配结果：先按子串匹配；一个都没有时自动降级为模糊匹配，
 * 这样「明明记得叫 flash 但只打了几个字母」也能找到。
 * @param {readonly string[]} ids 候选模型 id，保持原顺序。
 * @param {unknown} raw 输入框原始内容。
 * @returns {{ matches: boolean[], fuzzy: boolean, terms: string[] }} 与 `ids` 等长的命中数组。
 */
function matchIds(ids, raw) {
	const terms = parseQuery(raw);
	if (terms.length === 0) return { matches: ids.map(() => true), fuzzy: false, terms };
	let matches = ids.map((id) => matchesTerms(id, terms, false));
	if (matches.some(Boolean)) return { matches, fuzzy: false, terms };
	matches = ids.map((id) => matchesTerms(id, terms, true));
	return { matches, fuzzy: matches.some(Boolean), terms };
}

/**
 * 猜当前界面语言：先用对话框/菜单的 aria-label 与实际界面对齐（最可靠），
 * 再退到 `navigator.language`。
 * @param {"auto" | "zh" | "en"} preference 用户选项。
 * @returns {"zh" | "en"} 文本语言。
 */
function pickLang(preference) {
	if (preference === "zh" || preference === "en") return preference;
	const anchors = [
		['[role="dialog"][aria-label]', "dialogTitle"],
		['div[role="menu"][aria-label]', "menuAria"],
	];
	for (const [selector, key] of anchors) {
		for (const node of document.querySelectorAll(selector)) {
			const label = node.getAttribute("aria-label");
			if (label === COPY.zh[key]) return "zh";
			if (label === COPY.en[key]) return "en";
		}
	}
	const preferred = String(window.navigator?.language ?? "").toLowerCase();
	return preferred.startsWith("zh") ? "zh" : "en";
}

/* ────────────────────────── 推理强度（能量条） ────────────────────────── */

/**
 * 当前会话 id。运行时把「当前会话」持久化在 localStorage 里
 * (`dsh.sessions.current`)，这是插件从宿主服务取模型目录的入口。
 * @returns {string | null} 会话 id，取不到就返回 null。
 */
function currentSessionId() {
	try {
		const raw = JSON.parse(String(window.localStorage.getItem("dsh.sessions.current") ?? ""));
		const id = raw?.sessionId ?? raw?.subagentAddress?.childSessionId;
		return typeof id === "string" && id !== "" ? id : null;
	} catch {
		return null;
	}
}

/**
 * 取当前会话的模型目录（宿主 `modelDirectories` 服务的实例）。
 *
 * 用服务而不是爬 DOM 的理由：推理强度的档位是**每个模型各自的能力**
 * （DeepSeek 是 low/high/max，某些线路只有一档），只有宿主的目录里有权威数据；
 * 而且 `directory.select()` 就是宿主自己提交选择时走的同一个接口。
 *
 * 服务不可用（没有这个服务、会话未知、非 Web 部署）时返回 null，
 * 能量条自动缺席，其余功能照常。
 * @returns {object | null} 模型目录实例。
 */
function modelDirectory() {
	const services = state.ctx;
	if (services === undefined || services === null || typeof services.get !== "function") return null;
	const sessionId = currentSessionId();
	if (sessionId === null) return null;
	try {
		const resolver = services.get("modelDirectories");
		if (resolver === undefined || resolver === null || typeof resolver.directoryFor !== "function") return null;
		return resolver.directoryFor(sessionId) ?? null;
	} catch {
		return null;
	}
}

/**
 * 当前模型的推理强度档位，以及现在生效的是哪一档。
 * @param {object | null} directory 模型目录。
 * @returns {{ levels: { id: string | undefined, name: string }[], index: number, provider: string, model: string } | null} 档位信息；模型没有推理能力时为 null。
 */
function effortInfo(directory) {
	const snapshot = directory?.store?.getSnapshot?.();
	const current = snapshot?.current ?? null;
	if (current === null || typeof current.model !== "string") return null;
	const groups = snapshot.groups ?? [];
	const group = groups.find((item) => item.id === current.provider);
	const model = group?.models?.find((item) => item.id === current.model);
	const reasoning = model?.reasoning ?? null;
	if (reasoning === null || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return null;

	const levels = [];
	// 宿主自己也是这么拼的：能选「提供方默认」时，它排在最前面。
	if (reasoning.defaultEffort === undefined) levels.push({ id: undefined, name: "" });
	for (const effort of reasoning.efforts) levels.push({ id: effort.id, name: String(effort.name ?? effort.id) });

	const effective = current.reasoningEffort ?? reasoning.defaultEffort;
	const at = levels.findIndex((level) => level.id === effective);
	return {
		levels,
		index: at === -1 ? 0 : at,
		provider: current.provider,
		model: current.model,
	};
}

/**
 * 档位的显示名（「提供方默认」那一档由本地文案负责）。
 * @param {{ id: string | undefined, name: string }} level 档位。
 * @param {typeof COPY.zh} t 文案。
 * @returns {string} 显示名。
 */
function effortName(level, t) {
	if (level === undefined) return "";
	return level.id === undefined ? t.effortDefault : level.name;
}

/* ────────────────────────── DOM 构造 ────────────────────────── */

const ICON_SEARCH =
	'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">' +
	'<circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4"/>' +
	'<path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/**
 * 建元素的小工具（不引入 React：宿主组件的容器由 React 管，我们只做外来节点）。
 * @param {string} tag 标签名。
 * @param {Record<string, unknown>} [props] 属性：`class` / `text` / `html` / `on*` / 其余走 setAttribute。
 * @param {Array<Node | string>} [children] 子节点。
 * @returns {HTMLElement} 建好的元素。
 */
function h(tag, props, children) {
	const node = document.createElement(tag);
	if (props !== undefined) {
		for (const [key, value] of Object.entries(props)) {
			if (value === undefined || value === null) continue;
			if (key === "class") node.className = String(value);
			else if (key === "text") node.textContent = String(value);
			else if (key === "html") node.innerHTML = String(value);
			else if (key.startsWith("on") && typeof value === "function") {
				node.addEventListener(key.slice(2).toLowerCase(), value);
			} else node.setAttribute(key, String(value));
		}
	}
	for (const child of children ?? []) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child);
	}
	return node;
}

/**
 * 当前焦点是否落在「用户正在往里打字」的控件上——只有这种情况我们才不去抢焦点。
 * @param {Element | null} node 当前 `document.activeElement`。
 * @returns {boolean} 是否正在打字。
 */
function isTypingField(node) {
	if (node instanceof HTMLTextAreaElement) return true;
	if (node instanceof HTMLElement && node.isContentEditable === true) return true;
	if (!(node instanceof HTMLInputElement)) return false;
	return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"].includes(node.type);
}

/**
 * 造一条搜索条（对话框版带操作按钮，菜单版更紧凑）。
 * @param {"dialog" | "menu"} kind 用途。
 * @param {typeof COPY.zh} t 文案。
 * @returns {{ root: HTMLElement, input: HTMLInputElement, clear: HTMLButtonElement, count: HTMLElement, empty: HTMLElement, actions: HTMLElement | null, select: HTMLButtonElement | null, deselect: HTMLButtonElement | null }} 句柄。
 */
function buildBar(kind, t) {
	const input = /** @type {HTMLInputElement} */ (
		h("input", {
			class: "dms-input",
			type: "text",
			placeholder: t.placeholder,
			"aria-label": t.searchAria,
			autocomplete: "off",
			spellcheck: "false",
		})
	);
	const clear = /** @type {HTMLButtonElement} */ (
		h("button", { class: "dms-clear", type: "button", title: t.clear, "aria-label": t.clear, text: "×" })
	);
	const field = h(
		"div",
		{ class: "dms-field" },
		[h("span", { class: "dms-icon", html: ICON_SEARCH }), input, clear],
	);

	const count = h("span", { class: "dms-count" });
	const empty = h("span", { class: "dms-empty", hidden: "hidden" });
	const meta = h("div", { class: "dms-meta" }, [count, empty]);

	/** @type {HTMLButtonElement | null} */
	let select = null;
	/** @type {HTMLButtonElement | null} */
	let deselect = null;
	/** @type {HTMLElement | null} */
	let actions = null;
	if (kind === "dialog") {
		select = /** @type {HTMLButtonElement} */ (
			h("button", { class: "dms-btn", type: "button", "data-dms-act": "select", text: t.selectResults })
		);
		deselect = /** @type {HTMLButtonElement} */ (
			h("button", { class: "dms-btn", type: "button", "data-dms-act": "deselect", text: t.deselectResults })
		);
		actions = h("div", { class: "dms-actions", hidden: "hidden" }, [select, deselect]);
		meta.append(actions);
	}

	const root = h("div", { class: `dms-bar dms-bar-${kind}`, "data-dms-bar": kind }, [field, meta]);
	return { root, input, clear, count, empty, actions, select, deselect };
}

/* ────────────────────────── 识别宿主结构 ────────────────────────── */

/**
 * 是否是「模型候选列表」：一个只装 `<li>`、每个 `<li>` 里都有复选框的 `<ul>`。
 * 全应用只有模型候选弹窗符合这个形状（已核对全部内建客户端包），
 * 因此不依赖任何哈希类名。
 * @param {Element} ul 待判定元素。
 * @returns {boolean} 是否命中。
 */
function isCandidateList(ul) {
	if (!(ul instanceof HTMLUListElement)) return false;
	if (ul.dataset.dmsBar !== undefined) return false;
	const items = ul.children;
	if (items.length === 0) return false;
	for (const item of items) {
		if (item.tagName !== "LI") return false;
		if (item.querySelector('input[type="checkbox"]') === null) return false;
	}
	return true;
}

/**
 * 一行的模型 id（宿主在 `<label>` 里放复选框 + `<span>` 文本）。
 * @param {Element} li 候选行。
 * @returns {string} 模型 id。
 */
function rowId(li) {
	const span = li.querySelector("label > span");
	return (span ?? li).textContent?.trim() ?? "";
}

/** 候选列表的所有行。 */
function candidateRows(ul) {
	return Array.from(ul.children).filter((item) => item.tagName === "LI");
}

/**
 * 一个分组的标题文本：宿主用 `aria-labelledby` 指向标题节点，退化情况下取
 * 分组里的第一个非按钮子节点。
 * @param {Element} section 分组。
 * @returns {string} 线路（提供方）显示名。
 */
function sectionTitle(section) {
	const labelledBy = section.getAttribute("aria-labelledby");
	if (labelledBy !== null && labelledBy !== "") {
		const node = section.ownerDocument.getElementById(labelledBy);
		if (node !== null) return (node.textContent ?? "").trim();
	}
	const first = section.firstElementChild;
	if (first !== null && first.tagName !== "BUTTON") return (first.textContent ?? "").trim();
	return "";
}

/**
 * 把菜单拆成「线路 → 模型」两层（`section[role=group]` 就是一条线路）。
 * @param {Element} menu 菜单根。
 * @returns {{ section: Element, name: string, items: { node: Element, id: string, checked: boolean }[] }[]} 线路数组。
 */
function providerSections(menu) {
	return Array.from(menu.querySelectorAll('section[role="group"]')).map((section) => ({
		section,
		name: sectionTitle(section),
		items: Array.from(section.querySelectorAll(MENU_ITEM_SELECTOR)).map((node) => ({
			node,
			/** 宿主按钮上只有显示名（模型 id 在 React key 里，DOM 上看不到），搜索与分组都用它。 */
			label: ((node.getAttribute("title") ?? "").trim() || (node.textContent ?? "").trim()),
			checked: node.getAttribute("aria-checked") === "true",
		})),
	}));
}

/**
 * 菜单里的全部模型项（扫描阶段用来判断「这个菜单值不值得介入」）。
 * @param {Element} menu 菜单根。
 * @returns {{ sections: Element[], items: Element[], providers: ReturnType<typeof providerSections> }} 分组与模型项。
 */
function menuParts(menu) {
	const providers = providerSections(menu);
	return {
		sections: providers.map((provider) => provider.section),
		items: providers.flatMap((provider) => provider.items.map((item) => item.node)),
		providers,
	};
}

/* ────────────────────────── 控制器 ────────────────────────── */

/** 已挂载的搜索条：宿主元素 → 控制器。 */
const mounted = new Map();

/**
 * 行/项可见性由 `style.display` 控制（宿主不管理该属性，因此不会被 React 覆盖）。
 * @param {HTMLElement} node 目标节点。
 * @param {boolean} visible 是否可见。
 */
function setVisible(node, visible) {
	if (visible) {
		if (node.style.display === "none") node.style.removeProperty("display");
	} else if (node.style.display !== "none") node.style.setProperty("display", "none");
}

/**
 * 把容器同步成给定的一批节点：只删该消失的、只插该新增或该挪位置的，
 * **绝不整片重建**。
 *
 * 为什么这条这么重要：鼠标点击会先把焦点给被点的按钮。如果重绘时把那个按钮删掉，
 * 浏览器会把焦点掉回 body，宿主的 `onBlur`（它监听菜单根上的 focusout）就会认为
 * 「用户点到菜单外面去了」而把整个菜单关掉——表现就是「点了线路，菜单直接没了」。
 * 复用节点身份，焦点就不会丢。
 * @param {HTMLElement} container 容器。
 * @param {HTMLElement[]} wanted 目标子节点（顺序即最终顺序）。
 */
function syncNodes(container, wanted) {
	const keep = new Set(wanted);
	for (const node of Array.from(container.children)) if (!keep.has(node)) node.remove();
	let anchor = container.firstChild;
	for (const node of wanted) {
		if (node === anchor) {
			anchor = anchor.nextSibling;
			continue;
		}
		container.insertBefore(node, anchor);
	}
}

/**
 * 建或复用一颗可点按钮，并把它刷成目标状态。
 * @param {Map<string, { node: HTMLElement, onClick: () => void }>} cache 复用表。
 * @param {string} key 身份键（线路名 / 模型名 / 家族名）。
 * @param {object} spec 目标状态：`className` / `parts`（两个 span 的类名）/ `label` / `meta` / `attrs` / `onClick`。
 * @returns {HTMLElement} 可放进容器的按钮。
 */
function reuseButton(cache, key, spec) {
	let entry = cache.get(key);
	if (entry === undefined) {
		const node = h("button", { class: spec.className, type: "button" }, [
			h("span", { class: spec.parts[0] }),
			h("span", { class: spec.parts[1] }),
		]);
		entry = { node, onClick: null };
		// 事件只挂一次：回调每次都从 entry 上现取，所以永远指着最新的那个模型项。
		node.addEventListener("click", () => entry.onClick?.());
		cache.set(key, entry);
	}
	const { node } = entry;
	entry.onClick = spec.onClick;

	if (node.className !== spec.className) node.className = spec.className;
	for (const [name, value] of Object.entries(spec.attrs ?? {})) {
		if (value === null || value === undefined) {
			if (node.hasAttribute(name)) node.removeAttribute(name);
		} else if (node.getAttribute(name) !== String(value)) {
			node.setAttribute(name, String(value));
		}
	}
	const [primary, secondary] = node.children;
	if (primary.textContent !== spec.label) primary.textContent = spec.label;
	if (secondary !== undefined && secondary.textContent !== spec.meta) secondary.textContent = spec.meta;
	return node;
}

/** 复用表瘦身：只留这一轮真正用到的键，避免模型换了一轮后无限增长。 */
function pruneCache(cache, used) {
	for (const key of [...cache.keys()]) if (!used.has(key)) cache.delete(key);
}

/** 刷新对话框搜索条：过滤、计数、按钮可见性。 */
function renderDialog(ctl) {
	const rows = candidateRows(ctl.ul);
	const ids = rows.map(rowId);
	const { matches, fuzzy } = matchIds(ids, ctl.input.value);
	rows.forEach((row, index) => setVisible(row, matches[index]));

	const shown = matches.filter(Boolean).length;
	let picked = 0;
	for (const row of rows) {
		if (row.querySelector('input[type="checkbox"]')?.checked === true) picked += 1;
	}
	ctl.count.textContent = `${format(ctl.t.count, { shown, total: rows.length })} · ${format(ctl.t.selected, { picked })}`;

	const query = parseQuery(ctl.input.value);
	if (query.length > 0 && shown === 0) {
		ctl.empty.textContent = ctl.t.empty;
		ctl.empty.removeAttribute("hidden");
	} else if (query.length > 0 && fuzzy) {
		ctl.empty.textContent = ctl.t.fuzzy;
		ctl.empty.removeAttribute("hidden");
	} else {
		ctl.empty.setAttribute("hidden", "hidden");
	}
	ctl.clear.hidden = ctl.input.value.length === 0;
	if (ctl.actions !== null) ctl.actions.hidden = query.length === 0;
	ctl.matches = matches;
	ctl.rows = rows;
}

/**
 * 空结果/模糊提示的统一切换。
 * @param {object} ctl 控制器。
 * @param {string | null} text 要显示的文字，`null` 表示隐藏。
 */
function showHint(ctl, text) {
	if (text === null) {
		ctl.empty.setAttribute("hidden", "hidden");
		return;
	}
	ctl.empty.textContent = text;
	ctl.empty.removeAttribute("hidden");
}

/**
 * 左栏：线路列表。当前线路高亮，带模型条数；搜索时同时按「线路名」和「线路里的模型名」筛。
 * 节点按线路名复用（见 {@link reuseButton}），所以点一下不会把焦点弄丢、菜单不会被关掉。
 * @param {object} ctl 控制器。
 * @param {object[]} view 线路视图。
 * @param {string[]} terms 搜索关键词。
 * @returns {number} 命中的线路数。
 */
function renderVendorColumn(ctl, view, terms) {
	const hits = view.filter((provider) => provider.nameHit || provider.matched.length > 0);
	const used = new Set();
	const nodes = [];

	const pushVendor = (key, label, meta, active, onClick) => {
		used.add(key);
		nodes.push(
			reuseButton(ctl.cache.vendors, key, {
				className: `dms-vendor${active ? " dms-vendorOn" : ""}${key === "*" ? " dms-vendorAll" : ""}`,
				parts: ["dms-vendorName", "dms-vendorMeta"],
				label,
				meta,
				attrs: {
					"data-dms-provider": key,
					"aria-pressed": active ? "true" : "false",
					title: label,
				},
				onClick,
			}),
		);
	};

	// 「所有线路」项：搜索结果散在多条线路上时出现，进了这个模式就一直留着，
	// 否则清空搜索后用户会看不到自己还在「所有线路」里。
	const withHits = view.filter((provider) => provider.matched.length > 0);
	if (ctl.all || (terms.length > 0 && withHits.length > 1)) {
		const total =
			terms.length === 0
				? view.reduce((sum, provider) => sum + provider.items.length, 0)
				: withHits.reduce((sum, provider) => sum + provider.matched.length, 0);
		pushVendor("*", ctl.t.allProviders, String(total), ctl.all, () => selectAllProviders(ctl));
	}

	for (const provider of hits) {
		pushVendor(
			provider.name,
			provider.name || "—",
			String(terms.length === 0 ? provider.items.length : provider.matched.length),
			ctl.provider === provider.name && !ctl.all,
			() => selectProvider(ctl, provider.name),
		);
	}

	syncNodes(ctl.vendors, nodes);
	pruneCache(ctl.cache.vendors, used);
	showHint(ctl, terms.length > 0 && hits.length === 0 ? ctl.t.noProvider : null);
	return hits.length;
}

/**
 * 把一批模型项按家族分组（DeepSeek / GPT / Claude / 其他…），
 * 家族顺序按 {@link familyRank}，组内保持宿主原来的顺序。
 * @param {{ node: Element, label: string, checked: boolean }[]} items 模型项。
 * @returns {{ family: string, items: object[] }[]} 分组结果。
 */
function familyGroups(items) {
	const byFamily = new Map();
	for (const item of items) {
		const key = familyOf(item.label);
		if (!byFamily.has(key)) byFamily.set(key, []);
		byFamily.get(key).push(item);
	}
	return [...byFamily.entries()]
		.sort((a, b) => familyRank(a[0]) - familyRank(b[0]))
		.map(([family, list]) => ({ family, items: list }));
}

/**
 * 模型行：点击直接转交给宿主自己的按钮——选择、关菜单、错误提示全走宿主既有逻辑，
 * 我们只负责把它画成右栏的一行。节点按「线路 + 显示名 + 同名序号」复用：
 * 不同线路里可能有同名模型（中转站很常见），只用显示名当键会让它们互相顶掉。
 * @param {object} ctl 控制器。
 * @param {{ node: Element, label: string, checked: boolean }} item 模型项。
 * @param {Set<string>} used 本轮用到的键。
 * @param {string} scope 所属线路名（跨线路视图里用来区分同名模型）。
 * @param {Map<string, number>} keyCounts 同名计数（同一条线路里也可能重名）。
 * @returns {HTMLElement} 行按钮。
 */
function modelRow(ctl, item, used, scope, keyCounts) {
	const base = `${scope}\u0000${item.label}`;
	const nth = keyCounts.get(base) ?? 0;
	keyCounts.set(base, nth + 1);
	const key = `model:${base}\u0000${nth}`;
	used.add(key);
	return reuseButton(ctl.cache.models, key, {
		className: `dms-option${item.checked ? " dms-optionOn" : ""}`,
		parts: ["dms-optionLabel", "dms-optionCheck"],
		label: item.label,
		meta: item.checked ? "✓" : "",
		attrs: {
			role: "option",
			"aria-selected": item.checked ? "true" : "false",
			"aria-label": item.label,
			title: item.label,
			"data-dms-model": item.label,
		},
		onClick: () => {
			/** @type {HTMLElement} */ (item.node).click();
		},
	});
}

/**
 * 右栏：模型子列表。按家族分好组，当前模型打勾，搜不到时给提示。
 * @param {object} ctl 控制器。
 * @param {object[]} view 线路视图。
 * @param {string[]} terms 搜索关键词。
 * @returns {number} 显示的模型数。
 */
function renderModelColumn(ctl, view, terms) {
	const used = new Set();
	const keyCounts = new Map();
	const wanted = [];
	let shown = 0;

	/** 往右栏追加「家族标题 + 该家族的模型」。标题每次重建（不持有焦点），模型行复用。 */
	const pushGroup = (title, items, scope) => {
		if (items.length === 0) return;
		wanted.push(
			h("div", { class: "dms-groupHead", "data-dms-grouphead": title }, [
				h("span", { text: title }),
				h("span", { class: "dms-groupN", text: String(items.length) }),
			]),
		);
		for (const item of items) wanted.push(modelRow(ctl, item, used, scope, keyCounts));
		shown += items.length;
	};

	const pushProviderHead = (title, count) => {
		wanted.push(
			h("div", { class: "dms-providerHead" }, [
				h("span", { text: title }),
				h("span", { class: "dms-groupN", text: String(count) }),
			]),
		);
	};

	if (ctl.all) {
		// 跨线路：每条线路一个标题，里面再按家族分。
		for (const provider of view) {
			const { matches } = matchIds(
				provider.items.map((item) => item.label),
				ctl.input.value,
			);
			const hit = provider.items.filter((_, index) => matches[index]);
			if (hit.length === 0) continue;
			pushProviderHead(provider.name || "—", hit.length);
			for (const group of familyGroups(hit)) {
				pushGroup(familyLabel(group.family, ctl.lang), group.items, provider.name);
			}
		}
	} else {
		const chosen = view.find((provider) => provider.name === ctl.provider);
		if (chosen === undefined) {
			syncNodes(ctl.models, []);
			pruneCache(ctl.cache.models, used);
			ctl.rows = [];
			ctl.count.textContent = "";
			return 0;
		}
		const { matches, fuzzy } = matchIds(
			chosen.items.map((item) => item.label),
			ctl.input.value,
		);
		const hit = chosen.items.filter((_, index) => matches[index]);
		for (const group of familyGroups(hit)) pushGroup(familyLabel(group.family, ctl.lang), group.items, chosen.name);
		if (hit.length === 0 && terms.length > 0) showHint(ctl, fuzzy ? ctl.t.fuzzy : ctl.t.empty);
		ctl.count.textContent = format(ctl.t.count, { shown: hit.length, total: chosen.items.length });
	}

	syncNodes(ctl.models, wanted);
	pruneCache(ctl.cache.models, used);
	ctl.rows = wanted.filter((node) => node.classList.contains("dms-option"));
	return shown;
}

/**
 * 切到某条线路：右栏随之刷新（左栏保持可见，这就是「选了线路右边出子列表」）。
 * @param {object} ctl 控制器。
 * @param {string} name 线路名。
 */
function selectProvider(ctl, name) {
	ctl.all = false;
	ctl.provider = name;
	ctl.effortPreview = null;
	renderMenu(ctl);
}

/**
 * 切到「所有线路」：跨线路搜索命中的模型。
 * @param {object} ctl 控制器。
 */
function selectAllProviders(ctl) {
	ctl.all = true;
	ctl.effortPreview = null;
	renderMenu(ctl);
}

/**
 * 刷新整个菜单：左栏线路、右栏模型（家族分组）、推理强度能量条、计数。
 *
 * 三条重要约定：
 * 1. 宿主的模型列表**永远**是 `display:none`——右栏是我们按家族重画的一份，
 *    点击时把事件转交给对应宿主按钮，选择逻辑仍然只有一个真相来源。
 * 2. 两栏的按钮按名字复用节点，绝不整片重建：删掉带焦点的按钮会让宿主以为
 *    「点到外面了」而关掉整个菜单。
 * 3. 每次重绘都重读宿主 DOM，所以宿主自己换模型/刷新目录后这里自动跟上。
 * @param {object} ctl 控制器。
 */
function renderMenu(ctl) {
	const providers = providerSections(ctl.menu);
	const terms = parseQuery(ctl.input.value);
	// 宿主把分组包在一层滚动容器里（`.groups`），收起它就能藏掉整份原始列表。
	// 但如果哪天的结构变成「分组直接挂在菜单下」，收起它等于把菜单自己藏了——
	// 那样面板会变成 0 尺寸、连焦点都进不去，所以这种情况退化成逐个藏分组。
	const parent = providers.length > 0 ? providers[0].section.parentElement : null;
	const container = parent !== ctl.menu ? parent : null;
	if (container !== null) setVisible(container, false);
	else for (const provider of providers) setVisible(provider.section, false);

	const view = providers.map((provider) => {
		const matched = provider.items.filter((item) => matchesTerms(item.label, terms, false));
		return {
			...provider,
			matched,
			nameHit: terms.length === 0 || matchesTerms(provider.name, terms, false),
			current: provider.items.some((item) => item.checked),
		};
	});

	// 默认停在「当前模型所在的线路」；线路没了就退回第一条。
	if (!ctl.all && view.every((provider) => provider.name !== ctl.provider)) {
		const fallback = view.find((provider) => provider.current) ?? view[0];
		ctl.provider = fallback === undefined ? null : fallback.name;
	}
	// 搜索时如果当前线路一条都没命中，就把右栏挪到第一个有命中的线路，
	// 省掉「明明搜到了却要自己去左栏再点一下」的这一步。
	if (!ctl.all && terms.length > 0) {
		const chosen = view.find((provider) => provider.name === ctl.provider);
		if (chosen !== undefined && chosen.matched.length === 0) {
			const hit = view.find((provider) => provider.matched.length > 0);
			if (hit !== undefined) ctl.provider = hit.name;
		}
	}

	if (ctl.options.drilldown) {
		ctl.split.removeAttribute("hidden");
		ctl.legacy.setAttribute("hidden", "hidden");
		ctl.input.placeholder = ctl.t.placeholderProviders;
		renderVendorColumn(ctl, view, terms);
		renderModelColumn(ctl, view, terms);
	} else {
		// 老样子：一栏列出所有线路的所有模型 + 搜索框。
		ctl.split.setAttribute("hidden", "hidden");
		ctl.legacy.removeAttribute("hidden");
		ctl.input.placeholder = ctl.t.placeholderModels;
		const used = new Set();
		const keyCounts = new Map();
		const wanted = [];
		let shown = 0;
		let total = 0;
		for (const provider of view) {
			total += provider.items.length;
			const { matches } = matchIds(
				provider.items.map((item) => item.label),
				ctl.input.value,
			);
			const hit = provider.items.filter((_, index) => matches[index]);
			if (hit.length === 0) continue;
			wanted.push(
				h("div", { class: "dms-providerHead" }, [
					h("span", { text: provider.name || "—" }),
					h("span", { class: "dms-groupN", text: String(hit.length) }),
				]),
			);
			for (const item of hit) wanted.push(modelRow(ctl, item, used, provider.name, keyCounts));
			shown += hit.length;
		}
		syncNodes(ctl.legacy, wanted);
		pruneCache(ctl.cache.models, used);
		ctl.rows = wanted.filter((node) => node.classList.contains("dms-option"));
		ctl.count.textContent = format(ctl.t.count, { shown, total });
		showHint(ctl, shown === 0 && terms.length > 0 ? ctl.t.empty : null);
	}

	ctl.clear.hidden = ctl.input.value.length === 0;
	renderEffortBar(ctl);
}
/** 当前可见的候选行。 */
function visibleRows(ctl) {
	return candidateRows(ctl.ul).filter((row) => row.style.display !== "none");
}

/**
 * 右栏当前画出来的模型行（↑↓ / 回车都走它）。
 * @param {object} ctl 控制器。
 * @returns {HTMLElement[]} 模型行按钮。
 */
function visibleItems(ctl) {
	return ctl.rows.filter((row) => row.isConnected);
}

/**
 * 我们注入的节点里，当前可见的按钮（第一层的线路按钮 / 家族标签）。
 * @param {Element} container 注入的容器。
 * @returns {HTMLElement[]} 可见按钮。
 */
function visibleOwnButtons(container) {
	return Array.from(container.querySelectorAll("button")).filter((node) => node.style.display !== "none");
}

/**
 * 在我们自己的按钮列表里用 ↑↓ 移动焦点，并把事件拦住——
 * 否则宿主的菜单会把焦点交给它自己那些（此刻被隐藏的）项。
 * @param {Element} container 注入的容器。
 * @returns {(event: KeyboardEvent) => void} 事件处理器。
 */
function ownListKeyNav(container) {
	return (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const buttons = visibleOwnButtons(container);
		if (buttons.length === 0) return;
		event.preventDefault();
		event.stopPropagation();
		const at = buttons.indexOf(/** @type {HTMLElement} */ (event.target));
		const step = event.key === "ArrowDown" ? 1 : -1;
		const next = at === -1 ? (step === 1 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
		buttons[next].focus();
	};
}

/** 把焦点放到某个复选框上（供 ↑↓ 在结果间移动）。 */
function focusRow(row) {
	row?.querySelector('input[type="checkbox"]')?.focus();
}

/**
 * 给「获取模型列表」对话框挂上搜索条。
 * @param {Element} ul 候选列表。
 * @param {typeof DEFAULT_OPTIONS} options 选项。
 * @returns {object} 控制器。
 */
function mountDialog(ul, options) {
	const body = ul.parentElement;
	if (body === null) return null;
	const lang = pickLang(options.lang);
	const t = COPY[lang];
	const bar = buildBar("dialog", t);
	const ctl = {
		kind: "dialog",
		host: ul,
		ul,
		bar,
		t,
		lang,
		input: bar.input,
		count: bar.count,
		empty: bar.empty,
		clear: bar.clear,
		actions: bar.actions,
		matches: [],
		rows: [],
	};

	const rerender = () => renderDialog(ctl);
	bar.input.addEventListener("input", rerender);
	bar.clear.addEventListener("click", () => {
		bar.input.value = "";
		rerender();
		bar.input.focus();
	});
	if (bar.select !== null) {
		bar.select.addEventListener("click", () => {
			for (const row of visibleRows(ctl)) {
				const box = row.querySelector('input[type="checkbox"]');
				if (box !== null && box.checked === false) box.click();
			}
			rerender();
		});
	}
	if (bar.deselect !== null) {
		bar.deselect.addEventListener("click", () => {
			for (const row of visibleRows(ctl)) {
				const box = row.querySelector('input[type="checkbox"]');
				if (box !== null && box.checked === true) box.click();
			}
			rerender();
		});
	}

	// 搜索框：Esc 清空（不关弹窗）、↑↓ 下移到结果、回车选中唯一结果。
	bar.input.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && bar.input.value.length > 0) {
			event.preventDefault();
			event.stopPropagation();
			bar.input.value = "";
			rerender();
			return;
		}
		if (event.key === "Enter") {
			const rows = visibleRows(ctl);
			if (rows.length === 1) {
				event.preventDefault();
				rows[0].querySelector('input[type="checkbox"]')?.click();
				rerender();
			} else if (rows.length > 1) {
				event.preventDefault();
				focusRow(rows[0]);
			}
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const rows = visibleRows(ctl);
			focusRow(event.key === "ArrowDown" ? rows[0] : rows[rows.length - 1]);
		}
	});

	// 在结果之间用 ↑↓ 移动，Esc 回到搜索框（都是我们自己的节点，不影响宿主）。
	ctl.onKeyDown = (event) => {
		if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") {
			const rows = visibleRows(ctl);
			const at = rows.indexOf(/** @type {Element} */ (event.target.closest("li")));
			if (event.key === "Escape") {
				event.preventDefault();
				bar.input.focus();
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			if (rows.length === 0) return;
			const next = (Math.max(at, 0) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
			focusRow(rows[next]);
		}
	};
	ul.addEventListener("keydown", ctl.onKeyDown);

	body.insertBefore(bar.root, body.firstChild);
	rerender();
	if (options.autoFocus) {
		// 等宿主这一帧渲染完再聚焦（宿主刚处理完点击，焦点还停在「获取可用模型」按钮上）。
		// 唯一不抢的情况：用户此刻正在某个输入框里打字。
		window.requestAnimationFrame(() => {
			if (bar.root.isConnected && !isTypingField(document.activeElement)) bar.input.focus();
		});
	}
	mounted.set(ul, ctl);
	return ctl;
}

/**
 * 造一条推理强度能量条：左边标题、中间可拖动的分段轨道、右边当前档位名。
 * @param {typeof COPY.zh} t 文案。
 * @returns {{ root: HTMLElement, track: HTMLElement, value: HTMLElement, error: HTMLElement, segs: HTMLElement }} 句柄。
 */
function buildEffortBar(t) {
	const track = h("div", {
		class: "dms-track",
		"data-dms-track": "1",
		role: "slider",
		tabindex: "0",
		"aria-label": t.effortAria,
		"aria-orientation": "horizontal",
	});
	const value = h("span", { class: "dms-effortValue" });
	const error = h("span", { class: "dms-effortErr", hidden: "hidden" });
	const root = h("div", { class: "dms-effort", "data-dms-effort": "1", hidden: "hidden" }, [
		h("span", { class: "dms-effortLabel", text: t.effortLabel }),
		track,
		value,
		error,
	]);
	return { root, track, value, error, segs: track };
}

/**
 * 画能量条：几档就几格，填到当前档；拖动时跟着手指走。
 * 档位数据每次都从宿主的目录快照现读，所以模型一换、设置一改，条子自己就对了。
 * @param {object} ctl 控制器。
 */
function renderEffortBar(ctl) {
	const info = effortInfo(ctl.directory);
	ctl.effortInfo = info;
	if (info === null) {
		ctl.effort.root.setAttribute("hidden", "hidden");
		return;
	}
	const shown = ctl.effortPreview ?? ctl.effortOverride ?? info.index;
	const count = info.levels.length;

	ctl.effort.track.replaceChildren(
		...info.levels.map((level, index) => {
			const name = effortName(level, ctl.t);
			const seg = h("span", {
				class: `dms-seg${index <= shown ? " dms-segOn" : ""}${
					ctl.effortOverride !== null && index === ctl.effortOverride ? " dms-segPending" : ""
				}`,
				"data-dms-seg": String(index),
				title: name,
				"aria-hidden": "true",
			});
			return seg;
		}),
	);

	ctl.effort.track.setAttribute("aria-valuemin", "1");
	ctl.effort.track.setAttribute("aria-valuemax", String(count));
	ctl.effort.track.setAttribute("aria-valuenow", String(shown + 1));
	// 空格用 label 拼，拖动时右边实时跟着变，松手才落库。
	ctl.effort.track.setAttribute("aria-valuetext", effortName(info.levels[shown], ctl.t));
	ctl.effort.track.setAttribute("aria-busy", ctl.effortBusy ? "true" : "false");
	ctl.effort.value.textContent = ctl.effortBusy
		? ctl.t.effortPending
		: effortName(info.levels[shown], ctl.t);

	if (ctl.effortError === null) ctl.effort.error.setAttribute("hidden", "hidden");
	else {
		ctl.effort.error.textContent = format(ctl.t.effortFailed, { message: ctl.effortError });
		ctl.effort.error.removeAttribute("hidden");
	}
	ctl.effort.root.removeAttribute("hidden");
}

/**
 * 落到宿主：调的就是宿主自己的 `directory.select()`，和它菜单里点一下完全等价。
 * @param {object} ctl 控制器。
 * @param {number} index 目标档位下标。
 * @returns {Promise<void>} 提交完成。
 */
async function commitEffort(ctl, index) {
	const info = ctl.effortInfo;
	if (info === null || ctl.directory === null || ctl.effortBusy) return;
	const level = info.levels[index];
	if (level === undefined || index === info.index) {
		ctl.effortPreview = null;
		ctl.effortOverride = null;
		renderEffortBar(ctl);
		return;
	}
	ctl.effortPreview = null;
	ctl.effortOverride = index; // 乐观显示：先动条子，失败自然回滚（快照没变）
	ctl.effortBusy = true;
	ctl.effortError = null;
	renderEffortBar(ctl);
	try {
		await ctl.directory.select({
			provider: info.provider,
			model: info.model,
			...(level.id === undefined ? {} : { reasoningEffort: level.id }),
		});
	} catch (error) {
		ctl.effortError = String(error?.message ?? error);
	} finally {
		ctl.effortBusy = false;
		ctl.effortOverride = null;
		try {
			renderEffortBar(ctl);
		} catch {
			/* 菜单可能已经关掉了 */
		}
	}
}

/**
 * 能量条的指针交互：按下即预览、拖动跟随、松手提交。
 * @param {object} ctl 控制器。
 */
function wireEffortDrag(ctl) {
	const track = ctl.effort.track;

	/** 指针位置 → 档位下标；拿不到几何信息时退回「点到哪一格」。 */
	const indexAt = (event) => {
		const seg = event.target instanceof Element ? event.target.closest("[data-dms-seg]") : null;
		if (seg !== null) return Number(seg.getAttribute("data-dms-seg"));
		const count = ctl.effortInfo?.levels.length ?? 0;
		if (count === 0) return null;
		const rect = track.getBoundingClientRect();
		if (!(rect.width > 0)) return null;
		const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 0.999999);
		return Math.min(count - 1, Math.floor(ratio * count));
	};

	track.addEventListener("pointerdown", (event) => {
		if (ctl.effortInfo === null || ctl.effortBusy) return;
		event.preventDefault();
		ctl.dragging = true;
		try {
			track.setPointerCapture(event.pointerId);
		} catch {
			/* 老浏览器没有指针捕获也能用 */
		}
		const at = indexAt(event);
		if (at !== null) {
			ctl.effortPreview = at;
			renderEffortBar(ctl);
		}
	});

	track.addEventListener("pointermove", (event) => {
		if (ctl.dragging !== true) return;
		const at = indexAt(event);
		if (at === null || at === ctl.effortPreview) return;
		event.preventDefault();
		ctl.effortPreview = at;
		renderEffortBar(ctl);
	});

	const release = (event) => {
		if (ctl.dragging !== true) return;
		ctl.dragging = false;
		try {
			track.releasePointerCapture(event.pointerId);
		} catch {
			/* 同上 */
		}
		const at = ctl.effortPreview ?? indexAt(event);
		if (at === null) return;
		commitEffort(ctl, at);
	};
	track.addEventListener("pointerup", release);
	track.addEventListener("pointercancel", release);

	// 键盘：左右/上下直接调一档，立即提交（和点一格等价）。
	track.addEventListener("keydown", (event) => {
		const info = ctl.effortInfo;
		if (info === null) return;
		const step =
			event.key === "ArrowRight" || event.key === "ArrowUp"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowDown"
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		event.stopPropagation();
		const next = Math.min(Math.max((ctl.effortPreview ?? info.index) + step, 0), info.levels.length - 1);
		ctl.effortPreview = null;
		commitEffort(ctl, next);
	});
}

/**
 * 给输入框旁的模型菜单挂上搜索条。
 * @param {Element} menu 菜单根。
 * @param {typeof DEFAULT_OPTIONS} options 选项。
 * @returns {object} 控制器。
 */
function mountMenu(menu, options) {
	const lang = pickLang(options.lang);
	const t = COPY[lang];
	const bar = buildBar("menu", t);

	// 注入节点：搜索条 → 左栏（线路）+ 右栏（模型）→ 推理强度能量条。
	// 左栏右栏都是我们自己的节点，所以可以是真正的两栏级联布局，不必挪动宿主的任何节点。
	const vendors = h("div", {
		class: "dms-col dms-colLeft",
		"data-dms-vendors": "1",
		role: "group",
		"aria-label": t.providersAria,
	});
	const models = h("div", {
		class: "dms-col dms-colRight",
		"data-dms-models": "1",
		role: "listbox",
		"aria-label": t.modelsAria,
	});
	const split = h("div", { class: "dms-split", "data-dms-split": "1" }, [vendors, models]);
	// 关掉两级选择时用的单栏容器（老版一屏列表）。
	const legacy = h("div", { class: "dms-legacy", "data-dms-legacy": "1", hidden: "hidden" });
	const effort = buildEffortBar(t);

	const ctl = {
		kind: "menu",
		host: menu,
		menu,
		bar,
		t,
		lang,
		options,
		input: bar.input,
		count: bar.count,
		empty: bar.empty,
		clear: bar.clear,
		actions: null,
		matches: [],
		providers: [],
		rows: [],
		/** 左栏选中的线路；`all` 为真时表示「所有线路」（跨线路搜索）。 */
		provider: null,
		all: false,
		vendors,
		models,
		split,
		legacy,
		/** 按钮节点复用表：保住节点身份就保住了焦点（见 reuseButton）。 */
		cache: { vendors: new Map(), models: new Map() },
		effort,
		/** 模型目录（拿不到就没有能量条）。 */
		directory: modelDirectory(),
		effortInfo: null,
		effortPreview: null,
		effortOverride: null,
		effortBusy: false,
		effortError: null,
		dragging: false,
		unsubscribe: null,
		nodes: [bar.root, split, legacy, effort.root],
	};
	const rerender = () => renderMenu(ctl);

	bar.input.addEventListener("input", rerender);
	bar.clear.addEventListener("click", () => {
		bar.input.value = "";
		rerender();
		bar.input.focus();
	});

	// 搜索框：Esc 先清空，清空后交还给宿主（宿主自己用 Esc 关菜单）。
	bar.input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (bar.input.value.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				bar.input.value = "";
				rerender();
			} else if (ctl.all) {
				event.preventDefault();
				event.stopPropagation();
				ctl.all = false;
				rerender();
			}
			return;
		}
		if (event.key === "Enter") {
			// 回车只把焦点交给第一个候选，不替用户做选择——误触不该换模型。
			event.preventDefault();
			if (ctl.rows.length === 1) ctl.rows[0].click();
			else ctl.rows[0]?.focus();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const first = event.key === "ArrowDown" ? 0 : ctl.rows.length - 1;
			ctl.rows[first]?.focus();
		}
	});

	vendors.addEventListener("keydown", ownListKeyNav(vendors));
	models.addEventListener("keydown", ownListKeyNav(models));
	wireEffortDrag(ctl);

	// 跟着宿主的目录快照走：换模型、设置生效都会推过来，能量条自己更新。
	try {
		ctl.unsubscribe = ctl.directory?.store?.subscribe?.(() => {
			try {
				renderEffortBar(ctl);
			} catch {
				/* 菜单正在卸载 */
			}
		}) ?? null;
	} catch {
		ctl.unsubscribe = null;
	}

	// 把菜单尺寸钉死：不同线路的模型名长短、条数都不一样，让盒子跟着内容变长变宽很难看。
	// （宿主自己没给 style，这一层不归 React 管，卸载时还原。）
	ctl.menuStyle = {
		width: menu.style.getPropertyValue("width"),
		maxHeight: menu.style.getPropertyValue("max-height"),
	};
	menu.style.setProperty("width", "min(400px, calc(100vw - 32px))");
	menu.style.setProperty("max-height", "calc(100vh - 80px)");

	const anchor = menu.firstChild;
	for (const node of ctl.nodes) menu.insertBefore(node, anchor);
	rerender();
	// 打开菜单时如果停在第一层，就把焦点交给搜索框：打开即可打字。
	window.requestAnimationFrame(() => {
		if (bar.root.isConnected && !isTypingField(document.activeElement)) bar.input.focus();
	});
	mounted.set(menu, ctl);
	return ctl;
}

/** 拆掉一个控制器注入的节点。 */
function unmount(ctl) {
	if (typeof ctl.onKeyDown === "function" && ctl.ul !== undefined) {
		try {
			ctl.ul.removeEventListener("keydown", ctl.onKeyDown);
		} catch {
			/* 宿主已经先一步移除了整棵子树 */
		}
	}
	try {
		ctl.unsubscribe?.();
		ctl.unsubscribe = null;
		// 还原我们钉上去的尺寸，别把宿主的菜单样式留着改过的样子
		for (const [name, value] of Object.entries(ctl.menuStyle ?? {})) {
			if (value === "") ctl.menu.style.removeProperty(name);
			else ctl.menu.style.setProperty(name, value);
		}
		ctl.bar.root.remove();
		for (const node of ctl.nodes ?? []) node.remove();
	} catch {
		/* 同上：注入节点随宿主子树一起消失了 */
	}
}

/**
 * 打开菜单时直接落到「模型」面板：宿主的根面板只有「模型 / 推理等级」两行，
 * 而用户点模型选择器十有八九是为了换模型。每个菜单实例只点一次，绝不循环。
 * 想改推理等级按 Esc 就回得到根面板。
 * @param {Element} menu 菜单根。
 * @param {typeof DEFAULT_OPTIONS} options 选项。
 * @returns {void}
 */
function advanceToModelPane(menu, options) {
	if (!options.openToModels || menu.dataset.dmsAdvanced === "1") return;
	const cells = Array.from(menu.querySelectorAll(':scope > button[role="menuitem"]'));
	const modelCell = cells.find((cell) => /^(模型|Model)/.test((cell.textContent ?? "").trim()));
	if (modelCell === undefined) return;
	menu.dataset.dmsAdvanced = "1";
	/** @type {HTMLElement} */ (modelCell).click();
}

/** 一遍扫描：发现新对话框/菜单就挂上，结构变了或消失了就拆掉。 */
function scan() {
	const options = state.options;
	const live = new Set();

	if (options.dialog) {
		for (const dialog of document.querySelectorAll('[role="dialog"]')) {
			for (const ul of dialog.querySelectorAll("ul")) {
				if (!isCandidateList(ul)) continue;
				if (candidateRows(ul).length < options.minItems) continue;
				if (mounted.has(ul) || mountDialog(ul, options) !== null) live.add(ul);
			}
		}
	}
	if (options.menu) {
		for (const menu of document.querySelectorAll('div[role="menu"]')) {
			const { items } = menuParts(menu);
			if (items.length < options.minItems) {
				// 还没进「模型」面板（根面板只有两行入口）时，按需替用户点一下。
				if (items.length === 0) advanceToModelPane(menu, options);
				continue;
			}
			if (mounted.has(menu) || mountMenu(menu, options) !== null) live.add(menu);
		}
	}

	for (const [host, ctl] of mounted) {
		if (!live.has(host) || !host.isConnected) {
			unmount(ctl);
			mounted.delete(host);
		}
	}
}

/** 模块级状态（选项 + 观察器 + 节流句柄）。 */
const state = {
	options: { ...DEFAULT_OPTIONS },
	observer: null,
	timer: null,
	apply: null,
	/** 客户端根上下文：推理强度那条能量条要靠它取宿主的 modelDirectories 服务。 */
	ctx: null,
};

/**
 * 只处理「刚刚冒出来、还没被接管」的弹窗/菜单。
 *
 * 为什么要单独有这一条同步路径：MutationObserver 的回调是微任务，浏览器要到
 * 当前任务结束后才绘制，所以在回调里立刻接管，用户永远看不到宿主那份原始列表；
 * 换成节流后的 `scan()`（80ms 后）就会先闪一下原样——这正是要避免的。
 * @param {MutationRecord[]} records 本批变更。
 */
function takeoverNow(records) {
	let candidate = false;
	for (const record of records) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== 1) continue;
			const element = /** @type {Element} */ (node);
			if (element.matches?.('[role="menu"], [role="dialog"]') === true) {
				candidate = true;
			} else if (
				typeof element.querySelector === "function" &&
				element.querySelector('[role="menu"], [role="dialog"]') !== null
			) {
				candidate = true;
			}
			if (candidate) break;
		}
		if (candidate) break;
	}
	if (!candidate) return;

	const options = state.options;
	if (options.menu) {
		for (const menu of document.querySelectorAll('div[role="menu"]')) {
			if (mounted.has(menu)) continue;
			const { items } = menuParts(menu);
			if (items.length === 0) advanceToModelPane(menu, options);
			else if (items.length >= options.minItems) mountMenu(menu, options);
		}
	}
	if (options.dialog) {
		for (const dialog of document.querySelectorAll('[role="dialog"]')) {
			for (const ul of dialog.querySelectorAll("ul")) {
				if (!isCandidateList(ul) || mounted.has(ul)) continue;
				if (candidateRows(ul).length >= options.minItems) mountDialog(ul, options);
			}
		}
	}
}

/** 节流调度一次扫描：一次事件风暴最多 80ms 扫一遍，长会话里也不会白烧 CPU。 */
function schedule() {
	if (state.timer !== null) return;
	state.timer = window.setTimeout(() => {
		state.timer = null;
		try {
			scan();
		} catch (error) {
			// 增强层永远不能影响宿主：出问题就退场，控制台留痕。
			console.warn("[dsh-model-cascade] scan failed", error);
		}
	}, 80);
}

/** 观察器回调：先同步接管（防闪烁），再排队做一次兜底的全量扫描。 */
function onMutations(records) {
	try {
		takeoverNow(records);
	} catch (error) {
		console.warn("[dsh-model-cascade] takeover failed", error);
	}
	schedule();
}

/** 用新选项重扫（选项变了要立刻生效）。 */
function rescan() {
	for (const [, ctl] of mounted) unmount(ctl);
	mounted.clear();
	scan();
}

/**
 * 插件入口：注入样式、起观察器、暴露一点控制台开关。
 * @param {import("@deepseek-ai/cordis").Context} ctx 客户端根上下文。
 * @returns {void}
 */
function apply(ctx) {
	state.options = readOptions();
	state.ctx = ctx;
	injectStyles();

	const consoleApi = {
		version: VERSION,
		get options() {
			return { ...state.options };
		},
		/** 改选项并立即生效（写 localStorage，刷新后仍在）。 */
		set(patch) {
			state.options = { ...state.options, ...patch };
			writeOptions(state.options);
			rescan();
			return { ...state.options };
		},
		/** 恢复默认选项。 */
		reset() {
			state.options = { ...DEFAULT_OPTIONS };
			writeOptions(state.options);
			rescan();
			return { ...state.options };
		},
		/** 手动扫一遍（调试用）。 */
		scan,
	};
	// 控制台开关：`dshModelCascade.set({ minItems: 1 })` 等。
	globalThis.dshModelCascade = consoleApi;
	// 改名前的名字：保留一段时间，省得按旧文档敲的人一脸问号。
	globalThis.dshModelSearch = consoleApi;

	const start = () => {
		scan();
		state.observer = new MutationObserver(onMutations);
		state.observer.observe(document.documentElement, { childList: true, subtree: true });
	};
	start();
	state.apply = start;
	console.info(`[dsh-model-cascade] v${VERSION} 已启用（模型列表搜索 + 两级选择 + 推理强度能量条）`);

	ctx.effect(() => () => {
		state.observer?.disconnect();
		state.observer = null;
		if (state.timer !== null) {
			window.clearTimeout(state.timer);
			state.timer = null;
		}
		for (const [, ctl] of mounted) unmount(ctl);
		mounted.clear();
		state.ctx = null;
		delete globalThis.dshModelCascade;
		delete globalThis.dshModelSearch;
	}, "dsh-model-cascade: dom observer");
}

/** 注入样式（同名标签只注入一次，热重载时由 client-modules 负责回收）。 */
function injectStyles() {
	if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-model-cascade";
	tag.dataset.pluginCss = STYLE_TAG_ID;
	tag.textContent = STYLES;
	document.head.append(tag);
}

exports.apply = apply;
exports.inject = [];
exports.name = "dsh-model-cascade";
// 单元测试与调试用的内部面（浏览器里也能 `require("@deepseek-ai/...")` 之外的方式拿到）。
exports.__internals = {
	VERSION,
	DEFAULT_OPTIONS,
	COPY,
	parseQuery,
	isSubsequence,
	matchesTerms,
	matchIds,
	pickLang,
	format,
	isCandidateList,
	menuParts,
	providerSections,
	sectionTitle,
	familyOf,
	familyCounts,
	familyLabel,
	rowId,
	advanceToModelPane,
	takeoverNow,
	renderMenu,
	familyGroups,
	renderEffortBar,
	effortInfo,
	currentSessionId,
	scan,
	state,
	mounted,
	rescan,
};
