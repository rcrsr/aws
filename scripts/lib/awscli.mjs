// awscli.mjs
// Thin wrapper around the `aws` CLI binary. No SDK, no npm deps.
// Spawns the binary synchronously, normalizes failures into AwsError.

import { spawnSync } from "node:child_process";

/**
 * Typed error for AWS CLI failures.
 * code is one of: EXPIRED | ACCESS_DENIED | NOT_FOUND | CLI_MISSING | UNKNOWN
 */
export class AwsError extends Error {
  /**
   * @param {string} message
   * @param {"EXPIRED"|"ACCESS_DENIED"|"NOT_FOUND"|"CLI_MISSING"|"UNKNOWN"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "AwsError";
    this.code = code;
  }
}

/**
 * Inspect combined stderr/stdout text and classify into an AwsError code.
 * Ordered most-specific-first so that, for example, an expired SSO token is
 * not misread as a generic access-denied.
 * @param {string} text
 * @returns {"EXPIRED"|"ACCESS_DENIED"|"NOT_FOUND"|"UNKNOWN"}
 */
function classifyError(text) {
  const t = (text || "").toLowerCase();
  if (
    t.includes("token has expired") ||
    t.includes("expiredtoken") ||
    (t.includes("session token") && t.includes("expired")) ||
    (t.includes("sso") && t.includes("expired")) ||
    t.includes("the sso session associated") ||
    t.includes("error loading sso token") ||
    t.includes("expired")
  ) {
    return "EXPIRED";
  }
  if (
    t.includes("accessdenied") ||
    t.includes("access denied") ||
    t.includes("not authorized") ||
    t.includes("unauthorizedoperation")
  ) {
    return "ACCESS_DENIED";
  }
  if (
    t.includes("does not exist") ||
    t.includes("not found") ||
    t.includes("resourcenotfound") ||
    t.includes("nosuch") ||
    t.includes("validationerror") && t.includes("does not exist")
  ) {
    return "NOT_FOUND";
  }
  return "UNKNOWN";
}

/**
 * Run an `aws` command.
 * Adds --profile/--region/--output json as appropriate.
 * @param {string[]} args  positional aws args, e.g. ["sts","get-caller-identity"]
 * @param {{ profile?: string, region?: string, json?: boolean }} [opts]
 * @returns {object|string} parsed JSON when json=true, raw string otherwise.
 * @throws {AwsError}
 */
export function aws(args, { profile, region, json = true } = {}) {
  const full = [...args];
  if (profile) full.push("--profile", profile);
  if (region) full.push("--region", region);
  if (json) full.push("--output", "json");

  let res;
  try {
    res = spawnSync("aws", full, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new AwsError(`failed to spawn aws: ${err.message}`, "UNKNOWN");
  }

  if (res.error) {
    if (res.error.code === "ENOENT") {
      throw new AwsError("aws CLI not found on PATH", "CLI_MISSING");
    }
    throw new AwsError(`aws spawn error: ${res.error.message}`, "UNKNOWN");
  }

  if (res.status !== 0) {
    const text = `${res.stderr || ""}\n${res.stdout || ""}`.trim();
    throw new AwsError(text || `aws exited ${res.status}`, classifyError(text));
  }

  const stdout = res.stdout || "";
  if (!json) return stdout;
  if (stdout.trim() === "") return {};
  try {
    return JSON.parse(stdout);
  } catch {
    throw new AwsError(`aws returned non-JSON output: ${stdout.slice(0, 200)}`, "UNKNOWN");
  }
}

/**
 * Validate an SSO/credentials session via sts get-caller-identity.
 * Never throws for the expected expired/denied case; returns valid=false.
 * @param {string} profile
 * @returns {{ valid: boolean, account?: string, arn?: string, userId?: string }}
 */
export function checkSso(profile) {
  try {
    const id = aws(["sts", "get-caller-identity"], { profile });
    return {
      valid: true,
      account: id.Account,
      arn: id.Arn,
      userId: id.UserId,
    };
  } catch (err) {
    if (err instanceof AwsError && (err.code === "EXPIRED" || err.code === "ACCESS_DENIED")) {
      return { valid: false };
    }
    if (err instanceof AwsError && err.code === "CLI_MISSING") {
      throw err;
    }
    // Any other failure means we could not confirm a valid session.
    return { valid: false };
  }
}

/**
 * List the account's enabled regions so discovery never depends on a guessed
 * primary region. Prefers the Account API (authoritative, carries opt-in
 * status); falls back to EC2 DescribeRegions; returns [] when neither is
 * permitted so the caller can fall back to its own static region set.
 * Never throws: a missing permission must not abort discovery.
 * @param {string} profile
 * @param {string} [fallbackRegion]  region endpoint for the EC2 fallback call
 * @returns {string[]} enabled region names, or [] when enumeration fails
 */
export function listEnabledRegions(profile, fallbackRegion) {
  // Account API: returns only ENABLED + ENABLED_BY_DEFAULT regions.
  try {
    const res = aws(
      ["account", "list-regions", "--region-opt-status-contains", "ENABLED", "ENABLED_BY_DEFAULT"],
      { profile },
    );
    const regions = (res?.Regions || []).map((r) => r.RegionName).filter(Boolean);
    if (regions.length) return regions;
  } catch {
    // Account API not permitted or unavailable: try EC2 next.
  }

  // EC2 fallback: DescribeRegions, dropping regions the account has not opted into.
  try {
    const res = aws(["ec2", "describe-regions"], { profile, region: fallbackRegion });
    const regions = (res?.Regions || [])
      .filter((r) => r.OptInStatus !== "not-opted-in")
      .map((r) => r.RegionName)
      .filter(Boolean);
    if (regions.length) return regions;
  } catch {
    // Neither API available: caller keeps its static region set.
  }

  return [];
}
