/**
 * pi-statusline — replaces the default footer with a clean one-line status bar.
 *
 * Layout:   ~/path  ⎇ branch          ctx 45%  5h 12%  wk 3%  model
 *
 * Context % — current token count vs the model's context window.
 * 5h %      — input+output tokens from the last 5 h vs FIVE_HOUR_LIMIT.
 * wk %      — same for the last 7 days vs WEEKLY_LIMIT.
 *
 * Limits default to Anthropic Tier-1 values.
 * Override via /statusline-config  e.g. /statusline-config 5h=2000000 wk=20000000
 *
 * Placement: ~/.pi/agent/extensions/statusline.ts  (global)
 *         or .pi/extensions/statusline.ts          (project-local)
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

// ─── tuneable limits ────────────────────────────────────────────────────────
let FIVE_HOUR_LIMIT = 1_000_000;
let WEEKLY_LIMIT    = 10_000_000;
// ────────────────────────────────────────────────────────────────────────────

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

/** Sum input+output tokens for assistant turns within the given window (ms). */
function tokensInWindow(ctx: ExtensionContext, since: number): number {
	let total = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (
			e.type === "message" &&
			e.message.role === "assistant" &&
			(e as any).timestamp >= since
		) {
			const m = e.message as AssistantMessage;
			total += (m.usage?.input ?? 0) + (m.usage?.output ?? 0);
		}
	}
	return total;
}

/** green → yellow → red based on percentage. */
function pctColor(pct: number): "success" | "warning" | "error" {
	return pct >= 80 ? "error" : pct >= 60 ? "warning" : "success";
}

// ─── extension entry point ──────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | null = null;
	let requestRenderFn: (() => void) | null = null;

	function mountFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRenderFn = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					const activeCtx = latestCtx ?? ctx;
					const now = Date.now();

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

					const usage         = activeCtx.getContextUsage();
					const contextWindow = (activeCtx.model as any)?.contextWindow ?? 200_000;
					const ctxPct        = Math.min(100, Math.round(((usage?.tokens ?? 0) / contextWindow) * 100));

					const tokens5h = tokensInWindow(activeCtx, now - 5 * 60 * 60 * 1_000);
					const pct5h    = Math.min(999, Math.round((tokens5h / FIVE_HOUR_LIMIT) * 100));

					const tokensWk = tokensInWindow(activeCtx, now - 7 * 24 * 60 * 60 * 1_000);
					const pctWk    = Math.min(999, Math.round((tokensWk / WEEKLY_LIMIT) * 100));

					const SEP = theme.fg("dim", "  ");

					const right =
						theme.fg("syntaxKeyword",  "Context ") + theme.fg(pctColor(ctxPct), `${ctxPct}%`) + SEP +
						theme.fg("syntaxFunction", "5h ")      + theme.fg(pctColor(pct5h),  `${pct5h}%`)  + SEP +
						theme.fg("syntaxVariable", "wk ")      + theme.fg(pctColor(pctWk),  `${pctWk}%`)  + SEP +
						theme.fg("syntaxType", model) +
						" ";

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
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		requestRenderFn = null;
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		requestRenderFn?.();
	});

	// ── /statusline-config ──────────────────────────────────────────────────
	pi.registerCommand("statusline-config", {
		description: "Configure statusline token limits  e.g. /statusline-config 5h=2000000 wk=20000000",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify(
					`5h: ${FIVE_HOUR_LIMIT.toLocaleString()} tokens  •  wk: ${WEEKLY_LIMIT.toLocaleString()} tokens`,
					"info",
				);
				return;
			}
			for (const part of args.trim().split(/\s+/)) {
				const [key, val] = part.split("=");
				const n = parseInt(val ?? "", 10);
				if (isNaN(n) || n <= 0) continue;
				if (key === "5h") FIVE_HOUR_LIMIT = n;
				if (key === "wk") WEEKLY_LIMIT    = n;
			}
			ctx.ui.notify(
				`Updated  5h: ${FIVE_HOUR_LIMIT.toLocaleString()}  •  wk: ${WEEKLY_LIMIT.toLocaleString()}`,
				"success",
			);
			requestRenderFn?.();
		},
	});
}
