import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { RepoConfig, RunOutcome } from "./types.ts";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const EXIT_LINE = /\n*Command exited with code \d+\s*$/;
const SUMMARY = /^.*\b\d+\s+(?:passed|failed|error|errors|skipped|xfailed|xpassed|deselected|warning|warnings|rerun|reruns)\b.*$/i;

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;

export function buildPytestArgs(config: RepoConfig, tests: string[], extra: string[] = []): string[] {
	return [...tests, "-q", "--no-header", "--tb=short", "-p", "no:cacheprovider", ...extra];
}

export async function runPytest(
	exec: ExecFn,
	config: RepoConfig,
	tests: string[],
	signal?: AbortSignal,
): Promise<RunOutcome> {
	const [bin, ...prefix] = config.runner;
	const args = [...prefix, ...buildPytestArgs(config, tests)];
	const command = [bin, ...args].join(" ");
	const run = await exec(bin, args, { cwd: config.root, timeout: 900_000, signal });
	return { exitCode: run.code, stdout: run.stdout ?? "", stderr: run.stderr ?? "", command };
}

function strip(raw: string): string {
	return raw.replace(ANSI, "").replace(EXIT_LINE, "").trimEnd();
}

function findSummary(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		// pytest sometimes wraps the summary in a `=== ... ===` banner.
		const line = lines[i].trim().replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim();
		if (!line || line.startsWith("=")) continue;
		if (SUMMARY.test(line)) return line;
	}
	return undefined;
}

/** Any pytest banner line, e.g. `=== short test summary info ===` or `=== 1 failed in 0.1s ===`. */
const BANNER = /^=+[^=]*=+\s*$/;

/** Capture a `=== HEADING ===` section, stopping at the next banner line. */
function sectionBetween(text: string, startMarker: RegExp, endMarkers: RegExp[]): string | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => startMarker.test(line));
	if (start < 0) return undefined;
	const out: string[] = [lines[start]];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (BANNER.test(line) || endMarkers.some((marker) => marker.test(line))) break;
		out.push(line);
	}
	return out.join("\n").trimEnd();
}

/**
 * Reduce pytest output to what the model needs: a pass completion line, or the
 * failure digest. Everything else (progress dots, warnings, passing details) is
 * dropped so a green run costs a handful of tokens.
 */
export function filterPytestOutput(raw: string, exitCode: number, tests?: string[]): string {
	if (!raw.trim()) {
		if (exitCode === 0) return "OK · no output";
		return `FAILED · pytest exited with code ${exitCode} and produced no output.`;
	}

	const text = strip(raw);
	const lines = text.split("\n");
	const summary = findSummary(lines);

	if (exitCode === 5) return `NO TESTS · ${summary ?? "pytest collected nothing"}`;
	if (exitCode === 4) return `USAGE ERROR · ${summary ?? text.slice(0, 400)}`;

	if (exitCode === 0) {
		if (!summary) {
			// Introspection runs (`--collect-only`, `--markers`) have no summary line;
			// keep their output instead of reporting a meaningless "clean" result.
			return truncateHead(text, { maxLines: 60, maxBytes: 8_000 }).content;
		}
		const head = `PASS · ${summary}`;
		if (!tests || tests.length === 0) return head;
		const shown = tests.slice(0, 6).map((t) => t.split("/").pop() ?? t);
		const more = tests.length > shown.length ? ` (+${tests.length - shown.length} more)` : "";
		return `${head}\nran ${tests.length} file(s): ${shown.join(", ")}${more}`;
	}

	const parts: string[] = [summary ? `FAIL · ${summary}` : `FAIL · pytest exited with code ${exitCode}`];

	const shortSummary = sectionBetween(text, /^=+\s*short test summary info\s*=+$/, [
		/^=+\s*warnings summary\s*=+$/,
	]);
	if (shortSummary) {
		// Drop a trailing copy of the summary line when pytest repeats it inside the section.
		const cleaned = shortSummary
			.split("\n")
			.filter((line, index, all) => !(index >= all.length - 2 && summary !== undefined && line.trim() === summary))
			.join("\n")
			.trimEnd();
		if (cleaned) parts.push("", cleaned);
	}

	const body = sectionBetween(text, /^=+\s*(?:FAILURES|ERRORS)\s*=+$/, [
		/^=+\s*short test summary info\s*=+$/,
		/^=+\s*warnings summary\s*=+$/,
	]);
	if (body) {
		const trimmed = truncateHead(body, { maxLines: Math.min(DEFAULT_MAX_LINES, 120), maxBytes: Math.min(DEFAULT_MAX_BYTES, 12_000) });
		parts.push("", trimmed.content);
		if (trimmed.truncated) parts.push(`\n[traceback truncated: ${trimmed.outputLines}/${trimmed.totalLines} lines]`);
	} else if (!shortSummary) {
		parts.push("", truncateHead(text, { maxLines: 40, maxBytes: 6_000 }).content);
	}

	return parts.join("\n");
}

/** Strip the exit-code line pi appends so the filter can see raw pytest output. */
export function exitCodeFromBashOutput(raw: string): number | undefined {
	const match = raw.match(/Command exited with code (\d+)\s*$/);
	if (match) return Number(match[1]);
	if (/Command aborted/.test(raw)) return 130;
	if (/Command timed out/.test(raw)) return 124;
	return undefined;
}

export { strip };
