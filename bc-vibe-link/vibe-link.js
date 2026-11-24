// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Vibe Link for Bondage Club
// Drives real toys (through Intiface Central / buttplug.io) from the vibrators your character wears.
// Phase 1: five-level mapping, smooth ramps between levels, safety stop, strength cap.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_VibeLink", fullName: "Nightstand: Vibe Link", version: "0.15.2", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-vibe-link" };
	const TAG = "[VibeLink]";
	const SETTINGS_KEY = "VibeLink";
	const LOCAL_KEY = "VibeLink.local"; // per-browser things: panel position, open/closed, paused
	const TICK_MS = 50; // ramp resolution
	const MIN_SEND_MS = 100; // never more than 10 commands a second per toy
	const MIN_SEND_MS_LIVE = 50; // during live remote control: up to 20 a second
	const LEVEL_NAMES = ["Off", "Low", "Medium", "High", "Max"]; // game Intensity -1..3

	// Re-running the script (dev reload) replaces the previous instance
	if (window.VibeLink && typeof window.VibeLink.unload === "function") window.VibeLink.unload();

	/**
	 * @typedef {"wave" | "pulse" | "heartbeat" | "climb" | "stairs" | "tease" | "random" | "quake"} VLWaveType
	 * @typedef {{ type: VLWaveType, min: number, max: number, period: number, dur: number, seed: number }} VLWave a pattern shape, min-max %, one cycle in ms, how long (0: until stopped)
	 * @typedef {{ type: "prog", steps: VLWave[], loop: boolean, min: number, max: number, period: number, dur: number, seed: number }} VLProg a program: patterns one after another
	 * @typedef {{ type: "rec", pts: [number, number][], min: number, max: number, period: number, dur: number, seed: number }} VLRec a recording: [ms, 0-100] points
	 * @typedef {VLWave | VLProg | VLRec} VLPattern
	 * @typedef {{ type: string, min: number, max: number, period: number }} VLModeSetting what a game vibrator mode plays
	 * @typedef {{ levels: number[], rampUp: number, rampDown: number, curve: "ease" | "linear", cap: number }} VLTuning
	 * @typedef {VLTuning & { name: string, links: Record<string, string> }} VLPreset
	 * @typedef {{ name: string, p: VLPattern }} VLSaved
	 * @typedef {{ on: boolean, mode: "ask" | "list", trustOwners: boolean, always: Record<string, string>, blocked: Record<string, string>, lockoutMin: number, safeWord: string, announce: "off" | "me" | "room", bufferMs: number }} VLRemoteSettings
	 * @typedef {VLTuning & { url: string, autoConnect: boolean, links: Record<string, string>, modes: Record<string, VLModeSetting | "game">, modesFollowGame: boolean, chatLines: boolean, toyHidden: Record<string, boolean>, selfIgnoreRules: boolean, chartToMax: boolean, hotkey: { ctrl: boolean, shift: boolean, alt: boolean, code: string }, stopWhenHidden: boolean, rememberLinks: boolean, presets: VLPreset[], saved: VLSaved[], keepHistory: boolean, remote: VLRemoteSettings, v: number }} VLSettings
	 * @typedef {{ paused: boolean, virtual?: boolean, secOpen?: Record<string, boolean>, [more: string]: any }} VLLocal what's kept in this browser
	 * @typedef {{ t0: number, pts: [number, number][] }} VLRecording a live session being recorded
	 * @typedef {{ buf?: { at: number, v: number }[], offset?: number | null, val?: number, lvl?: number | null, mode?: string, pat?: VLPattern, t0?: number, rnd?: (n: number) => number, until?: number, free?: boolean, game?: boolean, gap?: number, at?: number, rec?: VLRecording | null }} VLLane what drives your toys during remote control: live points, a pattern, a level or a mode
	 * @typedef {{ by: number, at: number, gameSig: string, lanes: Map<string, VLLane>, prev: Record<string, any>, mirror: Record<string, any>, lost?: boolean }} VLRemote who controls you, and their lanes
	 * @typedef {{ Index: number, StepCount: number, type: string }} VLMotor
	 * @typedef {{ index: number, id: string, name: string, display: string, key: string, devKey: string, motor: { n: number, of: number } | null, vibes: VLMotor[], batteryIndex: number, batteryRange: number[], battery: number | null, value: number, from: number, target: number | null, t0: number, dur: number, sent: number | null, sentAt: number, sending: boolean, testUntil: number, virtual?: boolean, followPat?: boolean, linear?: boolean, ravg?: number | null, hist?: [number, number][], histN?: number }} VLToy one vibration motor
	 * @typedef {{ ver: string, accepts: boolean, at: number }} VLPeer someone here running Vibe Link
	 * @typedef {{ until: number, at: number, self?: boolean }} VLGrant control you gave someone
	 * @typedef {{ n: string, k: string | null, pct: number, e: boolean, m: string, lv: number | null, md: string | null, el: number, pat: VLPattern | null, pl: string | null, left: number }} VLStatusToy
	 * @typedef {{ at: number, active: boolean, pat: VLPattern | null, pl: string | null, left: number, toys: VLStatusToy[] }} VLStatus what the wearer says their toys are doing
	 * @typedef {{ pat: VLPattern, rnd: (n: number) => number, t0: number, until: number }} VLPlaying
	 * @typedef {{ state: string, until?: number, reason?: string, at: number, playingBy?: Map<string, VLPlaying>, liveBy?: Map<string, number>, prog?: { steps: VLWave[], loop: boolean } | null, sel?: string, savedSel?: string, val?: number, pts?: [number, number][], ptsKey?: string, liveTimer?: ReturnType<typeof setTimeout> | null, lastT?: number, flushAt?: number, epoch?: number, status?: VLStatus, rec?: VLRecording | null, pat?: VLPattern | null }} VLControl you controlling someone (or yourself)
	 * @typedef {{ at: number, dir: "in" | "out", who: number, name: string, ev: string, text: string, p?: VLPattern }} VLHistEntry
	 * @typedef {Record<string, any>} VLMsg a remote control message, checked field by field on arrival
	 */
	/** @param {number} ms */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof Player === "undefined" || typeof ServerSocket === "undefined" || typeof LZString === "undefined") await sleep(250);

	/** @type {ModSDKModAPI | null} */
	let mod = null;
	try {
		if (typeof bcModSdk !== "undefined") mod = bcModSdk.registerMod(MOD_INFO);
	} catch (e) {
		console.warn(TAG, "mod SDK registration failed", e);
	}

	// ---------- settings ----------

	// The game vibrator's own modes, and what each plays on your toy: a pattern (shape, low-high %, speed), or "game" to
	// follow the level steps the game makes in that mode
	/** @type {string[]} */
	const VIBE_MODES = ["Random", "Escalate", "Tease", "Deny", "Edge"];
	/** @type {Record<string, VLModeSetting>} */
	const MODE_DEFAULTS = {
		Random: { type: "random", min: 10, max: 80, period: 4000 },
		Escalate: { type: "climb", min: 5, max: 100, period: 30000 },
		Tease: { type: "tease", min: 0, max: 80, period: 8000 },
		Deny: { type: "climb", min: 20, max: 90, period: 12000 },
		Edge: { type: "wave", min: 55, max: 95, period: 6000 },
	};
	/** @type {VLSettings} */
	const DEFAULTS = {
		url: "ws://127.0.0.1:12345",
		autoConnect: true,
		links: {}, // toy key -> body slot (asset group name)
		levels: [0, 10, 40, 75, 100], // % for Off, Low, Medium, High, Max
		modes: structuredClone(MODE_DEFAULTS), // game vibrator mode -> pattern on the toy, or "game"
		modesFollowGame: false, // on: every mode follows the game's level steps instead of its pattern
		rampUp: 1500,
		rampDown: 800,
		curve: "ease", // "ease" | "linear"
		cap: 100, // % everything is scaled to
		chatLines: true, // Vibe Link's lines in your chat (its 〰 notes, and Vibe Link announcements from anyone); off hides them
		toyHidden: {}, // toy key -> true (hidden) / false (shown); unset: toys without a vibration motor are hidden
		selfIgnoreRules: false, // immersion off: "Play on my toys" works whatever the game says (worn vibrator still follows the game's rules)
		chartToMax: false, // toy charts: false = 0-100% with a dashed line at max strength; true = 0-max fills the chart
		hotkey: { ctrl: true, shift: false, alt: false, code: "Space" },
		stopWhenHidden: false,
		rememberLinks: false, // off: every session starts with toys following nothing
		presets: [], // { name, links, levels, rampUp, rampDown, curve, cap }
		saved: [], // { name, p }: your saved patterns, programs and recordings
		keepHistory: true, // remote control history, kept in this browser only
		// remote control by other Vibe Link users (off until you turn it on)
		remote: {
			on: false,
			mode: "ask", // "ask": everyone the game allows can ask; "list": only your Always list
			trustOwners: false, // owner and lovers get control without asking
			always: {}, // member -> name: get control without asking
			blocked: {}, // member -> name: always refused
			lockoutMin: 5, // after 🛑 / hotkey / safe word, refuse control this long
			safeWord: "", // saying it in chat stops everything
			announce: "off", // remote control changes in chat: "off" | "me" (only you see them) | "room" (everyone in the room)
			bufferMs: 250, // live control is replayed this far behind the controller, to smooth out network stalls
		},
		v: 2,
	};
	const MAX_PRESETS = 20;
	const MAX_SAVED = 40;
	const SAVED_MAX_CHARS = 60_000; // saved patterns go with your account settings, so they're kept small
	let settings = structuredClone(DEFAULTS);
	/** @type {VLLocal} */
	let local = { paused: false }; // older versions also kept pos/open here; the dock keeps those now

	try {
		local = { ...local, .../** @type {Partial<VLLocal>} */ (JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}")) };
	} catch {
		// missing or unreadable: the defaults stay
	}
	const saveLocal = () => {
		try {
			localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
		} catch {
			// storage full or blocked: carries on without saving
		}
	};

	/**
	 * @param {any} s settings as saved
	 * @returns {VLSettings}
	 */
	function sanitizeSettings(s) {
		/** @type {VLSettings} */
		const out = { ...structuredClone(DEFAULTS), ...s };
		/**
		 * @param {unknown} v
		 * @param {number} lo
		 * @param {number} hi
		 * @param {number} d
		 */
		const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
		out.levels = DEFAULTS.levels.map((d, i) => num(out.levels?.[i], 0, 100, d));
		out.rampUp = num(out.rampUp, 0, 10000, DEFAULTS.rampUp);
		out.rampDown = num(out.rampDown, 0, 10000, DEFAULTS.rampDown);
		out.cap = num(out.cap, 0, 100, 100);
		if (out.curve !== "linear") out.curve = "ease";
		if (!out.links || typeof out.links !== "object") out.links = {};
		if (!out.hotkey || typeof out.hotkey.code !== "string") out.hotkey = { ...DEFAULTS.hotkey };
		if (typeof out.url !== "string" || !out.url) out.url = DEFAULTS.url;
		out.rememberLinks = !!out.rememberLinks;
		out.chartToMax = !!out.chartToMax;
		out.selfIgnoreRules = !!out.selfIgnoreRules;
		out.chatLines = out.chatLines !== false;
		/** @type {Record<string, boolean>} */
		const th = {};
		if (s?.toyHidden && typeof s.toyHidden === "object") for (const [k, v] of Object.entries(s.toyHidden)) if (typeof v === "boolean") th[String(k).slice(0, 80)] = v;
		out.toyHidden = th;
		out.modesFollowGame = !!out.modesFollowGame;
		const sm = s?.modes && typeof s.modes === "object" ? s.modes : {};
		out.modes = Object.fromEntries(
			VIBE_MODES.map((k) => {
				const v = sm[k];
				if (v === "game") return [k, "game"];
				const d = MODE_DEFAULTS[k];
				if (!v || typeof v !== "object" || typeof v.type !== "string") return [k, { ...d }];
				let min = num(v.min, 0, 100, d.min);
				let max = num(v.max, 0, 100, d.max);
				if (min > max) [min, max] = [max, min];
				return [k, { type: v.type.slice(0, 20), min: Math.round(min), max: Math.round(max), period: Math.round(num(v.period, 200, 60_000, d.period)) }];
			})
		);
		const r = s?.remote && typeof s.remote === "object" ? s.remote : {};
		/** @param {unknown} o */
		const names = (o) => {
			/** @type {Record<string, string>} */
			const res = {};
			if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (/^\d+$/.test(k)) res[k] = String(v || "").slice(0, 40);
			return res;
		};
		out.remote = {
			on: !!r.on,
			mode: r.mode === "list" ? "list" : "ask",
			trustOwners: !!r.trustOwners,
			always: names(r.always),
			blocked: names(r.blocked),
			lockoutMin: num(r.lockoutMin, 0, 120, 5),
			safeWord: typeof r.safeWord === "string" ? r.safeWord.trim().slice(0, 30) : "",
			announce: ["me", "room"].includes(r.announce) ? r.announce : "off",
			bufferMs: num(r.bufferMs, 50, 1000, 250),
		};
		out.keepHistory = out.keepHistory !== false;
		out.saved = (Array.isArray(s?.saved) ? s.saved : [])
			.filter((/** @type {any} */ x) => x && typeof x.name === "string" && x.name.trim())
			.slice(0, MAX_SAVED)
			.map((/** @type {any} */ x) => ({ name: x.name.trim().slice(0, 40), p: cleanPattern(x.p) }))
			.filter((/** @type {{ name: string, p: VLPattern | null }} */ x) => x.p != null)
			.map((/** @type {{ name: string, p: VLPattern | null }} */ x) => /** @type {VLSaved} */ (x));
		out.presets = (Array.isArray(out.presets) ? out.presets : [])
			.filter((/** @type {any} */ p) => p && typeof p.name === "string" && p.name.trim())
			.slice(0, MAX_PRESETS)
			.map((/** @type {any} */ p) => {
				const clean = sanitizeLinks(p.links);
				const t = sanitizeSettings.tuning(p);
				return { name: p.name.trim().slice(0, 40), links: clean, ...t };
			});
		return out;
	}
	// The tuning part of settings (levels, ramps, curve, cap), cleaned
	/**
	 * @param {any} p
	 * @returns {VLTuning}
	 */
	sanitizeSettings.tuning = (p) => {
		/**
		 * @param {unknown} v
		 * @param {number} lo
		 * @param {number} hi
		 * @param {number} d
		 */
		const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
		return {
			levels: DEFAULTS.levels.map((d, i) => num(p?.levels?.[i], 0, 100, d)),
			rampUp: num(p?.rampUp, 0, 10000, DEFAULTS.rampUp),
			rampDown: num(p?.rampDown, 0, 10000, DEFAULTS.rampDown),
			curve: p?.curve === "linear" ? "linear" : "ease",
			cap: num(p?.cap, 0, 100, 100),
		};
	};
	/** @param {unknown} links */
	function sanitizeLinks(links) {
		/** @type {Record<string, string>} */
		const out = {};
		if (links && typeof links === "object") for (const [k, v] of Object.entries(links)) if (typeof v === "string" && v) out[String(k)] = v;
		return out;
	}

	function loadSettings() {
		try {
			const raw = Player.ExtensionSettings?.[SETTINGS_KEY];
			const saved = /** @type {any} */ (typeof raw === "string" && raw ? JSON.parse(LZString.decompressFromUTF16(raw) || "{}") : {});
			// v0.1.0 linked new toys automatically; drop those links once
			if (!saved.v) saved.links = {};
			settings = sanitizeSettings(saved);
			if (!settings.rememberLinks) settings.links = {};
			// A dev reload (BC Dev Reload) hands over the links of the copy it replaced
			const carry = window.__vibeLinkCarry;
			delete window.__vibeLinkCarry;
			if (carry && carry.member === Player.MemberNumber && Date.now() - carry.at < 60_000) settings.links = { ...carry.links };
		} catch (e) {
			console.warn(TAG, "settings load failed", e);
			settings = sanitizeSettings({});
		}
	}

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let saveTimer;
	function saveSettings() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (!Player.ExtensionSettings || !Player.MemberNumber) return;
			const toSave = { ...settings, links: settings.rememberLinks ? settings.links : {}, v: DEFAULTS.v };
			Player.ExtensionSettings[SETTINGS_KEY] = LZString.compressToUTF16(JSON.stringify(toSave));
			ServerPlayerExtensionSettingsSync(SETTINGS_KEY);
		}, 1000);
	}

	// WCE's own toy sync also connects to Intiface, which only accepts one app at a time
	function wceToySyncOn() {
		try {
			const raw = Player.ExtensionSettings?.FBC;
			if (!raw) return false;
			return !!(/** @type {any} */ (JSON.parse(LZString.decompressFromBase64(raw) || "null"))?.toySync);
		} catch {
			return false;
		}
	}

	// ---------- game helpers ----------

	const loggedIn = () => !!Player?.MemberNumber && Array.isArray(Player.Appearance);

	/** Item slots that can hold a vibrating item, from the game's asset list */
	/** @type {{ name: string, label: string }[] | null} */
	let slotCache = null;
	function vibeSlots() {
		if (slotCache) return slotCache;
		/** @type {Map<string, string>} */
		const groups = new Map();
		try {
			for (const a of typeof Asset !== "undefined" ? Asset : []) {
				if (a?.Group?.Category === "Item" && Array.isArray(a.AllowEffect) && a.AllowEffect.includes("Vibrating"))
					groups.set(a.Group.Name, a.Group.Description || a.Group.Name);
			}
		} catch {
			// not critical: carries on without it
		}
		if (!groups.size)
			for (const g of ["ItemVulva", "ItemButt", "ItemNipples", "ItemBreast", "ItemVulvaPiercings", "ItemNipplesPiercings", "ItemPelvis"]) groups.set(g, g.replace(/^Item/, ""));
		slotCache = [...groups].map(([name, label]) => ({ name, label })).sort((a, b) => a.label.localeCompare(b.label));
		return slotCache;
	}
	/** @param {string} name */
	const slotLabel = (name) => vibeSlots().find((s) => s.name === name)?.label || name;
	// What you wear in a slot: { item, name, vibrates } (item null when empty)
	/** @param {string} slot */
	function wornIn(slot) {
		const item = loggedIn() ? Player.Appearance.find((it) => it?.Asset?.Group?.Name === slot) : null;
		if (!item) return { item: null, name: "", vibrates: false };
		const a = /** @type {Partial<Asset>} */ (item.Asset || {});
		const has = (/** @type {unknown} */ list) => Array.isArray(list) && list.includes("Vibrating");
		const vibrates = a.Archetype === "vibrating" || has(a.AllowEffect) || has(a.Effect) || has(item.Property?.Effect);
		return { item, name: a.Description || a.Name || "Item", vibrates };
	}
	// Changes whenever what you wear in those slots changes (so the dropdowns can refresh)
	const wornSig = () => vibeSlots().map((sl) => { const w = wornIn(sl.name); return w.item ? `${w.name}${w.vibrates ? "~" : ""}` : ""; }).join("|");

	/**
	 * What the game says is in a slot: { item, level } with level -1 (off/none) .. 3
	 * @param {string} slot
	 */
	function slotState(slot) {
		if (!loggedIn() || !slot) return { item: null, level: -1 };
		const item = Player.Appearance.find((it) => it?.Asset?.Group?.Name === slot);
		const i = item?.Property?.Intensity;
		return { item, level: typeof i === "number" && i >= 0 && i <= 3 ? Math.round(i) : -1 };
	}

	// ---------- inspect: what someone wears that vibrates or holds them at the edge (read only) ----------
	const EDGE_FX = ["Edged", "DenialMode", "RuinOrgasms"];
	/** @type {Record<string, string>} */
	const FX_TEXT = { Edged: "🫠 edging", DenialMode: "⛔ denial", RuinOrgasms: "💔 ruins orgasms" };
	const CRAFT_FX = ["Edging", "Arousing", "Dull"]; // crafted properties that change orgasms
	/** @type {Record<string, string>} */
	const MODE_TEXT = {
		Random: "Random: changes strength at random",
		Escalate: "Escalate: builds up step by step",
		Tease: "Tease: comes and goes",
		Deny: "Deny: stops short of letting you finish (edging)",
		Edge: "Edge: keeps you at the edge (edging)",
	};
	/** @param {ItemProperties} p */
	const lockText = (p) => {
		if (!p?.LockedBy) return "";
		const name = String(p.LockedBy).replace(/Padlock$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Padlock";
		const left = Number(p.RemoveTimer) > Date.now() ? ` · opens in ${fmtLeft(Number(p.RemoveTimer) - Date.now())}` : "";
		return `🔒 ${name} lock${left}`;
	};
	/** @param {number} ms */
	const agoText = (ms) => {
		const m = Math.max(0, Math.floor(ms / 60_000));
		return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
	};
	/** @param {number} ms */
	const fmtLeft = (ms) => {
		const m = Math.ceil(ms / 60_000);
		return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
	};
	/**
	 * The items that matter for arousal on a character: vibrating, edging/denial/ruin, or crafted to change orgasms
	 * @param {Character} C
	 */
	function inspectItems(C) {
		/** @type {{ slot: string, group: string, name: string, craftName: string, mode: string, level: number | null, vibrates: boolean, fx: string[], craftFx: string, lock: string, lockBy: number, belt: { orgasms: number, held: number, last: number, worn: number } | null }[]} */
		const out = [];
		for (const item of Array.isArray(C?.Appearance) ? C.Appearance : []) {
			const a = item?.Asset;
			if (!a || a.Group?.Category !== "Item") continue;
			/** @type {ItemProperties & Record<string, any>} */
			const p = item.Property || {};
			/** @type {string[]} */
			const fx = [...new Set([...(Array.isArray(a.Effect) ? a.Effect : []), ...(Array.isArray(p.Effect) ? p.Effect : [])])];
			const has = (/** @type {unknown} */ list) => Array.isArray(list) && list.includes("Vibrating");
			const vibrates = a.Archetype === "vibrating" || has(a.AllowEffect) || has(a.Effect) || has(p.Effect);
			const craft = item.Craft && typeof item.Craft === "object" ? item.Craft : null;
			const craftFx = craft && CRAFT_FX.includes(String(craft.Property)) ? String(craft.Property) : "";
			const edgeFx = fx.filter((e) => EDGE_FX.includes(e));
			// The Modular Chastity Belt and Techno Chastity Cage keep their own record of the wearer's orgasms (only while
			// worn). "Last orgasm" starts at the time it was put on (TimeWorn): only later than that is it a real one.
			const n = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
			const worn = n(p.TimeWorn);
			const real = worn ? n(p.TimeSinceLastOrgasm) > worn + 5000 : n(p.OrgasmCount) > 0;
			const belt = ["ModularChastityBelt", "TechnoChastityCage"].includes(a.Name) ? { orgasms: n(p.OrgasmCount), held: n(p.RuinedOrgasmCount), last: real ? n(p.TimeSinceLastOrgasm) : 0, worn } : null;
			if (!vibrates && !edgeFx.length && !craftFx && !belt) continue;
			const level = typeof p.Intensity === "number" && p.Intensity >= -1 && p.Intensity <= 3 ? Math.round(p.Intensity) : null;
			out.push({
				slot: a.Group?.Description || a.Group?.Name || "",
				group: a.Group?.Name || "",
				name: a.Description || a.Name || "Item",
				craftName: craft?.Name || "",
				mode: typeof p.Mode === "string" ? p.Mode : "",
				level,
				vibrates,
				fx: edgeFx,
				craftFx,
				lock: lockText(p),
				lockBy: Number(p.LockMemberNumber) || 0,
				belt,
			});
		}
		return out.sort((x, y) => x.slot.localeCompare(y.slot));
	}
	// Changes whenever anything shown on the Inspect tab would change (except arousal, updated in place)
	/** @param {Character | null | undefined} C */
	const inspectSig = (C) => (C ? `${C.MemberNumber}|${(C.Effect || []).filter((e) => EDGE_FX.includes(e)).join(",")}|${inspectItems(C).map((i) => `${i.group}:${i.name}:${i.mode}:${i.level}:${i.fx}:${i.craftFx}:${i.lock}:${i.belt ? `${i.belt.orgasms}/${i.belt.held}/${i.belt.last}` : ""}`).join("|")}` : "");

	// ---------- buttplug.io client (JSON protocol, message version 3) ----------

	class ButtplugClient {
		/** @param {(type: string, body?: any) => void} onEvent */
		constructor(onEvent) {
			this.onEvent = onEvent;
			/** @type {WebSocket | null} */
			this.ws = null;
			this.nextId = 1;
			/** @type {Map<number, { resolve: (m: any) => void, reject: (e: Error) => void }>} */
			this.pending = new Map();
			/** @type {ReturnType<typeof setInterval> | undefined} */
			this.pingTimer = undefined;
			this.connected = false;
		}

		/**
		 * @param {string} url
		 * @returns {Promise<any>}
		 */
		connect(url) {
			this.close();
			return new Promise((resolve, reject) => {
				let ws;
				try {
					ws = new WebSocket(url);
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
					return;
				}
				this.ws = ws;
				let settled = false;
				const fail = (/** @type {Error} */ err) => {
					if (!settled) {
						settled = true;
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				};
				ws.onmessage = (ev) => this.handle(ev.data);
				ws.onerror = () => fail(new Error("Could not reach Intiface"));
				ws.onclose = () => {
					fail(new Error("Connection closed"));
					if (this.ws !== ws) return;
					this.teardown();
					this.onEvent("disconnected");
				};
				ws.onopen = async () => {
					try {
						const info = await this.request("RequestServerInfo", { ClientName: "BC Vibe Link", MessageVersion: 3 });
						const maxPing = info?.ServerInfo?.MaxPingTime || 0;
						if (maxPing > 0) this.pingTimer = setInterval(() => this.request("Ping").catch(() => {}), Math.max(200, maxPing / 2));
						this.connected = true;
						settled = true;
						resolve(info?.ServerInfo);
					} catch (e) {
						fail(e instanceof Error ? e : new Error(String(e)));
						ws.close();
					}
				};
			});
		}

		teardown() {
			this.connected = false;
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
			for (const p of this.pending.values()) p.reject(new Error("Disconnected"));
			this.pending.clear();
		}

		close() {
			const ws = this.ws;
			this.ws = null;
			this.teardown();
			if (ws && ws.readyState <= 1) {
				try {
					ws.close();
				} catch {
					// already done or gone: nothing to undo
				}
			}
		}

		/**
		 * @param {string} type
		 * @param {Record<string, any>} [body]
		 * @returns {Promise<any>}
		 */
		request(type, body = {}) {
			return new Promise((resolve, reject) => {
				if (!this.ws || this.ws.readyState !== 1) return reject(new Error("Not connected"));
				const id = this.nextId++;
				if (this.nextId > 4e9) this.nextId = 1;
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${type} timed out`));
				}, 8000);
				this.pending.set(id, {
					resolve: (m) => (clearTimeout(timer), resolve(m)),
					reject: (e) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
				});
				this.ws.send(JSON.stringify([{ [type]: { Id: id, ...body } }]));
			});
		}

		/** @param {string} data */
		handle(data) {
			/** @type {any} */
			let list;
			try {
				list = JSON.parse(data);
			} catch {
				return;
			}
			if (!Array.isArray(list)) return;
			for (const msg of /** @type {any[]} */ (list)) {
				const type = msg ? Object.keys(msg)[0] : "";
				const body = type ? msg[type] : null;
				if (!body || typeof body !== "object") continue;
				if (body.Id && this.pending.has(body.Id)) {
					const p = this.pending.get(body.Id);
					this.pending.delete(body.Id);
					if (!p) continue;
					if (type === "Error") p.reject(new Error(body.ErrorMessage || "Intiface error"));
					else p.resolve(msg);
				} else if (!body.Id) {
					this.onEvent(type, body); // server-initiated: DeviceAdded, DeviceRemoved, ScanningFinished, Error
				}
			}
		}

		/**
		 * @param {number} index
		 * @param {{ Index: number, Scalar: number, ActuatorType: string }[]} scalars
		 */
		vibrate(index, scalars) {
			return this.request("ScalarCmd", { DeviceIndex: index, Scalars: scalars });
		}
		stopAll() {
			if (this.ws?.readyState === 1) {
				// sent directly so it still goes out during page unload
				try {
					this.ws.send(JSON.stringify([{ StopAllDevices: { Id: this.nextId++ } }]));
				} catch {
					// already done or gone: nothing to undo
				}
			}
		}
	}

	// ---------- toys ----------

	/** @type {Map<string, VLToy>} by id ("DeviceIndex:motor"). A device with several vibration motors is one toy per motor. */
	const toys = new Map();
	// Shown on the Toys tab (and driven): toys you haven't hidden; toys without a vibration motor start hidden
	/** @param {VLToy} t */
	const toyShown = (t) => !(settings.toyHidden?.[t.key] ?? !t.vibes.length);
	const shownToys = () => [...toys.values()].filter(toyShown);
	let conn = "idle"; // idle | connecting | connected | failed | busy (another game tab has Intiface)
	let connError = "";
	let scanning = false;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let retryTimer;
	let retryDelay = 3000;
	const client = new ButtplugClient(onServerEvent);

	// A virtual toy: a pretend one-motor toy that needs no Intiface, so you can see what Vibe Link would do (its chart,
	// percentage, presets, Play on my toys) before getting a real toy going. Nothing is sent anywhere, and only you can
	// drive it: controllers aren't shown it. It's a switch for this browser (⚙ → Connection), off by default.
	const VIRTUAL = { DeviceIndex: -1, DeviceName: "Virtual toy", DeviceDisplayName: "Virtual toy", DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: "Vibrate" }] } };
	const virtualOn = () => !!local.virtual;
	function syncVirtual() {
		const have = [...toys.values()].filter((t) => t.virtual);
		if (virtualOn() && !have.length) for (const t of makeToys(VIRTUAL)) toys.set(t.id, Object.assign(t, { virtual: true }));
		else if (!virtualOn()) for (const t of have) toys.delete(t.id);
	}
	/** @param {boolean} on */
	function setVirtual(on) {
		local.virtual = !!on;
		saveLocal();
		syncVirtual();
		ui.renderSoon();
	}
	// Real toys come and go with Intiface; the virtual toy stays
	function resetToys() {
		for (const t of [...toys.values()]) if (!t.virtual) toys.delete(t.id);
		syncVirtual();
	}

	// One toy per vibration motor (a toy with none is still listed, hidden by default). Motor 1 keeps the device's own
	// key, so links made before motors were split still work; motor 2 and up are "<key> motor N".
	/**
	 * @param {any} d a device from Intiface
	 * @returns {VLToy[]}
	 */
	function makeToys(d) {
		const scalar = Array.isArray(d.DeviceMessages?.ScalarCmd) ? d.DeviceMessages.ScalarCmd : [];
		const vibes = scalar.map((/** @type {any} */ f, /** @type {number} */ i) => ({ Index: i, StepCount: Math.max(1, f.StepCount || 20), type: f.ActuatorType })).filter((/** @type {VLMotor} */ f) => f.type === "Vibrate");
		const name = String(d.DeviceName || "Toy");
		const display = String(d.DeviceDisplayName || name);
		// Key for slot links: the device name, numbered if several identical toys are connected
		let key = name;
		for (let n = 2; [...toys.values()].some((t) => t.devKey === key); n++) key = `${name} #${n}`;
		const motors = vibes.length ? vibes : [null];
		return motors.map((/** @type {VLMotor | null} */ v, /** @type {number} */ i) =>
			makeToy(d, {
				id: `${d.DeviceIndex}:${i}`,
				key: i ? `${key} motor ${i + 1}` : key,
				devKey: key,
				display: motors.length > 1 ? `${display} · ${i + 1}` : display,
				vibes: v ? [v] : [],
				motor: motors.length > 1 ? { n: i + 1, of: motors.length } : null,
			})
		);
	}
	/**
	 * @param {any} d a device from Intiface
	 * @param {{ id: string, key: string, devKey: string, display: string, vibes: VLMotor[], motor: { n: number, of: number } | null }} m
	 * @returns {VLToy}
	 */
	function makeToy(d, m) {
		const sensors = Array.isArray(d.DeviceMessages?.SensorReadCmd) ? d.DeviceMessages.SensorReadCmd : [];
		const batteryIndex = sensors.findIndex((/** @type {any} */ s) => s.SensorType === "Battery");
		const name = String(d.DeviceName || "Toy");
		return {
			index: d.DeviceIndex,
			id: m.id,
			name,
			display: m.display,
			key: m.key,
			devKey: m.devKey,
			motor: m.motor,
			vibes: m.vibes,
			batteryIndex,
			batteryRange: sensors[batteryIndex]?.SensorRange?.[0] || [0, 100],
			battery: null,
			// ramp state, all 0..1
			value: 0,
			from: 0,
			target: 0,
			t0: 0,
			dur: 0,
			sent: null,
			sentAt: 0,
			sending: false,
			testUntil: 0,
		};
	}

	/** @param {any} d a device from Intiface */
	function addDevice(d) {
		if (typeof d?.DeviceIndex !== "number" || [...toys.values()].some((t) => t.index === d.DeviceIndex)) return;
		const list = makeToys(d);
		for (const toy of list) {
			toys.set(toy.id, toy);
			readBattery(toy).catch((err) => console.warn(TAG, err));
		}
		if (scanning) stopScan().catch((err) => console.warn(TAG, err));
		const name = String(d.DeviceDisplayName || d.DeviceName || "Toy");
		const shown = list.filter(toyShown);
		const linked = shown.filter((t) => settings.links[t.key]);
		if (!shown.length) ui.toast(`${name} connected. ${list[0].vibes.length ? "It's hidden" : "It has no vibration motor Vibe Link can drive, so it's hidden"} (⚙ → Toys).`);
		else if (linked.length) ui.toast(`${name} connected, ${linked.map((t) => `${list.length > 1 ? `motor ${t.motor?.n} ` : ""}follows ${slotLabel(settings.links[t.key])}`).join(", ")}`);
		else {
			// New toys follow nothing until you pick a slot or load a preset
			ui.open();
			ui.toast(`${name} connected${list.length > 1 ? ` (${list.length} motors, each its own toy)` : ""}. It follows nothing until you pick a slot or load a preset.`);
		}
		ui.renderSoon();
	}

	// ---------- presets ----------

	/** @param {string} name */
	function findPreset(name) {
		const n = String(name || "").trim().toLowerCase();
		return settings.presets.find((p) => p.name.toLowerCase() === n) || (n && settings.presets.find((p) => p.name.toLowerCase().startsWith(n)));
	}

	/** @param {string} name */
	function savePreset(name) {
		name = String(name || "").trim().slice(0, 40);
		if (!name) return null;
		const preset = { name, links: { ...settings.links }, ...sanitizeSettings.tuning(settings) };
		const i = settings.presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
		if (i >= 0) settings.presets[i] = preset;
		else if (settings.presets.length >= MAX_PRESETS) return null;
		else settings.presets.push(preset);
		saveSettings();
		ui.renderSoon();
		return preset;
	}

	/**
	 * Applies a preset; links for toys that aren't connected are kept for when they connect
	 */
	/** @param {VLPreset} preset */
	function loadPreset(preset) {
		settings.links = { ...preset.links };
		Object.assign(settings, sanitizeSettings.tuning(preset));
		saveSettings();
		ui.render();
		const linked = [...toys.values()].filter((t) => settings.links[t.key]).map((t) => `${t.display} → ${slotLabel(settings.links[t.key])}`);
		return linked.length ? linked.join(", ") : "no connected toy is linked by it";
	}

	/** @param {VLPreset} preset */
	function deletePreset(preset) {
		settings.presets = settings.presets.filter((p) => p !== preset);
		saveSettings();
		ui.renderSoon();
	}

	/**
	 * @param {string} type
	 * @param {any} [body]
	 */
	function onServerEvent(type, body) {
		if (type === "DeviceAdded") addDevice(body);
		else if (type === "DeviceRemoved") {
			const gone = [...toys.values()].filter((t) => t.index === body.DeviceIndex);
			for (const t of gone) toys.delete(t.id);
			if (gone.length) ui.toast(`${String(gone[0].display).replace(/ · \d+$/, "")} disconnected`);
			ui.renderSoon();
		} else if (type === "ScanningFinished") {
			scanning = false;
			ui.renderSoon();
		} else if (type === "disconnected") {
			resetToys();
			clearTimeout(scanTimer);
			scanning = false;
			conn = "failed";
			connError = "Intiface closed the connection";
			ui.toast("Disconnected from Intiface");
			scheduleRetry();
			ui.renderSoon();
		}
	}

	// ---------- one game tab at a time ----------
	// Intiface takes one client, and each game tab (one per account) runs its own Vibe Link. A browser lock
	// decides which tab talks to Intiface; the others wait and take over when it closes, logs out or lets go.
	const LOCK = "VibeLink.intiface";
	const chan = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("VibeLink") : null;
	/** @type {(() => void) | null} */
	let releaseLock = null; // set while this tab holds the lock
	/** @type {AbortController | null} */
	let lockWait = null; // AbortController of a queued wait for the lock
	let ownerName = ""; // whose tab has Intiface, when it isn't this one

	/**
	 * @param {boolean} wait
	 * @returns {Promise<boolean>}
	 */
	function acquireLock(wait) {
		if (releaseLock || !navigator.locks) return Promise.resolve(true);
		return new Promise((resolve) => {
			const opts = wait ? { signal: (lockWait = new AbortController()).signal } : { ifAvailable: true };
			navigator.locks
				.request(LOCK, opts, (lock) => {
					if (!lock) return resolve(false);
					lockWait = null;
					return new Promise((/** @type {(v?: unknown) => void} */ release) => {
						releaseLock = () => ((releaseLock = null), release());
						chan?.postMessage({ type: "owner", name: myName() });
						resolve(true);
					});
				})
				.catch(() => resolve(false)); // aborted
		});
	}
	function dropLock() {
		lockWait?.abort();
		lockWait = null;
		releaseLock?.();
	}
	const myName = () => (loggedIn() ? (typeof CharacterNickname === "function" ? CharacterNickname(Player) : Player.Name) || `#${Player.MemberNumber}` : "");

	// Wait in line; connect as soon as the tab that has Intiface lets go
	function queueForIntiface() {
		if (lockWait || releaseLock) return;
		acquireLock(true).then((got) => (got && loggedIn() ? connect() : undefined)).catch((err) => console.warn(TAG, err));
	}

	chan?.addEventListener("message", (e) => {
		const m = e.data || {};
		if (m.type === "owner") {
			ownerName = m.name || "";
			ui.renderSoon();
		} else if (m.type === "who" && releaseLock) chan.postMessage({ type: "owner", name: myName() });
		else if (m.type === "release" && releaseLock) {
			// Another tab pressed "Use here": hand over, then wait in line to get it back later
			say(`${m.name || "Another tab"} took over Intiface.`);
			disconnect();
			if (settings.autoConnect) {
				conn = "busy";
				ownerName = m.name || "";
				setTimeout(queueForIntiface, 500);
				ui.renderSoon();
			}
		}
	});

	// "Use here": ask the tab that has Intiface to let go, and take it
	function takeOver() {
		chan?.postMessage({ type: "release", name: myName() });
		if (!lockWait) queueForIntiface();
	}

	async function connect() {
		clearTimeout(retryTimer);
		if (conn === "connecting") return;
		if (!(await acquireLock(false))) {
			conn = "busy";
			connError = "";
			chan?.postMessage({ type: "who" });
			if (settings.autoConnect) queueForIntiface();
			return ui.renderSoon();
		}
		conn = "connecting";
		connError = "";
		ui.renderSoon();
		try {
			await client.connect(settings.url);
			conn = "connected";
			retryDelay = 3000;
			resetToys();
			const list = await client.request("RequestDeviceList");
			// Only the toys Intiface already has; no Bluetooth scan unless you ask for one (Look for toys)
			for (const d of list?.DeviceList?.Devices || []) addDevice(d);
		} catch (e) {
			client.close();
			conn = "failed";
			connError = e instanceof Error ? e.message : String(e);
			scheduleRetry();
		}
		ui.renderSoon();
	}

	function disconnect() {
		clearTimeout(retryTimer);
		clearTimeout(scanTimer);
		if (scanning) client.request("StopScanning").catch(() => {});
		client.stopAll();
		client.close();
		dropLock();
		resetToys();
		conn = "idle";
		scanning = false;
		ui.renderSoon();
	}

	function scheduleRetry() {
		clearTimeout(retryTimer);
		if (!settings.autoConnect || !loggedIn()) return;
		retryTimer = setTimeout(connect, retryDelay);
		retryDelay = Math.min(30000, retryDelay * 1.5);
	}

	// Bluetooth scans only run when you ask, and stop as soon as a toy turns up or after SCAN_MS
	const SCAN_MS = 30_000;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let scanTimer;
	async function startScan() {
		clearTimeout(scanTimer);
		try {
			await client.request("StartScanning");
			scanning = true;
			scanTimer = setTimeout(stopScan, SCAN_MS);
		} catch {
			// not critical: carries on without it
		}
		ui.renderSoon();
	}
	async function stopScan() {
		clearTimeout(scanTimer);
		if (scanning && client.connected) {
			try {
				await client.request("StopScanning");
			} catch {
				// already done or gone: nothing to undo
			}
		}
		scanning = false;
		ui.renderSoon();
	}

	/** @param {VLToy} toy */
	async function readBattery(toy) {
		if (toy.batteryIndex < 0 || !client.connected) return;
		try {
			const r = await client.request("SensorReadCmd", { DeviceIndex: toy.index, SensorIndex: toy.batteryIndex, SensorType: "Battery" });
			const v = r?.SensorReading?.Data?.[0];
			const [lo, hi] = toy.batteryRange;
			if (typeof v === "number") toy.battery = Math.round(((v - lo) / (hi - lo || 100)) * 100);
			ui.renderSoon();
		} catch {
			// not critical: carries on without it
		}
	}

	// ---------- sync engine ----------

	let tabHidden = document.hidden;
	const ease = (/** @type {number} */ x) => x * x * (3 - 2 * x);

	/**
	 * Where a toy should be heading right now, 0..1
	 * @param {VLToy} toy
	 * @param {number} now
	 */
	/**
	 * @param {VLToy} toy
	 * @param {number} now
	 */
	function desiredStrength(toy, now) {
		toy.followPat = false;
		if (!toyShown(toy)) return 0;
		if (local.paused || !loggedIn() || (settings.stopWhenHidden && tabHidden)) return 0;
		const cap = settings.cap / 100;
		if (toy.testUntil > now) return 0.3 * cap;
		// A controller you allowed is driving this toy: their 0-100% is scaled by your max strength, like the game levels
		const lane = laneFor(toy);
		const slot = settings.links[toy.key];
		if (lane && laneDrives(toy, lane)) return remoteRaw(lane, now) * cap;
		if (!slot) return 0;
		const { item, level } = slotState(slot);
		// The game vibrator is in a mode (Random, Escalate, ...): play that mode's pattern, from when the mode started
		const mode = gameMode(item);
		const mp = mode && modePattern(mode);
		if (mp) {
			let ck = modeClock.get(slot);
			if (!ck || ck.mode !== mode) modeClock.set(slot, (ck = { mode, t0: now, rnd: seeded((Math.random() * 2 ** 31) | 0) }));
			toy.followPat = true;
			return (patternAt(mp, now - ck.t0, ck.rnd) / 100) * cap;
		}
		return (settings.levels[level + 1] / 100) * cap;
	}

	// Where the current glide has got to by `now`
	/**
	 * @param {VLToy} toy
	 * @param {number} now
	 */
	function glideValue(toy, now) {
		if (toy.dur > 0 && now - toy.t0 < toy.dur) {
			let x = (now - toy.t0) / toy.dur;
			if (settings.curve === "ease" && !toy.linear) x = ease(x);
			return toy.from + ((toy.target ?? toy.from) - toy.from) * x;
		}
		return toy.target ?? toy.value;
	}

	/**
	 * @param {VLToy} toy
	 * @param {number} now
	 */
	function stepToy(toy, now) {
		const target = desiredStrength(toy, now);
		if (target !== toy.target) {
			// Start the new glide from where the toy really is now (not where it was at the last tick), so a
			// stream of new targets keeps it moving instead of restarting from a stale value
			toy.from = toy.target == null ? toy.value : glideValue(toy, now);
			toy.target = target;
			toy.t0 = now;
			// Ramp up or down over your ramp times (going to 0 included); only the emergency stop (local.paused) is instant
			const full = target > toy.from ? settings.rampUp : settings.rampDown;
			// Live remote control glides in a straight line over the time between the controller's last two values,
			// so the toy moves at the speed of their hand instead of in steps
			// Levels set by a controller ramp like game levels; patterns play exactly
			const lane = laneFor(toy);
			const live = lane && laneDrives(toy, lane) && lane.lvl == null;
			toy.linear = !!live;
			toy.dur = local.paused || toy.followPat || (live && (lane.buf || lane.pat)) ? 0 : live ? Math.min(REMOTE_GLIDE_MAX, Math.max(REMOTE_GLIDE_MIN, lane.gap || REMOTE_GLIDE_MAX)) : full;
		}
		toy.value = glideValue(toy, now);

		if (toy.virtual || !client.connected || !toy.vibes.length || toy.sending) return;
		const steps = toy.vibes[0].StepCount;
		const q = Math.round(toy.value * steps) / steps;
		if (q === toy.sent) return;
		// Stop always goes out at once. During live control the toy may get up to 20 commands a second; a new one only
		// goes out once the toy has taken the last (toy.sending), so commands never pile up
		const gap = laneFor(toy) ? MIN_SEND_MS_LIVE : MIN_SEND_MS;
		if (now - toy.sentAt < gap && q !== 0) return;
		toy.sending = true;
		toy.sentAt = now;
		client
			.vibrate(toy.index, toy.vibes.map((/** @type {VLMotor} */ v) => ({ Index: v.Index, Scalar: q, ActuatorType: "Vibrate" })))
			.then(() => (toy.sent = q))
			.catch(() => (toy.sent = null))
			.finally(() => (toy.sending = false));
	}

	// Theme colors for canvas drawing (the dock's --bcd-* variables, re-read at most once a second)
	/** @type {{ at: number, cs: CSSStyleDeclaration } | null} */
	let themeCache = null;
	let themeGen = 0;
	const onTheme = () => ((themeCache = null), themeGen++, ui.renderSoon());
	addEventListener("bcdock:theme", onTheme);
	/**
	 * @param {string} name a theme variable without --bcd-
	 * @param {string} fallback
	 */
	function tc(name, fallback) {
		const now = Date.now();
		if (!themeCache || now - themeCache.at > 1000) themeCache = { at: now, cs: getComputedStyle(document.documentElement) };
		return themeCache.cs.getPropertyValue(`--bcd-${name}`).trim() || fallback;
	}
	// "#rrggbb" + alpha -> rgba()
	/**
	 * @param {string} hex
	 * @param {number} a
	 */
	function rgba(hex, a) {
		const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
		return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
	}

	// Each toy's strength over the last HIST_MS, one sample every HIST_STEP ms, for the chart on its card
	const HIST_MS = 15_000;
	const HIST_STEP = 100;
	/**
	 * @param {VLToy} toy
	 * @param {number} now
	 */
	function recordHistory(toy, now) {
		const hst = (toy.hist = toy.hist || []);
		if (hst.length && now - hst[hst.length - 1][0] < HIST_STEP) return;
		hst.push([now, toy.value]);
		while (hst.length && hst[0][0] < now - HIST_MS - HIST_STEP) hst.shift();
		toy.histN = (toy.histN || 0) + 1;
	}

	function tick() {
		const now = Date.now();
		rcTrackLevel(now);
		for (const toy of toys.values()) {
			stepToy(toy, now);
			recordHistory(toy, now);
		}
		ui.tick();
	}

	function stopNow() {
		local.paused = true;
		saveLocal();
		for (const t of toys.values()) {
			t.value = t.from = t.target = 0;
			t.dur = 0;
			t.testUntil = 0;
		}
		client.stopAll();
		rcOnStop();
		ui.toast("Stopped. Toys stay off until you press Resume.");
		ui.renderSoon();
	}
	function resume() {
		local.paused = false;
		saveLocal();
		ui.renderSoon();
	}



	// ---------- patterns ----------
	// A pattern is sent once as a short description ({ type, min, max, period, dur, seed }) and the wearer's Vibe Link
	// draws the curve itself, so it's perfectly smooth and doesn't depend on the network. The same functions draw the
	// controller's preview, and random patterns use the shared seed so both sides see the same shape.
	// Each function gets the phase within one period (0..1), the cycle number and a seeded random source, and returns
	// 0..1, which is then mapped onto min..max.
	/**
	 * @param {number} seed
	 * @returns {(n: number) => number}
	 */
	function seeded(seed) {
		// mulberry32
		return (/** @type {number} */ n) => {
			let t = (seed + Math.imul(n | 0, 0x9e3779b1)) >>> 0;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const smooth01 = (/** @type {number} */ x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
	/** @type {Record<VLWaveType, { label: string, fn: (f: number, cyc: number, rnd: (n: number) => number) => number }>} */
	const PATTERNS = {
		wave: { label: "Wave", fn: (f) => 0.5 - 0.5 * Math.cos(2 * Math.PI * f) },
		pulse: { label: "Pulse", fn: (f) => (f < 0.5 ? 1 : 0) },
		heartbeat: {
			label: "Heartbeat",
			fn: (f) => {
				const beat = (/** @type {number} */ c, /** @type {number} */ w) => Math.exp(-(((f - c) / w) ** 2));
				return Math.min(1, beat(0.08, 0.045) + 0.75 * beat(0.26, 0.045));
			},
		},
		climb: { label: "Climb", fn: (f) => f }, // sawtooth: build up, drop
		stairs: { label: "Stairs", fn: (f) => Math.floor(f * 4) / 3 },
		tease: { label: "Tease", fn: (f) => f * (0.5 - 0.5 * Math.cos(2 * Math.PI * f * 4)) }, // growing waves, then drop
		random: {
			label: "Random",
			// a new level every quarter period, glided to smoothly
			fn: (f, cyc, rnd) => {
				const i = cyc * 4 + Math.floor(f * 4);
				const x = f * 4 - Math.floor(f * 4);
				return rnd(i) + (rnd(i + 1) - rnd(i)) * smooth01(x);
			},
		},
		quake: {
			label: "Quake",
			// fast jolts: a new random level 12 times a period
			fn: (f, cyc, rnd) => rnd(cyc * 12 + Math.floor(f * 12)),
		},
	};
	const PATTERN_TYPES = /** @type {VLWaveType[]} */ (Object.keys(PATTERNS));

	// Two more kinds travel the same way (0.11.0 on both sides):
	// - a program: { type: "prog", steps: [pattern with a duration, ...], loop }, played one step after another
	// - a recording: { type: "rec", pts: [[ms, 0-100], ...] }, a live slider session replayed as it was drawn
	const PROG_MAX_STEPS = 12;
	const REC_MAX_PTS = 600; // a stored recording keeps at most this many points (resampled evenly)
	const REC_NET_PTS = 240; // ... and sends at most this many to someone else
	const REC_MAX_MS = 10 * 60_000;
	const PROG_VER = "0.11.0"; // the first version that plays programs and recordings
	/**
	 * @param {unknown} v
	 * @param {string} want
	 */
	const verAtLeast = (v, want) => {
		const a = (typeof v === "string" ? v : "").split(".").map(Number);
		const b = want.split(".").map(Number);
		for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
		return true;
	};
	// Evenly spaced points along a recording, at most `max`
	/**
	 * @param {[number, number][]} pts
	 * @param {number} max
	 * @returns {[number, number][]}
	 */
	function resample(pts, max) {
		if (pts.length <= max) return pts;
		const dur = pts[pts.length - 1][0];
		/** @type {[number, number][]} */
		const out = [];
		let j = 0;
		for (let i = 0; i < max; i++) {
			const t = Math.round((dur * i) / (max - 1));
			while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
			const [t0, v0] = pts[j];
			const [t1, v1] = pts[j + 1];
			out.push([t, Math.round(v0 + ((v1 - v0) * (t - t0)) / Math.max(1, t1 - t0))]);
		}
		return out;
	}

	// Cleans a pattern from the network (or the UI); null if unusable
	/**
	 * @param {any} x
	 * @param {boolean} [inner] a program's step (no programs inside)
	 * @returns {VLPattern | null}
	 */
	function cleanPattern(x, inner = false) {
		if (!x || typeof x !== "object") return null;
		/**
		 * @param {unknown} v
		 * @param {number} lo
		 * @param {number} hi
		 * @param {number} d
		 */
		const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
		if (x.type === "prog" && !inner) {
			const steps = (Array.isArray(x.steps) ? x.steps : [])
				.slice(0, PROG_MAX_STEPS)
				.map((/** @type {any} */ st) => cleanPattern({ ...st, dur: n(st?.dur, 1000, 3_600_000, 60_000) }, true))
				.filter((/** @type {VLPattern | null} */ st) => st != null && st.type !== "rec" && st.type !== "prog")
				.map((/** @type {VLPattern | null} */ st) => /** @type {VLWave} */ (st));
			if (!steps.length) return null;
			const total = steps.reduce((/** @type {number} */ a, /** @type {VLWave} */ st) => a + st.dur, 0);
			const loop = !!x.loop;
			return { type: "prog", steps, loop, min: Math.min(...steps.map((/** @type {VLWave} */ st) => st.min)), max: Math.max(...steps.map((/** @type {VLWave} */ st) => st.max)), period: total, dur: loop ? n(x.dur, 0, 3_600_000, 0) : total, seed: 1 };
		}
		if (x.type === "rec") {
			/** @type {[number, number][]} */
			const pts = [];
			for (const q of Array.isArray(x.pts) ? x.pts.slice(0, 20_000) : []) {
				if (!Array.isArray(q)) continue;
				const t = Math.round(Number(q[0]));
				const v = Math.round(Number(q[1]));
				if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0 || t > REC_MAX_MS) continue;
				if (pts.length && t <= pts[pts.length - 1][0]) continue; // in time order only
				pts.push([t, Math.min(100, Math.max(0, v))]);
			}
			if (pts.length < 2) return null;
			const t0 = pts[0][0];
			const even = resample(
				pts.map(([t, v]) => /** @type {[number, number]} */ ([t - t0, v])),
				REC_MAX_PTS
			);
			const dur = even[even.length - 1][0];
			if (dur < 500) return null;
			const vals = even.map((p) => p[1]);
			return { type: "rec", pts: even, min: Math.min(...vals), max: Math.max(...vals), period: dur, dur, seed: 1 };
		}
		if (typeof x.type !== "string" || !(x.type in PATTERNS)) return null;
		let min = n(x.min, 0, 100, 0);
		let max = n(x.max, 0, 100, 100);
		if (min > max) [min, max] = [max, min];
		return { type: /** @type {VLWaveType} */ (x.type), min, max, period: n(x.period, 200, 60_000, 2000), dur: n(x.dur, 0, 3_600_000, 0), seed: n(x.seed, 0, 2 ** 31 - 1, 1) };
	}

	// The pattern a game vibrator mode plays on your toy (null: follow the game's steps)
	/** @param {string} mode */
	function modePattern(mode) {
		const v = settings.modes?.[mode];
		if (v === "game" || settings.modesFollowGame) return null;
		return cleanPattern({ ...MODE_DEFAULTS[mode], ...(v || {}), dur: 0, seed: 1 }) || cleanPattern({ ...MODE_DEFAULTS[mode], dur: 0, seed: 1 });
	}
	/** @param {Item | null | undefined} item */
	const gameMode = (item) => (typeof item?.Property?.Mode === "string" && VIBE_MODES.includes(item.Property.Mode) ? item.Property.Mode : null);
	/** @type {Map<string, { mode: string, t0: number, rnd: (n: number) => number }>} */
	const modeClock = new Map(); // slot -> { mode, t0, rnd }: when the game switched that slot into a mode

	// 0..100 at t ms into the pattern
	/**
	 * @param {VLPattern} pat
	 * @param {number} t
	 * @param {(n: number) => number} [rnd]
	 * @returns {number} 0..100
	 */
	function patternAt(pat, t, rnd = seeded(pat.seed)) {
		if (pat.type === "prog") {
			// a looping program starts over; one that doesn't stays on its last moment until its time runs out
			let x = pat.loop ? t % pat.period : Math.min(t, pat.period - 1);
			for (const s of pat.steps) {
				if (x < s.dur) return patternAt(s, x);
				x -= s.dur;
			}
			const last = pat.steps[pat.steps.length - 1];
			return patternAt(last, last.dur - 1);
		}
		if (pat.type === "rec") {
			const p = pat.pts;
			const x = Math.min(Math.max(0, t), pat.dur);
			// binary search for the points either side of x
			let lo = 0;
			let hi = p.length - 1;
			while (hi - lo > 1) {
				const mid = (lo + hi) >> 1;
				if (p[mid][0] <= x) lo = mid;
				else hi = mid;
			}
			const [t0, v0] = p[lo];
			const [t1, v1] = p[hi];
			return x <= t0 ? v0 : x >= t1 ? v1 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
		}
		const cyc = Math.floor(t / pat.period);
		const f = (t % pat.period) / pat.period;
		const v = Math.min(1, Math.max(0, PATTERNS[pat.type].fn(f, cyc, rnd)));
		return pat.min + (pat.max - pat.min) * v;
	}
	/** @param {VLPattern} pat */
	const patLabel = (pat) => (pat.type === "prog" ? "Program" : pat.type === "rec" ? "Recording" : PATTERNS[pat.type]?.label || "Pattern");
	/** @param {VLWave} pat */
	const stepText = (pat) => `${PATTERNS[pat.type].label} ${pat.min}-${pat.max}% · ${(pat.period / 1000).toFixed(pat.period < 1000 ? 1 : 0)} s`;
	/** @param {VLPattern} pat */
	const patternText = (pat) =>
		pat.type === "prog"
			? `Program · ${pat.steps.length} step${pat.steps.length > 1 ? "s" : ""} · ${fmtDur(pat.period)}${pat.loop ? " · loops" : ""}`
			: pat.type === "rec"
				? `Recording · ${fmtDur(pat.dur)} · ${pat.min}-${pat.max}%`
				: stepText(pat);
	// What goes over the network: a recording sent to someone else is thinned to REC_NET_PTS points
	/**
	 * @param {VLPattern} pat
	 * @returns {VLPattern}
	 */
	const netPattern = (pat) => (pat.type === "rec" && pat.pts.length > REC_NET_PTS ? { ...pat, pts: resample(pat.pts, REC_NET_PTS) } : pat);
	// Status messages go out every second, so programs and recordings are named there rather than sent whole
	/** @param {VLPattern} pat */
	const isBig = (pat) => pat.type === "prog" || pat.type === "rec";
	/** @param {number} m */
	const peerPlaysBig = (m) => isSelf(m) || verAtLeast(peers.get(m)?.ver, PROG_VER);

	// ---------- saved patterns ----------
	// Patterns, programs and recordings you keep, by name. Saved with your account settings (like presets).
	/** @param {string} name */
	const findSaved = (name) => settings.saved.find((x) => x.name.toLowerCase() === String(name || "").trim().toLowerCase());
	/**
	 * @param {string} name
	 * @param {VLPattern} pat
	 */
	function savePatternAs(name, pat) {
		name = String(name || "").trim().slice(0, 40);
		const p = cleanPattern(pat);
		if (!name || !p) return "Nothing to save";
		const list = settings.saved.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
		const existed = list.length !== settings.saved.length;
		if (list.length >= MAX_SAVED) return `You can keep up to ${MAX_SAVED}; delete one first`;
		const next = [...list, { name, p: { ...p, seed: 1 } }];
		if (JSON.stringify(next).length > SAVED_MAX_CHARS) return "That's too much to keep with your account: delete a long recording first";
		settings.saved = next.sort((a, b) => a.name.localeCompare(b.name));
		saveSettings();
		ui.renderSoon();
		return existed ? `Updated "${name}"` : `Saved "${name}"`;
	}
	/** @param {string} name */
	function deleteSaved(name) {
		settings.saved = settings.saved.filter((x) => x.name !== name);
		saveSettings();
		ui.renderSoon();
	}
	// Pattern codes: "VL1:" + the pattern and its name, compressed like the game's outfit codes, for sharing as text.
	// Reading one goes through the same checks as a pattern arriving from another player (data only, same limits).
	const CODE_PREFIX = "VL1:";
	/**
	 * @param {string} name
	 * @param {VLPattern} pat
	 */
	function patternCode(name, pat) {
		const json = JSON.stringify({ n: String(name || "").slice(0, 40), p: pat });
		const body = typeof LZString?.compressToBase64 === "function" ? LZString.compressToBase64(json) : btoa(unescape(encodeURIComponent(json)));
		return CODE_PREFIX + body;
	}
	/**
	 * @param {string} text
	 * @returns {VLSaved | null}
	 */
	function readPatternCode(text) {
		const t = String(text || "").replace(/\s+/g, "");
		const at = t.indexOf(CODE_PREFIX);
		if (at < 0) return null;
		const body = t.slice(at + CODE_PREFIX.length);
		let json = null;
		try {
			json = typeof LZString?.decompressFromBase64 === "function" ? LZString.decompressFromBase64(body) : null;
		} catch {
			// missing or unreadable: the defaults stay
		}
		if (!json || json[0] !== "{") {
			try {
				json = decodeURIComponent(escape(atob(body)));
			} catch {
				return null;
			}
		}
		try {
			const o = /** @type {any} */ (JSON.parse(json));
			const pat = cleanPattern(o?.p);
			return pat ? { name: String(o.n || "").trim().slice(0, 40) || patLabel(pat), p: pat } : null;
		} catch {
			return null;
		}
	}
	// "Name", or "Name (2)", "Name (3)", ... if that's taken
	/** @param {string} name */
	function freeName(name) {
		if (!findSaved(name)) return name;
		const base = name.replace(/ \(\d+\)$/, "").slice(0, 34);
		for (let i = 2; ; i++) if (!findSaved(`${base} (${i})`)) return `${base} (${i})`;
	}
	// Adds several { name, p }; replace: same names are overwritten, otherwise they're kept as "Name (2)"
	/**
	 * @param {VLSaved[]} list
	 * @param {boolean} replace
	 */
	function importSaved(list, replace) {
		let added = 0;
		let failed = "";
		for (const x of list) {
			const name = replace ? x.name : freeName(x.name);
			const r = savePatternAs(name, x.p);
			if (/^(Saved|Updated)/.test(r)) added++;
			else failed = r;
		}
		return `${added} of ${list.length} imported${failed ? `. ${failed}` : ""}`;
	}
	// The file Export all writes, and Import file reads (also accepts a text file of pattern codes, one per line)
	const FILE_FORMAT = "VibeLinkPatterns";
	function exportFileText() {
		return JSON.stringify({ format: FILE_FORMAT, v: 1, exported: new Date().toISOString(), saved: settings.saved }, null, 1);
	}
	/**
	 * @param {string} text
	 * @returns {VLSaved[] | null}
	 */
	function readImportFile(text) {
		try {
			const o = /** @type {any} */ (JSON.parse(text));
			/** @type {any[] | null} */
			const arr = Array.isArray(o) ? o : o?.format === FILE_FORMAT && Array.isArray(o.saved) ? o.saved : null;
			if (arr) {
				/** @type {VLSaved[]} */
				const out = [];
				for (const x of arr.slice(0, 200)) {
					const p = cleanPattern(x?.p);
					if (p) out.push({ name: String(x?.name || "").trim().slice(0, 40) || patLabel(p), p });
				}
				return out;
			}
		} catch {
			// missing or unreadable: the defaults stay
		}
		return String(text || "")
			.split(/\r?\n/)
			.slice(0, 200)
			.map(readPatternCode)
			.filter(Boolean);
	}

	// Asks for a name (suggesting one) and saves; returns nothing, says how it went
	/**
	 * @param {VLPattern} pat
	 * @param {string} [suggest]
	 */
	function promptSave(pat, suggest) {
		const name = window.prompt("Save as:", suggest || patLabel(pat));
		if (name == null) return;
		ui.toast(savePatternAs(name, pat));
	}

	// ---------- history ----------
	// What happened during remote control, both ways: who took control, what they played (kept whole, so it can be
	// played again or saved), live slider sessions as recordings, levels, modes, and when it ended. Kept in this
	// browser only (localStorage, per account), newest last, HIST_MAX entries; only the newest HIST_KEEP_PATS keep
	// their recordings.
	const HIST_MAX = 300;
	const HIST_KEEP_PATS = 40;
	/** @type {{ key: string, list: VLHistEntry[] } | null} */
	let histCache = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let histTimer;
	const histKey = () => `VibeLink.history.${Player?.MemberNumber || 0}`;
	function history() {
		if (histCache?.key === histKey()) return histCache.list;
		/** @type {VLHistEntry[]} */
		let list = [];
		try {
			const raw = /** @type {any} */ (JSON.parse(localStorage.getItem(histKey()) || "[]"));
			if (Array.isArray(raw))
				list = raw
					.filter((/** @type {any} */ e) => e && Number.isFinite(e.at) && typeof e.text === "string")
					.slice(-HIST_MAX)
					.map((/** @type {any} */ e) => /** @type {VLHistEntry} */ ({ at: e.at, dir: e.dir === "out" ? "out" : "in", who: Number(e.who) || 0, name: String(e.name || "").slice(0, 40), ev: String(e.ev || "").slice(0, 10), text: e.text.slice(0, 200), ...(e.p && cleanPattern(e.p) ? { p: cleanPattern(e.p) } : {}) }));
		} catch {
			// missing or unreadable: the defaults stay
		}
		histCache = { key: histKey(), list };
		return list;
	}
	function saveHistory() {
		clearTimeout(histTimer);
		histTimer = setTimeout(() => {
			try {
				localStorage.setItem(histKey(), JSON.stringify(history()));
			} catch (e) {
				console.warn(TAG, "history not saved", e);
			}
		}, 500);
	}
	/** @param {{ who: number, ev: string, text: string, name?: string, dir?: "in" | "out", p?: VLPattern }} e */
	function logEvent(e) {
		if (!settings.keepHistory || !loggedIn()) return;
		const list = history();
		list.push({ at: Date.now(), dir: "in", ...e, name: e.name || (isSelf(e.who) ? "You" : nameOf(e.who)) });
		if (list.length > HIST_MAX) list.splice(0, list.length - HIST_MAX);
		// Older entries drop their recordings and programs (the text stays)
		let kept = 0;
		for (let i = list.length - 1; i >= 0; i--) if (list[i].p && ++kept > HIST_KEEP_PATS) delete list[i].p;
		saveHistory();
		ui.renderSoon();
	}
	function clearHistory() {
		history().length = 0;
		saveHistory();
		ui.renderSoon();
	}
	// Live slider sessions are recorded as they play (the wearer's replay timeline, or the controller's own slider)
	/**
	 * @param {{ rec?: VLRecording | null }} holder
	 * @param {number} t
	 * @param {number} v 0..100
	 */
	function recPush(holder, t, v) {
		const r = (holder.rec = holder.rec || { t0: t, pts: [] });
		const x = t - r.t0;
		if (x > REC_MAX_MS || r.pts.length >= 20_000) return;
		const last = r.pts[r.pts.length - 1];
		if (last && x <= last[0]) return;
		r.pts.push([x, Math.round(v)]);
	}
	// Ends a recording; logged if it lasted at least 2 seconds
	/**
	 * @param {{ rec?: VLRecording | null } | null | undefined} holder
	 * @param {{ who: number, text: string, dir?: "in" | "out" }} entry
	 */
	function recFinish(holder, entry) {
		const r = holder?.rec;
		if (!r) return;
		holder.rec = null;
		const p = r.pts.length >= 2 && r.pts[r.pts.length - 1][0] >= 2000 ? cleanPattern({ type: "rec", pts: r.pts }) : null;
		if (p) logEvent({ ev: "live", p, ...entry, text: `${entry.text} (${fmtDur(p.dur)})` });
	}

	// ---------- remote control: who may control your toy (phase 3, step 1) ----------
	// Other players who also run Vibe Link can ask for control; you decide. This step only handles access:
	// asking, granting (once / for a while / always), revoking, blocking, expiry, the 🛑 lockout and the safe word.
	// What a controller can then do (live strength, patterns) comes in the next steps; anything they send is a
	// 0-100% value that your max strength scales, like the game levels.
	// Messages are hidden room messages (Type "Hidden", Content "VibeLink"), sent only to the person concerned,
	// or to the room for "hello" (who here runs Vibe Link). They carry data only and are checked on arrival.
	const RC = "VibeLink";
	const RC_V = 1;
	const RC_ASK_TIMEOUT = 60_000; // an unanswered request is declined after this
	const RC_REQ_GAP = 10_000; // a person can ask at most this often
	/** @type {Map<number, VLPeer>} */
	const peers = new Map(); // member -> { ver, accepts, at }: others here running Vibe Link
	/** @type {Map<number, VLGrant>} */
	const grants = new Map(); // you as wearer: member -> { until (0 = while you're both here), at }
	/** @type {Map<number, VLControl>} */
	const controlling = new Map(); // you as controller: member -> { state, until, reason, at }
	/** @type {Map<number, { at: number, timer: ReturnType<typeof setTimeout> }>} */
	const asks = new Map(); // requests waiting for your answer: member -> { at, timer }
	/** @type {Map<number, number>} */
	const lastReqAt = new Map();
	let lockoutUntil = 0;
	/** @type {string | null} */
	let helloRoom = null;
	// Remote control, wearer side. One controller at a time drives your toys through "lanes": the lane "*" (all toys)
	// or one per toy (its key), each playing live slider points, a pattern, or a single value (older controllers).
	// A per-toy lane wins over "*" for that toy. Only toys linked to a slot are driven, or every toy if none is linked.
	/** @type {VLRemote | null} */
	let remoteCtl = null; // { by, at, gameSig, lanes: Map(key -> lane), prev, mirror }
	const ALL = "*";
	function remoteToys() {
		const all = shownToys().filter((t) => t.vibes.length);
		const linked = all.filter((t) => settings.links[t.key]);
		return linked.length ? linked : all;
	}
	/** @param {unknown} k */
	const laneKey = (k) => (typeof k === "string" && k !== ALL && remoteToys().some((t) => t.key === k) ? k : ALL);
	/**
	 * @param {VLToy} toy
	 * @returns {VLLane | null}
	 */
	function laneFor(toy) {
		const rc = remoteCtl;
		if (!rc || !(grants.has(rc.by) || rc.lost) || !remoteToys().includes(toy)) return null;
		if (toy.virtual && !isSelf(rc.by)) return null; // only you drive the virtual toy
		if (isSelf(rc.by) && !selfAccess().slots.has(settings.links[toy.key])) return null;
		const lane = rc.lanes.get(toy.key) || rc.lanes.get(ALL) || null;
		// A toy stopped on its own goes back to the game even while "all toys" plays
		return lane?.free ? null : lane;
	}
	// A mode set by a controller whose mapping is "follow the game" leaves a linked toy to the game (the worn vibrator is
	// in that mode); everything else is driven by the lane
	/**
	 * @param {VLToy} toy
	 * @param {VLLane} lane
	 */
	const laneDrives = (toy, lane) => !(lane.game && settings.links[toy.key]);
	// Lost contact with whoever drives your toys (heartbeat, they left, you changed rooms): everything stays as they
	// left it until you stop it (🛑, safe word, Hand back) or the vibrator is changed in the game
	/** @param {number} m */
	function loseContact(m) {
		if (remoteCtl?.by !== m || remoteCtl.lost) return;
		remoteCtl.lost = true;
		ui.toast(`Lost contact with ${nameOf(m)}; your toy keeps their last setting (🛑 stops it).`);
		ui.renderSoon();
	}
	// Starts (or continues) the session for this controller; someone else's session ends first
	/**
	 * @param {number} from
	 * @param {number} now
	 * @returns {VLRemote}
	 */
	function remoteSession(from, now) {
		if (remoteCtl && remoteCtl.by !== from) endRemote("", false);
		if (!remoteCtl) {
			remoteCtl = { by: from, at: now, lanes: new Map(), gameSig: gameSig(), prev: {}, mirror: {} };
			ui.toast(isSelf(from) ? "You're playing your toys." : `${nameOf(from)} is controlling your toy.`);
			if (!isSelf(from)) logEvent({ who: from, ev: "start", text: `${nameOf(from)} took control` });
			announce(isSelf(from) ? `${myName()} takes over their own toy.` : `${nameOf(from)} takes control of ${myName()}'s toy.`);
			ui.renderSoon();
		}
		remoteCtl.at = now;
		remoteCtl.lost = false;
		return remoteCtl;
	}
	// "*" replaces every per-toy lane; a toy's lane leaves the others alone
	/**
	 * @param {VLRemote} rc
	 * @param {string} key
	 * @param {VLLane} lane
	 */
	function setLane(rc, key, lane) {
		if (key === ALL) for (const [k, l] of rc.lanes) laneDone(rc, k, l);
		else laneDone(rc, key, rc.lanes.get(key));
		if (key === ALL) rc.lanes.clear();
		rc.lanes.set(key, lane);
		ui.renderSoon();
	}
	// A lane is replaced or ends: its live recording (if any) goes into the history
	/**
	 * @param {VLRemote} rc
	 * @param {string} key
	 * @param {VLLane | undefined} lane
	 */
	function laneDone(rc, key, lane) {
		if (!lane?.rec) return;
		const on = key && key !== ALL ? ` on ${toyName(key)}` : "";
		recFinish(lane, { who: rc.by, text: isSelf(rc.by) ? `You played live${on}` : `${nameOf(rc.by)} controlled you live${on}` });
	}
	/** @param {string} key */
	const toyName = (key) => (key === ALL ? "all toys" : toys.get?.(key)?.display || [...toys.values()].find((t) => t.key === key)?.display || key);
	const REMOTE_GLIDE_MIN = 30; // the wearer glides between values over the time between them, within these limits
	const REMOTE_GLIDE_MAX = 250;
	let statusAt = 0;
	// What the game says about your linked slots; when it changes during live control, the game takes over again
	// (the chosen option, not the level: in Random, Escalate, ... the game moves the level by itself)
	const gameSig = () =>
		JSON.stringify(
			Object.values(settings.links)
				.sort()
				.map((sl) => {
					const st = slotState(sl);
					return st.item?.Property?.TypeRecord?.vibrating ?? st.level;
				})
		);
	// Replay buffer. The controller records the slider with its own timing and sends it in small batches; we play the
	// points back on their timeline, a fixed delay behind, so network stalls and bursts don't change the curve.
	const PTS_MAX = 60; // points per batch
	const PTS_EVERY = 100; // a controller sends one batch at most this often
	/**
	 * @param {VLLane & { buf: { at: number, v: number }[] }} rc
	 * @param {number} now
	 */
	function replayValue(rc, now) {
		const b = rc.buf;
		if (!b.length) return rc.val || 0;
		// Points that have already played, except the last one, aren't needed any more
		while (b.length > 1 && b[1].at <= now) b.shift();
		const a = b[0];
		// Nothing due yet: stay where we are until the first point's moment
		if (now <= a.at) return rc.val || 0;
		const c = b[1];
		if (!c) return (rc.val = a.v);
		const x = (now - a.at) / Math.max(1, c.at - a.at);
		return (rc.val = a.v + (c.v - a.v) * Math.min(1, Math.max(0, x)));
	}
	/**
	 * @param {number} from
	 * @param {VLMsg} msg
	 * @param {number} now
	 */
	function onPoints(from, msg, now) {
		if (!grants.has(from) || local.paused) return;
		const st = Number(msg.st);
		if (!Number.isFinite(st) || st < 0 || !Array.isArray(msg.p)) return;
		/** @type {[number, number][]} */
		const pts = [];
		for (const q of msg.p.slice(0, PTS_MAX)) {
			if (!Array.isArray(q)) continue;
			const dt = Math.round(Number(q[0]));
			const v = Math.round(Number(q[1]));
			if (!Number.isFinite(dt) || !Number.isFinite(v) || dt < 0 || dt > 5000) continue;
			pts.push([dt, Math.min(100, Math.max(0, v)) / 100]);
		}
		if (!pts.length) return;
		const session = remoteSession(from, now);
		const key = laneKey(msg.toy);
		const had = session.lanes.get(key);
		/** @type {VLLane & { buf: { at: number, v: number }[] }} */
		const rc = had?.buf ? /** @type {VLLane & { buf: { at: number, v: number }[] }} */ (had) : { buf: [], offset: null, val: had ? remoteRaw(had, now) : 0 };
		if (rc !== had) setLane(session, key, rc);
		const delay = settings.remote.bufferMs;
		const lastAt = rc.buf.length ? rc.buf[rc.buf.length - 1].at : -Infinity;
		// Their clock is mapped to ours once per burst of movement (when nothing is waiting to play), then held steady:
		// points play `delay` after they'd have arrived on time. A batch that arrives too late to play in time pushes
		// the timeline later (a short pause) rather than dropping points; it's never pulled earlier, so order holds.
		// A batch leaves about PTS_EVERY ms after its first point, with its newest point; anchor on the newest point plus
		// one batch, so the whole smoothing delay is spare for stalls on the way
		const lag = now - (st + pts[pts.length - 1][0]) + PTS_EVERY;
		const firstLag = now - st;
		if (rc.offset == null || lastAt < now - 100) rc.offset = lag;
		else if (firstLag > rc.offset + delay - 30) rc.offset = firstLag - delay + 30;
		for (const [dt, v] of pts) {
			const at = Math.max(st + dt + rc.offset + delay, lastAt + 1);
			rc.buf.push({ at, v });
			recPush(rc, at, v * 100);
		}
		if (rc.buf.length > 600) rc.buf.splice(0, rc.buf.length - 600);
	}


	// ---------- the worn vibrator follows remote control ----------
	// While someone controls you, your character's vibrator(s) in the linked slots show a matching game level, so the
	// room sees what's happening. The level comes from a running average of the controller's 0-100% (not scaled by
	// your max strength): under 5% Off, 5-25 Low, 25-55 Medium, 55-85 High, above Max. It changes only after the new
	// level has held for MIRROR_HOLD_MS and at most every MIRROR_GAP_MS, is synced silently (no chat line), and goes
	// back to what it was when remote control ends. A vibrator locked by someone else is left alone unless the
	// controller is the one who locked it, or your owner.
	const MIRROR_HOLD_MS = 2000;
	const MIRROR_GAP_MS = 5000;
	const levelForPct = (/** @type {number} */ pct) => (pct < 5 ? 0 : pct < 25 ? 1 : pct < 55 ? 2 : pct < 85 ? 3 : 4); // option index: Off, Low, Medium, High, Maximum

	// The controller's current value, 0..1, before your max strength
	/**
	 * @param {VLLane} rc
	 * @param {number} now
	 * @returns {number} 0..1
	 */
	function remoteRaw(rc, now) {
		if (rc.lvl != null) return settings.levels[rc.lvl] / 100;
		if (rc.pat) return patternAt(rc.pat, now - (rc.t0 ?? now), rc.rnd) / 100;
		return rc.buf ? replayValue(/** @type {VLLane & { buf: { at: number, v: number }[] }} */ (rc), now) : rc.val || 0;
	}

	// Called every engine tick: a running average (about 1.5 s) of what the controller is doing, per driven toy
	/** @param {number} now */
	function rcTrackLevel(now) {
		for (const toy of toys.values()) {
			const lane = laneFor(toy);
			if (!lane) {
				toy.ravg = null;
				continue;
			}
			const v = remoteRaw(lane, now) * 100;
			toy.ravg = toy.ravg == null ? v : toy.ravg + (v - toy.ravg) * 0.035;
		}
	}

	/**
	 * @param {AssetGroupName} slot
	 * @returns {Item | null}
	 */
	function vibeItemIn(slot) {
		const item = typeof InventoryGet === "function" ? InventoryGet(Player, slot) : Player.Appearance.find((it) => it?.Asset?.Group?.Name === slot) || null;
		if (!item || item.Asset?.Archetype !== "vibrating" || typeof ExtendedItemSetOptionByRecord !== "function") return null;
		return item;
	}
	/**
	 * @param {Item} item
	 * @param {number} by
	 */
	function mayChange(item, by) {
		if (isSelf(by)) return selfAccess().gameSlots.has(item.Asset?.Group?.Name);
		const p = item.Property || {};
		if (!p.LockedBy) return true;
		if (p.LockMemberNumber === by) return true;
		try {
			return !!Player.IsOwnedByMemberNumber?.(by);
		} catch {
			return false;
		}
	}
	// Index of a named option (Off ... Maximum, Random ... Edge) on this vibrator, -1 if it has none
	/**
	 * @param {Item} item
	 * @param {string} name
	 */
	function vibeOptIndex(item, name) {
		try {
			const opts = ExtendedItemGetData(item.Asset, "vibrating")?.options || [];
			return opts.findIndex((o) => o.Name === name);
		} catch {
			return -1;
		}
	}
	/**
	 * @param {Item} item
	 * @param {number} idx
	 */
	function vibeOptName(item, idx) {
		try {
			return ExtendedItemGetData(item.Asset, "vibrating")?.options?.[idx]?.Name || LEVEL_OPT[idx] || "";
		} catch {
			return LEVEL_OPT[idx] || "";
		}
	}
	const LEVEL_OPT = ["Off", "Low", "Medium", "High", "Maximum"];
	/**
	 * @param {AssetGroupName} slot
	 * @param {Item} item
	 * @param {number} idx
	 */
	function setVibeOption(slot, item, idx) {
		try {
			ExtendedItemSetOptionByRecord(Player, item, { vibrating: idx }, { push: false, refresh: true });
			if (typeof ChatRoomCharacterItemUpdate === "function") ChatRoomCharacterItemUpdate(Player, slot);
			return true;
		} catch (e) {
			console.warn(TAG, "couldn't set the worn vibrator", e);
			return false;
		}
	}

	// Once a second (from rcTick): each linked slot's worn vibrator moves to the level that matches the toy(s) linked to
	// it, once settled. A slot whose toys are no longer driven goes back to what it had.
	/** @param {number} now */
	function rcMirror(now) {
		const rc = remoteCtl;
		if (!rc || !(grants.has(rc.by) || rc.lost)) return;
		let changed = false;
		for (const slot of /** @type {Set<AssetGroupName>} */ (new Set(Object.values(settings.links)))) {
			const driven = [...toys.values()].filter((t) => settings.links[t.key] === slot && t.ravg != null);
			const m = (rc.mirror[slot] = rc.mirror[slot] || {});
			if (!driven.length) {
				if (m.level != null) changed = restoreSlot(rc, slot) || changed;
				continue;
			}
			// A level or mode the controller picked is set exactly and at once, like using the game's own remote
			const fixed = driven.map((t) => laneFor(t)).find((l) => l && (l.lvl != null || l.mode));
			const item = vibeItemIn(slot);
			let want = fixed && item ? vibeOptIndex(item, fixed.mode || LEVEL_OPT[fixed.lvl ?? 0]) : -1;
			const exact = want >= 0;
			if (!exact) want = levelForPct(Math.max(...driven.map((t) => t.ravg ?? 0)));
			if (want === m.level) {
				m.pending = null;
				continue;
			}
			if (m.pending?.level !== want) m.pending = { level: want, since: now };
			if (!exact && m.level != null && (now - m.pending.since < MIRROR_HOLD_MS || now - (m.at || 0) < MIRROR_GAP_MS)) continue;
			if (!item || !mayChange(item, rc.by)) continue;
			if (!(slot in rc.prev)) rc.prev[slot] = { asset: item.Asset.Name, idx: item.Property?.TypeRecord?.vibrating ?? 0 };
			const was = item.Property?.TypeRecord?.vibrating ?? -1;
			if (was !== want && setVibeOption(slot, item, want)) {
				changed = true;
				const what = item.Asset?.Description || "vibrator";
				// (a level or mode the controller picked was announced when it came in)
				if (!exact) announce(want === 0 ? `${myName()}'s ${what} goes quiet.` : `${myName()}'s ${what} ${want > was ? "rises" : "eases"} to ${LEVEL_WORDS[want] || vibeOptName(item, want)}.`);
			}
			m.level = want;
			m.at = now;
			m.pending = null;
		}
		// Our own change mustn't look like someone else taking over in the game
		if (changed) rc.gameSig = gameSig();
	}

	// A slot goes back to what it had before remote control (if nobody changed it since)
	/**
	 * @param {VLRemote} rc
	 * @param {AssetGroupName} slot
	 */
	function restoreSlot(rc, slot) {
		const prev = rc.prev[slot];
		const m = rc.mirror[slot] || {};
		let done = false;
		const item = prev && vibeItemIn(slot);
		if (item && item.Asset.Name === prev.asset && (item.Property?.TypeRecord?.vibrating ?? -1) === m.level) done = setVibeOption(slot, item, prev.idx);
		delete rc.prev[slot];
		delete rc.mirror[slot];
		return done;
	}
	/** @param {VLRemote} rc */
	function rcRestoreGame(rc) {
		if (!rc?.prev) return;
		for (const slot of /** @type {AssetGroupName[]} */ (Object.keys(rc.prev))) restoreSlot(rc, slot);
	}

	// Remote control changes in chat (Remote → Safety → Announce changes). "me": a local line only you see. "room": an
	// action line everyone in the room sees, sent the way other add-ons post custom action text.
	const ctrlName = (/** @type {number} */ m) => (isSelf(m) ? myName() : nameOf(m));
	// Room announcements go out at most once every ANNOUNCE_GAP: a controller clicking quickly (or on purpose) can't flood
	// the room from your account. Changes in between are merged: only the latest one is posted when the gap is over.
	const ANNOUNCE_GAP = 4000;
	let announceLast = 0;
	/** @type {string | null} */
	let announceNext = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let announceTimer;
	/** @param {string} text */
	function announce(text) {
		const mode = settings.remote.announce;
		if (mode === "off" || !text || !rcInRoom()) return;
		if (mode === "me") {
			if (settings.chatLines && typeof ChatRoomSendLocal === "function") ChatRoomSendLocal(`〰 ${text}`, 30000);
			return;
		}
		const wait = ANNOUNCE_GAP - (Date.now() - announceLast);
		if (wait > 0) {
			announceNext = text;
			if (!announceTimer)
				announceTimer = setTimeout(() => {
					announceTimer = undefined;
					const next = announceNext;
					announceNext = null;
					if (next) announce(next);
				}, wait);
			return;
		}
		announceLast = Date.now();
		try {
			const tags = ["Beep", "Biep", "Sonner", "发送私聊"]; // shown as the text in any game language
			// VL_MARK lets anyone's Vibe Link recognise (and, if they choose, hide) the line; the game ignores unused tags
			ServerSend("ChatRoomChat", { Content: "Beep", Type: "Action", Dictionary: [...tags.map((Tag) => ({ Tag, Text: text })), { Tag: VL_MARK, Text: "" }] });
		} catch (e) {
			console.warn(TAG, "announcement failed", e);
		}
	}
	const LEVEL_WORDS = ["off", "low", "medium", "high", "max"];

	// "Vibe Link messages in my chat" off: Vibe Link announcements from anyone are left out of your chat (the game's own
	// lines are untouched). Uses the game's message-handler list, the supported way for mods to filter chat.
	const VL_MARK = "VibeLinkAnnounce";
	const chatFilter = {
		Description: "Vibe Link: hide Vibe Link announcements when its chat lines are off",
		Priority: -205,
		Callback: (/** @type {ServerChatRoomMessage} */ data) => !settings.chatLines && data?.Type === "Action" && Array.isArray(data.Dictionary) && data.Dictionary.some((/** @type {any} */ e) => e?.Tag === VL_MARK),
	};
	function addChatFilter() {
		if (typeof ChatRoomMessageHandlers !== "undefined" && ChatRoomMessageHandlers.includes(chatFilter)) return;
		if (typeof ChatRoomRegisterMessageHandler === "function") ChatRoomRegisterMessageHandler(chatFilter);
	}
	addChatFilter();

	/**
	 * @param {string} reason shown to you (empty: nothing)
	 * @param {boolean} [tell] tell the controller
	 * @param {boolean} [restore] put the worn vibrator back
	 */
	function endRemote(reason, tell = true, restore = true) {
		if (!remoteCtl) return;
		const by = remoteCtl.by;
		const rc = remoteCtl;
		remoteCtl = null;
		for (const [k, l] of rc.lanes) laneDone(rc, k, l);
		if (!isSelf(by)) logEvent({ who: by, ev: "end", text: `${nameOf(by)}'s control ended${reason ? `: ${reason}` : ""}` });
		if (restore) rcRestoreGame(rc);
		announce(`${myName()}'s toy follows the game again.`);
		if (tell && grants.has(by)) rcSend(by, { t: "note", text: reason });
		ui.renderSoon();
	}
	/** @type {boolean | null} */
	let lastAccepts = null;

	const rcInRoom = () => loggedIn() && typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" && typeof ChatRoomData !== "undefined" && !!ChatRoomData;
	const charOf = (/** @type {number} */ m) => (typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((c) => c.MemberNumber === m) : null);
	/** @param {number} m */
	function nameOf(m) {
		const c = charOf(m);
		if (c) return typeof CharacterNickname === "function" ? CharacterNickname(c) : c.Name;
		return settings.remote.always[m] || settings.remote.blocked[m] || `#${m}`;
	}
	const acceptsRemote = () => settings.remote.on && Date.now() >= lockoutUntil;
	const lockedOut = () => Date.now() < lockoutUntil;

	// Heartbeat: a controller sends "hb" when it has said nothing to the wearer for HB_EVERY; the wearer sends status
	// every second anyway. Silence means the other side is gone (crashed tab, lost connection) and gets cleaned up.
	const HB_EVERY = 5000;
	const HB_LOST = 15_000; // no word from the controller: contact is lost, your toy keeps their last setting
	const HB_DROP = 30_000; // ... and their grant is dropped (the setting still stays until you stop it)
	/** @type {Map<number, number>} */
	const lastSentTo = new Map(); // member -> when we last sent them anything
	/** @type {Map<number, number>} */
	const lastHeard = new Map(); // member -> when we last heard from them
	/** @type {Map<number, number>} */
	const staleToldAt = new Map(); // member -> when we last told them they no longer have control
	/** @type {Map<number, number>} */
	const helloToldAt = new Map(); // member -> when we last answered their hello

	// You can be your own controller ("Play on my toys"): messages to yourself are handled right here, never sent
	const isSelf = (/** @type {number | null | undefined} */ m) => m != null && m === Player.MemberNumber;
	/**
	 * @param {number | null} target null: the whole room
	 * @param {VLMsg} payload
	 */
	function rcSend(target, payload) {
		if (target != null && isSelf(target)) {
			/** @type {VLMsg} */
			const own = { v: RC_V, ...payload };
			lastSentTo.set(target, Date.now());
			setTimeout(() => {
				lastHeard.set(target, Date.now());
				if (own.t !== "hb") rcHandle(target, own);
			});
			return;
		}
		if (!rcInRoom() || typeof ServerSend !== "function") return;
		if (target != null) lastSentTo.set(target, Date.now());
		/** @type {ServerChatRoomMessage} */
		const msg = { Content: RC, Type: "Hidden", Dictionary: /** @type {any[]} */ ([{ message: { v: RC_V, ...payload } }]) };
		if (target != null) msg.Target = target;
		try {
			ServerSend("ChatRoomChat", msg);
		} catch (e) {
			console.warn(TAG, "remote message failed to send", e);
		}
	}

	// The game decides who may use items on you; remote control never goes beyond that
	/** @param {Character | null | undefined} c */
	function gameAllows(c) {
		try {
			return typeof ServerChatRoomGetAllowItem !== "function" || !!c && !!ServerChatRoomGetAllowItem(c, Player);
		} catch {
			return false;
		}
	}
	/** @param {number} m */
	function ownerOrLover(m) {
		try {
			if (Player.IsOwnedByMemberNumber?.(m)) return true;
			if (Player.Ownership?.MemberNumber === m) return true;
			const lovers = Player.GetLoversNumbers?.() || (Player.Lovership || []).map((l) => l.MemberNumber);
			return lovers.includes(m);
		} catch {
			return false;
		}
	}

	// Incoming hidden messages; returns true if it was ours
	/** @param {ServerChatRoomMessage} data */
	function rcReceive(data) {
		if (!data || data.Type !== "Hidden" || data.Content !== RC) return false;
		const from = data.Sender;
		if (typeof from !== "number" || from === Player.MemberNumber) return true;
		const msg = /** @type {any} */ (data.Dictionary?.[0])?.message;
		if (!msg || typeof msg !== "object" || msg.v !== RC_V || typeof msg.t !== "string") return true;
		lastHeard.set(from, Date.now());
		// Someone acting as our controller who no longer has control (we reloaded, revoked, timed out): tell them, so
		// their panel stops showing control that does nothing (at most once every 5 s per person)
		if (["pts", "pat", "live", "stop", "hb"].includes(msg.t) && !grants.has(from)) {
			if (Date.now() - (staleToldAt.get(from) || 0) > 5000) {
				staleToldAt.set(from, Date.now());
				rcSend(from, { t: "revoke", reason: "You don't have control any more" });
			}
			return true;
		}
		if (msg.t === "hb") return true; // only says "still here"
		try {
			rcHandle(from, msg);
		} catch (e) {
			console.warn(TAG, "remote message failed", e);
		}
		return true;
	}

	/**
	 * @param {number} from
	 * @param {VLMsg} msg
	 */
	function rcHandle(from, msg) {
		const now = Date.now();
		const reason = (/** @type {unknown} */ r) => (typeof r === "string" ? r.slice(0, 120) : "");
		switch (msg.t) {
			case "hello":
				peers.set(from, { ver: String(msg.ver || "").slice(0, 20), accepts: !!msg.accepts, at: now });
				// At most one reply per person every RC_REQ_GAP, so nobody can make your account send messages on demand
				if (msg.ask && now - (helloToldAt.get(from) || 0) >= RC_REQ_GAP) {
					helloToldAt.set(from, now);
					rcSend(from, { t: "hello", ver: MOD_INFO.version, accepts: acceptsRemote(), ask: false });
				}
				break;
			case "req":
				onRequest(from);
				break;
			case "grant": {
				const secs = Number(msg.for) || 0;
				const was = controlling.get(from)?.state;
				controlling.set(from, { state: "granted", until: secs > 0 ? now + Math.min(secs, 24 * 3600) * 1000 : 0, at: now });
				if (was !== "granted") ui.toast(`${nameOf(from)} gave you control${secs > 0 ? ` for ${fmtDur(secs * 1000)}` : ""}.`);
				break;
			}
			case "deny":
				controlling.set(from, { state: "denied", reason: reason(msg.reason), at: now });
				ui.toast(`${nameOf(from)}: ${reason(msg.reason) || "declined"}.`);
				break;
			case "revoke": {
				const had = controlling.get(from);
				if (had && had.state !== "revoked") {
					outDone(from, had);
					controlling.set(from, { state: "revoked", reason: reason(msg.reason), at: now });
					ui.toast(`${nameOf(from)} took control back${msg.reason ? `: ${reason(msg.reason)}` : ""}.`);
				}
				break;
			}
			case "release":
				if (grants.delete(from)) ui.toast(`${nameOf(from)} gave control back.`);
				if (remoteCtl?.by === from) endRemote("", false);
				break;
			// Wearer side: a value from someone you gave control to (anyone else is ignored)
			// Live control: a batch of slider points with the controller's timing (replayed, see onPoints)
			case "pts":
				onPoints(from, msg, now);
				return;
			// Older controllers (0.4.0) send single values
			case "live": {
				if (!grants.has(from) || local.paused) return;
				const v = Math.round(Number(msg.val));
				if (!Number.isFinite(v)) return;
				const session = remoteSession(from, now);
				const prev = session.lanes.get(ALL);
				const lane = { val: Math.min(100, Math.max(0, v)) / 100, at: now, gap: prev && !prev.buf && !prev.pat ? now - (prev.at || now) : 0 };
				if (prev && !prev.buf && !prev.pat) session.lanes.set(ALL, lane);
				else setLane(session, ALL, lane);
				return;
			}
			// Stop one toy (msg.toy) or everything
			case "stop": {
				if (remoteCtl?.by !== from) return;
				const key = msg.toy == null ? ALL : laneKey(msg.toy);
				if (key === ALL) return endRemote("", false);
				// Free just this toy (marked, so "all toys" doesn't pick it up again); when nothing is driven any more, it's over
				laneDone(remoteCtl, key, remoteCtl.lanes.get(key));
				remoteCtl.lanes.set(key, { free: true });
				if (!remoteToys().some((t) => laneFor(t))) endRemote("", false);
				ui.renderSoon();
				return;
			}
			// Controller side: what their toy is doing, about once a second
			// Wearer side: play a pattern (replaces live control or another pattern)
			case "pat": {
				if (!grants.has(from) || local.paused) return;
				const pat = cleanPattern(msg.p);
				if (!pat) return;
				const session = remoteSession(from, now);
				const key = laneKey(msg.toy);
				setLane(session, key, { pat, rnd: seeded(pat.seed), t0: now, until: pat.dur ? now + pat.dur : 0 });
				if (!isSelf(from)) logEvent({ who: from, ev: "pat", p: pat, text: `${nameOf(from)} played ${patternText(pat)}${pat.dur && !isBig(pat) ? ` for ${fmtDur(pat.dur)}` : ""}${key === ALL ? "" : ` on ${toyName(key)}`}` });
				announce(`${ctrlName(from)} starts ${patLabel(pat)} (${pat.min}-${pat.max}%${pat.dur ? `, ${fmtDur(pat.dur)}` : ""}) on ${isSelf(from) ? "their" : `${myName()}'s`} ${key === ALL ? "toy" : toyName(key)}.`);
				return;
			}
			// Wearer side: hold a game level (your own % for it, the worn vibrator set to it) or a game mode
			case "lvl":
			case "mode": {
				if (!grants.has(from) || local.paused) return;
				const session = () => remoteSession(from, now);
				const key = laneKey(msg.toy);
				const where = `${isSelf(from) ? "their" : `${myName()}'s`} ${key === ALL ? "toy" : toyName(key)}`;
				if (msg.t === "lvl") {
					const n = Math.round(Number(msg.n));
					if (!(n >= 0 && n <= 4)) return;
					setLane(session(), key, { lvl: n, at: now });
					if (!isSelf(from)) logEvent({ who: from, ev: "lvl", text: `${nameOf(from)} set ${LEVEL_NAMES[n]}${key === ALL ? "" : ` on ${toyName(key)}`}` });
					announce(`${ctrlName(from)} sets ${where} to ${LEVEL_NAMES[n]}.`);
					return;
				}
				const mode = VIBE_MODES.find((x) => x === msg.mode);
				if (!mode) return;
				const mp = modePattern(mode);
				const pat = /** @type {VLPattern} */ ({ ...(mp || cleanPattern({ ...MODE_DEFAULTS[mode], dur: 0, seed: 1 })), seed: (Math.random() * 2 ** 31) | 0 });
				setLane(session(), key, { mode, pat, rnd: seeded(pat.seed), t0: now, until: 0, game: !mp });
				if (!isSelf(from)) logEvent({ who: from, ev: "mode", text: `${nameOf(from)} set ${mode} mode${key === ALL ? "" : ` on ${toyName(key)}`}` });
				announce(`${ctrlName(from)} sets ${where} to ${mode} mode.`);
				return;
			}
			case "status": {
				const c = controlling.get(from);
				if (c?.state !== "granted") return;
				const toyList = Array.isArray(msg.toys) ? msg.toys.slice(0, 8) : [];
				const pat = msg.pat ? cleanPattern(msg.pat) : null;
				const pl = (/** @type {unknown} */ x) => (typeof x === "string" ? x.slice(0, 60) : null);
				c.status = {
					at: now,
					active: !!msg.active,
					pat,
					pl: pl(msg.pl),
					left: (pat || msg.pl) && Number(msg.left) > 0 ? Math.min(3_600_000, Number(msg.left)) : 0,
					toys: toyList.map((/** @type {any} */ t) => {
						const tp = t?.pat ? cleanPattern(t.pat) : null;
						return {
							n: String(t?.n || "Toy").slice(0, 30),
							k: typeof t?.k === "string" ? t.k.slice(0, 60) : null,
							pct: Math.min(100, Math.max(0, Math.round(Number(t?.pct) || 0))),
							e: t?.e == null ? true : !!t.e,
							m: ["pat", "live", "lvl", "mode"].includes(t?.m) ? t.m : "game",
							lv: t?.m === "lvl" ? Math.min(4, Math.max(0, Math.round(Number(t.lv) || 0))) : null,
							md: t?.m === "mode" ? VIBE_MODES.find((x) => x === t.md) || null : null,
							el: tp && Number(t.el) > 0 ? Math.min(86_400_000, Number(t.el)) : 0,
							pat: tp,
							pl: pl(t?.pl),
							left: (tp || t?.pl) && Number(t.left) > 0 ? Math.min(3_600_000, Number(t.left)) : 0,
						};
					}),
				};
				return;
			}
			case "note": {
				const ctl = controlling.get(from);
				if (ctl?.state === "granted") {
					if (typeof msg.toy === "string" && msg.toy !== ALL) {
						ctl.playingBy?.delete(msg.toy);
						ctl.liveBy?.delete(msg.toy);
					} else {
						ctl.val = 0;
						ctl.playingBy?.clear();
						ctl.liveBy?.clear();
					}
					ui.toast(`${nameOf(from)}: ${reason(msg.text) || "back to the game"}.`);
				}
				break;
			}
		}
		ui.renderSoon();
	}

	// You as wearer: someone asks for control
	/** @param {number} from */
	function onRequest(from) {
		const now = Date.now();
		if (now - (lastReqAt.get(from) || 0) < RC_REQ_GAP) return;
		lastReqAt.set(from, now);
		const deny = (/** @type {string} */ r) => rcSend(from, { t: "deny", reason: r });
		const c = charOf(from);
		if (!c) return;
		if (!settings.remote.on) return deny("They haven't turned on remote control");
		if (lockedOut()) return deny("They stopped everything a moment ago, try again later");
		if (settings.remote.blocked[from]) return deny("Not allowed");
		if (!gameAllows(c)) return deny("The game doesn't let you use items on them");
		const g = grants.get(from);
		if (g) return rcSend(from, grantMsg(g));
		if (settings.remote.always[from] || (settings.remote.trustOwners && ownerOrLover(from))) return giveControl(from, { mins: 0 });
		if (settings.remote.mode === "list") return deny("Only people they've chosen can control them");
		if (asks.has(from)) return;
		const timer = setTimeout(() => answerAsk(from, "decline", "No answer"), RC_ASK_TIMEOUT);
		asks.set(from, { at: now, timer });
		ui.toast(`${nameOf(from)} asks to control your toy (Vibe Link → Remote).`);
		ui.renderSoon();
	}

	// Your answer to a request: "once" (while you're both here), a number of minutes, "always", or "decline"
	/**
	 * @param {number} from
	 * @param {string | number} answer once, minutes (15, 60, …), always, decline or block
	 * @param {string} [why]
	 */
	function answerAsk(from, answer, why) {
		const a = asks.get(from);
		if (!a) return;
		clearTimeout(a.timer);
		asks.delete(from);
		if (answer === "decline") rcSend(from, { t: "deny", reason: why || "Declined" });
		else if (answer === "always") giveControl(from, { mins: 0, always: true });
		else giveControl(from, { mins: answer === "once" ? 0 : Number(answer) || 0 });
		ui.renderSoon();
	}

	const grantMsg = (/** @type {VLGrant} */ g) => ({ t: "grant", for: g.until ? Math.max(1, Math.round((g.until - Date.now()) / 1000)) : 0 });

	/**
	 * @param {number} member
	 * @param {{ mins?: number, always?: boolean }} [how] mins: 0 while you're both here
	 */
	function giveControl(member, { mins = 0, always = false } = {}) {
		if (!charOf(member) || !settings.remote.on || lockedOut()) return false;
		const g = { until: mins > 0 ? Date.now() + mins * 60_000 : 0, at: Date.now() };
		grants.set(member, g);
		lastHeard.set(member, Date.now());
		if (always) {
			settings.remote.always[member] = nameOf(member);
			saveSettings();
		}
		rcSend(member, grantMsg(g));
		ui.renderSoon();
		return true;
	}

	/**
	 * @param {number} member
	 * @param {string} [why]
	 * @param {boolean} [silent]
	 */
	function revokeControl(member, why = "Taken back", silent = false) {
		if (remoteCtl?.by === member) endRemote("", false);
		if (!grants.delete(member)) return;
		if (!silent) rcSend(member, { t: "revoke", reason: why });
		ui.renderSoon();
	}

	/** @param {number} member */
	function blockMember(member) {
		settings.remote.blocked[member] = nameOf(member);
		delete settings.remote.always[member];
		saveSettings();
		revokeControl(member, "Not allowed");
		if (asks.has(member)) answerAsk(member, "decline", "Not allowed");
	}

	// 🛑, the stop hotkey and the safe word: everyone loses control and new requests are refused for a while
	function rcOnStop() {
		if (!grants.size && !asks.size && !settings.remote.on) return;
		lockoutUntil = Date.now() + settings.remote.lockoutMin * 60_000;
		if (grants.has(Player.MemberNumber)) endSelf();
		for (const m of [...grants.keys()]) revokeControl(m, "They pressed stop");
		for (const m of [...asks.keys()]) answerAsk(m, "decline", "They pressed stop");
		ui.renderSoon();
	}

	// "Play on my toys" follows the game: you may only play the toys linked to a worn vibrator you could change yourself
	// in the game right now. Same rule as the item's menu: a vibrator that works by remote needs free hands, a vibrator
	// remote and no rule or item blocking remotes; any other needs free hands and a slot you can reach.
	const SELF_WHY = {
		CannotInteract: "You can't use your hands",
		NoRemote: "You need a vibrator remote",
		NoLoversRemote: "You need a lover's vibrator remote",
		RemotesBlocked: "Remotes are blocked for you",
		NoRemoteOwnerRuleActive: "Your owner doesn't allow remotes",
		NoAccess: "Only your lover can use it",
	};
	/**
	 * @param {AssetGroupName} slot
	 * @returns {string | null} why you can't change it (null: you can)
	 */
	function ownVibeAccess(slot) {
		const item = slotState(slot).item;
		if (!item || item.Asset?.Archetype !== "vibrating") return "Wear a vibrator in the linked slot";
		try {
			const st = typeof DialogCanUseRemoteState === "function" ? DialogCanUseRemoteState(Player, item) : "InvalidItem";
			if (st !== "InvalidItem") return st === "Available" ? "" : SELF_WHY[st] || "The game doesn't let you change it";
			if (!(Player.CanInteract?.() || item.Asset.AlwaysInteract)) return SELF_WHY.CannotInteract;
			if (typeof InventoryGroupIsBlocked === "function" && InventoryGroupIsBlocked(Player, /** @type {AssetGroupItemName} */ (slot)) && !item.Asset.AlwaysExtend) return "You can't reach it";
			return "";
		} catch {
			return "The game doesn't let you change it";
		}
	}
	// { ok, slots: Set of slots you may play, why }, worked out at most once a second
	/** @type {{ at: number, ok: boolean, slots: Set<string>, gameSlots: Set<string>, why: string } | null} */
	let selfAccessCache = null;
	function selfAccess(now = Date.now()) {
		if (selfAccessCache && now - selfAccessCache.at < 1000) return selfAccessCache;
		/** @type {Set<string>} */
		const slots = new Set(); // toys linked here may be played
		/** @type {Set<string>} */
		const gameSlots = new Set(); // the worn vibrator here may be changed (always the game's rule)
		let why = "Link a toy to a worn vibrator first";
		if (loggedIn())
			for (const slot of /** @type {Set<AssetGroupName>} */ (new Set(Object.values(settings.links)))) {
				const w = ownVibeAccess(slot);
				if (!w) gameSlots.add(slot);
				else why = w;
				if (!w || settings.selfIgnoreRules) slots.add(slot);
			}
		const ok = slots.size > 0;
		const reason = ok ? "" : why;
		if (selfAccessCache && (selfAccessCache.ok !== ok || selfAccessCache.why !== reason)) ui.renderSoon();
		selfAccessCache = { at: now, ok, slots, gameSlots, why: reason };
		return selfAccessCache;
	}

	// "Play on my toys": you hold control of your own toys, no permission needed (🛑 still stops it)
	function ensureSelf() {
		const me = Player.MemberNumber;
		if (!me || !selfAccess().ok) return null;
		if (local.paused) resume(); // you asked to play: that's your OK to start again
		const now = Date.now();
		if (!grants.has(me)) grants.set(me, { until: 0, at: now, self: true });
		const c = controlling.get(me);
		if (c?.state !== "granted") controlling.set(me, { state: "granted", until: 0, at: now, playingBy: c?.playingBy, liveBy: c?.liveBy });
		lastHeard.set(me, now);
		return controlling.get(me);
	}
	function endSelf() {
		const me = Player.MemberNumber;
		if (remoteCtl?.by === me) endRemote("", false);
		grants.delete(me);
		controlling.delete(me);
		ui.renderSoon();
	}

	// You as controller
	/** @param {number} member */
	function askControl(member) {
		controlling.set(member, { state: "pending", at: Date.now() });
		rcSend(member, { t: "req" });
		setTimeout(() => {
			if (controlling.get(member)?.state === "pending") {
				controlling.set(member, { state: "denied", reason: "No answer", at: Date.now() });
				ui.renderSoon();
			}
		}, RC_ASK_TIMEOUT + 5000);
		ui.renderSoon();
	}
	// Every slider change is recorded with its time; batches go out every PTS_EVERY ms while it moves. The wearer replays
	// them on this timeline, so the curve arrives exactly as drawn even when messages bunch up on the way.
	// Your own live slider on someone else goes into your history as a recording when it stops
	/**
	 * @param {number} member
	 * @param {VLControl} c
	 */
	function outDone(member, c) {
		if (c?.rec) recFinish(c, { dir: "out", who: member, text: `You controlled ${nameOf(member)} live` });
	}
	/**
	 * @param {number} member
	 * @param {number} pct 0..100
	 */
	function sendLive(member, pct) {
		const c = controlling.get(member);
		if (c?.state !== "granted") return;
		const v = Math.min(100, Math.max(0, Math.round(pct)));
		if (v === c.val && c.pts) return; // only changes are recorded
		const now = Date.now();
		if (!isSelf(member)) {
			const last = c.rec?.pts[c.rec.pts.length - 1];
			if (last && c.rec && now - c.rec.t0 - last[0] > 60 && c.val != null) recPush(c, now - 20, c.val);
			recPush(c, now, v);
		}
		const key = c.sel || ALL;
		// Points for another toy go out first, so a batch never mixes toys
		if (c.ptsKey != null && c.ptsKey !== key && c.pts?.length) {
			clearTimeout(c.liveTimer ?? undefined);
			flushLive(member);
		}
		c.ptsKey = key;
		c.playingBy = c.playingBy || new Map();
		c.liveBy = c.liveBy || new Map();
		if (key === ALL) {
			c.playingBy.clear();
			c.liveBy.clear();
		}
		c.playingBy.delete(key);
		c.liveBy.set(key, now);
		if (!c.epoch) c.epoch = now;
		const t = now - c.epoch;
		c.pts = c.pts || [];
		// After a pause, hold the old value until just before the new one, so it isn't stretched over the pause
		if (c.lastT != null && t - c.lastT > 60 && c.val != null) c.pts.push([t - 20, c.val]);
		c.pts.push([t, v]);
		c.val = v;
		c.lastT = t;
		// The first change after a quiet spell goes out at once; after that, at most one batch every PTS_EVERY ms
		if (!c.liveTimer) c.liveTimer = setTimeout(() => flushLive(member), Math.max(0, PTS_EVERY - (now - (c.flushAt || 0))));
	}
	/** @param {number} member */
	function flushLive(member) {
		const c = controlling.get(member);
		if (!c) return;
		c.liveTimer = null;
		if (!c.pts?.length) return;
		const pts = c.pts.splice(0, PTS_MAX);
		c.flushAt = Date.now();
		const st = pts[0][0];
		rcSend(member, { t: "pts", st, p: pts.map(([t, v]) => [t - st, v]), ...(c.ptsKey && c.ptsKey !== ALL ? { toy: c.ptsKey } : {}) });
		// Anything recorded since goes out in the next batch
		if (c.pts.length) c.liveTimer = setTimeout(() => flushLive(member), PTS_EVERY);
	}
	/**
	 * @param {number} member
	 * @param {VLPattern} pat
	 */
	function sendPattern(member, pat) {
		const c = controlling.get(member);
		const clean = cleanPattern(pat);
		if (c?.state !== "granted" || !clean) return;
		if (isBig(clean) && !peerPlaysBig(member)) return ui.toast(`${nameOf(member)} needs Vibe Link ${PROG_VER} or newer for programs and recordings.`);
		outDone(member, c);
		if (!isSelf(member)) logEvent({ dir: "out", who: member, ev: "pat", p: clean, text: `You played ${patternText(clean)}${clean.dur && !isBig(clean) ? ` for ${fmtDur(clean.dur)}` : ""} on ${nameOf(member)}` });
		clearTimeout(c.liveTimer ?? undefined);
		c.liveTimer = null;
		c.pts = [];
		c.lastT = undefined;
		const key = c.sel || ALL;
		c.playingBy = c.playingBy || new Map();
		c.liveBy = c.liveBy || new Map();
		if (key === ALL) {
			c.playingBy.clear();
			c.liveBy.clear();
		}
		c.liveBy.delete(key);
		c.playingBy.set(key, { pat: clean, rnd: seeded(clean.seed), t0: Date.now(), until: clean.dur ? Date.now() + clean.dur : 0 });
		rcSend(member, { t: "pat", p: isSelf(member) ? clean : netPattern(clean), ...(key !== ALL ? { toy: key } : {}) });
		ui.renderSoon();
	}

	// Off ... Max and the game modes: the wearer holds it like a game setting (their own % per level, their own pattern
	// per mode) and sets their worn vibrator to it
	/**
	 * @param {VLControl} c
	 * @param {number} member
	 */
	function rcTakeOver(c, member) {
		outDone(member, c);
		clearTimeout(c.liveTimer ?? undefined);
		c.liveTimer = null;
		c.pts = [];
		c.lastT = undefined;
		const key = c.sel || ALL;
		c.playingBy = c.playingBy || new Map();
		c.liveBy = c.liveBy || new Map();
		if (key === ALL) {
			c.playingBy.clear();
			c.liveBy.clear();
		}
		c.playingBy.delete(key);
		c.liveBy.delete(key);
		return key;
	}
	/**
	 * @param {number} member
	 * @param {number} n -1 (off) .. 3
	 */
	function sendLevel(member, n) {
		const c = controlling.get(member);
		if (c?.state !== "granted") return;
		const key = rcTakeOver(c, member);
		if (!isSelf(member)) logEvent({ dir: "out", who: member, ev: "lvl", text: `You set ${nameOf(member)} to ${LEVEL_NAMES[n]}` });
		c.val = [0, 25, 50, 75, 100][n];
		rcSend(member, { t: "lvl", n, ...(key !== ALL ? { toy: key } : {}) });
		ui.renderSoon();
	}
	/**
	 * @param {number} member
	 * @param {string} mode
	 */
	function sendMode(member, mode) {
		const c = controlling.get(member);
		if (c?.state !== "granted") return;
		const key = rcTakeOver(c, member);
		if (!isSelf(member)) logEvent({ dir: "out", who: member, ev: "mode", text: `You set ${nameOf(member)} to ${mode} mode` });
		rcSend(member, { t: "mode", mode, ...(key !== ALL ? { toy: key } : {}) });
		ui.renderSoon();
	}

	/** @param {number} member */
	function stopLive(member) {
		const c = controlling.get(member);
		if (!c) return;
		outDone(member, c);
		c.playingBy?.clear();
		c.liveBy?.clear();
		clearTimeout(c.liveTimer ?? undefined);
		c.liveTimer = null;
		c.pts = [];
		c.val = 0;
		rcSend(member, { t: "stop" });
	}

	/** @param {number} member */
	function releaseControl(member) {
		stopLive(member);
		if (controlling.get(member)?.state === "granted") rcSend(member, { t: "release" });
		controlling.delete(member);
		ui.renderSoon();
	}

	/** @param {number} ms */
	function fmtDur(ms) {
		const m = Math.round(ms / 60_000);
		if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
		return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
	}

	// Once a second: say hello in each new room, end grants that ran out or whose person left
	function rcTick() {
		const now = Date.now();
		const others = (/** @type {Map<number, unknown>} */ map) => [...map.keys()].filter((m) => !isSelf(m));
		selfAccess(now); // re-renders when "Play on my toys" becomes (un)available
		addChatFilter(); // in case the game's chat wasn't set up yet when we loaded
		if (!rcInRoom()) {
			if (helloRoom || others(grants).length || others(controlling).length || peers.size) {
				helloRoom = null;
				for (const m of others(grants)) {
					loseContact(m);
					grants.delete(m);
				}
				for (const m of others(controlling)) controlling.delete(m);
				peers.clear();
				for (const a of asks.values()) clearTimeout(a.timer);
				asks.clear();
				ui.renderSoon();
			}
			rcSelfTick(now);
			return;
		}
		const room = ChatRoomData?.Name || "";
		const accepts = acceptsRemote();
		if (room !== helloRoom) {
			helloRoom = room;
			peers.clear();
			for (const m of others(controlling)) controlling.delete(m);
			for (const m of others(grants)) {
				loseContact(m);
				grants.delete(m);
			}
			lastAccepts = accepts;
			rcSend(null, { t: "hello", ver: MOD_INFO.version, accepts, ask: true });
		} else if (accepts !== lastAccepts) {
			// Turned on/off, or a lockout started/ended: tell the room without asking for replies
			lastAccepts = accepts;
			rcSend(null, { t: "hello", ver: MOD_INFO.version, accepts, ask: false });
		}
		let changed = false;
		for (const [m, g] of [...grants]) {
			if (isSelf(m)) continue;
			if (!charOf(m)) {
				loseContact(m);
				grants.delete(m);
				changed = true;
			}
			else if (g.until && now > g.until) {
				revokeControl(m, "Time's up");
				changed = true;
			}
			// The game decides who may use items on you: if that changes mid-session (you blacklist them, change your
			// item permissions), control ends at once rather than at the next request
			else if (!gameAllows(charOf(m))) {
				revokeControl(m, "The game no longer lets you use items on them");
				changed = true;
			}
		}
		for (const [m, c] of [...controlling]) {
			if (isSelf(m)) continue;
			if (!charOf(m)) {
				controlling.delete(m);
				changed = true;
			}
			else if (c.state === "granted" && c.until && now > c.until) {
				outDone(m, c);
				controlling.set(m, { state: "revoked", reason: "Time's up", at: now });
				changed = true;
			}
		}
		// Heartbeat out to everyone whose toy we control
		for (const [m, c] of controlling) if (c.state === "granted" && !isSelf(m) && now - (lastSentTo.get(m) || 0) >= HB_EVERY) rcSend(m, { t: "hb" });
		// Wearer: a controller we haven't heard from loses control, then the grant
		for (const m of [...grants.keys()]) {
			if (isSelf(m)) continue;
			const quiet = now - (lastHeard.get(m) || grants.get(m)?.at || now);
			if (quiet > HB_DROP) {
				// Their grant goes; what they set keeps playing until you stop it
				loseContact(m);
				grants.delete(m);
				changed = true;
			} else if (quiet > HB_LOST) loseContact(m);
		}
		// Controller: the wearer has gone quiet
		for (const [m, c] of controlling) {
			if (c.state !== "granted" || isSelf(m)) continue;
			const quiet = now - Math.max(lastHeard.get(m) || 0, c.at || 0);
			if (quiet > HB_LOST) {
				outDone(m, c);
				controlling.set(m, { state: "lost", reason: "Lost contact", at: now });
				ui.toast(`Lost contact with ${nameOf(m)}.`);
				changed = true;
			}
		}
		for (const m of [...peers.keys()]) if (!charOf(m)) {
			peers.delete(m);
			changed = true;
		}
		for (const m of [...asks.keys()]) if (!charOf(m)) {
			answerAsk(m, "decline", "Left");
			changed = true;
		}
		rcSessionTick(now);
		// Countdowns and live bars update in place (ui.tick); only re-render when something changed
		if (changed) ui.renderSoon();
	}

	// The parts of the once-a-second work that apply to whoever is driving your toys, yourself included (also outside rooms)
	/** @param {number} now */
	function rcSelfTick(now) {
		if (remoteCtl && (isSelf(remoteCtl.by) || remoteCtl.lost)) rcSessionTick(now);
	}
	/** @param {number} now */
	function rcSessionTick(now) {
		if (remoteCtl && isSelf(remoteCtl.by) && !selfAccess(now).ok) {
			ui.toast(`${selfAccess(now).why}, so your toys follow the game again.`);
			endSelf();
		}
		// Timed patterns end by themselves, per toy
		if (remoteCtl) {
			for (const [k, lane] of [...remoteCtl.lanes]) {
				if (!lane.pat || !lane.until || now <= lane.until) continue;
				remoteCtl.lanes.delete(k);
				if (!remoteToys().some((t) => laneFor(t))) {
					endRemote("The pattern finished");
					break;
				}
				rcSend(remoteCtl.by, { t: "note", toy: k, text: `The pattern on ${toyName(k)} finished` });
				ui.renderSoon();
			}
		}
		// The game changed the level (e.g. someone used the in-game remote): the game takes over again
		if (remoteCtl && ((!grants.has(remoteCtl.by) && !remoteCtl.lost) || local.paused)) endRemote("", false);
		else if (remoteCtl && gameSig() !== remoteCtl.gameSig) endRemote("The vibrator was changed in the game, so the game is in control again", true, false);
		else if (remoteCtl) rcMirror(now);
		// Tell each controller what the toy is really doing
		if (grants.size && now - statusAt >= 1000) {
			statusAt = now;
			const driven = remoteToys();
			for (const m of grants.keys()) {
				const mine = remoteCtl?.by === m;
				// Per toy: name, key, real strength, whether it can be controlled, and what it's doing (pattern / live / game)
				const list = shownToys().filter((t) => !t.virtual || isSelf(m)).map((t) => {
					const lane = mine ? laneFor(t) : null;
					/** @type {Record<string, any>} */
					const row = { n: t.display, k: t.key, pct: Math.round(t.value * 100), e: driven.includes(t) ? 1 : 0, m: !lane ? "game" : lane.lvl != null ? "lvl" : lane.mode ? "mode" : lane.pat ? "pat" : "live" };
					if (lane?.lvl != null) row.lv = lane.lvl;
					if (lane?.mode) row.md = lane.mode;
					if (lane?.pat && laneDrives(t, lane)) Object.assign(row, isBig(lane.pat) ? { pl: patternText(lane.pat) } : { pat: lane.pat }, { el: now - (lane.t0 ?? now), left: lane.until ? lane.until - now : 0 });
					return row;
				});
				// Older controllers read the top-level active/pat/left
				const any = mine && remoteCtl ? remoteCtl.lanes.get(ALL) || [...remoteCtl.lanes.values()][0] : null;
				rcSend(m, { t: "status", toys: list, active: mine && !!remoteCtl?.lanes.size, ...(any?.pat ? { ...(isBig(any.pat) ? { pl: patternText(any.pat) } : { pat: any.pat }), left: any.until ? any.until - now : 0 } : {}) });
			}
		}
	}

	// Saying the safe word in chat (talk, whisper or emote) works like 🛑
	/** @param {unknown} text */
	function hasSafeWord(text) {
		const w = settings.remote.safeWord;
		if (!w || typeof text !== "string") return false;
		const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(text);
	}

	if (mod) {
		mod.hookFunction("ChatRoomMessage", 5, (args, next) => {
			rcReceive(args[0]);
			return next(args);
		});
		mod.hookFunction("ServerSend", 5, (args, next) => {
			try {
				const [ev, d] = /** @type {[string, any]} */ (args);
				if (ev === "ChatRoomChat" && d && d.Type !== "Hidden" && hasSafeWord(d.Content)) setTimeout(() => (local.paused ? rcOnStop() : stopNow()));
			} catch {
				// not critical: carries on without it
			}
			return next(args);
		});
	}

	// ---------- UI ----------

	const ui = (() => {
		/** @type {BCDockHandle | null} */
		let panel = null; // our panel in the shared dock (bc-dock.js)
		/** @type {HTMLElement | null} */
		let root = null; // the panel's body element
		let renderQueued = false;
		// A render replaces the panel's buttons. While a pattern runs it renders every tick, so a press could land on
		// one button and the release on its replacement, and the click never fires. Hold renders while the pointer is
		// down on the panel, and catch up after the click.
		let pointerHeld = false;
		let renderHeld = false;
		const holdRenders = () => (pointerHeld = true);
		const releaseRenders = () => {
			if (!pointerHeld) return;
			pointerHeld = false;
			if (renderHeld) {
				renderHeld = false;
				setTimeout(render, 0); // after the click handler has run
			}
		};
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let toastTimer;
		let recordingHotkey = false;
		let presetSel = ""; // preset picked in the panel, kept across re-renders

		const CSS = `
[data-id="vibe-link"] .bcd-actions button.stop{background:#8b1e2b;border-color:#b33}
[data-id="vibe-link"] .bcd-actions button.go{background:#2c6b3a;border-color:#3a8}
#vl-body{font-size:12px}
/* The game styles every <canvas> as position:absolute; ours must stay in the panel's flow, or the banner's curve
   floats up over the header and covers the 🛑 button */
#vl-body canvas{position:static!important;left:auto!important;top:auto!important;pointer-events:none}
#vl-body .vl-tabs{display:flex;gap:3px;margin:0 0 4px}
#vl-body .vl-tabs button{flex:1}
#vl-body .vl-tabs button.act{background:var(--bcd-line,#6b4f85);border-color:var(--bcd-hi,#9a7bb8)}
#vl-body h3{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--bcd-muted,#a99fc0);margin:7px 0 2px}
#vl-body .row{display:flex;align-items:center;gap:4px;margin:3px 0;flex-wrap:wrap}
#vl-body .row select,#vl-body .row input[type=text]{flex:1;min-width:0}
#vl-body .hint{color:#999;font-size:11px;margin:2px 0}
#vl-body .vl-insp-sum{margin:3px 0 4px;font-size:11px}
#vl-body .vl-insp{margin:3px 0;padding:3px 5px;border:1px solid var(--bcd-line-soft,#352f42);border-radius:5px;font-size:11px}
#vl-body .vl-insp.on{border-color:var(--bcd-hi,#9a5cc8)}
#vl-body .vl-insp-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vl-body .warn{color:#fc6;font-size:11px;margin:4px 0;padding:4px 6px;border:1px solid #a84;border-radius:6px;background:#3a2c18}
#vl-body .err{color:#f99;font-size:12px}
#vl-body input[type=text],#vl-body input[type=number],#vl-body select{font:inherit;color:#eee;background:var(--bcd-ctl,#2a2633);border:1px solid var(--bcd-ctl-line,#5a5070);border-radius:5px;padding:2px 4px}
#vl-body input[type=number]{width:50px}
#vl-body .toy{border:1px solid var(--bcd-ctl-line,#4a4458);border-radius:6px;padding:3px 6px;margin:4px 0}
#vl-body .toy .row{margin:2px 0}
#vl-body .toy .nm{font-weight:600;flex:1}
#vl-body .vl-sec{display:flex;align-items:center;gap:6px;width:100%;margin:6px 0 0;padding:4px 6px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:var(--bcd-ctl,#25212e);border:1px solid var(--bcd-line-soft,#352f42);border-radius:4px;color:var(--bcd-text,#d8cde6)}
#vl-body .vl-sec.open{border-bottom-left-radius:0;border-bottom-right-radius:0;background:var(--bcd-tab-act,#2c2638)}
#vl-body .vl-sec-a{width:10px;color:var(--bcd-hi,#b08ad0)}
#vl-body .vl-sec-body{padding:2px 6px 6px;border:1px solid var(--bcd-line-soft,#352f42);border-top:0;border-radius:0 0 4px 4px}
#vl-body .vl-wave{position:relative;margin:3px 0;background:var(--bcd-ctl,#1d1a24);border:1px solid var(--bcd-line-soft,#2f2a3a);border-radius:4px;overflow:hidden}
#vl-body .vl-wave canvas{display:block;width:100%;height:34px}
#vl-body .vl-wave-pct{position:absolute;top:1px;left:4px;font-size:10px;color:#ddd;text-shadow:0 0 3px #000;pointer-events:none}
#vl-body .bar{height:6px;background:var(--bcd-ctl,#2a2633);border-radius:3px;overflow:hidden;flex:1;min-width:40px}
#vl-body .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--bcd-line,#a050d0),var(--bcd-glow,#e070a0))}
#vl-body .lv{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;text-align:center;font-size:10px}
#vl-body .lv input{width:100%;box-sizing:border-box;padding:2px 0;text-align:center}
#vl-body .vl-live{flex:1;min-width:0;accent-color:var(--bcd-accent,#c070d0);height:22px}
#vl-body .vl-pct{width:34px;text-align:right;font-variant-numeric:tabular-nums}
#vl-body .vl-quick button{flex:1;padding:1px 0}
#vl-body .vl-mode{margin-bottom:4px}
#vl-body .vl-mode .row{margin:2px 0;flex-wrap:nowrap}
#vl-body .vl-mode .vl-mk{flex:0 0 4.6em;font-size:11px}
#vl-body .vl-mode .vl-ind{flex:0 0 1.2em}
#vl-body .vl-mode .vl-num{width:2.9em;flex:0 0 auto;padding:1px 2px}
#vl-body .vl-mode select{flex:1 1 auto;min-width:0}
#vl-body .vl-quick button.stop{background:#8b1e2b;border-color:#b33}
#vl-body .vl-pat{margin-top:4px;padding-top:3px;border-top:1px solid var(--bcd-line-soft,#3a2e47)}
#vl-body .vl-now{margin:0 0 4px;padding:4px 6px;border-radius:5px;background:var(--bcd-ctl,#24202c);color:#aaa;font-size:11px}
#vl-body .vl-now.on{background:var(--bcd-tab-act,#3b2350);color:#fff;border:1px solid var(--bcd-hi,#9a5cc8);box-shadow:0 0 8px color-mix(in srgb,var(--bcd-hi,var(--bcd-hi,#9a5cc8)) 35%,transparent)}
#vl-body .vl-now.live{background:#203a2a;color:#cfe;border:1px solid #3a8}
#vl-body .vl-now-t{font-weight:600}
#vl-body .vl-now-toys{font-size:11px;color:#ddd;margin-top:2px}
#vl-body .vl-now-toys:empty{display:none}
#vl-body .vl-wide{width:100%}
#vl-body .vl-now-g{width:100%;height:26px;display:block;margin-top:3px}
#vl-body .vl-now-bar{height:3px;background:#0004;border-radius:2px;margin-top:3px;overflow:hidden}
#vl-body .vl-now-bar i{display:block;height:100%;width:0;background:var(--bcd-accent,#e7b6ff)}
#vl-body .vl-sub{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--bcd-muted,#a99fc0)}
#vl-body .vl-k{width:30px;color:#bbb;font-size:11px}
#vl-body .vl-prev{width:100%;height:36px;background:var(--bcd-ctl,#1e1a26);border-radius:4px;display:block;margin:2px 0}
#vl-body button.go{background:#2c6b3a;border-color:#3a8}
#vl-body .vl-list{margin:2px 0}
#vl-body .vl-li{display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid var(--bcd-line-soft,#2f2a3a)}
#vl-body .vl-li:last-child{border-bottom:0}
#vl-body .vl-li-t{flex:1;min-width:0;font-size:11px;overflow-wrap:anywhere}
#vl-body .vl-li-t small{display:block;color:#999;font-size:10px}
#vl-body .vl-li button{padding:0 5px;flex:0 0 auto}
#vl-body .vl-hist{max-height:260px;overflow-y:auto}
#vl-toast{position:fixed;z-index:10001;left:50%;bottom:20px;transform:translateX(-50%);background:var(--bcd-ctl,#2a2633);color:#eee;border:1px solid var(--bcd-ctl-line,#5a5070);border-radius:8px;padding:6px 12px;font:13px system-ui,sans-serif;pointer-events:none}
`;

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

		const hotkeyText = (/** @type {VLSettings["hotkey"]} */ k) => [k.ctrl && "Ctrl", k.alt && "Alt", k.shift && "Shift", k.code.replace(/^Key|^Digit/, "")].filter(Boolean).join("+");

		function mount() {
			if (panel) return;
			if (!window.BCDock) return console.warn(TAG, "bc-dock.js isn't loaded (the Nightstand script brings it), so there's no panel");
			document.head.append(h("style", { id: "vl-style" }, CSS));
			panel = BCDock.add({ id: "vibe-link", title: "Vibe Link", icon: "〰", order: 30, version: MOD_INFO.version, width: 230, minWidth: 190, maxWidth: 300, alignStart: true, onToggle: () => render() });
			root = panel.body || null;
			if (!root) return;
			root.id = "vl-body";
			for (const el of [root, panel.actions]) el?.addEventListener("pointerdown", holdRenders, true);
			window.addEventListener("pointerup", releaseRenders, true);
			window.addEventListener("pointercancel", releaseRenders, true);
			render();
		}

		function unmount() {
			window.BCDock?.setTitleMark?.("vibe-link", null);
			panel?.remove();
			window.removeEventListener("pointerup", releaseRenders, true);
			window.removeEventListener("pointercancel", releaseRenders, true);
			pointerHeld = renderHeld = false;
			document.getElementById("vl-style")?.remove();
			document.getElementById("vl-toast")?.remove();
			panel = root = null;
		}

		function open() {
			panel?.open();
			render();
		}

		// 〰 in the browser tab's title while connected to Intiface (dock 13 and later)
		const titleMark = () => window.BCDock?.setTitleMark?.("vibe-link", loggedIn() && conn === "connected" ? "〰" : null);
		function statusDot() {
			if (local.paused) return "bad";
			if (conn === "connected") return toys.size ? "on" : "wait";
			if (virtualOn() && conn !== "connecting" && conn !== "busy") return "on";
			if (conn === "connecting" || conn === "busy") return "wait";
			return conn === "failed" ? "bad" : "";
		}

		// "▶ Robin: Wave" for everyone you're driving (patterns by name, otherwise live)
		function drivingText() {
			const out = [];
			for (const [m, c] of controlling) {
				if (c.state !== "granted") continue;
				const pats = [...(c.playingBy?.values() || [])].map((p) => patLabel(p.pat));
				if (isSelf(m)) continue; // shown as "🎮 You" already
				if (pats.length) out.push(`▶ ${nameOf(m)}: ${pats.join(", ")}`);
				else if (c.liveBy?.size) out.push(`▶ ${nameOf(m)}: live ${c.val || 0}%`);
			}
			return out;
		}

		function summary() {
			// What you're playing on others shows first, even without a toy of your own
			const drivingOnly = drivingText();
			const own = local.paused ? "Stopped" : conn === "connecting" ? "Connecting…" : conn === "busy" ? busyText() : conn !== "connected" ? (conn === "failed" ? "Intiface not reachable" : "Not connected") : null;
			if (own && (local.paused || !virtualOn())) return drivingOnly.length ? `${drivingOnly.join(" · ")} · ${own}` : own;
			if (!toys.size) return drivingOnly.length ? drivingOnly.join(" · ") : scanning ? "Looking for toys…" : "No toys";
			const pcts = shownToys().map((t) => `${t.display} ${Math.round(t.value * 100)}%`).join(" · ") || "No toys shown";
			const mine = remoteCtl && (grants.has(remoteCtl.by) || remoteCtl.lost) ? `🎮 ${isSelf(remoteCtl.by) ? "You" : nameOf(remoteCtl.by)} · ${pcts}` : pcts;
			const driving = drivingOnly;
			return driving.length ? `${driving.join(" · ")} · ${mine}` : mine;
		}

		function renderSoon() {
			if (renderQueued) return;
			renderQueued = true;
			setTimeout(() => {
				renderQueued = false;
				render();
			}, 0);
		}

		function render() {
			if (!panel) return;
			if (pointerHeld) return void (renderHeld = true);
			panel.setVisible(loggedIn());
			panel.setDot(statusDot() || "none");
			titleMark();
			panel.setSummary(summary());
			panel.actions?.replaceChildren(
				...[
					!local.paused && conn === "connected" && !toys.size && h("button", { class: "bcd-ico", title: "Look for toys (turn the toy on first)", onclick: startScan, disabled: scanning }, "🔍"),
					local.paused
						? h("button", { class: "go", title: "Let toys follow the game again", onclick: resume }, "▶ Resume")
						: h("button", { class: "stop", title: `Stop all toys now (${hotkeyText(settings.hotkey)})`, onpointerdown: (/** @type {PointerEvent} */ e) => e.button === 0 && stopNow(), onclick: (/** @type {MouseEvent} */ e) => e.detail === 0 && stopNow() }, "🛑"),
				].filter(Boolean)
			);
			if (!root) return;
			if (!panel.isOpen()) return root.replaceChildren();
			// Keep focus/caret if the user is typing in one of our inputs
			const active = document.activeElement;
			const focusId = active instanceof HTMLElement && root.contains(active) ? active.dataset.id : null;
			root.replaceChildren(...renderBody());
			if (focusId) /** @type {HTMLElement | null} */ (root.querySelector(`[data-id="${focusId}"]`))?.focus();
		}

		// A settings section that folds away; which ones are open is remembered (only Connection starts open)
		/**
		 * @param {HTMLElement[]} out
		 * @param {string} key
		 * @param {string} title
		 * @param {(o: HTMLElement[]) => void} fill
		 */
		function section(out, key, title, fill) {
			const isOpen = local.secOpen?.[key] ?? key === "conn";
			out.push(
				h(
					"button",
					{
						class: `vl-sec${isOpen ? " open" : ""}`,
						"data-sec": key,
						"aria-expanded": isOpen ? "true" : "false",
						onclick: () => {
							local.secOpen = { ...(local.secOpen || {}), [key]: !isOpen };
							saveLocal();
							render();
						},
					},
					h("span", { class: "vl-sec-a" }, isOpen ? "▾" : "▸"),
					title
				)
			);
			if (isOpen) {
				/** @type {HTMLElement[]} */
				const inner = [];
				fill(inner);
				out.push(h("div", { class: "vl-sec-body" }, inner));
			}
		}

		// Inspect tab: pick yourself or someone in the room, and see their vibrators (mode, strength), anything
		// edging, denying or ruining, crafted properties and locks. Read only: it sends nothing and changes nothing.
		/** @type {number | null} */
		let inspectWho = null; // member number; null: you
		const inspectChar = () => (inspectWho == null || isSelf(inspectWho) ? (loggedIn() ? Player : null) : charOf(inspectWho));
		const arousalText = (/** @type {Character} */ C) => {
			const a = C?.ArousalSettings;
			if (!a || a.Active === "Inactive") return "Arousal off";
			return `Arousal ${Math.round(Number(a.Progress) || 0)}%`;
		};
		/** @param {HTMLElement[]} out */
		function secInspect(out) {
			const others = rcInRoom() && typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter) ? ChatRoomCharacter.filter((c) => c && !isSelf(c.MemberNumber)) : [];
			if (inspectWho != null && !isSelf(inspectWho) && !charOf(inspectWho)) inspectWho = null;
			out.push(
				h(
					"label",
					{ class: "row" },
					"Who ",
					h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((inspectWho = e.target.value ? Number(e.target.value) : null), render()) },
						h("option", { value: "", selected: inspectWho == null }, "You"),
						others.map((c) => h("option", { value: String(c.MemberNumber), selected: inspectWho === c.MemberNumber }, `${nameOf(c.MemberNumber)} (#${c.MemberNumber})`))
					)
				)
			);
			const C = inspectChar();
			if (!C) return out.push(h("div", { class: "hint" }, "Not logged in."));
			const fx = (C.Effect || []).filter((e) => EDGE_FX.includes(e));
			// The game counts you as edged only if every vibrator on a zone you can orgasm from edges (IsEdged); others: the effect
			const edgedNow = C === Player && typeof Player.IsEdged === "function" ? Player.IsEdged() : fx.includes("Edged");
			const held = [fx.includes("DenialMode") && !fx.includes("RuinOrgasms") && "⛔ Denied", edgedNow && "🫠 Edged", fx.includes("RuinOrgasms") && "💔 Ruins orgasms"].filter(Boolean);
			out.push(
				h(
					"div",
					{ class: "vl-insp-sum" },
					h("span", { "data-insp-arousal": "" }, arousalText(C)),
					held.length ? ` · ${held.join(" · ")}` : fx.includes("Edged") && C === Player ? " · 🫠 partly edged (not every vibrator edges)" : " · free to finish"
				)
			);
			const items = inspectItems(C);
			if (!items.length) out.push(h("div", { class: "hint" }, "No vibrators or edging, denial or ruin items."));
			for (const it of items) {
				const lvl = it.level == null ? "" : LEVEL_NAMES[it.level + 1];
				const modeLine = !it.vibrates ? "" : it.mode && !LEVEL_NAMES.includes(it.mode) && it.mode !== "Maximum" ? `${it.mode} · now ${lvl || "?"}` : lvl || it.mode || "";
				out.push(
					h(
						"div",
						{ class: `vl-insp${(it.level ?? -1) > -1 ? " on" : ""}` },
						h("div", { class: "vl-insp-t" }, h("b", {}, it.slot), " ", it.craftName ? `“${it.craftName}” (${it.name})` : it.name),
						modeLine ? h("div", { title: MODE_TEXT[it.mode] || "" }, `〰 ${modeLine}`) : null,
						it.fx.length || it.craftFx ? h("div", {}, [...it.fx.map((e) => FX_TEXT[e]), it.craftFx && `✂ crafted ${it.craftFx}`].filter(Boolean).join(" · ")) : null,
						it.belt
						? h(
							"div",
							{ title: "The belt's own record while worn: orgasms, and orgasm prompts since the last one that didn't end in one (resisted or ruined)" },
							`📋 Belt: 💦 ${it.belt.orgasms} · held back ${it.belt.held} · ${it.belt.last ? `last orgasm ${agoText(Date.now() - it.belt.last)} ago` : it.belt.worn ? `none since it went on ${agoText(Date.now() - it.belt.worn)} ago` : "no orgasm yet"}`
						)
						: null,
					it.lock ? h("div", { class: "hint" }, `${it.lock}${it.lockBy ? ` · by ${nameOf(it.lockBy)}` : ""}`) : null
					)
				);
			}
			out.push(h("div", { class: "hint" }, "Read only: what the game shows everyone. Nothing is sent."));
		}

		// Two views keep the panel small: Toys (what you use while playing) and Settings (everything else)
		let view = "toys";
		function renderBody() {
			const out = [
				h(
					"div",
					{ class: "vl-tabs" },
					h("button", { class: view === "toys" ? "act" : "", onclick: () => ((view = "toys"), render()) }, "Toys"),
					h("button", { class: view === "remote" ? "act" : "", onclick: () => ((view = "remote"), render()) }, asks.size ? `Remote (${asks.size})` : "Remote"),
					h("button", { class: view === "inspect" ? "act" : "", title: "What's buzzing or holding someone at the edge right now (works without Intiface)", onclick: () => ((view = "inspect"), render()) }, "Inspect"),
					h("button", { class: view === "settings" ? "act" : "", onclick: () => ((view = "settings"), render()) }, "⚙")
				),
			];
			if (view === "remote") {
				secRemote(out);
			} else if (view === "inspect") {
				secInspect(out);
			} else if (view === "settings") {
				section(out, "conn", "Connection", (/** @type {HTMLElement[]} */ o) => (secConnection(o), secRemember(o)));
				section(out, "toys", "Toys", secToyConfig);
				section(out, "safety", "Safety", secSafety);
				section(out, "modes", "Game Modes", secGameModes);
				section(out, "ramp", "Ramp Config", secRamp);
				section(out, "presets", "Presets", secPresets);
			} else {
				secStatus(out);
				secToys(out);
				secPlayMine(out);
				secPresetQuick(out);
			}
			return out;
		}


		// Live controls for someone who gave you control: a strength slider, quick levels, stop, and their real strength
		// What's happening on their toy, kept up to date by ui.tick: a highlighted "Now playing" with the pattern's curve,
		// a moving playhead and the time left; or "Live"; or idle
		/** @param {number} m */
		function nowPlaying(m) {
			return h(
				"div",
				{ class: "vl-now", "data-rc-now": m },
				h("div", { class: "vl-now-t" }, ""),
				h("canvas", { class: "vl-now-g", width: 200, height: 26 }),
				h("div", { class: "vl-now-bar" }, h("i", {})),
				h("div", { class: "vl-now-toys" }, "")
			);
		}
		/**
		 * @param {HTMLElement} el
		 * @param {VLControl} c
		 * @param {VLStatus | undefined} st
		 * @param {number} now
		 */
		function drawNow(el, c, st, now) {
			const title = /** @type {HTMLElement} */ (el.querySelector(".vl-now-t"));
			const g = /** @type {HTMLCanvasElement} */ (el.querySelector(".vl-now-g"));
			const bar = /** @type {HTMLElement} */ (el.querySelector(".vl-now-bar i"));
			const barBox = /** @type {HTMLElement} */ (bar.parentElement);
			const lines = /** @type {HTMLElement} */ (el.querySelector(".vl-now-toys"));
			const sel = c.sel || ALL;
			c.playingBy = c.playingBy || new Map();
			c.liveBy = c.liveBy || new Map();
			const fresh = st && now - st.at < 2500;
			const toysNow = (st?.toys || []).filter((t) => t.e);
			// The wearer says a toy isn't playing any more (finished, or stopped there)
			for (const [k, pl] of [...c.playingBy]) {
				const rows = k === ALL ? toysNow : toysNow.filter((t) => t.k === k);
				if ((fresh && rows.length && rows.every((t) => t.m !== "pat") && now - pl.t0 > 3000) || (pl.until && now > pl.until + 1500)) c.playingBy.delete(k);
			}
			/** @type {(VLPlaying & { label?: string }) | undefined} */
			let p = c.playingBy.get(sel) || (sel !== ALL ? c.playingBy.get(ALL) : [...c.playingBy.values()][0]);
			// A level or mode they hold (from their status)
			const selRows = sel === ALL ? toysNow : toysNow.filter((t) => t.k === sel);
			const held = !p && fresh ? selRows.find((t) => t.m === "lvl" || t.m === "mode") : null;
			if (st && held?.m === "mode" && held.pat) p = { pat: held.pat, rnd: seeded(held.pat.seed), t0: st.at - held.el, until: 0, label: `${held.md} mode` };
			const live = !p && c.liveBy.size && fresh && toysNow.some((t) => t.m === "live");
			el.className = `vl-now${p || held ? " on" : live ? " live" : ""}`;
			if (p) {
				const left = p.until ? Math.max(0, p.until - now) : 0;
				title.textContent = p.label ? `▶ ${p.label} · ${patternText(p.pat)}` : `▶ Playing ${patternText(p.pat)}${p.until ? ` · ${fmtDur(left)} left` : " · until stopped"}`;
				barBox.style.display = p.until ? "" : "none";
				if (p.until) bar.style.width = `${100 - (100 * left) / (p.until - p.t0)}%`;
				// two cycles of the curve, with the playhead where it is now
				g.style.display = "";
				const ctx = g.getContext("2d");
				if (!ctx) return;
				const W = g.width;
				const H = g.height;
				const span = p.pat.period * 2;
				const t = now - p.t0;
				const start = Math.floor(t / p.pat.period) * p.pat.period; // window starts at the current cycle
				ctx.clearRect(0, 0, W, H);
				ctx.strokeStyle = tc("accent", "#e7b6ff");
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				for (let x = 0; x <= W; x++) {
					const y = H - 2 - (patternAt(p.pat, start + (x / W) * span, p.rnd) / 100) * (H - 4);
					if (x) ctx.lineTo(x, y);
					else ctx.moveTo(x, y);
				}
				ctx.stroke();
				const px = ((t - start) / span) * W;
				const py = H - 2 - (patternAt(p.pat, t, p.rnd) / 100) * (H - 4);
				ctx.fillStyle = "#fff";
				ctx.fillRect(px - 0.5, 0, 1, H);
				ctx.beginPath();
				ctx.arc(px, py, 3, 0, 2 * Math.PI);
				ctx.fill();
			} else {
				g.style.display = "none";
				barBox.style.display = "none";
				title.textContent = held ? (held.m === "lvl" ? `■ Holding ${LEVEL_NAMES[held.lv ?? 0]}` : `▶ ${held.md} mode · their game drives it`) : live ? `● Live ${c.val || 0}%` : "Idle · their game is in control";
			}
			// One line per toy when they have more than one
			const txt =
				toysNow.length > 1
					? toysNow.map((t) => `${t.n} ${t.pct}%${t.m === "lvl" ? ` ■ ${LEVEL_NAMES[t.lv ?? 0]}` : t.m === "mode" ? ` ▶ ${t.md}` : t.m === "pat" && (t.pat || t.pl) ? ` ▶ ${t.pat ? patLabel(t.pat) : t.pl}` : t.m === "live" ? " ● live" : ""}`).join(" · ")
					: "";
			if (lines.textContent !== txt) lines.textContent = txt;
		}

		// The toys a controller can pick: for someone else, from their status; for yourself, straight from your own toys
		// (only the ones the game lets you play), so the list is there before anything has played
		/**
		 * @param {number} m
		 * @param {VLControl} c
		 * @returns {VLStatusToy[]}
		 */
		function pickerToys(m, c) {
			if (isSelf(m)) {
				const ok = selfAccess().slots;
				return remoteToys()
					.filter((t) => ok.has(settings.links[t.key]))
					.map((t) => /** @type {VLStatusToy} */ ({ k: t.key, n: t.display, e: true, pct: Math.round(t.value * 100), m: "game", lv: null, md: null, el: 0, pat: null, pl: null, left: 0 }));
			}
			return (c.status?.toys || []).filter((t) => t.e && t.k);
		}
		// Which toy the slider and patterns go to (only shown when they have more than one); options follow their status
		/**
		 * @param {number} m
		 * @param {VLControl} c
		 */
		function toyPicker(m, c) {
			const sel = h("select", {
				"data-id": `rc-toy-${m}`,
				"data-rc-toys": m,
				title: "Which of their toys the slider and patterns control",
				onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => {
					c.sel = e.target.value;
					e.target.blur();
				},
			});
			fillToyPicker(sel, c, m);
			return h("div", { class: "row", "data-rc-toyrow": m, style: pickerToys(m, c).length > 1 ? "" : "display:none" }, h("span", { class: "vl-k" }, "Toy"), sel);
		}
		/**
		 * @param {HTMLSelectElement} sel
		 * @param {VLControl} c
		 * @param {number} m
		 */
		function fillToyPicker(sel, c, m) {
			const list = pickerToys(m, c);
			const sig = list.map((t) => t.k).join("|");
			if (sel.dataset.sig === sig) {
				if (sel.value !== (c.sel || ALL)) sel.value = c.sel || ALL;
				return;
			}
			sel.dataset.sig = sig;
			if (c.sel && c.sel !== ALL && !list.some((t) => t.k === c.sel)) c.sel = ALL;
			sel.replaceChildren(h("option", { value: ALL, selected: !c.sel || c.sel === ALL }, "All toys"), ...list.map((t) => h("option", { value: t.k, selected: c.sel === t.k }, t.n)));
			const row = /** @type {HTMLElement | null} */ (sel.closest("[data-rc-toyrow]"));
			if (row) row.style.display = list.length > 1 ? "" : "none";
		}

		/**
		 * @param {number} m
		 * @param {VLControl} c
		 */
		function liveControls(m, c) {
			const pct = h("span", { class: "vl-pct" }, `${c.val || 0}%`);
			const slider = h("input", {
				type: "range",
				min: 0,
				max: 100,
				step: 1,
				value: c.val || 0,
				"data-id": `rc-live-${m}`,
				class: "vl-live",
				title: "Their strength (scaled by their own max strength)",
				oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
					pct.textContent = `${e.target.value}%`;
					sendLive(m, Number(e.target.value));
				},
			});
			const setLevel = (/** @type {number} */ i) => {
				slider.value = String([0, 25, 50, 75, 100][i]);
				pct.textContent = LEVEL_NAMES[i];
				sendLevel(m, i);
			};
			return h(
				"div",
				{ class: "toy" },
				nowPlaying(m),
				toyPicker(m, c),
				h("div", { class: "row" }, slider, pct),
				h(
					"div",
					{ class: "row vl-quick" },
					LEVEL_NAMES.map((n, i) => h("button", { title: `Hold ${n}, like the game level (their own strength for it; their worn vibrator is set to ${n})`, onclick: () => setLevel(i) }, n === "Medium" ? "Med" : n)),
					h("button", { class: "stop", title: "Stop all their toys and hand them back to the game", onclick: () => ((slider.value = "0"), (pct.textContent = "0%"), stopLive(m)) }, "Stop")
				),
				h(
					"div",
					{ class: "row vl-quick" },
					VIBE_MODES.map((md) => h("button", { title: `${md} mode, like the game's (plays the pattern they chose for it; their worn vibrator is set to ${md})`, onclick: () => ((pct.textContent = md), sendMode(m, md)) }, md))
				),
				h("div", { class: "hint", "data-rc-status": m }, "Waiting for their toy…"),
				patternControls(m, c)
			);
		}

		// Pattern picker: shape, low/high, speed, how long, with a preview of the curve
		/** @type {[number, string][]} */
		const PERIODS = [[500, "0.5 s"], [1000, "1 s"], [2000, "2 s"], [3000, "3 s"], [5000, "5 s"], [10000, "10 s"], [20000, "20 s"]];
		/** @type {[number, string][]} */
		const DURATIONS = [[0, "until stopped"], [15000, "15 s"], [30000, "30 s"], [60000, "1 min"], [120000, "2 min"], [300000, "5 min"], [600000, "10 min"]];
		// A fresh random seed (each step of a program its own), so random shapes differ each time they're played
		/**
		 * @template {VLPattern} P
		 * @param {P} p
		 * @returns {P}
		 */
		const reseed = (p) => (p.type === "prog" ? { ...p, steps: p.steps.map(reseed) } : { ...p, seed: (Math.random() * 2 ** 31) | 0 });
		// A pattern's curve on a canvas, the first `span` ms of it
		/**
		 * @param {HTMLCanvasElement} cv
		 * @param {VLPattern} p
		 * @param {number} span ms
		 */
		function drawPat(cv, p, span) {
			const ctx = cv.getContext("2d");
			if (!ctx) return;
			const W = cv.width;
			const H = cv.height;
			ctx.clearRect(0, 0, W, H);
			ctx.strokeStyle = tc("accent", "#c070d0");
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			const rnd = seeded(p.seed);
			for (let x = 0; x <= W; x++) {
				const y = H - 2 - (patternAt(p, (x / W) * span, rnd) / 100) * (H - 4);
				if (x) ctx.lineTo(x, y);
				else ctx.moveTo(x, y);
			}
			ctx.stroke();
		}
		// Plays a saved or remembered pattern on your own toys ("Play on my toys"), where the game lets you
		/** @param {VLPattern} p */
		function playOnMine(p) {
			const acc = selfAccess();
			if (!acc.ok) return toast(`${acc.why}.`);
			selfOpen = true;
			const c = ensureSelf();
			if (!c) return;
			sendPattern(Player.MemberNumber, reseed(p));
			toast(`Playing ${patLabel(p)} on your toys.`);
			render();
		}
		// Saved patterns: pick one and play it, or load it into the editor (programs into the program builder)
		/**
		 * @param {number} m
		 * @param {VLControl} c
		 * @param {VLPattern} pat what plays when nothing saved is picked
		 */
		function savedRow(m, c, pat) {
			if (!settings.saved.length) return null;
			const big = peerPlaysBig(m);
			if (!findSaved(c.savedSel || "")) c.savedSel = (settings.saved.find((x) => big || !isBig(x.p)) || settings.saved[0]).name;
			const ss = h(
				"select",
				{ "data-id": `rc-saved-${m}`, title: "Your saved patterns", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => (c.savedSel = e.target.value) },
				settings.saved.map((x) => h("option", { value: x.name, selected: x.name === c.savedSel, disabled: !big && isBig(x.p) }, `${x.name} · ${patLabel(x.p)}`))
			);
			const cur = () => findSaved(ss.value)?.p;
			return h(
				"div",
				{ class: "row" },
				ss,
				h("button", { class: "go", title: "Play it", onclick: () => { const p = cur(); if (p) sendPattern(m, reseed(p)); } }, "▶"),
				h(
					"button",
					{
						title: "Load it into the editor to change it",
						onclick: () => {
							const p = cur();
							if (!p) return;
							if (p.type === "rec") return toast("Recordings can only be played, not edited.");
							if (p.type === "prog") c.prog = { steps: p.steps.map((x) => ({ ...x })), loop: p.loop };
							else Object.assign(pat, p);
							render();
						},
					},
					"✎"
				)
			);
		}
		// The program being built: its steps, a preview of the whole run, loop, play and save
		/**
		 * @param {number} m
		 * @param {VLControl} c
		 */
		function programBlock(m, c) {
			const cp = c.prog;
			if (!cp?.steps.length) return null;
			const big = peerPlaysBig(m);
			const prog = () => cleanPattern({ type: "prog", steps: cp.steps, loop: cp.loop });
			const pp = prog();
			if (!pp) return null;
			const cv = h("canvas", { class: "vl-prev", width: 200, height: 36 });
			setTimeout(() => drawPat(cv, pp, pp.period));
			const move = (/** @type {number} */ i, /** @type {number} */ d) => {
				const st = cp.steps;
				[st[i], st[i + d]] = [st[i + d], st[i]];
				render();
			};
			return h(
				"div",
				{ class: "vl-pat" },
				h("div", { class: "vl-sub" }, `Program · ${fmtDur(pp.period)}${cp.loop ? " · loops" : ""}`),
				h(
					"div",
					{ class: "vl-list" },
					cp.steps.map((st, i) =>
						h(
							"div",
							{ class: "vl-li" },
							h("span", { class: "vl-li-t" }, `${i + 1}. ${stepText(st)} for ${fmtDur(st.dur)}`),
							h("button", { title: "Move up", disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
							h("button", { title: "Remove this step", onclick: () => (cp.steps.splice(i, 1), render()) }, "✕")
						)
					)
				),
				cv,
				h(
					"div",
					{ class: "row" },
					h("label", { title: "Start again from the first step until stopped" }, h("input", { type: "checkbox", checked: cp.loop, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((cp.loop = e.target.checked), render()) }), " Loop"),
					h("span", { style: "flex:1" }),
					h("button", { class: "go", disabled: !big, title: big ? "Play the program" : `They need Vibe Link ${PROG_VER} or newer for programs`, onclick: () => { const pr = prog(); if (pr) sendPattern(m, reseed(pr)); } }, "▶ Play"),
					h("button", { title: "Save the program", onclick: () => pp && promptSave(pp, "Program") }, "💾"),
					h("button", { title: "Start a new program", onclick: () => ((c.prog = null), render()) }, "Clear")
				)
			);
		}
		/**
		 * @param {number} m
		 * @param {VLControl} c
		 */
		function patternControls(m, c) {
			const pat = /** @type {VLWave} */ (c.pat = c.pat || { type: "wave", min: 10, max: 70, period: 3000, dur: 0, seed: 1 });
			const preview = h("canvas", { class: "vl-prev", width: 200, height: 36 });
			const draw = () => {
				const ctx = preview.getContext("2d");
				if (!ctx) return;
				const W = preview.width;
				const H = preview.height;
				ctx.clearRect(0, 0, W, H);
				ctx.strokeStyle = tc("accent", "#c070d0");
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				const span = pat.period * 2; // two cycles
				const rnd = seeded(pat.seed);
				for (let x = 0; x <= W; x++) {
					const y = H - 2 - (patternAt(pat, (x / W) * span, rnd) / 100) * (H - 4);
					if (x) ctx.lineTo(x, y);
					else ctx.moveTo(x, y);
				}
				ctx.stroke();
			};
			/**
			 * @param {string} id
			 * @param {[number | string, string][]} options
			 * @param {"type" | "period" | "dur"} key
			 * @param {boolean} [toNum]
			 */
			const sel = (id, options, key, toNum = true) =>
				h(
					"select",
					{ "data-id": `rc-${id}-${m}`, onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((/** @type {Record<string, any>} */ (pat)[key] = toNum ? Number(e.target.value) : e.target.value), draw()) },
					options.map(([v, t]) => h("option", { value: v, selected: pat[key] === v }, t))
				);
			const lo = h("input", { type: "range", min: 0, max: 100, value: pat.min, class: "vl-live", "data-id": `rc-lo-${m}`, title: "Lowest strength" });
			const hi = h("input", { type: "range", min: 0, max: 100, value: pat.max, class: "vl-live", "data-id": `rc-hi-${m}`, title: "Highest strength" });
			const loT = h("span", { class: "vl-pct" }, `${pat.min}%`);
			const hiT = h("span", { class: "vl-pct" }, `${pat.max}%`);
			// Each slider pushes the other along instead of stopping at it, so they never get stuck together
			const flat = h("div", { class: "hint" });
			const sync = () => {
				lo.value = String(pat.min);
				hi.value = String(pat.max);
				loT.textContent = `${pat.min}%`;
				hiT.textContent = `${pat.max}%`;
				flat.textContent = pat.min === pat.max ? `Low and High are the same, so this plays a steady ${pat.min}%.` : "";
				flat.style.display = pat.min === pat.max ? "" : "none";
				draw();
			};
			lo.addEventListener("input", () => ((pat.min = +lo.value), (pat.max = Math.max(pat.max, pat.min)), sync()));
			hi.addEventListener("input", () => ((pat.max = +hi.value), (pat.min = Math.min(pat.min, pat.max)), sync()));
			setTimeout(sync);
			return h(
				"div",
				{ class: "vl-pat" },
				h("div", { class: "vl-sub" }, "Pattern"),
				savedRow(m, c, pat),
				h("div", { class: "row" }, sel("ptype", PATTERN_TYPES.map((k) => [k, PATTERNS[k].label]), "type", false), sel("pspeed", PERIODS, "period")),
				h("div", { class: "row" }, h("span", { class: "vl-k" }, "Low"), lo, loT),
				h("div", { class: "row" }, h("span", { class: "vl-k" }, "High"), hi, hiT),
				flat,
				preview,
				h(
					"div",
					{ class: "row" },
					sel("pdur", DURATIONS, "dur"),
					h(
						"button",
						{
							class: "go",
							title: "Play this pattern on their toy",
							onclick: () => {
								pat.seed = (Math.random() * 2 ** 31) | 0;
								draw();
								sendPattern(m, pat);
							},
						},
						"▶ Play"
					),
					h("button", { title: "Save this pattern", onclick: () => promptSave({ ...pat }, `${PATTERNS[pat.type]?.label || "Pattern"} ${pat.min}-${pat.max}%`) }, "💾")
				),
				h(
					"div",
					{ class: "row" },
					h(
						"button",
						{
							class: "vl-wide",
							title: "Add this pattern to a program as its next step (for its 'how long', or 1 min if it runs until stopped)",
							onclick: () => {
								c.prog = c.prog || { steps: [], loop: false };
								if (c.prog.steps.length >= PROG_MAX_STEPS) return toast(`A program has at most ${PROG_MAX_STEPS} steps.`);
								c.prog.steps.push({ ...pat, dur: pat.dur || 60_000 });
								render();
							},
						},
						"+ Add to program"
					)
				),
				programBlock(m, c)
			);
		}

		// Remote tab: control others (top) and who may control you (below)
		/** @param {HTMLElement[]} out */
		function secRemote(out) {
			const r = settings.remote;
			const now = Date.now();
			if (!rcInRoom()) out.push(h("div", { class: "hint" }, "Remote control works in chat rooms, between people who both run Vibe Link."));
			// Requests waiting for your answer
			for (const [m, a] of asks) {
				out.push(
					h(
						"div",
						{ class: "warn" },
						h("div", {}, `${nameOf(m)} asks to control your toy.`),
						h(
							"div",
							{ class: "row" },
							h("button", { title: "Until one of you leaves the room", onclick: () => answerAsk(m, "once") }, "Allow"),
							[15, 30, 45, 60].map((min) => h("button", { title: `For ${min === 60 ? "1 hour" : `${min} minutes`}`, onclick: () => answerAsk(m, min) }, min === 60 ? "1 h" : `${min} min`)),
							h("button", { title: "Never ask for them again (until you remove them)", onclick: () => answerAsk(m, "always") }, "Always"),
							h("button", { onclick: () => answerAsk(m, "decline") }, "Decline")
						),
						h("div", { class: "hint" }, `Declined automatically in ${Math.max(0, Math.ceil((a.at + RC_ASK_TIMEOUT - now) / 1000))} s.`)
					)
				);
			}

			// Control someone
			out.push(h("h3", {}, "Control someone"));
			const others = [...peers].filter(([m]) => charOf(m));
			if (!others.length) out.push(h("div", { class: "hint" }, rcInRoom() ? "Nobody else here runs Vibe Link." : "—"));
			for (const [m, peer] of others) {
				const c = controlling.get(m);
				const left = c?.state === "granted" && c.until ? ` · ${fmtDur(c.until - now)} left` : "";
				const status =
					c?.state === "granted"
						? `You have control${left}`
						: c?.state === "pending"
							? "Asked, waiting…"
							: c?.state === "denied" || c?.state === "revoked" || c?.state === "lost"
								? c.reason || "No"
								: peer.accepts
									? "Accepts requests"
									: "Not accepting control";
				const btn =
					c?.state === "granted"
						? h("button", { onclick: () => releaseControl(m) }, "Give back")
						: c?.state === "pending"
							? null
							: h("button", { disabled: !peer.accepts, onclick: () => askControl(m) }, "Ask");
				out.push(h("div", { class: "row" }, h("span", { style: "flex:1;min-width:0" }, h("b", {}, nameOf(m)), h("div", { class: "hint", "data-rc-left": c?.state === "granted" && c.until ? m : null }, status)), btn));
				if (c?.state === "granted") out.push(liveControls(m, c));
			}

			section(out, "saved", `My patterns${settings.saved.length ? ` (${settings.saved.length})` : ""}`, secSaved);
			section(out, "hist", "History", secHistory);

			// Who may control you
			out.push(h("h3", {}, "Who can control you"));
			out.push(
				h(
					"div",
					{ class: "row" },
					h("label", { title: "Off: every request is declined" }, h("input", { type: "checkbox", checked: r.on, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((r.on = e.target.checked), saveSettings(), !r.on && [...grants.keys()].forEach((m) => revokeControl(m, "Remote control turned off")), render()) }), " Let others ask for control")
				)
			);
			if (!r.on) {
				out.push(h("div", { class: "hint" }, "Off: nobody can control your toy. Your max strength and 🛑 always apply."));
				out.push(announceRow(r)); // also covers "Play on my toys"
				return;
			}
			if (lockedOut()) out.push(h("div", { class: "warn" }, `Refusing control for ${fmtDur(lockoutUntil - now)} after a stop.`, " ", h("button", { onclick: () => ((lockoutUntil = 0), render()) }, "Allow again")));
			out.push(
				h(
					"div",
					{ class: "row" },
					"Requests",
					h(
						"select",
						{ "data-id": "rc-mode", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((r.mode = e.target.value === "list" ? "list" : "ask"), saveSettings()) },
						h("option", { value: "ask", selected: r.mode === "ask" }, "Ask me"),
						h("option", { value: "list", selected: r.mode === "list" }, "Only my Always list")
					)
				)
			);
			out.push(h("div", { class: "row" }, h("label", {}, h("input", { type: "checkbox", checked: r.trustOwners, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((r.trustOwners = e.target.checked), saveSettings()) }), " Owner and lovers don't need to ask")));
			out.push(h("div", { class: "hint" }, "Only people the game lets use items on you can ask."));

			// Who has control now
			if ([...grants.keys()].some((m) => !isSelf(m))) {
				out.push(h("h3", {}, "Controlling you now"));
				for (const [m, g] of [...grants].filter(([who]) => !isSelf(who)))
					out.push(
						h(
							"div",
							{ class: "row" },
							h(
								"span",
								{ style: "flex:1;min-width:0" },
								h("b", {}, nameOf(m), remoteCtl?.by === m ? " 🎮" : ""),
								h("div", { class: "hint", "data-rc-grant": g.until ? m : null }, g.until ? `${fmtDur(g.until - now)} left` : "Until one of you leaves")
							),
							h("button", { onclick: () => revokeControl(m) }, "Revoke"),
							h("button", { title: "Revoke and always refuse them", onclick: () => blockMember(m) }, "Block")
						)
					);
			}

			// Give someone control without them asking
			const invitable = [...peers.keys()].filter((m) => charOf(m) && !grants.has(m) && !r.blocked[m]);
			if (invitable.length) {
				const who = h("select", { "data-id": "rc-invite" }, invitable.map((m) => h("option", { value: m }, nameOf(m))));
				const dur = h(
					"select",
					{ "data-id": "rc-invite-dur", style: "flex:0 0 auto" },
					[[0, "while here"], [15, "15 min"], [30, "30 min"], [45, "45 min"], [60, "1 h"]].map(([v, t]) => h("option", { value: v }, t))
				);
				out.push(h("div", { class: "row" }, who, dur, h("button", { onclick: () => giveControl(Number(who.value), { mins: Number(dur.value) }) && toast(`Gave ${nameOf(Number(who.value))} control.`) }, "Give")));
			}

			// Lists
			/**
			 * @param {string} title
			 * @param {Record<string, string>} obj
			 * @param {string} removeLabel
			 */
			const list = (title, obj, removeLabel) => {
				const ids = Object.keys(obj);
				if (!ids.length) return;
				out.push(h("h3", {}, title));
				out.push(
					h(
						"div",
						{ class: "row" },
						ids.map((id) =>
							h("button", { title: `${removeLabel} (#${id})`, onclick: () => (delete obj[id], saveSettings(), render()) }, `${obj[id] || "#" + id} ✕`)
						)
					)
				);
			};
			list("Always allowed", r.always, "Remove from the Always list");
			list("Blocked", r.blocked, "Unblock");

			// Safety
			out.push(h("h3", {}, "Safety"));
			out.push(
				h(
					"div",
					{ class: "row" },
					"After 🛑 refuse for",
					h(
						"select",
						{ "data-id": "rc-lock", style: "flex:0 0 auto", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((r.lockoutMin = Number(e.target.value)), saveSettings()) },
						[0, 1, 5, 15, 30, 60].map((v) => h("option", { value: v, selected: r.lockoutMin === v }, v ? `${v} min` : "no time"))
					)
				)
			);
			out.push(
				h(
					"div",
					{ class: "row", title: "How far behind the controller your toy plays. Longer smooths out more network stalls; shorter reacts faster." },
					"Smoothing",
					h(
						"select",
						{ "data-id": "rc-buf", style: "flex:0 0 auto", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((r.bufferMs = Number(e.target.value)), saveSettings()) },
						[[100, "0.1 s (snappy)"], [150, "0.15 s"], [250, "0.25 s"], [400, "0.4 s"], [600, "0.6 s (smoothest)"]].map(([v, t]) => h("option", { value: v, selected: r.bufferMs === v }, t))
					)
				)
			);
			const sw = h("input", { type: "text", "data-id": "rc-safe", value: r.safeWord, placeholder: "Safe word (optional)", maxlength: 30 });
			sw.addEventListener("change", () => ((r.safeWord = sw.value.trim()), saveSettings()));
			out.push(h("div", { class: "row" }, sw));
			out.push(announceRow(r));
			out.push(h("div", { class: "hint" }, "Saying the safe word in chat, 🛑 or the stop hotkey stop your toy, take control away from everyone and refuse new requests for the time above. Your max strength scales whatever a controller sends."));
		}

		// Copies a pattern code to the clipboard (or shows it to copy by hand if the browser won't)
		/**
		 * @param {string} name
		 * @param {VLPattern} pat
		 */
		async function copyCode(name, pat) {
			const code = patternCode(name, pat);
			try {
				await navigator.clipboard.writeText(code);
				toast(`Code for "${name}" copied (${code.length} characters).`);
			} catch {
				window.prompt("Copy this code:", code);
			}
		}
		// Import: a pasted code, or a file (Export all's .json, or a text file of codes)
		/** @param {HTMLElement[]} o */
		function importRows(o) {
			const box = h("input", { type: "text", "data-id": "vl-import-code", placeholder: "Paste a pattern code (VL1:…)" });
			const fromCode = () => {
				const x = readPatternCode(box.value);
				if (!x) return toast("That isn't a Vibe Link pattern code.");
				const name = window.prompt("Save as:", freeName(x.name));
				if (name == null) return;
				const had = findSaved(name);
				if (had && !window.confirm(`Replace your "${had.name}"?`)) return;
				toast(savePatternAs(name, x.p));
				box.value = "";
			};
			box.addEventListener("keydown", (e) => e.key === "Enter" && fromCode());
			const file = h("input", { type: "file", accept: ".json,.txt,application/json,text/plain", style: "display:none" });
			const importFile = async () => {
				const f = file.files?.[0];
				file.value = "";
				if (!f) return;
				if (f.size > 2_000_000) return toast("That file is too big.");
				const list = readImportFile(await f.text());
				if (!list?.length) return toast("No Vibe Link patterns found in that file.");
				const clash = list.filter((x) => findSaved(x.name)).length;
				const replace = clash > 0 && window.confirm(`${clash} of the ${list.length} have names you already use.\n\nOK: replace yours.\nCancel: keep both (the imported ones get "(2)").`);
				toast(importSaved(list, replace));
			};
			file.addEventListener("change", () => {
				importFile().catch((err) => console.warn(TAG, err));
			});
			const exportAll = () => {
				const url = URL.createObjectURL(new Blob([exportFileText()], { type: "application/json" }));
				const a = h("a", { href: url, download: "vibe-link-patterns.json" });
				document.body.append(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			};
			o.push(h("div", { class: "row" }, box, h("button", { title: "Save the pattern from this code", onclick: fromCode }, "Import")));
			o.push(
				h(
					"div",
					{ class: "row" },
					h("button", { style: "flex:1", title: "Download all your saved patterns as a file (a backup, or to move them to another account)", disabled: !settings.saved.length, onclick: exportAll }, "⭳ Export all"),
					h("button", { style: "flex:1", title: "Add the patterns from an exported file", onclick: () => file.click() }, "⭱ Import file"),
					file
				)
			);
		}
		// Your saved patterns, programs and recordings: play on your own toys, copy as a code, rename, delete
		// (controllers pick them in the pattern picker)
		/** @param {HTMLElement[]} o */
		function secSaved(o) {
			if (!settings.saved.length) {
				o.push(h("div", { class: "hint" }, "Save patterns and programs with 💾 in a pattern picker, or from the History, or import them below."));
				return importRows(o);
			}
			o.push(
				h(
					"div",
					{ class: "vl-list" },
					settings.saved.map((x) =>
						h(
							"div",
							{ class: "vl-li" },
							h("span", { class: "vl-li-t" }, x.name, h("small", {}, patternText(x.p))),
							h("button", { title: "Play on my toys", onclick: () => playOnMine(x.p) }, "▶"),
							h("button", { title: "Copy as a code to share", onclick: () => copyCode(x.name, x.p) }, "📋"),
							h(
								"button",
								{
									title: "Rename",
									onclick: () => {
										const n = window.prompt("New name:", x.name);
										if (!n || !n.trim() || n.trim() === x.name) return;
										deleteSaved(x.name);
										toast(savePatternAs(n, x.p));
									},
								},
								"✎"
							),
							h("button", { title: "Delete", onclick: () => window.confirm(`Delete "${x.name}"?`) && deleteSaved(x.name) }, "✕")
						)
					)
				)
			);
			importRows(o);
			o.push(h("div", { class: "hint" }, `Saved with your account. In a pattern picker, choose one to play it on someone (programs and recordings need them on Vibe Link ${PROG_VER} or newer). 📋 copies a code anyone can import here.`));
		}

		// What happened during remote control, newest first; patterns and live sessions can be played again or saved
		let histShow = 40;
		/** @param {HTMLElement[]} o */
		function secHistory(o) {
			const list = history();
			o.push(
				h(
					"div",
					{ class: "row" },
					h("label", { style: "flex:1", title: "Kept in this browser only, never sent anywhere" }, h("input", { type: "checkbox", checked: settings.keepHistory, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.keepHistory = e.target.checked), saveSettings()) }), " Keep a history"),
					list.length > 0 && h("button", { title: "Delete the whole history", onclick: () => window.confirm("Clear the whole history?") && clearHistory() }, "Clear")
				)
			);
			if (!list.length) return o.push(h("div", { class: "hint" }, "Who controlled whom, and what they played, shows here. Live slider sessions are kept as recordings you can play again."));
			const today = new Date().toDateString();
			const when = (/** @type {number} */ at) => {
				const d = new Date(at);
				const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				return d.toDateString() === today ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
			};
			o.push(
				h(
					"div",
					{ class: "vl-list vl-hist" },
					list
						.slice(-histShow)
						.reverse()
						.map((e) =>
							h(
								"div",
								{ class: "vl-li" },
								h("span", { class: "vl-li-t" }, `${e.dir === "out" ? "→" : "←"} ${e.text}`, h("small", {}, when(e.at))),
								e.p && h("button", { title: "Play on my toys", onclick: () => e.p && playOnMine(e.p) }, "▶"),
								e.p && h("button", { title: "Save it", onclick: () => e.p && promptSave(e.p, `${e.dir === "out" ? `To ${e.name}` : e.name} ${patLabel(e.p)}`) }, "💾"),
								e.p && h("button", { title: "Copy as a code to share", onclick: () => e.p && copyCode(`${e.dir === "out" ? `To ${e.name}` : e.name} ${patLabel(e.p)}`, e.p) }, "📋")
							)
						)
				)
			);
			if (list.length > histShow) o.push(h("button", { class: "vl-wide", onclick: () => ((histShow += 60), render()) }, `Show older (${list.length - histShow})`));
			o.push(h("div", { class: "hint" }, "← done to you · → done by you. Kept in this browser only."));
		}

		/** @param {VLRemoteSettings} r */
		function announceRow(r) {
			return h(
				"div",
				{ class: "row", title: "Write remote control changes (taking control, patterns, the vibrator's level) into the chat" },
				"Announce changes",
				h(
					"select",
					{ "data-id": "rc-announce", style: "flex:0 0 auto", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((r.announce = e.target.value === "me" || e.target.value === "room" ? e.target.value : "off"), saveSettings()) },
					[["off", "Off"], ["me", "Only me"], ["room", "Everyone in the room"]].map(([v, t]) => h("option", { value: v, selected: r.announce === v }, t))
				)
			);
		}

		// Toys view: one line of connection state with the button you need right now
		const busyText = () => `In use by ${ownerName ? `${ownerName}'s` : "another game"} tab`;

		// Who controls you and what each toy is doing (pattern with its curve and time left, or live); updated by ui.tick
		/** @param {HTMLElement[]} out */
		function secControlledBy(out) {
			const rc = remoteCtl;
			if (!rc || !(grants.has(rc.by) || rc.lost)) return;
			out.push(
				h(
					"div",
					{ class: "vl-now on vl-me", "data-rc-me": "1" },
					isSelf(rc.by)
						? h("div", { class: "row", style: "margin:0" }, h("span", { class: "vl-now-t", style: "flex:1" }, "🎮 You're playing your toys"), h("button", { title: "Stop and let your toys follow the game", onclick: () => endSelf() }, "Stop"))
						: rc.lost
							? h("div", { class: "row", style: "margin:0" }, h("span", { class: "vl-now-t", style: "flex:1" }, `🎮 Lost contact with ${nameOf(rc.by)} · keeping their last setting`), h("button", { title: "Stop it and let your toys follow the game", onclick: () => revokeControl(rc.by) }, "Hand back"))
							: h("div", { class: "row", style: "margin:0" }, h("span", { class: "vl-now-t", style: "flex:1" }, `🎮 ${nameOf(rc.by)} is controlling your toy`), h("button", { title: "Take control away from them", onclick: () => revokeControl(rc.by) }, "Revoke")),
					h("div", { class: "vl-now-toys" }, ""),
					h("canvas", { class: "vl-now-g", width: 200, height: 26 }),
					h("div", { class: "vl-now-bar" }, h("i", {}))
				)
			);
		}
		/**
		 * @param {VLLane | null} lane
		 * @param {number} now
		 */
		function laneText(lane, now) {
			if (!lane) return "";
			if (lane.lvl != null) return `■ ${LEVEL_NAMES[lane.lvl]}`;
			if (lane.mode) return `▶ ${lane.mode} mode`;
			if (lane.pat) return `▶ ${patternText(lane.pat)}${lane.until ? ` · ${fmtDur(Math.max(0, lane.until - now))} left` : ""}`;
			return "● live";
		}
		/**
		 * @param {HTMLElement} el
		 * @param {number} now
		 */
		function drawMe(el, now) {
			const rc = remoteCtl;
			if (!rc) return;
			const driven = remoteToys()
				.map((toy) => /** @type {[VLToy, VLLane | null]} */ ([toy, laneFor(toy)]))
				.filter(([, l]) => l);
			const lines = /** @type {HTMLElement} */ (el.querySelector(".vl-now-toys"));
			const txt = driven.length ? driven.map(([toy, l]) => `${toy.display} ${Math.round(toy.value * 100)}% ${laneText(l, now)}`).join(" · ") : "Waiting for them…";
			if (lines.textContent !== txt) lines.textContent = txt;
			// The first pattern being played, drawn with its playhead (exactly what your toy is doing)
			const lane = driven.find(([toy, l]) => l?.pat && laneDrives(toy, l))?.[1];
			const g = /** @type {HTMLCanvasElement} */ (el.querySelector(".vl-now-g"));
			const bar = /** @type {HTMLElement} */ (el.querySelector(".vl-now-bar i"));
			const barBox = /** @type {HTMLElement} */ (bar.parentElement);
			g.style.display = lane ? "" : "none";
			barBox.style.display = lane?.until ? "" : "none";
			if (!lane?.pat) return;
			const lp = lane.pat;
			const lt0 = lane.t0 ?? now;
			if (lane.until) bar.style.width = `${Math.min(100, (100 * (now - lt0)) / (lane.until - lt0))}%`;
			const ctx = g.getContext("2d");
			if (!ctx) return;
			const W = g.width;
			const H = g.height;
			const span = lp.period * 2;
			const t = now - lt0;
			const start = Math.floor(t / lp.period) * lp.period;
			ctx.clearRect(0, 0, W, H);
			ctx.strokeStyle = tc("accent", "#e7b6ff");
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			for (let x = 0; x <= W; x++) {
				const y = H - 2 - (patternAt(lp, start + (x / W) * span, lane.rnd) / 100) * (H - 4);
				if (x) ctx.lineTo(x, y);
				else ctx.moveTo(x, y);
			}
			ctx.stroke();
			const px = ((t - start) / span) * W;
			const py = H - 2 - (patternAt(lp, t, lane.rnd) / 100) * (H - 4);
			ctx.fillStyle = "#fff";
			ctx.fillRect(px - 0.5, 0, 1, H);
			ctx.beginPath();
			ctx.arc(px, py, 3, 0, 2 * Math.PI);
			ctx.fill();
		}

		// Your own controls: the same slider, toy picker and patterns a controller gets, for your toys
		let selfOpen = false;
		/** @param {HTMLElement[]} out */
		function secPlayMine(out) {
			if (!loggedIn() || !toys.size) return;
			const acc = selfAccess();
			if (!acc.ok) {
				if (selfOpen) {
					selfOpen = false;
					if (grants.has(Player.MemberNumber)) setTimeout(endSelf);
				}
				out.push(h("div", { class: "row", title: "Only toys linked to a worn vibrator you could change yourself in the game" }, h("button", { class: "vl-wide", disabled: true }, "🎮 Play on my toys")));
				out.push(h("div", { class: "hint" }, `${acc.why}.${Object.keys(settings.links).length ? " (⚙ → Safety can ignore the game's rules.)" : ""}`));
				return;
			}
			if (!selfOpen) {
				out.push(h("div", { class: "row" }, h("button", { class: "vl-wide", title: "Live slider and patterns for your own toys", onclick: () => ((selfOpen = true), ensureSelf(), render()) }, "🎮 Play on my toys")));
				return;
			}
			const c = ensureSelf();
			if (!c) return;
			out.push(
				h("div", { class: "row", style: "justify-content:space-between" }, h("h3", { style: "margin:0" }, "Play on my toys"), h("button", { title: "Hide (stops what you're playing)", onclick: () => ((selfOpen = false), endSelf()) }, "Close")),
				liveControls(Player.MemberNumber, c)
			);
		}

		/** @param {HTMLElement[]} out */
		function secStatus(out) {
			secControlledBy(out);
			if (wceToySyncOn()) out.push(h("div", { class: "warn" }, "WCE's own toy sync (buttplug.io) is on. Turn it off in WCE's settings (Buttplug.io page) and reload, or Vibe Link can't connect."));
			const state =
				conn === "connected"
					? scanning
						? "Looking for toys…"
						: "Connected to Intiface"
					: conn === "connecting"
						? "Connecting…"
						: conn === "busy"
							? busyText()
							: conn === "failed"
								? `Not connected: ${connError}`
								: "Not connected";
			out.push(
				h(
					"div",
					{ class: "row" },
					h("span", { class: conn === "failed" ? "err" : "hint", style: "flex:1" }, state),
					conn === "connected"
						? h("button", { onclick: scanning ? stopScan : startScan }, scanning ? "Stop looking" : "Look for toys")
						: conn === "busy"
							? h("button", { title: "Intiface takes one game tab at a time: move it to this tab", onclick: takeOver }, "Use here")
							: conn !== "connecting" && h("button", { onclick: connect }, "Connect")
				)
			);
			if (conn === "busy") out.push(h("div", { class: "hint" }, "Intiface takes one game tab at a time. This tab takes over by itself when that one closes, logs out or disconnects."));
		}

		// Toys view: load a preset without opening Settings
		/** @param {HTMLElement[]} out */
		function secPresetQuick(out) {
			if (!settings.presets.length) return;
			const sel = h(
				"select",
				{ "data-id": "preset-quick", style: "flex:1;min-width:0", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => (presetSel = e.target.value) },
				settings.presets.map((p) => h("option", { value: p.name, selected: p.name === presetSel }, p.name))
			);
			const load = () => {
				const p = findPreset(sel.value);
				if (p) ui.toast(`Loaded "${p.name}": ${loadPreset(p)}`);
			};
			out.push(h("div", { class: "row" }, "Preset", sel, h("button", { title: "Use this preset now", onclick: load }, "Load")));
		}

		/** @param {HTMLElement[]} out */
		function secConnection(out) {
			// Connection
			if (wceToySyncOn())
				out.push(h("div", { class: "warn" }, "WCE's own toy sync (buttplug.io) is on. Intiface only accepts one app at a time, so turn it off in WCE's settings (Buttplug.io page) and reload, or Vibe Link can't connect."));
			out.push(
				h(
					"div",
					{ class: "row" },
					h("input", {
						type: "text",
						"data-id": "url",
						value: settings.url,
						style: "flex:1;min-width:0",
						title: "Intiface's server address (Intiface Central → Server address)",
						onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
							settings.url = e.target.value.trim() || DEFAULTS.url;
							saveSettings();
						},
					}),
					conn === "connected" || conn === "connecting" ? h("button", { onclick: disconnect }, "Disconnect") : h("button", { onclick: connect }, "Connect")
				)
			);
			const state =
				conn === "connected"
					? `Connected${scanning ? ", looking for toys…" : ""}`
					: conn === "connecting"
						? "Connecting…"
						: conn === "failed"
							? `Not connected: ${connError}. Is Intiface Central running with its server started?`
							: "Not connected.";
			out.push(h("div", { class: conn === "failed" ? "err" : "hint" }, state));
			out.push(
				h(
					"div",
					{ class: "row" },
					h("label", {}, h("input", { type: "checkbox", checked: settings.autoConnect, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.autoConnect = e.target.checked), saveSettings(), e.target.checked && conn !== "connected" && connect()) }), " Connect automatically"),
					conn === "connected" && h("button", { onclick: scanning ? stopScan : startScan }, scanning ? "Stop looking" : "Look for toys")
				)
			);
			out.push(
				h("div", { class: "row" }, h("label", { title: "A pretend toy that needs no Intiface. Nothing is sent anywhere, and people controlling your toys don't see it." }, h("input", { type: "checkbox", "data-id": "virtual", checked: virtualOn(), onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => setVirtual(e.target.checked) }), " Virtual toy (try Vibe Link without a toy)"))
			);

		}

		/** @param {HTMLElement[]} out */
		function secToys(out) {
			// Toys
			out.push(h("h3", {}, "Toys"));
			if (!toys.size) out.push(h("div", { class: "hint" }, conn === "connected" ? "No toys. Turn the toy on and press Look for toys (it looks for 30 seconds), or pair it in Intiface Central. Not in Windows Bluetooth settings." : "Connect to see toys."));
			if (!toys.size || (conn !== "connected" && !virtualOn()))
				out.push(h("div", { class: "row" }, h("button", { class: "vl-wide", title: "A pretend toy that needs no Intiface: see what Vibe Link would do with your vibrators", onclick: () => setVirtual(true) }, "Try a virtual toy")));
			const slots = vibeSlots();
			const hidden = toys.size - shownToys().length;
			if (hidden) out.push(h("div", { class: "hint" }, `${hidden} hidden (no vibration motor, or you hid ${hidden > 1 ? "them" : "it"}): ⚙ → Toys.`));
			for (const toy of shownToys()) {
				const slot = settings.links[toy.key] || "";
				const st = slotState(slot);
				out.push(
					h(
						"div",
						{ class: "toy" },
						h("div", { class: "row" }, h("span", { class: "nm", title: toy.motor ? `Motor ${toy.motor.n} of ${toy.motor.of} in ${toy.name}` : toy.name }, toy.display), toy.battery != null && h("span", { class: "hint", title: "Battery" }, `🔋 ${toy.battery}%`)),
						toy.virtual ? h("div", { class: "hint" }, "Pretend toy: nothing is sent anywhere, and only you can drive it. ", h("a", { href: "#", onclick: (/** @type {MouseEvent} */ e) => (e.preventDefault(), setVirtual(false)) }, "Remove")) : null,
							toy.vibes.length ? null : h("div", { class: "err" }, "This toy has no vibration motor buttplug.io can drive."),
							h(
								"div",
								{ class: "row" },
								"Follows",
								h(
									"select",
									{
										"data-id": "slot-" + toy.key,
										onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => {
											if (e.target.value) settings.links[toy.key] = e.target.value;
											else delete settings.links[toy.key];
											saveSettings();
											render();
										},
									},
									h("option", { value: "" }, "— nothing —"),
									// Slots with a vibrator on first, then slots with something that doesn't vibrate, then empty ones
									(() => {
										const rows = slots.map((s) => ({ ...s, w: wornIn(s.name) }));
										const opt = (/** @type {{ name: string }} */ s, /** @type {string} */ text) => h("option", { value: s.name, selected: s.name === slot }, text);
										/** @typedef {(typeof rows)[number]} SlotRow */
										/** @type {[string, SlotRow[], (r: SlotRow) => string][]} */
										const groups = [
											["Wearing a vibrator", rows.filter((r) => r.w.vibrates), (r) => `〰 ${r.label}: ${r.w.name}`],
											["Worn, doesn't vibrate", rows.filter((r) => r.w.item && !r.w.vibrates), (r) => `${r.label}: ${r.w.name}`],
											["Nothing worn", rows.filter((r) => !r.w.item), (r) => `${r.label} (empty)`],
										];
										return groups.filter(([, list]) => list.length).map(([label, list, text]) => h("optgroup", { label }, list.map((r) => opt(r, text(r)))));
									})()
								),
								h("button", { title: "Vibrate at 30% for 1.5 seconds", disabled: local.paused, onclick: () => (toy.testUntil = Date.now() + 1500) }, "Test")
							),
							h("div", { class: "vl-wave", title: "Strength over the last 15 seconds (⚙ → Scale charts to max)" }, h("canvas", { "data-wave": toy.id, height: 34 }), h("span", { "data-pct": toy.id, class: "vl-wave-pct" }, "")),
							slot && h("div", { class: "hint", "data-slot": toy.id }, slotText(st))
					)
				);
			}

		}

		// Every connected toy (one row per motor), with whether it shows on the Toys tab
		/** @param {HTMLElement[]} out */
		function secToyConfig(out) {
			if (!toys.size) return out.push(h("div", { class: "hint" }, conn === "connected" ? "No toys connected." : "Connect to see toys, or turn on the virtual toy (Connection)."));
			for (const t of toys.values()) {
				const note = !t.vibes.length ? "no vibration motor Vibe Link can drive" : t.motor ? `motor ${t.motor.n} of ${t.motor.of}` : "";
				out.push(
					h(
						"div",
						{ class: "row" },
						h(
							"label",
							{ title: toyShown(t) ? "Shown on the Toys tab" : "Hidden: not shown or driven" },
							h("input", {
								type: "checkbox",
								"data-id": `show-${t.key}`,
								checked: toyShown(t),
								onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.toyHidden[t.key] = !e.target.checked), saveSettings(), render()),
							}),
							` ${t.display}`
						),
						note && h("span", { class: "hint", style: "margin:0" }, note)
					)
				);
			}
			out.push(h("div", { class: "hint" }, "Toys with several vibration motors list each motor as its own toy, to link or control separately. Link them to the same slot to move together."));
		}

		/** @param {HTMLElement[]} out */
		function secRemember(out) {
			out.push(
				h(
					"div",
					{ class: "row" },
					h("label", { title: "Off: every session starts with toys following nothing" }, h("input", { type: "checkbox", checked: settings.rememberLinks, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.rememberLinks = e.target.checked), saveSettings()) }), " Remember links")
				)
			);
			out.push(
				h(
					"div",
					{ class: "row" },
					h(
						"label",
						{ title: "Off: Vibe Link's 〰 lines and anyone's Vibe Link announcements stay out of your chat; /vibe replies pop up instead. The game's own messages are untouched." },
						h("input", { type: "checkbox", "data-id": "chat-lines", checked: settings.chatLines, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.chatLines = e.target.checked), saveSettings()) }),
						" Vibe Link messages in my chat"
					)
				)
			);

		}

		/** @param {HTMLElement[]} out */
		function secPresets(out) {
			// Presets
			out.push(h("div", { class: "hint" }, "Saves toy links, levels, ramps and max strength."));
			if (settings.presets.length) {
				const sel = h(
					"select",
					{ "data-id": "preset", style: "flex:1;min-width:0", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => (presetSel = e.target.value) },
					settings.presets.map((p) => h("option", { value: p.name, selected: p.name === presetSel }, p.name))
				);
				const chosen = () => findPreset(sel.value);
				out.push(
					h(
						"div",
						{ class: "row" },
						sel,
						h("button", { title: "Use this preset now", onclick: () => { const p = chosen(); if (p) ui.toast(`Loaded "${p.name}": ${loadPreset(p)}`); } }, "Load"),
						h("button", { title: "Save the current setup over this preset", onclick: () => { const p = chosen(); if (p && savePreset(p.name)) ui.toast(`Updated "${p.name}"`); } }, "Update"),
						h("button", { title: "Delete this preset", onclick: (/** @type {MouseEvent} */ e) => {
							const p = chosen();
							if (!p) return;
							const btn = /** @type {HTMLElement} */ (e.target);
							if (btn.dataset.sure) return deletePreset(p), ui.toast(`Deleted "${p.name}"`);
							btn.dataset.sure = "1";
							btn.textContent = "Sure?";
						} }, "Delete")
					)
				);
			}
			const nameInput = h("input", { type: "text", "data-id": "preset-name", placeholder: "Preset name", maxlength: 40, style: "flex:1;min-width:0" });
			const doSave = () => {
				const name = nameInput.value.trim();
				if (!name) return nameInput.focus();
				const existed = !!settings.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
				presetSel = name;
				if (!savePreset(name)) return ui.toast(`You can keep up to ${MAX_PRESETS} presets.`);
				ui.toast(existed ? `Updated "${name}"` : `Saved "${name}"`);
			};
			nameInput.addEventListener("keydown", (e) => e.key === "Enter" && doSave());
			out.push(h("div", { class: "row" }, nameInput, h("button", { onclick: doSave }, "Save current")));

		}

		/** @param {HTMLElement[]} out */
		function secGameModes(out) {
			// Levels
			out.push(h("h3", {}, "Strength per game level"));
			out.push(
				h(
					"div",
					{ class: "lv" },
					LEVEL_NAMES.map((n) => h("div", {}, n)),
					settings.levels.map((v, i) =>
						h("input", {
							type: "number",
							min: 0,
							max: 100,
							step: 5,
							value: v,
							"data-id": "lv" + i,
							title: `Toy strength (%) when the game vibrator is on ${LEVEL_NAMES[i]}`,
							onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
								settings.levels[i] = Math.min(100, Math.max(0, +e.target.value || 0));
								e.target.value = String(settings.levels[i]);
								saveSettings();
							},
						})
					)
				)
			);
			out.push(h("div", { class: "row" }, h("button", { onclick: () => ((settings.levels = [...DEFAULTS.levels]), saveSettings(), render()) }, "Reset levels")));

			// Game vibrator modes -> patterns
			out.push(h("h3", {}, "Game vibrator modes"));
			out.push(
				h(
					"div",
					{ class: "row" },
					h(
						"label",
						{ title: "On: in Random, Escalate, Tease, Deny and Edge your toy follows the level steps the game makes (very steppy: only Low, Medium, High and Max, no curves). Off: each mode plays its pattern below." },
						h("input", { type: "checkbox", "data-id": "modes-follow", checked: settings.modesFollowGame, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.modesFollowGame = e.target.checked), saveSettings(), render()) }),
						" Follow the game's levels in modes"
					)
				)
			);
			/** @type {[number, string][]} */
			const MODE_SPEEDS = [[1000, "1 s"], [2000, "2 s"], [4000, "4 s"], [6000, "6 s"], [8000, "8 s"], [12000, "12 s"], [20000, "20 s"], [30000, "30 s"], [60000, "60 s"]];
			for (const md of settings.modesFollowGame ? [] : VIBE_MODES) {
				const v = settings.modes[md];
				const isGame = v === "game";
				const cur = /** @type {VLModeSetting} */ (isGame ? { ...MODE_DEFAULTS[md] } : v);
				const save = () => (saveSettings(), render());
				const pctIn = (/** @type {"min" | "max"} */ key, /** @type {string} */ title) =>
					h("input", {
						type: "number",
						min: 0,
						max: 100,
						step: 5,
						value: cur[key],
						disabled: isGame,
						title,
						class: "vl-num",
						"data-id": `md-${key}-${md}`,
						onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
							cur[key] = Math.round(Math.min(100, Math.max(0, +e.target.value || 0)));
							if (cur.min > cur.max) {
								if (key === "min") cur.max = cur.min;
								else cur.min = cur.max;
							}
							settings.modes[md] = { ...cur };
							save();
						},
					});
				const speeds = MODE_SPEEDS.some(([ms]) => ms === cur.period) ? MODE_SPEEDS : [...MODE_SPEEDS, /** @type {[number, string]} */ ([cur.period, `${cur.period / 1000} s`])].sort((a, b) => a[0] - b[0]);
				out.push(
					h(
						"div",
						{ class: "vl-mode", title: `What your toy plays when the vibrator is in ${md} mode (set in the game or by a controller)` },
						h(
							"div",
							{ class: "row" },
							h("b", { class: "vl-mk" }, md),
							h(
								"select",
								{ "data-id": `md-type-${md}`, onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((settings.modes[md] = e.target.value === "game" ? "game" : { ...cur, type: e.target.value }), save()) },
								h("option", { value: "game", selected: isGame }, "Game steps"),
								PATTERN_TYPES.map((k) => h("option", { value: k, selected: !isGame && cur.type === k }, PATTERNS[k].label))
							)
						),
						isGame
							? null
							: h(
								"div",
								{ class: "row" },
								h("span", { class: "vl-ind" }, ""),
								pctIn("min", "Lowest strength (%)"),
								"–",
								pctIn("max", "Highest strength (%)"),
								"%",
								h(
									"select",
									{ "data-id": `md-speed-${md}`, title: "How long one cycle takes", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((cur.period = Number(e.target.value)), (settings.modes[md] = { ...cur }), save()) },
									speeds.map(([ms, t]) => h("option", { value: ms, selected: cur.period === ms }, t))
								)
							)
					)
				);
			}
			if (settings.modesFollowGame) out.push(h("div", { class: "hint" }, "Your toy follows the level steps the game makes in every mode (also when a controller picks one). It's very steppy: the game only jumps between Low, Medium, High and Max, so nothing curves the way the patterns do."));
			else {
				out.push(h("div", { class: "hint" }, "Used when the game puts your vibrator in that mode, and when a controller picks it. Game steps: follow the level changes the game makes. Strength is scaled by your max strength."));
				out.push(h("div", { class: "row" }, h("button", { onclick: () => ((settings.modes = structuredClone(MODE_DEFAULTS)), saveSettings(), render()) }, "Reset modes")));
			}
		}

		/** @param {HTMLElement[]} out */
		function secRamp(out) {
			const msInput = (/** @type {"rampUp" | "rampDown"} */ key, /** @type {string} */ label) =>
				h(
					"label",
					{},
					label,
					" ",
					h("input", {
						type: "number",
						min: 0,
						max: 10,
						step: 0.1,
						value: settings[key] / 1000,
						"data-id": key,
						onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
							settings[key] = Math.round(Math.min(10, Math.max(0, +e.target.value || 0)) * 1000);
							saveSettings();
						},
					}),
					" s"
				);
			out.push(h("div", { class: "row" }, msInput("rampUp", "Up"), msInput("rampDown", "Down")));
			out.push(
				h(
					"div",
					{ class: "row" },
					"Curve",
					h(
						"select",
						{ "data-id": "curve", onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((settings.curve = e.target.value === "linear" ? "linear" : "ease"), saveSettings()) },
						h("option", { value: "ease", selected: settings.curve === "ease" }, "Smooth"),
						h("option", { value: "linear", selected: settings.curve === "linear" }, "Linear")
					)
				)
			);
			out.push(h("div", { class: "hint" }, "0 s jumps straight there. 🛑 is always instant."));
		}

		/** @param {HTMLElement[]} out */
		function secSafety(out) {
			out.push(
				h(
					"div",
					{ class: "row" },
					"Max strength",
					h("input", {
						type: "range",
						min: 0,
						max: 100,
						step: 5,
						value: settings.cap,
						"data-id": "cap",
						style: "flex:1",
						oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
							settings.cap = +e.target.value;
							if (e.target.nextSibling) e.target.nextSibling.textContent = settings.cap + "%";
							saveSettings();
						},
					}),
					h("span", { style: "width:36px;text-align:right" }, settings.cap + "%")
				)
			);
			out.push(
				h(
					"div",
					{ class: "row" },
					h(
						"label",
						{ title: "Off: toy charts run 0-100% with a dashed line at your max strength. On: 0 to your max fills the chart." },
						h("input", { type: "checkbox", "data-id": "chart-max", checked: settings.chartToMax, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.chartToMax = e.target.checked), saveSettings()) }),
						" Scale charts to max"
					)
				)
			);
			out.push(h("div", { class: "hint" }, "Every level is scaled to this."));
			out.push(
				h(
					"div",
					{ class: "row" },
					"Stop hotkey",
					h(
						"button",
						{
							title: "Click, then press the key combination to use",
							onclick: (/** @type {MouseEvent} */ e) => {
								recordingHotkey = true;
								/** @type {HTMLElement} */ (e.target).textContent = "Press keys… (Esc cancels)";
							},
						},
						hotkeyText(settings.hotkey)
					)
				)
			);
			out.push(
				h(
					"div",
					{ class: "row" },
					h("label", {}, h("input", { type: "checkbox", checked: settings.stopWhenHidden, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.stopWhenHidden = e.target.checked), saveSettings()) }),  " Pause when tab is in background")
				)
			);
			out.push(h("div", { class: "hint" }, "Toys also stop on close, logout or disconnect."));
			out.push(
				h(
					"div",
					{ class: "row" },
					h(
						"label",
						{ title: "Immersion setting. Off: Play on my toys only works when the game would let you change your own vibrator (free hands, a remote, a slot you can reach)." },
						h("input", { type: "checkbox", "data-id": "self-ignore", checked: settings.selfIgnoreRules, onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => ((settings.selfIgnoreRules = e.target.checked), saveSettings(), (selfAccessCache = null), render()) }),
						" Play on my toys ignores the game's rules"
					)
				)
			);
			out.push(h("div", { class: "hint" }, "Off keeps it immersive: tied hands or no remote means you can't. Your worn vibrator is only changed where the game allows it either way."));
		}

		/** @param {{ item: Item | null | undefined, level: number }} st */
		function slotText(st) {
			if (!st.item) return "Nothing worn there.";
			const name = st.item.Asset?.Description || st.item.Asset?.Name || "Item";
			const mode = st.item.Property?.Mode;
			return `${name}: ${LEVEL_NAMES[st.level + 1]}${mode && !LEVEL_NAMES.includes(mode) && mode !== "Maximum" ? ` (${mode} mode)` : ""}`;
		}

		let lastSum = "";
		/** @type {boolean | null} */
		let lastVisible = null;
		/** @type {string | null} */
		let lastWorn = null;
		let wornCheckAt = 0;
		let inspectCheckAt = 0;
		let lastInspect = "";
		function tickPanel() {
			if (!panel || !root) return;
			const vis = loggedIn();
			if (vis !== lastVisible) {
				lastVisible = vis;
				render();
			}
			const sum = summary();
			if (sum !== lastSum) {
				lastSum = sum;
				panel.setSummary(sum);
				panel.setDot(statusDot() || "none");
				titleMark();
			}
			if (!panel.isOpen()) return;
			const now = Date.now();
			if (now - wornCheckAt > 1000) {
				wornCheckAt = now;
				const sig = wornSig();
				if (sig !== lastWorn && !(document.activeElement?.tagName === "SELECT" && root?.contains(document.activeElement))) {
					if (lastWorn != null) render();
					lastWorn = sig;
				}
			}
			if (view === "inspect" && now - inspectCheckAt > 1000) {
				inspectCheckAt = now;
				const C = inspectChar();
				const sig = inspectSig(C);
				if (sig !== lastInspect && !(document.activeElement?.tagName === "SELECT" && root.contains(document.activeElement))) {
					lastInspect = sig;
					render();
				}
				const ar = root.querySelector("[data-insp-arousal]");
				if (ar && C && ar.textContent !== arousalText(C)) ar.textContent = arousalText(C);
			}
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-status]"))) {
				const c = controlling.get(Number(el.dataset.rcStatus));
				const st = c?.status;
				const one = st?.toys?.filter((t) => t.e) || [];
				const doing = st?.pat || st?.pl ? `${st.pat ? patternText(st.pat) : st.pl}${st.left ? `, ${fmtDur(st.left)} left` : ""}` : st?.active ? "Following you" : "Following their game";
				const txt = !st || now - st.at > 4000 ? "Waiting for their toy…" : st.toys.length ? (one.length > 1 ? `${st.active ? "You're controlling" : "Following their game"} · ${one.length} toys` : `${doing}: ${st.toys.map((t) => `${t.n} ${t.pct}%`).join(" · ")}`) : "No toy connected on their side";
				if (el.textContent !== txt) el.textContent = txt;
			}
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-me]"))) drawMe(el, now);
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-toys]"))) {
				const c = controlling.get(Number(el.dataset.rcToys));
				if (c && document.activeElement !== el) fillToyPicker(/** @type {HTMLSelectElement} */ (el), c, Number(el.dataset.rcToys));
			}
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-now]"))) {
				const c = controlling.get(Number(el.dataset.rcNow));
				if (c) drawNow(el, c, c.status, now);
			}
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-left]"))) {
				const c = controlling.get(Number(el.dataset.rcLeft));
				if (c?.until) el.textContent = `You have control · ${fmtDur(c.until - now)} left`;
			}
			for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-rc-grant]"))) {
				const g = grants.get(Number(el.dataset.rcGrant));
				if (g?.until) el.textContent = `${fmtDur(g.until - now)} left`;
			}
			for (const toy of toys.values()) {
				const pct = Math.round(toy.value * 100);
				const wave = /** @type {HTMLCanvasElement | null} */ (root.querySelector(`[data-wave="${toy.id}"]`));
				if (wave && wave.dataset.n !== `${toy.histN}/${settings.cap}/${settings.chartToMax}/${themeGen}`) drawWave(wave, toy, now);
				const p = root.querySelector(`[data-pct="${toy.id}"]`);
				if (p) p.textContent = pct + "%";
				const s = root.querySelector(`[data-slot="${toy.id}"]`);
				if (s) {
					const lane = laneFor(toy);
					const txt = lane && remoteCtl ? `🎮 ${isSelf(remoteCtl.by) ? "You" : nameOf(remoteCtl.by)}: ${lane.lvl != null ? LEVEL_NAMES[lane.lvl] : lane.mode ? `${lane.mode} mode` : lane.pat ? patLabel(lane.pat) : "live"}` : slotText(slotState(settings.links[toy.key]));
					if (s.textContent !== txt) s.textContent = txt;
				}
			}
		}

		// The toy's real strength over the last 15 s, newest on the right; faint lines at 25/50/75%
		/**
		 * @param {HTMLCanvasElement} cv
		 * @param {VLToy} toy
		 * @param {number} now
		 */
		function drawWave(cv, toy, now) {
			cv.dataset.n = `${toy.histN}/${settings.cap}/${settings.chartToMax}/${themeGen}`;
			const dpr = window.devicePixelRatio || 1;
			const cw = Math.max(40, Math.round(cv.clientWidth * dpr));
			const ch = Math.round(34 * dpr);
			if (cv.width !== cw || cv.height !== ch) {
				cv.width = cw;
				cv.height = ch;
			}
			const ctx = cv.getContext("2d");
			if (!ctx) return;
			const W = cv.width;
			const H = cv.height;
			const pad = 2 * dpr;
			const cap = Math.max(0.05, settings.cap / 100);
			const top = settings.chartToMax ? cap : 1; // strength at the top of the chart
			const y = (/** @type {number} */ v) => H - pad - Math.min(1, v / top) * (H - 2 * pad);
			const x = (/** @type {number} */ t) => W - ((now - t) / HIST_MS) * W;
			ctx.clearRect(0, 0, W, H);
			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.lineWidth = 1;
			for (const g of [0.25, 0.5, 0.75]) {
				ctx.beginPath();
				ctx.moveTo(0, Math.round(y(g * top)) + 0.5);
				ctx.lineTo(W, Math.round(y(g * top)) + 0.5);
				ctx.stroke();
			}
			// Where max strength is (on the full 0-100% scale, when it's below 100%)
			if (!settings.chartToMax && settings.cap < 100) {
				const my = Math.round(y(cap)) + 0.5;
				ctx.save();
				ctx.setLineDash([4 * dpr, 3 * dpr]);
				ctx.strokeStyle = "rgba(255,200,90,0.75)";
				ctx.beginPath();
				ctx.moveTo(0, my);
				ctx.lineTo(W, my);
				ctx.stroke();
				ctx.restore();
				ctx.fillStyle = "rgba(255,200,90,0.9)";
				ctx.font = `${9 * dpr}px sans-serif`;
				ctx.textAlign = "right";
				ctx.textBaseline = my > 12 * dpr ? "bottom" : "top";
				ctx.fillText(`max ${settings.cap}%`, W - 4 * dpr, my + (my > 12 * dpr ? -1 : 2) * dpr);
			}
			const pts = toy.hist || [];
			if (!pts.length) return;
			ctx.beginPath();
			pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
			const lastX = x(pts[pts.length - 1][0]);
			ctx.lineTo(lastX, H);
			ctx.lineTo(x(pts[0][0]), H);
			ctx.closePath();
			const fill = ctx.createLinearGradient(0, 0, 0, H);
			fill.addColorStop(0, rgba(tc("glow", "#e070a0"), 0.45));
			fill.addColorStop(1, rgba(tc("accent", "#a050d0"), 0.08));
			ctx.fillStyle = fill;
			ctx.fill();
			ctx.beginPath();
			pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
			ctx.strokeStyle = tc("glow", "#e070a0");
			ctx.lineWidth = 1.5 * dpr;
			ctx.stroke();
			const lv = pts[pts.length - 1][1];
			ctx.fillStyle = "#fff";
			ctx.beginPath();
			ctx.arc(Math.min(lastX, W - 3 * dpr), y(lv), 2.5 * dpr, 0, 2 * Math.PI);
			ctx.fill();
		}

		/** @param {string} msg */
		function toast(msg) {
			let el = document.getElementById("vl-toast");
			if (!el) document.body.append((el = h("div", { id: "vl-toast" })));
			el.textContent = "〰 " + msg;
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => el.remove(), 3500);
		}

		/** @param {KeyboardEvent} e */
		function onKey(e) {
			if (recordingHotkey) {
				if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) return;
				e.preventDefault();
				e.stopPropagation();
				recordingHotkey = false;
				if (e.code !== "Escape") {
					settings.hotkey = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, code: e.code };
					saveSettings();
				}
				render();
				return;
			}
			const k = settings.hotkey;
			if (e.code === k.code && e.ctrlKey === !!k.ctrl && e.altKey === !!k.alt && e.shiftKey === !!k.shift && !e.repeat) {
				e.preventDefault();
				e.stopPropagation();
				if (local.paused) resume();
				else stopNow();
			}
		}

		return { mount, unmount, open, render, renderSoon, tick: tickPanel, toast, onKey };
	})();

	// ---------- chat commands ----------

	/** @param {string} msg */
	function say(msg) {
		if (!settings.chatLines) return ui.toast(msg); // a pop-up instead of a chat line
		if (typeof ChatRoomSendLocal === "function" && typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") ChatRoomSendLocal(`〰 ${msg}`, 15000);
		else ui.toast(msg);
	}

	function statusText() {
		if (local.paused) return "Stopped. /vibe resume to let toys follow the game again.";
		if (conn === "busy") return `Intiface is in use by ${ownerName ? `${ownerName}'s` : "another game"} tab. /vibe here moves it to this tab.`;
		if (conn !== "connected" && !virtualOn()) return conn === "failed" ? `Not connected to Intiface: ${connError}` : "Not connected to Intiface.";
		if (!toys.size) return scanning ? "Connected, looking for toys…" : "Connected, no toys. /vibe scan to look for them.";
		return [...toys.values()]
			.map((t) => {
				const slot = settings.links[t.key];
				const lvl = slot ? LEVEL_NAMES[slotState(slot).level + 1] : null;
				return `${t.display}${t.battery != null ? ` (🔋${t.battery}%)` : ""}: ${slot ? `follows ${slotLabel(slot)} (${lvl}), ${Math.round(t.value * 100)}%` : "not linked"}`;
			})
			.join(" · ");
	}

	/** @param {string} argText */
	function vibeCommand(argText) {
		const [sub = "", ...rest] = String(argText || "").trim().split(/\s+/);
		const arg = rest.join(" ").toLowerCase();
		switch (sub.toLowerCase()) {
			case "":
			case "open":
				return ui.open();
			case "stop":
				return stopNow();
			case "resume":
			case "go":
				resume();
				return say("Resumed: toys follow the game again.");
			case "here":
				takeOver();
				return say("Asking the other game tab to hand over Intiface…");
			case "scan":
				if (conn !== "connected") {
					connect().then(() => (conn === "connected" && !toys.size ? startScan() : undefined)).catch((err) => console.warn(TAG, err));
					return say("Connecting to Intiface, then looking for toys… (turn the toy on)");
				}
				startScan().catch((err) => console.warn(TAG, err));
				return say("Looking for toys… (turn the toy on)");
			case "status":
				return say(statusText());
			case "link": {
				// /vibe link butt  or  /vibe link hush butt
				const words = arg.split(/\s+/).filter(Boolean);
				const slot = vibeSlots().find((s) => words.some((w) => s.label.toLowerCase() === w || s.name.toLowerCase() === w || s.name.toLowerCase() === "item" + w));
				if (!slot) return say(`Which slot? e.g. /vibe link butt. Slots: ${vibeSlots().map((s) => s.label).join(", ")}`);
				const list = [...toys.values()];
				const toy = list.length === 1 ? list[0] : list.find((t) => words.some((w) => t.display.toLowerCase().includes(w) || t.name.toLowerCase().includes(w)));
				if (!toy) return say(list.length ? `Which toy? ${list.map((t) => t.display).join(", ")}` : "No toys connected.");
				settings.links[toy.key] = slot.name;
				saveSettings();
				ui.renderSoon();
				return say(`${toy.display} now follows ${slot.label}.`);
			}
			case "unlink": {
				const list = [...toys.values()];
				const toy = list.length === 1 ? list[0] : list.find((t) => t.display.toLowerCase().includes(arg) || t.name.toLowerCase().includes(arg));
				if (!toy || !arg && list.length > 1) return say(`Which toy? ${list.map((t) => t.display).join(", ")}`);
				delete settings.links[toy.key];
				saveSettings();
				ui.renderSoon();
				return say(`${toy.display} no longer follows anything.`);
			}
			case "preset":
			case "presets":
			case "load": {
				if (!arg) return say(settings.presets.length ? `Presets: ${settings.presets.map((pr) => pr.name).join(", ")}. /vibe preset <name> loads one.` : "No presets yet. /vibe save <name> saves the current setup.");
				const p = findPreset(arg);
				if (!p) return say(`No preset "${arg}". Presets: ${settings.presets.map((x) => x.name).join(", ") || "none"}`);
				return say(`Loaded "${p.name}": ${loadPreset(p)}`);
			}
			case "save": {
				const name = rest.join(" ").trim();
				if (!name) return say("/vibe save <name> saves which slot each toy follows plus levels, ramps and max strength.");
				const p = savePreset(name);
				return say(p ? `Saved preset "${p.name}".` : `You can keep up to ${MAX_PRESETS} presets.`);
			}
			default:
				return say("/vibe (open panel) · /vibe status · /vibe scan · /vibe link <slot> · /vibe unlink · /vibe preset [name] · /vibe save <name> · /vibe stop · /vibe resume · /vibe here");
		}
	}

	const COMMAND = {
		Tag: "vibe",
		Description: "[status|scan|link <slot>|unlink|preset <name>|save <name>|stop|resume|here]: Vibe Link toys (no option opens the panel)",
		Action: vibeCommand,
	};
	let commandAdded = false;
	function addCommand() {
		if (commandAdded || typeof Commands === "undefined" || typeof CommandCombine !== "function") return;
		if (Commands.some((c) => c.Tag === COMMAND.Tag)) {
			console.warn(TAG, "/vibe is already used by another add-on; use the panel instead");
			commandAdded = true;
			return;
		}
		CommandCombine([COMMAND]);
		commandAdded = true;
	}

	// ---------- wiring ----------

	syncVirtual();
	ui.mount();

	/** @type {number | null} */
	let settingsLoadedFor = null;
	let batteryAt = 0;
	const lifeTimer = setInterval(() => {
		addCommand();
		const member = loggedIn() ? Player.MemberNumber : null;
		if (member !== settingsLoadedFor) {
			settingsLoadedFor = member;
			if (member) {
				loadSettings();
				if (settings.autoConnect && conn !== "connected") connect().catch((err) => console.warn(TAG, err));
			} else {
				// logged out: toys go to 0 through the engine; drop the connection
				disconnect();
			}
			ui.render();
		}
		if (Date.now() - batteryAt > 5 * 60_000) {
			batteryAt = Date.now();
			for (const t of toys.values()) readBattery(t).catch((err) => console.warn(TAG, err));
		}
	}, 500);

	// The ramp ticker. A background tab's timers are throttled to once a second (later once a minute), which turns
	// every ramp into steps while you're on another tab. A worker's timers aren't throttled, so the worker sets the
	// pace and posts to this tab, whose message handling isn't throttled either. If a worker can't start (blocked by
	// the page's security policy), plain setInterval is the fallback.
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
			setTimeout(() => ticked || useFallback(), 1000);
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
	const stopTicker = startTicker(tick, TICK_MS);
	// Remote control (status, heartbeats, timeouts) also runs off a worker: a hidden tab's plain timers drop to once a
	// minute after a few minutes, which would make the other side think we've gone
	const stopRcTicker = startTicker(rcTick, 1000);
	const onVisibility = () => (tabHidden = document.hidden);
	const onPageHide = () => client.stopAll();
	addEventListener("keydown", ui.onKey, true);
	document.addEventListener("visibilitychange", onVisibility);
	addEventListener("pagehide", onPageHide);
	addEventListener("beforeunload", onPageHide);

	window.VibeLink = {
		version: MOD_INFO.version,
		settings: () => settings,
		toys: () => [...toys.values()].map((t) => ({ name: t.display, key: t.key, slot: settings.links[t.key] || null, strength: t.value, battery: t.battery })),
		connect,
		disconnect,
		stop: stopNow,
		resume,
		remote: {
			peers: () => new Map(peers),
			grants: () => new Map(grants),
			controlling: () => new Map(controlling),
			asks: () => [...asks.keys()],
			receive: rcReceive, // for testing: feed a ChatRoomMessage
			history: () => [...history()],
			debug: () => ({ remoteCtl: remoteCtl && { ...remoteCtl, lanes: Object.fromEntries(remoteCtl.lanes) }, toys: [...toys.values()].map((t) => ({ value: t.value, target: t.target, from: t.from, dur: t.dur, t0: t.t0, linear: t.linear })) }),
		},
		unload() {
			// Remote control can't survive a reload: put the worn vibrators back and tell whoever had control
			if (remoteCtl) rcRestoreGame(remoteCtl);
			for (const m of grants.keys()) rcSend(m, { t: "revoke", reason: "Their Vibe Link restarted" });
			stopTicker();
			stopRcTicker();
			for (const a of asks.values()) clearTimeout(a.timer);
			clearInterval(lifeTimer);
			clearTimeout(retryTimer);
			clearTimeout(saveTimer);
			clearTimeout(announceTimer);
			removeEventListener("keydown", ui.onKey, true);
			removeEventListener("bcdock:theme", onTheme);
			document.removeEventListener("visibilitychange", onVisibility);
			removeEventListener("pagehide", onPageHide);
			removeEventListener("beforeunload", onPageHide);
			if (Player?.MemberNumber) window.__vibeLinkCarry = { member: Player.MemberNumber, links: { ...settings.links }, at: Date.now() };
			clearTimeout(scanTimer);
			if (scanning) client.request("StopScanning").catch(() => {});
			client.stopAll();
			client.close();
			dropLock();
			chan?.close();
			ui.unmount();
			if (typeof Commands !== "undefined") {
				const i = Commands.findIndex((c) => c.Tag === COMMAND.Tag && c.Action === COMMAND.Action);
				if (i >= 0) Commands.splice(i, 1);
			}
			try {
				mod?.unload();
			} catch {
				// already done or gone: nothing to undo
			}
			try {
				const i = typeof ChatRoomMessageHandlers !== "undefined" ? ChatRoomMessageHandlers.indexOf(chatFilter) : -1;
				if (i >= 0) ChatRoomMessageHandlers.splice(i, 1);
			} catch {
				// already done or gone: nothing to undo
			}
			delete window.VibeLink;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded`);
})().catch((err) => console.error("[VibeLink]", err));
