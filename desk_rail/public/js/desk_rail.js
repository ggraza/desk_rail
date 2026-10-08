/**
 * Desk Rail — a persistent workspace navigation rail and instant-redirect
 * navigation for the Frappe / ERPNext desk.
 *
 * Copyright (c) 2026, G2Virtu — GNU AGPL v3 (see license.txt)
 *
 * Design goals: load once, stable. The layout (rail width + content offset +
 * hidden native sidebar) is committed to <html> SYNCHRONOUSLY before first
 * paint, so nothing shifts afterwards. There is deliberately NO opacity masking
 * or route-transition observer — Frappe's own page rendering is left untouched,
 * which is what keeps loads flicker-free.
 */

(function () {
	"use strict";

	const boot = window.frappe && window.frappe.boot;
	const cfg = (boot && boot.desk_rail) || {};
	if (!cfg.enabled) return;

	const LS_COLLAPSED = "desk_rail:collapsed";
	const LS_EXPANDED = "desk_rail:expanded";

	// ── resolve collapsed state synchronously (so the offset is right at paint)
	let collapsed = false;
	try {
		const s = localStorage.getItem(LS_COLLAPSED);
		if (s === "1") collapsed = true;
		else if (s === null && cfg.default_collapsed_on_mobile &&
			window.matchMedia("(max-width: 768px)").matches) collapsed = true;
	} catch (e) {}

	// ── phase 1: lock layout on <html> before first paint (zero shift) ──────
	const root = document.documentElement;
	root.style.setProperty("--dr-rail-w", (cfg.rail_width || 274) + "px");
	root.classList.add("dr-rail-active");
	if (collapsed) root.classList.add("dr-rail-collapsed");
	if (cfg.full_width_navbar) root.classList.add("dr-fullwidth-navbar");
	if (cfg.hide_list_filter_bar) root.classList.add("dr-hide-filterbar");
	if (cfg.replace_native_sidebar) root.classList.add("dr-replace-sidebar");

	// ── phase 2: mount the (empty) rail box ASAP, so it never pops in ───────
	function mountRail() {
		if (!cfg.replace_native_sidebar || document.querySelector(".dr-rail")) return;
		const main = document.querySelector(".main-section");
		if (!main) return void requestAnimationFrame(mountRail);
		const rail = document.createElement("div");
		rail.className = "dr-rail";
		rail.innerHTML = '<nav class="dr-rail-nav"></nav>';
		main.appendChild(rail);
	}
	mountRail();

	// ── phase 3: hydrate once the desk's pending boot requests settle.
	//    after_ajax is a ONE-SHOT (frappe/request.js) — it runs the fn once when
	//    in-flight requests drain, NOT on every later save/list-refresh. Firing
	//    after the native sidebar's own fetch also means we hit a warm
	//    get_workspace_sidebar_items rather than a cold call. ──
	frappe.after_ajax(function () {
		const REDIRECTS = (frappe.boot && frappe.boot.redirect_workspaces) || {};
		// let applying = false;
		let fetched = false;

		// keep body classes in sync with <html> for any body-scoped CSS
		["dr-rail-active", "dr-fullwidth-navbar", "dr-hide-filterbar", "dr-replace-sidebar"]
			.forEach((c) => { if (root.classList.contains(c)) document.body.classList.add(c); });
		document.body.classList.toggle("dr-rail-collapsed", collapsed);

		// ---- navigation (soft for internal /app, hard otherwise) -----------
		function isSoftTarget(url) {
			try {
				const u = new URL(url, window.location.origin);
				return u.origin === window.location.origin && u.pathname.startsWith("/app/");
			} catch (e) { return false; }
		}
		function navigate(url) {
			if (isSoftTarget(url)) {
				const u = new URL(url, window.location.origin);
				frappe.set_route(u.pathname.replace(/^\/app\//, "") + u.search + u.hash);
			} else {
				window.location.href = url;
			}
		}

		// ---- redirect workspaces on the native sidebar (fallback) ----------
		function applyNativeRedirects() {
			Object.entries(REDIRECTS).forEach(([name, url]) => {
				if (!url) return;
				const anchor = document.querySelector(
					`.sidebar-item-container[item-name="${name}"] .item-anchor`);
				if (anchor && !anchor.dataset.drBound) {
					anchor.dataset.drBound = "1";
					anchor.setAttribute("href", url);
					anchor.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopImmediatePropagation();
						navigate(url);
					}, true);
				}
			});
		}
		(function watchNativeSidebar() {
			const sidebar = document.querySelector(".desk-sidebar");
			if (!sidebar) return void setTimeout(watchNativeSidebar, 300);
			applyNativeRedirects();
			new MutationObserver(applyNativeRedirects)
				.observe(sidebar, { childList: true, subtree: true });
		})();

		if (!cfg.replace_native_sidebar) return;

		// ---- collapse toggle -----------------------------------------------
		function setCollapsed(c) {
			collapsed = c;
			root.classList.toggle("dr-rail-collapsed", c);
			document.body.classList.toggle("dr-rail-collapsed", c);
			try { localStorage.setItem(LS_COLLAPSED, c ? "1" : "0"); } catch (e) {}
		}
		function injectNavToggle() {
			if (!cfg.show_navbar_toggle || document.querySelector(".dr-rail-toggle")) return;
			const container = document.querySelector(".navbar .container");
			const brand = container && container.querySelector(".navbar-brand");
			if (!container || !brand) return void setTimeout(injectNavToggle, 300);
			const btn = document.createElement("button");
			btn.className = "btn-reset dr-rail-toggle";
			btn.setAttribute("aria-label", "Toggle sidebar");
			btn.title = "Toggle sidebar";
			btn.innerHTML = (frappe.utils && frappe.utils.icon)
				? frappe.utils.icon("menu", "md") : "&#9776;";
			btn.addEventListener("click", () => setCollapsed(!collapsed));
			container.insertBefore(btn, brand);
		}

		// ---- rail tree -----------------------------------------------------
		// ---- rail tree -----------------------------------------------------
		const detailCache = {};

		function railTarget(p) {
			const r = REDIRECTS[p.title] || REDIRECTS[p.name];
			if (r) return r;
			const slug = frappe.router.slug(p.title);
			return "/app/" + (p.public ? slug : "private/" + slug);
		}

		// lazy-load the cards + links of one workspace (permission-filtered by server)
		async function getDetail(p) {
			if (detailCache[p.name]) return detailCache[p.name];
			let cards = [];
			try {
				const r = await frappe.call("frappe.desk.desktop.get_desktop_page", {
					page: JSON.stringify({ name: p.name, title: p.title, public: p.public }),
				});
				const raw = (r.message && r.message.cards &&
					(r.message.cards.items || r.message.cards)) || [];
				cards = raw.map((c) => ({ label: c.label, links: c.links || c.items || [] }));
			} catch (e) {
				try {
					const doc = await frappe.db.get_doc("Workspace", p.name);
					let cur = null;
					(doc.links || []).forEach((l) => {
						if (l.type === "Card Break") { cur = { label: l.label, links: [] }; cards.push(cur); }
						else if (cur && !l.hidden) cur.links.push(l);
					});
				} catch (e2) { cards = []; }
			}
			detailCache[p.name] = cards.filter((c) => c.links.length);
			return detailCache[p.name];
		}

		function linkRoute(l) {
			const t = l.link_type || l.type;
			const to = l.link_to || l.name;
			const slug = (s) => frappe.router.slug(s);
			if (t === "DocType") return "/app/" + slug(to);
			if (t === "Report") {
				return l.is_query_report
					? "/app/query-report/" + encodeURIComponent(to)
					: "/app/" + slug(l.doctype || l.dependencies || to) +
					  "/view/report/" + encodeURIComponent(to);
			}
			if (t === "Page") return "/app/" + slug(to);
			if (t === "Dashboard") return "/app/dashboard-view/" + encodeURIComponent(to);
			return "/app/" + slug(to);
		}

		const CHEVRON =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
			'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
			'aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
		const esc = (s) => (frappe.utils && frappe.utils.escape_html)
			? frappe.utils.escape_html(s || "") : (s || "");

		function eachGroup(nav, fn) {
			nav.querySelectorAll(".dr-rail-group").forEach((g) => {
				const panel = g.querySelector(":scope > .dr-rail-children");
				if (panel) fn(g, panel);
			});
		}
		function saveExpanded(nav) {
			const open = [];
			eachGroup(nav, (g, panel) => {
				if (!panel.classList.contains("hidden")) {
					const item = g.querySelector(":scope > .dr-rail-item");
					if (item && item.dataset.name) open.push(item.dataset.name);
				}
			});
			try { localStorage.setItem(LS_EXPANDED, JSON.stringify(open)); } catch (e) {}
		}

		// fill a workspace group with its cards (child workspaces are rendered up-front)
		async function fillWorkspace(group) {
			if (group.dataset.loaded) return;
			group.dataset.loaded = "1";
			const p = group._page;
			const depth = parseInt(group.dataset.depth, 10) || 0;
			const panel = group.querySelector(":scope > .dr-rail-children");
			const cards = await getDetail(p);
			cards.forEach((card) => panel.appendChild(buildCard(p, card, depth + 1)));
			if (!panel.children.length) group.classList.add("dr-no-kids");
		}

		async function setOpen(group, open, persist) {
			const panel = group.querySelector(":scope > .dr-rail-children");
			if (!panel) return;
			if (open && group._page) await fillWorkspace(group);
			panel.classList.toggle("hidden", !open);
			group.classList.toggle("dr-open", open);
			if (persist !== false) {
				const nav = group.closest(".dr-rail-nav");
				if (nav) saveExpanded(nav);
			}
		}
		function toggleGroup(group) {
			const panel = group.querySelector(":scope > .dr-rail-children");
			if (panel) setOpen(group, panel.classList.contains("hidden"));
		}

		function buildCard(p, card, depth) {
			const group = document.createElement("div");
			group.className = "dr-rail-group dr-rail-cardgroup";

			const head = document.createElement("div");
			head.className = "dr-rail-item dr-rail-card-head";
			head.dataset.name = "card:" + p.name + ":" + card.label;
			head.style.paddingLeft = 12 + depth * 14 + "px";
			head.innerHTML =
				`<span class="dr-rail-label">${esc(__(card.label))}</span>` +
				`<span class="dr-rail-arrow">${CHEVRON}</span>`;
			head.addEventListener("click", () => toggleGroup(group));
			group.appendChild(head);

			const panel = document.createElement("div");
			panel.className = "dr-rail-children hidden";

			card.links.forEach((l) => {
				const href = linkRoute(l);
				const t = l.link_type || l.type || "";
				const a = document.createElement("a");
				a.className = "dr-rail-item dr-rail-leaf";   // same class as workspace rows
				a.href = href;
				a.dataset.href = href;
				a.title = t;
				a.style.paddingLeft = 12 + (depth + 1) * 14 + "px";
				const icon = (frappe.utils && frappe.utils.icon)
					? frappe.utils.icon(
						t === "Report" ? "small-file" : t === "Dashboard" ? "dashboard" : "file", "sm")
					: "";
				a.innerHTML =
					`<span class="dr-rail-icon">${icon}</span>` +
					`<span class="dr-rail-label">${esc(__(l.label))}</span>`;
				a.addEventListener("click", (e) => {
					if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
					e.preventDefault();
					navigate(href);
				});
				panel.appendChild(a);
			});

			group.appendChild(panel);
			return group;
		}

		async function restoreOpen(container, saved) {
			for (const g of container.querySelectorAll(":scope > .dr-rail-group")) {
				const item = g.querySelector(":scope > .dr-rail-item");
				if (item && saved.includes(item.dataset.name)) {
					await setOpen(g, true, false);
					const panel = g.querySelector(":scope > .dr-rail-children");
					if (panel) await restoreOpen(panel, saved);
				}
			}
		}

		async function hydrate() {
			const rail = document.querySelector(".dr-rail");
			const nav = rail && rail.querySelector(".dr-rail-nav");
			if (!nav || nav.children.length || fetched) return;

			let data;
			try {
				fetched = true;
				data = await frappe.xcall("frappe.desk.desktop.get_workspace_sidebar_items");
			} catch (e) {
				if (rail) rail.remove();
				root.classList.remove("dr-rail-active");
				document.body.classList.remove("dr-rail-active");
				return;
			}
			const pages = (data && data.pages) || [];
			if (!pages.length) return;

			const byParent = {};
			pages.forEach((p) => {
				const k = p.parent_page || "";
				(byParent[k] = byParent[k] || []).push(p);
			});

			(function renderInto(parentKey, container, depth) {
				(byParent[parentKey] || []).forEach((p) => {
					if (p.is_hidden) return;
					const kids = (byParent[p.title] || []).filter((c) => !c.is_hidden);

					const group = document.createElement("div");
					group.className = "dr-rail-group";
					group._page = p;                    // marks a workspace (lazy cards)
					group.dataset.depth = depth;

					const href = railTarget(p);
					const a = document.createElement("a");
					a.className = "dr-rail-item";
					a.href = href;
					a.dataset.name = p.title;
					a.dataset.href = href;
					a.style.paddingLeft = 12 + depth * 14 + "px";
					const icon = (frappe.utils && frappe.utils.icon)
						? frappe.utils.icon(p.icon || "folder-normal", "md") : "";
					a.innerHTML =
						`<span class="dr-rail-icon">${icon}</span>` +
						`<span class="dr-rail-label">${esc(__(p.title))}</span>`;

					// every workspace gets an arrow: its cards load on first open
					const arrow = document.createElement("button");
					arrow.className = "btn-reset dr-rail-arrow";
					arrow.innerHTML = CHEVRON;
					arrow.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						toggleGroup(group);
					});
					a.appendChild(arrow);
					a.addEventListener("click", (e) => {
						e.preventDefault();
						navigate(href);
					});

					group.appendChild(a);
					const childWrap = document.createElement("div");
					childWrap.className = "dr-rail-children hidden";
					group.appendChild(childWrap);
					if (kids.length) renderInto(p.title, childWrap, depth + 1);
					container.appendChild(group);
				});
			})("", nav, 0);

			// collapse the overlay rail after tapping a link on mobile
			nav.addEventListener("click", (e) => {
				if (e.target.closest(".dr-rail-item, .dr-rail-leaf") &&
					!e.target.closest(".dr-rail-arrow, .dr-rail-card-head")) {
					if (window.matchMedia("(max-width: 768px)").matches) setCollapsed(true);
				}
			});

			// active-route highlight (longest same-origin path match, leaves included)
			function updateActive() {
				const here = window.location.pathname.replace(/\/+$/, "");
				let best = null, bestLen = -1;
				nav.querySelectorAll(".dr-rail-item[data-href], .dr-rail-leaf").forEach((a) => {
					a.classList.remove("active");
					let ap;
					try { ap = new URL(a.dataset.href, location.origin).pathname.replace(/\/+$/, ""); }
					catch (e) { return; }
					if ((here === ap || here.startsWith(ap + "/")) && ap.length >= bestLen) {
						best = a; bestLen = ap.length;
					}
				});
				if (best) {
					best.classList.add("active");
					let panel = best.closest(".dr-rail-children");
					while (panel) {
						const g = panel.closest(".dr-rail-group");
						setOpen(g, true, false);
						panel = g.parentElement.closest(".dr-rail-children");
					}
				}
			}

			// restore expanded groups (workspaces + cards), then highlight
			let saved = [];
			try { saved = JSON.parse(localStorage.getItem(LS_EXPANDED) || "[]"); } catch (e) {}
			await restoreOpen(nav, saved);

			updateActive();
			if (frappe.router && frappe.router.off) frappe.router.off("change", updateActive);
			frappe.router.on("change", updateActive);
		}

		injectNavToggle();
		hydrate();
	});
})();