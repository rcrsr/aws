#!/usr/bin/env node
// awsx.mjs
// CLI dispatcher for the aws-cli plugin. Routes argv[2] to subcommands, wires
// the lib modules, prints the exact aws commands before live calls, and maps
// AwsError codes to exit codes per the contract. ESM, node builtins only.

import { pathToFileURL } from "node:url";

import { out, errOut } from "./lib/utils.mjs";
import { AwsError, checkSso } from "./lib/awscli.mjs";
import { resolveEnv, setEnv, loadProfileMap, listEnvs } from "./lib/profiles.mjs";
import { discover } from "./lib/discover.mjs";
import { resolveRole } from "./lib/resolve.mjs";
import { runGuardHook } from "./lib/guard.mjs";

/**
 * Exit codes:
 *   0  success
 *   1  drift detected (discover --check) or generic command failure
 *   2  guard block (handled inside runGuardHook)
 *   3  expired SSO session (caller must run `aws sso login`)
 *   4  usage error (unknown subcommand / bad flags)
 */
const EXIT = {
  OK: 0,
  FAIL: 1,
  GUARD_BLOCK: 2,
  EXPIRED: 3,
  USAGE: 4,
};

/**
 * Parse argv flags into a simple bag.
 * Supports "--flag value", "--flag=value", and boolean "--flag".
 * Positional (non-flag) args are collected in order under `_`.
 * @param {string[]} argv  args AFTER the subcommand
 * @returns {{ _: string[], [k: string]: string|boolean|string[] }}
 */
export function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      flags._.push(tok);
    }
  }
  return flags;
}

/**
 * Require a flag value, throwing a usage error when absent.
 * @param {object} flags
 * @param {string} name
 * @returns {string}
 */
function requireFlag(flags, name) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") {
    throw new UsageError(`missing required flag --${name}`);
  }
  return v;
}

/**
 * Usage error type so the dispatcher can map to exit code 4.
 */
class UsageError extends Error {}

const USAGE = `awsx <subcommand> [flags]

Subcommands:
  whoami   --env <e>                       validate SSO + print identity
  discover --env <e> [--check]             build/diff .claude/aws-stack.md
  resolve  <role> --env <e> [--json]       resolve a role to its live arn/id
  profiles list                            list env -> profile/region
  profiles set <env> <profile> <region>    set an env entry
  guard                                    PreToolUse hook (stdin-driven)`;

/**
 * whoami: resolve env, validate the SSO session, print identity.
 * On invalid SSO, print the exact `aws sso login --profile <p>` command and
 * exit with the EXPIRED code.
 * @param {object} flags
 * @returns {number} exit code
 */
function cmdWhoami(flags) {
  const env = requireFlag(flags, "env");
  const { profile, region } = resolveEnv(env);

  out(`+ aws sts get-caller-identity --profile ${profile} --region ${region} --output json`);
  const sso = checkSso(profile);

  out(`env:     ${env}`);
  out(`profile: ${profile}`);
  out(`region:  ${region}`);

  if (!sso.valid) {
    out("sso:     INVALID (session expired or no credentials)");
    out("");
    out("Run this to refresh your session:");
    out(`  aws sso login --profile ${profile}`);
    return EXIT.EXPIRED;
  }

  out("sso:     VALID");
  out(`account: ${sso.account ?? ""}`);
  out(`arn:     ${sso.arn ?? ""}`);
  out(`userId:  ${sso.userId ?? ""}`);
  return EXIT.OK;
}

/**
 * discover: build or diff the committed stack cheat sheet.
 * --check exits 1 when drift is detected, 0 when in sync.
 * @param {object} flags
 * @returns {number} exit code
 */
function cmdDiscover(flags) {
  const env = requireFlag(flags, "env");
  const check = flags.check === true || flags.check === "true";

  const result = discover({ env, check });

  if (check) {
    if (result.drift) {
      out("drift: DETECTED");
      if (result.diff) {
        out("");
        out(result.diff);
      }
      return EXIT.FAIL;
    }
    out("drift: none (.claude/aws-stack.md in sync)");
    return EXIT.OK;
  }

  out(`written: .claude/aws-stack.md`);
  out(`services: ${result.model.services.length}`);
  out(`environments: ${result.model.environments.length}`);
  out(`roles: ${result.model.roles.length}`);
  return EXIT.OK;
}

/**
 * resolve: resolve a role to its current live arn/id.
 * @param {object} flags
 * @returns {number} exit code
 */
