/**
 * targeted-tests — run only the tests your change touches, and return only what matters.
 *
 * - `run_tests` tool: derives affected tests from git changes + files edited this
 *   session, runs them, and reports a one-line completion on green.
 * - Blocks full-suite `pytest` bash invocations and redirects to `run_tests`.
 * - Rewrites targeted pytest output to failures + completion only.
 * - `/prune-tests` command: report-only test-suite hygiene (stale, duplicate, mergeable).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	getAgentDir,
	isBashToolResult,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { detectRepoConfig, isTestFile, toRelative } from "./config.ts";
import { blockReason, classifyPytest } from "./guard.ts";
import { analyzeHygiene, ensureOutputDir } from "./hygiene.ts";
import { exitCodeFromBashOutput, filterPytestOutput, runPytest } from "./run.ts";
import { buildRepoIndex, ScanService } from "./scan.ts";
import { gitChangedFiles, selectTests } from "./select.ts";
import type { RepoConfig, RepoIndex } from "./types.ts";

const DATA_DIR = join(getAgentDir(), "targeted-tests");
const REPORTS_DIR = join(DATA_DIR, "reports");
const HYGIENE_ENTRY = "targeted-tests-hygiene";
/** Above this many changed files the working tree is too noisy to drive selection. */
const NOISY_TREE_LIMIT = 300;

interface SessionState {
	config: RepoConfig;
	index: RepoIndex;
	scan: ScanService;
	/** Files the agent mutated this session (catches untracked/gitignored edits). */
	touched: Set<string>;
}

const state: { current?: SessionState } = {};

const toolSchema = Type.Object({
	files: Type.Optional(
		Type.Array(Type.String({ description: "Changed files to consider. Default: git working-tree changes plus files edited in this session." })),
	),
	tests: Type.Optional(
		Type.Array(Type.String({ description: "Explicit test files or node ids to run. Overrides automatic selection." })),
	),
	base: Type.Optional(Type.String({ description: "Git ref to also diff against, e.g. main or HEAD~3." })),
	all: Type.Optional(
		Type.Boolean({ description: "Run every test file. Only set this when the user explicitly asks for a full run; it is discouraged." }),
	),
	args: Type.Optional(Type.Array(Type.String({ description: "Extra pytest flags, e.g. ['-x', '--tb=long']." }))),
});

type ToolParams = Static<typeof toolSchema>;

