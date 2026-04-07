/**
 * pi-statusline — replaces the default footer with a clean one-line status bar.
 * Integrates cc-usage (https://github.com/burneikis/cc-usage) for real
 * Anthropic API rate-limit utilization instead of local approximations.
 *
 * Layout:   ~/path  ⎇ branch          ctx 45%  5h 12%  7d 3%  snt 1%  model
 *
 * ctx  — current token count vs the model's context window (local).
 * 5h   — current-session 5-hour window utilization from Anthropic API.
 * 7d   — all-models 7-day window utilization from Anthropic API.
 * snt  — Sonnet-only 7-day window utilization from Anthropic API.
 * ext  — extra usage/credits utilization (shown only when enabled).
 *
 * Rate-limit data is fetched from the Anthropic OAuth usage endpoint every 30 s.
 * Requires ~/.claude/.credentials.json (populated automatically by Claude Code).
 * Falls back to showing nothing for those fields if credentials are absent.
 *
 * Placement: ~/.pi/agent/extensions/statusline.ts  (global)
 *         or .pi/extensions/statusline.ts          (project-local)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

// ─── cc-usage config (mirrors burneikis/cc-usage) ───────────────────────────
const POLL_INTERVAL_MS = 60_000;
const API_URL          = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL        = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID        = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CREDS_PATH       = join(homedir(), ".claude", ".credentials.json");

// ─── Types ───────────────────────────────────────────────────────────────────
interface LimitInfo {
	utilization: number | null;
	resets_at?: string;
}

interface UsageData {
	five_hour?: LimitInfo;
	seven_day?: LimitInfo;
	seven_day_sonnet?: LimitInfo;
	extra_usage?: {
		is_enabled: boolean;
		utilization?: number | null;
		monthly_limit?: number | null;
		used_credits?: number;
	};
}

interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt?: number;
}

// ─── Token management ────────────────────────────────────────────────────────
function readCreds(): Record<string, unknown> {
	return JSON.parse(readFileSync(CREDS_PATH, "utf8")) as Record<string, unknown>;
}

function writeCreds(creds: Record<string, unknown>): void {
	writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
}

function loadTokens(): OAuthTokens | null {
	try {
		const oauth = (readCreds()?.claudeAiOauth) as OAuthTokens | undefined;
		if (!oauth?.accessToken) return null;
		return oauth;
	} catch {
		return null;
	}
}

function isExpired(tokens: OAuthTokens): boolean {
	if (!tokens.expiresAt) return false;
	return Date.now() >= tokens.expiresAt - 60_000;
}

async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type:    "refresh_token",
			refresh_token: tokens.refreshToken,
			client_id:     CLIENT_ID,
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}`);
	}

	const data = await res.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	const newTokens: OAuthTokens = {
		...tokens,
		accessToken:  data.access_token,
		refreshToken: data.refresh_token ?? tokens.refreshToken,
		expiresAt:    Date.now() + data.expires_in * 1_000,
	};

	try {
		const creds = readCreds();
		creds.claudeAiOauth = newTokens;
		writeCreds(creds);
	} catch {
		// Non-fatal — new tokens still valid in memory
	}

	return newTokens;
}

async function fetchUsage(tokens: OAuthTokens): Promise<UsageData> {
	const res = await fetch(API_URL, {
		headers: {
			"Authorization":  `Bearer ${tokens.accessToken}`,
			"Content-Type":   "application/json",
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(8_000),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	return res.json() as Promise<UsageData>;
}

// ─── Usage poll state (module-level so it persists across re-mounts) ─────────
let usageData: UsageData | null = null;
let lastFetchTime  = 0;
let isFetching     = false;
let noCredentials  = false;   // true once we've confirmed creds are absent

async function pollUsage(): Promise<void> {
	if (isFetching) return;
	isFetching = true;
	try {
		let tokens = loadTokens();
		if (!tokens) {
			noCredentials = true;
			return;
		}
		noCredentials = false;

		if (isExpired(tokens)) {
			tokens = await refreshTokens(tokens);
		}

		usageData     = await fetchUsage(tokens);
		lastFetchTime = Date.now();
	} catch {
		// Keep stale data on error; silent fail — don't clutter the UI
	} finally {
		isFetching = false;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Format a reset countdown: "1h32m" or "45m" until the ISO timestamp.
 * Uses the system clock so it's always correct for the local timezone.
 */
function fmtResetIn(isoStr: string | undefined): string | null {
	if (!isoStr) return null;
	const diffMs = new Date(isoStr).getTime() - Date.now();
	if (diffMs <= 0) return "↺now";
	const h = Math.floor(diffMs / 3_600_000);
	const m = Math.floor((diffMs % 3_600_000) / 60_000);
	return h > 0 ? `↺${h}h${m}m` : `↺${m}m`;
}

