// guard.mjs
// Command guardrail for the PreToolUse Bash hook.
//
// Two layers:
//   classify(command)        -> structural analysis of a single shell command
//   decide(command, opts)    -> allow/block policy on top of classify
//   runGuardHook()           -> stdin-driven entrypoint used by hooks.json
//
// Design goals:
//   - Fail safe: when unsure whether an aws command mutates, lean toward the
//     higher tier so destructive intent is never silently allowed.
//   - Be precise: only aws commands are policed; everything else passes.

import { allowedProfiles } from "./profiles.mjs";
import { errOut } from "./utils.mjs";

/**
 * Tokenize a command line into bare words, stripping surrounding quotes.
 * This is a deliberately simple split. It is good enough to identify the
 * aws service, verb, and flags. It is NOT a full shell parser.
 * @param {string} command
 * @returns {string[]}
 */
function tokenize(command) {
  // Match single-quoted, double-quoted, or unquoted runs.
  const matches = command.match(/'[^']*'|"[^"]*"|[^\s]+/g) || [];
  return matches.map((tok) => {
    if (
      (tok.startsWith("'") && tok.endsWith("'")) ||
      (tok.startsWith('"') && tok.endsWith('"'))
    ) {
      return tok.slice(1, -1);
    }
    return tok;
  });
}

/**
 * Extract the value of a --profile flag, supporting both
 * "--profile foo" and "--profile=foo" forms.
 * @param {string[]} tokens
 * @returns {string|null}
 */
function extractProfile(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--profile") {
      return tokens[i + 1] || null;
    }
    if (t.startsWith("--profile=")) {
      return t.slice("--profile=".length) || null;
    }
  }
  return null;
}

/**
 * Locate the aws invocation inside a (possibly compound) command and return
 * the tokens starting at the `aws` word. Handles a leading "cd ... && aws ..."
 * style prefix and simple env-var assignments before the binary.
 * @param {string[]} tokens
 * @returns {string[]|null} tokens from `aws` onward, or null if no aws call.
 */
function locateAws(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "aws") {
      // Ensure it is a real command position, i.e. the previous token is a
      // shell separator, an env assignment, or it is the first token.
      const prev = tokens[i - 1];
      if (
        i === 0 ||
        prev === "&&" ||
        prev === "||" ||
        prev === ";" ||
        prev === "|" ||
        (prev && prev.includes("="))
      ) {
        return tokens.slice(i);
      }
    }
  }
  return null;
}

// Tier-0 read verbs. Pure inspection, no state change.
// Matched against the verb token (the subcommand after the service).
const READ_VERB_RE = /^(describe|describe-.*|list|list-.*|get|get-.*|tail|filter-log-events|ls|search|lookup-events|head-.*|batch-get-.*|scan|query|select|view-.*|show-.*|wait)$/;

// Tier-2 destructive verb patterns. These either delete/terminate resources,
// rewrite security policies, or otherwise carry high blast radius.
const DESTRUCTIVE_VERB_RE = /^(delete|delete-.*|remove-.*|terminate|terminate-.*|rb|rm|destroy|purge-.*|deregister-.*|disable-.*|revoke-.*|detach-.*|reset-.*|cancel-.*)$/;

// Verbs that look like policy writes regardless of the leading word, e.g.
// put-bucket-policy, put-role-policy, update-assume-role-policy.
const POLICY_WRITE_RE = /(^put-.*-policy$|^update-.*-policy$|^attach-.*-policy$|^set-.*-policy$|^delete-.*-policy$)/;

// Tier-1 low-mutate verbs. Invocations and copies that change data but are
// routine and reversible relative to tier-2.
const LOW_MUTATE_VERB_RE = /^(invoke|run-task|run-instances|start-.*|stop-.*|cp|sync|mv|mb|put|put-object|put-.*|create-.*|update-.*|register-.*|tag-.*|untag-.*|publish|send-.*|copy-.*|enable-.*|attach-.*|associate-.*|restore-.*|reboot-.*|modify-.*)$/;

/**
 * Classify a single shell command.
 *
 * Tier meanings:
 *   0 = read-only (describe/list/get/tail/filter-log-events/ls/...)
 *   1 = low mutate (lambda invoke, ecs run-task, s3 cp/sync, generic
 *       put/create/update verbs that are NOT policy writes)
 *   2 = destructive (delete, terminate, remove, rb, policy writes, scale-to-zero)
 *
 * @param {string} command
 * @returns {{ isAws: boolean, tier: 0|1|2, service: string, verb: string, profile: string|null, reasons: string[] }}
 */
