import type { RepoConfig } from "./types.ts";

export interface PytestCall {
	isPytest: boolean;
	/** True when the invocation would run the whole suite. */
	full: boolean;
	targets: string[];
	allowed: boolean;
	/** Introspection flags (`--collect-only`, `--version`, `--markers`, ...) — never worth blocking or trimming. */
	informational: boolean;
}

const PYTEST_INVOKE = /\b(?:uv\s+run\s+)?(?:[\w./-]*python[\w.]*\s+-m\s+)?(pytest|py\.test)\b/;
const VALUE_FLAGS = new Set(["-k", "-m", "--deselect", "-p", "--tb", "-W", "--maxfail", "-n", "-o", "-c", "--rootdir", "--timeout", "-r", "--junitxml", "--pythonwarnings"]);
const INFORMATIONAL_FLAGS = ["--collect-only", "--co", "--version", "-V", "--markers", "--fixtures", "--help", "-h", "--list-tests"];
const NARROWING_FLAGS = ["--lf", "--last-failed", "--ff", "--failed-first", "--stepwise", "-x", "--exitfirst"];

function splitSegments(command: string): string[] {
	return command
		.split(/\n+|&&|\|\||;|\|/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

function normalizePath(target: string, root: string): string {
	let value = target.trim().replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
	if (value.startsWith(root)) value = value.slice(root.length).replace(/^\//, "");
	return value;
}

/**
 * Decide whether a bash command is a pytest run, and whether it would run the
 * whole suite. Full-suite runs are the thing this extension exists to prevent.
 */
export function classifyPytest(command: string, config: RepoConfig): PytestCall {
	const segments = splitSegments(command);
	let isPytest = false;
	let full = false;
	let informational = false;
	const targets: string[] = [];

	for (const segment of segments) {
		const match = segment.match(PYTEST_INVOKE);
		if (!match || match.index === undefined) continue;
		isPytest = true;

		const rest = segment.slice(match.index + match[0].length);
		const tokens: string[] = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
		informational = informational || INFORMATIONAL_FLAGS.some((flag) => tokens.includes(flag));
		const found: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.startsWith("-")) {
				if (VALUE_FLAGS.has(token)) i++;
				continue;
			}
			found.push(token);
		}

		const narrowing =
		NARROWING_FLAGS.some((flag) => tokens.includes(flag)) || tokens.some((t) => t.startsWith("-k") || t.startsWith("-m"));
		const narrowedTargets = found.map((target) => normalizePath(target, config.root));
		targets.push(...narrowedTargets);

		if (narrowing || informational) continue;

		const effective = narrowedTargets.length > 0 ? narrowedTargets : [""];
		const allWholeSuite = effective.every((target) => {
			if (target === "" || target === ".") return true;
			return config.testDirs.includes(target);
		});
		if (allWholeSuite) full = true;
	}

	const override = new RegExp(`\\b${config.allowFullEnv}\\s*=\\s*(?:1|true)\\b`).test(command) || process.env[config.allowFullEnv] === "1" || process.env[config.allowFullEnv] === "true";

	return { isPytest, full, targets, allowed: !full || override, informational };
}

export function blockReason(config: RepoConfig, targets: string[]): string {
	const shown = targets.length > 0 ? targets.join(", ") : "(no path arguments)";
	return [
		`Full-suite pytest runs are discouraged: this repo has a targeted runner that only executes tests affected by the current change set.`,
		`Blocked target(s): ${shown}.`,
		`Use the run_tests tool instead (it derives the affected tests from git changes and files edited in this session).`,
		`To run specific tests with bash, name them: e.g. "${config.runner.join(" ")} tests/test_x.py -q".`,
		`If a complete run is genuinely required, set ${config.allowFullEnv}=1 in the command.`,
	].join(" ");
}
