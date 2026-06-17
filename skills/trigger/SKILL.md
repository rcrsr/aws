---
name: trigger
description: >
  Invoke a discovered Lambda function or run a discovered ECS task by logical
  role (Tier 1 mutation). Use when the user wants to trigger an ETL run,
  invoke a Lambda function, or kick off an ECS job. Requires explicit user
  confirmation before any mutation runs.
allowed-tools: Read, Bash, AskUserQuestion
---

# Trigger Lambda or ECS Task

Invoke a Lambda function or launch an ECS task for a named logical role in a target environment. This is a Tier 1 mutation: build the exact command, print it, confirm once with the user, then execute.

## Instructions

1. **Confirm SSO is valid.** Determine the target environment from the user's request. Run:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs whoami --env <env>
   ```

   Print the exact command before running it. If `ssoValid` is `false` or the call returns an auth error, stop and instruct the user to run:

   ```
   aws sso login --profile <profile>
   ```

   Do NOT attempt a silent login. Wait for the user to confirm they have re-authenticated before continuing.

2. **Resolve the logical role.** Read `.claude/aws-stack.md` to identify the correct role name for what the user wants to trigger. Then resolve it to a live resource ID. Run:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve <role> --env <env> --json
   ```

   Print the exact command before running it. Parse the JSON output for:
   - `type` — `lambda` or `ecs-task`
   - `id` — function name/ARN (Lambda) or task definition family (ECS)
   - `cluster` — cluster ARN (ECS only)
   - `subnets`, `securityGroups` — network config (ECS only)
   - `profile` — AWS CLI profile to use
   - `region` — target region

3. **Build the exact AWS command.** Construct the full command from the resolved values.

   For Lambda:

   ```
   aws lambda invoke \
     --function-name <id> \
     --payload '{}' \
     --cli-binary-format raw-in-base64-out \
     --log-type Tail \
     --profile <profile> \
     --region <region> \
     /tmp/lambda-response.json
   ```

   For ECS run-task:

   ```
   aws ecs run-task \
     --cluster <cluster> \
     --task-definition <id> \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[<subnets>],securityGroups=[<securityGroups>],assignPublicIp=DISABLED}" \
     --profile <profile> \
     --region <region>
   ```

   Substitute the user's payload or overrides if they provided any.

4. **Print the command and ask for confirmation ONCE.** Display the exact command you are about to run and ask:

   > The above command will mutate AWS (Tier 1). Run it? (yes/no)

   Do not proceed until the user replies with an affirmative. If the user declines, stop and confirm you have not run anything.

5. **Execute and report the result.** Run the confirmed command. Then report:
   - **Lambda:** HTTP status code from the response JSON, `FunctionError` field if present, and the decoded `LogResult` tail (last 10 lines).
   - **ECS:** The `taskArn` from `tasks[0].taskArn`, the `lastStatus`, and any `failures[]` entries.

   If the invocation succeeds, offer to tail logs via the logs skill:

   > Invocation succeeded. Would you like me to tail the logs for this function/task?

## Constraints

- Always pass `--profile` and `--region` on every raw `aws` command. Never rely on ambient credentials.
- Print every dispatcher command and every `aws` command before executing it.
- Ask for confirmation exactly once. Do not re-ask if the user has already confirmed.
- Never run Tier 2 (destructive) operations: no `delete-function`, `deregister-task-definition`, `update-service`, or `stop-task`.
- If `resolve` exits non-zero, report the error and stop. Do not attempt a fallback.
- If the SSO session expires mid-run, surface the `aws sso login` command and do not retry automatically.
- Do not write ARNs, account IDs, or concrete resource IDs to any committed file.
