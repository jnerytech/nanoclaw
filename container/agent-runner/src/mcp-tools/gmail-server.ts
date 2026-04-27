/**
 * Minimal Gmail MCP server.
 * Uses credentials from ~/.gmail-mcp/ — no external MCP package required.
 * Tools: list_emails, read_email, search_emails, send_email
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import os from 'os';
import { z } from 'zod';

const CRED_DIR = `${os.homedir()}/.gmail-mcp`;
const KEYS_PATH = `${CRED_DIR}/gcp-oauth.keys.json`;
const TOKENS_PATH = `${CRED_DIR}/credentials.json`;

function loadTokens(): Record<string, string | number> {
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as Record<string, string | number>;
}

function loadKeys(): Record<string, string> {
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')) as Record<string, unknown>;
  return (raw.installed ?? raw.web ?? raw) as Record<string, string>;
}

async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  const expiryDate = typeof tokens.expiry_date === 'number' ? tokens.expiry_date : 0;
  if (Date.now() < expiryDate - 60_000) {
    return tokens.access_token as string;
  }

  const keys = loadKeys();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: tokens.refresh_token as string,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await res.json()) as Record<string, string | number>;
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  fs.writeFileSync(
    TOKENS_PATH,
    JSON.stringify(
      { ...tokens, access_token: data.access_token, expiry_date: Date.now() + (data.expires_in as number) * 1000 },
      null,
      2,
    ),
  );
  return data.access_token as string;
}

async function gmailGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function gmailPost(path: string, body: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

interface Header { name?: string; value?: string }
interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[] }

function headerVal(headers: Header[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractText(payload: Part | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  }
  for (const part of payload.parts ?? []) {
    const text = extractText(part);
    if (text) return text;
  }
  return '';
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'gmail', version: '1.0.0' });

server.tool(
  'list_emails',
  'List emails from Gmail. Returns id, threadId, from, subject, date.',
  {
    query: z.string().optional().describe('Gmail search query (default: is:unread category:primary)'),
    maxResults: z.number().int().min(1).max(50).optional().describe('Max emails to return (default: 10)'),
  },
  async ({ query = 'is:unread category:primary', maxResults = 10 }) => {
    const data = (await gmailGet(
      `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    )) as { messages?: { id: string }[] };

    const messages = data.messages ?? [];
    const results = await Promise.all(
      messages.map(async (m) => {
        const msg = (await gmailGet(
          `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From,Subject,Date`,
        )) as { threadId: string; payload: { headers: Header[] } };
        const h = (n: string) => headerVal(msg.payload?.headers ?? [], n);
        return { id: m.id, threadId: msg.threadId, from: h('From'), subject: h('Subject'), date: h('Date') };
      }),
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'read_email',
  'Read the full content of a Gmail message by its ID.',
  { messageId: z.string().describe('Gmail message ID') },
  async ({ messageId }) => {
    const msg = (await gmailGet(`/users/me/messages/${messageId}?format=full`)) as {
      id: string;
      threadId: string;
      payload: { headers: Header[] } & Part;
    };
    const h = (n: string) => headerVal(msg.payload?.headers ?? [], n);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              id: msg.id,
              threadId: msg.threadId,
              from: h('From'),
              to: h('To'),
              subject: h('Subject'),
              date: h('Date'),
              messageId: h('Message-ID'),
              body: extractText(msg.payload),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'search_emails',
  'Search Gmail messages using Gmail query syntax.',
  {
    query: z.string().describe('Gmail search query (e.g. "from:foo@bar.com subject:invoice")'),
    maxResults: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
  },
  async ({ query, maxResults = 20 }) => {
    const data = (await gmailGet(
      `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    )) as { messages?: { id: string }[] };

    const messages = data.messages ?? [];
    const results = await Promise.all(
      messages.map(async (m) => {
        const msg = (await gmailGet(
          `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From,Subject,Date`,
        )) as { threadId: string; payload: { headers: Header[] } };
        const h = (n: string) => headerVal(msg.payload?.headers ?? [], n);
        return { id: m.id, threadId: msg.threadId, from: h('From'), subject: h('Subject'), date: h('Date') };
      }),
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'send_email',
  'Send an email via Gmail.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    inReplyTo: z.string().optional().describe('Message-ID header value to reply to'),
    threadId: z.string().optional().describe('Gmail thread ID (for replies)'),
  },
  async ({ to, subject, body, inReplyTo, threadId }) => {
    const profile = (await gmailGet('/users/me/profile')) as { emailAddress: string };
    const from = profile.emailAddress;

    const lines = [`To: ${to}`, `From: ${from}`, `Subject: ${subject}`];
    if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
    lines.push('Content-Type: text/plain; charset=utf-8', '', body);

    const raw = Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const requestBody: Record<string, string> = { raw };
    if (threadId) requestBody.threadId = threadId;

    const sent = (await gmailPost('/users/me/messages/send', requestBody)) as { id: string };
    return { content: [{ type: 'text' as const, text: `Email sent. Message ID: ${sent.id}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
