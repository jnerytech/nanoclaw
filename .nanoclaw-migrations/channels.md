# Channels: Telegram Custom Features + Gmail

---

## Telegram Channel

The base Telegram channel is installed via `/add-telegram` skill from the v2 `channels` branch. The following features are applied ON TOP of that base.

**Files to modify after `/add-telegram` installs:**
- `src/channels/telegram.ts` — all features below
- `src/types.ts` — add `thread_id` field

---

### Feature 1: `thread_id` (Telegram Topics / Forum Support)

**Intent:** Support Telegram supergroup forums/topics. Each topic has a `message_thread_id`. Threads must be preserved so replies go back to the correct topic.

**Files:** `src/types.ts`, `src/channels/telegram.ts`

**How to apply:**

1. In `src/types.ts`, find the `NewMessage` interface and add:
   ```typescript
   thread_id?: string;
   ```

2. In `src/channels/telegram.ts`, in the text message handler, capture:
   ```typescript
   const threadId = ctx.message.message_thread_id;
   ```
   Then pass it to `this.opts.onMessage(...)`:
   ```typescript
   thread_id: threadId ? threadId.toString() : undefined,
   ```

3. In `sendMessage`, accept `threadId?: string` and use it:
   ```typescript
   async sendMessage(jid: string, text: string, threadId?: string): Promise<void> {
     const options = threadId
       ? { message_thread_id: parseInt(threadId, 10) }
       : {};
     // ... send with options
   }
   ```

---

### Feature 2: Reply / Quoted Message Context

**Intent:** When a user replies to a message, capture the original message content and sender so the agent has full context about what is being responded to.

**Files:** `src/channels/telegram.ts`, `src/types.ts`, `src/db.ts`, `src/router.ts`

**How to apply:**

1. In `src/types.ts`, add to `NewMessage`:
   ```typescript
   reply_to_message_id?: string;
   reply_to_message_content?: string;
   reply_to_sender_name?: string;
   ```

2. In `src/channels/telegram.ts`, in the text handler, extract reply context:
   ```typescript
   const replyTo = ctx.message.reply_to_message;
   const replyToMessageId = replyTo?.message_id?.toString();
   const replyToContent = replyTo?.text || replyTo?.caption;
   const replyToSenderName = replyTo
     ? replyTo.from?.first_name ||
       replyTo.from?.username ||
       replyTo.from?.id?.toString() ||
       'Unknown'
     : undefined;
   ```
   Pass all three fields to `this.opts.onMessage(...)`.

3. In `src/db.ts`, add DB migration (run once at startup):
   ```typescript
   try {
     database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
     database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`);
     database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
   } catch { /* columns already exist */ }
   ```
   Also update `storeMessage` INSERT and `getNewMessages` SELECT to include these columns.

   **storeMessage INSERT:**
   ```typescript
   `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp,
     is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content,
     reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
   // params: ...existing..., msg.reply_to_message_id ?? null,
   //   msg.reply_to_message_content ?? null, msg.reply_to_sender_name ?? null
   ```

   > **Note:** v2 uses a completely rewritten two-DB session split (`inbound.db` / `outbound.db`). The `src/db.ts` from v1 does not exist in v2. Find the equivalent inbound message schema in `src/db/messages-in.ts` and `src/db/schema.ts` and add the reply columns there.

