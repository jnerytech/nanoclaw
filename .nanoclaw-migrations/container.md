# Container Changes

---

## Dockerfile

**File:** `container/Dockerfile`

> **v2 Note:** The Dockerfile was completely rewritten in v2 (147-line diff). Read the v2 Dockerfile first. The additions below are the specific custom changes to apply on top.

### System Dependencies

Add to the apt-get install block:
```dockerfile
poppler-utils \
python3 \
python3-pip \
```

`poppler-utils` is required for PDF-to-PNG conversion in Qwen Vision. `python3`/`pip` are required for `tavily-cli`.

### Tavily CLI

Add after the apt-get block:
```dockerfile
# Install tavily-cli for Tavily skills
RUN pip3 install --break-system-packages --no-cache-dir tavily-cli
```

### Global NPM Packages

Find the line that installs global npm packages (likely `RUN npm install -g ...` or `bun add -g ...` in v2 since agent-runner moved to Bun) and add:
```
@gongrzhe/server-gmail-autoauth-mcp todoist-mcp
```

Full original line for reference (v1):
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @gongrzhe/server-gmail-autoauth-mcp todoist-mcp
```

> **v2 Note:** v2 uses Bun as the container runtime. The install command may be different (`bun add -g` or similar). Add the same packages to whatever global install command v2 uses.

---

## Container Runner: Mounts + Env Injection

**File:** `src/container-runner.ts`

> **v2 Critical Note:** `src/container-runner.ts` was completely rewritten in v2 (1118 lines changed). Do NOT copy the v1 container-runner. Instead:
> 1. Read the v2 file to understand its structure
> 2. Find where mounts are assembled (likely a function that returns mount arrays)
> 3. Find where env vars are injected (likely a function that builds Docker `-e` flags or `--env` args)
> 4. Add the custom mounts and env vars in the appropriate places

### Gmail Credentials Mount

**Intent:** The Gmail MCP inside containers needs `~/.gmail-mcp/` mounted read-write to refresh OAuth tokens.

Add this mount when spawning any container:

```typescript
const homeDir = os.homedir();
const gmailDir = path.join(homeDir, '.gmail-mcp');
if (fs.existsSync(gmailDir)) {
  mounts.push({
    hostPath: gmailDir,
    containerPath: '/home/node/.gmail-mcp',
    readonly: false, // MCP needs to write refreshed tokens
  });
}
```

> **v2 Note:** The container user may have changed (was `node`, may now be different). Check the v2 Dockerfile for `USER` directive to confirm the home directory path inside the container.

### Qwen CLI Mount

**Intent:** The Qwen Vision MCP server binary lives in a local repo at `/home/ubuntu/repos/qwen-cli` on the host. Mount it read-only into containers.

```typescript
mounts.push({
  hostPath: '/home/ubuntu/repos/qwen-cli',
  containerPath: '/opt/qwen-cli',
  readonly: true,
});
```

This must be present for the Qwen Vision MCP to work (see `mcps.md`).

### Environment Variable Injection

**Intent:** Inject API tokens for Todoist, LiteLLM (Qwen), and Tavily into containers directly from `.env`. This bypasses OneCLI — intentional design choice for this install.

Read from `.env` file and inject via Docker `-e` flags:

```typescript
const env = readEnvFile(); // or however v2 reads .env
const envVars = ['TODOIST_API_TOKEN', 'LITELLM_API_KEY', 'TAVILY_API_KEY'];
for (const key of envVars) {
  if (env[key]) {
    dockerArgs.push('-e', `${key}=${env[key]}`);
  }
}
```

> **v2 Note:** v2's container-runner may use a different mechanism for env injection (e.g. `--env-file`, or a config object). Look for where `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` is injected in v2 (commit `26fc3ff` adds these) — add the three custom vars in the same pattern.

---

## Container Skills

These skill files are loaded into agent containers at runtime (read by the Claude agent inside the container).

**Source location (in this repo):** `container/skills/`

Copy the following directories verbatim from the current repo to the upgrade worktree:

### Qwen Vision Skill

`container/skills/qwen-vision/SKILL.md`

This file instructs the agent to use Qwen Vision MCP automatically for images and PDFs:

```markdown
---
name: qwen-vision
description: Analyze images and PDFs with Qwen Vision. Use automatically whenever the user sends image files (png, jpg, webp, gif) or PDF attachments. Do not wait to be asked — analyze proactively on arrival. Only pass `prompt` if the user gives a specific instruction about what to extract or do. Generic messages ("olha isso", "veja", "o que é isso?", "analisa aí") count as no instruction — omit prompt in those cases.
allowed-tools: mcp__qwen-vision__*
---
```
(Full SKILL.md content — copy the actual file from `container/skills/qwen-vision/SKILL.md`)

### Tavily Skills (7 files)

Copy the entire `container/skills/tavily-*/` directories:
- `container/skills/tavily-best-practices/SKILL.md` (+ `references/` subdirectory with 6 files)
- `container/skills/tavily-cli/SKILL.md`
- `container/skills/tavily-crawl/SKILL.md`
- `container/skills/tavily-dynamic-search/SKILL.md`
- `container/skills/tavily-extract/SKILL.md`
- `container/skills/tavily-map/SKILL.md`
- `container/skills/tavily-research/SKILL.md`
- `container/skills/tavily-search/SKILL.md`

**How to apply:** During Phase 2, after the worktree is set up, run:
```bash
cp -r container/skills/qwen-vision "$WORKTREE/container/skills/"
cp -r container/skills/tavily-* "$WORKTREE/container/skills/"
```

> **v2 Note:** v2 changed the container skills structure. Check what's in `$WORKTREE/container/skills/` before copying. If the directory structure changed, adapt accordingly.
