---
name: whoami
description: >
  Show the current AWS identity, account, region, and SSO session status for a
  logical environment. Use when the user asks who is logged in, which account is
  active, or which profile is in use, or when any AWS command fails with an auth
  or credentials error.
allowed-tools: Bash
---

# AWS Whoami

Report the current AWS identity, account, region, profile, and SSO session validity for a named logical environment.

## Instructions

1. Determine the target environment. Accept it from the user's request (e.g. "prod", "staging", "dev"). If the user does not name one, ask for it before proceeding.

2. Run the dispatcher whoami subcommand. Print the exact command before executing it.

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs whoami --env <env>
   ```

3. Parse the JSON output and report these fields to the user in plain language:
   - `account` — AWS account ID
   - `arn` — caller ARN (role or user)
   - `region` — active region
   - `profile` — resolved AWS CLI profile name
   - `ssoValid` — whether the SSO session is currently valid (`true`/`false`)

4. If `ssoValid` is `false` or the command exits with an auth error, surface the exact login command the user must run. Do NOT attempt a silent login or run `aws sso login` yourself.

   Tell the user:

   > Your SSO session for profile **\<profile\>** has expired or is invalid.
   > Run the following command in your terminal to re-authenticate:
   >
   > ```
   > aws sso login --profile <profile>
   > ```
   >
   > You can run it from the Claude terminal with: `!aws sso login --profile <profile>`

5. If `ssoValid` is `true`, confirm the identity is valid and summarise the account, ARN, region, and profile in a single short response.

## Constraints

- Always pass `--env` to the dispatcher. Never call raw `aws sts get-caller-identity` directly from this skill.
- Never pass credentials or secrets as arguments.
- Never call `aws sso login` autonomously. Surface the command and let the user run it.
- Print every dispatcher command before executing it so the user can see what is running.
