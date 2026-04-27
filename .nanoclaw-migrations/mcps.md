# MCP Integrations (Container Agent)

These MCP servers run inside agent containers. Configuration goes in `container/agent-runner/src/index.ts` (or equivalent in v2's modular MCP tools architecture — check `container/agent-runner/src/mcp-tools/` in v2).

> **v2 Note:** The `container/agent-runner/src/index.ts` was completely rewritten in v2. The MCP server configuration likely moved to `container/agent-runner/src/mcp-tools/server.ts` or is assembled differently. Read the v2 file first before applying these changes.

---

## Todoist MCP

**Intent:** Give the agent access to the user's Todoist tasks and projects.

**Package:** `todoist-mcp` (global npm)

**Configuration (add to the mcpServers object):**

```typescript
...(process.env.TODOIST_API_TOKEN
  ? {
      todoist: {
        command: 'todoist-mcp',
        args: [],
        env: { API_KEY: process.env.TODOIST_API_TOKEN },
      },
    }
  : {}),
```

**Allowed tools (add to allowedTools array):**
```typescript
'mcp__todoist__*',
```

**Environment variable:** `TODOIST_API_TOKEN` — injected via container-runner (see `container.md`).

**Dockerfile:** Add `todoist-mcp` to the global npm install line (see `container.md`).

---

## Qwen Vision MCP

**Intent:** Give the agent vision capabilities for images and PDFs. The MCP server runs a local Qwen model via a LiteLLM proxy.

**Source:** Custom/private repo at `/home/ubuntu/repos/qwen-cli` on host. The MCP binary is at `/opt/qwen-cli/dist/mcp-server.js` inside the container (mounted read-only).

**Configuration (add to the mcpServers object):**

```typescript
'qwen-vision': {
  command: 'node',
  args: ['/opt/qwen-cli/dist/mcp-server.js'],
  env: {
    ...process.env,
    LITELLM_BASE_URL: 'http://host.docker.internal:4010/v1',
    LITELLM_API_KEY: process.env.LITELLM_API_KEY ?? '',
  },
},
```

**Allowed tools (add to allowedTools array):**
```typescript
'mcp__qwen-vision__*',
```

**Environment variable:** `LITELLM_API_KEY` — injected via container-runner.

**Container mount** (see `container.md`): `/home/ubuntu/repos/qwen-cli` → `/opt/qwen-cli` (read-only).

**Dockerfile:** Add `poppler-utils` to apt-get install (needed for PDF-to-PNG conversion).

**Host-level MCP** (`.mcp.json`, for Claude Code on host):
```json
"qwen-vision": {
  "command": "/home/ubuntu/.hermes/node/bin/qwen-mcp",
  "args": []
}
```
This is for using Qwen vision in the HOST Claude Code session (not inside containers). The binary is at `~/.hermes/node/bin/qwen-mcp`. If this path doesn't exist after upgrade, rebuild or reinstall the qwen-cli package.

---

## Tavily MCP (HTTP Transport)

**Intent:** Give the agent web search capabilities via the Tavily API.

**Transport:** HTTP (not stdio like the others). This is important — Tavily uses the remote MCP endpoint directly.

**Configuration (add to the mcpServers object):**

```typescript
...(process.env.TAVILY_API_KEY
  ? {
      tavily: {
        type: 'http' as const,
        url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`,
      },
    }
  : {}),
```

**Allowed tools (add to allowedTools array):**
```typescript
'mcp__tavily__*',
```

**Environment variable:** `TAVILY_API_KEY` — injected via container-runner.

**Note on HTTP vs stdio:** Previous version used stdio (`npx tavily-mcp`). Current version uses HTTP transport which is simpler and doesn't require a local process. Do NOT revert to stdio.

**Dockerfile:** Install `tavily-cli` for Tavily skills in container:
```dockerfile
RUN pip3 install --break-system-packages --no-cache-dir tavily-cli
```
(Requires `python3` and `python3-pip` in the system deps — see `container.md`.)

**Host-level MCP** (`.mcp.json`, for Claude Code on host):
```json
"tavily": {
  "command": "npx",
  "args": ["-y", "tavily-mcp"],
  "env": {
    "TAVILY_API_KEY": "${TAVILY_API_KEY}"
  }
}
```

---

## Full `.mcp.json` (Host-Level)

This file lives at `/home/ubuntu/repos/nanoclaw/.mcp.json` and configures MCP servers for the HOST Claude Code session (not inside containers):

```json
{
  "mcpServers": {
    "qwen-vision": {
      "command": "/home/ubuntu/.hermes/node/bin/qwen-mcp",
      "args": []
    },
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": {
        "TAVILY_API_KEY": "${TAVILY_API_KEY}"
      }
    }
  }
}
```

Copy this file verbatim to the upgrade worktree.

---

## allowedTools Array (Full Addition)

In whatever v2 file configures the Claude SDK `allowedTools`, add these entries:

```typescript
'mcp__nanoclaw__*',
'mcp__gmail__*',
'mcp__todoist__*',
'mcp__qwen-vision__*',
'mcp__tavily__*',
```

> **v2 Note:** The allowed tools configuration in v1 was in `container/agent-runner/src/index.ts` around line 473. In v2 this may be in `container/agent-runner/src/providers/claude.ts` or `container/agent-runner/src/mcp-tools/server.ts`. Check both files.
