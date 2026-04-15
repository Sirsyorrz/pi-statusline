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
 * Usage data is fetched every 5 min, cached to disk, and shown from cache on
 * startup. If the API returns 429 (rate-limited) the poll interval doubles
 * (up to 60 min) and resets to 5 min once a fetch succeeds again.
 *
 * Placement: ~/.pi/agent/extensions/statusline.ts  (global)
 *         or .pi/extensions/statusline.ts          (project-local)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────────────────────────
const BASE_POLL_MS    = 300_000;          // 5 minutes (normal)
const MAX_POLL_MS     = 3_600_000;        // 60 minutes (rate-limit cap)
const API_URL         = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL       = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID       = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PI_AUTH_PATH    = join(homedir(), ".pi", "agent", "auth.json");
const CACHE_DIR       = join(homedir(), ".cache", "pi-statusline");
const CACHE_PATH      = join(CACHE_DIR, "usage.json");

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

interface CacheFile {
	fetchedAt: number;   // epoch ms
	data: UsageData;
}

interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt?: number;
}

// ─── Disk cache ──────────────────────────────────────────────────────────────
function loadCache(): CacheFile | null {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
	} catch {
		return null;
	}
}

function saveCache(data: UsageData): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2), "utf8");
	} catch {
		// Non-fatal
	}
}

// ─── Token management ────────────────────────────────────────────────────────

function loadTokens(): OAuthTokens | null {
	try {
		const raw = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8")) as Record<string, unknown>;
		const a = raw?.anthropic as { access?: string; refresh?: string; expires?: number } | undefined;
		if (!a?.access) return null;
		return {
			accessToken:  a.access,
			refreshToken: a.refresh ?? "",
			expiresAt:    a.expires,
		};
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
		const raw = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8")) as Record<string, unknown>;
		(raw.anthropic as Record<string, unknown>) = {
			...(raw.anthropic as Record<string, unknown>),
			access:  newTokens.accessToken,
			refresh: newTokens.refreshToken,
			expires: newTokens.expiresAt,
		};
		writeFileSync(PI_AUTH_PATH, JSON.stringify(raw, null, 2), "utf8");
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
		// Attach status so the caller can detect 429
		const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
		(err as Error & { status: number }).status = res.status;
		throw err;
	}
	return res.json() as Promise<UsageData>;
}

// ─── Poll state (module-level — persists across re-mounts) ───────────────────
let usageData: UsageData | null        = null;
let lastFetchTime  = 0;                // epoch ms of last successful fetch
let isFetching     = false;
let noCredentials  = false;
let currentPollMs  = BASE_POLL_MS;    // may grow on 429
let isRateLimited  = false;
let rateLimitUntil = 0;               // epoch ms: earliest time to resume BASE_POLL_MS

/** Set by session_start so the /usage-refresh command can restart the timer. */
let scheduledKick: (() => void) | null = null;

// Boot: load from disk cache immediately so data is visible before first fetch
const cached = loadCache();
if (cached) {
	usageData     = cached.data;
	lastFetchTime = cached.fetchedAt;
}

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

		// Successful fetch — restore normal interval
		if (isRateLimited) {
			currentPollMs  = BASE_POLL_MS;
			isRateLimited  = false;
			rateLimitUntil = 0;
		}

		saveCache(usageData);
	} catch (err: unknown) {
		const status = (err as Error & { status?: number }).status;
		if (status === 429) {
			// Exponential backoff on rate limit
			isRateLimited  = true;
			currentPollMs  = Math.min(currentPollMs * 2, MAX_POLL_MS);
			rateLimitUntil = Date.now() + currentPollMs;
		}
		// Keep stale data; silent fail — don't clutter the UI
	} finally {
		isFetching = false;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtResetIn(isoStr: string | undefined): string | null {
	if (!isoStr) return null;
	const diffMs = new Date(isoStr).getTime() - Date.now();
	if (diffMs <= 0) return "↺now";
	const h = Math.floor(diffMs / 3_600_000);
	const m = Math.floor((diffMs % 3_600_000) / 60_000);
	return h > 0 ? `↺${h}h${m}m` : `↺${m}m`;
}

function fmtTokens(n: number): string {
	if (n < 1_000)       return n.toString();
	if (n < 10_000)      return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000)   return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000)  return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function fmtDir(cwd: string): string {
	const home = homedir();
	let p = cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
	const parts = p.split("/").filter(Boolean);
	if (parts.length > 3) {
		p = (p.startsWith("~") ? "~/" : "/") + "…/" + parts.slice(-2).join("/");
	}
	return p;
}

function pctColor(pct: number): "success" | "warning" | "error" {
	return pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
}

/** How stale is the cached data? Returns a label like "~12m ago" or "~2h ago". */
function stalenessLabel(fetchedAt: number): string {
	const diffMs = Date.now() - fetchedAt;
	const m = Math.round(diffMs / 60_000);
	if (m < 60) return `~${m}m ago`;
	const h = Math.floor(m / 60);
	return `~${h}h ago`;
}

