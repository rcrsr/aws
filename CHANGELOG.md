# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-06-16

### Changed

- Discovery now scans every enabled region (via `account list-regions`, falling back to `ec2 describe-regions`) instead of only the primary region plus `us-east-1`. A wrong primary-region guess no longer silently hides stacks in other regions. The previous region set (primary, configured extras, `us-east-1`) is retained as a floor when region enumeration is not permitted.

## [1.0.0] - 2026-06-16

### Added

- CLI dispatcher (`scripts/awsx.mjs`) with `whoami`, `discover`, `resolve`, `profiles`, and `guard` subcommands.
- PreToolUse guard hook that classifies every `aws` command into read (tier 0), low-mutate (tier 1), and destructive (tier 2) tiers, blocking tier-2 commands unless `AWSX_ALLOW_DESTRUCTIVE=1`.
- Profile pinning: `aws` commands without an allowed `--profile` are blocked.
- Stack discovery that builds an id-free `.claude/aws-stack.md` from CloudFormation and the Resource Groups Tagging API across regions.
- Live role resolution that maps a role to its current ARN/id via one targeted query, with nothing cached or persisted.
- Git-ignored env→profile map at `.claude/aws-profiles.local.json`.
- Skills: `discover`, `whoami`, `cost`, `logs`, `ecs`, `trigger`, `security-review`, `report-anomalies`, `tagger`.
- Agents: `diagnostician`, `cost-analyst`, `security-auditor`, `cdk-engineer`.
- `node:test` suite covering guard classification, decision policy, stack-doc round-trip, and flag parsing.

[Unreleased]: https://github.com/rcrsr/aws/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/rcrsr/aws/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/rcrsr/aws/releases/tag/v1.0.0
