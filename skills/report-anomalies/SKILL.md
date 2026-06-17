---
name: report-anomalies
description: >
  Read-only cross-dimension scan of a project's AWS environment. Surfaces
  issues across app health, infra health, cost, security, reliability, and
  hygiene, then produces one concise ranked report with recommended actions.
  Use for a periodic health/risk sweep, before a release, or when the user
  asks "is anything wrong in AWS?"
allowed-tools: Bash, Read, Task
---

# report-anomalies

Scan the AWS environment across six dimensions and produce one consolidated,
ranked anomaly report. This skill is strictly read-only and never mutates
any resource.

## Instructions

1. Resolve the target environment.

   a. Read `.claude/aws-profiles.local.json`. The top-level keys are the valid
   environment names; each maps to an object with `profile` and `region`.
   - If the file is missing or contains no keys, stop immediately and report:
     "No environment/profile map found. Run `aws:discover` to create
     `.claude/aws-profiles.local.json` before scanning."

   b. If `--env` was supplied, validate it against the discovered keys.
   If it is not a valid key, stop immediately and report:
   "Unknown environment '<value>'. Valid environments: <key1>, <key2>, …"

   c. If `--env` was not supplied, ask the user which environment to scan,
   offering ONLY the environments discovered from that file. Never invent or
   assume names (e.g., do not guess "staging").

   d. Confirm SSO authentication for the resolved environment:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs whoami --env <env>
   ```

   Stop immediately if authentication fails and report the error.

2. Read `.claude/aws-stack.md` to identify all deployed roles and resource
   logical names. Use this file to scope every subsequent query.

3. For each role in the stack, resolve concrete AWS IDs:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve <role> --env <env> --json
   ```

4. Fan out the six dimension investigations in parallel. All six run
   concurrently because they are independent and read-only.

   **Dimension 1: App health** (investigate directly with read-tier aws commands)
   - Query Lambda error rates and throttle counts for each function over the
     last 24 hours via CloudWatch Metrics (`aws cloudwatch get-metric-statistics`).
   - List ECS tasks in STOPPED state and capture `stoppedReason` and exit codes
     (`aws ecs list-tasks --desired-status STOPPED`, then `describe-tasks`).
   - Pull the last 50 CloudWatch Logs entries for each service that contain
     ERROR or CRITICAL keywords.

   **Dimension 2: Infra health** (investigate directly with read-tier aws commands)
   - List all CloudWatch alarms currently in ALARM state
     (`aws cloudwatch describe-alarms --state-value ALARM`).
   - Check CloudFormation stacks for ROLLBACK_COMPLETE, UPDATE_ROLLBACK_COMPLETE,
     or any FAILED status (`aws cloudformation describe-stacks`).
   - Check CloudFormation drift status for each stack in the scope
     (`aws cloudformation describe-stack-drift-detection-status`).

   **Dimension 3: Cost** (delegate to the `cost-analyst` subagent)
   - Pass the environment name and the role list from `.claude/aws-stack.md`.
   - Ask it to compare spend versus the prior comparable period and surface
     any spikes exceeding 20% or $50.

   **Dimension 4: Security** (delegate to the `security-auditor` subagent)
   - Pass the environment name and the role list from `.claude/aws-stack.md`.
   - Ask it to check for public S3 buckets, security groups open to 0.0.0.0/0
     on ports 22/3389/5432/any database port, and IAM policies with wildcard
     actions or resources.

   **Dimension 5: Reliability** (investigate directly with read-tier aws commands)
   - Check service quota headroom for key limits: Lambda concurrent executions,
     ECS task count, and any quota relevant to the discovered roles
     (`aws service-quotas list-service-quotas` and
     `aws service-quotas get-aws-default-service-quota`).
   - Determine data freshness: query the last successful ETL or scheduled-job
     run timestamp from CloudWatch Logs or the relevant DynamoDB/S3 marker.
     Flag any job whose last success exceeds its expected cadence by 2x.

   **Dimension 6: Hygiene** (investigate directly with read-tier aws commands)
   - Check ACM certificates expiring within 30 days
     (`aws acm list-certificates`, then `describe-certificate`).
   - Check Secrets Manager secrets with rotation disabled or last-rotated date
     older than 90 days (`aws secretsmanager list-secrets`).
   - List IAM access keys older than 90 days
     (`aws iam list-users`, then `list-access-keys` per user).
   - Run the discover check to detect drift from `.claude/aws-stack.md`:
     ```
     aws:discover --env <env> --check
     ```
     Report any resources present in AWS but missing from the stack file, or
     vice versa.

5. If any dimension cannot be checked (insufficient permissions, feature not
   enabled, or service not in scope), record that fact explicitly as
   "SKIPPED: <reason>" for that dimension rather than omitting it silently.

6. Consolidate all findings from all six dimensions into one report using
   the output format below. Do not emit six separate sections with raw data.
   Map every finding to a severity before writing the report.

   Severity mapping:
   - **Critical**: outage-causing or active data-exposure risk right now.
   - **High**: degraded service, exploitable misconfiguration, or cost spike
     exceeding 50% of baseline.
   - **Medium**: approaching limits, expiry within 30 days, or hygiene debt
     that creates near-term risk.
   - **Low**: informational drift, minor hygiene items, or items within
     acceptable thresholds.

7. Sort findings Critical first, then High, Medium, Low. Within each severity
   level, order by dimension number (1 through 6).

8. Write the final report as plain text. Use a short table or bullet list per
   severity tier. Each finding line must state:
   `[Dimension] <role/resource logical name> — <problem> → RECOMMENDED ACTION: <action>`

9. Close the report with one summary line:
   `Overall: <N> Critical, <N> High, <N> Medium, <N> Low — <one-phrase status>`

   Example: `Overall: 0 Critical, 1 High, 3 Medium, 2 Low — review before next release`

## Examples

```
/aws:report-anomalies --env prod
/aws:report-anomalies --env preview
```

Expected output shape (abbreviated):

```
AWS Anomaly Report — prod — 2026-06-15

CRITICAL
  [App Health] api-lambda — error rate 12% in last 1h (threshold 1%) → RECOMMENDED ACTION: check recent deploys and roll back if correlated

HIGH
  [Cost] etl-fargate — spend $340 this week vs $180 last week (+89%) → RECOMMENDED ACTION: review ECS task scaling policy

MEDIUM
  [Hygiene] api-tls-cert — expires in 18 days → RECOMMENDED ACTION: trigger ACM renewal or update DNS validation record
  [Security] etl-bucket — public read ACL enabled → RECOMMENDED ACTION: set bucket ACL to private and enable Block Public Access

LOW
  [Infra Health] etl-stack — drift detected on 1 resource → RECOMMENDED ACTION: run cdk diff and re-deploy to reconcile

SKIPPED
  [Reliability] Service quota check — insufficient permissions for service-quotas:ListServiceQuotas

Overall: 1 Critical, 1 High, 2 Medium, 1 Low — address critical before next deployment
```
