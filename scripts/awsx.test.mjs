// awsx.test.mjs
// node:test suite for the aws-cli plugin script layer. Covers:
//   - guard.classify tiers (read / mutate / destructive)
//   - guard.decide profile pinning + allowlist + tier2 block + override
//   - stackdoc render->parse round-trip
//   - dispatcher parseFlags parsing
// Run: node --test scripts/awsx.test.mjs   (node builtins only)

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, decide } from "./lib/guard.mjs";
import { renderStackDoc, parseStackDoc } from "./lib/stackdoc.mjs";
import { parseFlags } from "./awsx.mjs";

// ---------------------------------------------------------------------------
// guard.classify: tier assignment
// ---------------------------------------------------------------------------

test("classify: non-aws command is not aws and tier 0", () => {
  const c = classify("ls -la /tmp");
  assert.equal(c.isAws, false);
  assert.equal(c.tier, 0);
});

test("classify: tier0 read verbs (describe/list/get/tail/ls)", () => {
  const cases = [
    ["aws ec2 describe-instances", "ec2", "describe-instances"],
    ["aws lambda list-functions", "lambda", "list-functions"],
    ["aws s3api get-object", "s3api", "get-object"],
    ["aws logs tail /aws/lambda/fn", "logs", "tail"],
    ["aws logs filter-log-events --log-group-name g", "logs", "filter-log-events"],
    ["aws s3 ls s3://bucket", "s3", "ls"],
  ];
  for (const [cmd, service, verb] of cases) {
    const c = classify(cmd);
    assert.equal(c.isAws, true, cmd);
    assert.equal(c.tier, 0, `${cmd} should be tier0`);
    assert.equal(c.service, service, cmd);
    assert.equal(c.verb, verb, cmd);
  }
});

test("classify: tier1 low-mutate verbs (invoke/run-task/cp/sync/put/create/update)", () => {
  const cases = [
    "aws lambda invoke --function-name fn out.json",
    "aws ecs run-task --cluster c --task-definition t",
    "aws s3 cp file s3://bucket/key",
    "aws s3 sync ./dist s3://bucket",
    "aws s3api put-object --bucket b --key k",
    "aws dynamodb create-table --table-name t",
    "aws ecs update-service --service s --desired-count 3",
  ];
  for (const cmd of cases) {
    const c = classify(cmd);
    assert.equal(c.isAws, true, cmd);
    assert.equal(c.tier, 1, `${cmd} should be tier1`);
  }
});

test("classify: tier2 destructive verbs (delete/terminate/remove/rb)", () => {
  const cases = [
    "aws lambda delete-function --function-name fn",
    "aws ec2 terminate-instances --instance-ids i-123",
    "aws s3 rb s3://bucket --force",
    "aws iam remove-role-from-instance-profile --role-name r",
    "aws dynamodb delete-table --table-name t",
  ];
  for (const cmd of cases) {
    const c = classify(cmd);
    assert.equal(c.isAws, true, cmd);
    assert.equal(c.tier, 2, `${cmd} should be tier2`);
  }
});

test("classify: tier2 policy writes", () => {
  const cases = [
    "aws s3api put-bucket-policy --bucket b --policy {}",
    "aws iam update-assume-role-policy --role-name r --policy-document {}",
  ];
  for (const cmd of cases) {
    const c = classify(cmd);
    assert.equal(c.tier, 2, `${cmd} should be tier2 (policy write)`);
  }
});

test("classify: tier2 scale-to-zero", () => {
  const c = classify("aws ecs update-service --service s --desired-count 0");
  assert.equal(c.tier, 2);
});

test("classify: extracts --profile in both forms", () => {
  assert.equal(classify("aws s3 ls --profile foo").profile, "foo");
  assert.equal(classify("aws s3 ls --profile=bar").profile, "bar");
  assert.equal(classify("aws s3 ls").profile, null);
});

// ---------------------------------------------------------------------------
// guard.decide: policy on top of classify
// ---------------------------------------------------------------------------

const ALLOWED = { allowedProfiles: ["angeleno-prod", "angeleno-dev"] };

test("decide: non-aws command is allowed", () => {
  const d = decide("echo hi", ALLOWED);
  assert.equal(d.allow, true);
});

test("decide: aws without --profile is blocked (profile pinning)", () => {
  const d = decide("aws ec2 describe-instances", ALLOWED);
  assert.equal(d.allow, false);
  assert.match(d.reason, /profile/i);
});

test("decide: aws with profile NOT in allowlist is blocked", () => {
  const d = decide("aws ec2 describe-instances --profile stranger", ALLOWED);
  assert.equal(d.allow, false);
  assert.match(d.reason, /not in the allowed set/i);
});

test("decide: tier0 with allowed pinned profile is allowed", () => {
  const d = decide("aws ec2 describe-instances --profile angeleno-prod", ALLOWED);
  assert.equal(d.allow, true);
});

test("decide: tier1 with allowed pinned profile is allowed", () => {
  const d = decide("aws s3 cp f s3://b/k --profile angeleno-dev", ALLOWED);
  assert.equal(d.allow, true);
});

test("decide: tier2 with allowed profile is blocked by default", () => {
  const prev = process.env.AWSX_ALLOW_DESTRUCTIVE;
  delete process.env.AWSX_ALLOW_DESTRUCTIVE;
  try {
    const d = decide("aws lambda delete-function --function-name fn --profile angeleno-prod", ALLOWED);
    assert.equal(d.allow, false);
    assert.match(d.reason, /tier2/i);
  } finally {
    if (prev !== undefined) process.env.AWSX_ALLOW_DESTRUCTIVE = prev;
  }
});

