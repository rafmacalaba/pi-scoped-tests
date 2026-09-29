import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTestFile } from "./config.ts";
import type { FileScan, RepoConfig, RepoIndex } from "./types.ts";

const SCANNER_VERSION = 3;

/** Python AST scanner: dumps imports + test markers for an explicit file list. */
const SCANNER = String.raw`
import ast, json, os, sys

def module_name(rel):
    r = rel[:-3]
    if r.endswith("/__init__"):
        r = r[: -len("/__init__")]
    elif r == "__init__":
        r = ""
    return r.replace("/", ".")

def skip_expr(node):
    try:
        return ast.unparse(node)
    except Exception:
        return ""

def is_skipped(node):
    for d in node.decorator_list:
        s = skip_expr(d)
        if "skipif" in s or "skip(" in s or s.endswith(".skip"):
            return True
    for st in (node.body or [])[:2]:
        if not isinstance(st, (ast.Expr, ast.Raise, ast.Pass)):
            continue
        s = skip_expr(st)
        if "pytest.skip" in s or "unittest.skip" in s or "skipTest" in s or "SkipTest" in s:
            return True
    return False

def main():
    root = sys.argv[1]
    files = json.loads(sys.argv[2])
    out = []
    for rel in files:
        full = os.path.join(root, rel)
        try:
            with open(full, "rb") as fh:
                src = fh.read()
        except OSError:
            continue
        try:
            tree = ast.parse(src, filename=full)
        except SyntaxError:
            continue
        mod = module_name(rel)
        parts = [p for p in mod.split(".") if p]
        pkg_parts = parts if rel.endswith("__init__.py") else parts[:-1]
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name:
                        imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    base = list(pkg_parts)
                    up = node.level - 1
                    if up:
                        base = base[:-up] if len(base) >= up else []
                    if node.module:
                        base.append(node.module)
                    if base:
                        imports.add(".".join(base))
                elif node.module:
                    imports.add(node.module)
        tests, skipped, allskip = [], [], False
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "pytestmark" and "skip" in skip_expr(node.value):
                        allskip = True
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
                tests.append(node.name)
                if is_skipped(node):
                    skipped.append(node.name)
        out.append({
            "p": rel,
            "i": sorted(imports),
            "t": tests,
            "s": skipped,
            "a": allskip or (len(tests) > 0 and len(skipped) == len(tests)),
        })
    sys.stdout.write(json.dumps(out))

main()
`;

export function moduleNameFromRel(rel: string): string {
	let r = rel.slice(0, -3);
	if (r.endsWith("/__init__")) r = r.slice(0, -"/__init__".length);
	else if (r === "__init__") r = "";
	return r.replace(/\//g, ".");
}

function walkPy(dir: string, root: string, exclude: Set<string>, out: string[]): void {
	let entries;
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const name = entry.name;
		const rel = dir ? `${dir}/${name}` : name;
		if (entry.isDirectory()) {
			if (exclude.has(name) || name.endsWith(".egg-info")) continue;
			walkPy(rel, root, exclude, out);
		} else if (entry.isFile() && name.endsWith(".py")) {
			out.push(rel);
		}
	}
}

/** Build the module index by listing files only (no parsing). */
export function buildRepoIndex(config: RepoConfig): RepoIndex {
	const exclude = new Set(config.scanExclude);
	const pyFiles: string[] = [];
	walkPy("", config.root, exclude, pyFiles);
	pyFiles.sort();

	const moduleFiles = new Map<string, string>();
	const baseModules = new Map<string, string>();
	for (const rel of pyFiles) {
		const mod = moduleNameFromRel(rel);
		if (mod && !moduleFiles.has(mod)) moduleFiles.set(mod, rel);
		const base = basename(rel, ".py");
		if (base !== "__init__" && !baseModules.has(base)) baseModules.set(base, rel);
	}

	return {
		pyFiles,
		testFiles: pyFiles.filter((rel) => isTestFile(rel, config)),
		moduleFiles,
		baseModules,
	};
}

interface CacheEntry {
	key: string;
	data: FileScan;
}

/**
 * Parses Python files on demand through the AST scanner and caches results by
 * mtime+size so repeated runs during a session stay cheap.
 */
export class ScanService {
	private cache = new Map<string, CacheEntry>();
	private scriptPath: string;

	constructor(
		private pi: ExtensionAPI,
		private config: RepoConfig,
		dataDir: string,
	) {
		this.scriptPath = join(dataDir, `scanner_v${SCANNER_VERSION}.py`);
		try {
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(this.scriptPath, SCANNER);
		} catch {
			// Scanner write failures fall through to the inline fallback below.
		}
	}

	private fileKey(rel: string): string | undefined {
		try {
			const stat = statSync(join(this.config.root, rel));
			return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	/** Ensure every listed file has a scan; returns the merged map. */
	async ensure(files: string[], signal?: AbortSignal): Promise<Map<string, FileScan>> {
		const result = new Map<string, FileScan>();
		const stale: string[] = [];
		for (const rel of files) {
			const key = this.fileKey(rel);
			if (key === undefined) continue;
			const hit = this.cache.get(rel);
			if (hit && hit.key === key) {
				result.set(rel, hit.data);
			} else {
				stale.push(rel);
			}
		}
		if (stale.length > 0) await this.scanBatch(stale, signal);
		for (const rel of files) {
			const hit = this.cache.get(rel);
			if (hit && !result.has(rel)) result.set(rel, hit.data);
		}
		return result;
	}

	private async scanBatch(files: string[], signal?: AbortSignal): Promise<void> {
		const fallback: FileScan = { imports: [], tests: [], skippedTests: [], allSkipped: false };
		if (!existsSync(this.scriptPath)) {
			for (const rel of files) this.cache.set(rel, { key: this.fileKey(rel) ?? "0", data: fallback });
			return;
		}
		// Chunk to stay inside argv limits.
		const chunks: string[][] = [];
		let current: string[] = [];
		let size = 0;
		for (const rel of files) {
			current.push(rel);
			size += rel.length + 4;
			if (size > 24000) {
				chunks.push(current);
				current = [];
				size = 0;
			}
		}
		if (current.length > 0) chunks.push(current);

		for (const chunk of chunks) {
			let parsed: Array<{ p: string; i: string[]; t: string[]; s: string[]; a: boolean }> = [];
			try {
				const run = await this.pi.exec(
					this.config.python,
					[this.scriptPath, this.config.root, JSON.stringify(chunk)],
					{ cwd: this.config.root, signal, timeout: 60_000 },
				);
				if (run.code === 0 && run.stdout.trim().length > 0) parsed = JSON.parse(run.stdout);
			} catch {
				parsed = [];
			}
			const seen = new Map(parsed.map((entry) => [entry.p, entry]));
			for (const rel of chunk) {
				const key = this.fileKey(rel) ?? "0";
				const entry = seen.get(rel);
				this.cache.set(rel, {
					key,
					data: entry
						? { imports: entry.i ?? [], tests: entry.t ?? [], skippedTests: entry.s ?? [], allSkipped: Boolean(entry.a) }
						: fallback,
				});
			}
		}
	}
}

export { dirname };
