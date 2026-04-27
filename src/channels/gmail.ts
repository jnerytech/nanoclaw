import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1, Auth } from 'googleapis';

import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

const CRED_DIR = path.join(os.homedir(), '.gmail-mcp');
const KEYS_PATH = path.join(CRED_DIR, 'gcp-oauth.keys.json');
const TOKENS_PATH = path.join(CRED_DIR, 'credentials.json');
const POLL_INTERVAL_MS = 60_000;
const PLATFORM_ID = 'gmail:inbox';

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string;
}

class GmailChannelAdapter implements ChannelAdapter {
  name = 'gmail';
  channelType = 'gmail';
  supportsThreads = true;

  private oauth2Client: Auth.OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private userEmail = '';
  private consecutiveErrors = 0;
  private onInbound: ChannelSetup['onInbound'] | null = null;

  async setup(config: ChannelSetup): Promise<void> {
    this.onInbound = config.onInbound;

    if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) {
      log.warn('Gmail credentials not found in ~/.gmail-mcp/ — channel disabled');
      return;
    }

    const tokensRaw = fs.readFileSync(TOKENS_PATH, 'utf-8');
    if (tokensRaw.includes('onecli-managed')) {
      log.info('Gmail: OneCLI-managed credentials — inbox polling disabled, MCP tools still work');
      return;
    }

    const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
    const tokens = JSON.parse(tokensRaw);

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    oauth2.setCredentials(tokens);

    oauth2.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(TOKENS_PATH, JSON.stringify(current, null, 2));
      } catch (err) {
        log.warn('Gmail: failed to persist refreshed tokens', { err });
      }
    });

    this.oauth2Client = oauth2;
    this.gmail = google.gmail({ version: 'v1', auth: oauth2 });

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress ?? '';
    log.info('Gmail channel connected', { email: this.userEmail });

    config.onMetadata(PLATFORM_ID, `Gmail (${this.userEmail})`, false);

    await this.poll();
    this.schedulePoll();
  }

  async teardown(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    if (!this.gmail) return undefined;

    const rawThreadId = threadId?.replace(/^gmail:/, '') ?? '';
    const meta = rawThreadId ? this.threadMeta.get(rawThreadId) : null;

    if (!meta) {
      log.warn('Gmail deliver: no thread metadata for reply', { threadId });
      return undefined;
    }

    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const subject = meta.subject.startsWith('Re:') ? meta.subject : `Re: ${meta.subject}`;

    const raw = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    try {
      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encoded, threadId: rawThreadId },
      });
      log.info('Gmail reply sent', { to: meta.sender, threadId: rawThreadId });
      return res.data.id ?? undefined;
    } catch (err) {
      log.error('Gmail reply failed', { threadId, err });
      return undefined;
    }
  }

  // --- private ---

  private schedulePoll(): void {
    const backoffMs =
      this.consecutiveErrors > 0
        ? Math.min(POLL_INTERVAL_MS * 2 ** this.consecutiveErrors, 30 * 60_000)
        : POLL_INTERVAL_MS;

    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((err) => log.error('Gmail poll error', { err }))
        .finally(() => {
          if (this.gmail) this.schedulePoll();
        });
    }, backoffMs);
  }

  private async poll(): Promise<void> {
    if (!this.gmail || !this.onInbound) return;

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread category:primary',
        maxResults: 10,
      });

      for (const stub of res.data.messages ?? []) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);
        await this.processMessage(stub.id);
      }

      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      log.error('Gmail poll failed', { err, consecutiveErrors: this.consecutiveErrors });
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail || !this.onInbound) return;

    const msg = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });

    const headers = msg.data.payload?.headers ?? [];
    const h = (name: string) => headers.find((hh) => hh.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

    const from = h('From');
    const subject = h('Subject');
    const rfc2822Id = h('Message-ID');
    const threadId = msg.data.threadId ?? messageId;
    const timestamp = new Date(parseInt(msg.data.internalDate ?? '0', 10)).toISOString();

    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    if (senderEmail === this.userEmail) return;

    const body = this.extractTextBody(msg.data.payload);
    if (!body) return;

    this.threadMeta.set(threadId, { sender: senderEmail, senderName, subject, messageId: rfc2822Id });

    const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body.trim()}`;

    this.onInbound(PLATFORM_ID, `gmail:${threadId}`, {
      id: messageId,
      kind: 'chat',
      content,
      timestamp,
      isMention: true,
    });

    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      log.warn('Gmail: failed to mark message as read', { messageId, err });
    }

    log.info('Gmail email delivered', { from: senderName, subject, threadId });
  }

  private extractTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }
    return '';
  }
}

registerChannelAdapter('gmail', {
  factory: () => {
    if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) return null;
    return new GmailChannelAdapter();
  },
});
