---
name: migrate-v1-to-v2
description: Migrate a NanoClaw v1 install to v2. v2 is a ground-up rewrite — new DB schema, new entity model (users/roles/DMs), channels moved off trunk, npm→pnpm, Node→Bun container, credential proxy → OneCLI. Runs a structured worktree-based flow (`pnpm run migrate:v1-to-v2`) that extracts v1 state, seeds v2's central DB, and hands off to Claude for any source customizations that need rebuilding. Triggers on "migrate to v2", "upgrade to v2", "v1 to v2".
---

# Migrate v1 → v2

This skill is a **hybrid flow**, modeled on `setup:auto`: the heavy lifting is a scripted driver (`setup/migrate.ts`), and this markdown's job is to orient you before handing control over to it.

The driver owns the visible UX — spinners, notes, prompts — and emits a progression log at `logs/setup.log`. You stay available in two specific spots:

1. **On failure**, the driver calls `offerClaudeAssist()` which spawns `claude -p` non-interactively to diagnose and suggest a command. If the user accepts, the driver re-runs the failed step.
2. **For the rebuild step**, the driver calls `offerClaudeHandoff()` which spawns interactive Claude with the migration guide pre-loaded as a system-prompt append. The user types `/exit` in Claude when they're done to return to the flow.

Your role when this skill is invoked is to (a) decide whether this is actually the right skill, (b) set up the v2 worktree, (c) start the driver, and (d) stay available for handoffs as Claude.

## When to use this skill

Trigger: the user is on v1 (NanoClaw < 2.0.0) and wants to move to v2 (≥ 2.0.0).

Diagnose by running these in parallel:

```
ls -la store/messages.db       # v1 DB — should exist
ls -la data/v2.db              # v2 DB — should NOT exist
grep -E "^\s*\"version\":" package.json
```

| Signal | Skill |
|---|---|
| `store/messages.db` exists + `package.json` version `1.x` | **this skill** |
| `data/v2.db` exists, user wants routine upgrade | `/update-nanoclaw` |
| Fresh clone, no install state | `/setup` or `bash nanoclaw.sh` |
| Heavily customized fork, user already on v2, wants clean-base replay | `/migrate-nanoclaw` |

If the user is on v1 but has limited customizations (just channel skills + some CLAUDE.md edits), this skill is still the right tool — the structural break is what matters, not the size of the diff.

## Flow overview

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  v1 install │───▶│  v2 worktree │───▶│  swap (user) │
│  (stay put) │    │ (.migrate-…) │    │  v2 worktree │
└─────────────┘    └──────────────┘    │ replaces v1  │
     reads only       seed + build     └──────────────┘
