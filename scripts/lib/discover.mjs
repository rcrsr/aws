// discover.mjs
// Build the abstract stack model. The live account is authoritative: we query
// CloudFormation and the Resource Groups Tagging API to learn what actually
// exists, and we mine the repo only for hints (service names, env labels,
// role naming intent). We NEVER persist concrete ARNs, resource ids, or
// account numbers; only abstract handles (tag value, CFN logical id, name
// pattern) are written into .claude/aws-stack.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

import { paths, fileExists, out, ensureDir } from "./utils.mjs";
import { aws, AwsError, listEnabledRegions } from "./awscli.mjs";
import { resolveEnv, listEnvs } from "./profiles.mjs";
import { renderStackDoc, parseStackDoc } from "./stackdoc.mjs";
import { writeFileSync } from "node:fs";

/**
 * Map an AWS resource type or ARN fragment to a coarse service label.
 * @param {string} value
 * @returns {string}
 */
function serviceFromArnLike(value) {
  const v = String(value || "");
  // arn:aws:<service>:...  or  AWS::<Service>::<Type>
  const arnMatch = v.match(/^arn:[^:]*:([^:]+):/);
  if (arnMatch) return arnMatch[1];
  const cfnMatch = v.match(/^AWS::([^:]+)::/);
  if (cfnMatch) return cfnMatch[1].toLowerCase();
  return v;
}

/**
 * Map a CloudFormation resource type to the abstract service bucket.
 * @param {string} resourceType  e.g. "AWS::Lambda::Function"
 * @returns {string}
 */
function serviceFromCfnType(resourceType) {
  const m = String(resourceType || "").match(/^AWS::([^:]+)::/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Walk a directory shallowly (one level) collecting file names that match.
 * Defensive: returns [] on any fs error.
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function listDir(dir) {
  try {
    if (!fileExists(dir)) return [];
    return readdirSync(dir).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Gather repo hints. Reads only file presence and shallow contents; extracts
 * service names and env labels. Returns abstract hints, never concrete ids.
 * @param {string} root consumer repo root
 * @returns {{ services: Set<string>, environments: Set<string>, files: string[] }}
 */
function gatherRepoHints(root) {
  const services = new Set();
  const environments = new Set();
  const files = [];

  const note = (p) => {
    if (fileExists(p)) files.push(p);
  };

  // IaC + config hint files.
  note(join(root, "cdk.json"));
  note(join(root, "serverless.yml"));
  note(join(root, "serverless.yaml"));
  note(join(root, "samconfig.toml"));
  note(join(root, "template.yaml"));
  note(join(root, "template.yml"));

  // cdk.out/*.template.json
  const cdkOut = join(root, "cdk.out");
  for (const f of listDir(cdkOut)) {
    if (f.endsWith(".template.json")) files.push(f);
  }

  // Terraform files (top level + one nested level is enough for hints).
  for (const f of listDir(root)) {
    try {
      if (extname(f) === ".tf") files.push(f);
    } catch {
      // ignore
    }
  }

  // dotenv files for env labels.
  for (const f of listDir(root)) {
    const name = basename(f);
    if (name === ".env" || name.startsWith(".env.")) {
      files.push(f);
      const label = name === ".env" ? null : name.slice(".env.".length);
      if (label && label !== "local" && label !== "example") {
        environments.add(label);
      }
    }
  }

  // GitHub workflows hint at environments via "environment:" keys.
  const workflows = join(root, ".github", "workflows");
  for (const f of listDir(workflows)) {
    if (f.endsWith(".yml") || f.endsWith(".yaml")) {
      files.push(f);
      try {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/environment:\s*([A-Za-z0-9_-]+)/g)) {
          environments.add(m[1]);
        }
      } catch {
        // ignore unreadable workflow
      }
    }
  }

  // Mine CFN/SAM templates and serverless config for service names.
  for (const f of files) {
    const ext = extname(f);
    if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml" && ext !== ".toml") {
      continue;
    }
    try {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/AWS::([A-Za-z0-9]+)::/g)) {
        services.add(m[1].toLowerCase());
      }
    } catch {
      // ignore unreadable hint file
    }
  }

  return { services, environments, files };
}

