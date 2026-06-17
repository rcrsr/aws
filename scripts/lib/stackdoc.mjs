// stackdoc.mjs
// Render and parse the committed abstract architecture cheat sheet at
// .claude/aws-stack.md. The document is intentionally id-free: it carries
// only services, environment labels, and role->handle bindings. Concrete
// ARNs, resource ids, and account numbers NEVER appear here; they resolve
// live via resolve.mjs.
//
// renderStackDoc(model) and parseStackDoc(md) must round-trip: parsing the
// output of render yields an equivalent model.

import { paths, fileExists } from "./utils.mjs";
import { readFileSync } from "node:fs";

/**
 * @typedef {Object} StackRole
 * @property {string} name
 * @property {string} service
 * @property {string} description
 * @property {"tag"|"logicalId"|"namePattern"} handleType
 * @property {string} handle
 */

/**
 * @typedef {Object} StackEntry
 * @property {string} name abstracted, env-agnostic stack name
 * @property {string} description one-line functional summary
 */

/**
 * @typedef {Object} StackModel
 * @property {string[]} services
 * @property {string[]} environments
 * @property {StackEntry[]} stacks
 * @property {StackRole[]} roles
 * @property {string} [architecture] hand-authored prose block (verbatim
 *   markdown, including any ASCII diagram). Preserved across re-renders so the
 *   skill's repo-inferred architecture narrative survives discovery re-runs.
 */

const HANDLE_LABELS = {
  tag: "tag",
  logicalId: "logicalId",
  namePattern: "namePattern",
};

/**
 * Escape a value for safe inclusion inside a markdown table cell.
 * Pipes would otherwise break column boundaries; newlines collapse to spaces.
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Reverse escapeCell for a single table cell.
 * @param {string} value
 * @returns {string}
 */
function unescapeCell(value) {
  return String(value ?? "")
    .replace(/\\\|/g, "|")
    .trim();
}

/**
 * Format a single role into the "Handle" column: "<handleType>: <handle>".
 * @param {StackRole} role
 * @returns {string}
 */
function formatHandle(role) {
  const type = HANDLE_LABELS[role.handleType] || "namePattern";
  return `${type}: ${escapeCell(role.handle)}`;
}

/**
 * Split a markdown table row body into cells on UNescaped pipes only, so an
 * escaped "\|" inside a cell survives as literal content.
 * @param {string} inner row text with leading/trailing border pipes removed
 * @returns {string[]}
 */
