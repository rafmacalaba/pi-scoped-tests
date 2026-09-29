import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTestFile, looksLikeTest } from "./config.ts";
import { moduleNameFromRel, type ScanService } from "./scan.ts";
import type { RepoConfig, RepoIndex } from "./types.ts";

const THIRD_PARTY_HINTS = new Set([
	"__future__", "os", "sys", "json", "re", "math", "time", "pathlib", "typing", "collections",
	"itertools", "functools", "dataclasses", "unittest", "pytest", "numpy", "torch", "tempfile",
	"shutil", "subprocess", "random", "string", "textwrap", "contextlib", "importlib", "io",
	"csv", "glob", "argparse", "logging", "copy", "types", "hashlib", "uuid", "warnings",
	"datetime", "abc", "enum", "csv", "gzip", "zipfile", "pickle", "ast", "inspect", "sqlite3",
]);

interface TestFileFacts {
	rel: string;
	tests: string[];
	skipped: string[];
	allSkipped: boolean;
	orphans: string[];
	imports: string[];
}

export interface HygieneReport {
	totalFiles: number;
	totalTests: number;
	orphans: Array<{ rel: string; modules: string[] }>;
	alwaysSkipped: Array<{ rel: string; tests: number; skipped: number }>;
	emptyFiles: string[];
	singleTestFiles: string[];
	duplicateNames: Array<{ name: string; files: string[] }>;
	mergeCandidates: Array<{ a: string; b: string; overlap: number }>;
	importGroups: Array<{ modules: string; files: string[] }>;
	/** Test-named files outside the suite (experiment scripts, legacy entry points). */
	outside: Array<{ rel: string; tests: number }>;
	reportPath: string;
}

function resolveInRepo(mod: string, index: RepoIndex): boolean {
	if (index.moduleFiles.has(mod)) return true;
	const tail = mod.split(".").pop() ?? mod;
	return index.baseModules.has(tail);
}

function isThirdParty(mod: string): boolean {
	return THIRD_PARTY_HINTS.has(mod.split(".")[0]);
}

export async function analyzeHygiene(opts: {
	pi: ExtensionAPI;
	config: RepoConfig;
	index: RepoIndex;
	scan: ScanService;
	outputPath: string;
	signal?: AbortSignal;
}): Promise<HygieneReport> {
	const { config, index, scan, outputPath, signal } = opts;
	const testFiles = index.pyFiles.filter((rel) => isTestFile(rel, config));
	const outsideCandidates = index.pyFiles.filter((rel) => !isTestFile(rel, config) && looksLikeTest(rel));
	const scans = await scan.ensure([...testFiles, ...outsideCandidates], signal);

	const facts: TestFileFacts[] = [];
	let totalTests = 0;

	for (const rel of testFiles) {
		const data = scans.get(rel);
		const tests = data?.tests ?? [];
		const skipped = data?.skippedTests ?? [];
		const allSkipped = Boolean(data?.allSkipped);
		const orphans = (data?.imports ?? []).filter((mod) => {
			if (isThirdParty(mod)) return false;
			if (resolveInRepo(mod, index)) return false;
			const top = mod.split(".")[0];
			return index.pyFiles.some((file) => file.startsWith(`${top}/`)) || index.moduleFiles.has(top);
		});
		totalTests += tests.length;
		facts.push({ rel, tests, skipped, allSkipped, orphans, imports: data?.imports ?? [] });
	}

	const orphans = facts.filter((f) => f.orphans.length > 0).map((f) => ({ rel: f.rel, modules: f.orphans }));
	const alwaysSkipped = facts
		.filter((f) => f.allSkipped || (f.tests.length > 0 && f.skipped.length === f.tests.length))
		.map((f) => ({ rel: f.rel, tests: f.tests.length, skipped: f.skipped.length || f.tests.length }));
	const emptyFiles = facts.filter((f) => f.tests.length === 0).map((f) => f.rel);
	const singleTestFiles = facts.filter((f) => f.tests.length === 1).map((f) => f.rel);

	const nameIndex = new Map<string, string[]>();
	for (const f of facts) {
		for (const name of f.tests) nameIndex.set(name, [...(nameIndex.get(name) ?? []), f.rel]);
	}
	const duplicateNames = [...nameIndex.entries()]
		.filter(([, files]) => files.length > 1)
		.map(([name, files]) => ({ name, files: [...new Set(files)] }))
		.sort((a, b) => b.files.length - a.files.length);

	const mergeCandidates: Array<{ a: string; b: string; overlap: number }> = [];
	for (let i = 0; i < facts.length; i++) {
		for (let j = i + 1; j < facts.length; j++) {
			const a = new Set(facts[i].tests);
			const b = new Set(facts[j].tests);
			if (a.size === 0 || b.size === 0) continue;
			let shared = 0;
			for (const name of a) if (b.has(name)) shared++;
			const jaccard = shared / (a.size + b.size - shared);
			if (jaccard >= 0.5) mergeCandidates.push({ a: facts[i].rel, b: facts[j].rel, overlap: Number(jaccard.toFixed(2)) });
		}
	}
	mergeCandidates.sort((x, y) => y.overlap - x.overlap);

	const importGroups: Array<{ modules: string; files: string[] }> = [];
	const byImports = new Map<string, string[]>();
	for (const f of facts) {
		const signature = f.imports.filter((mod) => !isThirdParty(mod)).sort().join(",");
		if (!signature) continue;
		byImports.set(signature, [...(byImports.get(signature) ?? []), f.rel]);
	}
	for (const [modules, files] of byImports) {
		if (files.length > 1) importGroups.push({ modules, files });
	}
	importGroups.sort((x, y) => y.files.length - x.files.length);

	const outside = outsideCandidates.map((rel) => ({ rel, tests: scans.get(rel)?.tests.length ?? 0 }));

	const report: HygieneReport = {
		totalFiles: testFiles.length,
		totalTests,
		orphans,
		alwaysSkipped,
		emptyFiles,
		singleTestFiles,
		duplicateNames: duplicateNames.slice(0, 40),
		mergeCandidates: mergeCandidates.slice(0, 40),
		importGroups: importGroups.slice(0, 20),
		outside,
		reportPath: outputPath,
	};

	writeFileSync(outputPath, renderMarkdown(report), "utf8");
	return report;
}

