import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RepoConfig } from "./types.ts";

/** Directories never scanned for Python sources. */
const DEFAULT_EXCLUDE = [
	".git",
	".hg",
	".svn",
	".venv",
	"venv",
	"env",
	"mlx-env",
	"node_modules",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".eggs",
	"dist",
	"build",
	"site-packages",
	".codegraph",
	".omo",
	".senpi",
];

const CONFIG_FILE = "targeted-tests.json";

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findRepoRoot(start: string): string | undefined {
	let cur = resolve(start);
	for (let i = 0; i < 6; i++) {
		if (isDir(join(cur, ".git"))) return cur;
		const parent = resolve(cur, "..");
		if (parent === cur) break;
		cur = parent;
	}
	return undefined;
}

function hasTopLevelTests(root: string): boolean {
	try {
		return readdirSync(root).some((name) => name.startsWith("test_") && name.endsWith(".py"));
	} catch {
		return false;
	}
}

function readOverrides(root: string): Partial<RepoConfig> {
	const path = join(root, CONFIG_DIR_NAME, CONFIG_FILE);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<RepoConfig>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Detect a Python+pytest repo. Returns undefined when the cwd is not a pytest
 * project, which makes the extension a no-op instead of blocking unrelated work.
 */
export function detectRepoConfig(cwd: string): RepoConfig | undefined {
	const root = findRepoRoot(cwd) ?? resolve(cwd);
	const testDirs = ["tests", "test"].filter((dir) => isDir(join(root, dir)));
	if (testDirs.length === 0 && !hasTopLevelTests(root)) return undefined;

	const venvPython = join(root, ".venv", "bin", "python");
	const python = existsSync(venvPython) ? venvPython : "python3";

	const config: RepoConfig = {
		root,
		testDirs: testDirs.length > 0 ? testDirs : [""],
		runner: [python, "-m", "pytest"],
		python,
		allowFullEnv: "PI_ALLOW_FULL_TESTS",
		enabled: true,
		scanExclude: DEFAULT_EXCLUDE,
	};

	const overrides = readOverrides(root);
	if (overrides.enabled === false) return { ...config, enabled: false };
	if (Array.isArray(overrides.testDirs) && overrides.testDirs.length > 0) config.testDirs = overrides.testDirs;
	if (Array.isArray(overrides.runner) && overrides.runner.length > 0) config.runner = overrides.runner;
	if (typeof overrides.python === "string" && overrides.python.length > 0) config.python = overrides.python;
	if (typeof overrides.allowFullEnv === "string" && overrides.allowFullEnv.length > 0) config.allowFullEnv = overrides.allowFullEnv;
	if (Array.isArray(overrides.scanExclude) && overrides.scanExclude.length > 0) config.scanExclude = overrides.scanExclude;
	return config;
}

/** Name-based test heuristic, used only when the repo has no test directory. */
export function looksLikeTest(rel: string): boolean {
	const base = basename(rel);
	return base.startsWith("test_") || base.endsWith("_test.py");
}

/**
 * Membership in the real suite. A file only counts when it lives under a
 * configured test directory: repos keep experiment scripts named `test_v25_*`
 * that run models and must never be collected as regression tests.
 */
export function isTestFile(rel: string, config: RepoConfig): boolean {
	if (!rel.endsWith(".py")) return false;
	if (config.testDirs.some((dir) => dir.length > 0 && rel.startsWith(`${dir}/`))) return true;
	return config.testDirs.every((dir) => dir.length === 0) && looksLikeTest(rel);
}

export function toRelative(path: string, root: string): string {
	if (!path.includes("/") && !path.includes("\\")) return path;
	const abs = resolve(root, path);
	return abs.startsWith(root) ? abs.slice(root.length).replace(/^[/\\]/, "") : path;
}

export { DEFAULT_EXCLUDE };
