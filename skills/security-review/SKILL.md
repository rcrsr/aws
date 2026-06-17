---
name: security-review
description: >
  Run a read-only exposure scan over the discovered AWS stack: public S3 buckets,
  permissive security groups, and over-broad IAM policies. Use when the user asks
  for a security check, audit, or wants to find risky AWS configuration.
allowed-tools: Bash, Read
model: sonnet
---

# Security Review

Scan the discovered AWS stack for high-risk exposure: public S3 buckets, security groups
open to the internet on sensitive ports, and IAM policies granting wildcard actions or
resources. Report every finding by severity with the exact resource ARN and a concrete fix.
Never mutate any resource.

## Instructions

1. Identify the target environment. If the user specified an env label (dev, staging, prod),
   use it. Otherwise ask which env to scan before proceeding.

2. Resolve the AWS profile and region for that environment via the dispatcher.
   Print the command before running it.

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/awsx.mjs resolve infra --env <env> --json
   ```

   Extract `profile` and `region` from the JSON output. All subsequent `aws` calls use
   `--profile <profile> --region <region>`.

3. Load the stack inventory from `aws-stack.md` if it exists in the repo root or
   `.claude/` directory. Extract S3 bucket names, security group IDs, and IAM role/policy
   ARNs to scope the scan. If the file is absent, discover resources from the live account
   (steps below will cast wider nets automatically).

4. **S3 public-access scan.** For each bucket in scope (or all buckets if no scope file):

   a. Print then run:

   ```
   aws s3api get-public-access-block --bucket <bucket> --profile <profile> --region <region>
   ```

   Flag any bucket where any of the four block-public-access flags is `false`.

   b. Print then run:

   ```
   aws s3api get-bucket-policy-status --bucket <bucket> --profile <profile> --region <region>
   ```

   Flag any bucket where `PolicyStatus.IsPublic` is `true`.

   c. Print then run:

   ```
   aws s3api get-bucket-acl --bucket <bucket> --profile <profile> --region <region>
   ```

   Flag any grant where `Grantee.URI` contains `AllUsers` or `AuthenticatedUsers`.

5. **Security-group ingress scan.** Print then run:

   ```
   aws ec2 describe-security-groups --profile <profile> --region <region> \
     --query "SecurityGroups[*].{ID:GroupId,Name:GroupName,Ingress:IpPermissions}"
   ```

   If the scope file lists specific group IDs, add `--group-ids <id1> <id2> ...`.

   Flag any rule where `IpRanges[].CidrIp` is `0.0.0.0/0` or `Ipv6Ranges[].CidrIpv6` is
   `::/0` AND the `FromPort`/`ToPort` range includes any sensitive port:
   22 (SSH), 3389 (RDP), 5432 (PostgreSQL), 3306 (MySQL), 27017 (MongoDB), 6379 (Redis),
   or port range 0-65535 (all ports).

6. **IAM wildcard-policy scan.**

   a. List customer-managed policies. Print then run:

   ```
   aws iam list-policies --scope Local --profile <profile> --region <region> \
     --query "Policies[*].{Arn:Arn,Name:PolicyName,DefaultVersionId:DefaultVersionId}"
   ```

   b. For each policy ARN, print then run:

   ```
   aws iam get-policy-version --policy-arn <arn> --version-id <version> \
     --profile <profile> --region <region>
   ```

   Flag any statement where `Effect` is `Allow` and `Action` contains `"*"` or
   `Resource` contains `"*"`.

   c. For roles in scope, print then run:

   ```
   aws iam list-role-policies --role-name <role> --profile <profile> --region <region>
   ```

   Then for each inline policy name:

   ```
   aws iam get-role-policy --role-name <role> --policy-name <policy> \
     --profile <profile> --region <region>
   ```

   Apply the same wildcard check.

7. **Compile findings.** Produce a report grouped by severity:

   **CRITICAL** — Internet-exposed sensitive port (SG) or public S3 bucket with data.
   **HIGH** — IAM wildcard Action `"*"` on `Resource "*"`.
   **MEDIUM** — IAM wildcard Action `"*"` on a scoped resource, or wildcard Resource `"*"`
   with a scoped action set.
   **LOW** — Public-access block partially disabled with no active public policy or ACL.

   For each finding include:
   - Severity label
   - Resource type and exact ID/ARN
   - What is exposed or over-permissioned
   - Recommended fix (policy change, SG rule removal, bucket setting to enable)

8. If the scan reveals issues requiring cross-service correlation (e.g., CloudTrail for
   actual usage, Config for drift, GuardDuty findings), note that and recommend delegating
   to the `security-auditor` agent for a deeper investigation.

9. Print a summary line at the end:
   `Security review complete: <N> CRITICAL, <N> HIGH, <N> MEDIUM, <N> LOW findings.`

## Examples

**Example — invoke for production:**

```
/security-review env=prod
```

Dispatcher resolves `prod` profile and region. Scan runs against prod S3 buckets,
security groups, and IAM policies. Report lists all findings with fixes.

**Example — scoped to staging, no aws-stack.md:**

```
/security-review env=staging
```

Skill casts wide net across all accessible resources in the staging account. Same
report format applies.