function cmdResolve(flags) {
  const role = flags._[0];
  if (!role) throw new UsageError("missing <role> positional argument");
  const env = requireFlag(flags, "env");
  const asJson = flags.json === true || flags.json === "true";

  const result = resolveRole(role, env);

  if (asJson) {
    out(JSON.stringify(result));
    return EXIT.OK;
  }

  out(`role:    ${role}`);
  out(`service: ${result.service}`);
  if (result.arn) out(`arn:     ${result.arn}`);
  if (result.id) out(`id:      ${result.id}`);
  out(`profile: ${result.profile}`);
  out(`region:  ${result.region}`);
  return EXIT.OK;
}

/**
 * profiles: list or set env entries.
 * @param {object} flags
 * @returns {number} exit code
 */
function cmdProfiles(flags) {
  const action = flags._[0];

  if (action === "list") {
    const map = loadProfileMap();
    const envs = listEnvs();
    if (envs.length === 0) {
      out("(no environments configured in .claude/aws-profiles.local.json)");
      return EXIT.OK;
    }
    out("ENV        PROFILE                 REGION");
    for (const env of envs) {
      const { profile, region } = map[env];
      out(`${env.padEnd(10)} ${String(profile).padEnd(23)} ${region}`);
    }
    return EXIT.OK;
  }

  if (action === "set") {
    const [, env, profile, region] = flags._;
    if (!env || !profile || !region) {
      throw new UsageError("usage: awsx profiles set <env> <profile> <region>");
    }
    setEnv(env, profile, region);
    out(`set ${env} -> profile=${profile} region=${region}`);
    return EXIT.OK;
  }

  throw new UsageError("usage: awsx profiles <list|set> ...");
}

/**
 * Map a thrown AwsError to an exit code, printing guidance. EXPIRED prints the
 * `aws sso login` command using the profile from the active env when known.
 * @param {AwsError} err
 * @param {string|null} profile
 * @returns {number} exit code
 */
function handleAwsError(err, profile) {
  switch (err.code) {
    case "EXPIRED":
      errOut(`[awsx] SSO session expired: ${err.message}`);
      if (profile) {
        errOut("Refresh your session:");
        errOut(`  aws sso login --profile ${profile}`);
      } else {
        errOut("Refresh your session with: aws sso login --profile <profile>");
      }
      return EXIT.EXPIRED;
    case "CLI_MISSING":
      errOut("[awsx] aws CLI not found on PATH. Install the AWS CLI v2.");
      return EXIT.FAIL;
    case "ACCESS_DENIED":
      errOut(`[awsx] access denied: ${err.message}`);
      return EXIT.FAIL;
    case "NOT_FOUND":
      errOut(`[awsx] not found: ${err.message}`);
      return EXIT.FAIL;
    default:
      errOut(`[awsx] aws error: ${err.message}`);
      return EXIT.FAIL;
  }
}

/**
 * Best-effort lookup of the profile for an --env flag, for error messaging.
 * @param {object} flags
 * @returns {string|null}
 */
function profileForFlags(flags) {
  const env = flags.env;
  if (typeof env !== "string" || env === "") return null;
  try {
    return resolveEnv(env).profile;
  } catch {
    return null;
  }
}

/**
 * Dispatch a parsed argv. Returns an exit code; guard handles its own exit.
 * @param {string[]} argv  full process.argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const sub = argv[2];
  const rest = argv.slice(3);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    out(USAGE);
    return sub ? EXIT.OK : EXIT.USAGE;
  }

  // The guard hook is stdin-driven and manages its own process exit.
  if (sub === "guard") {
    await runGuardHook();
    return EXIT.OK; // unreachable; runGuardHook always exits.
  }

  const flags = parseFlags(rest);

  try {
    switch (sub) {
      case "whoami":
        return cmdWhoami(flags);
      case "discover":
        return cmdDiscover(flags);
      case "resolve":
        return cmdResolve(flags);
      case "profiles":
        return cmdProfiles(flags);
      default:
        errOut(`unknown subcommand: ${sub}`);
        out(USAGE);
        return EXIT.USAGE;
    }
  } catch (err) {
    if (err instanceof AwsError) {
      return handleAwsError(err, profileForFlags(flags));
    }
    if (err instanceof UsageError) {
      errOut(`[awsx] ${err.message}`);
      out(USAGE);
      return EXIT.USAGE;
    }
    errOut(`[awsx] ${err?.message || err}`);
    return EXIT.FAIL;
  }
}

// Run only when invoked directly, not when imported by the test file.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv).then((code) => process.exit(code));
}
