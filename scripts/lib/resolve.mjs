// resolve.mjs
// Resolve a role's live identifier on demand. We read the abstract handle for
// the role from the committed stack document, map the requested env to a
// profile/region locally, then fire ONE targeted aws query to learn the
// current concrete id. Nothing is cached and nothing is persisted: the live
// account is authoritative for every call.

import { out } from "./utils.mjs";
import { aws, AwsError } from "./awscli.mjs";
import { resolveEnv } from "./profiles.mjs";
import { loadStackModel } from "./stackdoc.mjs";

/**
 * Find a role entry in the stack model by name (exact, then case-insensitive).
 * @param {import("./stackdoc.mjs").StackModel} model
 * @param {string} role
 * @returns {import("./stackdoc.mjs").StackRole|null}
 */
function findRole(model, role) {
  if (!model || !Array.isArray(model.roles)) return null;
  const exact = model.roles.find((r) => r.name === role);
  if (exact) return exact;
  const lower = String(role).toLowerCase();
  return model.roles.find((r) => String(r.name).toLowerCase() === lower) || null;
}

/**
 * Parse a "tag" handle of the form "Key=Value" into its parts.
 * @param {string} handle
 * @returns {{ key: string, value: string }}
 */
function parseTagHandle(handle) {
  const idx = String(handle).indexOf("=");
  if (idx === -1) return { key: "Name", value: String(handle) };
  return { key: handle.slice(0, idx), value: handle.slice(idx + 1) };
}

/**
 * Resolve a role to its current live ARN/id.
 *
 * @param {string} role  role name as recorded in aws-stack.md
 * @param {string} env   environment key from aws-profiles.local.json
 * @returns {{ service: string, arn?: string, id?: string, profile: string, region: string }}
 * @throws {Error} when the stack doc, role, or env is missing.
 * @throws {AwsError} when the live query fails.
 */
export function resolveRole(role, env) {
  const model = loadStackModel();
  if (!model) {
    throw new Error(
      "no aws-stack.md found in .claude/; run `awsx discover --env <e>` first",
    );
  }

  const entry = findRole(model, role);
  if (!entry) {
    const known = model.roles.map((r) => r.name).join(", ") || "(none)";
    throw new Error(`role '${role}' not found in aws-stack.md; known roles: ${known}`);
  }

  const { profile, region } = resolveEnv(env);
  const ctx = { profile, region };

  const resolved = resolveByHandle(entry, ctx);
  return {
    service: entry.service,
    ...(resolved.arn ? { arn: resolved.arn } : {}),
    ...(resolved.id ? { id: resolved.id } : {}),
    profile,
    region,
  };
}

/**
 * Fire exactly one targeted live query based on the role's handle type.
 * @param {import("./stackdoc.mjs").StackRole} role
 * @param {{ profile: string, region: string }} ctx
 * @returns {{ arn?: string, id?: string }}
 */
function resolveByHandle(role, ctx) {
  switch (role.handleType) {
    case "tag":
      return resolveByTag(role, ctx);
    case "logicalId":
      return resolveByLogicalId(role, ctx);
    case "namePattern":
      return resolveByNamePattern(role, ctx);
    default:
      throw new Error(`unknown handleType '${role.handleType}' for role '${role.name}'`);
  }
}

/**
 * Resolve via the Resource Groups Tagging API filtering on the tag.
 * @param {import("./stackdoc.mjs").StackRole} role
 * @param {{ profile: string, region: string }} ctx
 * @returns {{ arn?: string, id?: string }}
 */
function resolveByTag(role, ctx) {
  const { key, value } = parseTagHandle(role.handle);
  const args = [
    "resourcegroupstaggingapi",
    "get-resources",
    "--tag-filters",
    `Key=${key},Values=${value}`,
  ];
  out(`+ aws ${args.join(" ")} --profile ${ctx.profile} --region ${ctx.region} --output json`);
  const res = aws(args, ctx);
  const list = (res && res.ResourceTagMappingList) || [];
  if (list.length === 0) {
    throw new AwsError(`no resource matched tag ${key}=${value}`, "NOT_FOUND");
  }
  const arn = list[0].ResourceARN;
  return { arn, id: idFromArn(arn) };
}

/**
 * Resolve via CloudFormation describe-stack-resources, matching the logical id.
 * The handle is "<StackName>.<LogicalId>" or just "<LogicalId>" when the role's
 * service implies a single stack. We support both forms.
 * @param {import("./stackdoc.mjs").StackRole} role
 * @param {{ profile: string, region: string }} ctx
 * @returns {{ arn?: string, id?: string }}
 */
function resolveByLogicalId(role, ctx) {
  const handle = String(role.handle);
  const dot = handle.indexOf(".");
  const stackName = dot === -1 ? handle : handle.slice(0, dot);
  const logicalId = dot === -1 ? handle : handle.slice(dot + 1);

  const args = [
    "cloudformation",
    "describe-stack-resources",
    "--stack-name",
    stackName,
  ];
  out(`+ aws ${args.join(" ")} --profile ${ctx.profile} --region ${ctx.region} --output json`);
  const res = aws(args, ctx);
  const resources = (res && res.StackResources) || [];
  const match = resources.find((r) => r.LogicalResourceId === logicalId);
  if (!match) {
    throw new AwsError(
      `logical id '${logicalId}' not found in stack '${stackName}'`,
      "NOT_FOUND",
    );
  }
  const id = match.PhysicalResourceId;
  return { id, arn: looksLikeArn(id) ? id : undefined };
}

/**
 * Resolve via the Resource Groups Tagging API, then glob-match the resource
 * name segment against the role's name pattern. One live call.
 * @param {import("./stackdoc.mjs").StackRole} role
 * @param {{ profile: string, region: string }} ctx
 * @returns {{ arn?: string, id?: string }}
 */
function resolveByNamePattern(role, ctx) {
  const args = ["resourcegroupstaggingapi", "get-resources"];
  out(`+ aws ${args.join(" ")} --profile ${ctx.profile} --region ${ctx.region} --output json`);
  const res = aws(args, ctx);
  const list = (res && res.ResourceTagMappingList) || [];
  const re = globToRegExp(role.handle);
  for (const item of list) {
    const arn = item.ResourceARN || "";
    const id = idFromArn(arn);
    if (re.test(arn) || re.test(id)) {
      return { arn, id };
    }
  }
  throw new AwsError(`no resource name matched pattern '${role.handle}'`, "NOT_FOUND");
}

/**
 * Convert a simple glob (only * supported) to an anchored RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Extract the trailing resource id from an ARN.
 * @param {string} arn
 * @returns {string}
 */
function idFromArn(arn) {
  const a = String(arn || "");
  const parts = a.split(":");
  const tail = parts[parts.length - 1] || a;
  return tail.split("/").pop() || tail;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeArn(value) {
  return /^arn:[^:]*:[^:]+:/.test(String(value || ""));
}