4. In `src/router.ts`, update `formatMessages` to include reply context in XML:
   ```typescript
   const replyAttr = m.reply_to_message_id
     ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
     : '';
   const replySnippet =
     m.reply_to_message_content && m.reply_to_sender_name
       ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
       : '';
   return `<message sender="..." time="..."${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
   ```

   > **Note:** v2 rewrote message formatting. Find the equivalent formatting code in v2's `src/router.ts` or `container/agent-runner/src/formatter.ts`.

---

### Feature 3: File Download to Group Attachments

**Intent:** When a user sends photos, videos, voice messages, audio, or documents via Telegram, download the file to the group's `attachments/` directory and pass the container-relative path to the agent (e.g. `/workspace/group/attachments/photo_123.jpg`).

**Files:** `src/channels/telegram.ts`

**How to apply:**

Add a private `downloadFile` method to the Telegram channel class:

```typescript
private async downloadFile(
  fileId: string,
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  if (!this.bot) return null;

  try {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const tgExt = path.extname(file.file_path);
    const localExt = path.extname(filename);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = localExt ? safeName : `${safeName}${tgExt}`;
    const destPath = path.join(attachDir, finalName);

    const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);

    return `/workspace/group/attachments/${finalName}`;
  } catch (err) {
    logger.error({ fileId, err }, 'Failed to download Telegram file');
    return null;
  }
}
```

Add a `storeMedia` helper inside the `connect()` method that handles async file download and delivers content to the agent:

```typescript
const storeMedia = (
  ctx: any,
  placeholder: string,
  opts?: { fileId?: string; filename?: string },
) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
  const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

  const deliver = (content: string) => {
    this.opts.onMessage(chatJid, {
      id: ctx.message.message_id.toString(),
      chat_jid: chatJid,
      sender: ctx.from?.id?.toString() || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  };

  if (opts?.fileId) {
    const msgId = ctx.message.message_id.toString();
    const filename = opts.filename || `file_${msgId}`;
    this.downloadFile(opts.fileId, group.folder, filename).then((filePath) => {
      deliver(filePath ? `${placeholder} (${filePath})${caption}` : `${placeholder}${caption}`);
    });
    return;
  }

  deliver(`${placeholder}${caption}`);
};
```

Register media handlers (add after the text handler):

```typescript
// Photo — last entry is largest size
this.bot.on('message:photo', (ctx: any) => {
  const photos = ctx.message.photo;
  const largest = photos?.[photos.length - 1];
  storeMedia(ctx, '[Photo]', { fileId: largest?.file_id, filename: `photo_${ctx.message.message_id}` });
});

this.bot.on('message:video', (ctx: any) => {
  storeMedia(ctx, '[Video]', { fileId: ctx.message.video?.file_id, filename: `video_${ctx.message.message_id}` });
});

this.bot.on('message:voice', (ctx: any) => {
  storeMedia(ctx, '[Voice message]', { fileId: ctx.message.voice?.file_id, filename: `voice_${ctx.message.message_id}` });
});

this.bot.on('message:audio', (ctx: any) => {
  const name = ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
  storeMedia(ctx, '[Audio]', { fileId: ctx.message.audio?.file_id, filename: name });
});

this.bot.on('message:document', (ctx: any) => {
  const name = ctx.message.document?.file_name || 'file';
  storeMedia(ctx, `[Document: ${name}]`, { fileId: ctx.message.document?.file_id, filename: name });
});
```

**Required imports:** `fs`, `path`, `resolveGroupFolderPath` (or equivalent utility from the v2 channels code).

---

### Feature 4: Markdown with Fallback + Message Splitting

**Intent:** Send Telegram messages as Markdown v1. Auto-fall back to plain text on parse error. Split messages longer than 4096 chars.

**Files:** `src/channels/telegram.ts`

**How to apply:**

Add a helper function (outside the class or as private method):

```typescript
async function sendTelegramMessage(
  api: { sendMessage: any },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
  } catch (err) {
    // Fallback to plain text if Markdown fails
    await api.sendMessage(chatId, text, options);
  }
}
```

In `sendMessage`, split and send in chunks:

```typescript
const MAX_LENGTH = 4096;
if (text.length <= MAX_LENGTH) {
  await sendTelegramMessage(this.bot.api, numericId, text, options);
} else {
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    await sendTelegramMessage(this.bot.api, numericId, text.slice(i, i + MAX_LENGTH), options);
  }
}
```

---

### Feature 5: @mention Translation

**Intent:** When a user mentions the bot by its Telegram username (`@bot_name`), automatically prepend the configured trigger pattern (`@AssistantName`) so the agent recognizes the message is directed at it.

**Files:** `src/channels/telegram.ts`

**How to apply:**

In the text message handler, after extracting `content`, add:

```typescript
const botUsername = ctx.me?.username?.toLowerCase();
if (botUsername) {
  const entities = ctx.message.entities || [];
  const isBotMentioned = entities.some((entity: any) => {
    if (entity.type === 'mention') {
      const mentionText = content
        .substring(entity.offset, entity.offset + entity.length)
        .toLowerCase();
      return mentionText === `@${botUsername}`;
    }
    return false;
  });
  if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
    content = `@${ASSISTANT_NAME} ${content}`;
  }
}
```

**Required:** `TRIGGER_PATTERN` and `ASSISTANT_NAME` from `src/config.ts`.

---

## Gmail Channel

The base Gmail channel is installed via `/add-gmail` skill from the v2 `channels` branch.

**What this channel does:**
- Polls unread emails in primary inbox every 60 seconds
- Extracts sender, subject, RFC 2822 Message-ID, thread ID, and text body
- Delivers to the main registered group with content: `[Email from {senderName}]`
- Maintains thread metadata for reply threading
- Auto-marks processed emails as read
- Skips emails from the user's own address
- Self-registers via `registerChannel('gmail', ...)` on import

**Credentials required:**
- `~/.gmail-mcp/gcp-oauth.keys.json` — GCP OAuth app credentials (client_id, client_secret, redirect_uris)
- `~/.gmail-mcp/credentials.json` — OAuth2 tokens (access_token, refresh_token, expiry_date)

**Registration in `src/channels/index.ts`:**
```typescript
import './gmail.js';
import './telegram.js';
```

> **If `/add-gmail` skill already adds the import**, skip this step. Only add if not present.

**Container-runner mount** (see `container.md`):
The Gmail MCP inside containers also needs `~/.gmail-mcp/` mounted read-write so OAuth tokens can be refreshed by the MCP. This is separate from the channel polling done by the host.
