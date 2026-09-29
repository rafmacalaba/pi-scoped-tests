# pi-scoped-tests

A [pi](https://pi.dev) extension that runs **only the pytest tests your change touches**, and returns **only what matters**.

A full pytest run on a large repo is slow and floods the model context with passing-test noise. This extension derives the affected tests from your git changes plus the files edited this session, runs just those, and reports a one-line completion on green or a compact failure digest on red.

## Install

```bash
pi install npm:pi-scoped-tests
```

Try it without installing:

```bash
pi -e npm:pi-scoped-tests
```

## What it adds

| Capability | Description |
|---|---|
| `run_tests` tool | Selects tests from git changes + session edits, runs them, returns terse output. |
| bash guard | Blocks whole-suite `pytest` invocations and redirects to `run_tests`. |
| Output filter | Rewrites targeted pytest output to failures + completion line only. |
| `/prune-tests` command | Report-only suite hygiene: stale, always-skipped, duplicate, and mergeable tests. |
| Prompt policy | Teaches the agent to prefer scoped runs over full-suite runs. |

## Tool: `run_tests`

| Parameter | Meaning |
|---|---|
| `files` | Changed files to consider. Default: git working-tree changes plus files edited this session. |
| `tests` | Explicit test files or node ids. Overrides automatic selection. |
| `base` | Git ref to also diff against, e.g. `main` or `HEAD~3`. |
| `all` | Run every test file. Only when the user explicitly asks; discouraged. |
| `args` | Extra pytest flags, e.g. `["-x", "--tb=long"]`. |

On green it returns the completion line. On failure it returns a digest. When nothing is selected it says why, and notes that adding a test is only worth it if the change introduces behaviour worth locking in.

## When it activates

The extension is a no-op outside a pytest project. It activates when the repo root has a `tests/` or `test/` directory, or top-level `test_*.py` files. Repos often keep experiment scripts named `test_v25_*` that run models — only files under a configured test directory count as suite members.

## Configure

Drop a `.pi/targeted-tests.json` in the repo root:

```json
{
  "testDirs": ["tests", "integration_tests"],
  "runner": [".venv/bin/python", "-m", "pytest"],
  "python": ".venv/bin/python",
  "allowFullEnv": "PI_ALLOW_FULL_TESTS",
  "scanExclude": ["node_modules", ".venv", "build"],
  "enabled": true
}
```

All fields are optional. Set `enabled: false` to disable the extension for a repo.

Set `PI_ALLOW_FULL_TESTS=1` to permit full-suite invocations for one session.

## Development

```bash
npm install
npm run typecheck
pi -e .
```

Pi loads TypeScript extensions directly via [jiti](https://github.com/unjs/jiti) — no build step.

## Security

Pi extensions run inside the pi process with your operating-system permissions and can inspect prompts, tool calls, files, and session history. Review the source before installing any third-party package.

## License

MIT
