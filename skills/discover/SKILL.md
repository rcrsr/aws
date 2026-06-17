---
name: discover
description: Derive the project AWS architecture from the live deployment and write or refresh .claude/aws-stack.md plus the env->profile map. Use when setting up the plugin in a repo, when the user asks what AWS resources a project uses, or to check for deployment drift.
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
model: sonnet
---

# Discover AWS Stack

Derive the abstract stack cheat sheet from the live AWS deployment. Write or refresh `.claude/aws-stack.md` and the env->profile map. Never write concrete resource IDs into any committed file.

## Instructions

1. **Confirm a profile mapping exists.**
   Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs profiles list`
   If the output is empty or the target environment has no entry, ask the user to supply the environment name, AWS SSO profile, and default region. Then run:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs profiles set <env> <profile> <region>`
   Confirm the entry appears in a second `profiles list` call before continuing.

2. **Verify SSO authentication.**
   Identify the environment to discover (use the first mapped env if the user did not specify).
   Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs whoami --env <env>`
   Print the exact command before running it.
   If authentication fails, instruct the user to run `aws sso login --profile <profile>` and wait for confirmation before proceeding.

3. **Run discovery.**
   Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs discover --env <env>`
   Print the exact command before running it.
   On the first run, the script proposes logical roles for each discovered resource group. Present the proposed roles to the user and ask for confirmation or relabeling. Once the user approves, re-run with any label flags the script accepts to persist the mapping.

   Discovery scans every region the account has enabled (via `account list-regions`, falling back to `ec2 describe-regions`), so a wrong primary-region guess never hides stacks. The env's primary region, any extra regions listed under the env's `regions` array in `aws-profiles.local.json`, and `us-east-1` are always included as a floor in case region enumeration is not permitted. NOTE: `resolve` still queries only the env's primary region, so when a stack lives elsewhere (e.g. a CloudFront/ACM frontend in `us-east-1`), set the primary region to where most resources live.

4. **Persist the stack cheat sheet.**
   Write or update `.claude/aws-stack.md` using only the abstract role names and resource types confirmed in step 3. Do not write ARNs, account IDs, or any concrete identifier into this file.
   The document opens with a `## Stacks` functional overview: one bullet per CloudFormation stack with a short description of what it does. Descriptions auto-seed from each stack's CloudFormation description (or a generic fallback). The renderer preserves any hand-edited description across re-runs and drift checks, so you may refine a stack's summary by editing its bullet in place. To improve the overview, edit the description after `**StackName**:` and keep the bullet format intact.

   **Infer descriptions from the repo when the auto-seed is generic.** Many stacks have a null CloudFormation `Description`, so the script writes the placeholder `Application stack discovered live.`. Whenever you see that placeholder (or an empty description) on any `## Stacks` bullet, do not leave it. Derive a one-line functional summary by reading the rest of the repo, in priority order:
   - IaC source that defines the stack (e.g. `infra/cdk/`, `cdk.out/*.template.json`, `serverless.yml`, `template.yaml`, `*.tf`). Match a stack to its source by name, then read which constructs it provisions.
   - Project docs: root `README.md`, `CLAUDE.md`, and any `docs/` architecture notes.
   - The `## Roles` table in the just-written document: the services tagged to each stack reveal its shape (e.g. `apigateway` + `lambda` + `logs` ⇒ backend API; `cloudfront` + `s3` ⇒ frontend CDN; `ecs` + `events` ⇒ scheduled task).

   Write each inferred summary into its bullet with `Edit`, preserving the `- **StackName**: <summary>` format. Name the primary resources and the role the stack plays. Keep descriptions abstract: no ARNs, ids, or account numbers.

   **Add an `## Architecture` section after `## Stacks`.** Once descriptions are accurate, write a short `## Architecture` section that explains how the stacks fit together at runtime: the request path (client → frontend → API → data store), the data path (schedulers/ETL → data store), shared resources (database, secrets), and observability/alerting wiring. Infer these relationships from the same repo sources and the roles table. A compact ASCII diagram plus 3-6 bullets is enough. This section is hand-authored content; the renderer leaves the file untouched on `--check` unless live roles drift, so the prose survives.

5. **Check for drift (subsequent runs).**
   When the user asks to refresh or verify the stack, run:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs discover --env <env> --check`
   Print the exact command before running it.
   Exit code 1 means drift was detected. Read the diff output and summarize which roles have changed, been added, or been removed. Offer to re-run discovery without `--check` to update the persisted map.

## Examples

**Initial setup:**

```
/discover
→ profiles list (empty)
→ Ask user: env name, profile, region
→ profiles set prod my-sso-profile us-west-2
→ whoami --env prod  (confirm identity)
→ discover --env prod  (propose roles)
→ User confirms labels
→ discover --env prod  (persist)
→ Write .claude/aws-stack.md with abstract roles
```

**Drift check:**

```
/discover
→ discover --env prod --check
→ Exit 1: summarize diff (e.g., "Lambda role api-handler replaced")
→ Offer to re-run without --check to update
```
