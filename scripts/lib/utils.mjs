// utils.mjs
// Shared filesystem and path helpers for the aws-cli plugin.
// No external npm deps; node builtins only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the consumer repo root.
 * Prefers CLAUDE_PROJECT_DIR (set by Claude Code), falls back to cwd.
 * @returns {string}
 */
export function consumerRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Canonical paths for the two persistent artifacts written into the
 * consumer repo (never into the plugin directory).
 * @returns {{ root: string, claudeDir: string, stackDoc: string, profileMap: string }}
 */
export function paths() {
  const root = consumerRoot();
  const claudeDir = join(root, ".claude");
  return {
    root,
    claudeDir,
    stackDoc: join(claudeDir, "aws-stack.md"),
    profileMap: join(claudeDir, "aws-profiles.local.json"),
  };
}

/**
 * Read and parse a JSON file.
 * @param {string} path
 * @returns {object|null} parsed object, or null if missing/unreadable/invalid.
 */
export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write an object as pretty-printed JSON, creating parent dirs as needed.
 * @param {string} path
 * @param {object} obj
 * @returns {void}
 */
export function writeJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function fileExists(path) {
  return existsSync(path);
}

/**
 * Create a directory recursively if it does not exist.
 * @param {string} path
 * @returns {void}
 */
export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Write a line to stdout.
 * @param {string} msg
 */
export function out(msg) {
  process.stdout.write(String(msg) + "\n");
}

/**
 * Write a line to stderr.
 * @param {string} msg
 */
export function errOut(msg) {
  process.stderr.write(String(msg) + "\n");
}
