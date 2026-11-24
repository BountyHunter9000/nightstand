// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Types shared by the Nightstand add-ons: the dock's API and what each add-on puts on window. Only used when type
// checking (tools/check.mjs checks the add-ons against the game's own declarations); the game never loads it.

/** A panel an add-on adds to the dock (BCDock.add) */
interface BCDockPanelSpec {
	id: string;
	title: string;
	/** Shown on the tab; the first two letters of the title without one */
	icon?: string;
	/** Tabs are kept sorted by this */
	order?: number;
	version?: string;
	width?: number;
	minWidth?: number;
	maxWidth?: number;
	/** Open lined up with the start of the rail instead of the tab */
	alignStart?: boolean;
	visible?: boolean;
	/** A tab that runs this instead of opening a panel */
	onClick?: () => void;
	onToggle?: (open: boolean) => void;
}

/** What BCDock.add returns; it finds its panel again through window.BCDock, so it survives a newer dock taking over */
interface BCDockHandle {
	readonly id: string;
	readonly body: HTMLElement | undefined;
	readonly actions: HTMLElement | undefined;
	setTitle(title: string): void;
	setSummary(text: string | null | undefined): void;
	setBadge(badge: string | number | null | undefined): void;
	setDot(dot: string | null | undefined): void;
	setVisible(visible: boolean): void;
	open(): void;
	close(): void;
	toggle(): void;
	isOpen(): boolean;
	remove(): void;
}

interface BCDockApi {
	version: number;
	add(spec: BCDockPanelSpec): BCDockHandle;
	isOpen(id: string): boolean;
	/** A marker in front of the name in the browser tab; null removes it */
	setTitleMark(id: string, text: string | null): void;
	/** The current palette: CSS variable name -> value */
	theme(): Record<string, string>;
	reset(): void;
	toolkit: {
		status(): Record<string, { pick: string; running: string | null; status: string }>;
		set(id: string, pick: string): void;
		check(): Promise<void>;
	};
	// Used between dock versions (taking over, the developer reload)
	_panels: Map<string, any>;
	_setOpen(id: string, open: boolean): void;
	_remove(id: string): void;
	_devKnown(): any;
	_devRoot(): any;
	_devKnownSet(known: any): void;
	_titleMarks(): [string, string][];
	_tk(): any;
	_takeover?(): any;
}

/** Each add-on's console object; `unload` removes it so a newer copy can take its place */
interface BCToolkitAddon {
	version: string;
	unload(): void;
	[more: string]: any;
}

interface Window {
	BCDock?: BCDockApi;
	/** Set by the Nightstand script (or loader.js): the dock is also the add-on loader */
	BCToolkit?: { loader?: boolean; beta?: boolean; checkMs?: number; tickMs?: number; listUrl?: string; fileBase?: string };
	/** Developer tools, only when a private loader turns them on */
	BCDockDev?: { reload?: boolean; watch?: boolean };
	/** Set by the developer reload so a dock of the same version replaces the running one */
	__bcDockReload?: boolean;
	/** Vibe Link hands its live state to its next copy on a developer reload */
	__vibeLinkCarry?: any;
	BlackBook?: BCToolkitAddon;
	QuickActions?: BCToolkitAddon;
	VibeLink?: BCToolkitAddon;
	Afterglow?: BCToolkitAddon;
	Quiet?: BCToolkitAddon;
	HeldRemote?: BCToolkitAddon;
	VibeFix?: BCToolkitAddon;
}

/** The dock, once loaded (add-ons check window.BCDock first) */
declare var BCDock: BCDockApi;
