---
name: logs
description: >
  Tail or search CloudWatch Logs for a discovered role (Lambda or ECS) in a given
  environment. Use when debugging errors, tailing live logs, or searching log history
  for an incident.
allowed-tools: Read, Bash
---

# CloudWatch Logs

Retrieve and summarize CloudWatch Logs for a service role in a target environment. Resolve the live log group via the dispatcher before running any AWS command.

## Instructions

1. Read `.claude/aws-stack.md` to identify the correct role name for the service the user is asking about (Lambda function name or ECS task family).

2. Resolve the role to a live log group and profile. Run:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve <role> --env <env> --json
   ```

   Parse the JSON output for `logGroup`, `profile`, and `region`.

3. Print the exact AWS command you are about to run before executing it.

4. For live tail (default when no search pattern is given), run:

   ```
   aws logs tail <logGroup> --follow --since 1h --profile <profile> --region <region>
   ```

   Stop after collecting enough output (30-60 lines) or when the user interrupts.

5. For log search (when the user provides a pattern or time range), run:

   ```
   aws logs filter-log-events \
     --log-group-name <logGroup> \
     --filter-pattern "<pattern>" \
     --start-time <epoch-ms> \
     --profile <profile> \
     --region <region>
   ```

   Use `--end-time` when the user specifies a closed window.

6. Summarize findings in plain language. Report: error count, first and last occurrence timestamps, and the 3 most representative log lines. Do not dump raw log output unfiltered.

## Constraints

- Always pass `--profile` and `--region` on every `aws` command; never rely on ambient credentials.
- Both `aws logs tail` and `aws logs filter-log-events` are read-tier. The PreToolUse guard hook classifies them automatically.
- If `resolve` returns a non-zero exit code, report the error and stop. Do not attempt a fallback profile.
- If the log group does not exist, tell the user and suggest running `awsx discover --env <env> --check` to refresh the stack map.
