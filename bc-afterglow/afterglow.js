// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Afterglow for Bondage Club
// Keeps count of your orgasms, ruined orgasms, resisted orgasms and denials, the time since your last orgasm, and
// your records: the longest you've gone without one, and the most denials (ruins, resists) between two.
// It only watches the game's own orgasm functions (ModSDK hooks that call the game first and change nothing).
// It sends nothing unless you share: then, only to someone the game's own permissions let see them, and only
// when their Afterglow asks. Counts and records go with your account; the event log stays in this browser.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_Afterglow", fullName: "Nightstand: Afterglow", version: "0.8.4", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-afterglow" };
	const TAG = "[Afterglow]";
	const SETTINGS_KEY = "Afterglow";
	const LOG_MAX = 1000;
	const DENY_GAP_MS = 60_000; // held at the edge without a break this long counts as one denial
	const DENY_DROP = 90; // ... and so does dropping below this arousal and coming back
	// Time away: while you're logged in and connected, "still here" is noted every minute in this browser (and every
	// ALIVE_SAVE_MS with the account, for other computers). At the next login, a gap longer than AWAY_MIN_MS since the
	// last note was time away.
	const ALIVE_EVERY_MS = 60_000;
	const ALIVE_SAVE_MS = 10 * 60_000;
	const AWAY_MIN_MS = 2 * 60_000;
	const AWAY_MAX = 300;
	// A session (the Session column, and time edged this session) carries on through reloads, reconnects and short
	// breaks; after this long without Afterglow running, the next login starts a new one.
	const SESSION_GAP_MS = 30 * 60_000;
	// A longer gap between two ticks (computer asleep, tab frozen, disconnected) isn't counted as time edged. It matches
	// "away" (AWAY_MIN_MS): Chrome slows a background tab's timers to once a minute, and those minutes count.
	const EDGE_TICK_MAX_MS = AWAY_MIN_MS;

	// Re-running the script (dev reload) replaces the previous instance
	if (window.Afterglow && typeof window.Afterglow.unload === "function") window.Afterglow.unload();

	/** @param {number} ms */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof bcModSdk === "undefined" || typeof Player === "undefined" || typeof ActivityOrgasmStart === "undefined") await sleep(250);

	const mod = bcModSdk.registerMod(MOD_INFO);

	/**
	 * @typedef {"orgasm" | "ruined" | "resisted" | "failed" | "denied" | "edged"} AgKind
	 * @typedef {"denied" | "edged" | "ruined" | "resisted"} AgStreakKind kinds counted between two orgasms
	 * @typedef {"denied" | "edged" | "ruined"} AgHeldKind kinds whose effect is timed while it's on you
	 * @typedef {{ ms: number, from: number, to: number, exact: boolean, manual?: boolean }} AgGap a stretch without an orgasm
	 * @typedef {"item" | "none" | number} AgLevel who may see a part: the game's item permission, nobody, or a level 0-5
	 * @typedef {[number, AgKind | "away", string, (string | number)?]} AgLogEntry [time, kind, room, how (or ms away)]
	 * @typedef {{ on: boolean, counts: AgLevel, records: AgLevel, held: AgLevel, look: boolean }} AgShare
	 * @typedef {{ v: number, since: number, totals: Record<AgKind, number>, base: Record<AgKind, number>, last: Partial<Record<AgKind, number>>, lastOrgasmAt: number | null, streakStart: number, streak: Record<AgStreakKind, number>, rec: { gap: AgGap | null, gapOnline: AgGap | null } & Record<AgStreakKind, number>, show: AgKind, held: Record<AgHeldKind, number>, edgeMs: number, heldEdge: number | null, edgeSince: number, edgeDay: { d: string, ms: number }, timeMode: "real" | "online", alive: number, away: [number, number][], share: AgShare, belt: { mode: "ask" | "auto" | "off", show: boolean, ignored: number } }} AgState
	 * @typedef {{ start: number, last: number, edgeMs: number } & Record<AgKind, number>} AgSession
	 * @typedef {{ since: number, exact: boolean, streak: Record<AgStreakKind, number>, session: Record<AgKind, number>, today: Record<AgKind, number>, all: Record<AgKind, number> }} AgSharedCounts
	 * @typedef {{ gap: { ms: number, exact: boolean, manual: boolean } | null, rec: Record<AgStreakKind, number>, edge: { session: number, today: number, all: number }, online: boolean }} AgSharedRecords
	 * @typedef {{ age: number, away: number, edging?: number, items: string[] }} AgSharedHeld
	 * @typedef {{ t: "stats", name: string, counts?: AgSharedCounts, records?: AgSharedRecords, held?: Partial<Record<AgHeldKind, AgSharedHeld>> }} AgStats what someone may see of you
	 * @typedef {AgStats | { t: "stop" } | { t: "ask" }} AgMessage
	 */
	/** @type {Record<AgKind, { label: string, one: string, icon: string }>} */
	const KINDS = {
		orgasm: { label: "Orgasms", one: "Orgasm", icon: "💦" },
		ruined: { label: "Ruined", one: "Ruined", icon: "💔" },
		resisted: { label: "Resisted", one: "Resisted", icon: "✊" },
		failed: { label: "Resist failed", one: "Resist failed", icon: "😵" }, // tried to resist and came anyway: also an orgasm
		denied: { label: "Denied", one: "Denied", icon: "⛔" }, // held at the edge by a denial effect (DenialMode)
		edged: { label: "Edged", one: "Edged", icon: "🫠" }, // held at the edge by an edging effect (Edged, or an Edging craft)
	};
	const KIND_KEYS = /** @type {AgKind[]} */ (Object.keys(KINDS));
	const zeroCounts = () => /** @type {Record<AgKind, number>} */ (Object.fromEntries(KIND_KEYS.map((k) => [k, 0])));
	/** @type {AgStreakKind[]} */
	const STREAK_KEYS = ["denied", "edged", "ruined", "resisted"]; // counted between two orgasms
	/** @type {AgStreakKind[]} */
	const BOX_KEYS = ["denied", "ruined", "resisted"]; // the small boxes (edged shares the denied one)
	/** @type {AgHeldKind[]} */
	const HELD_KEYS = ["denied", "edged", "ruined"]; // these also time how long the effect has been on you

	// ---------- state (with the account) ----------
	// since: when Afterglow started counting on this account. lastOrgasmAt: the last orgasm it saw (null: none yet,
	// so the current stretch is counted from `since` and is only a lower bound). streak: denials, ruins and resists
	// since then. rec: the longest stretch without an orgasm (gap) and the most of each in one stretch.
	/** @returns {AgState} */
	const fresh = () => ({
		v: 1,
		since: Date.now(),
		totals: zeroCounts(),
		base: zeroCounts(), // from before Afterglow, entered by hand
		last: {},
		lastOrgasmAt: null,
		streakStart: Date.now(),
		streak: { denied: 0, edged: 0, ruined: 0, resisted: 0 },
		rec: { gap: null, gapOnline: null, denied: 0, edged: 0, ruined: 0, resisted: 0 },
		show: "orgasm", // what the dock tab shows: the orgasm clock, or the denied / ruined / resisted box
		held: { denied: 0, edged: 0, ruined: 0 }, // since when a denial / edging / ruin effect has been on you, 0: none now
		edgeMs: 0, // time edged (online, with an edging effect on you), since edgeSince
		heldEdge: null, // time edged since the current edging timer started (null: none, or it started before 0.8.0)
		edgeSince: Date.now(), // when Afterglow started counting time edged, or it was last reset
		edgeDay: { d: "", ms: 0 }, // time edged today (d: the local date it's for)
		timeMode: "real", // "real": clocks and records count all time; "online": only time you were logged in
		alive: 0, // the last "still here" saved with the account (every few minutes), to find time away on another device
		away: [], // [from, to]: stretches you were away (logged out, tab closed, disconnected), newest last
		// Sharing. Each part: "item" (whoever the game lets use items on you), a level 0-5 from the game's own ladder
		// (0 everyone ... 5 owner only), or "none". Blacklist and ghost list never see anything.
		share: { on: false, counts: "item", records: "item", held: 4, look: true },
		// The game's Modular Chastity Belt keeps its own "time since last orgasm": cross-check with it while you wear it.
		// mode: "ask" (offer to count an orgasm it saw and Afterglow didn't), "auto" (count it), "off". ignored: a belt
		// time you said no to.
		belt: { mode: "ask", show: true, ignored: 0 },
	});
	let state = fresh();
	/** @type {number | null} */
	let loadedFor = null;

	/**
	 * @param {any} s the saved state, as parsed
	 * @returns {AgState}
	 */
	function clean(s) {
		const out = fresh();
		if (!s || typeof s !== "object") return out;
		/**
		 * @param {unknown} v
		 * @param {number} [d]
		 */
		const num = (v, d = 0) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
		out.since = num(s.since, out.since);
		for (const k of KIND_KEYS) out.totals[k] = num(s.totals?.[k]);
		for (const k of KIND_KEYS) out.base[k] = num(s.base?.[k]);
		for (const k of KIND_KEYS) if (num(s.last?.[k])) out.last[k] = num(s.last[k]);
		out.lastOrgasmAt = num(s.lastOrgasmAt) || null;
		out.streakStart = num(s.streakStart, out.lastOrgasmAt || out.since);
		for (const k of STREAK_KEYS) out.streak[k] = num(s.streak?.[k]);
		for (const k of STREAK_KEYS) out.rec[k] = num(s.rec?.[k]);
		if (typeof s.show === "string" && s.show in KINDS) out.show = /** @type {AgKind} */ (s.show);
		for (const k of HELD_KEYS) out.held[k] = num(s.held?.[k]);
		out.edgeMs = num(s.edgeMs);
		out.heldEdge = typeof s.heldEdge === "number" && s.heldEdge >= 0 && out.held.edged ? Math.round(s.heldEdge) : null;
		out.edgeSince = num(s.edgeSince, out.since);
		if (s.edgeDay && typeof s.edgeDay.d === "string") out.edgeDay = { d: s.edgeDay.d, ms: num(s.edgeDay.ms) };
		/**
		 * @param {any} g
		 * @returns {AgGap | null}
		 */
		const gap = (g) => (g && num(g.ms) ? { ms: num(g.ms), from: num(g.from), to: num(g.to), exact: !!g.exact, ...(g.manual ? { manual: true } : {}) } : null);
		out.rec.gap = gap(s.rec?.gap);
		// Records from before time away was tracked: all of it counts as online
		out.rec.gapOnline = s.rec && "gapOnline" in s.rec ? gap(s.rec.gapOnline) : out.rec.gap && { ...out.rec.gap };
		if (s.timeMode === "online") out.timeMode = "online";
		out.alive = num(s.alive);
		/**
		 * @param {unknown} v
		 * @param {AgLevel} d
		 * @returns {AgLevel}
		 */
		const lvl = (v, d) => (v === "item" || v === "none" ? v : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5 ? v : d);
		if (s.belt && typeof s.belt === "object")
			out.belt = { mode: ["ask", "auto", "off"].includes(s.belt.mode) ? s.belt.mode : "ask", show: s.belt.show !== false, ignored: num(s.belt.ignored) };
		if (s.share && typeof s.share === "object")
			out.share = { on: !!s.share.on, counts: lvl(s.share.counts, "item"), records: lvl(s.share.records, "item"), held: lvl(s.share.held, 4), look: s.share.look !== false };
		out.away = (Array.isArray(s.away) ? s.away : [])
			.filter((/** @type {unknown} */ a) => Array.isArray(a) && num(a[0]) && num(a[1]) > num(a[0]))
			.map((/** @type {any[]} */ a) => /** @type {[number, number]} */ ([num(a[0]), num(a[1])]))
			.slice(-AWAY_MAX);
		return out;
	}
	function load() {
		try {
			const raw = Player.ExtensionSettings?.[SETTINGS_KEY];
			state = typeof raw === "string" && raw ? clean(JSON.parse(LZString.decompressFromUTF16(raw) || "null")) : fresh();
		} catch (e) {
			console.warn(TAG, "load failed", e);
			state = fresh();
		}
		log = readLog();
		session = readSession();
		const before = Math.max(state.alive || 0, readAlive());
		const now = Date.now();
		if (before && now - before > AWAY_MIN_MS) addAway(before, now);
		markAlive(true);
		if (!Player.ExtensionSettings?.[SETTINGS_KEY]) save(); // the first day: remember when counting started
	}

	// ---------- time away ----------
	const aliveKey = () => `Afterglow.alive.${Player.MemberNumber || 0}`;
	function readAlive() {
		try {
			return Number(localStorage.getItem(aliveKey())) || 0;
		} catch {
			return 0;
		}
	}
	let aliveAt = 0;
	let aliveSavedAt = 0;
	function markAlive(force = false) {
		const now = Date.now();
		if (!force && now - aliveAt < ALIVE_EVERY_MS) return;
		aliveAt = now;
		try {
			localStorage.setItem(aliveKey(), String(now));
		} catch {
			// storage full or blocked: carries on without saving
		}
		session.last = now;
		writeSession();
		if (force || now - aliveSavedAt >= ALIVE_SAVE_MS) {
			aliveSavedAt = now;
			state.alive = now;
			save();
		}
	}
	const connected = () => typeof ServerIsConnected === "undefined" || ServerIsConnected !== false;
	/**
	 * @param {number} from
	 * @param {number} to
	 */
	function addAway(from, to) {
		state.away.push([from, to]);
		// Only stretches inside one of the running clocks or the record still matter
		const keep = Math.min(state.streakStart, ...Object.values(state.last));
		state.away = state.away.filter((a) => a[1] > keep).slice(-AWAY_MAX);
		log.push([from, "away", "", to - from]);
		if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
		writeLog();
		save();
	}
	// Time away between a and b
	/**
	 * @param {number} a
	 * @param {number} b
	 */
	function awayBetween(a, b) {
		let ms = 0;
		for (const [f, t] of state.away) ms += Math.max(0, Math.min(t, b) - Math.max(f, a));
		return ms;
	}
	// How long since t: all of it, or only time online (state.timeMode)
	/**
	 * @param {number} t
	 * @param {"real" | "online"} [mode]
	 */
	const elapsed = (t, mode = state.timeMode) => Math.max(0, Date.now() - t - (mode === "online" ? awayBetween(t, Date.now()) : 0));
	const recGap = () => (state.timeMode === "online" ? state.rec.gapOnline : state.rec.gap);
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let saveTimer;
	let dirty = false;
	function saveNow() {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (!Player.ExtensionSettings || !Player.MemberNumber || loadedFor !== Player.MemberNumber) return;
		dirty = false;
		Player.ExtensionSettings[SETTINGS_KEY] = LZString.compressToUTF16(JSON.stringify(state));
		if (typeof ServerPlayerExtensionSettingsSync === "function") ServerPlayerExtensionSettingsSync(SETTINGS_KEY);
	}
	function save() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(saveNow, 1500);
	}

	// ---------- event log (this browser only) ----------
	// [time, kind, room, how?]: for "today" and the recent list
	/** @type {AgLogEntry[]} */
	let log = [];
	// ---------- session (this browser) ----------
	// Counts and time edged since this session started. Kept in localStorage so a reload, a reconnect or a short break
	// doesn't end it: it goes on until Afterglow hasn't run for SESSION_GAP_MS.
	/** @returns {AgSession} */
	const newSession = () => ({ start: Date.now(), last: Date.now(), ...zeroCounts(), edgeMs: 0 });
	let session = newSession();
	const sessionKey = () => `Afterglow.session.${Player.MemberNumber || 0}`;
	function readSession() {
		try {
			const raw = /** @type {Record<string, unknown> | null} */ (JSON.parse(localStorage.getItem(sessionKey()) || "null"));
			if (raw && typeof raw.last === "number" && Number.isFinite(raw.last) && Date.now() - raw.last < SESSION_GAP_MS) {
				const out = newSession();
				for (const k of /** @type {(keyof AgSession)[]} */ (Object.keys(out))) {
					const v = raw[k];
					if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
				}
				return out;
			}
		} catch {
			// missing or unreadable: the defaults stay
		}
		return newSession();
	}
	function writeSession() {
		if (!Player.MemberNumber || loadedFor !== Player.MemberNumber) return;
		try {
			localStorage.setItem(sessionKey(), JSON.stringify(session));
		} catch {
			// storage full or blocked: carries on without saving
		}
	}
	const logKey = () => `Afterglow.log.${Player.MemberNumber || 0}`;
	/** @returns {AgLogEntry[]} */
	function readLog() {
		try {
			const raw = /** @type {unknown} */ (JSON.parse(localStorage.getItem(logKey()) || "[]"));
			if (!Array.isArray(raw)) return [];
			const list = /** @type {AgLogEntry[]} */ (raw.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && typeof e[1] === "string" && (e[1] in KINDS || e[1] === "away")));
			// before 0.4.0, edges were denials
			return list.map((e) => /** @type {AgLogEntry} */ (e[1] === "denied" && e[3] === "edge" ? [e[0], "edged", e[2]] : e)).slice(-LOG_MAX);
		} catch {
			return [];
		}
	}
	function writeLog() {
		try {
			localStorage.setItem(logKey(), JSON.stringify(log));
		} catch {
			// storage full or blocked: carries on without saving
		}
	}

	// ---------- counting ----------
	const roomName = () => (typeof ChatRoomData !== "undefined" && ChatRoomData?.Name) || "";
	/**
	 * @param {AgKind} kind
	 * @param {string} [how] edge, failed, …
	 */
	function record(kind, how) {
		if (!Player.MemberNumber || loadedFor !== Player.MemberNumber) return;
		const now = Date.now();
		state.totals[kind]++;
		state.last[kind] = now;
		session[kind]++;
		if (how === "failed") {
			state.totals.failed++;
			state.last.failed = now;
			session.failed++;
		}
		if (kind === "orgasm") {
			// The stretch that just ended: a new record if it's the longest (only a lower bound if it started at install)
			const gap = now - state.streakStart;
			const online = gap - awayBetween(state.streakStart, now);
			const span = { from: state.streakStart, to: now, exact: !!state.lastOrgasmAt };
			if (!state.rec.gap || gap > state.rec.gap.ms) state.rec.gap = { ms: gap, ...span };
			if (!state.rec.gapOnline || online > state.rec.gapOnline.ms) state.rec.gapOnline = { ms: online, ...span };
			for (const k of STREAK_KEYS) state.streak[k] = 0;
			state.lastOrgasmAt = now;
			state.streakStart = now;
		} else if (kind !== "failed") {
			state.streak[kind]++;
			if (state.streak[kind] > state.rec[kind]) state.rec[kind] = state.streak[kind];
		}
		// An orgasm, ruin or resist ends any spell at the edge: the next denial is a new one
		if (kind !== "denied" && kind !== "edged") dropped = true;
		log.push(how ? [now, kind, roomName(), how] : [now, kind, roomName()]);
		if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
		writeLog();
		writeSession();
		save();
		ui.render();
		pushShares();
	}

	// Denial and edging hold you at the edge, and the game asks again every time the meter refills, so one spell at
	// the edge counts once: again only after a minute without being stopped, or after arousal dropped and came back.
	let denyHitAt = 0;
	let dropped = true;
	/** @param {string | null} how */
	function denyHit(how) {
		const now = Date.now();
		if (dropped || now - denyHitAt > DENY_GAP_MS) record(how === "edge" ? "edged" : "denied");
		denyHitAt = now;
		dropped = false;
	}

	// What's on you now: a denial (or edging) effect holds you at the edge; a ruin effect ruins the orgasm instead
	const effects = () => (Array.isArray(Player.Effect) ? Player.Effect : []);
	const edged = () => {
		try {
			return (typeof Player.IsEdged === "function" && Player.IsEdged()) || (typeof InventoryCraftCount === "function" && InventoryCraftCount(Player, "Edging") > 0);
		} catch {
			return false;
		}
	};
	const heldNow = {
		denied: () => effects().includes("DenialMode") && !effects().includes("RuinOrgasms"),
		edged,
		ruined: () => effects().includes("RuinOrgasms"),
	};
	// Start or stop the "held for" timers when such an item goes on or comes off. The effect list can be empty for a
	// moment while the game redraws you, so it has to stay off a few seconds before the timer stops.
	/** @type {Record<AgHeldKind, number>} */
	const offSince = { denied: 0, edged: 0, ruined: 0 };
	function checkHeld() {
		if (!Player.MemberNumber || loadedFor !== Player.MemberNumber || !Array.isArray(Player.Appearance) || !Player.Appearance.length) return;
		let changed = false;
		for (const k of HELD_KEYS) {
			const on = heldNow[k]();
			if (on) offSince[k] = 0;
			if (on && !state.held[k]) {
				state.held[k] = Date.now();
				if (k === "edged") state.heldEdge = 0;
				changed = true;
			} else if (!on && state.held[k]) {
				offSince[k] ||= Date.now();
				if (Date.now() - offSince[k] >= 5000) {
					state.held[k] = 0;
					if (k === "edged") state.heldEdge = null;
					offSince[k] = 0;
					changed = true;
				}
			}
		}
		if (changed) {
			save();
			ui.render();
			pushShares();
		}
	}

	// Which items cause it: denial (DenialMode), edging (Edged, or crafted Edging) and ruin (RuinOrgasms)
	const CAUSE = { denied: "DenialMode", edged: "Edged", ruined: "RuinOrgasms" };
	/** @param {AgHeldKind} k */
	function causes(k) {
		const out = [];
		for (const item of Array.isArray(Player.Appearance) ? Player.Appearance : []) {
			const a = item?.Asset;
			if (!a || a.Group?.Category !== "Item") continue;
			const p = item.Property || {};
			const fx = [...(Array.isArray(a.Effect) ? a.Effect : []), ...(Array.isArray(p.Effect) ? p.Effect : [])];
			const crafted = k === "edged" && item.Craft?.Property === "Edging";
			if (!fx.includes(CAUSE[k]) && !crafted) continue;
			const name = item.Craft?.Name || a.Description || a.Name || "Item";
			const extra = [a.Group?.Description || a.Group?.Name, typeof p.Mode === "string" && ["Deny", "Edge", "Tease", "Random", "Escalate"].includes(p.Mode) ? `${p.Mode} mode` : "", crafted ? "crafted Edging" : ""].filter(Boolean);
			out.push(`${name}${extra.length ? ` (${extra.join(", ")})` : ""}`);
		}
		return out;
	}
	// "⛔ Polished Chastity Belt (Pelvis) · 🫠 Vibrating Egg (Vulva, Edge mode)": what's holding you right now
	const causeText = () =>
		HELD_KEYS.filter((k) => state.held[k])
			.map((k) => {
				const c = causes(k);
				return c.length ? `${KINDS[k].icon} ${c.join(", ")}` : "";
			})
			.filter(Boolean)
			.join(" · ");

	// Time edged: while an edging effect is on you and you're connected, add up the time between ticks. A long gap
	// between two ticks (asleep, frozen tab, disconnected) isn't counted. Saved with the account every minute, and the session every 10 seconds.
	const dayKey = () => new Date().toDateString();
	let edgeTickAt = 0;
	let edgeSavedAt = 0;
	let edgeSessionAt = 0;
	function addEdgeTime() {
		const now = Date.now();
		const dt = edgeTickAt ? now - edgeTickAt : 0;
		edgeTickAt = now;
		// The effect itself, not the timer (which waits a few seconds before it stops)
		if (!Player.MemberNumber || loadedFor !== Player.MemberNumber || !connected() || !state.held.edged || !edged()) return;
		if (dt <= 0 || dt > EDGE_TICK_MAX_MS) return;
		state.edgeMs += dt;
		if (state.edgeDay.d !== dayKey()) state.edgeDay = { d: dayKey(), ms: 0 };
		state.edgeDay.ms += dt;
		session.edgeMs += dt;
		if (state.heldEdge != null) state.heldEdge += dt;
		dirty = true;
		if (now - edgeSessionAt >= 10_000) {
			edgeSessionAt = now;
			writeSession();
		}
		if (now - edgeSavedAt >= 60_000) {
			edgeSavedAt = now;
			save();
		}
	}
	const edgeToday = () => (state.edgeDay.d === dayKey() ? state.edgeDay.ms : 0);
	function resetEdgeTime() {
		if (!window.confirm("Reset the all-time total for time edged? Today's and this session's time edged are kept.")) return;
		state.edgeMs = 0;
		state.edgeSince = Date.now();
		save();
		ui.render();
	}

	/** @param {Character | null | undefined} C */
	const isMe = (C) => !!C && (typeof C.IsPlayer === "function" ? C.IsPlayer() : C === Player);
	const orgasmTimer = () => Player.ArousalSettings?.OrgasmTimer || 0;
	/** @param {() => void} fn */
	const safely = (fn) => {
		try {
			fn();
		} catch (e) {
			console.warn(TAG, e);
		}
	};

	// The game runs first in every hook; we only look at what happened
	// An orgasm, or a ruined one (the game's ActivityOrgasmRuined says which). If the resist mini-game was still
	// running (OrgasmStage 1), its time ran out: you tried to resist and came anyway.
	mod.hookFunction("ActivityOrgasmStart", 0, (args, next) => {
		const mine = isMe(args[0]);
		const ruined = mine && typeof ActivityOrgasmRuined !== "undefined" && ActivityOrgasmRuined === true;
		const failed = mine && !ruined && Player.ArousalSettings?.OrgasmStage === 1;
		const r = next(args);
		if (mine) safely(() => record(ruined ? "ruined" : "orgasm", failed ? "failed" : undefined));
		return r;
	});
	// The resist mini-game: winning it ends the orgasm timer
	mod.hookFunction("ActivityOrgasmGameGenerate", 0, (args, next) => {
		const before = orgasmTimer();
		const r = next(args);
		if (args[0] > 0 && before > 0 && orgasmTimer() === 0) safely(() => record("resisted"));
		return r;
	});
	// A ruined orgasm that runs out its time (or that you push through) ends here, every frame until it fires
	mod.hookFunction("ActivityOrgasmControl", 0, (args, next) => {
		const before = orgasmTimer();
		const r = next(args);
		if (before > 0 && orgasmTimer() === 0) safely(() => record("ruined"));
		return r;
	});
	// Full arousal: a denial or edging effect holds you at the edge instead (unless it's a forced, ruined one)
	mod.hookFunction("ActivityOrgasmPrepare", 0, (args, next) => {
		const [C, bypass] = args;
		/** @type {string | null} */
		let how = null;
		if (isMe(C))
			safely(() => {
				const fx = Array.isArray(C.Effect) ? C.Effect : [];
				if (fx.includes("DenialMode") && !(bypass || fx.includes("RuinOrgasms"))) how = "denial";
				else if (!bypass && edged()) how = "edge";
			});
		const r = next(args);
		const hit = how;
		if (hit) safely(() => denyHit(hit));
		return r;
	});

	// ---------- formatting ----------
	/** @param {number} ms */
	function fmtSpan(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		const d = Math.floor(s / 86400);
		const hh = Math.floor((s % 86400) / 3600);
		const mm = Math.floor((s % 3600) / 60);
		if (d) return `${d}d ${hh}h ${mm}m`;
		if (hh) return `${hh}h ${mm}m`;
		return `${mm}m ${s % 60}s`;
	}
	/** @param {number} t */
	const fmtDay = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
	/** @param {number} t */
	const fmtWhen = (t) => {
		const d = new Date(t);
		const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return d.toDateString() === new Date().toDateString() ? time : `${fmtDay(t)} ${time}`;
	};
	function todayCounts() {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		const out = zeroCounts();
		for (const e of log)
			if (e[0] >= start.getTime() && e[1] !== "away") {
				out[e[1]]++;
				if (e[3] === "failed") out.failed++;
			}
		return out;
	}
	const sinceText = () => fmtSpan(elapsed(state.streakStart));
	/** @param {AgKind} k */
	const allTime = (k) => state.totals[k] + (state.base[k] || 0);
	// The orgasm clock: { t, exact }. The
	// stretch starts at install until the first one (exact: false, shown as "≥").
	/**
	 * @param {AgKind} k
	 * @returns {{ t: number, exact: boolean } | null}
	 */
	function sinceFor(k) {
		if (k === "orgasm") return { t: state.streakStart, exact: !!state.lastOrgasmAt };
		return state.last[k] ? { t: state.last[k], exact: true } : null;
	}
	/** @param {number} ms */
	const edgeText = (ms) => (ms < 1000 ? "—" : ms < 60_000 ? `${Math.floor(ms / 1000)}s` : two(fmtSpan(ms)));
	/** @param {string} span */
	const two = (span) => span.split(" ").slice(0, 2).join(" "); // the two largest units: "1d 2h", "4h 0m", "25m 3s"
	// The big text of a box. Orgasm: time since the last one. Denied / ruined: how long the item has been on you while
	// one is, otherwise how many this stretch. Resisted: how many this stretch.
	// short: the dock tab's summary line.
	// The denied box also stands for edged: while an edging effect is on you it times that.
	/**
	 * @param {AgKind} k
	 * @returns {AgHeldKind | null}
	 */
	const boxHeld = (k) => (k === "denied" ? (state.held.edged ? "edged" : state.held.denied ? "denied" : null) : (k === "edged" || k === "ruined") && state.held[k] ? k : null);
	/**
	 * @param {AgKind} k
	 * @param {boolean} [short] the dock's one-line summary
	 */
	function clockText(k, short = false) {
		if (k === "orgasm") {
			const x = sinceFor(k) || { t: state.streakStart, exact: false };
			return `${x.exact ? "" : "≥ "}${fmtSpan(elapsed(x.t))}${short ? " since last orgasm" : ""}`;
		}
		if (k === "denied") {
			const on = boxHeld(k);
			if (on) {
				const span = two(fmtSpan(elapsed(state.held[on])));
				return short ? `${KINDS[on].icon} ${on === "edged" ? "edged" : "held"} ${span} · ${state.streak[on]} ${KINDS[on].label.toLowerCase()}` : span;
			}
			return short ? `⛔ ${state.streak.denied} denied · 🫠 ${state.streak.edged} edged this stretch` : String(state.streak.denied);
		}
		if (k === "failed") return "";
		if (k !== "resisted" && state.held[k]) {
			const span = two(fmtSpan(elapsed(state.held[k])));
			return short ? `${KINDS[k].icon} held ${span} · ${state.streak[k]} ${KINDS[k].label.toLowerCase()}` : span;
		}
		return short ? `${KINDS[k].icon} ${state.streak[k]} ${KINDS[k].label.toLowerCase()} this stretch` : String(state.streak[k]);
	}
	// The game's own lifetime count (Player.ArousalSettings.OrgasmCount, shown under its zoomed arousal meter)
	const gameCountText = () => {
		const n = Player.ArousalSettings?.OrgasmCount;
		// 0 usually just means the game hasn't kept a count for this character: not worth a line
		return Number.isFinite(n) && n > 0 ? `The game's own count: ${n} (under its arousal meter).` : "";
	};

	// ---------- panel ----------
	const ui = (() => {
		/** @type {BCDockHandle | null} */
		let panel = null;
		/** @type {HTMLElement | null} */
		let root = null;
		/**
		 * An element with attributes (class, on<event> listeners, the rest as attributes; null/false left out) and children
		 * (nodes, text, arrays of them; null/false left out)
		 * @template {keyof HTMLElementTagNameMap} K
		 * @param {K} tag
		 * @param {Record<string, any>} [attrs]
		 * @param {...any} kids
		 * @returns {HTMLElementTagNameMap[K]}
		 */
		const h = (tag, attrs = {}, ...kids) => {
			const el = document.createElement(tag);
			for (const [k, v] of Object.entries(attrs)) {
				if (k === "class") el.className = v;
				else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
				else if (v === true) el.setAttribute(k, "");
				else if (v !== false && v != null) el.setAttribute(k, v);
			}
			for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
			return el;
		};
		const CSS = `
#ag-body{font-size:12px}
#ag-body .ag-clock{padding:3px 5px;border:1px solid var(--bcd-line-soft,#352f42);border-radius:5px;cursor:pointer;min-width:0}
#ag-body .ag-clock.pin{border-color:var(--bcd-hi,#9a5cc8);box-shadow:0 0 0 1px var(--bcd-hi,#9a5cc8) inset}
#ag-body .ag-clock .ag-t{font-weight:700;font-variant-numeric:tabular-nums;color:var(--bcd-accent,#e7b6ff);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ag-body .ag-clock.big .ag-t{font-size:20px}
#ag-body .ag-clock.on{border-color:#c86a5c}
#ag-body .ag-clock.on .ag-t{color:#ffb3a6}
#ag-body .ag-clock .ag-k{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ag-body .ag-clock:not(.big) .ag-k{letter-spacing:0;text-transform:none;font-size:10px}
#ag-body .ag-clock:not(.big){padding:2px 4px}
#ag-body .ag-clock:not(.big) .ag-sub{font-size:10px;margin:0}
#ag-body .ag-clocks{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:4px 0}
#ag-body .ag-k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--bcd-muted,#a99fc0)}
#ag-body .ag-sub{color:#aaa;font-size:11px;margin:1px 0 4px}
#ag-body .ag-sub.ag-x:empty{display:none}
#ag-body .ag-rec{margin:4px 0;padding:4px 6px;border-radius:5px;background:var(--bcd-ctl,#24202c);font-size:11px}
#ag-body .ag-rec.new{background:var(--bcd-tab-act,#3b2350);border:1px solid var(--bcd-hi,#9a5cc8);color:#fff}
#ag-body table{width:100%;border-collapse:collapse;margin:4px 0;font-variant-numeric:tabular-nums}
#ag-body th,#ag-body td{padding:2px 3px;text-align:right;font-weight:400}
#ag-body th{color:var(--bcd-muted,#a99fc0);font-size:10px;text-transform:uppercase}
#ag-body td:first-child,#ag-body th:first-child{text-align:left}
#ag-body td+td{white-space:nowrap}
#ag-body tr+tr td{border-top:1px solid var(--bcd-line-soft,#2f2a3a)}
#ag-body details{margin:4px 0}
#ag-body summary{cursor:pointer;color:var(--bcd-muted,#a99fc0);font-size:11px}
#ag-body .ag-log{max-height:180px;overflow-y:auto;font-size:11px}
#ag-body .ag-log div{padding:1px 0}
#ag-body .ag-log .ag-away{color:#888;font-style:italic}
#ag-body .hint{color:#999;font-size:11px;margin:3px 0}
#ag-body .hint:empty{display:none}
#ag-body button{font:inherit}
#ag-body input{font:inherit;color:#eee;background:var(--bcd-ctl,#2a2633);border:1px solid var(--bcd-ctl-line,#5a5070);border-radius:5px;padding:1px 3px;box-sizing:border-box}
#ag-body .ag-start{margin:6px 0;padding:4px 6px;border:1px solid var(--bcd-line-soft,#352f42);border-radius:5px}
#ag-body .ag-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;margin:3px 0}
#ag-body .ag-grid label{display:flex;justify-content:space-between;align-items:center;gap:4px;font-size:11px}
#ag-body .ag-row{display:flex;align-items:center;gap:4px;margin:3px 0;font-size:11px;flex-wrap:wrap}
#ag-body .ag-row select{max-width:100%}
#ag-body .ag-tabs{display:flex;gap:3px;margin:0 0 4px}
#ag-body .ag-tabs button{flex:1;padding:2px 0}
#ag-body .ag-tabs button.act{background:var(--bcd-line,#6b4f85);border-color:var(--bcd-hi,#9a7bb8)}
#ag-body .ag-sec{display:flex;gap:4px;align-items:center;width:100%;margin:3px 0 0;text-align:left;font-weight:600}
#ag-body .ag-sec.open{border-bottom-left-radius:0;border-bottom-right-radius:0;background:var(--bcd-tab-act,#2c2638)}
#ag-body .ag-sec-a{width:1em;color:var(--bcd-muted,#a99fc0)}
#ag-body .ag-sec-body{padding:4px 6px;border:1px solid var(--bcd-line-soft,#352f42);border-top:0;border-radius:0 0 5px 5px;margin:0 0 3px}
#ag-body .ag-offer{margin:4px 0;padding:4px 6px;border:1px solid var(--bcd-hi,#9a5cc8);border-radius:5px;background:var(--bcd-tab-act,#3b2350);font-size:11px}
#ag-body .ag-share{margin:4px 0;padding:4px 6px;border:1px solid var(--bcd-line-soft,#352f42);border-radius:5px;font-size:11px}
#ag-body .ag-share .ag-t{font-weight:700;font-variant-numeric:tabular-nums;color:var(--bcd-accent,#e7b6ff);font-size:14px}
#ag-body .ag-share .ag-held{color:#ffb3a6}
`;
		function mount() {
			if (panel) return;
			if (!window.BCDock) return console.warn(TAG, "bc-dock.js isn't loaded (the Nightstand script brings it), so there's no panel");
			document.head.append(h("style", { id: "ag-style" }, CSS));
			panel = BCDock.add({ id: "afterglow", title: "Afterglow", icon: "✨", order: 40, version: MOD_INFO.version, width: 220, minWidth: 190, maxWidth: 300, alignStart: true, onToggle: () => (panel?.isOpen() && lookNow(), render()) });
			root = panel.body || null;
			if (!root) return;
			root.id = "ag-body";
			render();
		}
		function unmount() {
			panel?.remove();
			document.getElementById("ag-style")?.remove();
			panel = root = null;
		}

		function render() {
			if (!panel) return;
			const on = !!Player.MemberNumber && loadedFor === Player.MemberNumber;
			panel.setVisible(on);
			if (!on) return;
			panel.setSummary(clockText(state.show, true));
			if (!root) return;
			if (!panel.isOpen()) return root.replaceChildren();
			const cur = elapsed(state.streakStart);
			const g = recGap();
			const beating = !g || cur > g.ms;
			const today = todayCounts();
			const arousalOff = Player.ArousalSettings && Player.ArousalSettings.Active === "Inactive";
			const nShared = sharedList().length;
			/**
			 * @param {string} key
			 * @param {string} label
			 * @param {string} [title]
			 */
			const tab = (key, label, title) => h("button", { class: view === key ? "act" : "", title, onclick: () => ((view = key), key === "shared" && lookNow(), render()) }, label);
			/** @type {(HTMLElement | null)[]} */
			const parts = [
				h("div", { class: "ag-tabs" }, tab("stats", "Stats"), tab("shared", nShared ? `Shared (${nShared})` : "Shared", "What people in the room share with you"), tab("settings", "⚙", "Settings")),
			];
			if (view === "shared") parts.push(...sharedView());
			else if (view === "settings") parts.push(...settingsView());
			else
				parts.push(
					arousalOff ? h("div", { class: "hint" }, "Your arousal is turned off in the game's settings, so there's nothing to count.") : null,
					beltOffer(),
					clockCell("orgasm"),
					h(
						"div",
						{ class: `ag-rec${beating && g ? " new" : ""}`, "data-ag": "rec" },
						g
							? beating
								? `🏆 Longest yet: you've passed your record of ${fmtSpan(g.ms)}${state.timeMode === "online" ? " online" : ""}`
								: `🏆 Longest without${state.timeMode === "online" ? " (online)" : ""}: ${g.exact ? "" : "≥ "}${fmtSpan(g.ms)} ${g.manual ? "(entered by hand)" : `(${fmtDay(g.from)} → ${fmtDay(g.to)})`}`
							: "🏆 Your longest stretch shows here after your first orgasm."
					),
					h("div", { class: "ag-clocks" }, BOX_KEYS.map(clockCell)),
					h("div", { class: "hint ag-cause", "data-ag": "cause", title: "The items doing it right now" }, causeText()),
					h(
						"table",
						{},
						h("tr", {}, h("th", {}, ""), h("th", { title: `Since ${fmtWhen(session.start)}. A session carries on through reloads, reconnects and breaks shorter than ${SESSION_GAP_MS / 60_000} minutes.` }, "Session"), h("th", {}, "Today"), h("th", {}, "All")),
						KIND_KEYS.map((k) => h("tr", {}, h("td", {}, `${KINDS[k].icon} ${KINDS[k].label}`), h("td", {}, session[k]), h("td", {}, today[k]), h("td", { title: state.base[k] ? `${state.totals[k]} counted + ${state.base[k]} from before` : null }, allTime(k)))),
						h(
							"tr",
							{ title: `Time online with an edging effect on you. All: since ${fmtWhen(state.edgeSince)} (reset it in ⚙ → Clocks).` },
							h("td", {}, "🫠 Time edged"),
							h("td", { "data-ag-edge": "session" }, edgeText(session.edgeMs)),
							h("td", { "data-ag-edge": "today" }, edgeText(edgeToday())),
							h("td", { "data-ag-edge": "all" }, edgeText(state.edgeMs))
						)
					),
					h("div", { class: "hint", "data-ag": "belt", title: "Your Modular Chastity Belt's own record (it only counts while you wear it)" }, beltText()),
					h("div", { class: "hint", "data-ag": "game", title: "The number under the game's arousal meter when you zoom in on it. The game saves it when you leave its Preferences screen and with arousal updates in chat rooms, so it can lag behind or start at 0." }, gameCountText()),
					h(
						"details",
						{ ontoggle: (/** @type {Event & { target: HTMLDetailsElement }} */ e) => (openLog = e.target.open), open: openLog },
						h("summary", {}, `Recent (${log.length})`),
						h(
							"div",
							{ class: "ag-log" },
							log.length
								? log
									.slice(-50)
									.reverse()
									.map((e) =>
											e[1] === "away"
												? h("div", { class: "ag-away" }, `${fmtWhen(e[0])} ⏸ Away ${fmtSpan(Number(e[3]) || 0)}`)
												: h("div", {}, `${fmtWhen(e[0])} ${KINDS[e[1]].icon} ${KINDS[e[1]].one}${e[3] === "edge" ? " (edged)" : e[3] === "failed" ? ` (${KINDS.failed.icon} resist failed)` : e[3] === "belt" ? " (seen by your belt)" : ""}${e[2] ? ` in ${e[2]}` : ""}`)
									)
								: h("div", { class: "hint" }, "Nothing yet.")
						)
					)
				);
			root.replaceChildren(...parts.filter((x) => x != null));
		}

		// ---------- views ----------
		let view = "stats";
		// Settings sections fold away; which are open is remembered in this browser (Sharing starts open)
		const uiKey = () => `Afterglow.ui.${Player.MemberNumber || 0}`;
		/** @type {Record<string, boolean> | null} */
		let secOpen = null;
		/** @returns {Record<string, boolean>} */
		const readSecOpen = () => {
			if (secOpen) return secOpen;
			try {
				secOpen = /** @type {Record<string, boolean>} */ (JSON.parse(localStorage.getItem(uiKey()) || "null") || {});
			} catch {
				secOpen = {};
			}
			return secOpen;
		};
		/**
		 * @param {HTMLElement[]} out
		 * @param {string} key
		 * @param {string} title
		 * @param {(o: HTMLElement[]) => void} fill
		 */
		function section(out, key, title, fill) {
			const open = readSecOpen()[key] ?? key === "share";
			out.push(
				h(
					"button",
					{
						class: `ag-sec${open ? " open" : ""}`,
						"aria-expanded": open ? "true" : "false",
						onclick: () => {
							readSecOpen()[key] = !open;
							try {
								localStorage.setItem(uiKey(), JSON.stringify(secOpen));
							} catch {
								// storage full or blocked: carries on without saving
							}
							render();
						},
					},
					h("span", { class: "ag-sec-a" }, open ? "▾" : "▸"),
					title
				)
			);
			if (open) {
				/** @type {HTMLElement[]} */
				const inner = [];
				fill(inner);
				out.push(h("div", { class: "ag-sec-body" }, inner));
			}
		}
		function settingsView() {
			/** @type {HTMLElement[]} */
			const out = [];
			section(out, "share", "Sharing", (o) => o.push(...shareForm().filter((x) => x != null)));
			section(out, "clocks", "Clocks", (o) =>
				o.push(
					h(
						"label",
						{ class: "ag-row", title: "Time away: logged out, the game closed, or disconnected (noticed at your next login, to within a minute)" },
						"Clocks count",
						h(
							"select",
							{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((state.timeMode = e.target.value === "online" ? "online" : "real"), save(), render()) },
							h("option", { value: "real", selected: state.timeMode === "real" }, "all time"),
							h("option", { value: "online", selected: state.timeMode === "online" }, "only time online")
						)
					),
					h("div", { class: "hint" }, "Time away (logged out, game closed, disconnected) is noticed at your next login and listed in Recent as ⏸."),
					h("div", { class: "hint" }, `Time edged counts only while you're online. All time: since ${fmtWhen(state.edgeSince)}.`),
					h("button", { title: "Start the all-time total for time edged again from zero", onclick: resetEdgeTime }, "Reset time edged")
				)
			);
			section(out, "belt", "Chastity belt", (o) => o.push(...beltForm()));
			section(out, "before", "From before Afterglow", (o) => o.push(startForm()));
			section(out, "about", "What counts as what", (o) =>
				o.push(
					h("div", { class: "hint" }, `Counting since ${fmtWhen(state.since)}. Counts and records go with your account; the recent list stays in this browser.`),
					h("div", { class: "hint" }, "⛔ Denied: held at the edge by a denial effect. 🫠 Edged: held there by an edging effect (an Edged item or an Edging craft). A spell at the edge counts once (again after a minute's break, or after arousal drops)."),
					h("div", { class: "hint" }, "😵 Resist failed: you started resisting but the time ran out and you came. It's counted as an orgasm too."),
					h("div", { class: "hint" }, "⛔ and 💔 show a timer while a denial, edging or ruin item is on you: how long it's been on (🫠 for edging). Otherwise they and ✊ count how many since your last orgasm.")
				)
			);
			section(out, "reset", "Reset", (o) => o.push(h("button", { title: "Start counting again from zero", onclick: resetAll }, "Reset everything"), h("div", { class: "hint" }, "Every count, record and the recent list on this account; your settings stay. It asks first.")));
			return out;
		}

		// The belt: its own figures on the Stats view, and an offer when it saw an orgasm Afterglow didn't
		function beltText() {
			const b = state.belt.show ? beltInfo() : null;
			if (!b) return "";
			return `🔒 Belt: 💦 ${b.orgasms} · held back ${b.held} · ${b.last ? `last orgasm ${two(fmtSpan(Date.now() - b.last))} ago` : b.worn ? `none since it went on ${two(fmtSpan(Date.now() - b.worn))} ago` : "no orgasm yet"}`;
		}
		function beltOffer() {
			if (state.belt.mode !== "ask") return null;
			const x = beltNews();
			if (!x) return null;
			const text =
				x.kind === "start"
					? `Your belt last saw you orgasm ${fmtWhen(x.t)}, before Afterglow started counting. Start the clock from then?`
					: `Your belt saw an orgasm ${fmtWhen(x.t)} that Afterglow didn't (another computer, or before it loaded). Count it?`;
			return h(
				"div",
				{ class: "ag-offer" },
				h("div", {}, `🔒 ${text}`),
				h("div", { class: "ag-row" }, h("button", { onclick: () => beltApply(x) }, x.kind === "start" ? "Start from then" : "Count it"), h("button", { onclick: () => beltIgnore(x) }, "No"))
			);
		}
		function beltForm() {
			const b = beltInfo();
			return [
				h(
					"label",
					{ class: "ag-row", title: "When your belt saw an orgasm Afterglow didn't" },
					"Belt saw one I didn't",
					h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((state.belt.mode = /** @type {"ask" | "auto" | "off"} */ (e.target.value)), save(), render()) },
						h("option", { value: "ask", selected: state.belt.mode === "ask" }, "ask me"),
						h("option", { value: "auto", selected: state.belt.mode === "auto" }, "count it"),
						h("option", { value: "off", selected: state.belt.mode === "off" }, "ignore")
					)
				),
				h("label", { class: "ag-row" }, h("input", { type: "checkbox", checked: state.belt.show, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((state.belt.show = e.target.checked), save(), render()) }), "Show the belt's own figures"),
				h("div", { class: "hint" }, "The game's Modular Chastity Belt (and the Techno Chastity Cage) notes your last orgasm while you wear it. Afterglow compares the two, so an orgasm on another computer or before it loaded isn't lost. Its \"held back\" is how many orgasm prompts didn't end in one since your last (resisted or ruined); denial and edging don't count there."),
				h("div", { class: "hint" }, b ? `Wearing: ${b.name}.` : "You aren't wearing one now.")
			];
		}
		let openLog = false;

		// What people in the room share with you: one card each, clocks kept running by tick
		/** @param {{ at: number }} x */
		const ago = (x) => Date.now() - x.at; // since their message arrived
		const sharedList = () => [...shared].filter(([m]) => charOf(m));
		function sharedView() {
			const list = sharedList();
			if (!state.share.look) return [h("div", { class: "hint" }, "Looking for what others share is off (⚙ → Sharing).")];
			if (!inRoom()) return [h("div", { class: "hint" }, "Join a room to see what people there share with you.")];
			if (!list.length) return [h("div", { class: "hint" }, "Nobody in this room shares with you yet. Only people with Afterglow can, and only if their permissions let you see.")];
			return list.map(([m, x]) => sharedCard(m, x));
		}
		/**
		 * @param {number} m
		 * @param {{ at: number, d: AgStats }} x
		 */
		function sharedCard(m, x) {
			const d = x.d;
			const c = d.counts;
			const r = d.records;
			const dh = d.held;
			const held = dh ? HELD_KEYS.filter((k) => dh[k]) : [];
			const line = (/** @type {Partial<Record<AgKind, number>>} */ o) => KIND_KEYS.filter((k) => o[k]).map((k) => `${KINDS[k].icon} ${o[k]}`).join(" · ") || "none";
			return h(
				"div",
				{ class: "ag-share", title: `Shared by ${nameOf(m)}'s Afterglow. Only what their permissions let you see.` },
				h("div", { class: "ag-k" }, `${nameOf(m)} (#${m})`),
				c ? h("div", {}, h("span", { class: "ag-t", "data-sh-since": String(m) }, sharedSince(x)), " since last orgasm") : null,
				c ? h("div", {}, `This stretch: ⛔ ${c.streak.denied || 0} · 🫠 ${c.streak.edged || 0} · 💔 ${c.streak.ruined || 0} · ✊ ${c.streak.resisted || 0}`) : null,
				held.map((k) => h("div", { class: "ag-held", "data-sh-held": `${m}|${k}` }, sharedHeld(x, k))),
				r
					? h(
						"div",
						{},
						`🏆 ${r.gap ? `${r.gap.exact ? "" : "≥ "}${fmtSpan(r.gap.ms)}${r.online ? " online" : ""}` : "no record yet"}` +
								(r.edge.all >= 1000 ? ` · 🫠 time edged ${edgeText(r.edge.session)} session, ${edgeText(r.edge.all)} all` : "")
					)
					: null,
				c ? h("div", { class: "hint" }, `Today: ${line(c.today)}`) : null,
				c ? h("div", { class: "hint" }, `All: ${line(c.all)}`) : null
			);
		}
		/** @param {{ at: number, d: AgStats }} x */
		const sharedSince = (x) => x.d.counts ? `${x.d.counts.exact ? "" : "≥ "}${fmtSpan(x.d.counts.since + ago(x))}` : "";
		/**
		 * @param {{ at: number, d: AgStats }} x
		 * @param {AgHeldKind} k
		 */
		const sharedHeld = (x, k) => {
			const hd = x.d.held?.[k];
			if (!hd) return "";
			const label = { denied: "⛔ Denied", edged: "🫠 Edged", ruined: "💔 Ruin item on" }[k];
			const age = hd.age + ago(x);
			// The same second line as your own boxes: time online, and time actually edged, when they differ by a minute
			const ex = [];
			const away = Number.isFinite(hd.away) ? hd.away : 0;
			if (away >= 60_000) ex.push(`${two(fmtSpan(Math.max(0, age - away)))} online`);
			if (k === "edged" && typeof hd.edging === "number" && Number.isFinite(hd.edging)) {
				const e = hd.edging + ago(x);
				if (age - away - e >= 60_000) ex.push(`${edgeText(e)} edging`);
			}
			return `${label} ${two(fmtSpan(age))}${ex.length ? ` (${ex.join(", ")})` : ""}${hd.items?.length ? `: ${hd.items.join(", ")}` : ""}`;
		};

		// More → Sharing: who may see what, on the game's own permission ladder
		function shareForm() {
			const sh = state.share;
			/**
			 * @param {"counts" | "records" | "held"} key
			 * @param {string} title
			 */
			const pick = (key, title) =>
				h(
					"label",
					{ class: "ag-row", title },
					h("span", {}, { counts: "Clocks and counts", records: "Records, time edged", held: "Held now, which items" }[key]),
					h(
						"select",
						{ disabled: !sh.on, onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((sh[key] = e.target.value === "item" || e.target.value === "none" ? e.target.value : Number(e.target.value)), save(), render(), shareSettingsChanged()) },
						LEVELS.map(([v, label]) => h("option", { value: String(v), selected: sh[key] === v }, label))
					)
				);
			const permName = (LEVELS.find(([v]) => v === Number(Player.AllowedInteractions ?? 2)) || [0, "?"])[1];
			const viewers = inRoom() ? ChatRoomCharacter.filter((c) => c && c.MemberNumber !== Player.MemberNumber && /** @type {("counts" | "records" | "held")[]} */ (["counts", "records", "held"]).some((k) => allowedAt(c, sh[k]))) : [];
			return [
				h("label", { class: "ag-row" }, h("input", { type: "checkbox", checked: sh.on, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((sh.on = e.target.checked), save(), render(), shareSettingsChanged()) }), "Share my stats"),
				pick("counts", "The clocks and the counts table"),
				pick("records", "Your longest stretch, the records for one stretch, and time edged"),
				pick("held", "Whether a denial, edging or ruin item is on you right now, and which"),
				h("div", { class: "hint" }, `Your item permission in the game: ${permName}. Your blacklist and ghost list never see anything.`),
				sh.on ? h("div", { class: "hint" }, viewers.length ? `In this room, ${viewers.map((c) => nameOf(c.MemberNumber)).join(", ")} can see some of it (if they have Afterglow).` : "Nobody in this room can see anything.") : null,
				h(
					"label",
					{ class: "ag-row", title: "When you open Afterglow in a room, ask everyone there (one hidden message each, to them only) whether they share with you" },
					h("input", { type: "checkbox", checked: sh.look, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((sh.look = e.target.checked), save(), render()) }),
					"Show what others share with me"
				),
				h("div", { class: "hint" }, "Asking and answering use hidden messages sent to one person only, never to the room. Only someone with Afterglow can read them."),
			];
		}
		// The other way of counting, when it differs by more than a minute: "1d 4h online" or "2d 3h in all"
		/** @param {number} t */
		function otherTime(t) {
			const away = awayBetween(t, Date.now());
			if (away < 60_000) return "";
			return state.timeMode === "online" ? `${fmtSpan(elapsed(t, "real"))} in all` : `${fmtSpan(elapsed(t, "online"))} online`;
		}
		// Under a held box's timer, the other ways of counting it when they differ by more than a minute: "39m online"
		// (or "1h 11m in all" when the clocks count only time online), and for edging, how long you were actually edged
		// since it started ("35m edging", the time the Time edged table adds up)
		/** @param {AgHeldKind} on */
		function heldExtra(on) {
			const t = state.held[on];
			if (!t) return "";
			const parts = [];
			if (awayBetween(t, Date.now()) >= 60_000) parts.push(state.timeMode === "online" ? `${two(fmtSpan(elapsed(t, "real")))} in all` : `${two(fmtSpan(elapsed(t, "online")))} online`);
			if (on === "edged" && state.heldEdge != null && elapsed(t, "online") - state.heldEdge >= 60_000) parts.push(`${edgeText(state.heldEdge)} edging`);
			return parts.join(" · ");
		}
		// One box. The big one: time since the last orgasm. The small ones (denied, ruined, resisted): how many since
		// your last orgasm, with the record; denied and ruined turn into a timer while such an item is on you.
		// Clicking a box shows it on the dock tab's summary (📌).
		/** @param {AgKind} k */
		function clockCell(k) {
			const big = k === "orgasm";
			const pinned = k === state.show;
			const on = big ? null : boxHeld(k);
			const held = !!on;
			const x = big ? sinceFor(k) : null;
			const other = big && x ? otherTime(x.t) : "";
			const lastTxt = state.last[k] ? `last ${fmtWhen(state.last[k])}` : `none yet`;
			const sub = big
				? (state.lastOrgasmAt ? `Last one ${fmtWhen(state.lastOrgasmAt)}` : `None seen since Afterglow started counting (${fmtWhen(state.since)})`) + (other ? ` · ${other}` : "")
				: held
					? `${state.streak[on]} now · rec ${state.rec[on]}`
					: k === "resisted"
						? `rec ${state.rec[k]} · ${KINDS.failed.icon} ${allTime("failed")}`
						: k === "denied"
							? `rec ${state.rec.denied} · 🫠 ${state.streak.edged}`
							: `rec ${k === "ruined" || k === "edged" ? state.rec[k] : ""}`;
			/** @type {Record<string, string>} */
			const whatOf = { denied: "a denial item", edged: "an edging item", ruined: "a ruin item" };
			const what = whatOf[on || k] || "an item";
			const title = big
				? `Time since your last orgasm${state.timeMode === "online" ? ", online" : ""}${other ? `; ${other}` : ""}.`
				: held
					? `${what[0].toUpperCase()}${what.slice(1)} has been on you since ${fmtWhen(state.held[on])}${causes(on).length ? `: ${causes(on).join(", ")}` : ""}. ${state.streak[on]} ${KINDS[on].label.toLowerCase()} since your last orgasm; the most in one stretch: ${state.rec[on]}.${on === "edged" ? ` Time edged: ${edgeText(session.edgeMs)} this session, ${edgeText(state.edgeMs)} in all.` : ""}`
					: `${KINDS[k].label} since your last orgasm (${lastTxt}); the most in one stretch: ${k === "failed" ? 0 : state.rec[k]}.${k === "denied" ? ` 🫠 Edged since your last orgasm: ${state.streak.edged} (the most in one stretch: ${state.rec.edged}).` : ""}${what ? ` While ${k === "denied" ? "a denial or edging item" : what} is on you, this shows how long it's been on.` : ""}${k === "resisted" ? ` ${KINDS.failed.icon} ${allTime("failed")} times you tried to resist and came anyway (all time).` : ""}`;
			return h(
				"div",
				{
					class: `ag-clock${big ? " big" : ""}${pinned ? " pin" : ""}${held ? " on" : ""}`,
					title: `${title}${pinned ? " Shown on the dock tab." : " Click to show it on the dock tab."}`,
					onclick: () => ((state.show = k), save(), render()),
				},
				h("div", { class: "ag-k" }, big ? `${KINDS[k].icon} Since last orgasm${pinned ? " 📌" : ""}` : `${KINDS[on || k].icon} ${on === "edged" ? "Edged" : held ? "Held" : KINDS[k].label}${pinned ? " 📌" : ""}`),
				h("div", { class: "ag-t", "data-ag-clock": k }, clockText(k)),
				held ? h("div", { class: "ag-sub ag-x", "data-ag-extra": on }, heldExtra(on)) : null,
				h("div", { class: "ag-sub" }, sub)
			);
		}

		// "From before Afterglow": earlier totals, when the last orgasm was, and the longest stretch so far
		/** @param {number} t */
		const toInput = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
		function startForm() {
			/**
			 * @param {number} v
			 * @param {string} title
			 */
			const num = (v, title) => h("input", { type: "number", min: 0, step: 1, value: v || 0, title, style: "width:4.2em" });
			const totals = KIND_KEYS.map((k) => /** @type {[AgKind, HTMLInputElement]} */ ([k, num(state.base[k], `${KINDS[k].label} before Afterglow started counting`)]));
			const last = h("input", { type: "datetime-local", value: state.lastOrgasmAt ? toInput(state.lastOrgasmAt) : "", max: toInput(Date.now()), style: "width:100%" });
			const g = state.rec.gap?.manual ? state.rec.gap.ms : 0;
			const recD = num(Math.floor(g / 86_400_000), "Days");
			const recH = num(Math.floor((g % 86_400_000) / 3_600_000), "Hours");
			const note = h("div", { class: "hint" });
			const apply = () => {
				const int = (/** @type {HTMLInputElement} */ el) => Math.max(0, Math.min(1e6, Math.round(Number(el.value) || 0)));
				for (const [k, el] of totals) state.base[k] = int(el);
				if (last.value) {
					const t = new Date(last.value).getTime();
					if (!Number.isFinite(t) || t > Date.now()) return (note.textContent = "That time is in the future.");
					// Afterglow saw one after that: its own record wins
					if (state.lastOrgasmAt && t < state.lastOrgasmAt - 60_000) return (note.textContent = `Afterglow saw one later than that (${fmtWhen(state.lastOrgasmAt)}).`);
					state.lastOrgasmAt = t;
					state.streakStart = t;
				}
				const ms = int(recD) * 86_400_000 + int(recH) * 3_600_000;
				for (const key of /** @type {("gap" | "gapOnline")[]} */ (["gap", "gapOnline"])) {
					const cur = state.rec[key];
					if (ms > 0 && (!cur || cur.manual || ms > cur.ms)) state.rec[key] = { ms, from: 0, to: 0, exact: true, manual: true };
					else if (!ms && cur?.manual) state.rec[key] = null;
				}
				save();
				render();
			};
			return h(
				"div",
				{},
				h("div", { class: "ag-grid" }, totals.map(([k, el]) => h("label", { title: el.title }, `${KINDS[k].icon} ${KINDS[k].label}`, el))),
				h("label", { class: "ag-row" }, "Last orgasm", last),
				h("label", { class: "ag-row", title: "Your longest stretch without an orgasm before Afterglow. A longer one Afterglow sees replaces it." }, "Longest without", recD, "d", recH, "h"),
				h("div", { class: "ag-row" }, h("button", { title: "Save these", onclick: apply }, "Save"), note),
				h("div", { class: "hint" }, "Totals here are added to the All column. Leave the last orgasm empty if you don't know it.")
			);
		}

		// Once a second: the running clocks
		function tickClocks() {
			if (!panel || !(Player.MemberNumber && loadedFor === Player.MemberNumber)) return;
			panel.setSummary(clockText(state.show, true));
			for (const el of root?.querySelectorAll("[data-ag-clock]") || []) {
				const t = clockText(/** @type {AgKind} */ (/** @type {HTMLElement} */ (el).dataset.agClock));
				if (el.textContent !== t) el.textContent = t;
			}
			for (const el of root?.querySelectorAll("[data-ag-extra]") || []) {
				const t = heldExtra(/** @type {AgHeldKind} */ (/** @type {HTMLElement} */ (el).dataset.agExtra));
				if (el.textContent !== t) el.textContent = t;
			}
			/** @type {Record<string, number>} */
			const edge = { session: session.edgeMs, today: edgeToday(), all: state.edgeMs };
			for (const el of root?.querySelectorAll("[data-ag-edge]") || []) {
				const t = edgeText(edge[/** @type {HTMLElement} */ (el).dataset.agEdge || ""] || 0);
				if (el.textContent !== t) el.textContent = t;
			}
			const cause = root?.querySelector('[data-ag="cause"]');
			if (cause) {
				const t = causeText();
				if (cause.textContent !== t) cause.textContent = t;
			}
			for (const el of root?.querySelectorAll("[data-sh-since]") || []) {
				const x = shared.get(Number(/** @type {HTMLElement} */ (el).dataset.shSince));
				if (x?.d.counts) {
					const t = sharedSince(x);
					if (el.textContent !== t) el.textContent = t;
				}
			}
			for (const el of root?.querySelectorAll("[data-sh-held]") || []) {
				const [m, k] = /** @type {[string, AgHeldKind]} */ ((/** @type {HTMLElement} */ (el).dataset.shHeld || "").split("|"));
				const x = shared.get(Number(m));
				if (x?.d.held?.[k]) {
					const t = sharedHeld(x, k);
					if (el.textContent !== t) el.textContent = t;
				}
			}
			const bl = root?.querySelector('[data-ag="belt"]');
			if (bl && bl.textContent !== beltText()) bl.textContent = beltText();
			const gc = root?.querySelector('[data-ag="game"]');
			if (gc && gc.textContent !== gameCountText()) gc.textContent = gameCountText();
			// Passing the record redraws the record line
			const g = recGap();
			const rec = root?.querySelector('[data-ag="rec"]');
			if (rec && g && elapsed(state.streakStart) > g.ms && !rec.classList.contains("new")) render();
		}
		return { mount, unmount, render, tick: tickClocks, isOpen: () => !!panel?.isOpen(), open: () => (panel?.open(), lookNow(), render()) };
	})();

	// ---------- the Modular Chastity Belt's own record ----------
	// While worn, the game's Modular Chastity Belt notes the time of your last orgasm (TimeSinceLastOrgasm), how many
	// orgasms (OrgasmCount) and how many orgasm prompts didn't end in one (RuinedOrgasmCount, its "deny count"; it starts
	// again at each orgasm). If it saw an orgasm Afterglow didn't (another computer, before installing), offer to count it.
	// The Techno Chastity Cage uses the same code. Both start "last orgasm" at the time they're put on (TimeWorn), so
	// their time is an orgasm only when it's later than that.
	const BELTS = ["ModularChastityBelt", "TechnoChastityCage"];
	const BELT_SLACK_MS = 2 * 60_000; // the belt notes the time when it's next drawn: allow for that
	function beltInfo() {
		const it = Array.isArray(Player.Appearance) ? Player.Appearance.find((a) => BELTS.includes(a?.Asset?.Name)) : null;
		if (!it) return null;
		const p = it.Property || {};
		const n = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
		const worn = n(p.TimeWorn);
		const t = n(p.TimeSinceLastOrgasm);
		// Without TimeWorn (older items), trust the time only once it has counted an orgasm
		const real = worn ? t > worn + 5000 : n(p.OrgasmCount) > 0;
		return { name: it.Craft?.Name || it.Asset.Description || "Chastity belt", orgasms: n(p.OrgasmCount), held: n(p.RuinedOrgasmCount), last: real ? t : 0, worn };
	}
	// { t, kind }: "missed" (an orgasm after Afterglow's last one) or "start" (before Afterglow started counting, while
	// it hasn't seen one yet: it can start the clock from there); null if the belt agrees
	function beltNews() {
		const b = beltInfo();
		if (!b || !b.last || b.last > Date.now() + 60_000 || b.last === state.belt.ignored) return null;
		const known = state.lastOrgasmAt;
		if (known) return b.last > known + BELT_SLACK_MS ? { t: b.last, kind: "missed" } : null;
		return b.last < state.since ? { t: b.last, kind: "start" } : { t: b.last, kind: "missed" };
	}
	/** @param {{ t: number, kind: string }} x */
	function beltApply(x) {
		if (!x) return;
		state.belt.ignored = x.t;
		if (x.kind === "start") {
			state.lastOrgasmAt = x.t;
			state.streakStart = x.t;
		} else {
			// An orgasm at x.t: it ends the stretch then (a record if it's the longest), and counts
			const gap = x.t - state.streakStart;
			if (gap > 0) {
				const online = gap - awayBetween(state.streakStart, x.t);
				const span = { from: state.streakStart, to: x.t, exact: !!state.lastOrgasmAt };
				if (!state.rec.gap || gap > state.rec.gap.ms) state.rec.gap = { ms: gap, ...span };
				if (!state.rec.gapOnline || online > state.rec.gapOnline.ms) state.rec.gapOnline = { ms: online, ...span };
			}
			state.totals.orgasm++;
			state.last.orgasm = Math.max(state.last.orgasm || 0, x.t);
			if (x.t >= session.start) session.orgasm++;
			state.lastOrgasmAt = x.t;
			state.streakStart = x.t;
			// This stretch: only what Afterglow saw after it
			for (const k of STREAK_KEYS) state.streak[k] = log.filter((e) => e[0] > x.t && e[1] === k).length;
			log.push([x.t, "orgasm", "", "belt"]);
			log.sort((a, b) => a[0] - b[0]);
			if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
			writeLog();
			writeSession();
		}
		save();
		ui.render();
		pushShares();
	}
	/** @param {{ t: number, kind: string }} x */
	function beltIgnore(x) {
		if (!x) return;
		state.belt.ignored = x.t;
		save();
		ui.render();
	}
	/** @type {string | null} */
	let beltShown = null; // the news on screen, to redraw when it changes
	let beltCheckAt = 0;
	function checkBelt() {
		if (!Player.MemberNumber || loadedFor !== Player.MemberNumber || Date.now() - beltCheckAt < 5000) return;
		beltCheckAt = Date.now();
		const x = state.belt.mode === "off" ? null : beltNews();
		if (x && state.belt.mode === "auto") return beltApply(x);
		const key = x ? `${x.kind}|${x.t}` : "";
		if (key !== beltShown) {
			beltShown = key;
			ui.render();
		}
	}

	// ---------- sharing ----------
	// Someone else's Afterglow asks ("ask"), only with a hidden message sent to you alone, when they open Afterglow and
	// every 30 s while it's open. Yours answers ("stats"), to them alone, with the parts the game's permissions let
	// them see, and sends news (a new orgasm, denial, an item going on) to whoever asked in the last minute. People
	// without Afterglow simply ignore the ask. Nothing is broadcast to the room.
	const MSG = "Afterglow";
	const MSG_V = 1;
	const ASK_EVERY_MS = 30_000; // ask someone who shares with you this often while Afterglow is open
	const ASK_OTHERS_MS = 10 * 60_000; // and someone who didn't answer, this often
	const SHARED_STALE_MS = 95_000; // no answer for this long: they stopped sharing or left
	const WATCH_MS = 65_000; // send news to someone who asked within this long
	const LEVELS = [
		["item", "Same as my item permissions"],
		[0, "Everyone in the room"],
		[1, "Everyone except blacklist"],
		[2, "Owner, lovers, whitelist, dominants"],
		[3, "Owner, lovers, whitelist"],
		[4, "Owner and lovers"],
		[5, "Owner only"],
		["none", "Nobody"],
	];
	const inRoom = () => typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" && typeof ChatRoomData !== "undefined" && !!ChatRoomData && typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter);
	/** @param {number} m */
	const charOf = (m) => (inRoom() ? ChatRoomCharacter.find((c) => c && c.MemberNumber === m) : null);
	/** @param {number} m */
	const nameOf = (m) => {
		const c = charOf(m);
		return c ? (typeof CharacterNickname === "function" ? CharacterNickname(c) : c.Nickname || c.Name) : `#${m}`;
	};
	// The game's own ladder (ServerChatRoomGetAllowItem), at the level you chose; blacklist and ghost list never pass
	/**
	 * @param {Character | null | undefined} c
	 * @param {AgLevel} level
	 */
	function allowedAt(c, level) {
		try {
			if (!c || typeof c.MemberNumber !== "number" || c.MemberNumber === Player.MemberNumber || level === "none") return false;
			const P = Player;
			if (P.HasOnBlacklist?.(c) || P.HasOnGhostlist?.(c)) return false;
			let lvl = level === "item" ? Number(P.AllowedInteractions ?? 2) : Number(level);
			if (!Number.isFinite(lvl)) return false;
			if (P.IsOwnedByCharacter?.(c)) return true;
			if (lvl <= 1) return true;
			const lover = !!c.IsLoverOfCharacter?.(P);
			const white = !!P.HasOnWhitelist?.(c);
			if (lvl === 2) {
				const dom = typeof ReputationGet === "function" && Array.isArray(c.Reputation) && ReputationGet(c, "Dominant") + 25 >= ReputationGet(P, "Dominant");
				return white || lover || dom;
			}
			if (lvl === 3) return white || lover;
			if (lvl === 4) return lover;
			return false;
		} catch {
			return false;
		}
	}
	/**
	 * @param {number} target
	 * @param {AgMessage} payload
	 */
	function send(target, payload) {
		if (!inRoom() || typeof ServerSend !== "function" || typeof target !== "number") return;
		try {
			ServerSend("ChatRoomChat", { Content: MSG, Type: "Hidden", Target: target, Dictionary: /** @type {any[]} */ ([{ message: { v: MSG_V, ...payload } }]) });
		} catch (e) {
			console.warn(TAG, "send failed", e);
		}
	}
	// One message at a time, a little apart, so opening Afterglow in a full room doesn't flood the server
	/** @type {{ target: number, payload: AgMessage }[]} */
	const outbox = [];
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let outboxTimer;
	/**
	 * @param {number} target
	 * @param {AgMessage} payload
	 */
	function queue(target, payload) {
		const i = outbox.findIndex((o) => o.target === target && o.payload.t === payload.t);
		if (i >= 0) outbox[i] = { target, payload };
		else outbox.push({ target, payload });
		if (!outboxTimer) outboxTimer = setTimeout(drain, 0);
	}
	function drain() {
		outboxTimer = undefined;
		const o = outbox.shift();
		if (!o) return;
		send(o.target, o.payload);
		if (outbox.length) outboxTimer = setTimeout(drain, 350);
	}

	// --- you, sharing ---
	/** @type {Map<number, number>} */
	const watchers = new Map(); // member -> when they last asked
	/** @type {Set<number>} */
	const sentTo = new Set(); // members we've sent stats to (and haven't told to stop)
	/** @type {Map<number, number>} */
	const askers = new Map(); // member -> when they last asked (whether or not they could see anything)
	// What this person may see right now (ages in ms, so their clock doesn't need to match yours)
	/**
	 * @param {Character} c
	 * @returns {AgStats | null}
	 */
	function statsFor(c) {
		if (!state.share.on || !loadedFor || loadedFor !== Player.MemberNumber) return null;
		const now = Date.now();
		/** @type {AgStats} */
		const out = { t: "stats", name: Player.Nickname || Player.Name || "" };
		if (allowedAt(c, state.share.counts)) {
			out.counts = {
				since: elapsed(state.streakStart),
				exact: !!state.lastOrgasmAt,
				streak: { ...state.streak },
				session: /** @type {Record<AgKind, number>} */ (Object.fromEntries(KIND_KEYS.map((k) => [k, session[k]]))),
				today: todayCounts(),
				all: /** @type {Record<AgKind, number>} */ (Object.fromEntries(KIND_KEYS.map((k) => [k, allTime(k)]))),
			};
		}
		if (allowedAt(c, state.share.records)) {
			const g = recGap();
			out.records = {
				gap: g ? { ms: g.ms, exact: !!g.exact, manual: !!g.manual } : null,
				rec: /** @type {Record<AgStreakKind, number>} */ (Object.fromEntries(STREAK_KEYS.map((k) => [k, state.rec[k]]))),
				edge: { session: session.edgeMs, today: edgeToday(), all: state.edgeMs },
				online: state.timeMode === "online",
			};
		}
		if (allowedAt(c, state.share.held)) {
			const held = (out.held = /** @type {Partial<Record<AgHeldKind, AgSharedHeld>>} */ ({}));
			for (const k of HELD_KEYS)
				if (state.held[k])
					held[k] = {
						age: now - state.held[k],
						away: awayBetween(state.held[k], now),
						...(k === "edged" && state.heldEdge != null ? { edging: state.heldEdge } : {}),
						items: causes(k).slice(0, 4),
					};
		}
		return out.counts || out.records || out.held ? out : null;
	}
	/** @param {number} m */
	function answer(m) {
		const c = charOf(m);
		const stats = c && statsFor(c);
		if (!stats) {
			// They could see something before (sharing turned off, a permission changed): tell them once, so their view clears
			if (c && sentTo.has(m)) queue(m, { t: "stop" });
			sentTo.delete(m);
			return watchers.delete(m);
		}
		sentTo.add(m);
		watchers.set(m, watchers.get(m) || Date.now());
		queue(m, stats);
	}
	// News for whoever is watching (each checked again: a permission can change at any time)
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let pushTimer;
	function pushShares() {
		if (!watchers.size || pushTimer) return;
		pushTimer = setTimeout(() => {
			pushTimer = undefined;
			const now = Date.now();
			for (const [m, at] of watchers) {
				if (now - at > WATCH_MS || !charOf(m)) watchers.delete(m);
				else answer(m);
			}
		}, 1500);
	}

	// You changed who may see what: answer everyone who asked lately (their Afterglow is open), so a new "yes" or
	// "no" reaches them now instead of at their next ask
	function shareSettingsChanged() {
		const now = Date.now();
		for (const [m, at] of askers) {
			if (now - at > ASK_OTHERS_MS + 60_000 || !charOf(m)) askers.delete(m);
			else {
				watchers.set(m, now);
				answer(m);
			}
		}
	}

	// --- others sharing with you ---
	/** @type {Map<number, { at: number, d: AgStats }>} */
	const shared = new Map(); // member -> { at, d }: what they last sent
	/** @type {Map<number, number>} */
	const askedAt = new Map(); // member -> when we last asked
	let lookOpenedAt = 0;
	/** @param {boolean} panelOpen */
	function lookAround(panelOpen) {
		if (!panelOpen || !state.share.look || !inRoom() || !loadedFor) return;
		const now = Date.now();
		for (const c of ChatRoomCharacter) {
			const m = c?.MemberNumber;
			if (typeof m !== "number" || m === Player.MemberNumber) continue;
			const last = askedAt.get(m) || 0;
			const every = shared.has(m) ? ASK_EVERY_MS : ASK_OTHERS_MS;
			if (now - last >= every || last < lookOpenedAt) {
				askedAt.set(m, now);
				queue(m, { t: "ask" });
			}
		}
		for (const [m, x] of shared) if (!charOf(m) || now - x.at > SHARED_STALE_MS) shared.delete(m);
	}
	// Opening the panel asks everyone again (at most once a minute)
	function lookNow() {
		if (Date.now() - lookOpenedAt > 60_000) lookOpenedAt = Date.now();
	}
	/** @param {ServerChatRoomMessage} data */
	function receive(data) {
		if (!data || data.Type !== "Hidden" || data.Content !== MSG || typeof data.Sender !== "number" || data.Sender === Player.MemberNumber) return;
		const msg = Array.isArray(data.Dictionary) ? /** @type {any[]} */ (data.Dictionary).find((d) => d && d.message)?.message : null;
		if (!msg || typeof msg !== "object" || msg.v !== MSG_V) return;
		const m = data.Sender;
		if (msg.t === "ask") {
			askers.set(m, Date.now());
			watchers.set(m, Date.now());
			answer(m);
		} else if (msg.t === "stats") {
			shared.set(m, { at: Date.now(), d: msg });
			ui.render();
		} else if (msg.t === "stop") {
			if (shared.delete(m)) ui.render();
		}
	}
	mod.hookFunction("ChatRoomMessage", 0, (args, next) => {
		safely(() => receive(args[0]));
		return next(args);
	});

	function resetAll() {
		if (!window.confirm("Reset every Afterglow count, record and the recent list on this account? This can't be undone.")) return;
		// Start counting again; keep your choices (sharing, belt, which time the clocks count, what the tab shows)
		const keep = { share: state.share, belt: { ...state.belt, ignored: 0 }, timeMode: state.timeMode, show: state.show };
		state = { ...fresh(), ...keep };
		session = newSession();
		writeSession();
		log = [];
		writeLog();
		save();
		ui.render();
	}

	// ---------- /afterglow ----------
	function statsLine() {
		const g = recGap();
		return (
			`✨ ${state.lastOrgasmAt ? "" : "≥ "}${sinceText()}${state.timeMode === "online" ? " online" : ""} since last orgasm` +
			` · this stretch: ${state.streak.denied} denied, ${state.streak.edged} edged, ${state.streak.ruined} ruined, ${state.streak.resisted} resisted` +
			(g ? ` · longest: ${g.exact ? "" : "≥ "}${fmtSpan(g.ms)}` : "") +
			` · all: ${allTime("orgasm")} orgasms, ${allTime("denied")} denied, ${allTime("edged")} edged, ${allTime("resisted")} resisted, ${allTime("failed")} failed resists` +
			(state.edgeMs >= 60_000 ? ` · time edged: ${edgeText(session.edgeMs)} this session, ${edgeText(state.edgeMs)} in all` : "")
		);
	}
	const COMMAND = {
		Tag: "afterglow",
		Description: ": Afterglow: open the panel, or 'stats' for a summary only you see",
		Action: (/** @type {string} */ args) => {
			if (String(args || "").trim().toLowerCase() === "stats") {
				if (typeof ChatRoomSendLocal === "function") ChatRoomSendLocal(statsLine(), 30_000);
				return;
			}
			ui.open();
		},
	};
	let commandAdded = false;
	function addCommand() {
		if (commandAdded || typeof Commands === "undefined" || typeof CommandCombine !== "function") return;
		commandAdded = true;
		if (Commands.some((c) => c.Tag === COMMAND.Tag)) return console.warn(TAG, "/afterglow is already used by another add-on");
		CommandCombine([COMMAND]);
	}

	// ---------- wiring ----------
	ui.mount();
	// The tick runs off a worker: a background tab's own timers slow to once a minute after a few minutes, which made
	// time edged and the "still here" marks coarse. A worker's timers aren't slowed, and its messages arrive on time.
	// If a worker can't start (blocked by the page's security policy), plain setInterval is the fallback.
	/**
	 * @param {() => void} fn
	 * @param {number} ms
	 */
	function startTicker(fn, ms) {
		/** @type {Worker | null} */
		let worker = null;
		/** @type {string | null} */
		let url = null;
		/** @type {ReturnType<typeof setInterval> | undefined} */
		let fallback;
		const useFallback = () => {
			if (fallback) return;
			worker?.terminate();
			worker = null;
			fallback = setInterval(fn, ms);
		};
		try {
			url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" }));
			worker = new Worker(url);
			let ticked = false;
			worker.onmessage = () => {
				ticked = true;
				if (worker) fn();
			};
			worker.onerror = useFallback;
			setTimeout(() => ticked || useFallback(), 2000);
		} catch {
			useFallback();
		}
		return () => {
			worker?.terminate();
			worker = null;
			clearInterval(fallback);
			fallback = -1;
			if (url) URL.revokeObjectURL(url);
		};
	}
	function tick() {
		addCommand();
		if (Player.MemberNumber && loadedFor !== Player.MemberNumber) {
			loadedFor = Player.MemberNumber;
			load();
			ui.render();
		} else if (!Player.MemberNumber && loadedFor) {
			loadedFor = null;
			ui.render();
		}
		if ((Player.ArousalSettings?.Progress ?? 0) < DENY_DROP) dropped = true;
		safely(checkHeld);
		safely(addEdgeTime);
		safely(checkBelt);
		safely(() => {
			const before = shared.size;
			lookAround(ui.isOpen());
			if (shared.size !== before) ui.render();
		});
		if (loadedFor && Player.MemberNumber === loadedFor && connected()) {
			// Back after a disconnect, or the computer slept, without a new login: that silence was time away too
			if (aliveAt && Date.now() - aliveAt > AWAY_MIN_MS + ALIVE_EVERY_MS) {
				if (Date.now() - aliveAt > SESSION_GAP_MS) session = newSession(); // a long break (overnight sleep): a new session
				addAway(aliveAt, Date.now());
				markAlive(true);
				ui.render();
			} else markAlive();
		}
		ui.tick();
	}
	const stopTicker = startTicker(tick, 1000);

	// Leaving the page: keep the session, and save anything not yet saved with the account (time edged is otherwise
	// saved once a minute)
	const onLeave = () => {
		writeSession();
		if (dirty) saveNow();
	};
	window.addEventListener("pagehide", onLeave);

	window.Afterglow = {
		version: MOD_INFO.version,
		state: () => state,
		session: () => ({ ...session }),
		log: () => [...log],
		stats: statsLine,
		unload() {
			stopTicker();
			clearTimeout(outboxTimer);
			clearTimeout(pushTimer);
			window.removeEventListener("pagehide", onLeave);
			clearTimeout(saveTimer);
			ui.unmount();
			mod.unload();
			delete window.Afterglow;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded`);
})().catch((err) => console.error("[Afterglow]", err));