function renderMarkdown(report: HygieneReport): string {
	const lines: string[] = [];
	lines.push("# Test suite hygiene report", "");
	lines.push(`Generated by the \`targeted-tests\` extension.`, "");
	lines.push(`- Test files: **${report.totalFiles}**`);
	lines.push(`- Test functions: **${report.totalTests}**`);
	lines.push(`- Always skipped: **${report.alwaysSkipped.length}**`);
	lines.push(`- Unresolvable imports: **${report.orphans.length}**`);
	lines.push(`- Files with no tests: **${report.emptyFiles.length}**`);
	lines.push(`- Single-test files: **${report.singleTestFiles.length}**`);
	lines.push(`- Duplicate test names: **${report.duplicateNames.length}**`);
	lines.push(`- Merge candidates: **${report.mergeCandidates.length}**`);
	lines.push(`- Shared-import groups: **${report.importGroups.length}**`);
	lines.push(`- Test-named files outside the suite: **${report.outside.length}**`, "");

	const section = (title: string, body: string[], note?: string) => {
		lines.push(`## ${title}`, "");
		if (note) lines.push(`_${note}_`, "");
		if (body.length === 0) {
			lines.push("None.", "");
			return;
		}
		for (const line of body) lines.push(`- ${line}`);
		lines.push("");
	};

	section(
		"Stale: unresolvable imports",
		report.orphans.map((o) => `\`${o.rel}\` imports ${o.modules.map((m) => `\`${m}\``).join(", ")} — no matching module in the repo. Delete or repoint.`),
		"Candidates for deletion or repair.",
	);
	section(
		"Stale: always skipped",
		report.alwaysSkipped.map((s) => `\`${s.rel}\` — ${s.skipped}/${s.tests} tests skipped unconditionally.`),
		"Tests that never execute are coverage the suite does not actually have.",
	);
	section("Empty test files", report.emptyFiles.map((rel) => `\`${rel}\``), "No `test_*` functions at all.");
	section(
		"Duplicate test names across files",
		report.duplicateNames.map((d) => `\`${d.name}\` in ${d.files.map((f) => `\`${f}\``).join(", ")}`),
		"Same name in several files usually means copy-paste; confirm they assert different behaviour before merging.",
	);
	section(
		"Merge candidates",
		report.mergeCandidates.map((m) => `\`${m.a}\` ↔ \`${m.b}\` (test-name overlap ${m.overlap})`),
		"High overlap of test function names; consider merging into one module.",
	);
	section(
		"Shared import signatures",
		report.importGroups.map((g) => `${g.files.map((f) => `\`${f}\``).join(" + ")} — same repo imports (${g.modules})`),
		"Test files importing exactly the same project modules often belong in one file.",
	);
	section(
		"Test-named files outside the suite",
		report.outside.map((o) => `\`${o.rel}\` (${o.tests} test functions) — not collected as a regression test; rename if it is an experiment script.`),
		"These match pytest naming but live outside the configured test directory, so a directory-wide run can pick up scripts that launch models or paid calls.",
	);
	section("Single-test files", report.singleTestFiles.map((rel) => `\`${rel}\``), "Candidates to fold into a neighbouring module.");
	return lines.join("\n");
}

export function ensureOutputDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {
		// Best effort: report writing is not fatal.
	}
}

export { join };