```

1. Add `upstream` remote if missing, fetch.
2. `git worktree add .migrate-worktree upstream/v2 --detach` (branch name may vary — check `git branch -r | grep v2`).
3. `cd .migrate-worktree && pnpm install --frozen-lockfile`.
4. Install channel skills matching what v1 used (see `v1-data/summary.md` after extract) via `/add-<name>` inside the worktree.
5. `pnpm run migrate:v1-to-v2` — runs the scripted driver.
6. Run `/init-onecli` inside the worktree to move credentials into the OneCLI vault.
7. `./container/build.sh` inside the worktree — forces a fresh Bun-based image.
8. Live-smoke-test from the worktree with symlinked data dirs (see driver outro).
9. Swap: rename v1 data dirs to `.v1-backup`, remove the worktree, `git reset --hard <upgrade-commit>` in the original tree, restore `.nanoclaw-migrations/`.
10. Restart service.

Steps 5 + 6 + 7 are where the driver does most of its work. Steps 1–4 and 8–10 are things you orchestrate.

## What the driver does

`setup/migrate.ts` runs these steps in order (each is skippable via `NANOCLAW_MIGRATE_SKIP=step1,step2,…`):

| Step | What it does | Can fail? |
|---|---|---|
| `preflight` | Detect v1/v2/mixed/fresh; dirty-tree check on v1 | yes → abort |
| `extract` | Read `store/messages.db`, `.env` (non-secret keys), `~/.config/nanoclaw/*`, git log. Write `.nanoclaw-migrations/v1-data/*.json` into the v1 tree | yes → claude-assist |
| `owner` | Confirm/prompt for owner user_id (with `?` → handoff if unknown) | no (prompts until answered) |
| `guide` | Compose `.nanoclaw-migrations/guide.md` from extracted state | yes → claude-assist |
| `safety` | `git tag pre-v2-<hash>-<ts>` + backup branch in v1 tree | no |
| `seed` | Run migrations + seed v2 central DB from v1-data | yes → claude-assist + retry |
| `copy` | Copy v1 `groups/<folder>/CLAUDE.md` → v2 `CLAUDE.local.md`; user-authored skills; additive `.env` merge; append `NANOCLAW_ADMIN_USER_IDS` | no |
| `rebuild` | For customized source files, offer **interactive Claude handoff** with the guide + customization list pre-loaded | user-skippable |
| `verify` | `pnpm run build && pnpm test` in the worktree; on failure, claude-assist | yes → claude-assist |

The driver does **not** run the swap. That's left to the user after they've live-smoke-tested from the worktree, because the swap is destructive and benefits from human judgement.

## Key v1 → v2 mappings the driver handles

- `registered_groups.folder` → `agent_groups` (dedupe — one AG per unique folder, may span multiple JIDs)
- `registered_groups.jid` → `messaging_groups` (channel_type inferred from JID; `wechat` added post-v2.0)
- `registered_groups.trigger_pattern` + `requires_trigger` → `messaging_group_agents.engage_mode` + `engage_pattern` (new in v2.0: replaces `trigger_rules` JSON column; see migration 010)
- `registered_groups.container_config` (DB column) → `groups/<folder>/container.json` (new shape — `skills: 'all'` default)
- `sender-allowlist.json` explicit entries → `users` + `agent_group_members`
- Owner (inferred from `.env` / `is_main` / single allowlist entry, or prompted) → `users` + `user_roles(owner)` + `user_dms` + `NANOCLAW_ADMIN_USER_IDS`
- v1 `groups/<folder>/CLAUDE.md` → v2 `groups/<folder>/CLAUDE.local.md` (v2 regenerates `CLAUDE.md` at spawn via `composeGroupClaudeMd()`)
- `scheduled_tasks` → deferred (v2 stores them in per-session `messages_in` rows, not central DB — driver writes them out for the agent to recreate via its scheduling tool on first contact)

## Orchestration playbook

When the user says "migrate to v2":

1. Run the diagnosis commands above. If this isn't a v1 install, redirect to the right skill.
2. Check that the user has committed or stashed any pending changes in the v1 tree. Offer to do this for them.
3. Add the `upstream` remote if missing (default URL: `https://github.com/qwibitai/nanoclaw.git`). Fetch.
4. Determine the v2 ref — prefer an explicit v2 release tag if available (e.g. `v2.0.0`), else `upstream/v2`, else `upstream/main` if v2 has already been merged.
5. Create the worktree: `git worktree add .migrate-worktree <v2-ref> --detach`.
6. `cd .migrate-worktree && pnpm install --frozen-lockfile`.
7. Start the driver: `cd .migrate-worktree && pnpm run migrate:v1-to-v2 -- --v1-root <v1-abs-path>` (the driver defaults `--v1-root` to `..` when run from a worktree dir named `.migrate-worktree`, so the flag is usually optional).
8. **Stay available for the driver's handoff calls.** The driver uses `claude -p` for failures and interactive `claude` for the rebuild step. When the user returns from an interactive handoff, they'll be back in the driver flow.
9. After the driver completes, walk the user through the remaining manual steps (install channel skills if they weren't already, `/init-onecli`, `./container/build.sh`, live smoke test, swap, service restart).

## When to hand off to Claude mid-flow

The driver invokes Claude automatically in these situations:

- **Any step fails** — `offerClaudeAssist` spawns `claude -p` with the step name, error message, and a short list of file references. The user sees a suggested command in a clack note and can run it (via `setup/run-suggested.sh`). If they accept, the driver re-runs the failing step.
- **Owner is ambiguous** — if the driver can't infer an owner and the user types `?` at the prompt, it opens interactive Claude with the extracted JSONs as context.
- **Rebuild step** — always prompts "Hand off to Claude now?"; if yes, spawns interactive Claude with `guide.md` + `git-customizations.json` + `docs/module-contract.md` + `docs/architecture.md` pre-loaded.

You (the orchestrating Claude for this skill) can also proactively offer to `cat` the migration guide and discuss it with the user between the driver's `guide` and `safety` steps. That's outside the driver's control — the user can always pause the flow with Ctrl-C and resume later via `NANOCLAW_MIGRATE_SKIP`.

## Rollback

Pre-migration tag is always created in step `safety`. After swap, the user can fully undo with:

```bash
git reset --hard pre-v2-<hash>-<ts>
rm -f data/v2.db
mv store.v1-backup store 2>/dev/null || true
mv data/ipc.v1-backup data/ipc 2>/dev/null || true
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

Before swap, rollback is trivial — just delete the worktree and ignore `.nanoclaw-migrations/`.

## Extending

The driver lives at `setup/migrate.ts`; library code at `setup/migrate/`. Mirrors `setup/auto.ts` + `setup/channels/` — look there for the pattern if you need to add a step (e.g. a dedicated step for moving WhatsApp Baileys auth state, or for running `scripts/init-first-agent.ts` against the seeded rows).

Reuses `setup/lib/{runner,claude-assist,claude-handoff,theme}.ts` directly — those primitives don't know anything specific to setup-vs-migrate.
