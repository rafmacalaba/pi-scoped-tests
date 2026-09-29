import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { isTestFile } from "./config.ts";
import { moduleNameFromRel, type ScanService } from "./scan.ts";
import type { RepoConfig, RepoIndex, SelectionResult } from "./types.ts";

const MAX_ROUNDS = 8;

export function execGit(pi: { exec: (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult> }, root: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
	return pi.exec("git", ["-C", root, ...args], { cwd: root, timeout: 15_000, signal });
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Files changed in the working tree (unstaged, staged, untracked) and optionally
 * vs a base ref. Tooling directories and dot-directories are dropped: repos often
 * carry thousands of untracked agent/session artifacts that would otherwise make
 * "everything changed" and defeat the point of targeted selection.
 */
export async function gitChangedFiles(
	pi: Parameters<typeof execGit>[0],
	root: string,
	base?: string,
	exclude: string[] = [],
	signal?: AbortSignal,
): Promise<string[]> {
	const skip = new Set(exclude);
	const accept = (path: string): boolean => {
		if (!path || path.includes("//")) return false;
		const first = path.split("/")[0];
		return !(first.startsWith(".") || skip.has(first));
	};
	const found = new Set<string>();
	const collect = async (args: string[]) => {
		try {
			const run = await execGit(pi, root, args, signal);
			if (run.code === 0) for (const line of splitLines(run.stdout)) if (accept(line)) found.add(line);
		} catch {
			// Non-git or git failure: fall back to whatever we already have.
		}
	};
	await collect(["diff", "--name-only", "HEAD"]);
	await collect(["diff", "--cached", "--name-only"]);
	await collect(["ls-files", "--others", "--exclude-standard"]);
	if (base) await collect(["diff", "--name-only", base]);
	return [...found];
}

/** Modules to match for a changed source file: its own module plus its top-level package. */
function matchTargets(rel: string): string[] {
	const mod = moduleNameFromRel(rel);
	if (!mod) return [];
	const parts = mod.split(".");
	const targets = [mod];
	if (parts.length > 1) targets.push(parts[0]);
	return targets;
}

function nameTokens(rel: string): string[] {
	const base = rel.slice(0, -3).split("/").pop() ?? "";
	return [base];
}

function testKey(rel: string): string {
	const base = rel.split("/").pop() ?? "";
	return base.replace(/^test_/, "").replace(/\.py$/, "");
}

/** True when a test file's name plausibly mirrors the changed module's name. */
function namesMatch(testRel: string, changedRel: string): boolean {
	const key = testKey(testRel);
	if (!key) return false;
	for (const token of nameTokens(changedRel)) {
		if (token === key) return true;
		if (key.endsWith(`_${token}`)) return true;
		if (token.endsWith(`_${key}`)) return true;
		if (token.startsWith(`${key}_`)) return true;
		if (key.startsWith(`${token}_`)) return true;
	}
	return false;
}

/**
 * Build the transitive dependency closure of every test file, then pick the
 * tests whose dependencies include any module touched by the change set.
 */
export async function selectTests(opts: {
	pi: Parameters<typeof execGit>[0];
	config: RepoConfig;
	index: RepoIndex;
	scan: ScanService;
	changed: string[];
	signal?: AbortSignal;
}): Promise<SelectionResult> {
	const { config, index, scan, changed, signal } = opts;
	const reasons = new Map<string, string>();
	const selected = new Set<string>();

	const changedPy: string[] = [];
	const changedOther: string[] = [];

	for (const raw of changed) {
		const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
		if (!rel.endsWith(".py")) {
			changedOther.push(rel);
			continue;
		}
		changedPy.push(rel);
		if (isTestFile(rel, config)) {
			selected.add(rel);
			reasons.set(rel, "changed test file");
		}
	}

	// Expand scans from the test files outward until the dependency graph is closed.
	const scanned = new Map<string, string[]>();
	const graph = new Map<string, string[]>();
	let frontier = [...index.testFiles];
	let visited = new Set<string>();
	for (let round = 0; round < MAX_ROUNDS && frontier.length > 0; round++) {
		const batch = frontier.filter((rel) => !visited.has(rel));
		if (batch.length === 0) break;
		const scans = await scan.ensure(batch, signal);
		const next: string[] = [];
		for (const rel of batch) {
			visited.add(rel);
			const data = scans.get(rel);
			const imports = data?.imports ?? [];
			scanned.set(rel, imports);
			const deps: string[] = [];
			for (const mod of imports) {
				const dep = resolveModule(mod, index);
				if (dep && dep !== rel) deps.push(dep);
			}
			graph.set(rel, deps);
			for (const dep of deps) if (!visited.has(dep)) next.push(dep);
		}
		frontier = next;
	}

	const closureCache = new Map<string, Set<string>>();
	const closureOf = (start: string): Set<string> => {
		const cached = closureCache.get(start);
		if (cached) return cached;
		const modules = new Set<string>();
		const queue = [start];
		const seen = new Set<string>();
		while (queue.length > 0 && seen.size < 2000) {
			const rel = queue.shift() as string;
			if (seen.has(rel)) continue;
			seen.add(rel);
			const mod = moduleNameFromRel(rel);
			if (mod) modules.add(mod);
			for (const dep of graph.get(rel) ?? []) if (!seen.has(dep)) queue.push(dep);
		}
		closureCache.set(start, modules);
		return modules;
	};

	for (const changedRel of changedPy) {
		if (isTestFile(changedRel, config)) continue;
		const targets = matchTargets(changedRel);
		if (targets.length === 0) continue;
		for (const testRel of index.testFiles) {
			if (selected.has(testRel)) continue;
			const closure = closureOf(testRel);
			const hit = targets.find((target) => closure.has(target));
			if (hit) {
				selected.add(testRel);
				reasons.set(testRel, `depends on ${hit}`);
				continue;
			}
			if (namesMatch(testRel, changedRel)) {
				selected.add(testRel);
				reasons.set(testRel, "name match");
			}
		}
	}

	const unmapped: string[] = [];
	for (const changedRel of changedPy) {
		if (isTestFile(changedRel, config)) continue;
		const targets = matchTargets(changedRel);
		const covered = [...selected].some((testRel) => {
			const reason = reasons.get(testRel) ?? "";
			return reason.startsWith("depends on") && targets.some((t) => reason.endsWith(t));
		});
		const named = [...selected].some((testRel) => namesMatch(testRel, changedRel));
		if (!covered && !named && targets.length > 0) unmapped.push(changedRel);
	}

	return {
		tests: [...selected].sort(),
		reasons,
		unmapped,
		changedPy,
		changedOther,
	};
}

function resolveModule(mod: string, index: RepoIndex): string | undefined {
	return index.moduleFiles.get(mod) ?? index.baseModules.get(mod.split(".").pop() ?? mod);
}
