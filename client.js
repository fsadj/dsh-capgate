window.__ModuleLoader__.load({
	id: "dsh-capgate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		/** Dictionary namespace owned by this plugin. */
		const NS = "ui-capgate";

		const en = {
			title: "Capgate",
			description: "Ask once per effect class, then run deterministically. Authorization comes from the user's own words, never from the model.",
			flow: "How a call is decided",
			steps: [
				"extract effect: op × scope × sensitivity × cardinality",
				"project-internal plain read → allow, no interruption",
				"already granted class → allow, zero model calls",
				"batch or wildcard → always ask a human",
				"outside workspace without a matching user sentence → deny",
				"otherwise ask once; the answer is remembered for that class",
			],
			commands: "Commands",
			commandList: "/capgate status · /capgate rules · /capgate reset",
			judge: "Residual LLM review is off by default (judgeMode: residual). When on, it may only deny or ask.",
		};

		const zh = {
			title: "Capgate",
			description: "每类效果只问一次，之后确定性放行。授权只来自用户原话，不来自模型。",
			flow: "一次调用怎么判",
			steps: [
				"抽效果：操作 × 作用域 × 敏感度 × 基数",
				"项目内普通读 → 放行，不打扰",
				"该类已授予 → 放行，零模型调用",
				"批量或通配 → 一律问人",
				"项目外且用户原话没提 → 拒绝",
				"其余问一次；答案按效果类记住",
			],
			commands: "命令",
			commandList: "/capgate status · /capgate rules · /capgate reset",
			judge: "残余 LLM 复核默认关闭（judgeMode: residual）；打开后它也只能拒绝或转人工。",
		};

		function CapgatePage() {
			return jsxs("div", {
				style: { padding: "16px 20px", lineHeight: 1.6, fontSize: 13 },
				children: [
					jsx("p", { style: { opacity: 0.75, margin: "0 0 12px" }, children: en.description }),
					jsx("h4", { style: { margin: "12px 0 6px" }, children: en.flow }),
					jsx("ul", {
						style: { margin: 0, paddingLeft: 18, opacity: 0.85 },
						children: en.steps.map((s, i) => jsx("li", { children: s }, `s${i}`)),
					}),
					jsx("h4", { style: { margin: "14px 0 6px" }, children: en.commands }),
					jsx("code", { style: { fontSize: 12, opacity: 0.85 }, children: en.commandList }),
					jsx("p", { style: { opacity: 0.6, margin: "12px 0 0", fontSize: 12 }, children: en.judge }),
				],
			});
		}

		/** Required client services (cordis fiber inject). */
		const inject = ["slots", "locale"];

		/**
		 * Register the Capgate page on the Plugins page while the host composes slots.
		 * Everything is defensive: a missing service leaves the page unregistered
		 * rather than breaking the client.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			try {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { en, zh }), "ui-capgate: dictionaries");
				ctx.effect(() => ctx.slots.register({
					name: "plugins.item",
					id: "capgate",
					order: 40,
					label: () => t("title"),
					locale: NS,
					inject: () => ({}),
				}, CapgatePage), "ui-capgate: page");
			} catch (err) {
				console.warn("[capgate] client page not registered:", err && err.message ? err.message : err);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
