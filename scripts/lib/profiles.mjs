// profiles.mjs
// Read/write the git-ignored env -> {profile, region} map stored in the
// consumer repo at .claude/aws-profiles.local.json.

import { paths, readJson, writeJson } from "./utils.mjs";

/**
 * Load the profile map. Returns {} when the file is absent or unreadable.
 * Schema: { "<env>": { "profile": "<aws-profile>", "region": "<aws-region>" } }
 * @returns {object}
 */
export function loadProfileMap() {
  const { profileMap } = paths();
  return readJson(profileMap) || {};
}

/**
 * List configured environment names.
 * @returns {string[]}
 */
export function listEnvs() {
  return Object.keys(loadProfileMap());
}

/**
 * Resolve an environment to its profile, primary region, and any extra
 * regions. The optional `regions` array lets a stack span regions (e.g. a
 * CloudFront/ACM stack pinned to us-east-1) so discovery can scan them all.
 * @param {string} env
 * @returns {{ profile: string, region: string, regions: string[] }}
 * @throws {Error} when the env is not configured.
 */
export function resolveEnv(env) {
  const map = loadProfileMap();
  const entry = map[env];
  if (!entry || !entry.profile || !entry.region) {
    const known = Object.keys(map).join(", ") || "(none)";
    throw new Error(`env '${env}' not configured in aws-profiles.local.json; known envs: ${known}`);
  }
  const regions = Array.isArray(entry.regions) ? entry.regions : [];
  return { profile: entry.profile, region: entry.region, regions };
}

/**
 * Set (create or overwrite) an environment entry, persisting to disk.
 * @param {string} env
 * @param {string} profile
 * @param {string} region
 * @returns {void}
 */
export function setEnv(env, profile, region) {
  const { profileMap } = paths();
  const map = loadProfileMap();
  map[env] = { profile, region };
  writeJson(profileMap, map);
}

/**
 * Distinct list of allowed AWS profile names across all envs.
 * Used by the guard to enforce profile pinning.
 * @returns {string[]}
 */
export function allowedProfiles() {
  const map = loadProfileMap();
  const set = new Set();
  for (const env of Object.keys(map)) {
    const p = map[env]?.profile;
    if (p) set.add(p);
  }
  return [...set];
}