test("decide: tier2 allowed when AWSX_ALLOW_DESTRUCTIVE=1", () => {
  const prev = process.env.AWSX_ALLOW_DESTRUCTIVE;
  process.env.AWSX_ALLOW_DESTRUCTIVE = "1";
  try {
    const d = decide("aws lambda delete-function --function-name fn --profile angeleno-prod", ALLOWED);
    assert.equal(d.allow, true);
  } finally {
    if (prev === undefined) delete process.env.AWSX_ALLOW_DESTRUCTIVE;
    else process.env.AWSX_ALLOW_DESTRUCTIVE = prev;
  }
});

// ---------------------------------------------------------------------------
// stackdoc: render -> parse round-trip
// ---------------------------------------------------------------------------

test("stackdoc: render then parse round-trips the model", () => {
  const model = {
    services: ["lambda", "s3", "dynamodb"],
    environments: ["dev", "prod"],
    roles: [
      {
        name: "api-handler",
        service: "lambda",
        description: "Main API Lambda function",
        handleType: "tag",
        handle: "Name=api-handler",
      },
      {
        name: "asset-bucket",
        service: "s3",
        description: "Static assets",
        handleType: "namePattern",
        handle: "angeleno-assets-*",
      },
      {
        name: "core-stack",
        service: "cloudformation",
        description: "Core infra stack",
        handleType: "logicalId",
        handle: "CoreStack.ApiFn",
      },
    ],
  };

  const md = renderStackDoc(model);
  const parsed = parseStackDoc(md);

  assert.deepEqual(parsed.services, model.services);
  assert.deepEqual(parsed.environments, model.environments);
  assert.deepEqual(parsed.roles, model.roles);
});

test("stackdoc: round-trips the functional Stacks section", () => {
  const model = {
    services: ["lambda"],
    environments: ["prod"],
    stacks: [
      { name: "AngelenoMicaEtlStack", description: "ETL pipeline (ECS Fargate)." },
      { name: "AngelenoMicaPortalStack", description: "Frontend SPA via CloudFront." },
    ],
    roles: [],
  };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.deepEqual(parsed.stacks, model.stacks);
});

test("stackdoc: stack descriptions survive pipe and colon characters", () => {
  const model = {
    services: [],
    environments: [],
    stacks: [
      { name: "DataStack", description: "ingests A | B; emits C: done" },
    ],
    roles: [],
  };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.deepEqual(parsed.stacks, model.stacks);
});

test("stackdoc: round-trip survives pipe characters in description", () => {
  const model = {
    services: ["ec2"],
    environments: ["prod"],
    roles: [
      {
        name: "worker",
        service: "ec2",
        description: "handles A | B | C pipelines",
        handleType: "tag",
        handle: "role=worker",
      },
    ],
  };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.deepEqual(parsed.roles, model.roles);
});

test("stackdoc: render is idempotent through a double round-trip", () => {
  const model = {
    services: ["lambda"],
    environments: ["staging"],
    roles: [
      {
        name: "ingest",
        service: "lambda",
        description: "ingest",
        handleType: "logicalId",
        handle: "IngestFn",
      },
    ],
  };
  const once = renderStackDoc(model);
  const twice = renderStackDoc(parseStackDoc(once));
  assert.equal(once, twice);
});

test("stackdoc: empty model round-trips to empty arrays", () => {
  const model = { services: [], environments: [], stacks: [], roles: [] };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.deepEqual(parsed, model);
});

test("stackdoc: preserves a hand-authored architecture narrative", () => {
  const architecture = [
    "How the stacks fit together:",
    "",
    "```",
    "Browser ──► CloudFront ──► S3 (SPA)",
    "        ──► API Gateway ──► Lambda",
    "```",
    "",
    "- Request path: client to frontend to API.",
    "- Data path: scheduler to ETL to database.",
  ].join("\n");
  const model = {
    services: ["lambda"],
    environments: ["prod"],
    stacks: [{ name: "PortalStack", description: "Frontend SPA." }],
    roles: [],
    architecture,
  };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.equal(parsed.architecture, architecture);
  assert.deepEqual(parsed.stacks, model.stacks);
});

test("stackdoc: architecture-free doc parses without an architecture key", () => {
  const model = {
    services: ["lambda"],
    environments: ["prod"],
    stacks: [{ name: "ApiStack", description: "Backend." }],
    roles: [],
  };
  const parsed = parseStackDoc(renderStackDoc(model));
  assert.equal("architecture" in parsed, false);
});

test("stackdoc: architecture survives a double round-trip unchanged", () => {
  const model = {
    services: ["s3"],
    environments: ["prod"],
    stacks: [],
    roles: [],
    architecture: "Line one.\n\n    indented diagram | with pipes\n\nLine two.",
  };
  const once = renderStackDoc(model);
  const twice = renderStackDoc(parseStackDoc(once));
  assert.equal(once, twice);
});

// ---------------------------------------------------------------------------
// dispatcher: parseFlags
// ---------------------------------------------------------------------------

test("parseFlags: space and equals forms, booleans, positionals", () => {
  const f = parseFlags(["myrole", "--env", "prod", "--json", "--region=us-west-2"]);
  assert.deepEqual(f._, ["myrole"]);
  assert.equal(f.env, "prod");
  assert.equal(f.json, true);
  assert.equal(f.region, "us-west-2");
});

test("parseFlags: trailing boolean flag", () => {
  const f = parseFlags(["--env", "dev", "--check"]);
  assert.equal(f.env, "dev");
  assert.equal(f.check, true);
});