function splitRow(inner) {
  const cells = [];
  let buf = "";
  const s = String(inner ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells;
}

/**
 * Parse a "Handle" column value back into { handleType, handle }.
 * Accepts "tag: foo", "logicalId: Bar", "namePattern: baz*".
 * Unknown prefixes fall back to namePattern with the whole string as handle.
 * @param {string} cell
 * @returns {{ handleType: "tag"|"logicalId"|"namePattern", handle: string }}
 */
function parseHandle(cell) {
  const raw = unescapeCell(cell);
  const idx = raw.indexOf(":");
  if (idx === -1) {
    return { handleType: "namePattern", handle: raw };
  }
  const type = raw.slice(0, idx).trim();
  const handle = raw.slice(idx + 1).trim();
  if (type === "tag" || type === "logicalId" || type === "namePattern") {
    return { handleType: type, handle };
  }
  return { handleType: "namePattern", handle: raw };
}

/**
 * Render the stack model as deterministic markdown.
 * Sections: # AWS Stack, ## Overview, ## Stacks, ## Environments, ## Roles,
 * ## Data Flow, ## Services. No ids/arns/account numbers are emitted.
 * @param {StackModel} model
 * @returns {string}
 */
export function renderStackDoc(model) {
  const services = Array.isArray(model?.services) ? model.services : [];
  const environments = Array.isArray(model?.environments) ? model.environments : [];
  const stacks = Array.isArray(model?.stacks) ? model.stacks : [];
  const roles = Array.isArray(model?.roles) ? model.roles : [];

  const lines = [];

  lines.push("# AWS Stack");
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  lines.push(
    "Abstract architecture cheat sheet. Contains no ARNs, resource ids, or " +
      "account numbers. Concrete identifiers resolve live per call via the " +
      "aws-cli plugin.",
  );
  lines.push("");
  lines.push(`- Stacks: ${stacks.length}`);
  lines.push(`- Services: ${services.length}`);
  lines.push(`- Environments: ${environments.length}`);
  lines.push(`- Roles: ${roles.length}`);
  lines.push("");

  lines.push("## Stacks");
  lines.push("");
  lines.push(
    "Functional overview of the deployed stacks, one bullet per stack. " +
      "Descriptions are auto-seeded on discovery and preserved across re-runs, " +
      "so hand-written summaries survive drift checks.",
  );
  lines.push("");
  if (stacks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const stack of stacks) {
      const name = escapeCell(stack?.name);
      const description = escapeCell(stack?.description);
      lines.push(`- **${name}**: ${description}`);
    }
  }
  lines.push("");

  // Optional hand-authored architecture narrative. Emitted verbatim (no cell
  // escaping) so ASCII diagrams and bullets render as written. Preserved across
  // re-renders via parseStackDoc, so discovery re-runs do not wipe the prose.
  const architecture =
    typeof model?.architecture === "string" ? model.architecture.trim() : "";
  if (architecture) {
    lines.push("## Architecture");
    lines.push("");
    lines.push(architecture);
    lines.push("");
  }

  lines.push("## Environments");
  lines.push("");
  lines.push("Environment labels only. Profiles, regions, and account numbers");
  lines.push("live in the git-ignored aws-profiles.local.json, not here.");
  lines.push("");
  if (environments.length === 0) {
    lines.push("- (none)");
  } else {
    for (const env of environments) {
      lines.push(`- ${escapeCell(env)}`);
    }
  }
  lines.push("");

  lines.push("## Roles");
  lines.push("");
  lines.push("| Role | Service | Description | Handle |");
  lines.push("| --- | --- | --- | --- |");
  for (const role of roles) {
    const name = escapeCell(role?.name);
    const service = escapeCell(role?.service);
    const description = escapeCell(role?.description);
    const handle = formatHandle({
      handleType: role?.handleType,
      handle: role?.handle,
    });
    lines.push(`| ${name} | ${service} | ${description} | ${handle} |`);
  }
  lines.push("");

  lines.push("## Data Flow");
  lines.push("");
  lines.push("Resolution is live and account-authoritative. Each call:");
  lines.push("");
  lines.push("1. Reads a role's abstract handle from this document.");
  lines.push("2. Maps the requested env to a profile/region locally.");
  lines.push("3. Fires one targeted aws query to resolve the current id.");
  lines.push("");

  lines.push("## Services");
  lines.push("");
  if (services.length === 0) {
    lines.push("- (none)");
  } else {
    for (const service of services) {
      lines.push(`- ${escapeCell(service)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Parse a markdown document produced by renderStackDoc back into a model.
 * Tolerant of surrounding whitespace; round-trips render output exactly.
 * @param {string} md
 * @returns {StackModel}
 */
export function parseStackDoc(md) {
  const text = String(md ?? "");
  const lines = text.split(/\r?\n/);

  /** @type {string|null} */
  let section = null;
  const services = [];
  const environments = [];
  /** @type {StackEntry[]} */
  const stacks = [];
  /** @type {StackRole[]} */
  const roles = [];
  /** @type {string[]} raw lines captured under ## Architecture, verbatim */
  const architectureLines = [];

  let inRoleTable = false;
  let roleHeaderSeen = false;

  const bulletItem = (line) => {
    const m = line.match(/^-\s+(.*)$/);
    if (!m) return null;
    const value = unescapeCell(m[1]);
    if (value === "(none)") return null;
    return value;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      inRoleTable = false;
      roleHeaderSeen = false;
      continue;
    }
    if (/^#\s+/.test(line)) {
      // Top-level title; not a section.
      continue;
    }

    if (section === "architecture") {
      // Capture the raw (untrimmed) line so ASCII diagrams and indentation in
      // the hand-authored narrative survive a parse->render round-trip.
      architectureLines.push(rawLine);
      continue;
    }

    if (section === "environments") {
      const item = bulletItem(line);
      if (item !== null) environments.push(item);
      continue;
    }

    if (section === "services") {
      const item = bulletItem(line);
      if (item !== null) services.push(item);
      continue;
    }

    if (section === "stacks") {
      // "- **<name>**: <description>"; tolerates an empty description.
      const m = line.match(/^-\s+\*\*(.+?)\*\*:\s?(.*)$/);
      if (m) {
        stacks.push({
          name: unescapeCell(m[1]),
          description: unescapeCell(m[2]),
        });
      }
      continue;
    }

    if (section === "roles") {
      if (!line.startsWith("|")) {
        inRoleTable = false;
        continue;
      }
      // Split table row into cells on UNescaped pipes only, so escaped "\|"
      // inside a cell survives. Drops the leading/trailing border pipes.
      const inner = line.slice(1, line.endsWith("|") ? -1 : undefined);
      const cells = splitRow(inner).map((c) => c.trim());

      // Header row.
      if (!roleHeaderSeen) {
        roleHeaderSeen = true;
        inRoleTable = true;
        continue;
      }
      // Separator row of dashes.
      if (cells.every((c) => /^:?-{1,}:?$/.test(c) || c === "")) {
        continue;
      }
      if (!inRoleTable) continue;
      if (cells.length < 4) continue;

      const { handleType, handle } = parseHandle(cells[3]);
      roles.push({
        name: unescapeCell(cells[0]),
        service: unescapeCell(cells[1]),
        description: unescapeCell(cells[2]),
        handleType,
        handle,
      });
      continue;
    }
  }

  // Trim leading/trailing blank lines from the captured narrative. Only attach
  // the key when prose exists, so an architecture-free doc round-trips to a
  // model without the field (keeps the empty-model deepEqual stable).
  const architecture = architectureLines.join("\n").replace(/^\s+|\s+$/g, "");

  const model = { services, environments, stacks, roles };
  if (architecture) model.architecture = architecture;
  return model;
}

/**
 * Load and parse the committed stack document, if present.
 * @returns {StackModel|null} null when the file does not exist.
 */
export function loadStackModel() {
  const { stackDoc } = paths();
  if (!fileExists(stackDoc)) return null;
  try {
    const md = readFileSync(stackDoc, "utf8");
    return parseStackDoc(md);
  } catch {
    return null;
  }
}