/**
 * Derive a handle for a role, preferring project-identity tags (best grouping
 * keys), then Name/path tags (unique resources), then any tag, then logical id.
 * @param {{ tags?: Record<string,string>, logicalId?: string, name?: string }} info
 * @returns {{ handleType: "tag"|"logicalId"|"namePattern", handle: string }}
 */
function assignHandle(info) {
  const tags = info.tags || {};
  // Plugin-owned tag wins: the `tagger` skill writes `aws-agent-meta=<component>`
  // as a stack-agnostic grouping key the plugin controls across any repo.
  if (tags["aws-agent-meta"]) {
    return { handleType: "tag", handle: `aws-agent-meta=${tags["aws-agent-meta"]}` };
  }
  // Project-identity tags next: existing per-project grouping keys.
  const projectTags = ["angeleno-stack", "Application", "role", "Role", "Service", "service"];
  for (const key of projectTags) {
    if (tags[key]) return { handleType: "tag", handle: `${key}=${tags[key]}` };
  }
  // Name/path tags: useful for unique infrastructure resources (VPCs, subnets).
  for (const key of ["Name", "aws-cdk:path"]) {
    if (tags[key]) return { handleType: "tag", handle: `${key}=${tags[key]}` };
  }
  // Any remaining tag, deterministic by key order.
  const tagKeys = Object.keys(tags).sort();
  if (tagKeys.length > 0) {
    const k = tagKeys[0];
    return { handleType: "tag", handle: `${k}=${tags[k]}` };
  }
  // CFN logical id.
  if (info.logicalId) {
    return { handleType: "logicalId", handle: info.logicalId };
  }
  const name = info.name || "";
  const pattern = nameToPattern(name);
  return { handleType: "namePattern", handle: pattern };
}

/**
 * Derive a human-friendly role name from the abstract handle.
 * For tag handles the role name comes from the TAG VALUE, not the ARN tail.
 * @param {"tag"|"logicalId"|"namePattern"} handleType
 * @param {string} handle
 * @param {string} service
 * @returns {string}
 */
function roleNameFromHandle(handleType, handle, service) {
  if (handleType === "tag") {
    const eqIdx = handle.indexOf("=");
    const tagKey = eqIdx >= 0 ? handle.slice(0, eqIdx) : handle;
    const tagVal = eqIdx >= 0 ? handle.slice(eqIdx + 1) : "";
    // For Name/path tags the value is a path — abstract it.
    if (tagKey === "Name" || tagKey === "aws-cdk:path") {
      return abstractRoleName(tagVal, service);
    }
    // For project-identity tags the VALUE is the role name.
    // Strip common account/app prefixes so "angeleno-mica-etl" -> "mica-etl".
    const simplified = tagVal
      .replace(/^angeleno-mica-?/i, "")
      .replace(/^angeleno-?/i, "")
      .replace(/[-_][A-Za-z0-9]{8,}$/, "")
      .toLowerCase()
      .trim();
    return simplified || abstractRoleName(tagVal, service);
  }
  if (handleType === "logicalId") return abstractRoleName(handle, service);
  // namePattern: strip trailing wildcard before abstracting.
  return abstractRoleName(handle.replace(/[-_]?\*$/, ""), service);
}

/**
 * Convert a concrete resource name into a stable glob, abstracting away
 * deploy-specific suffixes (random hashes, UUIDs, short SM suffixes).
 * @param {string} name
 * @returns {string}
 */
function nameToPattern(name) {
  const n = String(name || "");
  if (!n) return "*";
  // Full UUID suffix: -012e2258-c64e-4f96-9346 (partial or full 4-group form).
  let pattern = n.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i, "-*");
  if (pattern !== n) return pattern;
  // Partial UUID (3-group): -012e2258-c64e-4f96
  pattern = n.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}$/i, "-*");
  if (pattern !== n) return pattern;
  // Secrets Manager 6-char random suffix: mica-etl-jRAIEm -> mica-etl-*
  pattern = n.replace(/-[A-Za-z0-9]{6}$/, "-*");
  if (pattern !== n) return pattern;
  // Long CFN-style hash (8+ uppercase hex): MyStack-MyFn-ABC123DEF456 -> MyStack-MyFn-*
  pattern = n.replace(/[-_][A-Z0-9]{8,}$/i, "-*");
  if (pattern !== n) return pattern;
  return `${n}*`;
}

