# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A portable Claude Code **plugin** (not an app) named `aws`. It gives any consumer repo a
guardrailed, SSO-aware AWS operations layer: stack discovery, identity checks, live role
resolution, cost/log/ECS/security skills, and a PreToolUse hook that blocks dangerous `aws`
commands. The plugin ships agents (`agents/`), skills (`skills/`), a hook (`hooks/hooks.json`),
and one Node CLI (`scripts/awsx.mjs`).

## Commands

```bash
# Run the full test suite (node builtins only, no deps)
node --test scripts/awsx.test.mjs

# CLI dispatcher (run from the CONSUMER repo root, not the plugin dir)
node scripts/awsx.mjs whoami   --env <e>              # validate SSO + print identity
node scripts/awsx.mjs discover --env <e> [--check]    # build/diff .claude/aws-stack.md
node scripts/awsx.mjs resolve  <role> --env <e> [--json]  # role -> live arn/id (one query)
node scripts/awsx.mjs profiles list                   # list env -> profile/region
node scripts/awsx.mjs profiles set <env> <profile> <region>
```

There is no build step, no `package.json`, and no lint config. The CLI is pure ESM using only
`node:` builtins; skills shell out to it via `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs ...`.

Exit codes (see `EXIT` in `scripts/awsx.mjs`): `0` ok, `1` drift/fail, `2` guard block,
`3` expired SSO (caller must `aws sso login`), `4` usage error.

## Architecture

The CLI is a thin dispatcher (`scripts/awsx.mjs`) over single-purpose modules in `scripts/lib/`:

- `awscli.mjs` — only place that spawns the real `aws` binary (`spawnSync`, no SDK). Normalizes
  failures into `AwsError` with codes `EXPIRED | ACCESS_DENIED | NOT_FOUND | CLI_MISSING | UNKNOWN`.
  `checkSso()` returns `valid:false` rather than throwing for the expected expired/denied case.
- `profiles.mjs` — reads/writes the git-ignored env map at
  `.claude/aws-profiles.local.json` (`{ "<env>": { profile, region, regions? } }`). Source of
  truth for which environments exist and which profiles the guard allows.
- `discover.mjs` — builds the abstract stack model. **The live account is authoritative**: it
  queries CloudFormation + Resource Groups Tagging API across regions, and mines the repo only
  for hints (service names, env labels). `--check` diffs without writing.
- `resolve.mjs` — resolves one role's live ARN/id on demand via exactly one targeted query,
  dispatched by `handleType` (`tag` / `logicalId` / `namePattern`). Nothing cached.
- `stackdoc.mjs` — render/parse the committed `.claude/aws-stack.md`. `renderStackDoc` and
  `parseStackDoc` must round-trip (a test enforces this).
- `guard.mjs` — the PreToolUse policy (see below).
- `utils.mjs` — fs/path helpers. `paths()` resolves artifacts under the **consumer** repo
  (`CLAUDE_PROJECT_DIR` or cwd), never under the plugin dir.

### The two persistent artifacts (written into the consumer repo, never the plugin)

- `.claude/aws-stack.md` — committed, **id-free** architecture cheat sheet. Carries only services,
  env labels, and role→handle bindings. Concrete ARNs, resource ids, and account numbers NEVER
  appear here; they resolve live at call time. Hand-edited stack descriptions and the
  `architecture` prose block are preserved across `discover` re-runs.
- `.claude/aws-profiles.local.json` — git-ignored (see `.gitignore`) env→{profile,region} map.

### The abstraction invariant (most important design rule)

Discovery must produce a **deploy-portable, id-free** model. Concrete names are abstracted into
stable handles: random/UUID/Secrets-Manager/CFN-hash suffixes are stripped and env tokens
(prod/dev/staging) dropped (`nameToPattern`, `abstractRoleName` in `discover.mjs`). Resources are
grouped by `(service, handle)` so all tasks under one project tag collapse to ONE logical role.
The plugin-owned tag `aws-agent-meta=<component>` (written by the `tagger` skill) is the preferred
grouping key; project-identity tags, then Name/path tags, then logical id, then name pattern are
the fallbacks (`assignHandle`). If you add fields to the model, keep them id-free and ensure
`stackdoc.mjs` still round-trips.

### The guard (PreToolUse Bash hook)

`hooks/hooks.json` runs `awsx guard` on every Bash call. `guard.mjs` classifies a command into a
tier and applies policy. Two non-negotiable rules:

1. **Fail safe**: when unsure whether an `aws` command mutates, classify UP. Unrecognized verbs
   default to tier-1 (mutate), not tier-0.
2. **Be precise**: only `aws` commands are policed; everything else passes untouched.

Tiers: `0` read (describe/list/get/tail/...), `1` low-mutate (invoke/run-task/cp/sync/create/
update...), `2` destructive (delete/terminate/remove/rb, `*-policy` writes, and **scale-to-zero**
like `--desired-count 0`). `decide()` blocks: any `aws` command without `--profile`, any profile
not in the allowed set (from `profiles.mjs`), and all tier-2 unless `AWSX_ALLOW_DESTRUCTIVE=1`.
`runGuardHook()` must NEVER throw — on any internal error it allows rather than wedging the
session.

When changing classification regexes (`READ_VERB_RE`, `DESTRUCTIVE_VERB_RE`, `POLICY_WRITE_RE`,
`LOW_MUTATE_VERB_RE`) update the corresponding cases in `scripts/awsx.test.mjs`.

## Skills and agents

Skills (`skills/*/SKILL.md`) are the user-facing entry points: `discover`, `whoami`, `cost`,
`logs`, `ecs`, `trigger` (tier-1, requires confirmation), `security-review`, `report-anomalies`,
`tagger`. Each resolves live ids through the dispatcher (`awsx resolve <role> --env <e> --json`)
before running raw `aws`, and prints the exact `aws` command before live calls. Agents
(`agents/*.md`) are the heavier delegations: `diagnostician`, `cost-analyst`, `security-auditor`
(all read-only) and `cdk-engineer` (edits CDK source, never deploys).

When adding a skill, follow the existing pattern: pin `--profile`/`--region` via the env map,
resolve roles through `awsx`, never write concrete ids into committed files, and gate any mutation
behind explicit user confirmation.