// ─── Extension entry point ───────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | null = null;
	let requestRenderFn: (() => void) | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	/** Schedule the next poll; uses `currentPollMs` which may be inflated by 429. */
	function schedulePoll(renderFn: () => void) {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => {
			pollUsage().then(() => renderFn()).catch(() => {}).finally(() => schedulePoll(renderFn));
		}, currentPollMs);
	}

	function mountFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRenderFn = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					const activeCtx = latestCtx ?? ctx;

					// Sync from disk cache if a newer fetch landed (e.g. from another module instance)
					const diskCache = loadCache();
					if (diskCache && diskCache.fetchedAt > lastFetchTime) {
						usageData     = diskCache.data;
						lastFetchTime = diskCache.fetchedAt;
					}

					// Trigger a background fetch if data is stale (non-blocking)
					const staleness = Date.now() - lastFetchTime;
					if (!isFetching && staleness > currentPollMs) {
						pollUsage().then(() => tui.requestRender()).catch(() => {});
					}

					// ── helpers ───────────────────────────────────────────
					const D   = (s: string) => theme.fg("dim", s);
					const SEP = D(" · ");
					const pct = (n: number) => theme.fg(pctColor(n), `(${n}%)`);

					// ── left: dir + branch ────────────────────────────────
					const dir    = fmtDir(activeCtx.cwd);
					const branch = footerData.getGitBranch() ?? "no git";

					const left =
						" " +
						theme.fg("text", dir) +
						D(" ⎇ ") +
						theme.fg("accent", branch);

					// ── right segments ────────────────────────────────────
					const model    = activeCtx.model?.id ?? "no model";
					const provider = activeCtx.model?.provider;
					const usage    = activeCtx.getContextUsage();

					const ctxTokens = usage?.tokens ?? null;
					const ctxWindow = usage?.contextWindow ?? 0;
					const ctxPct    = Math.min(100, Math.round(usage?.percent ?? 0));
					const ctxVal    = ctxTokens !== null && ctxWindow > 0
						? `${fmtTokens(ctxTokens)}/${fmtTokens(ctxWindow)}`
						: ctxWindow > 0 ? `?/${fmtTokens(ctxWindow)}` : "?";

					const segments: string[] = [
						D("ctx ") + theme.fg(pctColor(ctxPct), ctxVal),
					];

					// API-sourced rate-limit utilization
					if (noCredentials) {
						segments.push(D("no oauth"));
					} else if (usageData) {
						const fiveHour = usageData.five_hour?.utilization;
						const sevenDay = usageData.seven_day?.utilization;
						const snt      = usageData.seven_day_sonnet?.utilization;
						const extra    = usageData.extra_usage;

						if (typeof fiveHour === "number") {
							const resetStr = fmtResetIn(usageData.five_hour?.resets_at);
							segments.push(
								D("5h ") + pct(Math.min(999, Math.floor(fiveHour))) +
								(resetStr ? " " + D(resetStr) : ""),
							);
						}
						if (typeof sevenDay === "number") {
							segments.push(D("7d ") + pct(Math.min(999, Math.floor(sevenDay))));
						}
						if (typeof snt === "number") {
							segments.push(D("snt ") + pct(Math.min(999, Math.floor(snt))));
						}
						if (extra?.is_enabled && typeof extra.utilization === "number") {
							segments.push(D("ext ") + pct(Math.min(999, Math.floor(extra.utilization))));
						}

						// Show staleness / rate-limit status as a subtle suffix
						if (isRateLimited) {
							const resumeIn = Math.max(0, Math.round((rateLimitUntil - Date.now()) / 60_000));
							segments.push(D(`⚠ rl ${resumeIn}m`));
						} else if (lastFetchTime > 0 && staleness > BASE_POLL_MS * 2) {
							// Data is notably stale (>10 min) — show how old it is
							segments.push(D(stalenessLabel(lastFetchTime)));
						}
					} else if (!isFetching) {
						// First fetch still in progress or failed before cache was populated
						segments.push(D("…"));
					}

					segments.push(theme.fg("text", model) + (provider ? D(` (${provider})`) : ""));

					const right = " " + segments.join(SEP) + " ";

					// ── pad between left and right ─────────────────────────
					const gap  = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					const line = left + " ".repeat(gap) + right;

					return [truncateToWidth(line, width)];
				},
			};
		});
	}

	// ── commands ────────────────────────────────────────────────────────────
	pi.registerCommand("usage-refresh", {
		description: "Immediately refresh Claude API usage data and restart the poll timer.",
		handler: async (_args, ctx) => {
			try {
				let tokens = loadTokens();
				if (!tokens) {
					ctx.ui.notify("No credentials found", "error");
					return;
				}
				if (isExpired(tokens)) tokens = await refreshTokens(tokens);

				const fresh = await fetchUsage(tokens);
				usageData     = fresh;
				lastFetchTime = Date.now();
				isFetching    = false;
				isRateLimited = false;
				noCredentials = false;
				rateLimitUntil = 0;
				currentPollMs  = BASE_POLL_MS;
				saveCache(fresh);
				requestRenderFn?.();
				scheduledKick?.();

				const fh = fresh.five_hour?.utilization;
				const sd = fresh.seven_day?.utilization;
				ctx.ui.notify(`Usage refreshed ✓  5h ${fh != null ? Math.floor(fh) : "?"}%  7d ${sd != null ? Math.floor(sd) : "?"}%`, "info");
			} catch (err) {
				ctx.ui.notify(`Usage fetch failed: ${(err as Error).message?.slice(0, 100)}`, "error");
			}
		},
	});

	// ── lifecycle ───────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		mountFooter(ctx);

		// Initial fetch (cache already loaded at module init)
		pollUsage().then(() => requestRenderFn?.()).catch(() => {});

		// Adaptive polling — uses currentPollMs so backoff is respected
		function kick() {
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = setTimeout(() => {
				pollUsage().then(() => requestRenderFn?.()).catch(() => {}).finally(kick);
			}, currentPollMs);
		}
		scheduledKick = kick; // expose for /usage-refresh command
		kick();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		requestRenderFn = null;
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		requestRenderFn?.();
	});
}