/**
 * Query the live account (authoritative) for stacks and tagged resources
 * across one or more regions. Scanning multiple regions surfaces stacks that
 * a global service pins outside the primary region (e.g. a CloudFront/ACM
 * portal stack in us-east-1).
 * @param {{ profile: string }} ctx
 * @param {string[]} regions deduped region list to scan
 * @returns {{ stacks: object[], resources: object[] }}
 */
function gatherLive(ctx, regions) {
  const { profile } = ctx;
  const stacks = [];
  const resources = [];

  for (const region of regions) {
    // CloudFormation stacks.
    const describeArgs = ["cloudformation", "describe-stacks"];
    out(`+ aws ${describeArgs.join(" ")} --profile ${profile} --region ${region} --output json`);
    try {
      const res = aws(describeArgs, { profile, region });
      if (res && Array.isArray(res.Stacks)) {
        for (const s of res.Stacks) {
          stacks.push(s);
        }
      }
    } catch (err) {
      if (err instanceof AwsError && err.code === "NOT_FOUND") {
        // No stacks in this region: not fatal for discovery.
      } else {
        throw err;
      }
    }

    // Resource Groups Tagging API: discover tagged resources.
    const tagArgs = ["resourcegroupstaggingapi", "get-resources"];
    out(`+ aws ${tagArgs.join(" ")} --profile ${profile} --region ${region} --output json`);
    try {
      const res = aws(tagArgs, { profile, region });
      if (res && Array.isArray(res.ResourceTagMappingList)) {
        for (const r of res.ResourceTagMappingList) {
          resources.push(r);
        }
      }
    } catch (err) {
      if (err instanceof AwsError && err.code === "NOT_FOUND") {
        // none
      } else {
        throw err;
      }
    }
  }

  return { stacks, resources };
}

/**
 * Build the abstract stack model from repo hints + live account data.
 * Concrete ids/arns/account numbers are dropped here; only abstract handles
 * survive into the model.
 * @param {{ services: Set<string>, environments: Set<string> }} hints
 * @param {{ stacks: object[], resources: object[] }} live
 * @param {string} env
 * @param {import("./stackdoc.mjs").StackModel|null} existing committed model,
 *   used to preserve hand-edited stack descriptions across re-runs.
 * @returns {import("./stackdoc.mjs").StackModel}
 */
