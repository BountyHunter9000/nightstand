// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Little Black Book for Bondage Club (Nightstand)
// - Profiles: caches the character data the server sends while you share a chat room with someone,
//   so you can look up their profile later (offline included) by member number.
// - Chats: logs beeps and whispers per person and lets you reply with beeps.
// - Rooms: logs every room you enter (settings, description, all chat lines) for history and export.
// - Friends / Lobby: who's online and where, and a browsable room list.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_BlackBook", fullName: "Nightstand: Little Black Book", version: "1.3.3", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-little-black-book" };
	const TAG = "[BlackBook]";
	// Server events that carry a full character payload (the others are partial deltas)
	const FULL_SYNC_EVENTS = new Set(["ChatRoomSync", "ChatRoomSyncMemberJoin", "ChatRoomSyncCharacter", "ChatRoomSyncSingle"]);
	const MAX_HIDDEN_MSG_CHARS = 200_000;
	// A room session that ended this recently is continued instead of starting a new one (page reloads)
	const SESSION_RESUME_MS = 15 * 60_000;

	// Re-running the script (dev reload) replaces the previous instance
	// Re-running the script (dev reload) replaces the previous copy
	if (window.BlackBook && typeof window.BlackBook.unload === "function") window.BlackBook.unload();

	/**
	 * What's stored (one IndexedDB database per account). Records grow new fields over versions, so older ones may lack some.
	 * @typedef {{ key: string, owner: number, member: number, name?: string, nickname?: string, data?: any, firstSeen?: number, lastSeen?: number, lastOnline?: number, lastOnlineInfo?: any, onlineSince?: number, lastOffline?: number, lastRoom?: string, lastRoomInfo?: Record<string, any>, modMessages: Record<string, any>, notifyOnline?: boolean, note: string, fav?: boolean, [more: string]: any }} LBBProfile someone you've met: their last snapshot and your notes
	 * @typedef {{ id: number, owner: number, room: Record<string, any>, start: number, end: number, count: number, members: Record<string, string>, aliases?: string[], colors?: Record<string, string>, closed?: boolean, [more: string]: any }} LBBSession one room visit
	 * @typedef {{ id?: number, owner: number, session: number, ts: number, type: string, text: string, sender?: number | null, senderName?: string, [more: string]: any }} LBBLine one line logged in a room
	 * @typedef {{ id?: number, owner?: number, member: number, name?: string, ts: number, dir: string, kind: string, text: string, ext?: string, [more: string]: any }} LBBDm one beep or whisper
	 * @typedef {{ key: string, owner: number, member: number, name?: string, unread?: number, last?: number, [more: string]: any }} LBBConv a conversation with someone
	 * @typedef {{ key: string, [more: string]: any }} LBBMeta settings, groups, outfits and the like, by key
	 * @typedef {{ id: string, name: string, color?: string }} LBBGroup a friend group
	 * @typedef {{ groups: LBBGroup[], members: Record<string, string[]> }} LBBGroups friend groups, and the groups each member is in
	 * @typedef {LBBLine | { marker: true, type: string, ts: number, text: string, visit?: number }} LBBLogItem a logged line, or where a visit starts/ends
	 * @typedef {Map<string, { member: number, color: string }>} LBBPeople the names in a room log, for coloring and linking them
	 * @typedef {{ Name: string, Group: AssetGroupName, Color?: any, Property?: Record<string, any>, craftName?: string }} LBBPiece a piece of clothing or a restraint, as the game bundles it
	 * @typedef {{ A: string, G: AssetGroupName, C?: any }} LBBLook one slot of a full look (the wardrobe's Copy format)
	 * @typedef {{ pieces: LBBPiece[], full: LBBLook[], restraints: LBBPiece[], family: IAssetFamily }} LBBSnapshot an outfit as it was worn
	 * @typedef {LBBSnapshot & { key: string, id: number, name: string, from: number | null, fromName: string, savedAt: number, fav: boolean }} LBBOutfit a saved outfit
	 * @typedef {{ name: string, linesEl: HTMLElement, items: LBBLogItem[], sessionIds: Set<number>, visits: LBBSession[], find: string, people?: LBBPeople, starEl?: HTMLElement }} LBBRoomView the room log on screen
	 */
	/** @param {number} ms */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof bcModSdk === "undefined" || typeof ServerSocket === "undefined" || typeof Player === "undefined") await sleep(250);

	const mod = bcModSdk.registerMod(MOD_INFO);

	// ---------- storage (one IndexedDB database per account, opened after login) ----------
	// Separate databases mean tabs logged into different accounts never block each other's upgrades.

	const DB_VERSION = 1;
	const DB_PREFIX = "BlackBook-"; // one database per account: BlackBook-<member number>
	const OLD_DB_PREFIX = "FriendMgr-"; // the same data from before the rename, moved over once (see migrateOldDb)
	const me = () => Player.MemberNumber;
	const keyFor = (/** @type {number} */ member) => `${Player.MemberNumber}:${member}`;

	/** @type {IDBDatabase | null} */
	let db = null;
	/** @type {number | null} */
	let dbOwner = null;
	/** @type {{ owner: number, promise: Promise<IDBDatabase> } | null} */
	let dbOpening = null; // { owner, promise }
	/** @type {(() => void)[]} */
	let dbWaiting = []; // writes that arrived before this account's database was open

	/**
	 * @param {IDBRequest} req
	 * @returns {Promise<any>}
	 */
	const reqDone = (req) =>
		new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error instanceof Error ? req.error : new Error("IndexedDB request failed"));
		});
	/**
	 * @param {IDBTransaction} t
	 * @returns {Promise<void>}
	 */
	const txDone = (t) =>
		new Promise((resolve, reject) => {
			t.oncomplete = () => resolve();
			t.onerror = () => reject(t.error instanceof Error ? t.error : new Error("IndexedDB transaction failed"));
		});

	/**
	 * @param {number} owner
	 * @returns {Promise<IDBDatabase>}
	 */
	function openAccountDb(owner) {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(`${DB_PREFIX}${owner}`, DB_VERSION);
			req.onupgradeneeded = (e) => {
				const d = req.result;
				if (e.oldVersion < 1) {
					d.createObjectStore("profiles", { keyPath: "key" }).createIndex("owner", "owner");
					// One session per room visit, the lines logged in it, and beep/whisper conversations
					d.createObjectStore("sessions", { keyPath: "id" }).createIndex("owner", "owner");
					const roomMsgs = d.createObjectStore("roomMsgs", { keyPath: "id", autoIncrement: true });
					roomMsgs.createIndex("session", "session");
					roomMsgs.createIndex("ownerTs", ["owner", "ts"]);
					const dms = d.createObjectStore("dms", { keyPath: "id", autoIncrement: true });
					dms.createIndex("conv", ["owner", "member", "ts"]);
					dms.createIndex("ownerTs", ["owner", "ts"]);
					dms.createIndex("ext", "ext");
					d.createObjectStore("convs", { keyPath: "key" }).createIndex("owner", "owner");
					d.createObjectStore("meta", { keyPath: "key" });
				}
			};
			// Only another tab on this same account running an older version can block us; say so instead of silently waiting
			req.onblocked = () => {
				console.warn(TAG, "database upgrade is waiting for another tab on this account to close");
				const note = document.createElement("div");
				note.id = "fm-blocked";
				note.textContent = "Little Black Book is updating and is waiting for another Bondage Club tab on this account to close.";
				note.style.cssText =
					"position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:10002;background:#3b2033;color:#fff;border:1px solid #a0507a;border-radius:6px;padding:8px 14px;font:13px system-ui,sans-serif";
				document.body.append(note);
			};
			req.onsuccess = () => {
				document.getElementById("fm-blocked")?.remove();
				const d = req.result;
				// Let a newer version in another tab upgrade the database instead of blocking it
				d.onversionchange = () => {
					d.close();
					if (db === d) {
						db = null;
						dbOwner = null;
					}
					console.warn(TAG, "a newer Little Black Book in another tab upgraded the database; reload this tab");
				};
				resolve(d);
			};
			req.onerror = () => reject(req.error instanceof Error ? req.error : new Error("IndexedDB request failed"));
		});
	}

	// Moves this account's data from its database under the old name (FriendMgr-<member>) into the new one, once.
	// Everything is copied as is, the copy is checked store by store, and only then is the old database deleted.
	// If anything goes wrong the old database is left alone and the move is tried again at the next login.
	const STORES = ["profiles", "sessions", "roomMsgs", "dms", "convs", "meta"];
	/**
	 * @param {IDBDatabase} d
	 * @param {number} owner
	 */
	async function migrateOldDb(d, owner) {
		const meta = () => d.transaction("meta").objectStore("meta");
		if (await reqDone(meta().get("migrated"))) return;
		const oldName = `${OLD_DB_PREFIX}${owner}`;
		const dbs = indexedDB.databases ? await indexedDB.databases() : [];
		if (!dbs.some((x) => x.name === oldName)) {
			await reqDone(d.transaction("meta", "readwrite").objectStore("meta").put({ key: "migrated", at: Date.now(), from: null }));
			return;
		}
		// Only move into an empty database, so nothing made here already is overwritten
		for (const name of STORES) {
			if (await reqDone(d.transaction(name).objectStore(name).count())) {
				console.warn(TAG, `${oldName} still exists but this account's new database already has data; leaving the old one alone`);
				await reqDone(d.transaction("meta", "readwrite").objectStore("meta").put({ key: "migrated", at: Date.now(), from: oldName, skipped: true }));
				return;
			}
		}
		const old = await Promise.race([
			new Promise((resolve, reject) => {
				const r = indexedDB.open(oldName);
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error instanceof Error ? r.error : new Error("IndexedDB request failed"));
			}),
			sleep(5000).then(() => null),
		]);
		if (!old) return console.warn(TAG, `${oldName} is busy in another tab; will move it next time`);
		const counts = {};
		try {
			for (const name of STORES) {
				if (!old.objectStoreNames.contains(name)) continue;
				const rows = await reqDone(old.transaction(name).objectStore(name).getAll());
				/** @type {Record<string, number>} */ (counts)[name] = rows.length;
				if (!rows.length) continue;
				const t = d.transaction(name, "readwrite");
				for (const r of rows) t.objectStore(name).put(r);
				await txDone(t);
			}
		} finally {
			old.close();
		}
		for (const [name, n] of Object.entries(counts)) {
			const got = await reqDone(d.transaction(name).objectStore(name).count());
			if (got < n) throw new Error(`moving ${name} copied ${got} of ${n}; the old database was kept`);
		}
		await reqDone(d.transaction("meta", "readwrite").objectStore("meta").put({ key: "migrated", at: Date.now(), from: oldName, counts }));
		console.log(TAG, `moved your data from ${oldName}:`, counts);
		// Tabs still running the old version close their copy when asked; until they do, the delete waits
		const del = indexedDB.deleteDatabase(oldName);
		del.onsuccess = () => console.log(TAG, `deleted ${oldName}`);
		del.onblocked = () => console.warn(TAG, `${oldName} will be deleted once other tabs using it are closed`);
	}

	// Opens (or switches to) the logged-in account's database
	function ensureDb() {
		const owner = me();
		if (!owner) return Promise.reject(new Error("not logged in"));
		if (db && dbOwner === owner) return Promise.resolve(db);
		if (dbOpening && dbOpening.owner === owner) return dbOpening.promise;
		if (db) {
			// Logged into a different account in this tab: drop everything tied to the previous one
			db.close();
			db = null;
			dbOwner = null;
			session = null;
			lineQueue = [];
			dbWaiting = [];
		}
		const promise = (async () => {
			const d = await openAccountDb(owner);
			try {
				await migrateOldDb(d, owner);
			} catch (e) {
				console.warn(TAG, "moving the data from before the rename failed", e);
			}
			if (me() !== owner) {
				d.close();
				throw new Error("account changed while opening");
			}
			const saved = await reqDone(d.transaction("meta").objectStore("meta").get("prefs"));
			prefs = { ...PREF_DEFAULTS, ...(saved || {}) };
			delete prefs.key;
			db = d;
			dbOwner = owner;
			dbOpening = null;
			applyPrefs();
			await loadOutbox();
			const waiting = dbWaiting;
			dbWaiting = [];
			for (const fn of waiting) {
				try {
					fn();
				} catch (e) {
					console.warn(TAG, "deferred write failed", e);
				}
			}
			ui.onAccountReady();
			syncStatus = { at: 0, items: 0, size: 0, note: "" };
			setTimeout(() => syncAccount(true).catch((err) => console.warn(TAG, "sync failed", err)), 3000);
			return d;
		})();
		dbOpening = { owner, promise };
		promise.catch((e) => {
			if (dbOpening?.promise === promise) dbOpening = null;
			console.warn(TAG, "database open failed", e);
		});
		return promise;
	}

	// Per-account preferences, kept in the meta store and edited on the Settings page
	/** @type {Record<string, boolean | number>} */
	const PREF_DEFAULTS = {
		// recording
		logRooms: true, // room visits and every chat line in them
		logRoomChanges: true, // room description/settings edits as log lines
		logChats: true, // beep and whisper history
		captureProfiles: true, // snapshots of people you share a room with
		refreshAppearance: true, // keep their items current as they change during the visit
		captureAddonMsgs: true, // hidden add-on messages (add-on detection, Mod messages tab)
		// storage: days to keep, 0 = forever
		roomLogDays: 0,
		chatDays: 0,
		// messaging
		outboxAutoSend: true,
		syncGameRead: true, // reading a chat here also marks its beeps read in the game's friend list
		notifyWhispers: true,
		notifyBeeps: false,
		notifyOnline: true, // tell you when a friend you flagged with 🔔 comes online
		// other people's outfits: off = copy/save/wear only with their consent (same room, their wardrobe open to you)
		outfitCopyAnyone: false,
		// ...and which consent checks apply when it's off (each can be switched off on its own)
		outfitNeedRoom: false, // you're in the same room as them right now (off: cached profiles work after the fact)
		outfitNeedInteract: true, // they allow you to interact with them
		outfitNeedWardrobe: true, // their wardrobe is open to others (the game's full wardrobe access setting)
		// exports: off = other people's descriptions, outfits and crafts are left out of export files
		exportFull: false,
		// group messages: seconds between beeps, and the least time between group messages to the same person
		groupGapSec: 1.5,
		groupPerPersonSec: 60,
		// account sync: settings, groups, notes, favorites, pins and your own outfits follow you (per computer switch)
		syncAccount: true,
		// interface
		showBubble: true,
		cmdBook: true,
		cmdChat: true,
	};
	/** @type {Record<string, any>} */
	let prefs = { ...PREF_DEFAULTS };

	function savePrefs() {
		const snap = { key: "prefs", ...prefs };
		withDb(() => storeOf("meta", "readwrite").put(snap));
	}

	// Side effects of settings that aren't checked at the moment they matter
	function applyPrefs() {
		if (!prefs.logRooms) closeSession();
		applyCommandPrefs();
		ui.syncTabVisibility();
	}

	/**
	 * @param {string} key
	 * @param {boolean | number} value
	 */
	function setPref(key, value) {
		prefs[key] = value;
		savePrefs();
		applyPrefs();
		if (key === "roomLogDays" || key === "chatDays") pruneOldData().catch((err) => console.warn(TAG, err));
		if (key === "outboxAutoSend" && value) deliverOutbox().catch((err) => console.warn(TAG, err));
	}

	// Runs fn right away if this account's database is open, otherwise as soon as it is
	/** @param {() => void} fn */
	function withDb(fn) {
		if (db && dbOwner === me()) return fn();
		dbWaiting.push(fn);
		ensureDb().catch(() => {});
	}

	// The open database (writes only start once ensureDb() has opened it)
	const openDb = () => {
		if (!db) throw new Error("the database isn't open");
		return db;
	};
	/**
	 * @param {string} name
	 * @param {IDBTransactionMode} [mode]
	 */
	const storeOf = (name, mode = "readonly") => {
		// Settings, groups, favorites, pins and outfits live in meta/convs: a write there may need syncing
		if (mode === "readwrite" && (name === "meta" || name === "convs")) markSyncDirty();
		return openDb().transaction(name, mode).objectStore(name);
	};

	/**
	 * @param {IDBTransactionMode} mode
	 * @param {(store: IDBObjectStore) => IDBRequest | void} fn
	 * @returns {Promise<any>}
	 */
	const tx = async (mode, fn) => {
		await ensureDb();
		return new Promise((resolve, reject) => {
			if (!db) return reject(new Error("the database isn't open"));
			const t = db.transaction("profiles", mode);
			const req = fn(t.objectStore("profiles"));
			t.oncomplete = () => resolve(req ? req.result : undefined);
			t.onerror = () => reject(t.error instanceof Error ? t.error : new Error("IndexedDB transaction failed"));
		});
	};
	/**
	 * @param {string} key
	 * @returns {Promise<LBBProfile | undefined>}
	 */
	const dbGet = (key) => tx("readonly", (s) => s.get(key));
	const dbPut = (/** @type {LBBProfile} */ rec) => tx("readwrite", (s) => s.put(rec));
	const dbDelete = (/** @type {string} */ key) => tx("readwrite", (s) => s.delete(key));
	/**
	 * @param {number} owner
	 * @returns {Promise<LBBProfile[]>}
	 */
	const dbAllForOwner = (owner) => tx("readonly", (s) => s.index("owner").getAll(owner));

	// Writes go through one queue so read-modify-write updates never interleave
	let writeChain = Promise.resolve();
	/**
	 * @param {number} member
	 * @param {(rec: LBBProfile) => void} mutate
	 */
	function updateRecord(member, mutate) {
		writeChain = writeChain
			.then(async () => {
				if (!Player.MemberNumber || typeof member !== "number") return;
				const key = keyFor(member);
				const rec = (await dbGet(key)) || { key, owner: Player.MemberNumber, member, firstSeen: Date.now(), note: "", modMessages: {} };
				mutate(rec);
				await dbPut(rec);
			})
			.catch((err) => console.warn(TAG, "save failed", err));
		writeChain.then(() => ui.refreshSoon()).catch((err) => console.warn(TAG, err));
		return writeChain;
	}

	// ---------- profile capture ----------

	/** @type {Map<number, any>} */
	let onlineFriends = new Map();
	let onlineFriendsAt = 0;

	// Room settings from the last full room sync; partial syncs only carry the changed character
	/** @type {Record<string, any> | null} */
	let syncedRoom = null;
	const ROOM_FIELDS = ["Name", "Description", "Background", "Space", "Language", "Limit", "Private", "Locked", "Game", "Visibility", "Access", "BlockCategory"];

	/** @param {any} data a room as the server sends it */
	function roomInfoFrom(data) {
		/** @type {Record<string, any>} */
		const room = {};
		for (const k of ROOM_FIELDS) if (data[k] !== undefined) room[k] = JSON.parse(JSON.stringify(data[k]));
		if (Array.isArray(data.Admin)) room.AdminCount = data.Admin.length;
		return room;
	}

	/** @param {any} data */
	function rememberRoom(data) {
		const room = roomInfoFrom(data);
		syncedRoom = { ...(syncedRoom && syncedRoom.Name === room.Name ? syncedRoom : {}), ...room };
	}

	/** @param {any} c a character as the server sends it */
	function captureCharacter(c) {
		if (!prefs.captureProfiles || !c || typeof c.MemberNumber !== "number" || !Array.isArray(c.Appearance)) return;
		// Snapshot synchronously: the game mutates these objects once its own handler runs
		const snap = /** @type {any} */ (JSON.parse(JSON.stringify(c)));
		// ChatRoomSync always arrives before the member events of that room, so this is the room they're in
		const room = syncedRoom ? { ...syncedRoom } : null;
		updateRecord(c.MemberNumber, (rec) => {
			rec.name = snap.Name;
			rec.nickname = snap.Nickname || "";
			rec.lastSeen = Date.now();
			rec.lastRoom = room?.Name || currentRoomName() || rec.lastRoom || "";
			if (room) rec.lastRoomInfo = room;
			rec.data = snap;
		}).catch((err) => console.warn(TAG, err));
	}

	// Items put on or changed on someone already in the room arrive as single-item updates (ChatRoomSyncItem),
	// not as a full character. Once the game has applied and validated one, copy that person's whole appearance
	// into their snapshot so ropes, tightness, locks and options stay current.
	/** @type {Map<number, ReturnType<typeof setTimeout>>} */
	const appearanceRefreshTimers = new Map();
	/** @param {number} member */
	function refreshAppearanceSoon(member) {
		if (!prefs.captureProfiles || !prefs.refreshAppearance || typeof member !== "number") return;
		clearTimeout(appearanceRefreshTimers.get(member));
		appearanceRefreshTimers.set(
			member,
			setTimeout(() => {
				appearanceRefreshTimers.delete(member);
				const C = typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((c) => c.MemberNumber === member) : null;
				if (!C || typeof ServerAppearanceBundle !== "function") return;
				const appearance = JSON.parse(JSON.stringify(ServerAppearanceBundle(C.Appearance)));
				updateRecord(member, (rec) => {
					if (!rec.data) return;
					rec.data.Appearance = appearance;
					rec.lastSeen = Date.now();
				}).catch((err) => console.warn(TAG, err));
			}, 800)
		);
	}

	/** @param {ServerChatRoomMessage} msg */
	function captureHidden(msg) {
		if (!prefs.captureAddonMsgs || msg.Sender === Player.MemberNumber || typeof msg.Content !== "string") return;
		const json = JSON.stringify(msg);
		if (json.length > MAX_HIDDEN_MSG_CHARS) return;
		const snap = JSON.parse(json);
		const known = typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((ch) => ch.MemberNumber === msg.Sender) : null;
		if (typeof msg.Sender !== "number") return;
		updateRecord(msg.Sender, (rec) => {
			if (!rec.name && known) rec.name = known.Name;
			rec.modMessages = rec.modMessages || {};
			rec.modMessages[msg.Content] = { at: Date.now(), msg: snap };
		}).catch((err) => console.warn(TAG, err));
	}

	// Each answer to the online-friends query: who's online now. Per friend we keep when they were last seen online
	// (lastOnline), when this time online started (onlineSince, if we saw it start) and when we noticed them gone
	// (lastOffline). The query runs every few minutes (more often while the window is open), so times are that close.
	const ONLINE_SAME_SESSION_MS = 10 * 60_000; // seen online this recently before a reload: still the same time online
	/** @param {any[]} result */
	function captureOnlineFriends(result) {
		const before = onlineFriendsAt ? onlineFriends : null; // the first answer after login is the starting point
		onlineFriends = new Map(result.map((f) => [f.MemberNumber, f]));
		const now = Date.now();
		onlineFriendsAt = now;
		if (before) for (const f of result) if (!before.has(f.MemberNumber)) notifyOnline(f);
		if (prefs.captureProfiles) {
			for (const f of result) {
				updateRecord(f.MemberNumber, (rec) => {
					if (!rec.name) rec.name = f.MemberName;
					const prev = Math.max(rec.lastOnline || 0, rec.lastSeen || 0);
					// Came online since the last answer; or, on the first answer, unknown unless they were online just before
					if (before ? !before.has(f.MemberNumber) : !(prev && now - prev < ONLINE_SAME_SESSION_MS && (rec.lastOffline || 0) < prev)) rec.onlineSince = before ? now : undefined;
					rec.lastOnline = now;
					rec.lastOnlineInfo = f;
				}).catch((err) => console.warn(TAG, err));
			}
			if (before) for (const m of before.keys()) if (!onlineFriends.has(m)) updateRecord(m, (rec) => (rec.lastOffline = now)).catch((err) => console.warn(TAG, err));
		}
		ui.refreshSoon();
		ui.onOutboxChanged();
		deliverOutbox().catch((err) => console.warn(TAG, err));
	}

	function currentRoomName() {
		return typeof ChatRoomData !== "undefined" && ChatRoomData && ChatRoomData.Name ? ChatRoomData.Name : "";
	}

	function inRoom() {
		if (typeof ServerPlayerIsInChatRoom === "function") return ServerPlayerIsInChatRoom();
		return CurrentScreen === "ChatRoom";
	}

	/** @param {number} member */
	function friendNameOf(member) {
		return Player.FriendNames instanceof Map ? Player.FriendNames.get(member) : undefined;
	}

	/** @param {number} member */
	function nameOf(member) {
		if (typeof member !== "number") return "";
		const c = typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((x) => x.MemberNumber === member) : null;
		if (c) return typeof CharacterNickname === "function" ? CharacterNickname(c) : c.Nickname || c.Name;
		return session?.members[member] || friendNameOf(member) || "";
	}

	// Room names linked by renames seen while you were in the room, mapped to the latest name of each chain:
	// Map(any name in the chain → name of the most recently seen visit)
	/** @param {LBBSession[]} list */
	function buildNameGroups(list) {
		/** @type {Map<string, string>} */
		const parent = new Map();
		const find = (/** @type {string} */ n) => {
			while (parent.get(n) !== n) n = /** @type {string} */ (parent.get(n));
			return n;
		};
		const add = (/** @type {string} */ n) => parent.has(n) || parent.set(n, n);
		for (const s of list) {
			const n = s.room?.Name;
			if (!n) continue;
			add(n);
			for (const a of s.aliases || []) {
				add(a);
				const ra = find(a);
				const rn = find(n);
				if (ra !== rn) parent.set(ra, rn);
			}
		}
		/** @type {Map<string, { name: string, at: number }>} */
		const latest = new Map(); // root → { name, at }
		for (const s of list) {
			const n = s.room?.Name;
			if (!n) continue;
			const root = find(n);
			const at = s.end || s.start || 0;
			if ((latest.get(root)?.at ?? -1) < at) latest.set(root, { name: n, at });
		}
		/** @type {Map<string, string>} */
		const out = new Map();
		for (const n of parent.keys()) out.set(n, latest.get(find(n))?.name || n);
		return out;
	}

	// ---------- chat: room sessions and lines ----------

	/** @type {LBBSession | null} */
	let session = null; // the room visit being logged: { id, owner, room, start, end, count, members, closed }
	let resuming = false;
	/** @type {LBBLine[]} */
	let lineQueue = [];
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let lineFlushTimer;
	/** @type {[string, number][]} */
	const recentLines = []; // [key, ts] of lately logged lines, to drop duplicates when the log is redrawn

	function saveSession() {
		if (!session) return;
		const snap = { ...session, members: { ...session.members }, colors: { ...session.colors } };
		withDb(() => storeOf("sessions", "readwrite").put(snap));
	}

	function closeSession() {
		if (!session || session.closed) return;
		flushLines();
		session.closed = true;
		session.end = Date.now();
		saveSession();
		ui.onSessionClosed({ ...session });
	}

	const ROOM_CHANGE_LABELS = {
		Name: "Name",
		Background: "Background",
		Space: "Space",
		Language: "Language",
		Limit: "Limit",
		Private: "Private",
		Locked: "Locked",
		Game: "Game",
		Visibility: "Visibility",
		Access: "Access",
		BlockCategory: "Blocked categories",
		AdminCount: "Admins",
	};
	/** @param {unknown} v a room setting: text, a number, yes/no or a list */
	const roomValue = (v) => {
		const one = (/** @type {unknown} */ x) => (typeof x === "string" || typeof x === "number" ? String(x) : JSON.stringify(x));
		if (Array.isArray(v)) return v.map(one).join(", ") || "none";
		if (typeof v === "boolean") return v ? "yes" : "no";
		return v == null || v === "" ? "—" : one(v);
	};

	// Human-readable differences between two room snapshots; fields missing from `after` are left alone
	/**
	 * @param {Record<string, any>} before
	 * @param {Record<string, any>} after
	 */
	function roomChanges(before, after) {
		const out = [];
		const settings = [];
		for (const [k, label] of Object.entries(ROOM_CHANGE_LABELS)) {
			if (!(k in after) || roomValue(before?.[k]) === roomValue(after[k])) continue;
			settings.push(`${label}: ${roomValue(before?.[k])} → ${roomValue(after[k])}`);
		}
		if (settings.length) out.push(settings.join(" · "));
		if ("Description" in after && (before?.Description || "") !== (after.Description || "")) out.push(`Description changed to:\n${after.Description || "(empty)"}`);
		return out;
	}

	// Room changes are stored as ordinary log lines so they show up in history, search and exports
	/**
	 * @param {string[]} changes
	 * @param {string} prefix
	 * @param {number} [sender]
	 */
	function logRoomChanges(changes, prefix, sender) {
		if (!prefs.logRoomChanges || !session || session.closed || !changes.length) return;
		const who = typeof sender === "number" ? nameOf(sender) : "";
		for (const c of changes) {
			lineQueue.push({
				session: session.id,
				owner: session.owner,
				ts: Date.now(),
				type: "RoomChange",
				sender: typeof sender === "number" ? sender : null,
				senderName: who,
				text: `${prefix}${who ? ` by ${who}` : ""}: ${c}`,
			});
		}
		if (!lineFlushTimer) lineFlushTimer = setTimeout(flushLines, 500);
	}

	/** @param {LBBSession} s */
	async function noteChangesSinceLastVisit(s) {
		try {
			await ensureDb();
			const all = await reqDone(storeOf("sessions").index("owner").getAll(s.owner));
			const prev = /** @type {LBBSession[]} */ (all).filter((x) => x.id !== s.id && x.room?.Name === s.room.Name).sort((a, b) => b.start - a.start)[0];
			if (prev && session === s) logRoomChanges(roomChanges(prev.room, s.room), `Changed since your last visit (${fmtDate(prev.end)})`);
		} catch (e) {
			console.warn(TAG, "room comparison failed", e);
		}
	}

	// Name and label colour of everyone seen in this visit, for the log's name highlighting
	/** @param {any} c */
	/** @param {any} c */
	function rememberMember(c) {
		if (!session) return;
		session.members[c.MemberNumber] = c.Nickname || c.Name;
		session.colors = session.colors || {};
		if (typeof c.LabelColor === "string") session.colors[c.MemberNumber] = c.LabelColor;
	}

	/**
	 * @param {any} data the room
	 * @param {any[]} characters
	 * @param {boolean} [checkedResume]
	 */
	function onRoomSync(data, characters, checkedResume = false) {
		const room = roomInfoFrom(data);
		if (!room.Name || !me()) return;
		if (!prefs.logRooms) return closeSession();
		// First room sync since the page loaded (auto-relogin rejoins before anything else runs): check whether
		// this continues the last visit first. Lines drawn meanwhile are picked up from the chat log afterwards.
		if (!session && !checkedResume) {
			if (!resuming) resumeCurrentRoom(data, characters).catch((err) => console.warn(TAG, err));
			return;
		}
		// A resync of the room we're already in (reconnect, admin change) continues the same session
		if (!session || session.closed || session.room.Name !== room.Name || session.owner !== me()) {
			closeSession();
			const now = Date.now();
			const started = (session = { id: now, owner: me(), room, start: now, end: now, count: 0, members: {}, colors: {}, closed: false });
			ui.onSessionStarted({ ...session });
			noteChangesSinceLastVisit(started).catch((err) => console.warn(TAG, err));
		} else {
			logRoomChanges(roomChanges(session.room, room), "Room changed");
			session.room = { ...session.room, ...room };
		}
		for (const c of characters || []) if (c && typeof c.MemberNumber === "number") rememberMember(c);
		saveSession();
		ui.refreshSoon();
	}

	// Script started (or page reloaded) while already in a room: continue that room's last session if it's recent
	async function resumeCurrentRoom(data = ChatRoomData, characters = ChatRoomCharacter) {
		resuming = true;
		try {
			await ensureDb();
			const all = await reqDone(storeOf("sessions").index("owner").getAll(me()));
			const last = /** @type {LBBSession[]} */ (all).sort((a, b) => b.start - a.start)[0];
			// Only a visit that ended without leaving (page closed, reload, disconnect) is continued
			if (last && !last.closed && last.room?.Name === data?.Name && Date.now() - last.end < SESSION_RESUME_MS) session = { ...last, closed: false };
			onRoomSync(data, characters, true);
		} catch (e) {
			console.warn(TAG, "session resume failed", e);
		} finally {
			resuming = false;
		}
	}

	/** @type {Element | null} */
	let observedLog = null;
	/** @type {MutationObserver | null} */
	let logObserver = null;

	// The chat log element is recreated per room, so re-attach whenever it changes
	function watchChatLog() {
		const el = document.getElementById("TextAreaChatLog");
		if (el === observedLog) return;
		logObserver?.disconnect();
		observedLog = el;
		if (!el) return;
		logObserver = new MutationObserver((muts) => {
			// Give other add-ons a moment to decorate the line before reading it
			for (const m of muts) for (const n of m.addedNodes) if (n instanceof HTMLElement) setTimeout(() => captureLine(n), 50);
		});
		logObserver.observe(el, { childList: true });
		for (const n of el.children) if (n instanceof HTMLElement) captureLine(n);
	}

	const LINE_TYPES = ["Whisper", "Chat", "Emote", "Activity", "Action", "LocalMessage", "ServerMessage"];

	/** @param {HTMLElement} el */
	function lineType(el) {
		for (const t of LINE_TYPES) if (el.classList.contains(`ChatMessage${t}`)) return t;
		return "Other";
	}

	/** @param {HTMLElement} el */
	function lineText(el) {
		let text = (el.innerText || "").trim();
		const time = el.dataset.time;
		if (time && text.startsWith(time)) text = text.slice(time.length).trim();
		return text;
	}

	/** @param {HTMLElement} el */
	function captureLine(el) {
		if (!session || session.closed || !el.classList?.contains("ChatMessage") || el.classList.contains("chat-room-sep") || el.dataset.fmLogged) return;
		el.dataset.fmLogged = "1";
		const text = lineText(el);
		if (!text) return;
		const type = lineType(el);
		const sender = parseInt(el.dataset.sender || "", 10) || null;
		const key = `${sender}|${type}|${text}`;
		const now = Date.now();
		if (recentLines.some(([k, t]) => k === key && now - t < 1500)) return;
		recentLines.push([key, now]);
		if (recentLines.length > 40) recentLines.shift();
		lineQueue.push({ session: session.id, owner: session.owner, ts: now, type, sender, senderName: sender ? nameOf(sender) : "", text });
		if (!lineFlushTimer) lineFlushTimer = setTimeout(flushLines, 500);
	}

	function flushLines() {
		clearTimeout(lineFlushTimer);
		lineFlushTimer = undefined;
		const batch = lineQueue;
		lineQueue = [];
		if (!batch.length) return;
		const cur = session;
		const mine = cur ? batch.filter((m) => m.session === cur.id) : [];
		if (cur && mine.length) {
			cur.count += mine.length;
			cur.end = mine[mine.length - 1].ts;
		}
		const snap = cur && mine.length ? { ...cur, members: { ...cur.members }, colors: { ...cur.colors } } : null;
		withDb(() => {
			const t = openDb().transaction(["roomMsgs", "sessions"], "readwrite");
			const store = t.objectStore("roomMsgs");
			for (const m of batch) store.add(m);
			if (snap) t.objectStore("sessions").put(snap);
			t.onerror = () => console.warn(TAG, "chat log write failed", t.error);
			t.oncomplete = () => ui.onRoomLines(batch);
		});
	}

	// ---------- chat: beeps and whispers ----------

	// Beeps carry the game's metadata (message id, colour, reply/reaction) after a separator character
	/** @param {unknown} raw */
	function parseBeepMessage(raw) {
		if (typeof raw !== "string") return { text: "", meta: null };
		try {
			if (typeof FriendListBeepParseMessage === "function") {
				const p = FriendListBeepParseMessage(raw);
				return { text: p.text || "", meta: p.metadata || null };
			}
		} catch {
			// not critical: carries on without it
		}
		return { text: raw, meta: null };
	}

	/** @param {LBBDm} rec */
	function addDm(rec) {
		if (!prefs.logChats || !me() || typeof rec.member !== "number") return;
		rec.owner = me();
		const key = `${rec.owner}:${rec.member}`;
		withDb(() => {
			const t = openDb().transaction(["dms", "convs"], "readwrite");
			t.objectStore("dms").add(rec);
			const convs = t.objectStore("convs");
			const req = convs.get(key);
			req.onsuccess = () => {
				const c = req.result || { key, owner: rec.owner, member: rec.member, unread: 0 };
				if (rec.name) c.name = rec.name;
				if (rec.kind !== "reaction") {
					c.lastTs = rec.ts;
					c.lastText = rec.text || (rec.kind === "ping" ? "(beep)" : "");
					c.lastDir = rec.dir;
				}
				if (rec.dir === "in" && rec.kind !== "reaction") {
					if (!ui.isViewingConv(rec.member)) c.unread = (c.unread || 0) + 1;
					// A hidden chat comes back when they message you again
					c.hidden = false;
				}
				convs.put(c);
			};
			t.oncomplete = () => {
				ui.onDm(rec);
				notifyDm(rec);
			};
			t.onerror = () => console.warn(TAG, "message write failed", t.error);
		});
	}

	// A friend you flagged with 🔔 came online: a desktop notification while the game tab is in the background,
	// otherwise a line in your chat that only you see
	/** @param {any} f a friend as the server lists them */
	function notifyOnline(f) {
		if (!prefs.notifyOnline || !bells.has(f.MemberNumber)) return;
		const name = f.MemberName || `#${f.MemberNumber}`;
		const where = f.ChatRoomName ? `in “${f.ChatRoomName}”` : "not in a room";
		// Desktop notification whenever you aren't looking at the game (another tab, another app, minimized)
		const desktop = notAtGame() && canNotify();
		if (desktop) {
			const n = new Notification(`${name} is online`, { body: where, tag: `fm-online-${f.MemberNumber}` });
			n.onclick = () => {
				window.focus();
				ui.open(f.MemberNumber, "profiles").catch((err) => console.warn(TAG, err));
				n.close();
			};
		}
		// ...and a line in your chat (only you see it), so it's there when you come back
		if (typeof ChatRoomSendLocal === "function" && inRoom()) ChatRoomSendLocal(`🔔 ${name} (${f.MemberNumber}) is online, ${where}.`, 60_000);
		console.info(TAG, `${name} (${f.MemberNumber}) came online, ${where}; ${desktop ? "desktop notification" : notAtGame() ? `no desktop notification (${quieted() ? "muted by Quiet" : `notifications ${typeof Notification === "undefined" ? "unsupported" : Notification.permission}`})` : "game in front, chat line only"}`);
	}
	// Not looking at the game: its tab is in the background, or the browser window isn't the active app
	const notAtGame = () => document.hidden || !document.hasFocus();
	const canNotify = () => typeof Notification !== "undefined" && Notification.permission === "granted" && !quieted();
	// The Quiet add-on (if installed) has notifications muted in this tab. Settings' test button ignores this.
	const quieted = () => {
		try {
			return window.Quiet?.isMuted?.() === true;
		} catch {
			return false;
		}
	};
	// Members flagged 🔔 on this account (kept here, outside the panel, so it works with the panel closed)
	let bells = new Set();
	/** @type {number | null} */
	let bellsFor = null;
	function loadBells() {
		const owner = me();
		bellsFor = owner;
		dbAllForOwner(owner)
			.then((all) => owner === me() && (bells = new Set(all.filter((r) => r.notifyOnline).map((r) => r.member))))
			.catch(() => (bellsFor = null));
	}
	const watchedOnline = () => prefs.notifyOnline && bells.size > 0;

	// Desktop notification for incoming messages while the game tab is in the background
	/** @param {LBBDm} rec */
	function notifyDm(rec) {
		if (rec.dir !== "in" || !notAtGame() || !canNotify()) return;
		const isWhisper = rec.kind === "whisper";
		if (isWhisper ? !prefs.notifyWhispers : !(prefs.notifyBeeps && (rec.kind === "beep" || rec.kind === "ping"))) return;
		const n = new Notification(`${isWhisper ? "Whisper" : "Beep"} from ${rec.name || `#${rec.member}`}`, {
			body: rec.kind === "ping" ? "(beep)" : rec.text,
			tag: `fm-${rec.member}`,
		});
		n.onclick = () => {
			window.focus();
			ui.open(rec.member, "chats").catch((err) => console.warn(TAG, err));
			n.close();
		};
	}

	/**
	 * @param {any} data the beep
	 * @param {"in" | "out"} dir
	 */
	function captureBeep(data, dir) {
		if (!data || typeof data.MemberNumber !== "number" || (data.BeepType && data.BeepType !== "")) return;
		const { text, meta } = parseBeepMessage(data.Message);
		addDm({
			member: data.MemberNumber,
			name: dir === "in" ? data.MemberName : friendNameOf(data.MemberNumber),
			ts: Date.now(),
			dir,
			kind: typeof data.Message !== "string" ? "ping" : meta?.messageType === "Reaction" ? "reaction" : "beep",
			text,
			meta,
			room: dir === "in" ? data.ChatRoomName || "" : data.IsSecret ? "" : currentRoomName(),
		});
	}

	// The game's friend list keeps its own unread flag per beep (shown as red unread counts on its Beeps
	// chats). Reading the conversation here clears those too, using the same rule as the game's own reader.
	/** @param {number} member */
	function markGameBeepsRead(member) {
		if (!prefs.syncGameRead || typeof FriendListBeepLog === "undefined" || !Array.isArray(FriendListBeepLog)) return;
		member = Number(member);
		let changed = false;
		for (const b of FriendListBeepLog) {
			if (b && Number(b.MemberNumber) === member && !b.Sent && b.Read === false) {
				b.Read = true;
				changed = true;
			}
		}
		if (!changed) return;
		if (typeof NotificationReset === "function" && typeof NotificationEventType !== "undefined") {
			try {
				NotificationReset(NotificationEventType.BEEP);
			} catch {
				// already done or gone: nothing to undo
			}
		}
		refreshGameFriendList(member);
	}

	// The game's friend list only redraws on its own events; if it's open, redraw it after we change its beep log
	/** @param {number} [member] */
	function refreshGameFriendList(member) {
		try {
			if (typeof CurrentScreen === "undefined" || CurrentScreen !== "FriendList") return;
			if (typeof FriendListBeepChatKey !== "undefined" && FriendListBeepChatKey === `member:${member}` && typeof FriendListBeepChat === "function") FriendListBeepChat(FriendListBeepChatKey);
			else ServerSend("AccountQuery", { Query: "OnlineFriends" }); // reloads the list with its unread counts
		} catch (e) {
			console.warn(TAG, "friend list refresh failed", e);
		}
	}

	/** Unread beeps as the game sees them (for checking the read sync from the console) */
	function gameUnread() {
		if (typeof FriendListBeepLog === "undefined") return null;
		/** @type {Record<number, number>} */
		const out = {};
		for (const b of FriendListBeepLog) {
			if (b && !b.Sent && b.Read === false && typeof b.MemberNumber === "number" && (typeof FriendListBeepIsUnread !== "function" || FriendListBeepIsUnread(b))) out[b.MemberNumber] = (out[b.MemberNumber] || 0) + 1;
		}
		return out;
	}

	/**
	 * @param {number} member
	 * @param {string} text
	 * @param {"in" | "out"} dir
	 */
	function captureWhisper(member, text, dir) {
		if (typeof member !== "number" || typeof text !== "string") return;
		addDm({ member, name: nameOf(member), ts: Date.now(), dir, kind: "whisper", text, meta: null, room: currentRoomName() });
	}

	/**
	 * @param {number} member
	 * @param {string} text
	 * @param {boolean} includeRoom
	 */
	function sendBeep(member, text, includeRoom) {
		if (typeof ServerSendBeepMessage === "function") {
			ServerSendBeepMessage(member, text, { includeRoom });
			showSentBeepInChat(member, text);
			showSentBeepInWceIm(member, text);
			refreshGameFriendList(member);
		} else ServerSend("AccountBeep", { MemberNumber: member, BeepType: "", IsSecret: !includeRoom, Message: text });
	}

	// WCE's instant messenger records outgoing beeps by watching ServerSend("AccountBeep"), but skips any
	// message carrying the  metadata line, which the game's ServerSendBeepMessage always adds. So we
	// hand WCE a plain copy through ServerSend, and the hook below stops that copy before it reaches the server.
	const WCE_IM_COPY = "__fmWceImCopy";
	mod.hookFunction("ServerSend", -100, (args, next) => {
		if (args[0] === "AccountBeep" && /** @type {any} */ (args[1])?.[WCE_IM_COPY]) return;
		return next(args);
	});
	// The copy must never reach the server as a second beep, so it's only made while the hook above is in place
	function ourBeepBlockerActive() {
		try {
			// Our hook is registered, and ServerSend is still the SDK's entry point (nothing has replaced it since)
			const info = bcModSdk.getPatchingInfo?.().get("ServerSend");
			return !!info && info.hookedByMods.includes(MOD_INFO.name) && !!info.sdkEntrypoint && info.currentEntrypoint === info.sdkEntrypoint;
		} catch {
			return false;
		}
	}
	/**
	 * @param {number} member
	 * @param {string} text
	 */
	function showSentBeepInWceIm(member, text) {
		if (!document.getElementById("bce-instant-messenger") || typeof ServerSend !== "function") return;
		if (!ourBeepBlockerActive()) return;
		try {
			ServerSend("AccountBeep", /** @type {ServerAccountBeepRequest} */ ({ MemberNumber: member, BeepType: "", IsSecret: true, Message: text, [WCE_IM_COPY]: true }));
		} catch (e) {
			console.warn(TAG, "couldn't add the sent beep to WCE's messenger", e);
		}
	}

	// The game's /beep command writes "Beep to …" into the chat room log; sending through
	// ServerSendBeepMessage doesn't, so add the same line (same look, reply arrow and link) ourselves.
	/**
	 * @param {number} target
	 * @param {string} msg
	 */
	function showSentBeepInChat(target, msg) {
		if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom" || typeof ChatRoomAppendChat !== "function") return;
		const targetName = Player.FriendNames?.get?.(target) || nameOf(target) || `#${target}`;
		const shown = msg.length > 150 ? `${msg.substring(0, 150)}…` : msg;
		try {
			const beepId = FriendListBeepLog.length - 1;
			const link = document.createElement("a");
			link.id = `#beep-${beepId}`;
			link.classList.add("beep-link");
			link.onclick = (e) => {
				e.preventDefault();
				if (typeof FriendListShowBeep === "function") FriendListShowBeep(beepId);
			};
			let label = "";
			try {
				label = CommonStringSubstitute(TextGet("CommandBeepLink"), [["{NAME}", targetName], ["{NUMBER}", String(target)], ["{MESSAGE}", shown]]);
			} catch {
				// not available in this game or browser: the fallback is used
			}
			link.textContent = label && !label.startsWith("MISSING") ? label : `Beep to ${targetName} (${target}): ${shown}`;
			const div = document.createElement("div");
			div.classList.add("ChatMessage", "ChatMessageLocalMessage", "ChatMessageNonDialogue", "ChatMessageBeep");
			div.dataset.time = typeof ChatRoomCurrentTime === "function" ? ChatRoomCurrentTime() : "";
			div.dataset.sender = String(Player.MemberNumber);
			div.dataset.target = String(target);
			if (typeof ElementButton !== "undefined" && ElementButton.Create) {
				const reply = ElementButton.Create(
					`beep-reply-${beepId}`,
					() => {
						ElementValue("InputChat", `/beep ${target} ${ElementValue("InputChat").replace(/^\/(beep|w) \S+ ?/u, "")}`);
						document.getElementById("InputChat")?.focus();
					},
					{ noStyling: true },
					{ button: { classList: ["ReplyButton"], children: ["↩️"] } }
				);
				div.append(reply);
			}
			div.append(link);
			ChatRoomAppendChat(div);
		} catch (e) {
			console.warn(TAG, "couldn't add the sent beep to the chat log", e);
			if (typeof ChatRoomSendLocal === "function") ChatRoomSendLocal(`Beep to ${targetName} (${target}): ${shown}`);
		}
	}

	// ---------- outbox: beeps held until the person is online ----------
	// Beeps to offline players are dropped by the server, so these wait in the account's meta store ("outbox:<id>")
	// and go out once the person shows up in the online-friends list or walks into your room. Needs the game open.

	/** @type {LBBMeta[]} */
	let outbox = [];
	let delivering = false;
	const OUTBOX_POLL_MS = 60_000;

	async function loadOutbox() {
		outbox = (await reqDone(storeOf("meta").getAll(IDBKeyRange.bound("outbox:", "outbox:￿")))).sort((/** @type {LBBMeta} */ a, /** @type {LBBMeta} */ b) => a.createdAt - b.createdAt);
	}

	function reachableNow() {
		const here = typeof ChatRoomCharacter !== "undefined" && inRoom() ? ChatRoomCharacter.map((c) => c.MemberNumber) : [];
		return new Set([...onlineFriends.keys(), ...here]);
	}

	/**
	 * @param {number} member
	 * @param {string} text
	 * @param {boolean} includeRoom
	 */
	async function queueMessage(member, text, includeRoom) {
		await ensureDb();
		const createdAt = Date.now();
		const rec = { key: `outbox:${createdAt}-${member}`, member, text, includeRoom: !!includeRoom, createdAt };
		await reqDone(storeOf("meta", "readwrite").put(rec));
		outbox.push(rec);
		ui.onOutboxChanged();
		requestOnlineFriends();
	}

	/** @param {string} key */
	async function cancelQueued(key) {
		await ensureDb();
		await reqDone(storeOf("meta", "readwrite").delete(key));
		outbox = outbox.filter((m) => m.key !== key);
		ui.onOutboxChanged();
	}

	// Sends whatever is waiting for people who are reachable right now, oldest first, a little apart
	// Automatic delivery can be switched off in Settings; force is the "Send now" button
	async function deliverOutbox(force = false) {
		if ((!prefs.outboxAutoSend && !force) || delivering || !outbox.length || !db || dbOwner !== me()) return;
		delivering = true;
		try {
			const reachable = reachableNow();
			for (const m of outbox.filter((x) => reachable.has(x.member))) {
				if (dbOwner !== me()) break;
				// Taken off the queue before it's sent: if removing it fails, it stays queued unsent instead of
				// going out a second time later
				await reqDone(storeOf("meta", "readwrite").delete(m.key));
				outbox = outbox.filter((x) => x.key !== m.key);
				sendBeep(m.member, m.text, m.includeRoom);
				ui.onOutboxChanged();
				await sleep(Math.max(1, prefs.groupGapSec || 1.5) * 1000);
			}
		} catch (e) {
			console.warn(TAG, "outbox delivery failed", e);
		} finally {
			delivering = false;
		}
	}

	// ---------- data management (Settings page) ----------

	const DAY_MS = 86_400_000;
	let lastPrune = 0;

	// Drops room visits and chat messages older than the retention set in Settings (0 days = keep forever)
	async function pruneOldData() {
		lastPrune = Date.now();
		try {
			await ensureDb();
			const owner = me();
			let removed = 0;
			if (prefs.roomLogDays > 0) {
				const cutoff = Date.now() - prefs.roomLogDays * DAY_MS;
				const old = (await reqDone(storeOf("sessions").index("owner").getAll(owner))).filter((/** @type {LBBSession} */ x) => (x.end || x.start) < cutoff && x.id !== session?.id);
				for (const v of old) {
					const t = openDb().transaction(["sessions", "roomMsgs"], "readwrite");
					const keys = await reqDone(t.objectStore("roomMsgs").index("session").getAllKeys(v.id));
					for (const k of keys) t.objectStore("roomMsgs").delete(k);
					t.objectStore("sessions").delete(v.id);
					await txDone(t);
					removed += keys.length;
				}
			}
			if (prefs.chatDays > 0) {
				const cutoff = Date.now() - prefs.chatDays * DAY_MS;
				const t = openDb().transaction(["dms", "convs"], "readwrite");
				const keys = await reqDone(t.objectStore("dms").index("ownerTs").getAllKeys(IDBKeyRange.bound([owner, 0], [owner, cutoff])));
				for (const k of keys) t.objectStore("dms").delete(k);
				// Conversations with nothing left go too, unless pinned or unread
				const convList = await reqDone(t.objectStore("convs").index("owner").getAll(owner));
				for (const c of convList) if ((c.lastTs || 0) < cutoff && !c.pinned && !c.unread) t.objectStore("convs").delete(c.key);
				await txDone(t);
				removed += keys.length;
			}
			if (removed) {
				console.log(TAG, `removed ${removed} logged messages past their retention`);
				ui.refreshSoon();
			}
		} catch (e) {
			console.warn(TAG, "cleanup failed", e);
		}
	}

	/** @type {Record<string, string[]>} */
	const DATA_KINDS = {
		rooms: ["sessions", "roomMsgs"],
		chats: ["dms", "convs"],
		profiles: ["profiles"],
	};

	// Row counts per kind of data for this account, plus what the browser says this site uses in total
	async function storageStats() {
		await ensureDb();
		const count = (/** @type {string} */ name) => reqDone(storeOf(name).count());
		const [sessions, roomMsgs, dms, convs, profiles, meta] = await Promise.all(["sessions", "roomMsgs", "dms", "convs", "profiles", "meta"].map(count));
		// The browser only reports the whole site (the game, its asset cache and every add-on), split by kind
		/** @type {number | null} */
		let usage = null;
		/** @type {Record<string, number> | null} */
		let details = null;
		/** @type {string[]} */
		let databases = [];
		try {
			const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
			usage = est?.usage ?? null;
			details = /** @type {any} */ (est)?.usageDetails || null;
		} catch {
			// not available in this game or browser: the fallback is used
		}
		try {
			databases = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).filter(Boolean).sort() : [];
		} catch {
			// not available in this game or browser: the fallback is used
		}
		return { sessions, roomMsgs, dms, convs, profiles, meta, usage, details, databases };
	}

	// Empties one kind of data ("rooms" | "chats" | "profiles"), or everything for this account ("all").
	// Settings survive "all"; queued outbox messages and saved outfits/groups don't.
	/** @param {string} kind all, rooms, chats or profiles */
	async function clearData(kind) {
		await ensureDb();
		flushLines();
		const names = kind === "all" ? ["sessions", "roomMsgs", "dms", "convs", "profiles", "meta"] : DATA_KINDS[kind];
		const t = openDb().transaction(names, "readwrite");
		for (const n of names) t.objectStore(n).clear();
		if (kind === "all") {
			t.objectStore("meta").put({ key: "prefs", ...prefs });
			// Don't move data from before the rename back in on the next login
			t.objectStore("meta").put({ key: "migrated", at: Date.now(), from: null });
		}
		await txDone(t);
		// A room being logged right now carries on as a fresh log
		if (session && !session.closed && (kind === "rooms" || kind === "all")) {
			session.count = 0;
			saveSession();
		}
		if (kind === "all") outbox = [];
		ui.onDataCleared();
	}

	// Export files leave out what other people made of themselves (description, outfit, crafts) and outfits saved
	// from them, unless Settings -> Full exports is on. Your own data always goes in whole.
	/** @param {LBBProfile} r */
	function trimProfileForExport(r) {
		if (prefs.exportFull || !r || r.member === me() || !r.data) return r;
		const data = { ...r.data };
		delete data.Description;
		delete data.Appearance;
		delete data.Crafting;
		return { ...r, data, trimmed: true };
	}
	const exportableMeta = (/** @type {LBBMeta} */ m) => prefs.exportFull || !String(m?.key || "").startsWith("outfit:") || m.from == null || m.from === me();

	// Every store for this account in one JSON file
	async function exportEverything() {
		await ensureDb();
		/** @type {{ format: string, version: number, owner: number, exported: number, full: boolean, stores: Record<string, any[]> }} */
		const out = { format: "BlackBookBackup", version: 1, owner: me(), exported: Date.now(), full: !!prefs.exportFull, stores: {} };
		for (const n of ["profiles", "sessions", "roomMsgs", "dms", "convs", "meta"]) out.stores[n] = await reqDone(storeOf(n).getAll());
		out.stores.profiles = out.stores.profiles.map(trimProfileForExport);
		out.stores.meta = out.stores.meta.filter(exportableMeta);
		download(`friendmgr-backup-${me()}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out), "application/json");
	}


	// ---------- account sync (small things follow you to other computers) ----------
	// Settings, friend groups, notes, favorite profiles and rooms, pinned/hidden chats and your own saved outfits go
	// into the game's private per-account add-on storage (Player.ExtensionSettings, never shown to other players).
	// Each item carries the time it last changed; when two computers disagree the newer change wins. Logs, cached
	// profiles of other people, outfits saved from them and queued messages stay on each computer.
	// Changes made on another computer arrive at your next login (the game loads this storage at login).
	const SYNC_KEY = "BlackBookSync";
	const OLD_SYNC_KEY = "FriendMgrSync"; // read when the new key isn't there yet, cleared once the new one is saved
	const SYNC_LIMIT = 120_000; // characters after compression; outfits are left out above this
	const SYNC_LOCAL_PREFS = ["syncAccount"]; // per computer, never synced
	const TOMBSTONE_DAYS = 120;
	let syncDirty = false;
	let syncBusy = false;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let syncTimer;
	/** @type {{ at: number, items: number, size: number, note: string, applied?: number, uploaded?: boolean }} */
	let syncStatus = { at: 0, items: 0, size: 0, note: "" };

	function markSyncDirty() {
		if (syncBusy || !prefs.syncAccount) return;
		syncDirty = true;
		clearTimeout(syncTimer);
		syncTimer = setTimeout(() => syncAccount().catch((err) => console.warn(TAG, "sync failed", err)), 10_000);
	}

	// Short stable fingerprint of a value, to notice what changed since the last sync
	/** @param {unknown} v */
	function syncHash(v) {
		const str = JSON.stringify(v ?? null);
		let hash = 5381;
		for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
		return `${str.length}:${hash >>> 0}`;
	}

	// What this computer has now, as { itemKey: value }; anything missing means empty/off/deleted
	async function syncCollect() {
		await ensureDb();
		const owner = me();
		const [profiles, convs, metaAll] = await Promise.all([dbAllForOwner(owner), reqDone(storeOf("convs").index("owner").getAll(owner)), reqDone(storeOf("meta").getAll())]);
		/** @type {Record<string, any>} */
		const items = {};
		const p = { ...prefs };
		for (const k of SYNC_LOCAL_PREFS) delete p[k];
		delete p.key;
		items.prefs = p;
		const groups = /** @type {LBBMeta[]} */ (metaAll).find((m) => m.key === "groups");
		if (groups && (groups.groups?.length || Object.keys(groups.members || {}).length)) items.groups = { groups: groups.groups || [], members: groups.members || {} };
		const favRoomsRec = /** @type {LBBMeta[]} */ (metaAll).find((m) => m.key === "favRooms");
		if (favRoomsRec?.names?.length) items.favRooms = [...favRoomsRec.names].sort();
		for (const r of profiles) {
			if (r.note) items[`note:${r.member}`] = r.note;
			if (r.fav) items[`fav:${r.member}`] = true;
			if (r.notifyOnline) items[`bell:${r.member}`] = true;
		}
		for (const c of convs) {
			if (c.pinned) items[`pin:${c.member}`] = true;
			if (c.hidden) items[`hide:${c.member}`] = true;
		}
		for (const m of metaAll) {
			if (!String(m.key).startsWith("outfit:") || (m.from != null && m.from !== owner)) continue;
			const { key: _key, ...o } = m;
			items[`outfit:${m.id}`] = o;
		}
		return items;
	}

	// Puts one item from another computer into this one's database
	/**
	 * @param {string} key
	 * @param {any} val
	 */
	async function syncApply(key, val) {
		const owner = me();
		const colon = key.indexOf(":");
		const kind = colon < 0 ? key : key.slice(0, colon);
		const id = colon < 0 ? null : key.slice(colon + 1);
		if (kind === "prefs") {
			const keep = Object.fromEntries(SYNC_LOCAL_PREFS.map((k) => [k, prefs[k]]));
			prefs = { ...PREF_DEFAULTS, ...(val || {}), ...keep };
			await reqDone(storeOf("meta", "readwrite").put({ key: "prefs", ...prefs }));
			applyPrefs();
		} else if (kind === "groups") {
			await reqDone(storeOf("meta", "readwrite").put({ key: "groups", groups: val?.groups || [], members: val?.members || {} }));
		} else if (kind === "favRooms") {
			await reqDone(storeOf("meta", "readwrite").put({ key: "favRooms", names: Array.isArray(val) ? val : [] }));
		} else if (kind === "note" || kind === "fav" || kind === "bell") {
			const member = Number(id);
			const k = keyFor(member);
			const rec = (await dbGet(k)) || (val ? { key: k, owner, member, firstSeen: Date.now(), note: "", modMessages: {} } : null);
			if (!rec) return;
			if (kind === "note") rec.note = val || "";
			else if (kind === "bell") {
				rec.notifyOnline = !!val;
				if (rec.notifyOnline) bells.add(member);
				else bells.delete(member);
			}
			else rec.fav = !!val;
			await dbPut(rec);
		} else if (kind === "pin" || kind === "hide") {
			const member = Number(id);
			const k = `${owner}:${member}`;
			const c = (await reqDone(storeOf("convs").get(k))) || (val ? { key: k, owner, member, unread: 0 } : null);
			if (!c) return;
			c[kind === "pin" ? "pinned" : "hidden"] = !!val;
			await reqDone(storeOf("convs", "readwrite").put(c));
		} else if (kind === "outfit") {
			if (val) await reqDone(storeOf("meta", "readwrite").put({ ...val, key: `outfit:${id}` }));
			else await reqDone(storeOf("meta", "readwrite").delete(`outfit:${id}`));
		}
	}

	function syncReadRemote() {
		try {
			const raw = Player.ExtensionSettings?.[SYNC_KEY] || Player.ExtensionSettings?.[OLD_SYNC_KEY];
			if (typeof raw !== "string" || !raw) return null;
			const doc = /** @type {any} */ (JSON.parse(LZString.decompressFromUTF16(raw) || "null"));
			return doc && doc.owner === me() && doc.items && typeof doc.items === "object" ? doc : null;
		} catch (e) {
			console.warn(TAG, "couldn't read the synced data", e);
			return null;
		}
	}

	async function syncAccount(force = false) {
		if (!prefs.syncAccount || syncBusy || !me() || !db || dbOwner !== me() || !Player.ExtensionSettings) return;
		if (!force && !syncDirty && syncStatus.at) return;
		syncBusy = true;
		syncDirty = false;
		try {
			const owner = me();
			const now = Date.now();
			const local = await syncCollect();
			const firstRun = !(await reqDone(storeOf("meta").get("syncState")));
			/** @type {{ key: string, h: Record<string, string>, at: Record<string, number> }} */
			const state = (await reqDone(storeOf("meta").get("syncState"))) || { key: "syncState", h: {}, at: {} };
			const remote = syncReadRemote();
			/** @type {Record<string, { at: number, v: any }>} */
			const ritems = remote?.items || {};
			// 1. What changed here since the last sync gets stamped now. On a computer's first sync, things the account
			//    already has are taken from the account rather than overwriting it with this computer's (empty) defaults.
			for (const k of new Set([...Object.keys(local), ...Object.keys(state.h)])) {
				const hv = syncHash(local[k]);
				if (state.h[k] === hv) continue;
				state.h[k] = hv;
				state.at[k] = firstRun && ritems[k] ? 0 : now;
			}
			// 2. Merge, newest change wins; apply what the account has newer
			/** @type {Record<string, { at: number, v: any }>} */
			const merged = {};
			let applied = 0;
			for (const k of new Set([...Object.keys(state.h), ...Object.keys(ritems)])) {
				const r = ritems[k];
				const localAt = state.at[k] || 0;
				if (r && r.at > localAt) {
					if (syncHash(r.v) !== state.h[k]) {
						await syncApply(k, r.v);
						applied++;
					}
					state.at[k] = r.at;
					state.h[k] = syncHash(r.v);
					merged[k] = r;
				} else merged[k] = { at: localAt, v: local[k] ?? null };
			}
			// Deletions are kept a while so other computers learn about them, then forgotten
			for (const [k, it] of Object.entries(merged)) {
				if (it.v == null && now - it.at > TOMBSTONE_DAYS * 86_400_000) {
					delete merged[k];
					delete state.h[k];
					delete state.at[k];
				}
			}
			// 3. Upload if anything differs from what the account has
			/** @type {{ v: number, owner: number, at: number, items: Record<string, { at: number, v: any }>, outfitsLeftOut?: boolean }} */
			let doc = { v: 1, owner, at: now, items: merged };
			let packed = LZString.compressToUTF16(JSON.stringify(doc));
			let note = "";
			if (packed.length > SYNC_LIMIT) {
				const small = Object.fromEntries(Object.entries(merged).filter(([k]) => !k.startsWith("outfit:")));
				doc = { v: 1, owner, at: now, items: small, outfitsLeftOut: true };
				packed = LZString.compressToUTF16(JSON.stringify(doc));
				note = "Saved outfits were too big to sync and stay on this computer.";
			}
			// Also upload when only the old key has the data, so it moves to the new name
			const changed = !remote || !Player.ExtensionSettings[SYNC_KEY] || syncHash(remote.items) !== syncHash(doc.items);
			if (changed && packed.length <= SYNC_LIMIT && typeof ServerPlayerExtensionSettingsSync === "function") {
				Player.ExtensionSettings[SYNC_KEY] = packed;
				ServerPlayerExtensionSettingsSync(SYNC_KEY);
			} else if (packed.length > SYNC_LIMIT) note = "Too much to sync; nothing was uploaded.";
			// Saved under the new name now: empty the old one so the account doesn't carry it around
			if (Player.ExtensionSettings[SYNC_KEY] && Player.ExtensionSettings[OLD_SYNC_KEY] && typeof ServerPlayerExtensionSettingsSync === "function") {
				Player.ExtensionSettings[OLD_SYNC_KEY] = null;
				ServerPlayerExtensionSettingsSync(OLD_SYNC_KEY);
			}
			await reqDone(storeOf("meta", "readwrite").put(state));
			syncStatus = { at: now, items: Object.values(doc.items).filter((x) => x.v != null).length, size: packed.length, note, applied, uploaded: changed };
			if (applied) {
				console.log(TAG, `sync: took ${applied} change(s) from your other computers`);
				ui.refreshSoon();
			}
		} finally {
			syncBusy = false;
		}
	}

	// Copies LianChat's beep/whisper history for this account; safe to run more than once
	async function importLianChat() {
		await ensureDb();
		const owner = me();
		const name = `LCDB_${owner}`;
		const dbs = indexedDB.databases ? await indexedDB.databases() : [];
		if (!dbs.some((d) => d.name === name)) return { error: "No LianChat history found for this account." };
		/** @type {IDBDatabase} */
		const lc = await new Promise((resolve, reject) => {
			const r = indexedDB.open(name);
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error instanceof Error ? r.error : new Error("IndexedDB request failed"));
		});
		try {
			/**
			 * @param {string} s
			 * @returns {Promise<any[]>}
			 */
			const read = (s) => (lc.objectStoreNames.contains(s) ? reqDone(lc.transaction(s).objectStore(s).getAll()) : Promise.resolve([]));
			const [msgs, players] = await Promise.all([read("messages"), read("playerCache")]);
			const names = new Map(players.map((p) => [p.memberNumber, p.Nickname || p.Name]));
			/** @type {LBBDm[]} */
			const recs = [];
			for (const m of msgs) {
				// LianChat: memberNumber is the other person in the conversation, sender is who wrote it
				if (typeof m.memberNumber !== "number") continue;
				const ext = `lc:${m.id}`;
				if (await reqDone(storeOf("dms").index("ext").count(ext))) continue;
				const { text, meta } = parseBeepMessage(m.content);
				const ts = new Date(m.time).getTime() || Date.now();
				recs.push({
					owner,
					member: m.memberNumber,
					name: names.get(m.memberNumber) || friendNameOf(m.memberNumber) || "",
					ts,
					dir: m.sender === owner ? "out" : "in",
					kind: m.type === "Whisper" ? "whisper" : "beep",
					text,
					meta,
					room: "",
					ext,
				});
			}
			if (recs.length) {
				const t = openDb().transaction(["dms", "convs"], "readwrite");
				const dms = t.objectStore("dms");
				const convs = t.objectStore("convs");
				for (const r of recs) dms.add(r);
				/** @type {Map<number, LBBDm>} */
				const latest = new Map();
				for (const r of recs) if ((latest.get(r.member)?.ts ?? -1) < r.ts) latest.set(r.member, r);
				for (const r of latest.values()) {
					const key = `${owner}:${r.member}`;
					const g = convs.get(key);
					g.onsuccess = () => {
						const c = g.result || { key, owner, member: r.member, unread: 0 };
						if (!c.name && r.name) c.name = r.name;
						if (!c.lastTs || c.lastTs < r.ts) {
							c.lastTs = r.ts;
							c.lastText = r.text;
							c.lastDir = r.dir;
						}
						convs.put(c);
					};
				}
				await txDone(t);
			}
			return { added: recs.length, skipped: msgs.length - recs.length };
		} finally {
			lc.close();
		}
	}

	// ---------- server traffic ----------

	// onAny listeners run before the game's own handlers and never change what the game receives
	/**
	 * @param {string} event
	 * @param {any} data
	 */
	const onServerEvent = (event, data) => {
		try {
			if (!data || typeof data !== "object") return;
			if (event === "ChatRoomSync") onRoomSync(data, data.Character);
			if (event === "ChatRoomSyncRoomProperties" && session && !session.closed) {
				const room = roomInfoFrom(data);
				const oldName = session.room.Name;
				logRoomChanges(roomChanges(session.room, room), "Room updated", data.SourceMemberNumber);
				session.room = { ...session.room, ...room };
				// Remember earlier names so logs under the old and new name are shown as one room
				const renamed = room.Name && room.Name !== oldName;
				if (renamed) session.aliases = [...new Set([...(session.aliases || []), oldName])];
				saveSession();
				if (renamed) ui.onRoomRenamed(oldName, room.Name).catch((err) => console.warn(TAG, err));
			}
			if (event === "ChatRoomSyncMemberJoin" && session && !session.closed && data.Character?.MemberNumber) {
				rememberMember(data.Character);
				saveSession();
			}
			// Someone with queued messages may have just walked in (the game adds them to the room right after this)
			if (event === "ChatRoomSync" || event === "ChatRoomSyncMemberJoin") setTimeout(deliverOutbox, 1000);
			if (event === "ChatRoomSync" || event === "ChatRoomSyncRoomProperties") rememberRoom(data);
			if (event === "ChatRoomSyncItem") refreshAppearanceSoon(data.Item?.Target);
			if (FULL_SYNC_EVENTS.has(event)) {
				const chars = Array.isArray(data.Character) ? data.Character : [data.Character];
				for (const c of chars) captureCharacter(c);
			} else if (event === "ChatRoomMessage" && data.Type === "Hidden" && typeof data.Sender === "number") {
				captureHidden(data);
			} else if (event === "ChatRoomMessage" && data.Type === "Whisper" && data.Sender !== me()) {
				captureWhisper(data.Sender, data.Content, "in");
			} else if (event === "AccountBeep") {
				captureBeep(data, "in");
			} else if (event === "AccountQueryResult" && data.Query === "OnlineFriends" && Array.isArray(data.Result)) {
				captureOnlineFriends(data.Result);
			}
		} catch (e) {
			console.warn(TAG, "capture error", event, e);
		}
	};
	/**
	 * @param {string} event
	 * @param {any} data
	 */
	const onClientEvent = (event, data) => {
		try {
			if (event === "ChatRoomLeave") return closeSession();
			if (!data || typeof data !== "object") return;
			if (event === "AccountBeep") captureBeep(data, "out");
			else if (event === "ChatRoomChat" && data.Type === "Whisper") captureWhisper(data.Target, data.Content, "out");
		} catch (e) {
			console.warn(TAG, "capture error", event, e);
		}
	};
	// Our listeners can go missing while the page stays up: after a reconnect the game can hand us a new
	// ServerSocket, and other add-ons have been seen clearing every catch-all listener. Either way nothing
	// gets logged any more, so check every tick and attach again to whatever socket the game uses now.
	const hookedSockets = new Set();
	function watchSocket() {
		const s = typeof ServerSocket !== "undefined" ? ServerSocket : null;
		if (!s || typeof s.onAny !== "function") return;
		let missing = false;
		if (!s.listenersAny?.().includes(onServerEvent)) {
			s.onAny(onServerEvent);
			missing = true;
		}
		if (typeof s.onAnyOutgoing === "function" && !s.listenersAnyOutgoing?.().includes(onClientEvent)) {
			s.onAnyOutgoing(onClientEvent);
			missing = true;
		}
		// The first attach is expected; any later one means they were lost
		if (missing && hookedSockets.size) console.warn(TAG, "the game's connection lost our listeners (reconnect?); listening again");
		hookedSockets.add(s);
	}
	watchSocket();

	function requestOnlineFriends() {
		if (Player.MemberNumber && typeof ServerSend === "function") ServerSend("AccountQuery", { Query: "OnlineFriends" });
	}

	// Uses the game's own request/response search helper, which doesn't touch the search screen.
	// Private rooms never appear in search results.
	/**
	 * @param {string} query
	 * @param {ServerChatRoomSpace} [space]
	 * @returns {Promise<{ error: string, rooms?: undefined } | { error?: undefined, rooms: ServerChatRoomSearchData[] }>}
	 */
	async function searchRooms(query, space) {
		if (typeof ServerRoomSearch !== "function") return { error: "Room search isn't available in this game version." };
		const res = await ServerRoomSearch(query, { Language: "", Space: space || "", Game: "", FullRooms: true, SearchDescs: false });
		if (res.error) return { error: String(res.error.message || res.error) };
		return { rooms: Array.isArray(res.value) ? res.value : [] };
	}

	/** @type {Record<string, string>} */
	const JOIN_ERRORS = {
		RoomFull: "The room is full.",
		RoomLocked: "The room is locked.",
		RoomBanned: "You're banned from that room.",
		RoomKicked: "You were kicked from that room.",
		CannotFindRoom: "That room isn't open right now.",
		InvalidRoomData: "The room couldn't be joined.",
	};

	// Same path the game's leash feature uses: the space/blocked-item checks, the room search screen, then ServerRoomJoin.
	// The game's own ChatRoomSync handler moves you into the room once the server accepts.
	/**
	 * @param {string} name
	 * @param {any} [room] what the search said about it
	 */
	async function joinRoom(name, room) {
		if (inRoom()) return { error: "Leave your current room first." };
		if (typeof ServerRoomJoin !== "function") return { error: "Joining isn't available in this game version." };
		if (room) {
			if (typeof ChatSelectGendersAllowed === "function" && room.Space != null && !ChatSelectGendersAllowed(room.Space, Player.GetGenders()))
				return { error: "That room's space doesn't allow your character." };
			if (typeof CharacterHasBlockedItem === "function" && Array.isArray(room.BlockCategory) && CharacterHasBlockedItem(Player, room.BlockCategory))
				return { error: "You're wearing something that room blocks." };
		}
		if (CurrentScreen !== "ChatSearch") {
			if (typeof ChatRoomStart !== "function") return { error: "Couldn't open the room search screen." };
			ChatRoomStart(room?.Space ?? "X", "", null, null, "Introduction", typeof BackgroundsTagList !== "undefined" ? /** @type {any} */ (BackgroundsTagList) : undefined);
			// (the game changes the screen while we wait)
			const screen = () => /** @type {string} */ (CurrentScreen);
			for (let i = 0; i < 50 && screen() !== "ChatSearch"; i++) await sleep(100);
			if (screen() !== "ChatSearch") return { error: "Couldn't open the room search screen." };
		}
		const res = await ServerRoomJoin(name);
		if (res.error) {
			const code = res.error.name && res.error.name !== "Error" ? res.error.name : String(res.error.message || "");
			return { error: JOIN_ERRORS[code] || JOIN_ERRORS[res.error.message] || `Couldn't join: ${code || res.error}` };
		}
		return { ok: true };
	}

	/**
	 * @param {string} name
	 * @param {ServerChatRoomSpace} [space]
	 */
	async function lookupRoom(name, space) {
		const res = await searchRooms(name, space);
		if (res.error !== undefined) return res;
		const room = res.rooms.find((r) => r.Name === name) || res.rooms.find((r) => r.Name.toUpperCase() === name.toUpperCase());
		return room ? { room, at: Date.now() } : { error: "Room not found in search (it may be private, hidden or just closed)." };
	}

	// ---------- add-on detection ----------
	// Other players' add-ons are only visible through what they put in the room: keys in their shared settings
	// and hidden chat messages they send. Both are already cached per profile.

	// Shared-settings keys that belong to the game itself
	const GAME_SHARED_KEYS = new Set([
		"GameVersion",
		"AllowFullWardrobeAccess",
		"AllowPlayerLeashing",
		"AllowRename",
		"BlockBodyCosplay",
		"DisablePickingLocksOnSelf",
		"ItemsAffectExpressions",
		"LockTimerLimit",
		"ScriptPermissions",
		"WheelFortune",
	]);
	/** @type {Record<string, string>} */
	const SHARED_ADDONS = {
		MBS: "MBS",
		MBSVersion: "MBS",
		LCData: "LianChat",
		AEE: "Liko AEE",
		UBC: "ULTRAbc",
		UBCShared: "ULTRAbc",
		Tplist: "ULTRAbc",
		Ulist: "ULTRAbc",
		Uwall: "ULTRAbc",
		AFC: "AFC",
		AFC_HeartLock: "AFC",
		EBC: "EBC",
		XSA: "XSA",
		HSC: "HSC",
		BCC: "BCC",
		MBCFS: "MBCFS",
		FCM: "FCM",
		PCM: "PCM",
		LikoTOOL: "Liko Tool",
	};
	/** @type {Record<string, string>} */
	const MESSAGE_ADDONS = {
		BCXMsg: "BCX",
		BCEMsg: "WCE",
		LSCGMsg: "LSCG",
		bctMsg: "BCTweaks",
		BCP: "BCP",
		BCC: "BCC",
		DOGS: "DOGS",
		MPA: "MPA",
		SecretPrisonMsg: "Secret Prison",
		HSC_Changed: "HSC",
		LCPlayerInfo: "LianChat",
		LCTypingStatus: "LianChat",
		HypnoMsg: "ECHS", // Erotic Chat Hypnosis Suite's hidden messages (its HIDDEN_TAG)
		ABCL: "ABCL",
		Seidr: "Seidr",
		MoonCE: "MoonCEBC",
		SlimeBeep: "SlimeBeep",
	};
	// Message names that carry more after a fixed start (a version, a sub-type)
	/** @type {[RegExp, string][]} */
	const MESSAGE_PREFIXES = [
		[/^KIKILINK\b/, "KikiLink"],
		[/^HSC_/, "HSC"],
		[/^BCNekoEnhancer\./, "BCNeko"],
		[/^PCM_/, "PCM"],
	];
	const messageAddon = (/** @type {string} */ key) => MESSAGE_ADDONS[key] || MESSAGE_PREFIXES.find(([re]) => re.test(key))?.[1] || null;

	// From FUSAM's add-on manifest (sidiousious.gitlab.io/bc-addon-loader/manifest.json), checked 2026-11-06:
	// [id, name, website, repository, description, other names]
	/** @type {[string, string, string, string, string, string[]][]} */
	const ADDON_DIRECTORY = [
		["WCE", "Wholesome Club Extensions (WCE)", "https://wce-docs.vercel.app", "https://github.com/KittenApps/WCE", "Smarter, extensible facial animation and posing engine, instant messaging, appearance layering and a collection of quality of life improvements - A fork of F…", []],
		["BCX", "Bondage Club Extended (BCX)", "https://jomshir98.github.io/bondage-club-extended/", "https://github.com/Jomshir98/bondage-club-extended", "Adds rules, curses, and more to enhance D/s play alongside a handful of quality of life improvements", []],
		["Themed", "Themed", "", "https://github.com/dDeepLb/Themed-BC", "Adds custom themes to BC along with other features", []],
		["ADCS", "Advanced Drone Control System (ADCS)", "https://dynilath.gitlab.io/SaotomeToyStore/en/Plugins/ADCS", "https://gitlab.com/dynilath/BCADCS", "Expansion of Drone gameplay", []],
		["ABCL", "ABCL", "", "https://github.com/zoe-64/ABCL/", "An ABDL addon that adds mechanics towards human body functions like bladder and bowels. Also makes the experience more immersive and interactive. Littlish Cl…", []],
		["BRBD", "BCX Reset Button Disabler", "", "https://github.com/ciberweaboo/brbd", "A very simple addon that disables the Module and Reset Buttons from BCX. That means you can have a new layer of helplessness.", []],
		["BCAR", "Bondage Club Auto React (BCAR)", "https://github.com/DrBranestawm/BCAR/wiki", "https://github.com/drbranestawm/bcar", "Automatically reacts to messages in the Bondage Club", []],
		["BC-XToys", "Bondage Club X-Toys Integration", "https://github.com/ItsNorin/Bondage-Club-XToys-Integration#readme", "https://github.com/ItsNorin/Bondage-Club-XToys-Integration", "Sync club interactions and toys with IRL remote-controlled toys, recommended use with https://github.com/itsFro/BCBridge", []],
		["BCT", "BCTweaks", "", "https://github.com/agicitag/BCTweaks", "Split arousal and orgasm bars, tail wagging, and Best Friends", []],
		["ciamod", "CIA (Community Information Addon)", "", "https://gitgud.io/cia/cia-bc", "This set of scripts adds several chat commands to BC. The commands work in conjunction with a central database of players managed by members of the community…", []],
		["EBCH", "Eli's Bondage Club Helper (EBCH)", "https://zorgjbe.gitlab.io/ebch/", "https://gitlab.com/zorgjbe/ebch", "Ungarble, custom notifications, altering other player's poses", []],
		["LSCG", "Little Sera's Club Games (LSCG)", "https://github.com/littlesera/LSCG/wiki", "https://github.com/littlesera/LSCG", "Adds custom activities, large gamified systems for hypnotism, breathplay, magic, and much more", []],
		["MBCHC", "Mute's Bondage Club Hacks Collection (MBCHC)", "", "https://code.fleshless.org/mute/MBCHC/", "Autohack, local time, some keyboard goodies etc.", []],
		["MBS", "Maid's Bondage Scripts (MBS)", "", "https://github.com/bananarama92/MBS", "Additional crafting slots, additional options in wheel of fortune, and custom outfits in wheel of fortune", []],
		["Responsive", "Responsive", "https://github.com/ProtoKink/Responsive/wiki", "https://github.com/ProtoKink/Responsive", "Automatically sends messages when the user reaches a certain state (slapped, orgasm, etc).", []],
		["ULTRAbc", "ULTRAbc", "", "https://github.com/tetris245/ULTRAbc", "A large collection of cheats, quality of life improvements, and a moaner script", []],
		["NotifyPlus", "NotifyPlus", "https://dynilath.gitlab.io/SaotomeToyStore/en/Plugins/NotifyPlus", "https://github.com/dynilath/BCNotifyPlus", "Improve the Name Mentioned notification in the original BC. Use keywords for mentioning names according to different roles.", []],
		["TTS", "TTS and Morse", "", "https://gitlab.com/KatKammand/tts", "Text-to-speech reading for chat messages, and some buttplug.io + morse functionalities.", []],
		["CATS", "CATS (Chat Auto Translator Script)", "", "https://github.com/ProtoKink/CATS", "Addon that auto-translates the chat to the language you want. 130+ Languages available. Commands: /ttoggle to toggle the translator on and off. And /tlang <l…", []],
		["DOGS", "DOGS (Devious Obligate Great Stuff)", "", "https://github.com/FurryZoi/Devious-Obligate-Great-Stuff", "Adds devious stuff, which will increase your helplessness.... or dominance", []],
		["MBCFS", "BC Fetish Share", "https://maplesyrup.gitgud.site/maples-bc-plugin-library/plugins/fetish-share/", "", "Shows how well your fetishes and activities match other players, with match badges in chat rooms and a list of the people you've met.", ["BC Fetisch-Austausch", "BC Partage de fétiches", "Бондаж Клуб: обмен фетишами", "Бондаж Клуб: обмін фетишами", "束缚俱乐部爱好分享", "束縛俱樂部愛好分享"]],
		["echocloth", "Echo's Clothing Mod", "https://github.com/emdsa2/-mod/wiki", "https://github.com/SugarChain-Studio/echo-clothing-ext", "Adds more clothing options and custom slots in the wardrobe. Wait for the 🍔 on the login character's head to make sure it loaded fully!", ["服装拓展"]],
		["echomove", "Echo's Activities Mod", "https://github.com/emdsa2/-mod/wiki", "https://github.com/SugarChain-Studio/echo-activity-ext", "Expansion on activity options", ["动作拓展"]],
		["MoonCEBC", "Moon Cards Editor", "https://clubcardmonitoring.onrender.com/", "https://github.com/LunarKitsunify/MoonCEBC", "A quality-of-life upgrade for the Club Card game deck editor.", []],
		["MPA", "Maya's Petplay Additions (MPA)", "https://github.com/MayaTheFoxy/MPA/wiki", "https://github.com/MayaTheFoxy/MPA", "Adds more petplay themed content", []],
		["ResponsiveLegacy", "Responsive(Legacy)", "https://dynilath.gitlab.io/SaotomeToyStore/en/Plugins/Responsive.html", "https://github.com/dynilath/BCResponsive", "Easily managed conditions for automatic feedback in online chat.", []],
		["CRABS", "CRABS (Crazy Roster Addon By Sin)", "", "https://github.com/sin-1337/CRABS", "Adds a dynamic, stowable room roster (via /roster or /crabs) designed to streamline your gameplay with live player sorting, advanced map tracking, global Whi…", []],
		["LC", "Littlish Club", "", "https://github.com/FurryZoi/Littlish-Club", "ABDL addon for mommy & baby relationship games. Adds diapers, babiesh outfits library, rules and such stuff.", []],
		["emoji", "emoji", "", "https://github.com/Ayako-Qt/Emojis/tree/pages", "add emoji picker, send emoji to the chat. Lovly~", []],
		["BCOM", "BC Outfit Manager", "", "https://github.com/Utsumi24/BCOM/", "An addon for managing outfits with included restraints, saving them to local storage with exporting and importing functionality. Supports BCX outfit codes.", []],
		["LianChat", "LianChat", "", "https://github.com/XinLian132243/BCMod/", "A more modern interface for private messaging with friends, custom avatars and signatures, and the ability to view lobby rooms from anywhere.", ["涟信"]],
		["NFT", "NFT - Nest of Fluffy Treasures", "", "https://gitlab.com/nicole-bc-group/NFT/", "Save and load ItemHandheld / ItemMisc items with full appearance, crafter and property restore.", []],
		["EmeryBC", "EmeryBC", "", "https://github.com/NekoEmery/EmeryBC", "Outfits, restraint sets, action buttons, poses, scenes, friends tools, palettes, IM & QoL features for Bondage Club.", []],
		["BCNeko", "Bondage Club Neko Chat Enhancer", "", "https://github.com/QAQMOON/meow-", "Catgirl chat enhancer with neko-style message conversion, chat decorations, kaomoji picker, quick roleplay actions, and color themes.", []],
		["AFC", "Abundantia Florum ─Chromatica─", "", "https://github.com/awdrrawd/BC-AFC", "Extended lover framework featuring relationship progression, shared private rooms, integrated Heart Lock systems.", ["繁戀如花 ─繽紛─"]],
		["FCM", "Friends and ChatRoom Manager", "", "https://github.com/awdrrawd/BC-FCM", "Friends and chatroom enhancement toolkit with avatar display, relationship tracking, player search, and extended room utilities.", ["好友與房間管理"]],
		["HSC", "Hypnotic Slave Club", "", "https://github.com/awdrrawd/BC-HSC", "Provides a variety of hypnosis effects to enhance the immersion of the experience.", ["催眠奴隸俱樂部"]],
		["KikiLink", "KikiLink", "", "https://github.com/Lilja000/KikiLink", "Social profiles, direct and group chat, presence, room tools, media, custom activities, reactions, and quality-of-life features.", []],
		["EMLALOCK", "EmlaLock BC Integration", "https://www.emlalock.com", "https://gitlab.com/emlalock/bc-userscript", "Shows EmlaLock account and lock status badges", []],
		["AEE", "Appearance editing extension", "", "https://github.com/awdrrawd/BC-AEE", "A clothing editor extension for the club, featuring a modern UI, a wide range of convenient tools, intuitive controls, highly customizable settings, as well…", ["外觀編輯拓展"]],
		["BCPlus", "BC+ (Bondage Club Plus)", "https://seles84.github.io/bc-plus/", "https://github.com/Seles84/bc-plus", "Rules, curses, punishments, contracts, auto-generated permissions, a virtual pet module and collar welding - runs standalone or alongside BCX", []],
		["BCSecPris", "Secret Prison", "https://gitlab.com/TheSecretCoder-BC/secretprison/-/blob/main/KEYHOLDER.md", "https://gitlab.com/TheSecretCoder-BC/secretprison", "Long cell and asylum sentences set by whisper, with parole by beep, taunts, status checks and a settings screen. Requires BCX", []],
		["FBM", "Freya’s Better Maps", "", "https://github.com/Freya-BC/Freyas-Better-Maps", "Bondage Club map helpers: typing bubbles, copy and paste, build tools, templates, map library, hearing-range whisper, SuperZoom.", []],
		["Seidr", "Freya’s Seidr", "https://freya-bc.github.io/Freyas-Seidr/", "https://github.com/Freya-BC/Freyas-Seidr", "Simple Plugin for Pulling Left/Right and Cuddle for Cuddle piles. Additional new Actions. A Room Manager and other helpful utility tools", []],
		["SlimeBeep", "SlimeBeep", "", "https://github.com/Proudkiller0015/slimebeep", "A cute beep messenger: chat with each friend, see who's online and where, beep many friends at once (WaveBeep), group chats with other SlimeBeep users, profi…", []],
		["GGC", "Galia's Gambling Club (GGC)", "https://galia-bc.github.io/galia.github.io/", "https://github.com/galia-bc/galia.github.io", "Multiplayer games, a bank, player trades, and animated chat-room effects.", []],
		// Not in FUSAM's list: Liko's own add-on manager, which announces itself in rooms
		["PCM", "Liko's Plugin Collection Manager (PCM)", "https://awdrrawd.github.io/liko-Plugin-Repository/", "https://github.com/awdrrawd/liko-Plugin-Repository", "Installs and manages Liko's plugins (and some others) from one script.", []],
		["ECHS", "Erotic Chat Hypnosis Suite (ECHS)", "https://github.com/Dwfreegethub/HypnosisAddon/wiki", "https://github.com/Dwfreegethub/HypnosisAddon", "Interactive hypnosis between players—featuring inductions, spoken suggestions, custom triggers, crafted drinks, and more. Designed to be the most comprehensi…", []],
	];
	// Names detection (or bcModSdk) uses that differ from the directory's
	/** @type {Record<string, string>} */
	const ADDON_ALIASES = { BCTweaks: "BCT", BCP: "BCPlus", "Secret Prison": "BCSecPris", "Liko AEE": "AEE" };

	// { id, title, url, repo, desc } for an add-on name, or null when the directory doesn't list it
	/** @param {unknown} name */
	function addonInfo(name) {
		if (typeof name !== "string") return null;
		const low = (ADDON_ALIASES[name] || name).toLowerCase();
		const hit = ADDON_DIRECTORY.find(
			([dirId, dirTitle, , , , other]) =>
				dirId.toLowerCase() === low || dirTitle.toLowerCase() === low || (dirTitle.match(/\(([^)]+)\)$/)?.[1] || "").toLowerCase() === low || other.some((o) => o.toLowerCase() === low)
		);
		if (!hit) return null;
		const [id, title, website, repo, desc] = hit;
		return { id, title, url: website || repo, repo, desc };
	}

	// Where to read about an add-on: its page, or a GitHub search for ones the directory doesn't know
	/** @param {string} name */
	function addonLink(name) {
		const info = addonInfo(name);
		if (info?.url) return info.url;
		const term = name.replace(/^Unknown \((.*)\)$/, "$1");
		return `https://github.com/search?type=repositories&q=${encodeURIComponent(`${term} bondage club`)}`;
	}

	/**
	 * @param {unknown} v
	 * @returns {any}
	 */
	const parseMaybe = (v) => {
		if (typeof v !== "string") return v;
		try {
			return JSON.parse(v);
		} catch {
			return v;
		}
	};

	// First "version"-like field anywhere in a message payload
	/**
	 * @param {any} o
	 * @param {number} [depth]
	 * @returns {string | null}
	 */
	function findVersion(o, depth = 0) {
		if (!o || typeof o !== "object" || depth > 6) return null;
		for (const [k, v] of Object.entries(o)) if (/^(version|bctVersion)$/i.test(k) && (typeof v === "string" || typeof v === "number")) return String(v);
		for (const v of Object.values(o)) {
			const found = findVersion(typeof v === "string" ? parseMaybe(v) : v, depth + 1);
			if (found) return found;
		}
		return null;
	}

	// [{ name, version, via, seen }] for a cached profile record, sorted by name
	/**
	 * @param {LBBProfile | undefined} rec
	 * @returns {{ name: string, version: string | null, via: string[], seen: number | null }[]}
	 */
	function detectAddons(rec) {
		/** @type {Map<string, { name: string, version: string | null, via: string[], seen: number | null }>} */
		const found = new Map();
		/**
		 * @param {string} name
		 * @param {string | null} version
		 * @param {string} via
		 * @param {number | undefined} seen
		 */
		const note = (name, version, via, seen) => {
			const prev = found.get(name);
			if (!prev) return found.set(name, { name, version: version || null, via: [via], seen: seen || null });
			if (version && !prev.version) prev.version = version;
			if (!prev.via.includes(via)) prev.via.push(via);
			if (seen && (!prev.seen || prev.seen < seen)) prev.seen = seen;
		};
		const shared = rec?.data?.OnlineSharedSettings || {};
		for (const [k, v] of Object.entries(shared)) {
			if (GAME_SHARED_KEYS.has(k)) continue;
			const name = SHARED_ADDONS[k] || `Unknown (${k})`;
			const version = k === "MBSVersion" ? String(v) : findVersion(parseMaybe(v));
			note(name, version, "room data", rec?.lastSeen);
		}
		for (const [content, m] of Object.entries(rec?.modMessages || {})) {
			/** @type {any} */
			const dict = m.msg?.Dictionary;
			// Echo's extensions list themselves (with versions) in one message
			if (content === "ECHO_INFO2" && Array.isArray(dict) && /** @type {any} */ (dict[0])?.Content && typeof /** @type {any} */ (dict[0]).Content === "object") {
				for (const [ext, info] of Object.entries(/** @type {Record<string, any>} */ (/** @type {any} */ (dict[0]).Content))) note(ext, info?.version ? String(info.version) : null, "messages", m.at);
				continue;
			}
			const key = content.replace(/:.*$/, "");
			const name = key === "LikoAEE" ? "Liko AEE" : messageAddon(key) || `Unknown (${key.slice(0, 40)})`;
			const payload = Array.isArray(dict) ? dict.map((/** @type {any} */ x) => (x && typeof x === "object" ? { ...x, message: parseMaybe(x.message) } : x)) : parseMaybe(dict);
			note(name, findVersion(payload), "messages", m.at);
		}
		return [...found.values()].sort((a, b) => Number(a.name.startsWith("Unknown")) - Number(b.name.startsWith("Unknown")) || a.name.localeCompare(b.name));
	}

	// ---------- decoding helpers ----------

	/** @param {unknown} d */
	function decodeDescription(d) {
		if (typeof d !== "string") return "";
		const magic = typeof ONLINE_PROFILE_DESCRIPTION_COMPRESSION_MAGIC === "string" ? ONLINE_PROFILE_DESCRIPTION_COMPRESSION_MAGIC : "╬";
		if (!d.startsWith(magic)) return d;
		try {
			return LZString.decompressFromUTF16(d.slice(magic.length)) || "";
		} catch {
			return d;
		}
	}

	/** @param {unknown} c */
	function decodeCrafting(c) {
		if (Array.isArray(c)) return c.filter(Boolean);
		if (typeof c !== "string" || !c) return [];
		try {
			const r = CraftingDecompressServerData(c);
			return Array.isArray(r) ? r.filter(Boolean) : [];
		} catch (e) {
			console.warn(TAG, "crafting decode failed", e);
			return [];
		}
	}

	/**
	 * @param {IAssetFamily | undefined} family
	 * @param {AssetGroupName} group
	 * @param {string} name
	 */
	function assetLabel(family, group, name) {
		try {
			const a = AssetGet(family || "Female3DCG", group, name);
			if (a && a.Description) return a.Description;
		} catch {
			// not available in this game or browser: the fallback is used
		}
		return name;
	}

	// Body parts and pronouns can't be removed; listing them only buries the actual items
	/**
	 * @param {IAssetFamily | undefined} family
	 * @param {AssetGroupName} group
	 */
	function isBodyGroup(family, group) {
		try {
			const g = AssetGroupGet(family || "Female3DCG", group);
			return !!g && g.AllowNone === false;
		} catch {
			return false;
		}
	}

	/** @param {number} member */
	function inRoomWith(member) {
		return typeof ChatRoomCharacter !== "undefined" && ChatRoomCharacter.some((c) => c.MemberNumber === member);
	}

	// Presence for the lists: the online-friends answer, or being in your room right now (which also covers
	// people who aren't mutual friends, whom the server never reports as online)
	/** @param {number} member */
	function onlineOf(member) {
		return onlineFriends.get(member) || (inRoomWith(member) ? { here: true } : null);
	}

	/**
	 * @param {IAssetFamily | undefined} family
	 * @param {AssetGroupName} group
	 */
	function groupLabel(family, group) {
		try {
			const g = AssetGroupGet(family || "Female3DCG", group);
			if (g && g.Description) return g.Description;
		} catch {
			// not available in this game or browser: the fallback is used
		}
		return group;
	}

	/**
	 * @param {IAssetFamily | undefined} family
	 * @param {AssetGroupName} group
	 */
	function isItemGroup(family, group) {
		try {
			const g = AssetGroupGet(family || "Female3DCG", group);
			return !!g && g.Category === "Item";
		} catch {
			return /^Item/.test(group);
		}
	}

	// Crafts only store the asset name, so find the restraint it refers to
	/** @param {string} name */
	function craftItemLabel(name) {
		try {
			const a = Asset.find((x) => x.Name === name && x.Group && x.Group.Category === "Item");
			if (a) return `${a.Description} (${a.Group.Description})`;
		} catch {
			// not available in this game or browser: the fallback is used
		}
		return name || "?";
	}

	/**
	 * @param {IAssetFamily | undefined} family
	 * @param {string} lock
	 */
	function lockLabel(family, lock) {
		if (!lock) return "";
		return assetLabel(family, "ItemMisc", lock);
	}

	// Property names/descriptions live in the Crafting screen's text file, which is only loaded
	// while that screen is open, so read the file ourselves
	/** @type {Map<string, string>} */
	const craftText = new Map();
	fetch(new URL("Screens/Room/Crafting/Text_Crafting.csv", location.href))
		.then((r) => (r.ok ? r.text() : ""))
		.then((txt) => {
			for (const line of txt.split(/\r?\n/)) {
				const i = line.indexOf(",");
				if (i < 1) continue;
				let val = line.slice(i + 1).trim();
				if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/""/g, '"');
				craftText.set(line.slice(0, i), val);
			}
			ui.refreshSoon();
		})
		.catch((err) => console.warn(TAG, "crafting text load failed", err));

	const craftPropName = (/** @type {string} */ key) => craftText.get(`Property${key}`) || key;
	const craftPropDesc = (/** @type {string} */ key) => craftText.get(`Description${key}`) || "";
	const activeEffects = (/** @type {Record<string, unknown> | null | undefined} */ effects) => Object.entries(effects || {}).filter(([, v]) => !!v);

	// ---------- UI ----------

	/**
	 * An element with attributes (class, on<event> listeners, the rest as attributes; null/false left out) and children
	 * (nodes, text, arrays of them; null/false left out)
	 * @template {keyof HTMLElementTagNameMap} K
	 * @param {K} tag
	 * @param {Record<string, any>} [attrs]
	 * @param {...any} children
	 * @returns {HTMLElementTagNameMap[K]}
	 */
	const h = (tag, attrs = {}, ...children) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (k === "class") el.className = v;
			else el.setAttribute(k, v === true ? "" : v);
		}
		for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
		return el;
	};

	/** @param {number} t */
	const ago = (t) => {
		if (!t) return "never";
		const s = Math.round((Date.now() - t) / 1000);
		if (s < 60) return "just now";
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		if (s < 86400) return `${Math.round(s / 3600)}h ago`;
		return `${Math.round(s / 86400)}d ago`;
	};
	const fmtDate = (/** @type {number | null | undefined} */ t) => (t ? new Date(t).toLocaleString() : "—");
	const fmtTime = (/** @type {number} */ t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const fmtDuration = (/** @type {number} */ ms) => {
		const m = Math.max(0, Math.round(ms / 60000));
		return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
	};

	/**
	 * @param {string} filename
	 * @param {string} content
	 * @param {string} type
	 */
	function download(filename, content, type) {
		const a = h("a", { href: URL.createObjectURL(new Blob([content], { type })), download: filename });
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 5000);
	}

	const safeName = (/** @type {string | null | undefined} */ s) => String(s || "room").replace(/[^\w\- ]+/g, "_").trim().slice(0, 60) || "room";
	/** @type {Record<string, string>} */
	const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
	const escapeHtml = (/** @type {unknown} */ s) => String(s).replace(/[&<>"]/g, (c) => HTML_ESC[c]);

	const CSS = `
#fm-panel{position:fixed;inset:4vh 4vw;z-index:10001;display:flex;flex-direction:column;background:rgb(var(--bcd-bg,27 22 34) / var(--bcd-opacity, 1));color:var(--bcd-text,#eee);
	border:1px solid var(--bcd-line,#6b4f85);border-radius:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px #000a}
/* Inside a dock window (dock 23+): the dock draws the frame, background and title bar */
#fm-panel.in-dock{position:static;inset:auto;z-index:auto;flex:1;min-height:0;background:none;border:0;border-radius:0;box-shadow:none}
#fm-panel *{box-sizing:border-box}
/* Slim scrollbars in the panel's colours (standard properties, plus WebKit for older browsers) */
#fm-panel *{scrollbar-width:thin;scrollbar-color:var(--bcd-line,#6b4f85) rgb(var(--bcd-bg,27 22 34))}
#fm-panel ::-webkit-scrollbar{width:8px;height:8px}
#fm-panel ::-webkit-scrollbar-track{background:transparent}
#fm-panel ::-webkit-scrollbar-thumb{background:var(--bcd-line,#6b4f85);border-radius:4px;border:2px solid rgb(var(--bcd-bg,27 22 34))}
#fm-panel ::-webkit-scrollbar-thumb:hover{background:var(--bcd-hi,#9a7bb8)}
#fm-panel ::-webkit-scrollbar-corner{background:transparent}
#fm-head{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47);flex-wrap:wrap}
#fm-head h2{margin:0 8px 0 0;font-size:16px}
#fm-head .fm-ver{font-size:11px;font-weight:400;color:var(--bcd-muted,#8f86a3)}
#fm-nav{display:flex;gap:4px}
#fm-nav button.act{background:var(--bcd-line,#6b4f85);border-color:var(--bcd-hi,#9a7bb8)}
#fm-panel input,#fm-panel select,#fm-panel textarea,#fm-panel button{font:inherit;color:var(--bcd-text,#eee);background:var(--bcd-ctl,#2a2233);border:1px solid var(--bcd-ctl-line,#4d3d5e);border-radius:4px;padding:4px 8px}
#fm-panel button{cursor:pointer}
#fm-panel button:hover{background:var(--bcd-ctl-hover,#3b2f48)}
#fm-body{display:flex;flex:1;min-height:0}
#fm-side{width:300px;display:flex;flex-direction:column;border-right:1px solid var(--bcd-line-soft,#3a2e47)}
#fm-tools{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47)}
#fm-tools input[type=search]{flex:1;min-width:120px}
#fm-list{flex:1;overflow:auto}
.fm-row{padding:7px 10px;border-bottom:1px solid var(--bcd-ctl,#2a2233);cursor:pointer}
.fm-row:hover{background:var(--bcd-tab,#262030)}.fm-row.sel{background:var(--bcd-ctl-hover,#3b2f48)}
.fm-row .n{font-weight:600;display:flex;align-items:center;gap:4px}.fm-row .n .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-row .m{font-size:12px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;margin-right:6px;flex:none}
.fm-dot.on{background:#4caf50}
.fm-badge{background:#c2185b;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;font-weight:700}
.fm-live{color:#ff6b9a;font-size:11px;font-weight:700}
#fm-detail{flex:1;overflow:auto;padding:12px 16px;min-width:0}
#fm-detail.fm-fill{overflow:hidden;padding:0;display:flex;flex-direction:column}
#fm-tabs{display:flex;gap:4px;margin:10px 0;flex-wrap:wrap}
#fm-tabs button.act{background:var(--bcd-line,#6b4f85)}
#fm-panel table{border-collapse:collapse;width:100%}
#fm-panel td,#fm-panel th{text-align:left;padding:3px 8px;border-bottom:1px solid var(--bcd-ctl,#2a2233);vertical-align:top}
#fm-panel th{color:#bbb;font-weight:500;width:180px}
#fm-panel pre{white-space:pre-wrap;word-break:break-word;background:#00000059;padding:8px;border-radius:4px;font-size:12px;margin:4px 0}
.fm-muted{color:#999}
.fm-card{border:1px solid var(--bcd-line-soft,#3a2e47);border-radius:6px;padding:8px 10px;margin:6px 0}
#fm-panel h3{margin:14px 0 4px;font-size:15px}
.fm-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.fm-chip{background:var(--bcd-ctl-hover,#3b2f48);border-radius:10px;padding:0 8px;font-size:12px;cursor:help}
a.fm-chip-link{color:var(--bcd-text,#eee);text-decoration:none;cursor:pointer}a.fm-chip-link:hover{background:var(--bcd-line,#6b4f85)}
.fm-addons-about{margin-top:6px}.fm-addons-about summary{cursor:pointer;color:var(--bcd-accent,#c9a6e8);font-size:12px}
.fm-addon{margin:6px 0 0 4px;font-size:12px}.fm-addon a{color:var(--bcd-accent,#c9a6e8)}
.fm-chip-unknown{background:none;border:1px dashed var(--bcd-ctl-line,#5a4570);color:#aaa}
.fm-outfit-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 8px}
.fm-locked{font-size:12px;margin:4px 0 8px;padding:6px 8px;border:1px solid var(--bcd-ctl-line,#4d3d5e);border-radius:6px;background:var(--bcd-tab,#241c2c)}
.fm-item-settings{font-size:12px;display:flex;flex-direction:column;gap:2px}
.fm-item-settings b{font-weight:600;color:#bbb}
.fm-unusual{color:#ff8a8a;font-weight:600}
.fm-with-preview{display:flex;gap:16px;align-items:flex-start}
/* The game's stylesheet stretches canvases, so pin the preview's size */
#fm-panel canvas.fm-preview{width:220px!important;height:407px!important;max-width:none;flex:none;position:sticky;top:0;
	background:linear-gradient(#0000004d,#0000004d),rgb(var(--bcd-bg,27 22 34) / var(--bcd-opacity, 1));border:1px solid var(--bcd-line-soft,#3a2e47);border-radius:8px}
#fm-panel button.off{opacity:.45}
.fm-swatch{display:inline-block;width:14px;height:14px;border:1px solid #0008;border-radius:3px;margin-right:3px;vertical-align:middle}
.fm-swatch-def{background:repeating-linear-gradient(45deg,#4a4a4a 0 3px,#2a2a2a 3px 6px);border-color:#666}
.fm-vhead{padding:10px 16px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.fm-vhead h2{margin:0;font-size:17px}
.fm-scroll{flex:1;overflow:auto;padding:10px 16px;display:flex;flex-direction:column}
.fm-msg{max-width:75%;padding:6px 10px;border-radius:10px;margin:3px 0;white-space:pre-wrap;word-break:break-word}
.fm-msg.in{background:var(--bcd-ctl,#2a2233);align-self:flex-start}.fm-msg.out{background:var(--bcd-tab-act,#4a3560);align-self:flex-end}
.fm-msg.whisper{border:1px dashed #8fd3ff66}.fm-msg.emote{font-style:italic}
.fm-msg .meta{font-size:11px;color:#aaa;margin-top:2px}
.fm-react{align-self:center;font-size:12px;color:#aaa}
.fm-day{align-self:center;font-size:11px;color:#888;margin:8px 0 2px}
.fm-compose{display:flex;gap:8px;padding:8px 16px;border-top:1px solid var(--bcd-line-soft,#3a2e47);align-items:flex-end}
.fm-compose textarea{flex:1;resize:vertical;min-height:38px;max-height:160px}
.fm-filters{display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:6px 16px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47)}
.fm-filters button.off{opacity:.45}
.fm-line{padding:1px 0;white-space:pre-wrap;word-break:break-word}
.fm-line .ts{color:#888;font-size:11px;margin-right:6px}
.fm-line.t-Emote,.fm-line.t-Action,.fm-line.t-Activity{color:var(--bcd-accent,#c9a8ff);font-style:italic}
.fm-line.t-Whisper{color:#8fd3ff}.fm-line.t-LocalMessage,.fm-line.t-ServerMessage,.fm-line.t-Other{color:#999}
.fm-line.t-RoomChange{color:#7fd1b9;background:#7fd1b912;border-left:2px solid #7fd1b9;padding-left:6px;margin:3px 0}
.fm-star{cursor:pointer;color:#888;font-size:15px;line-height:1;flex:none}
.fm-star:hover,.fm-star.on{color:#ffcc4d}
.fm-bell{cursor:pointer;font-size:13px;line-height:1;flex:none;opacity:.45;filter:grayscale(1)}
.fm-bell:hover,.fm-bell.on{opacity:1;filter:none}
.fm-row.fm-closed{opacity:.55}
#fm-tools button.act{background:var(--bcd-line,#6b4f85);border-color:var(--bcd-hi,#9a7bb8)}
.fm-modes{display:flex;flex-direction:column;gap:2px}
.fm-group-head{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--bcd-tab,#221b2b);border-bottom:1px solid var(--bcd-ctl,#2a2233);font-size:12px;font-weight:600;cursor:pointer;position:sticky;top:0;z-index:1}
.fm-group-head .grow{flex:1}
.fm-group-dot{width:10px;height:10px;border-radius:50%;flex:none}
.fm-group-msg{padding:0 4px;opacity:.6}.fm-group-msg:hover{opacity:1}
.fm-groups{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}
.fm-gtag{display:inline-flex;align-items:center;gap:4px;border-radius:10px;padding:0 8px;font-size:12px;color:#16121b;font-weight:600}
.fm-gtag .x{cursor:pointer;opacity:.6}.fm-gtag .x:hover{opacity:1}
#fm-panel select.fm-gpick{padding:0 4px;font-size:12px;background:none;border-style:dashed}
#fm-panel input.fm-gname{padding:0 6px;font-size:12px;width:150px}
.fm-group-head input.fm-gname{flex:1}
.fm-pending{display:flex;flex-direction:column;padding:4px 16px;border-top:1px dashed var(--bcd-line-soft,#3a2e47);max-height:30%;overflow:auto}
.fm-msg.queued{border:1px dashed color-mix(in srgb,var(--bcd-accent,var(--bcd-accent,#c9a8ff)) 53%,transparent);background:color-mix(in srgb,var(--bcd-tab-act,var(--bcd-tab-act,#4a3560)) 33%,transparent)}
.fm-msg.queued a{color:var(--bcd-accent,#c9a8ff)}
.fm-queued{font-size:11px;color:var(--bcd-accent,#c9a8ff);font-weight:400}
#fm-panel .fm-mode{padding:1px 8px;font-size:12px}
#fm-panel .fm-mode.act{background:var(--bcd-line,#6b4f85);border-color:var(--bcd-hi,#9a7bb8)}
#fm-panel .fm-visit-del{margin-left:8px;padding:0 6px;font-size:11px;color:#ffb86b;background:none;border:1px solid var(--bcd-ctl-line,#5a4570);opacity:.6}
#fm-panel .fm-visit-del:hover{opacity:1}
.fm-name{font-weight:700;font-style:normal;cursor:pointer}
.fm-name:hover{text-decoration:underline}
.fm-line.t-Session{color:#ffb86b;text-align:center;font-size:12px;margin:10px 0 4px;border-top:1px dashed var(--bcd-ctl-line,#5a4570);padding-top:4px}
.fm-hit{padding:6px 0;border-bottom:1px solid var(--bcd-ctl,#2a2233);cursor:pointer}.fm-hit:hover{background:var(--bcd-tab,#262030)}
mark{background:#c2185b;color:#fff;border-radius:2px}
.fm-set{max-width:760px}
.fm-set h3{margin:18px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47);color:var(--bcd-accent,#d7b8f0)}
.fm-set-row{display:block;margin:8px 0}
.fm-set-row.sub{margin-left:24px}
.fm-set-row.off{opacity:.55}
.fm-set-hint{margin-left:22px;font-size:12px}
.fm-set-btns{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
`;

	const SECTIONS = [
		["chats", "Chats"],
		["friends", "Friends"],
		["rooms", "Rooms"],
		["lobby", "Lobby"],
		["profiles", "Profiles"],
		["outfits", "Outfits"],
		["settings", "⚙"],
	];
	/** @type {[string, string[]][]} */
	const FILTER_TYPES = [
		["Chat", ["Chat"]],
		["Emote", ["Emote"]],
		["Whisper", ["Whisper"]],
		["Action", ["Action"]],
		["Activity", ["Activity"]],
		["Room changes", ["RoomChange"]],
		["System", ["LocalMessage", "ServerMessage", "Other"]],
	];

	const ui = (() => {
		/** @type {BCDockHandle | null} */
		let dockPanel = null; // our row in the shared dock (bc-dock.js): opens/closes the panel, shows unread
		/** @type {HTMLElement | null} */
		let panel = null;
		let section = "chats";
		/** @type {Record<string, string>} */
		const searches = {};
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let refreshTimer;
		let unreadTotal = 0;
		/** @type {number | null} */
		let shownFor = null; // account whose data the panel last showed

		// profiles
		/** @type {number | null} */
		let selected = null;
		let detailTab = "Overview";
		let filter = "friends";
		/** @type {Map<number, LBBProfile>} */
		let records = new Map();

		// chats / friends / rooms / lobby
		/** @type {Map<number, LBBConv>} */
		let convs = new Map();
		/** @type {LBBSession[]} */
		let sessions = [];
		/** @type {number | null} */
		let chatMember = null;
		/** @type {{ member: number, listEl: HTMLElement, [more: string]: any } | null} */
		let convView = null; // { member, listEl }
		/** @type {string | null} */
		let roomName = null; // Rooms section: the room whose log (all visits combined) is open
		/** @type {LBBRoomView | null} */
		let roomView = null; // { name, linesEl, items, sessionIds, visits, find }
		/** @type {string | null} */
		let messageSearch = null; // query string when the Rooms main pane shows message search results
		/** @type {Set<string>} */
		const hiddenTypes = new Set();
		/** @type {ServerChatRoomSpace} */
		let lobbySpace = "X";
		/** @type {ServerChatRoomSearchData[] | null} */
		let lobbyRooms = null;
		let lobbyError = "";
		/** @type {string | null} */
		let lobbySel = null;
		let lobbyFavOnly = false;
		/** @type {Set<string>} */
		let favRooms = new Set(); // favorite room names, saved per account in the meta store

		// A part of the open window (they're all there while it's open)
		const part = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (panel?.querySelector(sel));

		function mount() {
			document.head.append(h("style", { id: "fm-style" }, CSS));
			if (window.BCDock)
				dockPanel = BCDock.add(
					dockSizes()
						? // A dock window like the other add-ons': beside the rail or floating, resizable at its edges
						{ id: "friend-manager", title: "Black Book", icon: "📓", order: 10, version: MOD_INFO.version, visible: false, width: 960, minWidth: 560, maxWidth: 2400, height: 680, minHeight: 360, onToggle: (on) => {
							if (on && !panel) open().catch((err) => console.warn(TAG, err));
							else if (!on) teardown();
						} }
						: // An older dock can't size a window: the book keeps its own
						{ id: "friend-manager", title: "Black Book", icon: "📓", order: 10, version: MOD_INFO.version, visible: false, onClick: () => {
							if (panel) close();
							else open().catch((err) => console.warn(TAG, err));
						} }
				);
			else console.warn(TAG, "bc-dock.js isn't loaded (the Nightstand script brings it); open it with /book");
			renderTab();
			refreshBadge().catch((err) => console.warn(TAG, err));
		}

		function unmount() {
			document.getElementById("fm-style")?.remove();
			dockPanel?.remove();
			dockPanel = null;
			close();
		}

		function renderTab() {
			dockPanel?.setBadge(unreadTotal || null);
			dockPanel?.setSummary(panel && !inDock() ? "open" : unreadTotal ? `${unreadTotal} unread` : "");
		}

		// Shown once logged in, and kept while the panel is open since it also closes it
		function syncTabVisibility() {
			// Hidden from Settings, it still shows while the panel is open (it's also a way to close it)
			dockPanel?.setVisible(!!Player.MemberNumber && (prefs.showBubble || !!panel));
			renderTab();
		}

		async function refreshBadge() {
			if (!me()) return;
			await ensureDb();
			const all = await reqDone(storeOf("convs").index("owner").getAll(me()));
			unreadTotal = /** @type {LBBConv[]} */ (all).reduce((n, c) => n + (c.unread || 0), 0);
			renderTab();
			updateStatus();
		}

		// A (different) account's database just opened: forget anything shown for the previous one
		function onAccountReady() {
			records = new Map();
			convs = new Map();
			sessions = [];
			if (dbOwner !== shownFor) {
				shownFor = dbOwner;
				selected = chatMember = roomName = lobbySel = outfitSel = null;
				savedOutfits = [];
				groupsData = { groups: [], members: {} };
				groupFilter = "all";
				friendsView = null;
				messageSearch = null;
				convView = roomView = null;
			}
			refreshBadge().catch((err) => console.warn(TAG, err));
			if (panel) reload(true).catch((err) => console.warn(TAG, err));
		}

		// open(member, "profiles") jumps to that person's profile; open(member, "chats") to your conversation with them
		/**
		 * @param {number} [member]
		 * @param {string} [toSection]
		 */
		async function open(member, toSection) {
			if (!Player.MemberNumber) return;
			if (toSection) section = toSection;
			if (typeof member === "number") {
				if (section === "chats" || section === "friends") chatMember = member;
				else {
					section = "profiles";
					selected = member;
					filter = "all";
				}
			}
			if (!panel) build();
			if (inDock() && !dockPanel?.isOpen()) dockPanel?.open();
			convView = null;
			roomView = null;
			renderNav();
			renderTools();
			syncTabVisibility();
			requestOnlineFriends();
			await reload(true);
		}

		// Dock 23 and later give the book a window it fills (moved, floated and resized by the dock)
		const dockSizes = () => !!window.BCDock && Number(window.BCDock.version) >= 23;
		const inDock = () => dockSizes() && !!dockPanel?.body;

		function close() {
			// In the dock, closing its window tears the book down (onToggle)
			if (inDock() && dockPanel?.isOpen()) dockPanel.close();
			teardown();
		}

		function teardown() {
			panel?.remove();
			panel = null;
			dropPreviewCharacter();
			convView = null;
			roomView = null;
			syncTabVisibility();
		}

		function build() {
			const stop = (/** @type {Event} */ e) => e.stopPropagation();
			const docked = inDock();
			panel = h("div", { id: "fm-panel", class: docked ? "in-dock" : null, onkeydown: stop, onkeyup: stop, onkeypress: stop, onwheel: stop });
			panel.addEventListener("keydown", (e) => {
				if (e.key === "Escape") close();
			});
			panel.append(
				h(
					"div",
					{ id: "fm-head" },
					// The dock's title bar already says what and which version
					docked ? null : h("h2", {}, "Little Black Book", h("span", { class: "fm-ver", title: "Little Black Book version" }, ` v${MOD_INFO.version}`)),
					h("div", { id: "fm-nav" }),
					h("span", { style: "flex:1" }),
					h("span", { class: "fm-muted", id: "fm-status" }),
					h("button", { onclick: () => open(me(), "profiles"), title: "Your own profile, live" }, "👤 My profile"),
					docked ? null : h("button", { onclick: close, title: "Close (Esc)" }, "✕")
				),
				h("div", { id: "fm-body" }, h("div", { id: "fm-side" }, h("div", { id: "fm-tools" }), h("div", { id: "fm-list" })), h("div", { id: "fm-detail" }))
			);
			if (docked) dockPanel?.body?.replaceChildren(panel);
			else document.body.append(panel);
		}

		/** @param {string} s */
		function switchSection(s) {
			if (s === section) return;
			section = s;
			convView = null;
			roomView = null;
			renderNav();
			renderTools();
			if (s === "lobby" && !lobbyRooms) runLobbySearch().catch((err) => console.warn(TAG, err));
			reload(true).catch((err) => console.warn(TAG, err));
		}

		function renderNav() {
			if (!panel) return;
			// Settings uses the whole width
			part("#fm-side").style.display = section === "settings" ? "none" : "";
			part("#fm-nav").replaceChildren(
				...SECTIONS.map(([id, label]) =>
					h(
						"button",
						{ class: id === section ? "act" : "", title: id === "settings" ? "Settings" : null, onclick: () => switchSection(id) },
						label,
						id === "chats" && unreadTotal ? h("span", { class: "fm-badge", style: "margin-left:6px" }, String(unreadTotal)) : null
					)
				)
			);
		}

		/**
		 * @param {string} placeholder
		 * @param {(v: string) => void} [onEnter]
		 */
		function searchBox(placeholder, onEnter) {
			const el = h("input", { type: "search", placeholder, value: searches[section] || "" });
			el.addEventListener("input", () => {
				searches[section] = el.value.trim();
				renderList();
			});
			if (onEnter) el.addEventListener("keydown", (e) => e.key === "Enter" && onEnter(el.value.trim()));
			return el;
		}

		// Toolbar above the list; rebuilt only when switching sections so typing isn't interrupted
		function renderTools() {
			if (!panel) return;
			const el = part("#fm-tools");
			switch (section) {
				case "profiles": {
					const filterEl = h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((filter = e.target.value), renderList()) },
						h("option", { value: "friends", selected: filter === "friends" }, "Friends"),
						h("option", { value: "online", selected: filter === "online" }, "Online friends"),
						h("option", { value: "all", selected: filter === "all" }, "Everyone cached"),
						h("option", { value: "favs", selected: filter === "favs" }, "★ Favorites")
					);
					const importEl = h("input", {
						type: "file",
						accept: ".json,application/json",
						style: "display:none",
						onchange: async (/** @type {Event & { target: HTMLInputElement }} */ e) => {
							const f = e.target.files?.[0];
							if (f) await importFile(f);
							e.target.value = ""; // picking the same file again still imports
						},
					});
					el.replaceChildren(
						searchBox("Name or member #"),
						filterEl,
						h("button", { title: "Your character as it is right now: outfit, items, crafts, add-ons", onclick: () => ((selected = me()), renderList(), renderDetail()) }, "Me"),
						h("button", { onclick: () => requestOnlineFriends() }, "Refresh online"),
						h("button", { onclick: exportAll }, "Export"),
						h("button", { onclick: () => importEl.click() }, "Import"),
						importEl
					);
					break;
				}
				case "chats":
					el.replaceChildren(
						searchBox("Name, or member # + Enter", (/** @type {string} */ v) => {
							const n = parseInt(v, 10);
							if (String(n) === v) openChat(n);
						}),
						h(
							"button",
							{
								class: showHiddenChats ? "act" : "",
								title: "Show chats you've hidden",
								onclick: (/** @type {MouseEvent} */ e) => {
									showHiddenChats = !showHiddenChats;
									/** @type {HTMLElement} */ (e.currentTarget).classList.toggle("act", showHiddenChats);
									renderList();
								},
							},
							"Hidden"
						),
						h("button", { title: "Notifications and other settings", onclick: () => switchSection("settings") }, "🔔"),
						h("button", { title: "Copy your LianChat beep/whisper history into Little Black Book", onclick: runLianChatImport }, "Import LianChat")
					);
					break;
				case "friends": {
					const filterEl = h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((groupFilter = e.target.value), renderList()) },
						h("option", { value: "all", selected: groupFilter === "all" }, "All groups"),
						groupsData.groups.map((g) => h("option", { value: g.id, selected: groupFilter === g.id }, g.name)),
						h("option", { value: "ungrouped", selected: groupFilter === "ungrouped" }, "Ungrouped")
					);
					el.replaceChildren(
						searchBox("Name or member #"),
						filterEl,
						h("button", { title: "Create, rename, recolour and message groups", onclick: () => ((chatMember = null), (convView = null), (friendsView = "manage"), renderList(), renderDetail()) }, "Groups"),
						h("button", { onclick: () => requestOnlineFriends() }, "Refresh")
					);
					break;
				}
				case "outfits":
					el.replaceChildren(
						searchBox("Outfit or person"),
						h(
							"button",
							{
								class: outfitFavOnly ? "act" : "",
								title: "Show only favorite outfits",
								onclick: (/** @type {MouseEvent} */ e) => {
									outfitFavOnly = !outfitFavOnly;
									/** @type {HTMLElement} */ (e.currentTarget).classList.toggle("act", outfitFavOnly);
									renderList();
								},
							},
							"★ Favorites"
						),
						h("button", { title: "Save what you're wearing right now, restraints included (no locks; crafted ones as the plain item)", onclick: saveMyOutfit }, "Save my current outfit"),
						h("button", { title: "Paste an outfit code (wardrobe Copy/Paste format) to import it", onclick: importOutfitCode }, "Import outfit code")
					);
					break;
				case "rooms":
					el.replaceChildren(
						searchBox("Room name · Enter searches messages", (/** @type {string} */ v) => v && showMessageSearch(v)),
						h("button", { onclick: () => searches.rooms && showMessageSearch(searches.rooms) }, "Search messages")
					);
					break;
				case "lobby": {
					const spaceEl = h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => ((lobbySpace = /** @type {ServerChatRoomSpace} */ (e.target.value)), runLobbySearch()) },
						[
							["X", "Mixed"],
							["", "Female"],
							["M", "Male"],
							["Asylum", "Asylum"],
						].map(([v, l]) => h("option", { value: v, selected: v === lobbySpace }, l))
					);
					const favBtn = h(
						"button",
						{
							class: lobbyFavOnly ? "act" : "",
							title: "Show only favorite rooms",
							onclick: (/** @type {MouseEvent} */ e) => {
								lobbyFavOnly = !lobbyFavOnly;
								/** @type {HTMLElement} */ (e.currentTarget).classList.toggle("act", lobbyFavOnly);
								renderList();
							},
						},
						"★ Favorites"
					);
					el.replaceChildren(searchBox("Filter rooms", () => {
						runLobbySearch().catch((err) => console.warn(TAG, err));
					}), spaceEl, favBtn, h("button", { onclick: runLobbySearch }, "Refresh"));
					break;
				}
			}
		}

		async function reload(withDetail = false) {
			if (!panel) return;
			await ensureDb();
			const owner = me();
			const [all, convList, sessionList, favs, outfitRecs] = await Promise.all([
				dbAllForOwner(owner),
				reqDone(storeOf("convs").index("owner").getAll(owner)),
				reqDone(storeOf("sessions").index("owner").getAll(owner)),
				reqDone(storeOf("meta").get("favRooms")),
				reqDone(storeOf("meta").getAll(IDBKeyRange.bound("outfit:", "outfit:￿"))),
			]);
			favRooms = new Set(favs?.names || []);
			savedOutfits = /** @type {LBBOutfit[]} */ (outfitRecs).sort((a, b) => b.savedAt - a.savedAt);
			const { key: _gk, ...g } = (await reqDone(storeOf("meta").get("groups"))) || {};
			groupsData = { groups: [], members: {}, ...g };
			records = new Map(all.map((r) => [r.member, r]));
			convs = new Map(/** @type {LBBConv[]} */ (convList).map((c) => [c.member, c]));
			sessions = /** @type {LBBSession[]} */ (sessionList).sort((a, b) => b.start - a.start);
			nameGroups = buildNameGroups(withLive(sessions));
			unreadTotal = /** @type {LBBConv[]} */ (convList).reduce((n, c) => n + (c.unread || 0), 0);
			renderTab();
			renderNav();
			renderList();
			// Chat views update themselves incrementally; only the profile view is redrawn on every refresh
			if (withDetail || section === "profiles") renderDetail();
		}

		function refreshSoon() {
			if (!panel || refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = undefined;
				reload().catch((err) => console.warn(TAG, err));
			}, 500);
		}

		// A short message shown in the status line for a while (import results)
		/** @type {{ text: string, until: number } | null} */
		let statusNote = null;
		/**
		 * @param {string} text
		 * @param {number} [ms]
		 */
		function noteStatus(text, ms = 10_000) {
			statusNote = { text, until: Date.now() + ms };
			updateStatus();
			setTimeout(updateStatus, ms + 50);
		}
		function updateStatus() {
			const el = /** @type {HTMLElement | null} */ (panel?.querySelector("#fm-status"));
			if (!el) return;
			if (statusNote && statusNote.until > Date.now()) return void (el.textContent = statusNote.text);
			statusNote = null;
			el.textContent = `${records.size} profiles · ${onlineFriends.size} friends online${onlineFriendsAt ? ` (${ago(onlineFriendsAt)})` : ""}${
				session && !session.closed ? ` · logging “${session.room.Name}”` : ""
			}`;
		}

		function friendIds() {
			return new Set(Array.isArray(Player.FriendList) ? Player.FriendList : []);
		}

		/** @param {number} member */
		function displayName(member) {
			const rec = records.get(member);
			return rec?.nickname || rec?.name || convs.get(member)?.name || friendNameOf(member) || nameOf(member) || `#${member}`;
		}

		const matches = (/** @type {string} */ q, /** @type {(string | number | null | undefined)[]} */ ...fields) => !q || fields.some((f) => String(f ?? "").toLowerCase().includes(q.toLowerCase()));

		// ---------- lists ----------

		function renderList() {
			if (!panel) return;
			const listEl = part("#fm-list");
			const q = searches[section] || "";
			/** @type {HTMLElement[]} */
			let rows = [];
			let empty = "";
			switch (section) {
				case "profiles":
					rows = profileEntries(q).map((e) =>
						row(
							e.member === selected,
							() => ((selected = e.member), renderList(), renderDetail()),
							[e.member !== me() ? profileStar(e.member) : null, h("span", { class: `fm-dot${e.online ? " on" : ""}` }), h("span", { class: "grow" }, e.name)],
							`#${e.member} · ${e.member === me() ? "live" : e.rec?.data ? `seen ${ago(e.rec.lastSeen || 0)}` : "no snapshot"}${relationText(e)}`
						)
					);
					empty = filter === "favs" ? "No favorite profiles yet. Click ☆ on someone to add them." : "Nothing here yet. Join a room with someone to cache them.";
					break;
				case "chats":
					rows = [...convs.values()]
						// Hidden chats stay out of the list unless asked for (or the one that's open)
						.filter((c) => matches(q, displayName(c.member), c.member) && (showHiddenChats || !c.hidden || c.member === chatMember))
						.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastTs || 0) - (a.lastTs || 0))
						.map((c) =>
							row(
								c.member === chatMember,
								() => openChat(c.member),
								[
									h("span", { class: `fm-dot${onlineOf(c.member) ? " on" : ""}` }),
									c.pinned ? h("span", { title: "Pinned" }, "📌") : null,
									h("span", { class: "grow", style: c.hidden ? "opacity:.5" : "" }, displayName(c.member)),
									queuedFor(c.member) ? h("span", { class: "fm-queued", title: "Queued until they come online" }, `⏳${queuedFor(c.member)}`) : null,
									c.unread ? h("span", { class: "fm-badge" }, String(c.unread)) : null,
									h("span", { class: "fm-muted", style: "font-size:11px;font-weight:400" }, c.lastTs ? ago(c.lastTs) : ""),
								],
								`${c.lastDir === "out" ? "You: " : ""}${c.lastText || ""}`
							)
						);
					empty = "No conversations yet. Beeps and whispers you send or receive show up here.";
					break;
				case "friends": {
					const friendSet = friendIds();
					// Friends, plus anyone you've put in a group even if they aren't on your friend list
					const people = new Set([...friendSet, ...Object.keys(groupsData.members).map(Number)]);
					const all = [...people]
						.map((member) => ({ member, name: displayName(member), online: onlineOf(member), friend: friendSet.has(member) }))
						.filter((f) => matches(q, f.name, f.member))
						.sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.name.localeCompare(b.name));
					const friendRow = (/** @type {{ member: number, name: string, online: boolean, [more: string]: any }} */ f) =>
						row(
							f.member === chatMember,
							() => openChat(f.member),
							[
								h("span", { class: `fm-dot${f.online ? " on" : ""}` }),
								h("span", { class: "grow" }, f.name),
								convs.get(f.member)?.unread ? h("span", { class: "fm-badge" }, String(convs.get(f.member)?.unread)) : null,
							],
							`#${f.member} · ${f.online ? onlineText(f.online) + onlineForText(f.member) : f.friend ? offlineText(f.member) : `not a friend${lastOnlineAt(f.member) ? ` · seen ${ago(lastOnlineAt(f.member))}` : ""}`}`
						);
					const inGroup = (/** @type {{ member: number }} */ f, /** @type {string} */ id) => (groupsData.members[f.member] || []).includes(id);
					const ungrouped = all.filter((f) => f.friend && !(groupsData.members[f.member] || []).length);
					/**
					 * @param {string} key
					 * @param {string} label
					 * @param {string | undefined} color
					 * @param {{ member: number, name: string, online: boolean, [more: string]: any }[]} list
					 * @param {string} [groupId]
					 */
					const section_ = (key, label, color, list, groupId) => {
						const closed = collapsedGroups.has(key);
						const head = h(
							"div",
							{
								class: "fm-group-head",
								title: groupId ? "Click to fold · double-click the name to rename" : "",
								// Folding waits a moment so a double-click (rename) can cancel it before the list redraws
								onclick: () => {
									clearTimeout(groupHeadTimer);
									groupHeadTimer = setTimeout(() => (closed ? collapsedGroups.delete(key) : collapsedGroups.add(key), renderList()), 250);
								},
							},
							h("span", { class: "fm-group-dot", style: `background:${color}` }),
							h(
								"span",
								{ class: "grow", ondblclick: groupId ? (/** @type {MouseEvent} */ e) => (e.stopPropagation(), clearTimeout(groupHeadTimer), renameInline(/** @type {HTMLElement} */ (e.currentTarget), groupId)) : null },
								`${label} (${list.filter((f) => f.online).length}/${list.length})`
							),
							groupId
								? h(
									"span",
									{ class: "fm-group-msg", title: `Message everyone in ${label}`, onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), (chatMember = null), (convView = null), (friendsView = { message: groupId }), renderList(), renderDetail()) },
									"✉"
								)
								: null,
							closed ? "▸" : "▾"
						);
						return [head, ...(closed ? [] : list.map(friendRow))];
					};
					if (groupFilter === "all") {
						rows = groupsData.groups.flatMap((g) => {
							const list = all.filter((f) => inGroup(f, g.id));
							return list.length ? section_(g.id, g.name, g.color, list, g.id) : [];
						});
						rows.push(...(groupsData.groups.length ? section_("ungrouped", "Ungrouped", "#555", ungrouped) : ungrouped.map(friendRow)));
					} else if (groupFilter === "ungrouped") rows = ungrouped.map(friendRow);
					else rows = all.filter((f) => inGroup(f, groupFilter)).map(friendRow);
					empty = groupFilter === "all" ? "No friends on your friend list." : "Nobody here.";
					break;
				}
				case "rooms":
					rows = roomGroups()
						.filter((g) => matches(q, g.name))
						.map((g) =>
							row(
								g.name === roomName && !messageSearch,
								() => openRoom(g.name),
								[favStar(g.name), h("span", { class: "grow" }, g.name), g.live ? h("span", { class: "fm-live" }, "● LIVE") : null],
								`${g.visits} visit${g.visits === 1 ? "" : "s"} · ${g.lines} lines · last ${ago(g.last)}`
							)
						);
					empty = "No rooms logged yet. Every room you enter from now on is recorded here.";
					break;
				case "outfits":
					rows = savedOutfits
						.filter((o) => matches(q, o.name, o.fromName, o.from) && (!outfitFavOnly || o.fav))
						.sort((a, b) => Number(!!b.fav) - Number(!!a.fav) || b.savedAt - a.savedAt)
						.map((o) =>
							row(
								o.id === outfitSel,
								() => ((outfitSel = o.id), renderList(), renderDetail()),
								[outfitStar(o), h("span", { class: "grow" }, o.name)],
								`${o.fromName ? `${o.fromName} · ` : ""}${o.pieces.length} pieces${o.restraints?.length ? ` · ${o.restraints.length} restraints` : ""} · ${ago(o.savedAt)}`
							)
						);
					empty = outfitFavOnly
						? "No favorite outfits yet. Click ☆ on an outfit to add it."
						: "No saved outfits yet. Use “Save outfit” on a profile's Appearance tab, or save your own above.";
					break;
				case "lobby":
					if (lobbyError) empty = lobbyError;
					else if (!lobbyRooms) empty = "Loading rooms…";
					else {
						const select = (/** @type {string} */ name) => () => ((lobbySel = name), renderList(), renderDetail());
						const open_ = lobbyRooms
							.filter((r) => matches(q, r.Name, r.Description, r.Creator) && (!lobbyFavOnly || favRooms.has(r.Name)))
							// Favorites first; the search already put rooms with friends ahead of the rest
							.sort((a, b) => Number(favRooms.has(b.Name)) - Number(favRooms.has(a.Name)));
						const openNames = new Set(lobbyRooms.map((r) => r.Name));
						// Favorites that didn't come back from this search are closed, private, or in another space
						const closedFavs = [...favRooms].filter((name) => !openNames.has(name) && matches(q, name)).sort();
						rows = [
							...open_.map((r) =>
								row(
									r.Name === lobbySel,
									select(r.Name),
									[
										favStar(r.Name),
										h("span", { class: "grow" }, r.Name),
										Array.isArray(r.Friends) && r.Friends.length ? h("span", { class: "fm-badge", title: "Friends inside", style: "background:#2e7d32" }, String(r.Friends.length)) : null,
										h("span", { class: "fm-muted", style: "font-size:12px;font-weight:400" }, `${r.MemberCount}/${r.MemberLimit}${/** @type {any} */ (r).Locked ? " 🔒" : ""}`),
									],
									r.Description || ""
								)
							),
							...closedFavs.map((name) =>
								h(
									"div",
									{ class: `fm-row fm-closed${name === lobbySel ? " sel" : ""}`, onclick: select(name) },
									h("div", { class: "n" }, favStar(name), h("span", { class: "grow" }, name)),
									h("div", { class: "m" }, "not open in this space right now")
								)
							),
						];
						empty = lobbyFavOnly ? "No favorite rooms yet. Click ☆ on a room to add it." : "No rooms match.";
					}
					break;
			}
			listEl.replaceChildren(...rows);
			if (!rows.length) listEl.append(h("div", { class: "fm-row fm-muted" }, empty));
			updateStatus();
		}

		/** @param {string} name */
		async function toggleFavRoom(name) {
			if (favRooms.has(name)) favRooms.delete(name);
			else favRooms.add(name);
			await ensureDb();
			await reqDone(storeOf("meta", "readwrite").put({ key: "favRooms", names: [...favRooms].sort() }));
			renderList();
			if (section === "lobby") renderDetail();
			if (section === "rooms" && roomView && roomView.name === name && roomView.starEl) {
				roomView.starEl.textContent = favRooms.has(name) ? "★" : "☆";
				roomView.starEl.classList.toggle("on", favRooms.has(name));
			}
		}

		/** @param {string} name */
		function favStar(name) {
			const on = favRooms.has(name);
			return h(
				"span",
				{
					class: `fm-star${on ? " on" : ""}`,
					title: on ? "Remove from favorite rooms" : "Add to favorite rooms",
					onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), toggleFavRoom(name)),
				},
				on ? "★" : "☆"
			);
		}

		/**
		 * @param {boolean} isSel
		 * @param {() => void} onclick
		 * @param {any} nameParts
		 * @param {any} sub
		 */
		function row(isSel, onclick, nameParts, sub) {
			return h("div", { class: `fm-row${isSel ? " sel" : ""}`, onclick }, h("div", { class: "n" }, nameParts), h("div", { class: "m" }, sub));
		}

		/** @param {string} q */
		function profileEntries(q) {
			const friends = friendIds();
			const ids = new Set([...friends, ...records.keys()]);
			let list = [...ids].map((member) => {
				const rec = records.get(member);
				return { member, rec, name: rec?.nickname || rec?.name || friendNameOf(member) || "(unknown)", friend: friends.has(member), online: !!onlineOf(member) };
			});
			if (filter === "friends") list = list.filter((e) => e.friend);
			if (filter === "online") list = list.filter((e) => e.online);
			if (filter === "favs") list = list.filter((e) => e.rec?.fav);
			if (q) list = list.filter((e) => matches(q, e.name, e.member));
			// Favorites first, then online, then most recently seen
			return list.sort(
				(a, b) => Number(!!b.rec?.fav) - Number(!!a.rec?.fav) || Number(b.online) - Number(a.online) || (b.rec?.lastSeen || 0) - (a.rec?.lastSeen || 0) || a.name.localeCompare(b.name)
			);
		}

		/** @param {{ member: number, friend: boolean }} e */
		function relationText(e) {
			if (e.member === Player.MemberNumber) return " · you";
			if (inRoomWith(e.member)) return " · in your room";
			return e.friend ? "" : " · not a friend";
		}

		/**
		 * @param {number} member
		 * @param {any} online
		 */
		function presenceText(member, online) {
			if (member === Player.MemberNumber) return "you";
			if (inRoomWith(member)) return "in your room now";
			if (online) return onlineText(online) + onlineForText(member);
			if (friendIds().has(member)) return offlineText(member);
			const t = lastOnlineAt(member);
			return `not a friend (online status unknown)${t ? ` · last seen ${ago(t)}` : ""}`;
		}

		// When someone was last known to be online: the friends query, or being in a room with you
		/** @param {number} member */
		function lastOnlineAt(member) {
			const rec = records.get(member);
			return Math.max(rec?.lastOnline || 0, rec?.lastSeen || 0);
		}
		/** @param {number} member */
		function offlineText(member) {
			const t = lastOnlineAt(member);
			return t ? `offline · last online ${ago(t)}` : "offline";
		}
		// " · for 25m" while online, when we saw them come online
		/** @param {number} member */
		function onlineForText(member) {
			const since = records.get(member)?.onlineSince;
			if (!since || !onlineOf(member)) return "";
			return Date.now() - since < 60_000 ? " · just came online" : ` · for ${fmtDuration(Date.now() - since)}`;
		}
		/** @param {any} f */
		function onlineText(f) {
			if (f.here) return "in your room now";
			if (f.ChatRoomName) return `online in “${f.ChatRoomName}”${f.ChatRoomSpace ? ` (${f.ChatRoomSpace})` : ""}`;
			return f.Private ? "online (private room)" : "online";
		}

		// ---------- main pane ----------

		// The profile view is redrawn on every refresh (new data arrives all the time while the window is open). Keep
		// what the reader was doing: which sections are open (by their summary, without its "— 5m ago"), where the pane
		// and any open block are scrolled, and the note being typed (text and caret), so a refresh doesn't undo it.
		// Only for a redraw of the same view: picking another person or tab starts fresh at the top
		/** @type {string | null} */
		let viewSig = null;
		/**
		 * @param {HTMLElement} el
		 * @param {string} sig
		 * @param {() => void} rebuild
		 */
		function keepViewState(el, sig, rebuild) {
			const same = sig === viewSig;
			viewSig = sig;
			if (!same) return rebuild();
			const keyOf = (/** @type {Element} */ d) => (d.querySelector(":scope > summary")?.textContent || "").split(" — ")[0];
			/** @type {Map<string, number[][]>} */
			const openNow = new Map();
			for (const d of el.querySelectorAll("details")) if (d.open) openNow.set(keyOf(d), [...d.querySelectorAll("pre")].map((p) => [p.scrollTop, p.scrollLeft]));
			const top = el.scrollTop;
			const active = /** @type {HTMLInputElement | null} */ (document.activeElement);
			const typing = active && el.contains(active) && active.dataset.key ? { key: active.dataset.key, value: active.value, a: active.selectionStart, b: active.selectionEnd } : null;
			rebuild();
			for (const d of el.querySelectorAll("details")) {
				const was = openNow.get(keyOf(d));
				if (!was) continue;
				d.open = true;
				d.querySelectorAll("pre").forEach((/** @type {HTMLElement} */ p, /** @type {number} */ i) => was[i] && ((p.scrollTop = was[i][0]), (p.scrollLeft = was[i][1])));
			}
			el.scrollTop = top;
			if (typing) {
				const t = /** @type {HTMLInputElement | null} */ (el.querySelector(`[data-key="${typing.key}"]`));
				if (t) {
					t.value = typing.value;
					t.focus();
					try {
						t.setSelectionRange(typing.a, typing.b);
					} catch {
						// already done or gone: nothing to undo
					}
				}
			}
		}

		function renderDetail() {
			if (!panel) return;
			const el = part("#fm-detail");
			const fill = (/** @type {boolean} */ on) => el.classList.toggle("fm-fill", on);
			switch (section) {
				case "profiles":
					fill(false);
					return keepViewState(el, `${selected}|${detailTab}`, () => renderProfile(el));
				case "outfits":
					fill(false);
					return renderOutfit(el);
				case "chats":
				case "friends":
					if (chatMember == null) {
						fill(false);
						if (section === "friends" && friendsView === "manage") return renderManageGroups(el);
						if (section === "friends" && typeof friendsView === "object" && friendsView?.message) return renderGroupMessage(el, friendsView.message);
						return el.replaceChildren(h("p", { class: "fm-muted" }, "Pick a conversation or friend on the left."));
					}
					fill(true);
					if (!convView || convView.member !== chatMember || !convView.listEl.isConnected) renderConversation(el, chatMember).catch((err) => console.warn(TAG, err));
					return;
				case "rooms":
					if (messageSearch) {
						fill(false);
						renderMessageSearch(el, messageSearch).catch((err) => console.warn(TAG, err));
						return;
					}
					if (roomName == null) {
						fill(false);
						return el.replaceChildren(h("p", { class: "fm-muted" }, "Pick a room on the left, or search all logged messages."));
					}
					fill(true);
					if (!roomView || roomView.name !== roomName || !roomView.linesEl.isConnected) renderRoomLog(el, roomName).catch((err) => console.warn(TAG, err));
					return;
				case "settings":
					fill(false);
					return renderSettings(el);
				case "lobby": {
					fill(false);
					const r = lobbyRooms?.find((x) => x.Name === lobbySel);
					if (r) return el.replaceChildren(h("div", { style: "display:flex;justify-content:flex-end;gap:8px;align-items:center" }, joinButton(r.Name, r), favStar(r.Name)), roomCard(r));
					if (lobbySel && favRooms.has(lobbySel)) {
						const logged = sessions.some((s) => roomKey(s) === lobbySel);
						return el.replaceChildren(
							h("h2", { style: "margin-top:0" }, favStar(lobbySel), " ", lobbySel),
							h("p", { class: "fm-muted" }, "Not in this search: it's closed, private, full and hidden, or in another space."),
							logged ? h("button", { onclick: () => lobbySel && openRoom(lobbySel) }, "Open its chat log") : h("p", { class: "fm-muted" }, "You haven't logged a visit to it yet."),
							" ",
							joinButton(lobbySel, null, "Try to join") || ""
						);
					}
					return el.replaceChildren(h("p", { class: "fm-muted" }, "Pick a room to see its description and who's inside."));
				}
			}
		}

		// ----- conversations -----

		/** @param {number} member */
		function isViewingConv(member) {
			return !!panel && !!convView && convView.member === member && convView.listEl.isConnected;
		}

		/** @param {number} member */
		function openChat(member) {
			chatMember = member;
			friendsView = null;
			if (section !== "chats" && section !== "friends") {
				section = "chats";
				renderNav();
				renderTools();
			}
			convView = null;
			renderList();
			renderDetail();
		}

		/** @param {number} member */
		async function markRead(member) {
			const key = `${me()}:${member}`;
			markGameBeepsRead(member);
			await ensureDb();
			const c = await reqDone(storeOf("convs").get(key));
			if (c && c.unread) {
				c.unread = 0;
				await reqDone(storeOf("convs", "readwrite").put(c));
				refreshSoon();
				refreshBadge().catch((err) => console.warn(TAG, err));
			}
		}

		/**
		 * @param {LBBDm} m
		 * @param {LBBDm | null | undefined} prev
		 * @returns {HTMLElement[]}
		 */
		function bubble(m, prev) {
			/** @type {HTMLElement[]} */
			const out = [];
			const day = new Date(m.ts).toDateString();
			if (!prev || new Date(prev.ts).toDateString() !== day) out.push(h("div", { class: "fm-day" }, day));
			if (m.kind === "reaction") {
				out.push(h("div", { class: "fm-react" }, `${m.dir === "out" ? "You" : displayName(m.member)} reacted ${m.meta?.reactionEmoji || m.text}`));
				return out;
			}
			const type = m.meta?.messageType;
			const text = m.kind === "ping" ? "(beep)" : m.text;
			const meta = [fmtTime(m.ts), m.kind === "whisper" ? "whisper" : m.kind === "ping" ? "beep" : null, m.room ? `in “${m.room}”` : null].filter(Boolean).join(" · ");
			out.push(
				h(
					"div",
					{ class: `fm-msg ${m.dir}${m.kind === "whisper" ? " whisper" : ""}${type === "Emote" || type === "Action" ? " emote" : ""}`, title: fmtDate(m.ts) },
					text,
					h("div", { class: "meta" }, meta)
				)
			);
			return out;
		}

		/**
		 * @param {HTMLElement} el
		 * @param {number} member
		 */
		async function renderConversation(el, member) {
			const online = onlineFriends.get(member);
			const conv = convs.get(member);
			const listEl = h("div", { class: "fm-scroll" }, h("div", { class: "fm-muted" }, "Loading…"));
			const input = h("textarea", { rows: 2 });
			const includeRoom = h("input", { type: "checkbox" });
			const roomOpt = h("label", { class: "fm-muted", style: "font-size:12px;white-space:nowrap", title: "Tell them which room you're in" }, includeRoom, " my room");
			const sendBtn = h("button", {});
			// In the same room you can whisper instead of beeping; whispering is the default there
			const canWhisper = member !== me() && inRoomWith(member);
			/** @type {string} */
			let mode = canWhisper ? composeModes.get(member) || "whisper" : "beep";
			const modeBtns = canWhisper
				? ["whisper", "beep"].map((m) => h("button", { class: "fm-mode", "data-mode": m, onclick: () => setMode(m) }, m === "whisper" ? "Whisper" : "Beep"))
				: [];
			// Offline people can't receive beeps, so messages to them go to the outbox instead
			const queueing = () => mode === "beep" && member !== me() && !reachableNow().has(member);
			const setMode = (/** @type {string} */ m) => {
				mode = m;
				composeModes.set(member, m);
				for (const b of modeBtns) b.classList.toggle("act", b.dataset.mode === m);
				roomOpt.style.display = m === "beep" ? "" : "none";
				sendBtn.textContent = m === "whisper" ? "Whisper" : queueing() ? "Send when online" : "Send beep";
				sendBtn.title = queueing() ? "They're offline: this is beeped once they come online (your game needs to be open)" : "";
				input.placeholder = queueing()
					? `${displayName(member)} is offline. Write a message to beep them when they come online…`
					: `${m === "beep" ? "Beep" : "Whisper to"} ${displayName(member)}… (Enter to send, Shift+Enter for a new line)`;
			};
			const send = () => {
				const text = input.value.trim();
				if (!text) return;
				if (mode === "whisper") {
					const res = typeof ChatRoomSendWhisper === "function" ? ChatRoomSendWhisper(member, text) : "unavailable";
					if (res !== true) {
						sendBtn.textContent = res === "target-out-of-range" ? "Out of whisper range" : "They're not in your room";
						setTimeout(() => setMode(mode), 3000);
						return;
					}
				} else if (queueing()) queueMessage(member, text, includeRoom.checked).catch((err) => console.warn(TAG, err));
				else sendBeep(member, text, includeRoom.checked);
				input.value = "";
			};
			sendBtn.addEventListener("click", send);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					send();
				}
			});
			setMode(mode);
			const pendingEl = h("div", { class: "fm-pending" });
			convView = { member, listEl, pendingEl, last: null, refreshMode: () => setMode(mode) };
			renderPending();
			const isFriend = friendIds().has(member);
			const canInvite = member !== me() && inRoom() && !inRoomWith(member);
			el.replaceChildren(
				h(
					"div",
					{ class: "fm-vhead" },
					h("h2", {}, displayName(member)),
					h("span", { class: "fm-muted" }, `#${member}`),
					h("span", {}, h("span", { class: `fm-dot${online || inRoomWith(member) ? " on" : ""}` }), presenceText(member, online)),
					member !== me() ? groupTags(member) : null,
					h("span", { style: "flex:1" }),
					online?.ChatRoomName ? joinButton(online.ChatRoomName, { Space: online.ChatRoomSpace }, "Join their room") : null,
					canInvite ? inviteButton(member) : null,
					!isFriend && member !== me() ? addFriendButton(member) : null,
					h("button", { title: conv?.pinned ? "Unpin" : "Pin to the top of Chats", onclick: () => setConvFlag(member, "pinned", !conv?.pinned) }, conv?.pinned ? "Unpin" : "Pin"),
					h("button", { title: "Hide from Chats until they message you again", onclick: () => setConvFlag(member, "hidden", true) }, "Hide"),
					h("button", { title: "Download this conversation as text", onclick: () => exportConversation(member) }, "Export"),
					h("button", { onclick: () => open(member, "profiles") }, "Profile"),
					confirmButton("Delete chat", () => deleteConversation(member))
				),
				listEl,
				pendingEl,
				h("div", { class: "fm-compose" }, modeBtns.length ? h("div", { class: "fm-modes" }, modeBtns) : null, input, roomOpt, sendBtn)
			);
			await ensureDb();
			const msgs = await reqDone(storeOf("dms").index("conv").getAll(IDBKeyRange.bound([me(), member, 0], [me(), member, Infinity])));
			if (convView?.listEl !== listEl) return;
			listEl.replaceChildren();
			let prev = null;
			for (const m of msgs) {
				listEl.append(...bubble(m, prev));
				prev = m;
			}
			convView.last = prev;
			if (!msgs.length) listEl.append(h("div", { class: "fm-muted" }, "No messages yet."));
			listEl.scrollTop = listEl.scrollHeight;
			markRead(member).catch((err) => console.warn(TAG, err));
			input.focus();
		}

		// Queued (not yet sent) messages for the open conversation, above the reply box
		function renderPending() {
			const cv = convView;
			if (!cv?.pendingEl) return;
			const queued = outbox.filter((m) => m.member === cv.member);
			cv.pendingEl.replaceChildren(
				...queued.map((m) =>
					h(
						"div",
						{ class: "fm-msg out queued", title: `Queued ${fmtDate(m.createdAt)}` },
						m.text,
						h(
							"div",
							{ class: "meta" },
							`⏳ waiting for them to come online · queued ${ago(m.createdAt)} `,
							h("a", { href: "#", onclick: (/** @type {MouseEvent} */ e) => (e.preventDefault(), cancelQueued(m.key)) }, "cancel")
						)
					)
				)
			);
			cv.pendingEl.style.display = queued.length ? "" : "none";
		}

		// After a Clear / Delete everything on the Settings page
		function onDataCleared() {
			selected = chatMember = roomName = lobbySel = outfitSel = null;
			convView = roomView = null;
			messageSearch = null;
			refreshBadge().catch((err) => console.warn(TAG, err));
			reload().catch((err) => console.warn(TAG, err));
		}

		function onOutboxChanged() {
			renderPending();
			convView?.refreshMode?.();
			if (panel && (section === "chats" || section === "friends")) renderList();
		}

		/** @param {LBBDm} rec */
		function onDm(rec) {
			refreshBadge().catch((err) => console.warn(TAG, err));
			if (isViewingConv(rec.member)) {
				// Seen as it arrives; the game has logged its copy of the beep by now
				if (rec.dir === "in") markGameBeepsRead(rec.member);
				const cv = /** @type {NonNullable<typeof convView>} */ (convView);
				const listEl = cv.listEl;
				if (!cv.last) listEl.replaceChildren();
				const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
				listEl.append(...bubble(rec, cv.last));
				cv.last = rec;
				if (atBottom || rec.dir === "out") listEl.scrollTop = listEl.scrollHeight;
			}
			refreshSoon();
		}

		// ----- friend groups (meta store "groups": { groups: [{ id, name, color }], members: { [member]: [groupId] } }) -----

		const GROUP_COLORS = ["#c9a8ff", "#7fd1b9", "#ffb86b", "#ff8fab", "#8fd3ff", "#e6e47a", "#b4f08a"];
		/** @type {LBBGroups} */
		let groupsData = { groups: [], members: {} };
		let groupFilter = "all"; // "all" | "ungrouped" | group id
		const collapsedGroups = new Set();
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let groupHeadTimer;
		/** @type {null | "manage" | { message: string }} */
		let friendsView = null; // null | "manage" | { message: groupId } (Friends main pane when no chat is open)

		const groupById = (/** @type {string} */ id) => groupsData.groups.find((g) => g.id === id);
		const groupsOf = (/** @type {number} */ member) => (groupsData.members[member] || []).map(groupById).filter(Boolean);
		const membersOf = (/** @type {string} */ id) =>
			Object.entries(groupsData.members)
				.filter(([, ids]) => ids.includes(id))
				.map(([m]) => Number(m));

		async function saveGroups() {
			await ensureDb();
			await reqDone(storeOf("meta", "readwrite").put({ key: "groups", groups: groupsData.groups, members: groupsData.members }));
			if (panel && section === "friends") {
				// The group filter lists group names, so rebuild it too
				renderTools();
				renderList();
			}
		}

		/**
		 * @param {number} member
		 * @param {string} id
		 * @param {boolean} inGroup
		 */
		async function setMemberGroup(member, id, inGroup) {
			const ids = new Set(groupsData.members[member] || []);
			if (inGroup) ids.add(id);
			else ids.delete(id);
			if (ids.size) groupsData.members[member] = [...ids];
			else delete groupsData.members[member];
			await saveGroups();
		}

		/** @param {string} name */
		async function createGroup(name) {
			const id = String(Date.now());
			groupsData.groups.push({ id, name: name || `Group ${groupsData.groups.length + 1}`, color: GROUP_COLORS[groupsData.groups.length % GROUP_COLORS.length] });
			await saveGroups();
			return id;
		}

		/**
		 * @param {string} id
		 * @param {Partial<LBBGroup>} changes
		 */
		async function updateGroup(id, changes) {
			const g = groupById(id);
			if (!g) return;
			Object.assign(g, changes);
			await saveGroups();
		}

		// Swaps a group heading's label for a name box (Enter or click away saves, Esc cancels)
		/**
		 * @param {HTMLElement} labelEl
		 * @param {string} id
		 */
		function renameInline(labelEl, id) {
			const g = groupById(id);
			if (!g) return;
			const input = h("input", { type: "text", class: "fm-gname", value: g.name });
			let done = false;
			const finish = async (/** @type {boolean} */ save) => {
				if (done) return;
				done = true;
				const name = input.value.trim();
				if (save && name && name !== g.name) await updateGroup(id, { name });
				else renderList();
			};
			input.addEventListener("click", (e) => e.stopPropagation());
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") finish(true).catch((err) => console.warn(TAG, err));
				else if (e.key === "Escape") {
					e.stopPropagation();
					finish(false).catch((err) => console.warn(TAG, err));
				}
			});
			input.addEventListener("blur", () => {
				finish(true).catch((err) => console.warn(TAG, err));
			});
			labelEl.replaceWith(input);
			input.focus();
			input.select();
		}

		/** @param {string} id */
		async function deleteGroup(id) {
			groupsData.groups = groupsData.groups.filter((g) => g.id !== id);
			for (const [m, ids] of Object.entries(groupsData.members)) {
				const rest = ids.filter((x) => x !== id);
				if (rest.length) groupsData.members[m] = rest;
				else delete groupsData.members[m];
			}
			if (groupFilter === id) groupFilter = "all";
			await saveGroups();
		}

		// Coloured tags for a person's groups, with × to remove and a "+ Group" picker
		/** @param {number} member */
		function groupTags(member) {
			const wrap = h("span", { class: "fm-groups" });
			// "New group…" swaps the picker for a name box: Enter creates the group and adds this person, Esc cancels
			const askNewGroupName = () => {
				const input = h("input", { type: "text", class: "fm-gname", placeholder: "New group name, Enter" });
				let done = false;
				const finish = async (/** @type {boolean} */ create) => {
					if (done) return;
					done = true;
					const name = input.value.trim();
					if (create && name) await setMemberGroup(member, await createGroup(name), true);
					draw();
				};
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") finish(true).catch((err) => console.warn(TAG, err));
					else if (e.key === "Escape") {
						e.stopPropagation();
						finish(false).catch((err) => console.warn(TAG, err));
					}
				});
				input.addEventListener("blur", () => {
					finish(true).catch((err) => console.warn(TAG, err));
				});
				wrap.lastChild?.replaceWith(input);
				input.focus();
			};
			const draw = () => {
				const mine = groupsOf(member);
				const others = groupsData.groups.filter((g) => !mine.includes(g));
				const picker = h(
					"select",
					{
						class: "fm-gpick",
						title: "Add to a group",
						onchange: async (/** @type {Event & { target: HTMLSelectElement }} */ e) => {
							const v = e.target.value;
							if (!v) return;
							if (v === "__new") return askNewGroupName();
							await setMemberGroup(member, v, true);
							draw();
						},
					},
					h("option", { value: "" }, "+ Group"),
					others.map((g) => h("option", { value: g.id }, g.name)),
					h("option", { value: "__new" }, "New group…")
				);
				wrap.replaceChildren(
					...mine.map((g) =>
						h(
							"span",
							{ class: "fm-gtag", style: `background:${g.color}` },
							g.name,
							h("span", { class: "x", title: `Remove from ${g.name}`, onclick: async () => (await setMemberGroup(member, g.id, false), draw()) }, "×")
						)
					),
					picker
				);
			};
			draw();
			return wrap;
		}

		/** @param {HTMLElement} el */
		function renderManageGroups(el) {
			const nameEl = h("input", { type: "text", placeholder: "New group name" });
			const add = async () => {
				await createGroup(nameEl.value.trim());
				renderManageGroups(el);
			};
			nameEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") add().catch((err) => console.warn(TAG, err));
			});
			el.replaceChildren(
				h("h3", { style: "margin-top:0" }, "Friend groups"),
				h("p", { class: "fm-muted" }, "Add people to groups from their chat or profile (+ Group). Someone can be in several groups."),
				h("div", { style: "display:flex;gap:6px;margin-bottom:10px" }, nameEl, h("button", { onclick: add }, "Add group")),
				groupsData.groups.length
					? h(
						"table",
						{},
						groupsData.groups.map((g) => {
							const name = h("input", { type: "text", value: g.name });
							// Saves as you type (and again on Enter/blur), so there's no separate save step
							/** @type {ReturnType<typeof setTimeout> | undefined} */
							let nameTimer;
							const saveName = () => name.value.trim() && name.value.trim() !== g.name && updateGroup(g.id, { name: name.value.trim() });
							name.addEventListener("input", () => {
								clearTimeout(nameTimer);
								nameTimer = setTimeout(saveName, 400);
							});
							name.addEventListener("change", () => {
								const p = saveName();
								if (p) p.catch((err) => console.warn(TAG, err));
							});
							const color = h("input", { type: "color", value: g.color, style: "padding:0;width:32px;height:26px" });
							color.addEventListener("change", () => {
								updateGroup(g.id, { color: color.value }).catch((err) => console.warn(TAG, err));
							});
							return h(
								"tr",
								{},
								h("td", { style: "width:40px" }, color),
								h("td", {}, name),
								h("td", { class: "fm-muted" }, `${membersOf(g.id).length} people`),
								h(
									"td",
									{ style: "text-align:right" },
									h("button", { onclick: () => ((friendsView = { message: g.id }), renderDetail()) }, "Message group"),
									" ",
									confirmButton("Delete", async () => (await deleteGroup(g.id), renderManageGroups(el)))
								)
							);
						})
					)
					: h("p", { class: "fm-muted" }, "No groups yet.")
			);
		}

		function syncStatusText() {
			if (!syncStatus.at) return "Not synced yet this session.";
			const kb = Math.max(1, Math.round((syncStatus.size * 2) / 1024));
			const parts = [`Synced ${ago(syncStatus.at)}`, `${syncStatus.items} items`, `${kb} KB`];
			if (syncStatus.applied) parts.push(`${syncStatus.applied} change${syncStatus.applied === 1 ? "" : "s"} from your other computers`);
			return parts.join(" · ") + (syncStatus.note ? `. ${syncStatus.note}` : "");
		}

		// When each person last got a group message (while this page is open), for the per-person limit
		/** @type {Map<number, number>} */
		const lastGroupMsg = new Map();
		const fmtSecs = (/** @type {number} */ s) => (s >= 60 ? `${Math.round(s / 6) / 10} min` : `${s} s`).replace(".0 ", " ");

		// One message to everyone in a group: beeped now if they're online, otherwise held in the outbox
		/**
		 * @param {HTMLElement} el
		 * @param {string} id
		 */
		function renderGroupMessage(el, id) {
			const g = groupById(id);
			if (!g) return el.replaceChildren(h("p", { class: "fm-muted" }, "That group no longer exists."));
			const people = membersOf(id).filter((m) => m !== me());
			const reachable = reachableNow();
			const input = h("textarea", { rows: 4, style: "width:100%", placeholder: `Message everyone in ${g.name}…` });
			const includeRoom = h("input", { type: "checkbox" });
			const result = h("div", { class: "fm-muted", style: "margin-top:6px" });
			const sendBtn = h(
				"button",
				{
					onclick: async () => {
						const text = input.value.trim();
						if (!text || !people.length) return;
						sendBtn.disabled = true;
						let now = 0;
						let later = 0;
						let held = 0;
						const perPerson = Math.max(0, prefs.groupPerPersonSec || 0) * 1000;
						for (const m of people) {
							// One group message per person per interval (Settings), so groups can't be used to flood anyone
							if (perPerson && Date.now() - (lastGroupMsg.get(m) || 0) < perPerson) {
								held++;
								continue;
							}
							lastGroupMsg.set(m, Date.now());
							if (reachableNow().has(m)) {
								sendBeep(m, text, includeRoom.checked);
								now++;
								// Spread the beeps out rather than firing them all at once
								await sleep(Math.max(1, prefs.groupGapSec || 1.5) * 1000);
							} else {
								await queueMessage(m, text, includeRoom.checked);
								later++;
							}
						}
						// Nothing went out: keep the text so it can be sent once the limit has passed
						input.value = held && !now && !later ? text : "";
						sendBtn.disabled = false;
						result.textContent = `Beeped ${now} now${later ? `, queued ${later} for when they come online` : ""}${held ? `, skipped ${held} who got a group message in the last ${fmtSecs(prefs.groupPerPersonSec)}` : ""}.`;
					},
				},
				`Send to ${people.length}`
			);
			el.replaceChildren(
				h("h3", { style: "margin-top:0" }, h("span", { class: "fm-gtag", style: `background:${g.color}` }, g.name), " Message group"),
				h(
					"div",
					{ class: "fm-chips", style: "margin-bottom:8px" },
					people.map((m) => h("span", { class: "fm-chip" }, h("span", { class: `fm-dot${reachable.has(m) ? " on" : ""}` }), displayName(m)))
				),
				people.length ? "" : h("p", { class: "fm-muted" }, "Nobody is in this group yet."),
				input,
				h("div", { style: "display:flex;gap:10px;align-items:center;margin-top:6px" }, h("label", { class: "fm-muted" }, includeRoom, " include my room"), sendBtn),
				h(
					"p",
					{ class: "fm-muted", style: "font-size:12px" },
					`Online people get it now as a beep; offline ones get it from the outbox when they come online. Each person gets at most one group message every ${fmtSecs(prefs.groupPerPersonSec)} (Settings, Messages).`
				),
				result
			);
		}

		/** @type {Map<number, string>} */
		const composeModes = new Map(); // member → "whisper" | "beep", remembered while the page is open
		const queuedFor = (/** @type {number} */ member) => outbox.filter((m) => m.member === member).length;
		let showHiddenChats = false;

		// ----- settings (per account, saved in the meta store's "prefs") -----

		const RETENTION_CHOICES = [
			[0, "Forever"],
			[7, "7 days"],
			[30, "30 days"],
			[90, "90 days"],
			[180, "6 months"],
			[365, "1 year"],
		];
		const fmtBytes = (/** @type {number | null | undefined} */ n) => (n == null ? "unknown" : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

		/** @param {HTMLElement} el */
		function renderSettings(el) {
			const redraw = () => renderSettings(el);
			// opts: { sub: indent under the setting above, off: greyed with this reason }
			/**
			 * @param {string} key
			 * @param {string} label
			 * @param {string | null} [hint]
			 * @param {{ sub?: boolean, off?: string | null }} [opts] off: why it's greyed out
			 */
			const toggle = (key, label, hint, opts = {}) => {
				const cb = h("input", {
					type: "checkbox",
					disabled: !!opts.off,
					onchange: async (/** @type {Event & { target: HTMLInputElement }} */ e) => {
						const on = e.target.checked;
						if (on && key.startsWith("notify") && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
						setPref(key, on);
						redraw();
					},
				});
				cb.checked = !!prefs[key];
				return h(
					"label",
					{ class: `fm-set-row${opts.sub ? " sub" : ""}${opts.off ? " off" : ""}` },
					cb,
					" ",
					label,
					hint || opts.off ? h("div", { class: "fm-muted fm-set-hint" }, opts.off || hint) : null
				);
			};
			const retention = (/** @type {string} */ key, /** @type {string} */ label) =>
				h(
					"label",
					{ class: "fm-set-row" },
					`${label} `,
					h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => (setPref(key, parseInt(e.target.value, 10)), redraw()) },
						RETENTION_CHOICES.map(([v, t]) => h("option", { value: v, selected: prefs[key] === v }, t))
					)
				);
			/**
			 * @param {string} key
			 * @param {string} label
			 * @param {[number, string][]} options
			 * @param {string} [hint]
			 */
			const choice = (key, label, options, hint) =>
				h(
					"label",
					{ class: "fm-set-row" },
					`${label} `,
					h(
						"select",
						{ onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => (setPref(key, Number(e.target.value)), redraw()) },
						options.map(([v, t]) => h("option", { value: v, selected: Number(prefs[key]) === v }, t))
					),
					hint ? h("div", { class: "fm-muted fm-set-hint" }, hint) : null
				);
			const clearBtn = (/** @type {string} */ kind, /** @type {string} */ label) =>
				confirmButton(label, async () => {
					await clearData(kind);
					redraw();
				});

			const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
			const openers = [prefs.showBubble, prefs.cmdBook, prefs.cmdChat].filter(Boolean).length;
			// Never let the last way of opening the panel be switched off
			const lastOpener = (/** @type {string} */ key) => (prefs[key] && openers === 1 ? "This is the only way left to open your Little Black Book, so it can't be turned off." : null);
			const statsEl = h("div", { class: "fm-muted" }, "Counting…");
			const siteEl = h("div", { class: "fm-muted", style: "font-size:12px;margin-top:4px" });

			el.replaceChildren(
				h("div", { class: "fm-set" },
					h("h2", { style: "margin-top:0" }, "Settings"),
					h("p", { class: "fm-muted" }, `For this account (#${me()}) in this browser. Turning recording off stops new data being saved; what's already saved stays until you clear it.`),

					h("h3", {}, "Recording"),
					toggle("logRooms", "Room chat logs", "Every room you enter: its settings, who was there, and every chat line."),
					toggle("logRoomChanges", "Room setting and description changes", "Logged as lines in the room's log.", { sub: true, off: prefs.logRooms ? null : "Needs room chat logs." }),
					toggle("logChats", "Beep and whisper history", "Chats keeps working for sending, but nothing new is saved or counted as unread."),
					toggle("captureProfiles", "Profile snapshots", "Saves the profile, outfit and crafts of people you share a room with, for looking up later."),
					toggle("refreshAppearance", "Keep their items up to date during the visit", "Re-saves someone's outfit when items are put on or changed.", { sub: true, off: prefs.captureProfiles ? null : "Needs profile snapshots." }),
					toggle("captureAddonMsgs", "Add-on messages", "Hidden messages add-ons send in the room. Used for add-on detection and the Mod messages tab."),

					h("h3", {}, "Storage"),
					retention("roomLogDays", "Keep room logs for"),
					retention("chatDays", "Keep beeps and whispers for"),
					h("div", { class: "fm-muted fm-set-hint", style: "margin-left:0" }, "Older entries are removed automatically (checked at login and every few hours). Pinned and unread chats are kept."),
					statsEl,
					siteEl,
					h("div", { class: "fm-set-btns" },
						clearBtn("rooms", "Clear room logs"),
						clearBtn("chats", "Clear chat history"),
						clearBtn("profiles", "Clear profiles"),
					),
					toggle(
						"exportFull",
						"Full exports",
						"Off (recommended): export files leave out other people's descriptions, outfits and crafts, and outfits saved from them. Your own data is always included. On: everything goes in, for your own backups."
					),
					h("div", { class: "fm-set-btns" },
						h("button", { onclick: exportEverything, title: "All of this account's Little Black Book data as one JSON file" }, "Export everything"),
						confirmButton("Delete everything", async () => {
							await clearData("all");
							redraw();
						}, { title: "Profiles, logs, chats, groups, saved outfits, favorites and queued messages. Settings are kept." }),
					),

					h("h3", {}, "Sync between computers"),
					toggle(
						"syncAccount",
						"Sync through your account",
						"Settings, friend groups, notes, favorite profiles and rooms, pinned/hidden chats and your own saved outfits follow you to other computers, through the game's private add-on storage for your account (other players never see it). Changes from another computer arrive at your next login. Chat logs, cached profiles and outfits saved from other people stay on each computer. This switch is per computer."
					),
					prefs.syncAccount
						? h(
							"div",
							{ class: "fm-set-row sub" },
							h("span", { class: "fm-muted", style: "margin-right:8px" }, syncStatusText()),
							h(
								"button",
								{
									onclick: async (/** @type {MouseEvent} */ e) => {
										/** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
										try {
											await syncAccount(true);
										} catch (err) {
											console.warn(TAG, "sync failed", err);
										}
										redraw();
									},
								},
								"Sync now"
							)
						)
						: null,

					h("h3", {}, "Messages"),
					toggle("outboxAutoSend", "Send queued messages automatically", "When off, messages for offline people wait until you press Send now."),
					outbox.length
						? h("div", { class: "fm-set-row sub" },
							`${outbox.length} queued · ${outbox.filter((m) => reachableNow().has(m.member)).length} for people online now `,
							h("button", { onclick: async () => (await deliverOutbox(true), redraw()) }, "Send now"))
						: null,
					choice("groupGapSec", "Group messages: time between beeps", [[1, "1 s"], [1.5, "1.5 s"], [2, "2 s"], [3, "3 s"], [5, "5 s"]]),
					choice(
						"groupPerPersonSec",
						"Group messages: at most one per person every",
						[[30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"], [900, "15 min"]],
						"Stops groups being used to flood anyone. People skipped this way are listed after sending."
					),
					toggle("syncGameRead", "Mark beeps read in the game too", "Reading a chat here clears its unread count in the game's own friend list."),
					toggle("notifyWhispers", "Desktop notification for whispers", "When the game tab isn't in front. The game doesn't notify whispers itself."),
					toggle("notifyBeeps", "Desktop notification for beeps", "The game already notifies beeps with its own setting, so this usually doubles up."),
					toggle(
						"notifyOnline",
						"Notify when flagged friends come online",
						`Flag someone with 🔔 on their profile (${bells.size} flagged). Checked about once a minute while the game is open; desktop notification when the tab is in the background, otherwise a line in your chat only you see. Works for mutual friends, the only ones the game reports online.`
					),
					perm === "denied" ? h("p", { style: "color:#ff8a8a" }, "Notifications are blocked for this site in your browser settings.") : null,
					perm !== "unsupported"
						? h(
							"div",
							{ class: "fm-set-row sub" },
							h(
								"button",
								{
									title: "Shows a desktop notification now, asking your browser for permission first if needed",
									onclick: async (/** @type {MouseEvent} */ e) => {
										const out = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).nextElementSibling);
										if (Notification.permission === "default") await Notification.requestPermission();
										if (Notification.permission !== "granted") return (out.textContent = "Blocked: allow notifications for this site in the browser (padlock left of the address).");
										new Notification("Little Black Book", { body: "Desktop notifications work. Check Windows' notification settings / Focus if you didn't see this.", tag: "fm-test" });
										out.textContent = "Sent.";
									},
								},
								"Test desktop notification"
							),
							h("span", { class: "fm-muted", style: "margin-left:8px" }, perm === "granted" ? "Allowed" : perm === "default" ? "Not asked yet" : "")
						)
						: null,
					perm === "unsupported" ? h("p", { class: "fm-muted" }, "This browser doesn't support notifications.") : null,

					h("h3", {}, "Other people's outfits"),
					toggle(
						"outfitCopyAnyone",
						"Copy, save and wear anyone's outfit",
						"Off (recommended): only with their consent, checked as set below, the way the game asks before you can copy a look in their wardrobe. The add-on rules count copying someone's look without their OK as taking it. Only turn this on for people who are fine with it."
					),
					toggle("outfitNeedRoom", "Only while you're in the same room as them", null, { sub: true, off: prefs.outfitCopyAnyone ? "Not used while anyone's outfit can be copied." : null }),
					toggle("outfitNeedInteract", "Only if they allow you to interact with them", "Checked by the game while they're in the room with you; skipped for cached profiles.", { sub: true, off: prefs.outfitCopyAnyone ? "Not used while anyone's outfit can be copied." : null }),
					toggle("outfitNeedWardrobe", "Only if their wardrobe is open to others", "The game's full wardrobe access setting. Without the room check, their last saved profile is used.", { sub: true, off: prefs.outfitCopyAnyone ? "Not used while anyone's outfit can be copied." : null }),

					h("h3", {}, "Opening your Little Black Book"),
					toggle("showBubble", "Show the 📓 tab in the dock", "Hidden, it still shows while Little Black Book is open.", { off: lastOpener("showBubble") }),
					toggle("cmdBook", "/book command", null, { off: lastOpener("cmdBook") }),
					toggle("cmdChat", "/chat command", "Turn off if another add-on also uses /chat.", { off: lastOpener("cmdChat") })
				)
			);

			storageStats()
				.then((st) => {
					statsEl.textContent = `Saved now: ${st.sessions} room visits (${st.roomMsgs} lines) · ${st.convs} chats (${st.dms} messages) · ${st.profiles} profiles`;
					/** @type {Record<string, string>} */
					const KIND = { indexedDB: "databases", caches: "cached files", serviceWorkerRegistrations: "service worker", fileSystem: "files" };
					const parts = st.details
						? Object.entries(st.details)
							.filter(([, n]) => n > 0)
							.sort((a, b) => b[1] - a[1])
							.map(([k, n]) => `${KIND[k] || k} ${fmtBytes(n)}`)
						: [];
					siteEl.replaceChildren(
						`The whole game site uses ${fmtBytes(st.usage)} in this browser${parts.length ? ` (${parts.join(", ")})` : ""}. ` +
							"That includes the game and every add-on, not just Little Black Book.",
						st.databases.length ? h("div", {}, `Databases on this site: ${st.databases.join(", ")}`) : ""
					);
				})
				.catch(() => (statsEl.textContent = ""));
		}

		// Sends a beep that carries your room, so they can join from the beep
		/** @param {number} member */
		function inviteButton(member) {
			const btn = h(
				"button",
				{
					title: "Beep them an invite to your room",
					onclick: () => {
						sendBeep(member, `Come join me in “${currentRoomName()}”?`, true);
						btn.textContent = "Invited ✓";
						btn.disabled = true;
					},
				},
				"Invite to my room"
			);
			return btn;
		}

		// Same steps as the game's Add Friends screen
		/** @param {number} member */
		function addFriendButton(member) {
			const btn = h(
				"button",
				{
					onclick: () => {
						if (typeof ChatRoomListUpdate !== "function" || typeof ServerPlayerRelationsSync !== "function") return (btn.textContent = "Not available");
						ChatRoomListUpdate(Player.FriendList, true, member, "FriendRequest", false);
						ServerPlayerRelationsSync();
						requestOnlineFriends();
						btn.textContent = "Friend added ✓";
						btn.disabled = true;
					},
				},
				"Add friend"
			);
			return btn;
		}

		/**
		 * @param {number} member
		 * @param {"pinned" | "hidden"} flag
		 * @param {boolean} value
		 */
		async function setConvFlag(member, flag, value) {
			await ensureDb();
			const key = `${me()}:${member}`;
			const c = (await reqDone(storeOf("convs").get(key))) || { key, owner: me(), member, unread: 0, name: displayName(member) };
			c[flag] = value;
			await reqDone(storeOf("convs", "readwrite").put(c));
			if (flag === "hidden" && value) {
				chatMember = null;
				convView = null;
			} else convView = null;
			await reload(true);
		}

		/** @param {number} member */
		async function exportConversation(member) {
			await ensureDb();
			const msgs = await reqDone(storeOf("dms").index("conv").getAll(IDBKeyRange.bound([me(), member, 0], [me(), member, Infinity])));
			const who = displayName(member);
			const lines = /** @type {LBBDm[]} */ (msgs).map((m) => {
				const from = m.dir === "out" ? "You" : who;
				const kind = m.kind === "whisper" ? "whisper" : m.kind === "reaction" ? "reaction" : "beep";
				const text = m.kind === "ping" ? "(beep)" : m.kind === "reaction" ? m.meta?.reactionEmoji || m.text : m.text;
				return `[${fmtDate(m.ts)}] ${from} (${kind}${m.room ? `, in “${m.room}”` : ""}): ${text}`;
			});
			download(
				`chat-${safeName(who)}-${member}-${new Date().toISOString().slice(0, 10)}.txt`,
				`Conversation with ${who} (#${member})\n${msgs.length} messages\n${"-".repeat(40)}\n${lines.join("\n")}\n`,
				"text/plain"
			);
		}

		// Permanent deletes ask for a second click instead of a browser dialog (dialogs freeze the game)
		// texts: { armed, busy } override the wording for non-delete actions
		/**
		 * A button that asks for a second click before doing it
		 * @param {string} label
		 * @param {() => void | Promise<unknown>} onConfirm
		 * @param {Record<string, any>} [attrs]
		 * @param {{ armed?: string, busy?: string }} [texts]
		 */
		function confirmButton(label, onConfirm, attrs = {}, texts = {}) {
			let armed = false;
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let timer;
			const reset = () => {
				armed = false;
				btn.disabled = false;
				btn.textContent = label;
				btn.style.background = "";
			};
			const btn = h(
				"button",
				{
					...attrs,
					onclick: async (/** @type {MouseEvent} */ e) => {
						e.stopPropagation();
						if (!armed) {
							armed = true;
							btn.textContent = texts.armed || "Click again to delete";
							btn.style.background = "#7a1f3d";
							timer = setTimeout(reset, 4000);
							return;
						}
						clearTimeout(timer);
						btn.disabled = true;
						btn.textContent = texts.busy || "Deleting…";
						await onConfirm();
						// Deletes usually redraw the view; anything still on screen goes back to normal
						if (btn.isConnected) reset();
					},
				},
				label
			);
			return btn;
		}

		// Shown only while you're not in a room; closes the panel once the game moves you in
		/**
		 * @param {string} name
		 * @param {any} room what the search said about it (null: not known)
		 * @param {string} [label]
		 */
		function joinButton(name, room, label = "Join") {
			if (inRoom()) return null;
			const btn = h(
				"button",
				{
					class: "fm-join",
					onclick: async (/** @type {MouseEvent} */ e) => {
						e.stopPropagation();
						btn.disabled = true;
						btn.textContent = "Joining…";
						const res = await joinRoom(name, room);
						if (res.ok) return close();
						btn.textContent = res.error || "";
						setTimeout(() => {
							btn.disabled = false;
							btn.textContent = label;
						}, 4000);
					},
				},
				label
			);
			return btn;
		}

		/** @param {number} member */
		async function deleteConversation(member) {
			await ensureDb();
			const keys = await reqDone(storeOf("dms").index("conv").getAllKeys(IDBKeyRange.bound([me(), member, 0], [me(), member, Infinity])));
			const t = openDb().transaction(["dms", "convs"], "readwrite");
			for (const k of keys) t.objectStore("dms").delete(k);
			t.objectStore("convs").delete(`${me()}:${member}`);
			await txDone(t);
			chatMember = null;
			convView = null;
			refreshBadge().catch((err) => console.warn(TAG, err));
			await reload(true);
		}

		/** @param {MouseEvent} e */
		async function runLianChatImport(e) {
			const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
			btn.disabled = true;
			btn.textContent = "Importing…";
			try {
				const res = await importLianChat();
				btn.textContent = res.error ? res.error : `Imported ${res.added} (${res.skipped} already here)`;
			} catch (err) {
				console.warn(TAG, "LianChat import failed", err);
				btn.textContent = "Import failed (see console)";
			}
			convView = null;
			await reload(true);
			setTimeout(() => {
				btn.disabled = false;
				btn.textContent = "Import LianChat";
			}, 4000);
		}

		// ----- room sessions -----

		// Visits to rooms with the same name (or names linked by a rename) are shown as one growing log,
		// under the latest name seen
		/** @type {Map<string, string>} */
		let nameGroups = new Map();
		const roomKey = (/** @type {LBBSession} */ s) => nameGroups.get(s.room?.Name) || s.room?.Name || "(room)";
		const withLive = (/** @type {LBBSession[]} */ list) => (session ? [...list.filter((x) => x.id !== session?.id), session] : list);

		/**
		 * @param {string} oldName
		 * @param {string} newName
		 */
		async function onRoomRenamed(oldName, newName) {
			// A favorite follows its room to the new name
			if (favRooms.has(oldName)) {
				favRooms.delete(oldName);
				favRooms.add(newName);
				await ensureDb();
				await reqDone(storeOf("meta", "readwrite").put({ key: "favRooms", names: [...favRooms].sort() }));
			}
			if (roomName === oldName || roomView?.name === oldName) {
				roomName = newName;
				roomView = null;
			}
			if (panel) await reload(section === "rooms");
		}

		/** @returns {{ name: string, visits: number, lines: number, last: number, live: boolean }[]} */
		function roomGroups() {
			/** @type {Map<string, { name: string, visits: number, lines: number, last: number, live: boolean }>} */
			const groups = new Map();
			for (const s of sessions) {
				const name = roomKey(s);
				const g = groups.get(name) || { name, visits: 0, lines: 0, last: 0, live: false };
				g.visits++;
				g.lines += s.count || 0;
				g.last = Math.max(g.last, s.end || s.start);
				if (session && !session.closed && session.id === s.id) g.live = true;
				groups.set(name, g);
			}
			return [...groups.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.last - a.last);
		}

		/** @param {string} name */
		function openRoom(name) {
			roomName = name;
			messageSearch = null;
			roomView = null;
			if (section !== "rooms") {
				section = "rooms";
				renderNav();
				renderTools();
			}
			renderList();
			renderDetail();
		}

		// Divider lines marking where each visit starts and stops, so gaps in the conversation are visible
		/**
		 * @param {LBBSession} s
		 * @returns {LBBLogItem}
		 */
		const joinMarker = (s) => ({ marker: true, type: "Session", ts: s.start, text: "You joined", visit: s.id });
		/**
		 * @param {LBBSession} s
		 * @returns {LBBLogItem}
		 */
		const endMarker = (s) => ({ marker: true, type: "Session", ts: s.end, text: s.closed ? "You left" : "Log ends here (page closed or disconnected)" });

		/**
		 * @param {LBBLogItem} l
		 * @param {string} q
		 * @param {LBBPeople | undefined} people
		 */
		function lineEl(l, q, people) {
			if (l.type === "Session") {
				// The visit you're in right now can't be deleted
				const deletable = l.visit && !(session && !session.closed && session.id === l.visit);
				return h(
					"div",
					{ class: "fm-line t-Session" },
					`── ${l.text} · ${fmtDate(l.ts)} ──`,
					deletable ? confirmButton("delete this visit", () => deleteVisit(l.visit), { class: "fm-visit-del" }) : null
				);
			}
			return h("div", { class: `fm-line t-${l.type}`, title: fmtDate(l.ts) }, h("span", { class: "ts" }, fmtTime(l.ts)), richText(l.text, q, people));
		}

		// Appends s with search matches wrapped in <mark>
		/**
		 * @param {HTMLElement} el
		 * @param {string} s
		 * @param {string} q
		 */
		function markInto(el, s, q) {
			if (!q) return el.append(s);
			const lower = s.toLowerCase();
			let i = 0;
			for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
				el.append(s.slice(i, j), h("mark", {}, s.slice(j, j + q.length)));
				i = j + q.length;
			}
			el.append(s.slice(i));
		}

		const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		/** @type {WeakMap<LBBPeople, RegExp | null>} */
		const peopleRe = new WeakMap();

		// Every known name in the line gets that person's colour; clicking it opens their profile
		/**
		 * @param {string} text
		 * @param {string} q
		 * @param {LBBPeople | undefined} people
		 */
		function richText(text, q, people) {
			const out = h("span", {});
			if (!people || !people.size) {
				markInto(out, text, q);
				return out;
			}
			let re = peopleRe.get(people);
			if (!re) {
				const names = [...people.keys()].filter((n) => n.length > 1).sort((a, b) => b.length - a.length);
				re = names.length ? new RegExp(names.map(escapeRe).join("|"), "g") : null;
				peopleRe.set(people, re);
			}
			let i = 0;
			if (re) {
				for (const m of text.matchAll(re)) {
					markInto(out, text.slice(i, m.index), q);
					const p = people.get(m[0]);
					if (!p) continue;
					const name = h("span", { class: "fm-name", style: `color:${p.color}`, title: `#${p.member}`, onclick: () => open(p.member, "profiles") });
					markInto(name, m[0], q);
					out.append(name);
					i = m.index + m[0].length;
				}
			}
			markInto(out, text.slice(i), q);
			return out;
		}

		// A readable name colour: the character's own label colour, lightened if too dark for this background,
		// or a steady colour derived from the member number when there isn't one
		/**
		 * @param {number} member
		 * @param {string} label
		 */
		function nameColor(member, label) {
			const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(label || "").trim());
			if (m) {
				let hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
				let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
				const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
				// White/near-white is the game's default, so it doesn't tell people apart; use the per-member colour instead
				if (lum < 0.9) {
					if (lum < 0.45) [r, g, b] = [r, g, b].map((c) => Math.round(c + (255 - c) * (0.45 - lum + 0.25)));
					return `rgb(${r},${g},${b})`;
				}
			}
			return `hsl(${(member * 137.508) % 360},70%,72%)`;
		}

		// Name → { member, color } for everyone seen in these visits (nicknames and real names)
		/**
		 * @param {LBBSession[]} visits
		 * @returns {LBBPeople}
		 */
		function peopleOf(visits) {
			/** @type {LBBPeople} */
			const people = new Map();
			const add = (/** @type {number} */ member, /** @type {string} */ name, /** @type {string} */ label) => {
				if (!name || !Number.isFinite(member) || people.has(name)) return;
				people.set(name, { member, color: nameColor(member, label) });
			};
			for (const s of visits) {
				for (const [n, name] of Object.entries(s.members || {})) {
					const member = Number(n);
					const data = records.get(member)?.data;
					const label = s.colors?.[n] || data?.LabelColor;
					add(member, name, label);
					if (data?.Name && data.Name !== name) add(member, data.Name, label);
				}
			}
			add(me(), typeof CharacterNickname === "function" ? CharacterNickname(Player) : Player.Name, Player.LabelColor);
			add(me(), Player.Name, Player.LabelColor);
			return people;
		}

		/**
		 * @param {LBBLogItem} l
		 * @param {string} q
		 */
		function lineVisible(l, q) {
			if (l.type === "Session") return true;
			const group = FILTER_TYPES.find(([, types]) => types.includes(l.type))?.[0] || "System";
			return !hiddenTypes.has(group) && (!q || l.text.toLowerCase().includes(q));
		}

		/**
		 * @param {HTMLElement} el
		 * @param {string} name
		 */
		async function renderRoomLog(el, name) {
			const linesEl = h("div", { class: "fm-scroll" }, h("div", { class: "fm-muted" }, "Loading…"));
			/** @type {LBBRoomView} */
			const view = (roomView = { name, linesEl, items: [], sessionIds: new Set(), visits: [], find: "" });
			await ensureDb();
			/** @type {LBBSession[]} */
			const allVisits = await reqDone(storeOf("sessions").index("owner").getAll(me()));
			nameGroups = buildNameGroups(withLive(allVisits));
			const visits = allVisits.filter((s) => roomKey(s) === name).sort((a, b) => a.start - b.start);
			/** @type {LBBLine[][]} */
			const perVisit = await Promise.all(visits.map((s) => reqDone(storeOf("roomMsgs").index("session").getAll(s.id))));
			if (roomView !== view) return;
			if (!visits.length) return el.replaceChildren(h("p", { class: "fm-muted", style: "padding:16px" }, "No visits logged for this room."));
			const liveId = session && !session.closed ? session.id : null;
			visits.forEach((s, i) => {
				view.sessionIds.add(s.id);
				view.items.push(joinMarker(s), ...perVisit[i]);
				if (s.id !== liveId) view.items.push(endMarker(s));
			});
			view.visits = visits;
			view.people = peopleOf(visits);
			const live = visits.some((s) => s.id === liveId);
			const latest = visits[visits.length - 1];
			const r = latest.room || {};
			const members = {};
			for (const s of visits) Object.assign(members, s.members || {});
			const lineCount = view.items.filter((l) => !l.marker).length;
			const findEl = h("input", { type: "search", placeholder: "Find in this room", style: "flex:1;min-width:120px" });
			findEl.addEventListener("input", () => {
				view.find = findEl.value.trim().toLowerCase();
				drawLines(view);
			});
			const filterBtns = FILTER_TYPES.map(([label]) =>
				h(
					"button",
					{
						class: hiddenTypes.has(label) ? "off" : "",
						onclick: (/** @type {MouseEvent} */ e) => {
							if (hiddenTypes.has(label)) hiddenTypes.delete(label);
							else hiddenTypes.add(label);
							/** @type {HTMLElement} */ (e.currentTarget).classList.toggle("off", hiddenTypes.has(label));
							drawLines(view);
						},
					},
					label
				)
			);
			el.replaceChildren(
				h(
					"div",
					{ class: "fm-vhead" },
					(view.starEl = favStar(name)),
					h("h2", {}, name),
					live ? h("span", { class: "fm-live" }, "● LIVE") : null,
					h(
						"span",
						{ class: "fm-muted" },
						`${visits.length} visit${visits.length === 1 ? "" : "s"} · ${fmtDate(visits[0].start)} – ${live ? "now" : fmtDate(latest.end)} · ${lineCount} lines`
					),
					h("span", { style: "flex:1" }),
					live ? null : joinButton(name, latest.room, "Join"),
					h("button", { onclick: () => exportRoom(view, "txt") }, "Export TXT"),
					h("button", { onclick: () => exportRoom(view, "html") }, "HTML"),
					h("button", { onclick: () => exportRoom(view, "json") }, "JSON"),
					live ? null : confirmButton("Delete room log", () => deleteRoom(view))
				),
				h(
					"details",
					{ style: "padding:0 16px 6px;border-bottom:1px solid var(--bcd-line-soft,#3a2e47)" },
					h("summary", { class: "fm-muted", style: "cursor:pointer" }, "Room details (latest visit)"),
					r.Description ? h("pre", {}, r.Description) : h("p", { class: "fm-muted" }, "No description."),
					kv([
						["Space", r.Space != null ? r.Space || "female" : null],
						["Language", r.Language],
						["Background", r.Background],
						["Limit", r.Limit != null ? String(r.Limit) : null],
						["Game", r.Game],
						["Admins", r.AdminCount != null ? String(r.AdminCount) : null],
						["Locked", r.Locked != null ? (r.Locked ? "yes" : "no") : null],
						["Private", r.Private != null ? (r.Private ? "yes" : "no") : null],
						["Blocked categories", Array.isArray(r.BlockCategory) && r.BlockCategory.length ? r.BlockCategory.join(", ") : null],
						[
							"Members seen",
							h(
								"span",
								{},
								Object.entries(members).map(([n, who], i) => [
									i ? ", " : "",
									h(
										"a",
										{ href: "#", style: "color:var(--bcd-accent,#c9a8ff)", title: addonSummary(Number(n)), onclick: (/** @type {MouseEvent} */ e) => (e.preventDefault(), open(Number(n), "profiles")) },
										`${who} (#${n})`
									),
								])
							),
						],
					])
				),
				h("div", { class: "fm-filters" }, filterBtns, findEl),
				linesEl
			);
			drawLines(view);
			linesEl.scrollTop = linesEl.scrollHeight;
		}

		/** @param {LBBRoomView} view */
		function drawLines(view) {
			const shown = view.items.filter((l) => lineVisible(l, view.find));
			view.linesEl.replaceChildren(...shown.map((l) => lineEl(l, view.find, view.people)));
		}

		/**
		 * @param {LBBRoomView} view
		 * @param {LBBLogItem[]} items
		 */
		function appendItems(view, items) {
			const el = view.linesEl;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			view.items.push(...items);
			for (const l of items) if (lineVisible(l, view.find)) el.append(lineEl(l, view.find, view.people));
			if (atBottom) el.scrollTop = el.scrollHeight;
		}

		/**
		 * The room log on screen, when it's this room's
		 * @param {string} name
		 */
		const viewingRoom = (name) => (panel && roomView && roomView.name === name && roomView.linesEl.isConnected ? roomView : null);

		/** @param {LBBSession} s */
		function onSessionStarted(s) {
			const rv = viewingRoom(roomKey(s));
			if (rv && !rv.sessionIds.has(s.id)) {
				rv.sessionIds.add(s.id);
				appendItems(rv, [joinMarker(s)]);
			}
			refreshSoon();
		}

		/** @param {LBBSession} s */
		function onSessionClosed(s) {
			const rv = viewingRoom(roomKey(s));
			if (rv && rv.sessionIds.has(s.id)) appendItems(rv, [endMarker(s)]);
			refreshSoon();
		}

		/** @param {LBBLine[]} batch */
		function onRoomLines(batch) {
			const sid = batch[0]?.session;
			const cur = session;
			const rv = cur && cur.id === sid ? viewingRoom(roomKey(cur)) : null;
			if (cur && rv) {
				if (!rv.sessionIds.has(sid)) onSessionStarted(cur);
				// Someone new may have joined since the log was drawn; include the live visit's members
				rv.people = peopleOf([...rv.visits.filter((v) => v.id !== cur.id), cur]);
				appendItems(rv, batch);
			}
			if (section === "rooms") refreshSoon();
		}

		/**
		 * @param {LBBRoomView} view
		 * @param {"txt" | "html" | "json"} format
		 */
		function exportRoom(view, format) {
			const { name, visits, items } = view;
			const r = visits[visits.length - 1]?.room || {};
			const members = {};
			for (const s of visits) Object.assign(members, s.members || {});
			const header = [
				`Room: ${name}`,
				r.Description ? `Description: ${r.Description}` : null,
				`Space: ${r.Space || "female"} · Language: ${r.Language || "?"} · Background: ${r.Background || "?"} · Limit: ${r.Limit ?? "?"}`,
				`Private: ${r.Private ? "yes" : "no"} · Locked: ${r.Locked ? "yes" : "no"}${r.AdminCount != null ? ` · Admins: ${r.AdminCount}` : ""}`,
				`Visits: ${visits.length} (${fmtDate(visits[0]?.start)} – ${fmtDate(visits[visits.length - 1]?.end)})`,
				`Members seen: ${Object.entries(members).map(([n, who]) => `${who} (#${n})`).join(", ")}`,
			].filter(Boolean);
			const asText = (/** @type {LBBLogItem} */ l) => (l.type === "Session" ? `── ${l.text} · ${fmtDate(l.ts)} ──` : `[${fmtTime(l.ts)}] ${l.text}`);
			const base = `room-${safeName(name)}-${new Date().toISOString().slice(0, 10)}`;
			if (format === "json") return download(`${base}.json`, JSON.stringify({ format: "BlackBook-room", version: 2, room: name, visits, lines: items }, null, 2), "application/json");
			if (format === "txt") return download(`${base}.txt`, `${header.join("\n")}\n${"-".repeat(40)}\n${items.map(asText).join("\n")}\n`, "text/plain");
			const rows = items
				.map((l) =>
					l.type === "Session"
						? `<div class="l sep">${escapeHtml(asText(l))}</div>`
						: `<div class="l t-${escapeHtml(l.type)}"><span class="ts">${fmtTime(l.ts)}</span> ${richText(l.text, "", view.people).innerHTML}</div>`
				)
				.join("\n");
			const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;background:#1b1622;color:#eee;max-width:900px;margin:2em auto;padding:0 1em}
header{border-bottom:1px solid #444;margin-bottom:1em;padding-bottom:.5em;white-space:pre-wrap;color:#ccc}
.l{padding:1px 0;white-space:pre-wrap}.ts{color:#888;font-size:12px}.t-Emote,.t-Action,.t-Activity{color:#c9a8ff;font-style:italic}
.t-Whisper{color:#8fd3ff}.t-LocalMessage,.t-ServerMessage,.t-Other{color:#999}
.sep{color:#ffb86b;text-align:center;font-size:12px;margin:10px 0 4px;border-top:1px dashed #5a4570;padding-top:4px}
.t-RoomChange{color:#7fd1b9;border-left:2px solid #7fd1b9;padding-left:6px;margin:3px 0}
.fm-name{font-weight:700;font-style:normal}
</style></head><body><header>${header.map(escapeHtml).join("\n")}</header>${rows}</body></html>`;
			download(`${base}.html`, html, "text/html");
		}

		// Collect the line keys first, then delete everything in one transaction
		/** @param {number[]} ids */
		async function deleteVisits(ids) {
			await ensureDb();
			const keys = (await Promise.all(ids.map((/** @type {number} */ id) => reqDone(storeOf("roomMsgs").index("session").getAllKeys(id))))).flat();
			const t = openDb().transaction(["roomMsgs", "sessions"], "readwrite");
			for (const k of keys) t.objectStore("roomMsgs").delete(k);
			for (const id of ids) t.objectStore("sessions").delete(id);
			await txDone(t);
		}

		/** @param {LBBRoomView} view */
		async function deleteRoom(view) {
			await deleteVisits(view.visits.map((s) => s.id));
			roomName = null;
			roomView = null;
			await reload(true);
		}

		/** @param {number} id */
		async function deleteVisit(id) {
			await deleteVisits([id]);
			// Redraw the room's log without that visit; if it was the only one, the room disappears from the list
			roomView = null;
			await reload(true);
			if (!sessions.some((s) => roomKey(s) === roomName)) {
				roomName = null;
				renderDetail();
			}
		}

		/** @param {string} q */
		function showMessageSearch(q) {
			messageSearch = q;
			roomView = null;
			renderList();
			renderDetail();
		}

		// Newest first across every room log and conversation of this account
		/**
		 * @param {"roomMsgs" | "dms"} storeName
		 * @param {string} q
		 * @param {number} limit
		 * @returns {Promise<any[]>}
		 */
		async function collectMatches(storeName, q, limit) {
			await ensureDb();
			/** @type {any[]} */
			const out = [];
			const range = IDBKeyRange.bound([me(), 0], [me(), Infinity]);
			await new Promise((/** @type {(v?: unknown) => void} */ resolve, reject) => {
				/** @type {IDBRequest<IDBCursorWithValue | null>} */
				const req = storeOf(storeName).index("ownerTs").openCursor(range, "prev");
				req.onsuccess = () => {
					const cur = req.result;
					if (!cur || out.length >= limit) return resolve();
					if ((cur.value.text || "").toLowerCase().includes(q)) out.push(cur.value);
					cur.continue();
				};
				req.onerror = () => reject(req.error instanceof Error ? req.error : new Error("IndexedDB request failed"));
			});
			return out;
		}

		/**
		 * @param {HTMLElement} el
		 * @param {string} query
		 */
		async function renderMessageSearch(el, query) {
			const q = query.toLowerCase();
			el.replaceChildren(h("p", { class: "fm-muted" }, `Searching for “${query}”…`));
			const [lines, dms] = await Promise.all([collectMatches("roomMsgs", q, 300), collectMatches("dms", q, 200)]);
			if (messageSearch !== query) return;
			const byId = new Map(sessions.map((s) => [s.id, s]));
			/** @type {Map<number, LBBPeople | undefined>} */
			const peopleBySession = new Map();
			const peopleFor = (/** @type {number} */ id) => {
				const sess = byId.get(id);
				if (!peopleBySession.has(id)) peopleBySession.set(id, sess ? peopleOf([sess]) : undefined);
				return peopleBySession.get(id);
			};
			// Wrapped in h() so the result arrays are flattened; replaceChildren would print them as text
			el.replaceChildren(
				h(
					"div",
					{},
					h("h3", { style: "margin-top:0" }, `Room messages (${lines.length}${lines.length >= 300 ? "+" : ""})`),
					lines.length
						? lines.map((l) =>
							h(
								"div",
								{ class: "fm-hit", onclick: () => openRoom((() => { const x = byId.get(l.session); return x ? roomKey(x) : "(room)"; })()) },
								h("div", { class: "fm-muted", style: "font-size:12px" }, `${(() => { const x = byId.get(l.session); return x ? roomKey(x) : "(room)"; })()} · ${fmtDate(l.ts)}`),
								lineEl(l, q, peopleFor(l.session))
							)
						)
						: h("p", { class: "fm-muted" }, "None."),
					h("h3", {}, `Beeps & whispers (${dms.length}${dms.length >= 200 ? "+" : ""})`),
					dms.length
						? dms.map((m) =>
							h(
								"div",
								{ class: "fm-hit", onclick: () => open(m.member, "chats") },
								h("div", { class: "fm-muted", style: "font-size:12px" }, `${m.dir === "out" ? "You → " : ""}${displayName(m.member)} · ${m.kind} · ${fmtDate(m.ts)}`),
								lineEl({ ...m, type: m.kind === "whisper" ? "Whisper" : "Chat" }, q, undefined)
							)
						)
						: h("p", { class: "fm-muted" }, "None.")
				)
			);
		}

		// ----- lobby -----

		async function runLobbySearch() {
			lobbyError = "";
			lobbyRooms = null;
			renderList();
			const res = await searchRooms("", lobbySpace);
			if (res.error) lobbyError = /in progress/i.test(res.error) ? "A search is already running, try again in a moment." : res.error;
			else lobbyRooms = (res.rooms || []).sort((a, b) => (b.Friends?.length || 0) - (a.Friends?.length || 0) || b.MemberCount - a.MemberCount);
			renderList();
			renderDetail();
		}

		// ---------- profiles (detail) ----------

		const TABS = ["Overview", "Description", "Appearance", "Crafts", "Room", "Shared settings", "Mod messages", "Raw"];
		/** @type {Map<number, { name: string, room?: any, at?: number, error?: string }>} */
		const roomLookups = new Map();

		// Your own character read live from the game (the cached copy is only as fresh as the last room sync),
		// shaped like a cached profile so every profile tab works on it
		function liveSelfRecord() {
			const cached = records.get(me());
			const bundle = typeof ServerAppearanceBundle === "function" ? ServerAppearanceBundle(Player.Appearance) : [];
			const data = JSON.parse(
				JSON.stringify({
					Name: Player.Name,
					Nickname: Player.Nickname,
					Title: Player.Title,
					Creation: Player.Creation,
					Ownership: Player.Ownership,
					Lovership: Player.Lovership,
					Description: Player.Description,
					Difficulty: Player.Difficulty,
					ItemPermission: /** @type {any} */ (Player).ItemPermission,
					LabelColor: Player.LabelColor,
					Reputation: Player.Reputation,
					OnlineSharedSettings: Player.OnlineSharedSettings,
					Crafting: Array.isArray(Player.Crafting) ? Player.Crafting.filter(Boolean) : [],
					AssetFamily: Player.AssetFamily,
					Appearance: bundle,
				})
			);
			return { ...(cached || {}), key: keyFor(me()), member: me(), name: Player.Name, nickname: Player.Nickname || "", data, live: true, lastSeen: Date.now() };
		}

		/** @param {number} member */
		async function toggleFavProfile(member) {
			await updateRecord(member, (r) => (r.fav = !r.fav));
			markSyncDirty();
			await reload(true);
		}

		/** @param {number} member */
		async function toggleBell(member) {
			let on = false;
			await updateRecord(member, (r) => (on = r.notifyOnline = !r.notifyOnline));
			if (on) bells.add(member);
			else bells.delete(member);
			markSyncDirty();
			if (on && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
			if (on) requestOnlineFriends(); // starting point for this friend
			await reload(true);
		}
		/** @param {number} member */
		function profileBell(member) {
			const on = !!records.get(member)?.notifyOnline;
			const friend = friendIds().has(member);
			return h(
				"span",
				{
					class: `fm-bell${on ? " on" : ""}`,
					title: on
						? "Notifying you when they come online (click to stop)"
						: `Notify me when they come online${friend ? "" : " (works for mutual friends: the game only reports them as online)"}`,
					onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), toggleBell(member)),
				},
				on ? "🔔" : "🔕"
			);
		}

		/** @param {number} member */
		function profileStar(member) {
			const on = !!records.get(member)?.fav;
			return h(
				"span",
				{ class: `fm-star${on ? " on" : ""}`, title: on ? "Remove from favorite profiles" : "Add to favorite profiles", onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), toggleFavProfile(member)) },
				on ? "★" : "☆"
			);
		}

		/** @param {HTMLElement} el */
		function renderProfile(el) {
			if (selected == null) {
				el.replaceChildren(h("p", { class: "fm-muted" }, "Pick someone on the left, or use /book <member number>."));
				return;
			}
			const who = selected;
			const rec = who === me() ? liveSelfRecord() : records.get(who);
			const d = rec?.data;
			const online = onlineFriends.get(selected);
			const name = rec?.nickname || rec?.name || friendNameOf(selected) || "(unknown)";

			const note = h("textarea", { rows: 3, style: "width:100%", placeholder: "Private notes about this person", "data-key": `note-${selected}` });
			note.value = rec?.note || "";
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let noteTimer;
			note.addEventListener("input", () => {
				clearTimeout(noteTimer);
				noteTimer = setTimeout(() => updateRecord(who, (r) => (r.note = note.value)).then(markSyncDirty), 400);
			});

			el.replaceChildren(
				h(
					"div",
					{ style: "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap" },
					selected !== me() ? profileStar(selected) : null,
					selected !== me() ? profileBell(selected) : null,
					h("h2", { style: "margin:0" }, name),
					h("span", { class: "fm-muted" }, `#${selected}`),
					h("span", {}, h("span", { class: `fm-dot${online || inRoomWith(selected) ? " on" : ""}` }), presenceText(selected, online)),
					selected !== me() ? groupTags(selected) : null,
					h("span", { style: "flex:1" }),
					who !== me() ? h("button", { onclick: () => open(who, "chats") }, "Messages") : null,
					rec && !rec.live ? h("button", { onclick: () => deleteRecord(who) }, "Delete cache") : null
				),
				h(
					"div",
					{ class: "fm-muted" },
					rec?.live
						? "Live: your character as it is right now."
						: d
							? `Snapshot from ${fmtDate(rec.lastSeen)}${rec.lastRoom ? ` in “${rec.lastRoom}”` : ""}`
							: "No profile snapshot yet. Be in a room with them to capture one."
				),
				note,
				h("div", { id: "fm-tabs" }, TABS.map((t) => h("button", { class: t === detailTab ? "act" : "", onclick: () => ((detailTab = t), renderDetail()) }, t))),
				renderProfileTab(detailTab, /** @type {LBBProfile} */ (rec)) || ""
			);
		}

		/** @param {([string, any] | null | false)[]} rows */
		function kv(rows) {
			return h("table", {}, rows.filter((r) => !!r && r[1] != null && r[1] !== "").map((r) => /** @type {[string, any]} */ (r)).map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v))));
		}

		/**
		 * @param {string} tab
		 * @param {LBBProfile} rec
		 */
		function renderProfileTab(tab, rec) {
			const d = rec?.data;
			if (tab === "Mod messages") return renderModMessages(rec);
			if (tab === "Room") return renderProfileRoom(rec);
			if (!d) return h("p", { class: "fm-muted" }, "No snapshot.");
			switch (tab) {
				case "Overview": {
					const own = d.Ownership;
					const lovers = Array.isArray(d.Lovership) ? d.Lovership : [];
					const rep = Array.isArray(d.Reputation) ? d.Reputation.filter((/** @type {any} */ r) => r.Value) : [];
					return h(
						"div",
						{},
						kv([
							["Name", d.Name],
							["Nickname", d.Nickname],
							["Title", d.Title],
							["Member since", d.Creation ? fmtDate(d.Creation) : null],
							["Owner", own && own.MemberNumber ? `${own.Name} (#${own.MemberNumber})${own.Stage === 0 ? " — trial" : ""}` : d.Owner],
							["Lovers", lovers.length ? lovers.map((/** @type {any} */ l) => `${l.Name}${l.MemberNumber ? ` (#${l.MemberNumber})` : ""}`).join(", ") : null],
							["Difficulty", d.Difficulty && d.Difficulty.Level != null ? String(d.Difficulty.Level) : null],
							["Game version", d.OnlineSharedSettings?.GameVersion],
							["Add-ons", addonChips(rec)],
							["Item permission", d.ItemPermission != null ? String(d.ItemPermission) : null],
							["First cached", fmtDate(rec.firstSeen)],
							["Last online", selected != null && lastOnlineAt(selected) ? fmtDate(lastOnlineAt(selected)) : null],
							["Online since", rec.onlineSince && selected != null && onlineOf(selected) ? fmtDate(rec.onlineSince) : null],
							["Went offline", rec.lastOffline && rec.lastOffline > (rec.lastOnline || 0) ? `${fmtDate(rec.lastOffline)} (noticed)` : null],
						]),
						rep.length ? h("h3", {}, "Reputation") : null,
						rep.length ? kv(rep.map((/** @type {any} */ r) => [r.Type, String(r.Value)])) : null
					);
				}
				case "Description": {
					const text = decodeDescription(d.Description);
					return text ? h("pre", {}, text) : h("p", { class: "fm-muted" }, "Empty description.");
				}
				case "Appearance": {
					const fam = d.AssetFamily;
					const worn = (d.Appearance || []).filter((/** @type {any} */ a) => a && a.Group && !isBodyGroup(fam, a.Group));
					const applied = worn.filter((/** @type {any} */ a) => isItemGroup(fam, a.Group));
					const outfit = worn.filter((/** @type {any} */ a) => !isItemGroup(fam, a.Group));
					// Their outfit can be copied/saved/worn only with their consent (see outfitAccess); yours always
					const access = outfitAccess(rec.member, d);
					const canWearHere = rec.member !== me() && access.ok;
					const pv = previewWithOnMe(d.Appearance, fam, canWearHere);
					const craftCell = (/** @type {any} */ a) => {
						const craft = a.Craft || a.Property?.Craft;
						if (!craft) return "";
						return h(
							"div",
							{},
							h("div", {}, `“${craft.Name}” by ${craft.MemberName || "?"}${craft.MemberNumber ? ` (#${craft.MemberNumber})` : ""}`),
							effectChips(craft.Effects)
						);
					};
					const lockCell = (/** @type {any} */ a) => {
						const p = a.Property || {};
						if (!p.LockedBy) return "";
						return `${lockLabel(fam, p.LockedBy)}${p.LockMemberNumber ? ` by #${p.LockMemberNumber}` : ""}${p.RemoveTimer ? ` · until ${fmtDate(p.RemoveTimer)}` : ""}`;
					};
					return h(
						"div",
						{ class: "fm-with-preview" },
						h(
							"div",
							{ style: "flex:1;min-width:0" },
							h("h3", {}, `Applied items (${applied.length})`),
							applied.length && access.ok ? restraintTools(snapshotOutfit(d), canWearHere) : null,
							applied.length
								? h(
									"table",
									{},
									h("tr", {}, h("th", {}, "Slot"), h("th", {}, "Item"), h("th", {}, "Colours"), h("th", {}, "Settings"), h("th", {}, "Lock"), h("th", {}, "Crafted"), canWearHere ? h("th", {}, "") : null),
									applied.map((/** @type {any} */ a) =>
										h(
											"tr",
											{},
											h("td", {}, groupLabel(fam, a.Group)),
											h("td", {}, assetLabel(fam, a.Group, a.Name)),
											h("td", {}, colorSwatches(a.Color) || h("span", { class: "fm-muted" }, "default")),
											h("td", {}, itemSettings(a)),
											h("td", {}, lockCell(a)),
											h("td", {}, craftCell(a)),
												canWearHere ? h("td", {}, (() => { const r = restraintPiece(a); return r ? wearButton(r) : ""; })()) : null
										)
									)
								)
								: h("p", { class: "fm-muted" }, "None."),
							h("h3", {}, `Outfit (${outfit.length})`),
							outfit.length ? (access.ok ? outfitTools(snapshotOutfit(d), rec.member !== me(), saveOutfitButton(d, rec), pv.btn) : outfitLocked(access.why)) : null,
							outfit.length
								? h(
									"table",
									{},
									h("tr", {}, h("th", {}, "Slot"), h("th", {}, "Item"), h("th", {}, "Colours"), h("th", {}, "Settings"), h("th", {}, "Crafted"), canWearHere ? h("th", {}, "") : null),
									outfit.map((/** @type {any} */ a) =>
										h(
											"tr",
											{},
											h("td", {}, groupLabel(fam, a.Group)),
											h("td", {}, assetLabel(fam, a.Group, a.Name)),
											h("td", {}, colorSwatches(a.Color) || h("span", { class: "fm-muted" }, "default")),
											h("td", {}, itemSettings(a)),
											h("td", {}, craftCell(a)),
												canWearHere ? h("td", {}, wearButton(a)) : null
										)
									)
								)
								: h("p", { class: "fm-muted" }, "None.")
						),
						pv.cv
					);
				}
				case "Crafts": {
					const crafts = decodeCrafting(d.Crafting);
					if (!crafts.length) return h("p", { class: "fm-muted" }, "No public crafts in this snapshot.");
					return h("div", {}, crafts.map((c) => craftCard(c, d.AssetFamily)));
				}
				case "Shared settings": {
					const s = d.OnlineSharedSettings || {};
					const keys = Object.keys(s).sort();
					if (!keys.length) return h("p", { class: "fm-muted" }, "None.");
					return h(
						"div",
						{},
						keys.map((k) => h("details", {}, h("summary", {}, k), h("pre", {}, typeof s[k] === "string" ? s[k] : JSON.stringify(s[k], null, 2))))
					);
				}
				case "Raw":
					return h("pre", {}, JSON.stringify(rec, null, 2));
			}
			return h("div");
		}

		// ----- outfit codes and wearing pieces -----

		// An outfit as { pieces, full }: pieces are the removable clothing/accessories (Name, Group, Color, Property without
		// locks) that Wear puts on; full is every customizable appearance slot (hair, eyes, skin too), like the game's Copy
		/**
		 * @param {any} d a character as saved (AssetFamily, Appearance)
		 * @returns {LBBSnapshot}
		 */
		function snapshotOutfit(d) {
			const fam = d.AssetFamily || "Female3DCG";
			/** @type {LBBPiece[]} */
			const pieces = [];
			/** @type {LBBLook[]} */
			const full = [];
			/** @type {LBBPiece[]} */
			const restraints = [];
			for (const a of d.Appearance || []) {
				const g = a && AssetGroupGet(fam, a.Group);
				if (g && g.Category === "Item") {
					const r = restraintPiece(a);
					if (r) restraints.push(r);
					continue;
				}
				if (!g || g.Category !== "Appearance") continue;
				if (g.AllowCustomize) full.push({ A: a.Name, G: a.Group, C: a.Color });
				if (!g.AllowNone) continue;
				/** @type {LBBPiece} */
				const piece = { Name: a.Name, Group: a.Group, Color: a.Color };
				if (a.Property && typeof a.Property === "object") {
					const props = /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(a.Property)));
					for (const k of LOCK_PROPS) delete props[k];
					delete props.Craft;
					if (Object.keys(props).length) piece.Property = props;
				}
				pieces.push(piece);
			}
			return { pieces, full, restraints, family: fam };
		}

		// A restraint as a plain item. A crafted one becomes the generic item it was made from: its colours and
		// chosen options stay, the crafter's name, description, property and effects don't. Locks never come along.
		// craftName is only for showing where it came from and is left out of codes.
		/**
		 * @param {any} a an item as saved
		 * @returns {LBBPiece | null}
		 */
		function restraintPiece(a) {
			if (!a || !a.Name || !a.Group) return null;
			/** @type {LBBPiece} */
			const piece = { Name: a.Name, Group: a.Group, Color: a.Color };
			if (a.Property && typeof a.Property === "object") {
				const props = /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(a.Property)));
				for (const k of RESTRAINT_DROP) delete props[k];
				if (Object.keys(props).length) piece.Property = props;
			}
			const craft = a.Craft || a.Property?.Craft;
			if (craft && craft.Name) piece.craftName = String(craft.Name);
			return piece;
		}

		// Restraint codes are the game's item bundle (Name, Group, Color, Property), the format BCX-style outfit
		// codes with restraints use
		const bundleCode = (/** @type {LBBPiece[]} */ rows) =>
			LZString.compressToBase64(JSON.stringify(rows.map((r) => ({ Name: r.Name, Group: r.Group, Color: r.Color, ...(r.Property ? { Property: r.Property } : {}) }))));

		// Outfit codes use the game's own wardrobe Copy/Paste format: LZString base64 of [{ A: asset, G: group, C: colour }]
		const outfitCode = (/** @type {(LBBPiece | LBBLook)[]} */ rows) => LZString.compressToBase64(JSON.stringify(rows.map((r) => ("A" in r ? r : { A: r.Name, G: r.Group, C: r.Color }))));

		/**
		 * @param {string} label
		 * @param {() => string} getText
		 * @param {string} title
		 */
		function copyButton(label, getText, title) {
			const btn = h(
				"button",
				{
					title,
					onclick: async () => {
						try {
							await navigator.clipboard.writeText(getText());
							btn.textContent = "Copied ✓";
						} catch {
							btn.textContent = "Couldn't copy";
						}
						setTimeout(() => (btn.textContent = label), 2500);
					},
				},
				label
			);
			return btn;
		}

		// Never carry someone else's lock over with a piece of clothing
		const LOCK_PROPS = [
			"LockedBy",
			"LockMemberNumber",
			"LockPickSeed",
			"CombinationNumber",
			"Password",
			"Hint",
			"LockSet",
			"RemoveItem",
			"RemoveTimer",
			"RemoveOnUnlock",
			"ShowTimer",
			"EnableRandomInput",
			"MemberNumberList",
			"MemberNumberListKeys",
		];

		// What a copied restraint leaves behind: locks, the craft, and what the game works out again from its options
		const RESTRAINT_DROP = new Set([...LOCK_PROPS, "Craft", "Difficulty", "Effect", "Block", "Hide", "HideItem", "HideItemExclude", "AllowActivity", "AllowActivityOn", "Attribute", "SetPose", "AllowActivePose"]);

		// Same rules the wardrobe applies, plus owning the item: null when it can be worn, otherwise why not
		/**
		 * @param {LBBPiece} a
		 * @returns {string | null}
		 */
		function wearProblem(a) {
			if (isItemGroup(Player.AssetFamily, a.Group)) return restraintProblem(a);
			if (!Player.CanChangeOwnClothes?.()) return "You can't change clothes right now.";
			const asset = AssetGet(Player.AssetFamily, a.Group, a.Name);
			if (!asset) return "That item doesn't exist for your character.";
			if (typeof AppearanceGroupAllowed === "function" && !AppearanceGroupAllowed(Player, a.Group)) return "You're not allowed to change that slot.";
			if (!InventoryAvailable(Player, a.Name, a.Group)) return "You don't own this item.";
			if (typeof InventoryAllow === "function" && !InventoryAllow(Player, asset, undefined, false)) return "Something you're wearing prevents it.";
			return null;
		}

		// The checks the game's own item menu makes before you use a restraint on yourself
		/**
		 * @param {LBBPiece} a
		 * @returns {string | null}
		 */
		function restraintProblem(a) {
			const asset = AssetGet(Player.AssetFamily, a.Group, a.Name);
			if (!asset) return "That item doesn't exist for your character.";
			if (!Player.CanInteract?.()) return "You can't use your hands right now.";
			if (inRoom() && typeof InventoryChatRoomAllow === "function" && !InventoryChatRoomAllow(asset.Category)) return "This room doesn't allow that kind of item.";
			if (typeof InventoryGroupIsBlocked === "function" && InventoryGroupIsBlocked(Player, /** @type {AssetGroupItemName} */ (a.Group))) return "That spot is blocked by something you're wearing.";
			const cur = InventoryGet(Player, a.Group);
			if (cur && InventoryItemHasEffect(cur, "Lock", true)) return "Something locked is already there.";
			if (!InventoryAvailable(Player, a.Name, a.Group)) return "You don't own this item.";
			if (typeof InventoryBlockedOrLimited === "function" && InventoryBlockedOrLimited(Player, /** @type {Item} */ ({ Asset: asset }))) return "Your own item permissions block it.";
			const sb = asset.SelfBondage || 0;
			const always = typeof DialogAlwaysAllowRestraint === "function" && DialogAlwaysAllowRestraint();
			if (sb > 0 && !always && SkillGetLevel(Player, "SelfBondage") < sb) return sb <= 10 ? `Needs self-bondage level ${sb}.` : "Can't be used on yourself.";
			if (typeof InventoryAllow === "function" && !InventoryAllow(Player, asset, undefined, false)) return "Something you're wearing prevents it.";
			return null;
		}

		// A restraint goes on as the plain item, then gets its options back through the game's own option code, which
		// works out the effects and blocks those options bring
		/** @param {LBBPiece} a */
		function wearRestraint(a) {
			const item = InventoryWear(Player, a.Name, a.Group, a.Color, null, Player.MemberNumber, null, false);
			if (!item) return false;
			/** @type {Record<string, any>} */
			const props = a.Property && typeof a.Property === "object" ? /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(a.Property))) : {};
			for (const k of RESTRAINT_DROP) delete props[k];
			const rec = props.TypeRecord && typeof props.TypeRecord === "object" ? props.TypeRecord : null;
			delete props.TypeRecord;
			if (typeof ExtendedItemSetOptionByRecord === "function" && (rec || Object.keys(props).length)) {
				try {
					ExtendedItemSetOptionByRecord(Player, item, rec, { push: false, refresh: false, C_Source: Player, properties: props });
				} catch (e) {
					console.warn(TAG, "couldn't set item options", a.Group, a.Name, e);
				}
			}
			// Engraved / printed text isn't an option, so it comes over as is
			for (const k of ["Text", "Text2", "Text3"]) if (typeof props[k] === "string") item.Property = { ...(item.Property || {}), [k]: props[k] };
			return true;
		}

		// Puts the pieces on you (colours and options, never locks), leaving every other slot as it is.
		// Restraints that need another one first (an add-on on a device) get a second try once the rest are on.
		/** @param {LBBPiece[]} pieces */
		function wearPieces(pieces) {
			const applied = [];
			const skipped = [];
			let todo = pieces;
			for (let pass = 0; pass < 2 && todo.length; pass++) {
				const retry = [];
				for (const a of todo) {
					const problem = wearProblem(a);
					if (problem) {
						if (pass === 0 && isItemGroup(Player.AssetFamily, a.Group)) retry.push(a);
						else skipped.push(`${assetLabel(Player.AssetFamily, a.Group, a.Name)}: ${problem}`);
						continue;
					}
					if (isItemGroup(Player.AssetFamily, a.Group)) {
						if (wearRestraint(a)) applied.push(a);
						else skipped.push(`${assetLabel(Player.AssetFamily, a.Group, a.Name)}: the game refused it.`);
						continue;
					}
					wearClothing(a);
					applied.push(a);
				}
				if (retry.length && !applied.length) {
					for (const a of retry) skipped.push(`${assetLabel(Player.AssetFamily, a.Group, a.Name)}: ${wearProblem(a)}`);
					break;
				}
				todo = retry;
			}
			if (applied.length) {
				CharacterRefresh(Player, false);
				if (inRoom()) ChatRoomCharacterUpdate(Player);
				else ServerPlayerAppearanceSync();
			}
			return { applied, skipped };
		}

		/** @param {LBBPiece} a */
		function wearClothing(a) {
			InventoryWear(Player, a.Name, a.Group, a.Color, undefined, undefined, undefined, false);
			const item = InventoryGet(Player, a.Group);
			if (item && a.Property && typeof a.Property === "object") {
				const props = /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(a.Property)));
				for (const k of LOCK_PROPS) delete props[k];
				delete props.Craft;
				item.Property = { ...(item.Property || {}), ...props };
			}
		}

		/** @param {LBBPiece} a */
		function wearButton(a) {
			const problem = wearProblem(a);
			const label = isItemGroup(Player.AssetFamily, a.Group) ? "Put on" : "Wear";
			const btn = h(
				"button",
				{
					class: problem ? "off" : "",
					title: problem || "Put this piece on, keeping the rest of your outfit",
					onclick: () => {
						const res = wearPieces([a]);
						btn.textContent = res.applied.length ? "Done ✓" : "Can't";
						btn.title = res.skipped.join("\n") || btn.title;
						setTimeout(() => (btn.textContent = label), 2500);
					},
				},
				label
			);
			return btn;
		}

		// Copying someone's look needs their consent, the way the game asks for it: you're in the same room, they let you
		// interact with them, and their wardrobe is open to others. Your own outfits are always yours. Settings can
		// switch the check off (outfitCopyAnyone) for people who are fine with it.
		// cached: their last saved profile data, used for the wardrobe setting when they aren't in the room
		/**
		 * @param {number | null | undefined} member
		 * @param {any} [cached] their last saved profile data
		 * @returns {{ ok: boolean, override?: boolean, why?: string }}
		 */
		function outfitAccess(member, cached) {
			if (member == null || member === me()) return { ok: true };
			if (prefs.outfitCopyAnyone) return { ok: true, override: true };
			const c = typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((x) => x.MemberNumber === member) : null;
			if (prefs.outfitNeedRoom && !c) return { ok: false, why: "Only while you're in the same room as them" };
			if (prefs.outfitNeedInteract) {
				// Only the game can answer this, and only for someone in the room with you; when they aren't here
				// (a cached profile) it's skipped and the wardrobe setting from their last snapshot decides
				let interact = true;
				try {
					if (typeof ServerChatRoomGetAllowItem === "function") interact = !c || !!ServerChatRoomGetAllowItem(Player, c);
				} catch {
					// not available in this game or browser: the fallback is used
				}
				if (!interact) return { ok: false, why: "They don't allow you to interact with them" };
			}
			if (prefs.outfitNeedWardrobe) {
				const shared = c ? c.OnlineSharedSettings : cached?.OnlineSharedSettings;
				if (!shared?.AllowFullWardrobeAccess) return { ok: false, why: c || shared ? "They don't let others into their wardrobe" : "Their wardrobe setting isn't known" };
			}
			return { ok: true };
		}

		/** @param {string | undefined} why */
		function outfitLocked(why) {
			return h(
				"p",
				{ class: "fm-muted fm-locked", title: "Settings → Other people's outfits" },
				`🔒 View only. ${why}. Copying, saving or wearing someone else's outfit needs their OK (or the override in Settings).`
			);
		}

		// Copy/wear buttons for an outfit snapshot; canWear is false when it's what you're already wearing
		/**
		 * @param {LBBSnapshot} snap
		 * @param {boolean} canWear
		 * @param {...any} extra
		 */
		function outfitTools(snap, canWear, ...extra) {
			const result = h("span", { class: "fm-muted", style: "font-size:12px" });
			const wearAll = canWear
				? confirmButton(
					"Wear whole outfit",
					() => {
						const res = wearPieces(snap.pieces);
						result.textContent = `Wore ${res.applied.length} of ${snap.pieces.length}${res.skipped.length ? ` · ${res.skipped.length} skipped (hover)` : ""}`;
						result.title = res.skipped.join("\n");
					},
					{ title: "Puts on every piece you're allowed to; your other slots stay as they are" },
					{ armed: "Click again to wear", busy: "Wearing…" }
				)
				: null;
			return h(
				"div",
				{ class: "fm-outfit-tools" },
				copyButton("Copy outfit code", () => outfitCode(snap.pieces), "Clothes and accessories, for the wardrobe's Paste (which replaces your current outfit)"),
				copyButton("Copy full look code", () => outfitCode(snap.full), "Also hair, eyes and skin, same as the game's own Copy"),
				snap.restraints?.length
					? copyButton("Copy outfit + restraints code", () => bundleCode([...snap.pieces, ...snap.restraints]), "Clothes, accessories and restraints in one code (no locks; crafted ones as the plain item)")
					: null,
				wearAll,
				...extra,
				result
			);
		}

		// Copy/put-on buttons for the restraints in a snapshot. Putting them on is on you: nothing goes to the chat
		// and no lock is added, so you can take them off again unless the items themselves stop you.
		/**
		 * @param {LBBSnapshot} snap
		 * @param {boolean} canWear
		 */
		function restraintTools(snap, canWear) {
			const list = snap.restraints || [];
			if (!list.length) return null;
			const result = h("span", { class: "fm-muted", style: "font-size:12px" });
			const crafted = list.filter((r) => r.craftName).length;
			const wearAll = canWear
				? confirmButton(
					"Put restraints on me",
					() => {
						const res = wearPieces(list);
						result.textContent = `Put on ${res.applied.length} of ${list.length}${res.skipped.length ? ` · ${res.skipped.length} skipped (hover)` : ""}`;
						result.title = res.skipped.join("\n");
					},
					{ title: "Puts every restraint you're allowed to use on yourself onto you, without locks. Crafted ones go on as the plain item." },
					{ armed: "Click again to put on", busy: "Putting on…" }
				)
				: null;
			return h(
				"div",
				{ class: "fm-outfit-tools" },
				copyButton("Copy restraints code", () => bundleCode(list), "The restraints with their colours and options, no locks; crafted ones as the plain item"),
				wearAll,
				crafted ? h("span", { class: "fm-muted", style: "font-size:12px" }, `${crafted} crafted: copied as the plain item, same colours`) : null,
				result
			);
		}

		/**
		 * @param {LBBPiece[]} list
		 * @param {boolean} canWear
		 */
		function restraintsTable(list, canWear) {
			return h(
				"table",
				{},
				h("tr", {}, h("th", {}, "Slot"), h("th", {}, "Item"), h("th", {}, "Colours"), h("th", {}, "Settings"), h("th", {}, "Crafted as"), canWear ? h("th", {}, "") : null),
				list.map((p) =>
					h(
						"tr",
						{},
						h("td", {}, groupLabel(Player.AssetFamily, p.Group)),
						h("td", {}, assetLabel(Player.AssetFamily, p.Group, p.Name)),
						h("td", {}, colorSwatches(p.Color) || h("span", { class: "fm-muted" }, "default")),
						h("td", {}, itemSettings(p)),
						h("td", {}, p.craftName ? h("span", { class: "fm-muted", title: "Copied as the plain item" }, `“${p.craftName}”`) : ""),
						canWear ? h("td", {}, wearButton(p)) : null
					)
				)
			);
		}

		// ----- previews -----
		// The game draws every character onto its own off-screen canvas. A throwaway "simple" character (never part of a
		// room) is dressed with the appearance and its canvas copied into ours.
		const PREVIEW_ID = "BlackBookPreview";
		let previewChain = Promise.resolve();

		// "Preview on me": the same preview spot, drawn as your own body (skin, hair, eyes and the other parts that can't be
		// taken off) wearing the outfit's clothes and restraints. Only the picture changes; nothing is put on you.
		/** @param {any[]} bundle */
		function onMeBundle(bundle) {
			const fam = Player.AssetFamily || "Female3DCG";
			const mine = typeof ServerAppearanceBundle === "function" ? ServerAppearanceBundle(Player.Appearance) : [];
			return [...mine.filter((a) => isBodyGroup(fam, a.Group)), ...bundle.filter((/** @type {any} */ a) => a && a.Group && !isBodyGroup(fam, a.Group))];
		}
		/**
		 * The preview, and a button that switches it between the outfit as saved and the outfit on you
		 * @param {any[]} bundle
		 * @param {IAssetFamily} family
		 * @param {boolean} offer show the button (only when the outfit may be copied, and it's someone else's look)
		 * @returns {{ cv: HTMLCanvasElement, btn: HTMLElement | null }}
		 */
		function previewWithOnMe(bundle, family, offer) {
			let cv = previewCanvas(bundle, family);
			if (!offer || (family || "Female3DCG") !== (Player.AssetFamily || "Female3DCG")) return { cv, btn: null };
			let onMe = false;
			const btn = h("button", { title: "Show the outfit on your own body in this preview. Nothing is put on you." }, "👤 Preview on me");
			btn.addEventListener("click", () => {
				onMe = !onMe;
				const next = onMe ? previewCanvas(onMeBundle(bundle), family) : previewCanvas(bundle, family);
				cv.replaceWith(next);
				cv = next;
				btn.textContent = onMe ? "👤 Back to the original" : "👤 Preview on me";
			});
			return { cv, btn };
		}

		/**
		 * @param {any[]} bundle
		 * @param {IAssetFamily} family
		 */
		function previewCanvas(bundle, family) {
			const cv = h("canvas", { class: "fm-preview", width: 300, height: 555 });
			previewChain = previewChain.then(() => drawPreview(cv, bundle, family)).catch((err) => console.warn(TAG, "preview failed", err));
			return cv;
		}

		/**
		 * @param {HTMLCanvasElement} cv
		 * @param {any[]} bundle
		 * @param {IAssetFamily} family
		 */
		async function drawPreview(cv, bundle, family) {
			if (typeof CharacterLoadSimple !== "function" || typeof ServerAppearanceLoadFromBundle !== "function") return;
			const C = CharacterLoadSimple(PREVIEW_ID);
			// The preview character is reused, and the game only lets a character's body (skin, hair, eyes…) change when it
			// allows full wardrobe access: without it, every preview kept the body drawn first
			C.OnlineSharedSettings = /** @type {CharacterOnlineSharedSettings} */ ({ ...(C.OnlineSharedSettings ?? {}), AllowFullWardrobeAccess: true });
			ServerAppearanceLoadFromBundle(C, family || "Female3DCG", /** @type {AppearanceBundle} */ (JSON.parse(JSON.stringify(bundle))), undefined);
			CharacterRefresh(C, false, false);
			const ctx = cv.getContext("2d");
			if (!ctx) return;
			// The character canvas has room above/below for tall items; the body sits in a CanvasDrawWidth x 1000 box
			// starting at CanvasUpperOverflow. Crop to that box plus a margin (hats, wings), keeping the preview's aspect.
			const upper = typeof CanvasUpperOverflow === "number" ? CanvasUpperOverflow : 700;
			const sh = 1000 + 80;
			const sw = Math.round((sh * cv.width) / cv.height);
			// Item images load asynchronously, so redraw a few times as they arrive
			for (let i = 0; i < 10; i++) {
				await sleep(i ? 300 : 30);
				if (i > 0 && !cv.isConnected) break;
				CharacterAppearanceBuildCanvas(C);
				if (!C.Canvas) continue;
				const sx = Math.round((C.Canvas.width - sw) / 2);
				const sy = upper - 60;
				ctx.clearRect(0, 0, cv.width, cv.height);
				ctx.drawImage(C.Canvas, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
			}
		}

		function dropPreviewCharacter() {
			const C = typeof Character !== "undefined" ? Character.find((c) => c.CharacterID === PREVIEW_ID) : null;
			if (C) CharacterDelete(C, false);
		}

		// A saved outfit as a full appearance: the full look, with the pieces (and their options) laid over it
		/** @param {LBBOutfit} o a saved outfit */
		function outfitBundle(o) {
			/** @type {Map<string, any>} */
			const byGroup = new Map(o.full.map((r) => [r.G, { Group: r.G, Name: r.A, Color: r.C }]));
			for (const p of [...o.pieces, ...(o.restraints || [])]) {
				const { craftName: _craftName, ...item } = p;
				byGroup.set(p.Group, item);
			}
			return [...byGroup.values()];
		}

		// ----- saved outfits (kept in the account's meta store as "outfit:<id>") -----

		/** @type {LBBOutfit[]} */
		let savedOutfits = [];
		/** @type {number | null} */
		let outfitSel = null;
		let outfitFavOnly = false;

		/**
		 * @param {LBBSnapshot} snap
		 * @param {string} name
		 * @param {{ member: number | null, name: string }} from
		 */
		async function saveOutfit(snap, name, from) {
			await ensureDb();
			const id = Date.now();
			/** @type {LBBOutfit} */
			const rec = { ...snap, key: `outfit:${id}`, id, name, from: from?.member ?? null, fromName: from?.name || "", savedAt: id, fav: false };
			await reqDone(storeOf("meta", "readwrite").put(rec));
			return rec;
		}

		// Two snapshots are the same look when their clothes and restraints match
		const outfitSig = (/** @type {{ pieces?: LBBPiece[], restraints?: LBBPiece[] }} */ o) => JSON.stringify([o.pieces || [], o.restraints || []]);

		// Saving keeps the restraints as well when there are any; "without restraints" keeps just the clothes.
		// The profile view redraws as soon as the save lands, so the button reads Outfits to show it's saved: the same
		// look from the same person shows "Saved ✓" instead of saving a second copy.
		/**
		 * @param {any} d
		 * @param {LBBProfile} rec
		 */
		function saveOutfitButton(d, rec) {
			const snap = snapshotOutfit(d);
			const who = rec.nickname || rec.name || `#${rec.member}`;
			const make = (/** @type {string} */ label, /** @type {string} */ title, /** @type {boolean} */ withRestraints) => {
				const keep = withRestraints ? snap : { ...snap, restraints: [] };
				const sig = outfitSig(keep);
				const have = savedOutfits.find((o) => o.from === rec.member && outfitSig(o) === sig);
				if (have) return h("button", { disabled: true, title: `Already in Outfits as “${have.name}”` }, "Saved ✓");
				const btn = h(
					"button",
					{
						title,
						onclick: async () => {
							btn.disabled = true;
							btn.textContent = "Saving…";
							try {
								await saveOutfit(keep, withRestraints ? `${who}'s outfit + restraints` : `${who}'s outfit`, { member: rec.member, name: who });
								btn.textContent = "Saved ✓";
							} catch (e) {
								console.warn(TAG, "saving the outfit failed", e);
								btn.textContent = "Couldn't save";
								btn.disabled = false;
							}
							reload().catch((err) => console.warn(TAG, err));
						},
					},
					label
				);
				return btn;
			};
			if (!snap.restraints.length) return make("Save outfit", "Keep a copy of this outfit in Outfits, even if they change later", false);
			return h(
				"span",
				{ style: "display:contents" },
				make("Save outfit + restraints", "Keep a copy of the outfit and the restraints (no locks; crafted ones as the plain item) in Outfits", true),
				make("Save without restraints", "Keep a copy of just the clothes and accessories", false)
			);
		}

		/** Import an outfit code (wardrobe Copy/Paste format) onto the player's character. */
		async function importOutfitCode() {
			const code = /** @type {string} */ (prompt("Paste an outfit code (wardrobe Copy/Paste format):"));
			if (!code || !code.trim()) return;
			if (typeof LZString?.decompressFromBase64 !== "function") {
				alert("LZString not available — this requires the game to be loaded.");
				return;
			}
			try {
				const decompressed = /** @type {string} */ (LZString.decompressFromBase64(code.trim()));
				const decoded = /** @type {AppearanceBundle} */ (JSON.parse(decompressed));
				if (!Array.isArray(decoded)) throw new Error("Not an outfit array");
				if (typeof ServerAppearanceLoadFromBundle !== "function") {
					alert("Game appearance API not available — open the game first.");
					return;
				}
				// Apply to player character
				ServerAppearanceLoadFromBundle(Player, Player.AssetFamily || "Female3DCG", decoded, undefined);
				// Refresh the character canvas
				if (typeof CharacterRefresh === "function") CharacterRefresh(Player, false, false);
				if (typeof CharacterAppearanceBuildCanvas === "function") CharacterAppearanceBuildCanvas(Player);
				alert("Outfit applied! Check your character in the game.");
			} catch (/** @type {unknown} */ e) {
				alert("Failed to import: " + String(e));
			}
		}

		async function saveMyOutfit() {
			const who = typeof CharacterNickname === "function" ? CharacterNickname(Player) : Player.Name;
			const rec = await saveOutfit(
				snapshotOutfit({ AssetFamily: Player.AssetFamily, Appearance: typeof ServerAppearanceBundle === "function" ? ServerAppearanceBundle(Player.Appearance) : [] }),
				`My outfit · ${new Date().toLocaleDateString()}`,
				{ member: me(), name: who }
			);
			outfitSel = rec.id;
			await reload(true);
		}

		/**
		 * @param {number} id
		 * @param {Record<string, any>} changes
		 */
		async function updateOutfit(id, changes) {
			await ensureDb();
			const rec = await reqDone(storeOf("meta").get(`outfit:${id}`));
			if (!rec) return;
			await reqDone(storeOf("meta", "readwrite").put({ ...rec, ...changes }));
			await reload();
		}

		/** @param {number} id */
		async function deleteOutfit(id) {
			await ensureDb();
			await reqDone(storeOf("meta", "readwrite").delete(`outfit:${id}`));
			outfitSel = null;
			await reload(true);
		}

		/**
		 * @param {LBBPiece[]} pieces
		 * @param {boolean} canWear
		 */
		function piecesTable(pieces, canWear) {
			return h(
				"table",
				{},
				h("tr", {}, h("th", {}, "Slot"), h("th", {}, "Item"), h("th", {}, "Colours"), h("th", {}, "Settings"), canWear ? h("th", {}, "") : null),
				pieces.map((p) =>
					h(
						"tr",
						{},
						h("td", {}, groupLabel(Player.AssetFamily, p.Group)),
						h("td", {}, assetLabel(Player.AssetFamily, p.Group, p.Name)),
						h("td", {}, colorSwatches(p.Color) || h("span", { class: "fm-muted" }, "default")),
						h("td", {}, itemSettings(p)),
						canWear ? h("td", {}, wearButton(p)) : null
					)
				)
			);
		}

		/** @param {HTMLElement} el */
		function renderOutfit(el) {
			const o = savedOutfits.find((x) => x.id === outfitSel);
			if (!o) return el.replaceChildren(h("p", { class: "fm-muted" }, "Pick a saved outfit on the left. Save outfits from a profile's Appearance tab, or save your own."));
			const access = outfitAccess(o.from, o.from != null ? records.get(o.from)?.data : undefined);
			const pv = previewWithOnMe(outfitBundle(o), o.family || Player.AssetFamily, access.ok);
			const nameEl = h("input", { type: "text", value: o.name, style: "font-size:16px;font-weight:600;min-width:240px" });
			nameEl.addEventListener("change", () => {
				const v = nameEl.value.trim();
				if (v) updateOutfit(o.id, { name: v }).catch((err) => console.warn(TAG, err));
			});
			el.replaceChildren(
				h(
					"div",
					{ style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
					outfitStar(o),
					nameEl,
					h("span", { class: "fm-muted" }, `${o.fromName ? `from ${o.fromName}${o.from != null ? ` (#${o.from})` : ""} · ` : ""}saved ${fmtDate(o.savedAt)}`),
					h("span", { style: "flex:1" }),
					o.from != null && o.from !== me() ? h("button", { onclick: () => open(o.from ?? undefined, "profiles") }, "Profile") : null,
					confirmButton("Delete outfit", () => deleteOutfit(o.id))
				),
				h(
					"div",
					{ class: "fm-with-preview" },
					h(
						"div",
						{ style: "flex:1;min-width:0" },
						h("h3", {}, `Pieces (${o.pieces.length})`),
						access.ok ? outfitTools(o, true, pv.btn) : outfitLocked(access.why),
						o.pieces.length ? piecesTable(o.pieces, access.ok) : h("p", { class: "fm-muted" }, "No clothing pieces in this outfit."),
						o.restraints?.length ? h("h3", {}, `Restraints (${o.restraints.length})`) : null,
						o.restraints?.length ? (access.ok ? restraintTools(o, true) : null) : null,
						o.restraints?.length ? restraintsTable(o.restraints, access.ok) : null
					),
					pv.cv
				)
			);
		}

		/** @param {LBBOutfit} o */
		function outfitStar(o) {
			return h(
				"span",
				{
					class: `fm-star${o.fav ? " on" : ""}`,
					title: o.fav ? "Remove from favorite outfits" : "Add to favorite outfits",
					onclick: async (/** @type {MouseEvent} */ e) => {
						e.stopPropagation();
						await updateOutfit(o.id, { fav: !o.fav });
						if (outfitSel === o.id) renderDetail();
					},
				},
				o.fav ? "★" : "☆"
			);
		}

		// ----- item settings: tightness, chosen options, other stored properties -----

		// Shown elsewhere (locks, craft) or derived by the game from the options rather than chosen
		const DERIVED_PROPS = new Set([
			"TypeRecord",
			"Difficulty",
			"Effect",
			"Block",
			"Hide",
			"HideItem",
			"HideItemExclude",
			"AllowActivity",
			"AllowActivityOn",
			"Attribute",
			"SetPose",
			"AllowActivePose",
			"OverridePriority",
			"Tint",
			"Craft",
			...LOCK_PROPS,
		]);

		const textOr = (/** @type {string} */ key, /** @type {string} */ fallback) => {
			try {
				const t = AssetTextGet(key);
				return t && !t.startsWith("MISSING") ? t : fallback;
			} catch {
				return fallback;
			}
		};

		// Readable labels for TypeRecord, using the item's own dialog text ("Wrist Tie", "Hood: Hood Up")
		/** @param {any} a an item as saved */
		function optionLabels(a) {
			const rec = a.Property?.TypeRecord;
			if (!rec || typeof rec !== "object") return [];
			const key = `${a.Group}${a.Name}`;
			const typed = typeof TypedItemDataLookup !== "undefined" ? TypedItemDataLookup[key] : null;
			const modular = typeof ModularItemDataLookup !== "undefined" ? ModularItemDataLookup[key] : null;
			const out = [];
			for (const [k, idx] of Object.entries(rec)) {
				if (typed && k === "typed") {
					const opt = typed.options[idx];
					if (opt) out.push(textOr(`${typed.dialogPrefix?.option || ""}${opt.Name}`, opt.Name));
					continue;
				}
				const modDef = modular?.modules?.find((m) => m.Key === k);
				const o = modDef?.Options?.[idx];
				if (modular && modDef && o) out.push(`${textOr(`${modular.dialogPrefix?.module || ""}${modDef.Name}`, modDef.Name)}: ${textOr(`${modular.dialogPrefix?.option || ""}${o.Name}`, o.Name)}`);
				else if (idx) out.push(`${k}: ${idx}`);
			}
			return out;
		}

		const shortValue = (/** @type {unknown} */ v) => {
			const s = typeof v === "string" ? v : JSON.stringify(v);
			return s.length > 24 ? `${s.slice(0, 22)}…` : s;
		};

		/** @param {any} a */
		function itemSettings(a) {
			const p = a.Property || {};
			const parts = [];
			const applied = typeof a.Difficulty === "number" ? a.Difficulty : 0;
			const fromOptions = typeof p.Difficulty === "number" ? p.Difficulty : 0;
			if (applied || fromOptions) {
				// The game's own sources (skill up to 15, item, options, crafting) stay in the tens; far above that was set by an add-on
				const unusual = applied + fromOptions > 60;
				parts.push(
					h(
						"div",
						{ title: "What struggling has to beat: difficulty set when it was applied (and by tightening) plus what the chosen options add" },
						h("b", {}, "Tightness "),
						h("span", { class: unusual ? "fm-unusual" : "" }, String(applied + fromOptions)),
						fromOptions ? h("span", { class: "fm-muted" }, ` (${applied} applied + ${fromOptions} from options)`) : null,
						unusual ? h("div", { class: "fm-unusual", style: "font-size:11px" }, "Far above what the game sets on its own; likely set by an add-on") : null
					)
				);
			}
			const opts = optionLabels(a);
			if (opts.length) parts.push(h("div", {}, h("b", {}, "Options "), opts.join(", ")));
			const others = Object.entries(p).filter(([k, v]) => !DERIVED_PROPS.has(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length));
			if (others.length) parts.push(h("div", { class: "fm-chips" }, others.map(([k, v]) => h("span", { class: "fm-chip", title: JSON.stringify(v) }, `${k}: ${shortValue(v)}`))));
			return parts.length ? h("div", { class: "fm-item-settings" }, parts) : "";
		}

		// Each chip links to the add-on's page (or a GitHub search); "About these add-ons" lists what each one does
		/** @param {LBBProfile} rec */
		function addonChips(rec) {
			/** @type {{ name: string, label: string, note: string, unknown?: boolean, repo?: string | null }[]} */
			let entries; // [{ name, label, note, unknown, repo }]
			let footnote;
			if (rec?.live && typeof bcModSdk?.getModsInfo === "function") {
				// For yourself, list what's actually loaded rather than what other players could detect
				entries = bcModSdk
					.getModsInfo()
					.sort((a, b) => a.name.localeCompare(b.name))
					// repository: the link a mod gives ModSDK itself (only plain web links are used)
					// Directory add-ons keep their short name (BCX, WCE); the rest show their full name, not an internal id
					.map((m) => ({ m, name: addonInfo(m.name) ? m.name : m.fullName || m.name }))
					.map(({ m, name }) => ({
						name,
						label: m.version ? `${name} ${m.version}` : name,
						note: m.fullName || m.name,
						repo: typeof m.repository === "string" && /^https?:\/\/[^\s"<>]+$/i.test(m.repository) ? m.repository : null,
					}));
				footnote = "Loaded in this game right now.";
			} else {
				const list = detectAddons(rec);
				if (!list.length) return null;
				entries = list.map((a) => ({
					name: a.name,
					label: a.version ? `${a.name} ${a.version}` : a.name,
					note: `Seen in ${a.via.join(" and ")}${a.seen ? ` · ${fmtDate(a.seen)}` : ""}`,
					unknown: a.name.startsWith("Unknown"),
				}));
				footnote = "Only add-ons that announce themselves in rooms can be seen.";
			}
			const link = (/** @type {Record<string, any>} */ attrs, /** @type {any[]} */ ...kids) => h("a", { target: "_blank", rel: "noopener noreferrer", ...attrs }, ...kids);
			const chips = entries.map((e) => {
				const info = addonInfo(e.name);
				const tip = info ? `${info.title}
${info.desc}

${e.note}` : e.repo ? `${e.note}
Source: ${e.repo}` : `${e.note}
Not in the add-on directory: opens a GitHub search.`;
				// The directory's page first, then the link the add-on reports itself, then a search
				return link({ class: `fm-chip fm-chip-link${e.unknown ? " fm-chip-unknown" : ""}`, href: info?.url || e.repo || addonLink(e.name), title: tip }, e.label);
			});
			const about = entries
				.map((e) => ({ e, info: addonInfo(e.name) }))
				.map(({ e, info }) =>
					h(
						"div",
						{ class: "fm-addon" },
						h("b", {}, info ? info.title : e.name),
						" ",
						info?.url ? link({ href: info.url }, info.url === info.repo ? "source" : "website") : null,
						info?.repo && info.repo !== info.url ? [" · ", link({ href: info.repo }, "source")] : null,
						!info && e.repo ? link({ href: e.repo }, "source") : null,
						!info && !e.repo ? link({ href: addonLink(e.name) }, "search GitHub") : null,
						h("div", { class: "fm-muted" }, info ? info.desc : e.repo ? "Source linked by the add-on itself." : "Not in the FUSAM add-on directory.")
					)
				);
			return h(
				"div",
				{},
				h("div", { class: "fm-chips" }, chips),
				h("div", { class: "fm-muted", style: "font-size:11px;margin-top:3px" }, footnote),
				h("details", { class: "fm-addons-about" }, h("summary", {}, "About these add-ons"), about)
			);
		}

		/** @param {number} member */
		function addonSummary(member) {
			const rec = records.get(member);
			const list = rec ? detectAddons(rec).filter((a) => !a.name.startsWith("Unknown")) : [];
			return list.length ? `Add-ons: ${list.map((a) => (a.version ? `${a.name} ${a.version}` : a.name)).join(", ")}` : "No add-ons detected";
		}

		/** @param {Record<string, unknown> | null | undefined} effects */
		function effectChips(effects) {
			const list = activeEffects(effects);
			if (!list.length) return null;
			return h(
				"div",
				{ class: "fm-chips" },
				list.map(([k, v]) => h("span", { class: "fm-chip", title: craftPropDesc(k) }, `${craftPropName(k)}${Number(v) > 1 ? ` ×${Number(v)}` : ""}`))
			);
		}

		/** @param {string | string[] | null | undefined} color */
		function colorSwatches(color) {
			const colors = (Array.isArray(color) ? color : String(color || "").split(",")).map((c) => String(c).trim()).filter(Boolean);
			if (!colors.length) return null;
			if (colors.every((c) => !c.startsWith("#"))) return "default";
			return h(
				"span",
				{},
				// One swatch per colour layer; layers left at the item's default colour are hatched
				colors.map((c, i) =>
					/^#[0-9a-f]{3,8}$/i.test(c)
						? h("span", { class: "fm-swatch", title: `Layer ${i + 1}: ${c}`, style: `background:${c}` })
						: h("span", { class: "fm-swatch fm-swatch-def", title: `Layer ${i + 1}: default colour` })
				)
			);
		}

		/**
		 * @param {any} c
		 * @param {IAssetFamily} family
		 */
		function craftCard(c, family) {
			const effects = activeEffects(c.Effects);
			// Option index 0 everywhere is just the item's default variant
			const typeEntries = Object.entries(c.TypeRecord || {});
			const typeRec = typeEntries.some(([, v]) => v) ? typeEntries.map(([k, v]) => `${k}: ${v}`).join(", ") : "";
			const itemProps = c.ItemProperty && Object.keys(c.ItemProperty).length ? JSON.stringify(c.ItemProperty) : "";
			return h(
				"div",
				{ class: "fm-card" },
				h("div", {}, h("b", {}, c.Name || "(unnamed)"), " ", h("span", { class: "fm-muted" }, craftItemLabel(c.Item))),
				c.Description ? h("div", { style: "margin:4px 0" }, c.Description) : null,
				kv([
					[
						"Properties",
						effects.length
							? h(
								"div",
								{},
								effects.map(([k, v]) => h("div", {}, h("b", {}, `${craftPropName(k)}${Number(v) > 1 ? ` ×${Number(v)}` : ""}`), craftPropDesc(k) ? ` — ${craftPropDesc(k)}` : ""))
							)
							: `${craftPropName("Normal")}${craftPropDesc("Normal") ? ` — ${craftPropDesc("Normal")}` : ""}`,
					],
					["Difficulty bonus", c.DifficultyFactor ? `+${c.DifficultyFactor}` : null],
					["Lock", c.Lock ? lockLabel(family, c.Lock) : null],
					["Colors", colorSwatches(c.Color)],
					["Options", typeRec || null],
					["Item settings", itemProps || null],
					["Visibility", c.Private ? "private" : "public"],
				])
			);
		}

		/** @param {Record<string, any>} r */
		function roomCard(r) {
			const friends = Array.isArray(r.Friends) ? r.Friends : [];
			return h(
				"div",
				{ class: "fm-card" },
				h("div", {}, h("b", {}, r.Name || "(unnamed room)")),
				r.Description ? h("pre", {}, r.Description) : h("p", { class: "fm-muted" }, "No description."),
				kv([
					["Creator", r.Creator ? `${r.Creator}${r.CreatorMemberNumber ? ` (#${r.CreatorMemberNumber})` : ""}` : null],
					["Created", r.Creation ? fmtDate(r.Creation) : null],
					["Members", r.MemberCount != null ? `${r.MemberCount} / ${r.MemberLimit ?? "?"}` : r.Limit != null ? `limit ${r.Limit}` : null],
					["Space", r.Space != null ? r.Space || "female" : null],
					["Language", r.Language],
					["Background", r.Background],
					["Game", r.Game],
					["Admins", r.AdminCount != null ? String(r.AdminCount) : null],
					["Locked", r.Locked != null ? (r.Locked ? "yes" : "no") : null],
					["Private", r.Private != null ? (r.Private ? "yes" : "no") : null],
					["Blocked categories", Array.isArray(r.BlockCategory) && r.BlockCategory.length ? r.BlockCategory.join(", ") : null],
					["Your friends inside", friends.length ? friends.map((/** @type {any} */ f) => `${f.MemberName} (#${f.MemberNumber})`).join(", ") : null],
				])
			);
		}

		/** @param {LBBProfile} rec */
		function renderProfileRoom(rec) {
			const member = selected;
			if (member == null) return null;
			const online = onlineFriends.get(member);
			let current;
			if (inRoomWith(member) && syncedRoom) {
				current = h("div", {}, h("p", { class: "fm-muted" }, "In your room right now."), roomCard(syncedRoom));
			} else if (online && online.ChatRoomName) {
				const lookup = roomLookups.get(member);
				const stale = lookup && lookup.name !== online.ChatRoomName;
				current = h(
					"div",
					{},
					h(
						"button",
						{
							onclick: async (/** @type {MouseEvent} */ e) => {
								const btn = /** @type {HTMLButtonElement} */ (e.target);
								btn.disabled = true;
								btn.textContent = "Searching…";
								const result = await lookupRoom(online.ChatRoomName, online.ChatRoomSpace);
								roomLookups.set(member, { name: online.ChatRoomName, ...result });
								if (selected === member) renderDetail();
							},
						},
						`Look up “${online.ChatRoomName}”`
					),
					lookup && !stale
						? lookup.room
							? h("div", {}, h("div", { class: "fm-muted" }, `Searched ${ago(lookup.at || 0)} `, joinButton(lookup.room.Name, lookup.room)), roomCard(lookup.room))
							: h("p", { class: "fm-muted" }, lookup.error)
						: null
				);
			} else if (online) {
				current = h("p", { class: "fm-muted" }, online.Private ? "Online in a private room, which can't be looked up." : "Online, not in a room.");
			} else {
				current = h("p", { class: "fm-muted" }, "Not online (or not a friend, so their room isn't visible).");
			}
			return h(
				"div",
				{},
				h("h3", {}, "Current room"),
				current,
				h("h3", {}, "Last room you were in together"),
				rec?.lastRoomInfo
					? h("div", {}, h("div", { class: "fm-muted" }, `As of ${fmtDate(rec.lastSeen)}`), roomCard(rec.lastRoomInfo))
					: h("p", { class: "fm-muted" }, rec?.lastRoom ? `“${rec.lastRoom}” (details weren't captured in this older snapshot)` : "None captured yet.")
			);
		}

		/** @param {LBBProfile} rec */
		function renderModMessages(rec) {
			const msgs = Object.entries(rec?.modMessages || {});
			if (!msgs.length) return h("p", { class: "fm-muted" }, "No hidden add-on messages captured from this person yet.");
			return h(
				"div",
				{},
				msgs
					.sort((a, b) => b[1].at - a[1].at)
					.map(([content, m]) => h("details", {}, h("summary", {}, `${content} — ${ago(m.at)}`), h("pre", {}, JSON.stringify(m.msg, null, 2))))
			);
		}

		/** @param {number} member */
		async function deleteRecord(member) {
			await dbDelete(keyFor(member));
			await reload();
		}

		async function exportAll() {
			const all = (await dbAllForOwner(Player.MemberNumber)).map(trimProfileForExport);
			download(
				`friendmgr-${Player.MemberNumber}-${new Date().toISOString().slice(0, 10)}.json`,
				JSON.stringify({ format: "BlackBook", version: 1, owner: Player.MemberNumber, exported: Date.now(), full: !!prefs.exportFull, records: all }),
				"application/json"
			);
		}

		/** @param {File} file */
		async function importFile(file) {
			if (!file) return;
			try {
				/** @type {any} */
				let parsed;
				try {
					parsed = JSON.parse(await file.text());
				} catch {
					return noteStatus(`Import: “${file.name}” isn't a Little Black Book export (not readable as JSON).`);
				}
				if (!Array.isArray(parsed?.records)) return noteStatus(`Import: “${file.name}” has no profiles in it. Use a file from Export.`);
				const recs = parsed.records;
				let n = 0;
				let older = 0;
				for (const r of recs) {
					if (typeof r?.member !== "number") continue;
					const existing = await dbGet(keyFor(r.member));
					// Keep whichever snapshot is newer; notes are merged by preferring the non-empty one
					if (existing && (existing.lastSeen || 0) > (r.lastSeen || 0)) {
						older++;
						continue;
					}
					// A trimmed export has no description/outfit/crafts: keep the ones already here
					if (r.trimmed && existing?.data) r.data = { ...existing.data, ...r.data, Description: existing.data.Description, Appearance: existing.data.Appearance, Crafting: existing.data.Crafting };
					await dbPut({ ...r, key: keyFor(r.member), owner: Player.MemberNumber, note: r.note || existing?.note || "" });
					n++;
				}
				console.log(TAG, `imported ${n} records`);
				await reload();
				noteStatus(`Import: ${n} profile${n === 1 ? "" : "s"} imported${older ? `, ${older} skipped (the copy here is newer)` : ""}.`);
			} catch (e) {
				console.warn(TAG, "import failed", e);
				noteStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		return {
			mount,
			unmount,
			open,
			close,
			refreshSoon,
			refreshBadge,
			syncTabVisibility,
			isViewingConv,
			onDm,
			onRoomLines,
			onSessionStarted,
			onSessionClosed,
			onAccountReady,
			onRoomRenamed,
			onOutboxChanged,
			onDataCleared,
			isOpen: () => !!panel,
		};
	})();

	// ---------- wiring ----------

	ui.mount();
	/** @type {number | null} */
	let scannedFor = null;
	let lastOutboxPoll = 0; // last online-friends query sent by the tick
	const ONLINE_POLL_OPEN_MS = 30_000;
	const ONLINE_POLL_BG_MS = 5 * 60_000; // with the window closed: often enough for "last online" to be close
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let pruneArmed;
	const tickTimer = setInterval(() => {
		watchSocket();
		ui.syncTabVisibility();
		if (syncDirty && Date.now() - syncStatus.at > 600_000) syncAccount().catch(() => {});
		if (!me()) return;
		// Opens this account's database after login (or switches to it); onAccountReady refreshes the UI
		if (dbOwner !== me()) {
			if (!dbOpening || dbOpening.owner !== me()) ensureDb().catch(() => {});
			return;
		}
		// While the panel is open, keep who's online fresh (people log in while you look at it); otherwise every few
		// minutes, so "last online" stays close
		if (Date.now() - lastOutboxPoll > (ui.isOpen() ? ONLINE_POLL_OPEN_MS : ONLINE_POLL_BG_MS)) {
			lastOutboxPoll = Date.now();
			requestOnlineFriends();
		}
		if (bellsFor !== me()) loadBells();
		// While anything is queued, or a friend is flagged 🔔, check who's online every minute
		if (((outbox.length && prefs.outboxAutoSend) || watchedOnline()) && Date.now() - lastOutboxPoll > OUTBOX_POLL_MS) {
			lastOutboxPoll = Date.now();
			requestOnlineFriends();
		}
		// Retention cleanup a minute after login, then every 6 hours
		if ((prefs.roomLogDays > 0 || prefs.chatDays > 0) && !pruneArmed && Date.now() - lastPrune > 6 * 3_600_000)
			pruneArmed = setTimeout(() => ((pruneArmed = undefined), pruneOldData()), lastPrune ? 0 : 60_000);
		watchChatLog();
		// Lines drawn before the session existed (page reload, script start) were skipped; pick them up once it does
		if (session && !session.closed && observedLog && scannedFor !== session.id) {
			scannedFor = session.id;
			for (const n of observedLog.children) if (n instanceof HTMLElement) captureLine(n);
		}
		const here = inRoom();
		if (here && prefs.logRooms && (!session || session.closed || session.owner !== me()) && !resuming && currentRoomName()) resumeCurrentRoom().catch((err) => console.warn(TAG, err));
		else if (!here && session && !session.closed) closeSession();
	}, 1000);

	const openBook = (/** @type {string} */ args) => {
		const n = parseInt(String(args || "").trim(), 10);
		ui.open(Number.isFinite(n) ? n : undefined, Number.isFinite(n) ? "profiles" : undefined).catch((err) => console.warn(TAG, err));
	};
	const commands = [
		{ Pref: "cmdBook", Tag: "book", Description: "[member number]: open your Little Black Book (a profile, if given)", Action: openBook },
		{
			Pref: "cmdChat",
			Tag: "chat",
			Description: "[member number]: open your chats (a conversation, if given)",
			Action: (/** @type {string} */ args) => {
				const n = parseInt(String(args || "").trim(), 10);
				ui.open(Number.isFinite(n) ? n : undefined, "chats").catch((err) => console.warn(TAG, err));
			},
		},
	];
	// Each command can be switched off in Settings (e.g. when another add-on wants /chat)
	function applyCommandPrefs() {
		if (typeof Commands === "undefined" || typeof CommandCombine !== "function") return;
		for (const c of commands) {
			const i = Commands.findIndex((x) => x.Tag === c.Tag);
			const ours = i >= 0 && Commands[i].Action === c.Action;
			if (prefs[c.Pref] && !ours) CommandCombine([{ Tag: c.Tag, Description: c.Description, Action: c.Action }]);
			else if (!prefs[c.Pref] && ours) Commands.splice(i, 1);
		}
	}
	applyCommandPrefs();

	window.BlackBook = {
		version: MOD_INFO.version,
		open: ui.open,
		get: (/** @type {number} */ member) => dbGet(keyFor(member)),
		all: () => dbAllForOwner(Player.MemberNumber),
		onlineFriends: () => new Map(onlineFriends),
		currentSession: () => (session ? { ...session } : null),
		sessions: async () => (await ensureDb(), reqDone(storeOf("sessions").index("owner").getAll(me()))),
		sessionLines: async (/** @type {number} */ id) => (await ensureDb(), reqDone(storeOf("roomMsgs").index("session").getAll(id))),
		conversation: async (/** @type {number} */ member) => (await ensureDb(), reqDone(storeOf("dms").index("conv").getAll(IDBKeyRange.bound([me(), member, 0], [me(), member, Infinity])))),
		database: () => (db ? db.name : null),
		gameUnread,
		importLianChat,
		syncNow: () => syncAccount(true),
		syncStatus: () => ({ ...syncStatus }),
		unload() {
			flushLines();
			for (const s of hookedSockets) {
				try {
					s.offAny(onServerEvent);
					s.offAnyOutgoing?.(onClientEvent);
				} catch {
					// already done or gone: nothing to undo
				}
			}
			logObserver?.disconnect();
			clearInterval(tickTimer);
			clearTimeout(pruneArmed);
			ui.unmount();
			if (typeof Commands !== "undefined") {
				for (const c of commands) {
					const i = Commands.findIndex((x) => x.Tag === c.Tag && x.Action === c.Action);
					if (i >= 0) Commands.splice(i, 1);
				}
			}
			mod.unload();
			db?.close();
			delete window.BlackBook;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded`);
})().catch((err) => console.error("[BlackBook]", err));
