---
name: cost
description: >
  Summarize AWS spend by service and tag using Cost Explorer for an environment.
  Use when the user asks about costs, a bill increase, or wants spend attributed
  to services or components.
allowed-tools: Bash
---

# AWS Cost Explorer

Retrieve and summarize AWS spend for a logical environment. Group by service and by a cost-allocation tag when present. Present a compact table and highlight the top movers.

## Instructions

1. Determine the target environment from the user's request (e.g. "prod", "staging", "dev"). If the user does not name one, ask before proceeding.

2. Resolve the profile and region for that environment. Print the command before running it.

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve identity --env <env> --json
   ```

   Parse the JSON output for `profile` and `region`.

   If `resolve` exits non-zero, surface the error and stop. Do not guess a profile.

3. Determine the time period. Default to the last 30 calendar days unless the user specifies a different range.

   Compute `START` as 30 days before today (YYYY-MM-DD) and `END` as today (YYYY-MM-DD).

4. Fetch cost grouped by SERVICE. Print the exact command before running it.

   ```
   aws ce get-cost-and-usage \
     --time-period Start=<START>,End=<END> \
     --granularity MONTHLY \
     --metrics "UnblendedCost" \
     --group-by Type=DIMENSION,Key=SERVICE \
     --profile <profile> \
     --region us-east-1
   ```

   Note: Cost Explorer is a global service. Always pass `--region us-east-1` regardless of the environment region. Still pass `--profile` from the resolved env map.

5. If the user mentions a cost-allocation tag (e.g. "by environment" or "by component"), fetch a second breakdown grouped by that tag. Print the command before running it.

   ```
   aws ce get-cost-and-usage \
     --time-period Start=<START>,End=<END> \
     --granularity MONTHLY \
     --metrics "UnblendedCost" \
     --group-by Type=TAG,Key=<TagKey> \
     --profile <profile> \
     --region us-east-1
   ```

6. Parse the JSON response. Extract each group's `Keys[0]` (service or tag value) and its `UnblendedCost` amount and unit.

7. Present results as a compact table sorted by cost descending.

   | Service / Tag | Amount | Unit |
   | ------------- | ------ | ---- |
   | Amazon EC2    | 142.38 | USD  |
   | AWS Lambda    | 0.84   | USD  |
   | ...           | ...    | ...  |

   Below the table, list the top 3 cost drivers and their share of total spend as a percentage.

8. If total spend increased compared to the prior period, compute the delta and report it. To fetch the prior period, shift `START` and `END` back by the same number of days and rerun step 4 with those dates.

## Constraints

- Always pass `--profile` (resolved from the env map) and `--region us-east-1` on every `aws ce` command.
- `aws ce get-cost-and-usage` is read-tier. The PreToolUse guard hook classifies it automatically.
- Never hardcode a profile name. Always resolve via the dispatcher.
- Do not emit raw JSON to the user. Parse it and present only the table and summary.
- If the Cost Explorer API returns an access-denied error, tell the user that Cost Explorer requires the `ce:GetCostAndUsage` IAM permission and may need to be enabled in the AWS Billing console.
- Print every `aws` command before executing it so the user can audit what runs.
