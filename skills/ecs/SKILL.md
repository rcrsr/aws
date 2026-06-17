---
name: ecs
description: >
  Inspect ECS Fargate services and tasks: list services, show task status, and
  fetch stopped-task reasons for a discovered cluster. Use when an ECS or ETL
  task fails, will not start, or the user asks about service health.
allowed-tools: Bash, Read
---

# ECS Fargate Inspector

Diagnose ECS Fargate service and task health for a given environment, following
SSO-aware profile resolution at every step.

## Instructions

1. **Resolve the environment profile.** Run the dispatcher to obtain the AWS
   profile and region for the target environment. Capture the JSON output so
   subsequent raw `aws` calls use the correct identity.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve ecs-cluster --env <env> --json
   ```

   If the role name for the cluster differs per project, substitute the
   appropriate role token (e.g. `etl-cluster`, `fargate-cluster`). Use
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs profiles list` to confirm
   available environments when the target env is unknown.

2. **Discover the cluster ARN.** Use the resolved profile and region to list
   clusters, then identify the target cluster by name.

   Print the command before running it.

   ```bash
   aws ecs list-clusters --profile <profile> --region <region>
   ```

3. **List and describe services.** Retrieve services for the cluster and show
   their running/desired/pending counts and deployment status.

   ```bash
   aws ecs list-services \
     --cluster <cluster-arn> \
     --profile <profile> \
     --region <region>

   aws ecs describe-services \
     --cluster <cluster-arn> \
     --services <service-arn> [<service-arn> ...] \
     --profile <profile> \
     --region <region>
   ```

   Report `runningCount`, `desiredCount`, `pendingCount`, and any
   `deployments[].rolloutState` values that are not `COMPLETED`.

4. **List tasks.** Fetch both RUNNING and STOPPED tasks to capture recent
   failures.

   ```bash
   aws ecs list-tasks \
     --cluster <cluster-arn> \
     --desired-status RUNNING \
     --profile <profile> \
     --region <region>

   aws ecs list-tasks \
     --cluster <cluster-arn> \
     --desired-status STOPPED \
     --profile <profile> \
     --region <region>
   ```

5. **Describe tasks.** Pass all collected task ARNs to `describe-tasks` in one
   call per status group.

   ```bash
   aws ecs describe-tasks \
     --cluster <cluster-arn> \
     --tasks <task-arn> [<task-arn> ...] \
     --profile <profile> \
     --region <region>
   ```

6. **Extract failure details.** For any stopped task, surface:
   - `stoppedReason` on the task object
   - `containers[].exitCode` and `containers[].reason` for each container
   - `containers[].lastStatus`

   Report these values verbatim so the caller can act on them.

7. **Fetch logs when containers exit non-zero.** If a container shows a
   non-zero exit code and has a `logConfiguration.options.awslogs-group`, hand
   off to the logs skill for the relevant log stream. Otherwise note the log
   group name so the caller can invoke the logs skill directly.

   All calls remain read-tier. Do not modify tasks, services, or capacity
   providers.

## Constraints

- Always pass `--profile` and `--region` on every raw `aws` command.
- Print the exact `aws` command before executing it.
- Never run mutating ECS calls (`run-task`, `update-service`, `stop-task`).
- If the SSO session is expired, instruct the user to run
  `aws sso login --profile <profile>` and retry.
