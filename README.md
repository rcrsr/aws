# AWS

Portable AWS operations for Claude Code: stack discovery, SSO-aware identity, live role resolution, and a guardrail that blocks dangerous `aws` commands before they run.

## Why this plugin?

Operate your AWS infrastructure by talking to Claude Code. Ask "what's wrong in prod?", "tail the etl logs", or "trigger the nightly job", and the plugin maps your stack, resolves live resources, and runs the right `aws` commands, with guardrails that stop the dangerous ones before they execute.

**Guardrailed by default.** A PreToolUse hook classifies every `aws` command and blocks destructive ones (delete, terminate, policy writes, scale-to-zero) unless you explicitly opt in. Unrecognized verbs fail safe toward "mutating".

**Profile pinning.** Every `aws` command must carry an explicit `--profile` from your allowed set. No ambient credentials, no accidental prod hits.

**Id-free architecture map.** Discovery writes a committed, deploy-portable cheat sheet (`.claude/aws-stack.md`) that carries services, environments, and role handles, never concrete ARNs, resource ids, or account numbers. Those resolve live, on demand.

**SSO-aware.** Identity and session checks tell you exactly which `aws sso login` to run when a session expires.

**No npm dependencies.** Pure ESM, `node:` builtins only. No `npm install`, no build step. The one external requirement is the AWS CLI v2 (see Requirements).

## How it works

The plugin ships a single CLI dispatcher (`scripts/awsx.mjs`) that skills and agents shell out to. The live AWS account is authoritative for every call; the committed document is only an abstract map.

| Component | Role |
|-----------|------|
| `awsx.mjs` | CLI dispatcher. Routes subcommands, prints the exact `aws` command before live calls, maps errors to exit codes. |
| `lib/awscli.mjs` | Only module that spawns the real `aws` binary. Normalizes failures into typed `AwsError` codes. |
| `lib/profiles.mjs` | Reads/writes the git-ignored env→{profile, region} map. Source of truth for allowed profiles. |
| `lib/discover.mjs` | Queries CloudFormation + Resource Groups Tagging API, mines the repo for hints, builds the id-free model. |
| `lib/resolve.mjs` | Resolves one role to its live ARN/id via exactly one targeted query. Nothing cached. |
| `lib/stackdoc.mjs` | Renders/parses `.claude/aws-stack.md` (round-trips). |
| `lib/guard.mjs` | The PreToolUse policy: classify, then allow or block. |

**Two persistent artifacts** (written into your repo, never the plugin dir):

1. `.claude/aws-stack.md` — committed, id-free architecture cheat sheet. Hand-edited descriptions and the architecture narrative survive re-runs.
2. `.claude/aws-profiles.local.json` — git-ignored env→profile map.

## Requirements

| Requirement | Notes |
|-------------|-------|
| AWS CLI v2 | Required. The plugin shells out to the `aws` binary on your `PATH`; it does not bundle an SDK. Commands fail with exit code `1` (`CLI_MISSING`) when `aws` is absent. |
| Node.js 18+ | Required. The CLI is ESM using only `node:` builtins. |
| AWS SSO profiles | Configured in `~/.aws/config`. Map each to a logical environment with `awsx profiles set`. |