/** Format a token count as a compact string: 0–999 as-is, then Xk, XM. */
function fmtTokens(n: number): string {
	if (n < 1_000)       return n.toString();
	if (n < 10_000)      return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000)   return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000)  return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Replace $HOME with ~, keep at most 3 path segments. */
function fmtDir(cwd: string): string {
	const home = homedir();
	let p = cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
	const parts = p.split("/").filter(Boolean);
	if (parts.length > 3) {
		p = (p.startsWith("~") ? "~/" : "/") + "…/" + parts.slice(-2).join("/");
	}
	return p;
}

/** green → yellow → red based on percentage. */
function pctColor(pct: number): "success" | "warning" | "error" {
	return pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
}

// ─── Extension entry point ───────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | null = null;
	let requestRenderFn: (() => void) | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function mountFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRenderFn = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					const activeCtx = latestCtx ?? ctx;

					// Trigger a background fetch if data is stale (non-blocking)
					if (!isFetching && Date.now() - lastFetchTime > POLL_INTERVAL_MS) {
						pollUsage().then(() => tui.requestRender()).catch(() => {});
					}

					// ── left: dir + branch ─────────────────────────────────
					const dir    = fmtDir(activeCtx.cwd);
					const branch = footerData.getGitBranch() ?? "no git";

					const left =
						" " +
						theme.fg("text", dir) +
						theme.fg("dim", "  ⎇ ") +
						theme.fg("accent", branch);

					// ── right: usage percentages + model ──────────────────
					const model = activeCtx.model?.id ?? "no model";
					const usage = activeCtx.getContextUsage();

					// ctx: show "used/total" token counts
					const ctxTokens = usage?.tokens ?? null;
					const ctxWindow = usage?.contextWindow ?? 0;
					const ctxPct    = Math.min(100, Math.round(usage?.percent ?? 0));
					const ctxStr    = ctxTokens !== null && ctxWindow > 0
						? `${fmtTokens(ctxTokens)}/${fmtTokens(ctxWindow)}`
						: ctxWindow > 0 ? `?/${fmtTokens(ctxWindow)}` : "ctx ?";

					const SEP = theme.fg("dim", "  ");

					let right =
						theme.fg("syntaxKeyword", "ctx ") +
						theme.fg(pctColor(ctxPct), ctxStr);

					// API-sourced rate-limit utilization from cc-usage
					if (noCredentials) {
						// ~/.claude/.credentials.json not found — OAuth login required
						right += SEP + theme.fg("dim", "cc:no creds");
					} else if (usageData) {
						const fiveHour = usageData.five_hour?.utilization;
						const sevenDay = usageData.seven_day?.utilization;
						const snt      = usageData.seven_day_sonnet?.utilization;
						const extra    = usageData.extra_usage;

						if (typeof fiveHour === "number") {
							const pct      = Math.min(999, Math.floor(fiveHour));
							const resetStr = fmtResetIn(usageData.five_hour?.resets_at);
							right += SEP +
								theme.fg("syntaxFunction", "5h ") +
								theme.fg(pctColor(pct), `${pct}%`) +
								(resetStr ? " " + theme.fg("dim", resetStr) : "");
						}
						if (typeof sevenDay === "number") {
							const pct = Math.min(999, Math.floor(sevenDay));
							right += SEP +
								theme.fg("syntaxVariable", "7d ") +
								theme.fg(pctColor(pct), `${pct}%`);
						}
						if (typeof snt === "number") {
							const pct = Math.min(999, Math.floor(snt));
							right += SEP +
								theme.fg("dim", "snt ") +
								theme.fg(pctColor(pct), `${pct}%`);
						}
						if (extra?.is_enabled && typeof extra.utilization === "number") {
							const pct = Math.min(999, Math.floor(extra.utilization));
							right += SEP +
								theme.fg("dim", "ext ") +
								theme.fg(pctColor(pct), `${pct}%`);
						}
					} else {
						// Credentials present but no data yet (first fetch in progress)
						right += SEP + theme.fg("dim", "cc:…");
					}

					right += SEP + theme.fg("syntaxType", model) + " ";

					// ── pad between left and right ─────────────────────────
					const gap  = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					const line = left + " ".repeat(gap) + right;

					return [truncateToWidth(line, width)];
				},
			};
		});
	}

	// ── lifecycle ───────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		mountFooter(ctx);

		// Initial fetch, then periodic polling
		pollUsage().then(() => requestRenderFn?.()).catch(() => {});
		pollTimer = setInterval(() => {
			pollUsage().then(() => requestRenderFn?.()).catch(() => {});
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		requestRenderFn = null;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		requestRenderFn?.();
	});
}
