/**
 * dsh-model-search — browser half.
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
const VERSION = "1.0.0";

/** 注入样式的标签标识，避免重复注入。 */
const STYLE_TAG_ID = "dsh-model-search/styles.css";

/** 选项在 localStorage 中的键名。 */
const OPTIONS_KEY = "dsh-model-search:options";

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
	/** 界面语言：auto / zh / en。 */
	lang: "auto",
};

/**
 * 模型菜单里「一个可选项」的选择器。
 * 宿主用 `role="menuitemradio"` 标记模型（可选中的项），根面板的入口用 `menuitem`；
 * 两种都收，而且只取分组（`section[role=group]`）里面的，根面板入口不会被误当成模型。
 */
const MENU_ITEM_SELECTOR = 'button[role="menuitemradio"], button[role="menuitem"]';

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
	let stored;
	try {
		stored = JSON.parse(String(window.localStorage.getItem(OPTIONS_KEY) ?? ""));
	} catch {
		return base;
	}
	if (stored === null || typeof stored !== "object") return base;
	if (typeof stored.dialog === "boolean") base.dialog = stored.dialog;
	if (typeof stored.menu === "boolean") base.menu = stored.menu;
	if (typeof stored.autoFocus === "boolean") base.autoFocus = stored.autoFocus;
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
	for (const child of children ?? []) node.append(child);
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
 * 一个模型菜单里的模型按钮（`{role:"menu"}` 下的 `section[role=group]` 分组，
 * 分组外面还套着一层滚动容器，所以要按后代查）。
 * @param {Element} menu 菜单根。
 * @returns {{ sections: Element[], items: Element[] }} 分组与模型项。
 */
function menuParts(menu) {
	const sections = Array.from(menu.querySelectorAll('section[role="group"]'));
	const items = [];
	for (const section of sections) {
		for (const item of section.querySelectorAll(MENU_ITEM_SELECTOR)) items.push(item);
	}
	return { sections, items };
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

/** 刷新菜单搜索条：过滤、计数。 */
function renderMenu(ctl) {
	const { sections, items } = menuParts(ctl.menu);
	const ids = items.map((item) => item.textContent?.trim() ?? "");
	const { matches, fuzzy } = matchIds(ids, ctl.input.value);
	items.forEach((item, index) => setVisible(item, matches[index]));

	for (const section of sections) {
		const visible = Array.from(section.querySelectorAll(MENU_ITEM_SELECTOR)).some(
			(item) => item.style.display !== "none",
		);
		setVisible(section, visible);
	}

	const shown = matches.filter(Boolean).length;
	ctl.count.textContent = format(ctl.t.count, { shown, total: items.length });
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
}

/** 当前可见的候选行。 */
function visibleRows(ctl) {
	return candidateRows(ctl.ul).filter((row) => row.style.display !== "none");
}

/** 当前可见的模型项。 */
function visibleItems(ctl) {
	return menuParts(ctl.menu).items.filter((item) => item.style.display !== "none");
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
 * 给输入框旁的模型菜单挂上搜索条。
 * @param {Element} menu 菜单根。
 * @param {typeof DEFAULT_OPTIONS} options 选项。
 * @returns {object} 控制器。
 */
function mountMenu(menu, options) {
	const lang = pickLang(options.lang);
	const t = COPY[lang];
	const bar = buildBar("menu", t);
	const ctl = {
		kind: "menu",
		host: menu,
		menu,
		bar,
		t,
		lang,
		input: bar.input,
		count: bar.count,
		empty: bar.empty,
		clear: bar.clear,
		actions: null,
		matches: [],
	};
	const rerender = () => renderMenu(ctl);
	bar.input.addEventListener("input", rerender);
	bar.clear.addEventListener("click", () => {
		bar.input.value = "";
		rerender();
		bar.input.focus();
	});
	bar.input.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && bar.input.value.length > 0) {
			// 只清空输入：拦住冒泡，宿主菜单不会因此关掉。
			event.preventDefault();
			event.stopPropagation();
			bar.input.value = "";
			rerender();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const items = visibleItems(ctl);
			if (items.length > 0) items[0].click();
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const items = visibleItems(ctl);
			const target = items[event.key === "ArrowDown" ? 0 : items.length - 1];
			if (target instanceof HTMLElement) target.focus();
		}
	});
	menu.insertBefore(bar.root, menu.firstChild);
	rerender();
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
		ctl.bar.root.remove();
	} catch {
		/* 同上：注入节点随宿主子树一起消失了 */
	}
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
			if (items.length < options.minItems) continue;
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
};

/** 节流调度一次扫描：一次事件风暴最多 80ms 扫一遍，长会话里也不会白烧 CPU。 */
function schedule() {
	if (state.timer !== null) return;
	state.timer = window.setTimeout(() => {
		state.timer = null;
		try {
			scan();
		} catch (error) {
			// 增强层永远不能影响宿主：出问题就退场，控制台留痕。
			console.warn("[dsh-model-search] scan failed", error);
		}
	}, 80);
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
	// 控制台开关：`dshModelSearch.set({ minItems: 1 })` 等。
	globalThis.dshModelSearch = consoleApi;

	const start = () => {
		scan();
		state.observer = new MutationObserver(schedule);
		state.observer.observe(document.documentElement, { childList: true, subtree: true });
	};
	start();
	state.apply = start;
	console.info(`[dsh-model-search] v${VERSION} 已启用（模型列表搜索增强）`);

	ctx.effect(() => () => {
		state.observer?.disconnect();
		state.observer = null;
		if (state.timer !== null) {
			window.clearTimeout(state.timer);
			state.timer = null;
		}
		for (const [, ctl] of mounted) unmount(ctl);
		mounted.clear();
		delete globalThis.dshModelSearch;
	}, "dsh-model-search: dom observer");
}

/** 注入样式（同名标签只注入一次，热重载时由 client-modules 负责回收）。 */
function injectStyles() {
	if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-model-search";
	tag.dataset.pluginCss = STYLE_TAG_ID;
	tag.textContent = STYLES;
	document.head.append(tag);
}

exports.apply = apply;
exports.inject = [];
exports.name = "dsh-model-search";
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
	rowId,
	scan,
	state,
	mounted,
	rescan,
};
