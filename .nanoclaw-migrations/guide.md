# NanoClaw v1→v2 Migration Guide

Generated: 2026-04-27T00:15:01.482Z
v1 root: `/home/ubuntu/repos/nanoclaw`
v1 HEAD: `1150f7ead1eb41f9524871e33c5a914b5afc9123`
Owner: `telegram:tg:605390177` (confidence: medium, source: is_main group (tg:605390177))

---

## Seed plan

**Agent groups** (1):

- `telegram_main` — T-Bug

**Messaging groups + wirings** (1):

| channel_type | platform_id | folder | engage_mode | engage_pattern |
|---|---|---|---|---|
| telegram | `tg:605390177` | `telegram_main` | pattern | `@Andy` |

## Skills to install (in order)

**Channel skills** (required by seed — the seeder fails if missing):

- [ ] `/add-telegram`

## Reapply-as-is

- Non-secret `.env` keys (already captured in `v1-data/env.json`)
- `groups/<folder>/CLAUDE.md` → v2 `groups/<folder>/CLAUDE.local.md` (v2 regenerates `CLAUDE.md` at spawn; per-group agent memory lives in `.local.md`)
- User-authored skills under `.claude/skills/`: `add-compact`, `add-discord`, `add-emacs`, `add-gmail`, `add-image-vision`, `add-karpathy-llm-wiki`, `add-macos-statusbar`, `add-ollama-tool`, `add-parallel`, `add-pdf-reader`, `add-reactions`, `add-slack`, `add-telegram`, `add-telegram-swarm`, `add-voice-transcription`, `add-whatsapp`, `channel-formatting`, `claw`, `convert-to-apple-container`, `customize`, `debug`, `get-qodo-rules`, `init-onecli`, `migrate-from-openclaw`, `migrate-nanoclaw`, `qodo-pr-resolver`, `setup`, `update-nanoclaw`, `update-skills`, `use-local-whisper`, `use-native-credential-proxy`, `x-integration`

## Translate

- **Triggers** (v1 global `TRIGGER_PATTERN` → per-wiring `engage_mode` + `engage_pattern`) — seeded automatically
- **Container configs** (v1 `registered_groups.container_config` column → `groups/<folder>/container.json`) — seeded automatically
- **Sender allowlist** was wildcard (`"*"`) or absent — no member rows seeded; set `unknown_sender_policy` per messaging group to control access
- **Owner + admin** (`users(role=owner)` + `NANOCLAW_ADMIN_USER_IDS`) — seeded automatically from `owner.json`

## Rebuild

Files changed since the v1 merge base (40). The sequencer offers a Claude handoff at the `rebuild` step so you can walk these through interactively:

- `src/channels/telegram.test.ts` (+1159 / -0)
- `container/skills/tavily-best-practices/references/integrations.md` (+717 / -0)
- `package-lock.json` (+568 / -8)
- `container/skills/tavily-dynamic-search/SKILL.md` (+457 / -0)
- `src/channels/telegram.ts` (+442 / -0)
- `container/skills/tavily-best-practices/references/search.md` (+403 / -0)
- `container/skills/tavily-best-practices/references/sdk.md` (+397 / -0)
- `src/channels/gmail.ts` (+372 / -0)
- `container/skills/tavily-best-practices/references/crawl.md` (+357 / -0)
- `.nanoclaw-migrations/channels.md` (+336 / -0)
- `container/skills/tavily-best-practices/references/research.md` (+315 / -0)
- `.nanoclaw-migrations/claude-md.md` (+288 / -0)
- `container/skills/tavily-best-practices/references/extract.md` (+249 / -0)
- `.nanoclaw-migrations/mcps.md` (+167 / -0)
- `.nanoclaw-migrations/container.md` (+151 / -0)
- `container/skills/tavily-best-practices/SKILL.md` (+144 / -0)
- `container/skills/tavily-crawl/SKILL.md` (+100 / -0)
- `container/skills/tavily-research/SKILL.md` (+100 / -0)
- `.nanoclaw-migrations/index.md` (+92 / -0)
- `container/skills/tavily-search/SKILL.md` (+91 / -0)
- … and 20 more (see `v1-data/git-customizations.json`)

## Deferred

**2 scheduled task(s)** live in `v1-data/scheduled-tasks.json`. v2 stores tasks in per-session `messages_in` rows, not the central DB — they can't be seeded directly. After first DM contact with the agent, paste the list so it can call its scheduling tool.

**1 chat metadata row(s)** from v1 are not migrated — v2 doesn't keep a central `chats` table. The v1 DB is preserved at `store.v1-backup/messages.db` if you need to extract history separately.

## Dropped

Customizations targeting v1-only surfaces (IPC, credential-proxy, monolithic `src/db.ts`, `task-scheduler.ts`, pino) do not survive the migration. Review `v1-data/git-customizations.json` and re-express any surviving intent against v2's module system (see docs/module-contract.md).

## Rollback

After the swap, the pre-migration state is preserved at:

- Git tag `pre-v2-<hash>-<ts>` (restore code with `git reset --hard <tag>`)
- `store.v1-backup/` (restore v1 DB with `mv store.v1-backup store`)
- `data/ipc.v1-backup/` (restore v1 IPC with `mv data/ipc.v1-backup data/ipc`)

Delete `data/v2.db` after restoring to drop the v2 central state.
