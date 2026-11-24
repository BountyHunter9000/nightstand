// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
//
// Checks every add-on the way Bondage Club checks its own scripts: the game's ESLint config and its strict
// TypeScript check (checkJs + strict), with the add-ons placed among the game's scripts so they're held to the same
// rules and see the game's own declarations.
//
//   node tools/check.mjs [--game <path to the game's BondageClub folder>]
//
// The game's folder defaults to ./Bondage-College/BondageClub (a checkout of the game's repository). Its scripts are
// copied to a work folder in the system temp folder, the game's npm packages are installed there once, and nothing in
// either checkout is changed. Exit code 0: both checks pass.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argGame = process.argv.indexOf("--game");
const game = path.resolve(argGame > 0 ? process.argv[argGame + 1] : path.join(repo, "Bondage-College", "BondageClub"));
const work = path.join(os.tmpdir(), "bc-toolkit-check");
const ADDONS = {
	"bc-dock/bc-dock.js": "Dock.js",
	"bc-little-black-book/little-black-book.js": "LittleBlackBook.js",
	"bc-quick-actions/quick-actions.js": "QuickActions.js",
	"bc-vibe-link/vibe-link.js": "VibeLink.js",
	"bc-afterglow/afterglow.js": "Afterglow.js",
	"bc-quiet/quiet.js": "Quiet.js",
	"bc-held-remote/held-remote.js": "HeldRemote.js",
	"bc-vibe-fix/vibe-fix.js": "GameFixes.js",
	"types/bc-toolkit.d.ts": "BCToolkit.d.ts",
};

if (!fs.existsSync(path.join(game, "eslint.config.mjs"))) {
	console.error(`No Bondage Club checkout at ${game} (pass --game <path to its BondageClub folder>)`);
	process.exit(2);
}

// The game's script sources and its tooling config, no images or audio
const want = (f) => /\.(js|ts|mjs|cjs|json)$/.test(f);
function copyTree(rel, all = false) {
	const from = path.join(game, rel);
	if (!fs.existsSync(from)) return;
	for (const e of fs.readdirSync(from, { withFileTypes: true, recursive: true })) {
		if (!e.isFile() || (!all && (!want(e.name) || e.name.endsWith(".min.js")))) continue;
		const abs = path.join(e.parentPath ?? e.path, e.name);
		const out = path.join(work, path.relative(game, abs));
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.copyFileSync(abs, out);
	}
}
fs.mkdirSync(work, { recursive: true });
for (const f of ["package.json", "package-lock.json", "eslint.config.mjs", "tsconfig.json"]) fs.copyFileSync(path.join(game, f), path.join(work, f));
for (const d of ["Scripts", "Screens", "Assets", "Backgrounds", "Tools/Node"]) copyTree(d);
copyTree("Scripts/lib", true);
const dest = path.join(work, "Scripts", "BCToolkit");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const [from, to] of Object.entries(ADDONS)) fs.copyFileSync(path.join(repo, from), path.join(dest, to));

const run = (cmd, args) => spawnSync(cmd, args, { cwd: work, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
if (!fs.existsSync(path.join(work, "node_modules", "typescript"))) {
	console.log("Installing the game's npm packages (once)…");
	const r = run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
	if (r.status !== 0) {
		console.error(r.stdout, r.stderr);
		process.exit(2);
	}
}

console.log(`ESLint (the game's eslint.config.mjs), ${Object.keys(ADDONS).length - 1} add-ons…`);
const lint = run("npx", ["eslint", "--max-warnings", "0", "Scripts/BCToolkit/"]);
process.stdout.write(lint.stdout || "");
console.log(lint.status === 0 ? "  passed: no errors, no warnings" : "  FAILED");

console.log("TypeScript (the game's tsconfig.json: checkJs, strict), the game and the add-ons…");
const tsc = run("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "--incremental", "false", "--pretty", "false"]);
const lines = (tsc.stdout || "").split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
const ours = lines.filter((l) => l.startsWith("Scripts/BCToolkit/") || l.startsWith("Scripts\\BCToolkit\\"));
for (const l of ours) console.log(`  ${l}`);
if (lines.length > ours.length) console.log(`  (${lines.length - ours.length} errors in the game's own files, not counted)`);
console.log(ours.length ? `  FAILED: ${ours.length} errors` : "  passed: no errors");

process.exit(lint.status === 0 && ours.length === 0 ? 0 : 1);
