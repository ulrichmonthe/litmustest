# Codex

**Status: untested.** The plugin ships manifests for OpenAI Codex, but nobody has installed it in Codex: `codex` is not installed where this was written. The manifests were checked on 2026-11-11 against Codex's published plugin documentation and the `openai/codex` source, and corrected where they disagreed. That is a reading of documents, not a run. The checklist at the end is what turns "untested" into "tested".

Claude Code is the supported target (`docs/DECISIONS.md` #5).

## What ships

```
.agents/plugins/marketplace.json     # the marketplace Codex discovers at the repo root
plugin/.codex-plugin/plugin.json     # the plugin manifest (Codex compatibility format)
plugin/skills/<name>/SKILL.md        # the same fourteen skills Claude Code uses
```

## What was wrong and what changed

| Was | Why it was wrong | Now |
| --- | --- | --- |
| The marketplace file sat at `plugin/.agents/plugins/marketplace.json` with `"path": "./plugin"` | Codex looks for `$REPO_ROOT/.agents/plugins/marketplace.json`, and resolves `source.path` against the marketplace root (the directory that holds `.agents/`), not against the file. Inside `plugin/` the path meant `plugin/plugin`, which does not exist, so the entry would be skipped. | Moved to `.agents/plugins/marketplace.json` at the repo root. The path stays `./plugin` and now resolves. |
| The manifest had no `skills` field | The docs say a Codex-format package with skills declares them: `"skills": "./skills/"`. (The source falls back to `skills/` when the field is absent, so it probably loaded anyway.) | `"skills": "./skills/"` |
| The manifest had no `interface` block | The docs mark `interface` as required for the Codex format: `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities`. (The source parses it as optional.) | Added, within the documented length limits. |
| The description said "UNTESTED on Codex until Phase 2" | Phase 2 passed without a test. | Says untested, pointing here. |

`tests/skills.test.ts` checks that these files agree with each other and with those rules: the path starts with `./`, stays inside the root and reaches a plugin manifest; the policy values are ones Codex accepts; the skills directory holds the fourteen skills; the listing fields fit their limits. It does not run Codex.

## What the documentation says, with sources

Read on 2026-11-11. The Codex plugin pages have moved more than once; these are where they resolved that day.

- **Marketplace location and path resolution.** "Codex resolves `source.path` relative to the marketplace root, not relative to the `.agents/plugins/` folder", and the path must start with `./` and stay inside that root. A repo marketplace lives at `$REPO_ROOT/.agents/plugins/marketplace.json`; `$REPO_ROOT/.claude-plugin/marketplace.json` is read as a legacy-compatible fallback. Source: developers.openai.com/plugins/build/plugins.
- **Marketplace entry.** `name`, `source` (`{ "source": "local", "path": "./..." }`), `policy.installation`, `policy.authentication`, `category`. Installation values named in the docs: `AVAILABLE`, `INSTALLED_BY_DEFAULT`, `NOT_AVAILABLE`. The authentication values (`ON_INSTALL`, `ON_USE`) appear only in the source (`codex-rs/core-plugins/src/marketplace.rs`), not in the docs.
- **Manifest fields.** For the Codex format: `name` (lowercase, digits, single hyphens, 64 characters at most), `version`, `description`, `author.name`, `skills`, `interface`. Source: developers.openai.com/plugins/deploy/submission.
- **Skills.** `SKILL.md` needs `name` and `description` in its frontmatter. In the Codex CLI a skill is invoked with `/skills` or by typing `$` and its name. Source: learn.chatgpt.com/docs/build-skills.
- **Install location.** Plugins are copied to `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and loaded from there.

Two things the documentation and the source disagree on, noted so nobody is surprised: whether `skills` and `interface` are needed for a local install (docs: yes; source: no), and the newer "portable" format (a `plugin.json` with `$schema` at the plugin root), which the docs now prefer. This repo keeps the `.codex-plugin/plugin.json` format, which the docs call a supported compatibility fallback.

## Known gaps before it can work well

- **The CLI is separate.** The skills call `litmustest`, which is not on npm yet. Without it on `PATH` every skill stops at its first command.
- **Skills point at files outside the plugin.** Several skills cite `docs/SCHEMAS.md`. Codex installs a copy of `plugin/` only, so that file is not there after install. The same is true of a Claude Code install. The skills should cite `litmustest validate` output or bundle what they need.
- **No icons.** The docs list `composerIcon` and `logo` as required for a Codex-format listing. They would have to live inside `plugin/`; the logos are in `brand/logos/`. Not added.
- **Not submitted anywhere.** The listing fields are filled for a local install, not reviewed for a public directory.
- **How Codex proposes a diff and runs a shell command** differs from Claude Code. The skills say "stop before a commit" and "show the diff"; whether Codex follows that the same way is exactly what a test run would show.

## Install, once someone tests it

From the documentation; none of these commands has been run here.

```bash
codex plugin marketplace add ulrichmonthe/litmustest
```

or, from a clone:

```bash
codex plugin marketplace add .
```

Then, in Codex, `/plugins`, install `litmustest`, and start a new session. Invoke a skill with `$evals-start` or pick it from `/skills`.

## Test checklist

Run in a copy of `examples/support-agent` with the built CLI on `PATH`. Record the Codex version and date beside each line.

- [ ] `codex plugin marketplace add .` from the repo root lists a marketplace named `litmustest` with one plugin.
- [ ] The plugin installs from `/plugins` with no warning about its manifest.
- [ ] All fourteen skills appear under `/skills` after a new session.
- [ ] `$evals-start` runs `litmustest doctor` (or `init`) and reports the repo's state.
- [ ] `$define-task` writes a task and a reference under `evals/`, runs `litmustest validate`, and stops without committing.
- [ ] `$analyze-run` runs `litmustest compare` and reports with intervals.
- [ ] No skill runs `litmustest label` or `litmustest dispute`, or writes a label file: labelling is human-only.
- [ ] A skill that cites `docs/SCHEMAS.md` still completes (see the gap above).

When every line is ticked, change "untested" in `README.md`, `CLAUDE.md`, `plugin/.codex-plugin/plugin.json` and `docs/DECISIONS.md` #5, and record the outcome there.
