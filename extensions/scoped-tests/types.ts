/** Shared shapes for the targeted-tests extension. */

/** Parsed facts about one Python file, produced by the AST scanner. */
export interface FileScan {
	/** Dotted module names this file imports (relative imports already resolved). */
	imports: string[];
	/** Top-level `test_*` function names. */
	tests: string[];
	/** Subset of `tests` carrying an unconditional skip marker. */
	skippedTests: string[];
	/** True when every test in the file is skipped, or a module-level skip marker exists. */
	allSkipped: boolean;
}

/** Resolved per-repo configuration (auto-detected, overridable). */
export interface RepoConfig {
	root: string;
	testDirs: string[];
	/** Command prefix used to invoke pytest, e.g. ["/repo/.venv/bin/python", "-m", "pytest"]. */
	runner: string[];
	/** Interpreter used for the AST scanner. */
	python: string;
	/** Env var name that unlocks a full-suite bash run. */
	allowFullEnv: string;
	enabled: boolean;
	scanExclude: string[];
}

/** Static view of the repo's Python files, built without reading file contents. */
export interface RepoIndex {
	pyFiles: string[];
	testFiles: string[];
	/** Dotted module -> file, e.g. "data_use.chunk" -> "data_use/chunk.py". */
	moduleFiles: Map<string, string>;
	/** Basename -> file, e.g. "doctrine_store" -> "training/doctrine_store.py". */
	baseModules: Map<string, string>;
}

export interface SelectionResult {
	tests: string[];
	reasons: Map<string, string>;
	/** Changed Python modules no test depends on. */
	unmapped: string[];
	changedPy: string[];
	changedOther: string[];
}

export interface RunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	command: string;
}