Install the AWS CLI v2 from the [official guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then verify:

```bash
aws --version   # expect: aws-cli/2.x.x ...
```

## Installation

```bash
# Load locally
claude --plugin-dir /path/to/aws

# Or install from a marketplace
/plugin marketplace add <owner>/<marketplace-repo>
/plugin install aws@<marketplace>
```

## Quick Start

```bash
# 1. Map a logical environment to an AWS profile + region
node scripts/awsx.mjs profiles set prod my-sso-profile us-west-2

# 2. Confirm the SSO session is valid
node scripts/awsx.mjs whoami --env prod

# 3. Discover the stack and write .claude/aws-stack.md
node scripts/awsx.mjs discover --env prod
```

Then drive it through skills in conversation, e.g. "what's wrong in AWS prod?", "tail the logs for the etl role", "summarize this month's spend".

## CLI

Run the dispatcher from the **consumer repo root** (not the plugin directory):

| Command | Description |
|---------|-------------|
| `awsx whoami --env <e>` | Validate SSO and print account / arn / userId. |
| `awsx discover --env <e> [--check]` | Build `.claude/aws-stack.md`; `--check` diffs without writing. |
| `awsx resolve <role> --env <e> [--json]` | Resolve a role to its current live ARN/id. |
| `awsx profiles list` | List configured env → profile / region. |
| `awsx profiles set <env> <profile> <region>` | Add or overwrite an env entry. |
| `awsx guard` | PreToolUse hook entrypoint (stdin-driven; runs automatically). |

**Exit codes:** `0` success, `1` drift/failure, `2` guard block, `3` expired SSO (run `aws sso login`), `4` usage error.

## The Guard

`hooks/hooks.json` runs `awsx guard` on every Bash call. Non-`aws` commands always pass. Each `aws` command is classified into a tier:

| Tier | Meaning | Examples |
|------|---------|----------|
| `0` | Read-only | `describe-*`, `list-*`, `get-*`, `tail`, `s3 ls` |
| `1` | Low mutate | `invoke`, `run-task`, `s3 cp`/`sync`, `create-*`, `update-*` |
| `2` | Destructive | `delete-*`, `terminate-*`, `rb`, `*-policy` writes, scale-to-zero (`--desired-count 0`) |

`decide()` **blocks** when:

- the `aws` command has no `--profile` (profile pinning required),
- the `--profile` is not in your allowed set, or
- the command is tier-2 destructive.

To run a tier-2 command, set `AWSX_ALLOW_DESTRUCTIVE=1`. When in doubt about whether a verb mutates, the guard classifies up. The hook never throws: on any internal error it allows rather than wedging your session.

## Skills

| Skill | Description |
|-------|-------------|
| `discover` | Derive the project architecture from the live deployment; write/refresh the stack map and env→profile map. |
| `whoami` | Show current AWS identity, account, region, and SSO status for an environment. |
| `cost` | Summarize spend by service and tag via Cost Explorer. |
| `logs` | Tail or search CloudWatch Logs for a discovered role. |
| `ecs` | Inspect ECS Fargate services and tasks; fetch stopped-task reasons. |
| `trigger` | Invoke a discovered Lambda or run an ECS task (tier-1; requires confirmation). |
| `security-review` | Read-only exposure scan: public S3, permissive security groups, broad IAM. |
| `report-anomalies` | Read-only cross-dimension health/risk sweep with a ranked report. |
| `tagger` | Add `aws-agent-meta` tags to IaC so discovery groups resources by logical role. |

## Agents

| Agent | Description |
|-------|-------------|
| `diagnostician` | Root-cause a failed deploy, ETL run, or incident across CloudFormation, ECS, Lambda, and CloudWatch (read-only). |
| `cost-analyst` | Investigate cost spikes; attribute spend deltas in USD against the prior period. |
| `security-auditor` | Read-only IAM / S3 / security-group exposure audit with ranked findings and remediation. |
| `cdk-engineer` | Edit AWS CDK source across TS/JS/Python/Java/C#/Go. Never deploys. |

## Development

```bash
# Run the test suite (node builtins only, no deps)
node --test scripts/awsx.test.mjs
```

The CLI is pure ESM; there is no build step and no `package.json`. Skills invoke it as
`node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs ...`.

## The Abstraction Invariant

Discovery must produce a deploy-portable, **id-free** model. Concrete names are abstracted into stable handles: random / UUID / Secrets-Manager / CloudFormation-hash suffixes are stripped and env tokens (prod/dev/staging) dropped. Resources sharing a project tag collapse into ONE logical role, preferring the plugin-owned `aws-agent-meta=<component>` tag, then project-identity tags, then `Name`/path tags, then logical id, then a name pattern.

If you extend the model, keep every field id-free and ensure `stackdoc.mjs` still round-trips (a test enforces this).

## License

MIT