function buildModel(hints, live, env, existing = null) {
  const services = new Set(hints.services);
  // Environments are authoritative from the profile map, not repo hints. Repo
  // hints (e.g. GitHub workflow "environment:" keys) leak labels like
  // "production" that are not real bound environments.
  const environments = new Set(listEnvs());
  if (env) environments.add(env);

  // Group tagged resources by (service, handle). All resources sharing the same
  // project tag value collapse into ONE logical role — prevents one role per task.
  /** @type {Map<string, import("./stackdoc.mjs").StackRole>} */
  const roleByGroup = new Map();
  const seenRoleNames = new Set();

  for (const r of live.resources) {
    const arn = r.ResourceARN || "";
    const service = serviceFromArnLike(arn);
    if (service) services.add(service);

    const tags = {};
    for (const t of r.Tags || []) {
      if (t && t.Key) tags[t.Key] = t.Value;
    }

    // Pass the ARN label as a fallback name so namePattern gets "slack-aws*"
    // instead of "*" when no useful tags are present.
    const fallbackName = arnResourceLabel(arn);
    const { handleType, handle } = assignHandle({ tags, name: fallbackName });
    // Wildcard handles ("*") are not useful — skip untagged resources with no name.
    if (handle === "*") continue;
    // Skip CDK bootstrap infrastructure resources — they are not app roles.
    if (/CdkBootstrapVersion|StagingBucket|cdk-hnb659fds/i.test(handle)) continue;
    // Skip AWS-managed internal resources (ResourceGroups, etc.).
    if (/^Managed\./i.test(fallbackName)) continue;
    // Skip resources whose name is a bare UUID (CFN change sets, temp stacks).
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(fallbackName)) continue;
    const groupKey = `${service}::${handle}`;
    if (roleByGroup.has(groupKey)) continue; // already have this group

    let roleName = roleNameFromHandle(handleType, handle, service);
    // Disambiguate name clashes across groups by appending the service.
    if (seenRoleNames.has(roleName)) roleName = `${roleName}-${service}`;
    if (!roleName || seenRoleNames.has(roleName)) continue;
    seenRoleNames.add(roleName);

    roleByGroup.set(groupKey, {
      name: roleName,
      service,
      description: `Tagged ${service} resource discovered live.`,
      handleType,
      handle,
    });
  }

  /** @type {import("./stackdoc.mjs").StackRole[]} */
  const roles = [...roleByGroup.values()];

  // Functional stack overview. Each CloudFormation stack becomes one entry with
  // an auto-seeded description. Preserve any hand-edited description from the
  // committed doc so curated summaries survive re-runs and drift checks.
  const existingStackDesc = new Map(
    (existing?.stacks || []).map((s) => [s.name, s.description]),
  );
  /** @type {import("./stackdoc.mjs").StackEntry[]} */
  const stacks = [];
  const seenStackNames = new Set();

  // Roles from CloudFormation stack resources. Skip CDK bootstrap infrastructure
  // (CDKToolkit, cdk-bootstrap) which is not an app role.
  const CDK_SKIP = /^(CDKToolkit|cdk-bootstrap)/i;
  for (const s of live.stacks) {
    const stackName = s.StackName || "";
    if (CDK_SKIP.test(stackName)) continue;
    // Tags on the stack itself.
    for (const t of s.Tags || []) {
      if (t && t.Key === "Service" && t.Value) services.add(t.Value.toLowerCase());
    }

    const stackLabel = abstractRoleName(stackName, "cloudformation");

    // Functional overview entry (one per distinct stack).
    if (stackLabel && !seenStackNames.has(stackLabel)) {
      seenStackNames.add(stackLabel);
      const seeded =
        (typeof s.Description === "string" && s.Description.trim()) ||
        "Application stack discovered live.";
      stacks.push({
        name: stackLabel,
        description: existingStackDesc.get(stackLabel) || seeded,
      });
    }

    if (stackName) {
      const roleName = stackLabel;
      if (roleName && !seenRoleNames.has(roleName)) {
        seenRoleNames.add(roleName);
        roles.push({
          name: roleName,
          service: "cloudformation",
          description: "CloudFormation stack discovered live.",
          handleType: "namePattern",
          handle: nameToPattern(stackName),
        });
      }
    }
  }

  const model = {
    services: [...services].sort(),
    environments: [...environments].sort(),
    stacks: stacks.sort((a, b) => a.name.localeCompare(b.name)),
    roles: roles.sort((a, b) => a.name.localeCompare(b.name)),
  };

  // Preserve the hand-authored architecture narrative across re-runs, the same
  // way stack descriptions are preserved. The live account does not carry this
  // prose; it is inferred from the repo by the discover skill and must not be
  // wiped when discovery rewrites the doc.
  if (existing?.architecture) model.architecture = existing.architecture;

  return model;
}

/**
 * Extract the resource label segment from an ARN (the id-ish tail), used only
 * to derive an abstract role name. The value is not persisted directly.
 * @param {string} arn
 * @returns {string}
 */
function arnResourceLabel(arn) {
  const a = String(arn || "");
  const parts = a.split(":");
  const tail = parts[parts.length - 1] || "";
  // tail may be "function:name" or "name/with/slashes".
  const last = tail.split("/").pop() || tail;
  return last.split(":").pop() || last;
}

/**
 * Turn a concrete name into an abstract, deploy-portable role name.
 * Strips random suffixes and env tokens so the name describes intent.
 * @param {string} name
 * @param {string} service
 * @returns {string}
 */
