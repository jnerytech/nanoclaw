# NanoClaw Migration Guide

Generated: 2026-04-26
Base (merge-base): a81e1651b5e48c9194162ffa2c50a22283d5ecd3
HEAD at generation: 8dcd13cae3c0013fe587f3f7413796d4c5603780
Upstream HEAD: f8c3d023483c3775309d97b89638d96cded618df

This is a **v1.x → v2.0 migration** (NanoClaw v2 major architectural rewrite).
Tier 3 (complex). Section files live alongside this index.

---

## Migration Plan

### Order of Operations

1. **Apply channel skills from v2 `channels` branch** (Phase 2, step 2.4)
   - `/add-telegram` — installs base Telegram channel
   - `/add-gmail` — installs Gmail channel
   - Verify: `npm run build` passes

2. **Apply Telegram custom features** (see `channels.md`)
   - Reply/quoted message context
   - `message_thread_id` / topic support
   - File download (photo, video, voice, audio, document)
   - These go ON TOP of the v2 telegram channel code

3. **Add MCP integrations to container agent-runner** (see `mcps.md`)
   - Todoist (stdio)
   - Qwen Vision (stdio, local mount)
   - Tavily (HTTP transport)
   - Update `container/agent-runner/src/index.ts`

4. **Update Dockerfile** (see `container.md`)
   - Add system deps: `poppler-utils`, `python3`, `python3-pip`
   - Install `tavily-cli` via pip3
   - Add npm globals: `@gongrzhe/server-gmail-autoauth-mcp todoist-mcp`

5. **Update container-runner for mounts + env injection** (see `container.md`)
   - Gmail creds mount
   - Qwen CLI mount
   - Direct env var injection (TODOIST_API_TOKEN, LITELLM_API_KEY, TAVILY_API_KEY)
   - **Note:** v2 rewrote `src/container-runner.ts` entirely. Adaptation required.

6. **Copy container skills** (see `container.md`)
   - `container/skills/qwen-vision/SKILL.md`
   - `container/skills/tavily-*/SKILL.md` (7 files)

7. **Apply root CLAUDE.md behavioral guidelines** (see `claude-md.md`)

8. **Copy group CLAUDE.md files** (see `claude-md.md`)
   - `groups/global/CLAUDE.md` — T-Bug persona + Qwen vision + formatting rules
   - `groups/main/CLAUDE.md` — admin context + group management

### Risk Areas

- **Telegram custom features**: v2 `channels` branch ships a new `telegram.ts`. The reply context, thread_id, and file download features need to be applied as patches ON TOP of whatever v2's telegram channel looks like. Diff carefully.
- **container-runner.ts**: Completely rewritten in v2. Do NOT copy the old file. Instead, find the equivalent mount/env injection hooks in the new file and add the custom logic there.
- **container/agent-runner/src/index.ts**: Completely rewritten in v2 with modular MCP tools architecture. The MCP server configuration may live in a different location. Read the new file first.
- **Credential injection**: v2 mandates OneCLI but this install keeps direct `.env` injection. This may conflict with v2's container-runner architecture. If v2's runner strips env vars, investigate `src/container-config.ts` for injection hooks.

### Skill Interactions

- Telegram and Gmail both self-register via `registerChannel()` — no conflicts expected.
- Qwen Vision mount uses a fixed path (`/home/ubuntu/repos/qwen-cli`) — this is a custom/private local repo, must be present before the container builds/runs.
- Tavily MCP uses HTTP transport; Todoist and Qwen use stdio. These are independent and don't interact.

---

## Applied Skills (from upstream `channels` branch)

Install these in the worktree during Phase 2 before applying source customizations:

```bash
# In the upgrade worktree
git merge upstream/skill/channels-telegram --no-edit  # or however v2 ships it
# Check: git branch -r --list 'upstream/channels'
# v2 may ship via /add-telegram skill from the channels branch
```

> **Note:** In v2, channels are NOT on upstream `skill/*` branches. They are on `upstream/channels` and installed via `/add-telegram`, `/add-gmail` skills. Run those skills in the worktree first, then apply the custom feature patches from `channels.md`.

---

## Customization Files

| File | Description |
|------|-------------|
| `channels.md` | Telegram custom features + Gmail integration |
| `mcps.md` | Todoist, Qwen Vision, Tavily MCP in container agent |
| `container.md` | Dockerfile, container-runner mounts/env, container skills |
| `claude-md.md` | Root + group CLAUDE.md files (verbatim content) |
