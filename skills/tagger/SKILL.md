---
name: tagger
description: >
  Adds the aws-agent-meta tag to Infrastructure-as-Code source so that
  aws:discover groups resources by logical role instead of falling back to weak
  name-pattern handles. Use when aws:discover shows roles labelled by
  namePattern rather than a clean logical name, or when you add new IaC
  constructs and want discovery to group them correctly from the first deploy.
allowed-tools: Read, Bash, Task
---

# AWS IaC Tagger

Plans and delegates `aws-agent-meta` tag additions to IaC source so that
`aws:discover` groups resources by logical role on every future deployment.

## Why this matters

`aws:discover` reads tags first. When the `aws-agent-meta` key is present on a
resource, discovery uses its value as the logical role name directly. Resources
without that tag fall back to name-pattern matching, which produces generic or
ambiguous role labels. This skill closes that gap by tagging at the IaC layer,
ensuring tags survive redeployments and live in version control.

**Plugin-owned tag key:** `aws-agent-meta`
**Value format:** the logical component or role name, e.g. `mica-etl`, `mica-api`.

The key is stack-agnostic so this skill works in any repo, not just this one.

## Instructions

1. Read `/home/andre/projects/angeleno/.claude/aws-stack.md` to identify which
   roles currently rely on `namePattern` handles. These are the highest-priority
   tagging targets.

2. Locate the IaC source in the repo. Check for these in order:
   - CDK app: `infra/` or `cdk/` directories containing `*Stack*.ts` files
   - AWS SAM: `template.yaml` at repo root or under `infra/`
   - Serverless Framework: `serverless.yml` at repo root
   - Terraform: `*.tf` files under `infra/` or `terraform/`

3. Build a tag plan. For each resource or construct that has a `namePattern`
   role or is otherwise ungrouped, map it to a `aws-agent-meta=<component>`
   value. Use the existing logical names from `aws-stack.md` where they exist.
   Present the complete plan to the user as a table:

   | Construct / Resource | IaC file                   | Proposed aws-agent-meta value |
   | -------------------- | -------------------------- | ----------------------------- |
   | EtlTaskDefinition    | infra/cdk/lib/etl-stack.ts | mica-etl                      |
   | ApiLambdaFunction    | infra/cdk/lib/api-stack.ts | mica-api                      |

   Ask the user to confirm or relabel any entries before proceeding.

4. On user approval, determine the IaC type and delegate accordingly:

   **AWS CDK projects (TypeScript, JavaScript, Python, Java, C#, Go):**
   Delegate ALL concrete IaC edits to the plugin-owned `aws:cdk-engineer`
   subagent. Do NOT edit IaC files yourself. The delegation message must include:
   - The tag key: `aws-agent-meta`
   - The confirmed plan table
   - The instruction to apply tags at stack or construct scope, not to live
     resources

   **Non-CDK IaC (raw CloudFormation/SAM templates, Serverless Framework,
   Terraform):**
   There is no plugin-owned engineer for these IaC types yet. A dedicated
   engineer for each type is planned. Instead, present the user with the exact
   tag additions they need to apply manually, using the syntax from the
   IaC Tag Syntax Reference section below. State clearly that these edits must
   be made by hand until a dedicated engineer ships.

5. Tell the user the next steps:
   - Deploy the IaC change (e.g. `nx deploy:prod` or the project's deploy
     command)
   - Optionally preview drift first: `aws:discover --env <env> --check`
   - Re-run `aws:discover --env <env>` after deploy to refresh the cheat sheet
     and confirm resources now appear under clean logical role names

## IaC Tag Syntax Reference

**AWS CDK (TypeScript)**

```typescript
// At stack scope (tags all resources in the stack)
Tags.of(this).add('aws-agent-meta', 'mica-etl');

// At construct scope (tags a specific resource)
Tags.of(myTaskDefinition).add('aws-agent-meta', 'mica-etl');
```

**AWS SAM (`template.yaml`)**

```yaml
Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Tags:
        aws-agent-meta: mica-api
```

**Serverless Framework (`serverless.yml`)**

```yaml
provider:
  tags:
    aws-agent-meta: mica-api # applies to all functions

functions:
  myFunction:
    tags:
      aws-agent-meta: mica-etl # construct-level override
```

**Terraform**

```hcl
# Per-resource
resource "aws_lambda_function" "api" {
  tags = {
    aws-agent-meta = "mica-api"
  }
}

# Via default_tags (applies to all resources in the provider block)
provider "aws" {
  default_tags {
    tags = {
      aws-agent-meta = "mica-api"
    }
  }
}
```

## Constraints

- Never apply tags directly to live AWS resources via CLI or SDK. Tag the IaC
  source only so changes are version-controlled and survive redeployments.
- Never edit IaC files yourself. Delegate CDK edits to the `aws:cdk-engineer`
  agent. For non-CDK IaC, present the exact changes for the user to apply
  manually.
- One `aws-agent-meta` value per logical role. Do not use the same value for
  constructs that belong to different roles.
- Confirm the tag plan with the user before delegating any edits.