function abstractRoleName(name, service) {
  let n = String(name || "").trim();
  if (!n) return service ? `${service}-resource` : "";
  // Strip trailing UUID fragment: -012e2258-c64e-4f96-9346 (3 or 4 groups).
  n = n.replace(/-[0-9a-f]{8}(-[0-9a-f]{4}){2,3}$/i, "");
  // Strip Secrets Manager 6-char random suffix (e.g. -jRAIEm, -Vdba2R).
  // SM suffixes are exactly 6 chars with randomly mixed case (2+ uppercase).
  // This avoids stripping meaningful suffix words like "-Online".
  n = n.replace(/-[A-Za-z0-9]{6}$/, (m) => {
    const chars = m.slice(1);
    const upperCount = (chars.match(/[A-Z]/g) || []).length;
    return (upperCount >= 2 || /[0-9]/.test(chars)) ? "" : m;
  });
  // Strip CFN hash suffixes: 8+ chars containing both digits and letters.
  // Pure-alpha words like "AlarmHigh" are kept; hashes like "ABC123DE" are stripped.
  n = n.replace(/[-_][A-Za-z0-9]{8,}$/, (m) =>
    /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "" : m
  );
  // Normalize slashes to dashes (e.g. "AngelenoStack/GrafanaFileSystem").
  n = n.replace(/[/\\]/g, "-");
  // Drop common env tokens to keep the name env-agnostic.
  n = n.replace(/[-_](prod|production|dev|development|stage|staging|test|qa)\b/gi, "");
  n = n.replace(/\s+/g, "-").trim();
  return n || (service ? `${service}-resource` : "");
}

/**
 * Discover the stack, writing or diffing the committed cheat sheet.
 *
 * Live account is authoritative. check=true renders in memory and diffs
 * against the committed document without writing.
 *
 * @param {{ env: string, check?: boolean }} args
 * @returns {{ ok: boolean, written?: boolean, drift?: boolean, diff?: string, model: import("./stackdoc.mjs").StackModel }}
 */
export function discover({ env, check = false }) {
  const { root, stackDoc, claudeDir } = paths();
  const ctx = resolveEnv(env);

  // Scan every enabled region so discovery never depends on a correctly-guessed
  // primary region (a wrong guess silently hides stacks in other regions). The
  // env's primary, configured extras, and us-east-1 are unioned in as a floor so
  // a missing account:ListRegions / ec2:DescribeRegions permission degrades to
  // the prior behavior instead of scanning nothing.
  const enabled = listEnabledRegions(ctx.profile, ctx.region);
  const scanRegions = [...new Set([ctx.region, ...ctx.regions, "us-east-1", ...enabled])];
  out(`+ scanning ${scanRegions.length} region(s): ${scanRegions.join(", ")}`);

  // Load the committed doc first so hand-edited stack descriptions are
  // preserved. This runs for both the write and --check paths, so the drift
  // check compares against a model that already carries the curated text.
  const existing = fileExists(stackDoc) ? parseStackDoc(safeRead(stackDoc)) : null;

  const hints = gatherRepoHints(root);
  const live = gatherLive(ctx, scanRegions);
  const model = buildModel(hints, live, env, existing);

  const rendered = renderStackDoc(model);

  if (check) {
    const current = fileExists(stackDoc) ? safeRead(stackDoc) : "";
    // Normalize both through parse->render to compare semantic content, not
    // incidental whitespace.
    const currentNorm = current ? renderStackDoc(parseStackDoc(current)) : "";
    const drift = currentNorm.trim() !== rendered.trim();
    return {
      ok: true,
      drift,
      diff: drift ? unifiedDiff(currentNorm, rendered) : "",
      model,
    };
  }

  ensureDir(claudeDir);
  writeFileSync(stackDoc, rendered.endsWith("\n") ? rendered : rendered + "\n", "utf8");
  return { ok: true, written: true, drift: false, model };
}

/**
 * Read a file, returning "" on any error.
 * @param {string} p
 * @returns {string}
 */
function safeRead(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Minimal line-oriented diff for human-readable drift reporting.
 * Not a real LCS; flags lines present in one side but not the other.
 * @param {string} a committed
 * @param {string} b rendered
 * @returns {string}
 */
function unifiedDiff(a, b) {
  const aLines = a.split(/\r?\n/);
  const bLines = b.split(/\r?\n/);
  const bSet = new Set(bLines);
  const aSet = new Set(aLines);
  const lines = [];
  for (const line of aLines) {
    if (!bSet.has(line)) lines.push(`- ${line}`);
  }
  for (const line of bLines) {
    if (!aSet.has(line)) lines.push(`+ ${line}`);
  }
  return lines.join("\n");
}
