---
name: qwen-vision
description: Analyze images and PDFs with Qwen Vision. Use automatically whenever the user sends image files (png, jpg, webp, gif) or PDF attachments. Do not wait to be asked — analyze proactively on arrival. Only pass `prompt` if the user gives a specific instruction about what to extract or do. Generic messages ("olha isso", "veja", "o que é isso?", "analisa aí") count as no instruction — omit prompt in those cases.
allowed-tools: mcp__qwen-vision__*
---

# Qwen Vision — Image and PDF Analysis

Use `mcp__qwen-vision__qwen_vision` (markdown output) or `mcp__qwen-vision__qwen_vision_json` (structured JSON) to analyze any image or PDF.

## When to use

**Always use when:**
- User sends an image attachment (png, jpg, webp, gif)
- User sends a PDF attachment
- User asks to "read", "analyze", "extract", "what's in this file/image/PDF"
- File path appears in message as `/workspace/group/attachments/...`

**Use JSON variant when:**
- User wants structured data (tables, lists, form fields)
- Data will be processed further (saved, searched, compared)

## Tool parameters

```
mcp__qwen-vision__qwen_vision
  files   — list of absolute file paths (required)
  prompt  — instruction for the model (optional — see rules below)
  model   — model override (optional, default: qwen3.5-flash-02-23)
```

**Parameter rules:**
- `files` — always required, pass exact path from the message
- `prompt` — only pass if the user explicitly gave an instruction (e.g. "extraia a tabela", "traduza o texto"). If in doubt, omit it. Never invent a prompt.
- `model` — never pass unless user requests a specific model

## File paths

Attachments land in `/workspace/group/attachments/`. Use the exact path from the message — do not guess or reconstruct paths.

## Examples

User sends image with no instruction → omit prompt:
```
tool: mcp__qwen-vision__qwen_vision
files: ["/workspace/group/attachments/photo_123.jpg"]
```

User says "extraia os dados da tabela":
```
tool: mcp__qwen-vision__qwen_vision_json
prompt: "Extraia todos os dados da tabela"
files: ["/workspace/group/attachments/document.pdf"]
```

## PDF support

PDFs are auto-converted to PNG internally using `pdftoppm` (installed). No pre-processing needed — pass the `.pdf` path directly.

## Default behavior

1. File arrives → call `mcp__qwen-vision__qwen_vision` immediately
2. Use prompt in Portuguese matching the conversation language
3. Present result to user — do not just say "I analyzed it", show the content
4. If analysis fails, report the exact error message