export function classify(command) {
  const reasons = [];
  const tokens = tokenize(command || "");
  const awsTokens = locateAws(tokens);

  if (!awsTokens) {
    return { isAws: false, tier: 0, service: "", verb: "", profile: null, reasons: ["not an aws command"] };
  }

  // awsTokens[0] === "aws". The first non-flag token after it is the service,
  // and the next non-flag token is the verb (subcommand).
  const positional = [];
  for (let i = 1; i < awsTokens.length; i++) {
    const t = awsTokens[i];
    if (t.startsWith("-")) {
      // Skip a flag and, when it is the space-separated form, its value too.
      // We cannot perfectly know which flags take values, so we only skip the
      // value when it does not look like another flag. This keeps service/verb
      // detection robust against "--region us-west-2 s3 ls" orderings.
      const next = awsTokens[i + 1];
      if (!t.includes("=") && next && !next.startsWith("-") && positional.length < 2) {
        // Heuristic: known value-taking global flags before the service.
        if (/^--(profile|region|output|endpoint-url|color|ca-bundle|cli-.*)$/.test(t)) {
          i++;
        }
      }
      continue;
    }
    positional.push(t);
    if (positional.length >= 2) break;
  }

  const service = positional[0] || "";
  const verb = positional[1] || "";
  const profile = extractProfile(awsTokens);

  reasons.push(`service=${service || "?"}`, `verb=${verb || "?"}`);

  // Default tier when we cannot match a known pattern: treat as tier-1 mutate.
  // Reading is whitelisted explicitly; anything unrecognized is assumed to
  // change state, which is the safe direction.
  let tier = 1;

  // Order matters: policy writes and destructive verbs win over low-mutate
  // and read matches so we never under-classify a dangerous command.
  if (POLICY_WRITE_RE.test(verb)) {
    tier = 2;
    reasons.push("policy write detected (tier2)");
  } else if (DESTRUCTIVE_VERB_RE.test(verb)) {
    tier = 2;
    reasons.push("destructive verb (tier2)");
  } else if (isScaleToZero(service, verb, awsTokens)) {
    tier = 2;
    reasons.push("scale-to-zero detected (tier2)");
  } else if (READ_VERB_RE.test(verb)) {
    tier = 0;
    reasons.push("read verb (tier0)");
  } else if (LOW_MUTATE_VERB_RE.test(verb)) {
    tier = 1;
    reasons.push("low-mutate verb (tier1)");
  } else if (verb === "") {
    // `aws s3 ls` style: s3 ls is read; bare service with no verb is unknown.
    tier = 1;
    reasons.push("no verb; defaulting to tier1");
  } else {
    reasons.push("unrecognized verb; defaulting to tier1");
  }

  // s3 ls / s3api list-* are reads even though "ls" passes via READ_VERB_RE.
  // s3 rm / s3 rb were already caught as destructive above.

  return { isAws: true, tier, service, verb, profile, reasons };
}

/**
 * Detect a scale-to-zero mutation, e.g.
 *   aws ecs update-service ... --desired-count 0
 *   aws application-autoscaling ... --min-capacity 0 --max-capacity 0
 *   aws autoscaling update-auto-scaling-group ... --desired-capacity 0
 * These are destructive because they take a service to zero running tasks.
 * @param {string} service
 * @param {string} verb
 * @param {string[]} awsTokens
 * @returns {boolean}
 */
function isScaleToZero(service, verb, awsTokens) {
  const flags = ["--desired-count", "--desired-capacity", "--min-capacity", "--min-size"];
  for (let i = 0; i < awsTokens.length; i++) {
    const t = awsTokens[i];
    for (const flag of flags) {
      if (t === flag && awsTokens[i + 1] === "0") return true;
      if (t === `${flag}=0`) return true;
    }
  }
  return false;
}

/**
 * Apply allow/block policy to a command.
 *
 * Rules (in order):
 *   - non-aws command            -> allow
 *   - aws without --profile      -> block (we require explicit profile pinning)
 *   - aws --profile not allowed  -> block
 *   - tier2 (destructive)        -> block unless AWSX_ALLOW_DESTRUCTIVE=1
 *   - tier0/tier1 + allowed      -> allow
 *
 * @param {string} command
 * @param {{ allowedProfiles: string[] }} opts
 * @returns {{ allow: boolean, reason: string }}
 */
export function decide(command, { allowedProfiles: allowed = [] } = {}) {
  const c = classify(command);

  if (!c.isAws) {
    return { allow: true, reason: "non-aws command" };
  }

  if (!c.profile) {
    return {
      allow: false,
      reason: `aws command missing --profile (profile pinning required); ${c.service} ${c.verb}`.trim(),
    };
  }

  if (!allowed.includes(c.profile)) {
    return {
      allow: false,
      reason: `profile '${c.profile}' is not in the allowed set [${allowed.join(", ")}]`,
    };
  }

  if (c.tier === 2) {
    if (process.env.AWSX_ALLOW_DESTRUCTIVE === "1") {
      return {
        allow: true,
        reason: `tier2 destructive allowed via AWSX_ALLOW_DESTRUCTIVE=1 (${c.service} ${c.verb})`,
      };
    }
    return {
      allow: false,
      reason: `tier2 destructive command blocked (${c.service} ${c.verb}); set AWSX_ALLOW_DESTRUCTIVE=1 to override`,
    };
  }

  return {
    allow: true,
    reason: `tier${c.tier} allowed with pinned profile '${c.profile}'`,
  };
}

/**
 * Read stdin fully.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * PreToolUse hook entrypoint.
 * Reads the PreToolUse JSON payload from stdin, extracts
 * .tool_input.command, runs decide(), and:
 *   - on block: writes the reason to stderr and exits 2
 *   - on allow: exits 0
 * Must never throw an uncaught error (that would surface as a hook failure).
 * @returns {Promise<void>}
 */
export async function runGuardHook() {
  try {
    const raw = await readStdin();
    let payload = {};
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // Malformed payload: do not block legitimate work; allow.
      process.exit(0);
      return;
    }

    const command = payload?.tool_input?.command;
    if (typeof command !== "string" || command.trim() === "") {
      // Nothing to police.
      process.exit(0);
      return;
    }

    let allowed = [];
    try {
      allowed = allowedProfiles();
    } catch {
      allowed = [];
    }

    const verdict = decide(command, { allowedProfiles: allowed });
    if (!verdict.allow) {
      errOut(`[awsx guard] BLOCKED: ${verdict.reason}`);
      process.exit(2);
      return;
    }
    process.exit(0);
  } catch (err) {
    // Last-resort safety net. Never crash the hook; allow rather than wedge.
    errOut(`[awsx guard] internal error, allowing: ${err?.message || err}`);
    process.exit(0);
  }
}
