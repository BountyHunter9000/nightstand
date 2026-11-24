// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Refreshes the version lists in toolkit.json from the release tags (book-v1.2.3, qa-v0.5.2, …), newest first.
// Test versions (pre-release tags such as ag-v0.9.0-beta.1) go in a separate "beta" list, which the dock only offers
// to people who switch on "Show test versions"; "versions" (and so Latest) never contains one.
// Run it after tagging a release or a test version, then commit toolkit.json:   node tools/toolkit-list.mjs
// The Nightstand loader (in the dock) reads toolkit.json from main to fill its version menus; the add-on files
// themselves always come from their tags.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KEEP = 8; // releases offered per add-on
const KEEP_BETA = 5; // test versions offered per add-on
const RELEASE = /^\d+\.\d+\.\d+$/;
const PRERELEASE = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

// Newest first, by semantic versioning: 0.9.0 > 0.9.0-beta.10 > 0.9.0-beta.2 > 0.9.0-beta.1 > 0.8.2
export function newestFirst(a, b) {
	const [am, ap] = a.split(/-(.*)/s);
	const [bm, bp] = b.split(/-(.*)/s);
	const x = am.split(".").map(Number);
	const y = bm.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
	if (!ap !== !bp) return ap ? 1 : -1; // a release beats its own test versions
	if (!ap) return 0;
	const p = ap.split(".");
	const q = bp.split(".");
	for (let i = 0; i < Math.max(p.length, q.length); i++) {
		if (p[i] === undefined) return 1;
		if (q[i] === undefined) return -1;
		const num = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
		const d = num ? Number(q[i]) - Number(p[i]) : q[i].localeCompare(p[i]);
		if (d) return d;
	}
	return 0;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(new URL("../toolkit.json", import.meta.url));
const list = JSON.parse(readFileSync(file, "utf8"));
const tags = execFileSync("git", ["tag", "-l"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
// The dock releases, for loader.js and loader-beta.js (console, bookmark, FUSAM): they read which dock to load from
// here, so a dock release reaches them as soon as toolkit.json is on main. "dockBeta" is the newest test version of
// the dock, or the release once that's newer.
{
	const tk = tags.filter((t) => t.startsWith("tk-v")).map((t) => t.slice(4));
	const rel = tk.filter((v) => RELEASE.test(v)).sort(newestFirst)[0];
	const pre = tk.filter((v) => PRERELEASE.test(v)).sort(newestFirst)[0];
	// The repository the files are in: the dock and the loaders build their addresses from it (change it when the
	// repository is renamed)
	list.repo = "nightstand";
	if (rel) list.dock = `tk-v${rel}`;
	const beta = [rel, pre].filter(Boolean).sort(newestFirst)[0];
	if (beta) list.dockBeta = `tk-v${beta}`;
	console.log(`Dock: ${list.dock || "(no release)"}, test: ${list.dockBeta || "(none)"}`);
}
for (const a of list.addons) {
	const all = tags.filter((t) => t.startsWith(a.prefix)).map((t) => t.slice(a.prefix.length));
	a.versions = all.filter((v) => RELEASE.test(v)).sort(newestFirst).slice(0, KEEP);
	a.beta = all.filter((v) => PRERELEASE.test(v)).sort(newestFirst).slice(0, KEEP_BETA);
	console.log(`${a.name}: ${a.versions.join(", ") || "(no releases)"}${a.beta.length ? ` · test: ${a.beta.join(", ")}` : ""}`);
}
writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