function loadState(pi: ExtensionAPI, ctx: ExtensionContext): SessionState | undefined {
	if (state.current) return state.current;
	const config = detectRepoConfig(ctx.cwd);
	if (!config || !config.enabled) return undefined;
	ensureOutputDir(DATA_DIR);
	state.current = {
		config,
		index: buildRepoIndex(config),
		scan: new ScanService(pi, config, DATA_DIR),
		touched: new Set<string>(),
	};
	return state.current;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_tests",
		label: "Run Related Tests",
		description:
			"Run only the pytest files affected by the current change set and return a terse result (completion line on success, failure digest on error). Never runs the whole suite unless `all` is set.",
		promptSnippet: "Run only tests related to current changes",
		promptGuidelines: [
			"Use run_tests to verify changes instead of invoking pytest through bash; it selects tests by dependency on changed files and reports only failures or completion.",
			"Only set run_tests `all: true` when the user explicitly asks for the full suite, because a full run costs many tokens.",
		],
		parameters: toolSchema,

		async execute(_toolCallId, params: ToolParams, signal, _onUpdate, ctx) {
			const session = loadState(pi, ctx);
			if (!session) {
				throw new Error("No pytest project detected here, so run_tests is inactive.");
			}
			const { config, index, scan } = session;

			try {
				if (params.all === true) {
					const tests = index.testFiles;
					const outcome = await runPytest(pi.exec, config, tests, signal);
					return {
						content: [{ type: "text", text: `FULL RUN (${tests.length} files)\n${filterPytestOutput(outcome.stdout || outcome.stderr, outcome.exitCode, tests)}` }],
						details: { mode: "all", tests, exitCode: outcome.exitCode, command: outcome.command },
					};
				}

				let tests: string[];
				let reasons: Map<string, string> | undefined;
				let note = "";

				if (params.tests && params.tests.length > 0) {
					tests = params.tests.map((t) => toRelative(t, config.root));
				} else {
					const gitFiles = params.files
						? params.files.map((f) => toRelative(f, config.root))
						: await gitChangedFiles(pi, config.root, params.base, config.scanExclude, signal);
					const touched = [...session.touched].map((p) => toRelative(p, config.root));
					// A bulk-changed tree would select the whole suite, so prefer what this
					// session touched when the working tree looks like a mass edit.
					const useGit = Boolean(params.files) || gitFiles.length <= NOISY_TREE_LIMIT || touched.length === 0;
					const merged = new Set<string>(useGit ? [...gitFiles, ...touched] : touched);
					if (merged.size === 0) {
						return {
							content: [{
								type: "text",
								text: "No changed files detected, so no tests were selected. Pass `files` or `tests` explicitly, or use git to make your changes visible.",
							}],
							details: { mode: "none", tests: [] },
						};
					}
					const selection = await selectTests({ pi, config, index, scan, changed: [...merged], signal });
					tests = selection.tests;
					reasons = selection.reasons;
					if (tests.length === 0) {
						const py = selection.changedPy.length;
						const other = selection.changedOther.length;
						const why = py === 0
							? `the ${other} changed file(s) are not Python`
							: `no test depends on: ${selection.unmapped.slice(0, 8).join(", ") || selection.changedPy.slice(0, 8).join(", ")}`;
						return {
							content: [{
								type: "text",
								text: `No tests selected — ${why}. Nothing to run; only add a new test if this change introduces behaviour that should be locked in.`,
							}],
							details: { mode: "empty", changedPy: selection.changedPy, changedOther: selection.changedOther, unmapped: selection.unmapped },
						};
					}
					const shown = tests.slice(0, 8).map((t) => `${t} (${reasons?.get(t) ?? "selected"})`);
					note = `selected ${tests.length}/${index.testFiles.length} test file(s)`;
					if (!useGit) note += ` (working tree has ${gitFiles.length} changed files; scoped to this session's edits)`;
					else if (tests.length > index.testFiles.length * 0.4) note += " (broad blast radius — change touches a widely imported module)";
					note += ` — ${shown.join("; ")}`;
					if (tests.length > 8) note += " …";
				}

				const outcome = await runPytest(pi.exec, config, tests, signal);
				const text = filterPytestOutput(outcome.stdout || outcome.stderr, outcome.exitCode, tests);
				return {
					content: [{ type: "text", text: note ? `${note}\n${text}` : text }],
					details: { mode: "selected", tests, reasons: reasons ? Object.fromEntries(reasons) : undefined, exitCode: outcome.exitCode, command: outcome.command },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`run_tests failed: ${message}`);
			}
		},

		renderCall(args, theme) {
			const parts: string[] = [];
			if (args.all) parts.push("all");
			if (args.tests?.length) parts.push(`${args.tests.length} explicit`);
			if (args.base) parts.push(`base=${args.base}`);
			return new Text(`${theme.fg("toolTitle", theme.bold("run_tests "))}${theme.fg("muted", parts.join(" ") || "changed")}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
			const first = text.split("\n")[0] ?? "";
			const failed = first.startsWith("FAIL") || first.startsWith("USAGE") || first.startsWith("NO TESTS");
			return new Text(failed ? theme.fg("error", first) : theme.fg("success", first), 0, 0);
		},
	});

	// Block whole-suite pytest runs; targeted ones are allowed and filtered later.
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const session = loadState(pi, ctx);
		if (!session) return undefined;

		const command = event.input.command as string;
		const call = classifyPytest(command, session.config);
		if (!call.isPytest) return undefined;
		if (call.allowed) return undefined;
		return { block: true, reason: blockReason(session.config, call.targets) };
	});

	// Track edits so selection works for untracked/gitignored files, and quiet pytest output.
	pi.on("tool_result", async (event, ctx) => {
		const session = loadState(pi, ctx);
		if (!session) return undefined;

		if (isEditToolResult(event) || isWriteToolResult(event)) {
			if (!event.isError) {
				const path = (event.input as { path?: unknown }).path;
				if (typeof path === "string") session.touched.add(resolve(session.config.root, path));
			}
			return undefined;
		}

		if (isBashToolResult(event)) {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const call = classifyPytest(command, session.config);
			if (!call.isPytest || call.informational) return undefined;
			const raw = event.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n");
			const exitCode = exitCodeFromBashOutput(raw) ?? (event.isError ? 1 : 0);
			return { content: [{ type: "text", text: filterPytestOutput(raw, exitCode, call.targets) }] };
		}
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!loadState(pi, ctx)) return undefined;
		const policy = [
			"",
			"## Targeted testing policy",
			"- Use the `run_tests` tool to verify changes; it runs only tests affected by the current change set.",
			"- Do not run the full pytest suite. Full-suite invocations are blocked and re-running everything wastes tokens.",
			"- Only pass `all: true` to `run_tests` when the user explicitly asks for a complete run.",
			"- Prefer adding a test only when a change introduces behaviour worth locking in; run `/prune-tests` before growing the suite.",
			"",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n${policy}` };
	});

	pi.registerCommand("prune-tests", {
		description: "Report-only test suite hygiene: stale, skipped, duplicate and mergeable tests",
		handler: async (args, ctx) => {
			const session = loadState(pi, ctx);
			if (!session) {
				ctx.ui.notify("No pytest project detected here.", "warning");
				return;
			}
			ensureOutputDir(REPORTS_DIR);
			const slug = session.config.root.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(-60) || "repo";
			const reportPath = join(REPORTS_DIR, `${slug}-hygiene.md`);
			const report = await analyzeHygiene({
				pi,
				config: session.config,
				index: session.index,
				scan: session.scan,
				outputPath: reportPath,
			});

			pi.appendEntry(HYGIENE_ENTRY, report);
			ctx.ui.notify(
				`${report.totalFiles} test files / ${report.totalTests} tests · stale ${report.orphans.length + report.alwaysSkipped.length} · mergeable ${report.mergeCandidates.length} · report: ${reportPath}`,
				"info",
			);
			if (args.trim().length > 0) ctx.ui.setEditorText(`Read ${reportPath} and propose the minimum set of test deletions/merges.`);
		},
	});

	pi.registerEntryRenderer(HYGIENE_ENTRY, (entry, { expanded }, theme) => {
		type Entry = { data?: { totalFiles?: number; totalTests?: number; orphans?: unknown[]; alwaysSkipped?: unknown[]; emptyFiles?: unknown[]; singleTestFiles?: unknown[]; duplicateNames?: unknown[]; mergeCandidates?: unknown[]; reportPath?: string } };
		const report = (entry as unknown as Entry).data ?? {};
		const lines: string[] = [
			`${theme.bold("Test hygiene")}: ${report.totalFiles ?? 0} files / ${report.totalTests ?? 0} tests`,
		];
		const stale = (report.orphans?.length ?? 0) + (report.alwaysSkipped?.length ?? 0);
		lines.push(theme.fg(stale > 0 ? "warning" : "dim", `stale ${stale} · empty ${report.emptyFiles?.length ?? 0} · dupes ${report.duplicateNames?.length ?? 0} · mergeable ${report.mergeCandidates?.length ?? 0}`));
		if (expanded) {
			for (const orphan of (report.orphans ?? []).slice(0, 10)) lines.push(theme.fg("dim", `  unresolvable: ${JSON.stringify(orphan)}`));
			for (const skipped of (report.alwaysSkipped ?? []).slice(0, 10)) lines.push(theme.fg("dim", `  always skipped: ${JSON.stringify(skipped)}`));
			for (const merge of (report.mergeCandidates ?? []).slice(0, 10)) lines.push(theme.fg("dim", `  merge: ${JSON.stringify(merge)}`));
			if (report.reportPath) lines.push(theme.fg("muted", `  report: ${report.reportPath}`));
		}
		return new Text(lines.join("\n"), 1, 1);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.current = undefined;
		if (existsSync(join(ctx.cwd, "tests")) || existsSync(join(ctx.cwd, "test"))) {
			loadState(pi, ctx);
		}
		try {
			mkdirSync(REPORTS_DIR, { recursive: true });
		} catch {
			// Non-fatal.
		}
	});
}
