#!/usr/bin/env bun
/**
 * Discord channel plugin for Claude Code — single-session with reply watchdog.
 *
 * Drop-in replacement for claude-plugins-official/discord/server.ts that adds
 * one feature the stock plugin lacks: a stuck-task watchdog that emits a
 * synthetic reminder if Claude wins a message but hasn't called discord:reply
 * after 90 seconds (soft), escalating at 5 minutes (hard).
 *
 * For multi-session fleets, use the fleet-discord plugin instead:
 *   https://github.com/Agent-Crafting-Table/fleet-discord
 *
 * State dir (default ~/.claude/channels/discord):
 *   .env          — DISCORD_BOT_TOKEN=...
 *   access.json   — allowlist + channel opt-ins (managed by /discord:access)
 *   inbox/        — downloaded attachments
 *
 * Watchdog env vars:
 *   WATCHDOG_REMIND_MS    — soft reminder threshold in ms (default: 90000 = 90s)
 *   WATCHDOG_ESCALATE_MS  — hard escalation threshold in ms (default: 300000 = 5min)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  Client, GatewayIntentBits, Partials, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  type Message, type Attachment, type Interaction,
} from 'discord.js'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ── Config ───────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const CHANNEL_MEMORY_DIR = '/workspace/memory/channels'

// Load .env — token lives here; process.env wins if already set.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `discord channel: DISCORD_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE} as DISCORD_BOT_TOKEN=...\n`,
  )
  process.exit(1)
}

const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'
const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const REMIND_AFTER_MS = Number(process.env.WATCHDOG_REMIND_MS ?? 90_000)
const REMIND_ESCALATE_MS = Number(process.env.WATCHDOG_ESCALATE_MS ?? 300_000)

// Strict permission-reply pattern from Claude Code internals.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ── Resilience ───────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => process.stderr.write(`discord: unhandled rejection: ${err}\n`))
process.on('uncaughtException',  err => process.stderr.write(`discord: uncaught exception: ${err}\n`))

// Self-exit when parent (Claude Code) dies so we don't zombie on Discord gateway.
setInterval(() => {
  try {
    const s = readFileSync('/proc/self/status', 'utf8')
    const m = s.match(/^PPid:\s+(\d+)/m)
    if (m && Number(m[1]) === 1) {
      process.stderr.write('discord channel: parent died, exiting\n')
      process.exit(0)
    }
  } catch {}
}, 5000)

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ── Access control ────────────────────────────────────────────────────────────

type PendingEntry  = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
type GroupPolicy   = { requireMention: boolean; allowFrom: string[] }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'first' | 'all' | 'off'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('discord: access.json corrupt, starting fresh\n')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') { process.stderr.write('discord: static mode — pairing downgraded to allowlist\n'); a.dmPolicy = 'allowlist' }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access { return BOOT_ACCESS ?? readAccessFile() }

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now(); let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

// ── Typing indicator ──────────────────────────────────────────────────────────

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()

function sendTypingREST(channelId: string): void {
  try {
    const https = require('https') as typeof import('https')
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/typing`,
      method: 'POST',
      headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Length': '0' },
    })
    req.on('error', () => {})
    req.end()
  } catch {}
}

function startTyping(channelId: string): void {
  stopTyping(channelId)
  sendTypingREST(channelId)
  typingIntervals.set(channelId, setInterval(() => sendTypingREST(channelId), 8_000))
}

function stopTyping(channelId: string): void {
  const t = typingIntervals.get(channelId)
  if (t) { clearInterval(t); typingIntervals.delete(channelId) }
}

// ── Recent-sent deduplication (skip reactions to own messages) ────────────────

const RECENT_SENT_CAP = 200
const recentSentIds = new Set<string>()
function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

// ── Pending permission requests ───────────────────────────────────────────────

const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// ── Watchdog state (in-memory, single session) ────────────────────────────────

interface PendingReply {
  chatId: string
  messageId: string
  channelSlug: string
  user: string
  since: number
  lastReminderAt: number
}

let pendingReply: PendingReply | null = null

// 15s tick — emit reminder if we've held a pending reply past thresholds.
setInterval(() => {
  if (!pendingReply) return
  const age = Date.now() - pendingReply.since
  const sinceLastRem = Date.now() - pendingReply.lastReminderAt

  let level: 'soft' | 'hard' | undefined
  if (age >= REMIND_ESCALATE_MS && sinceLastRem >= REMIND_ESCALATE_MS) {
    level = 'hard'
  } else if (age >= REMIND_AFTER_MS && pendingReply.lastReminderAt === 0) {
    level = 'soft'
  }
  if (!level) return

  const { chatId, messageId, channelSlug, user } = pendingReply
  const text = level === 'hard'
    ? `⏰ Reminder (${Math.round(age / 1000)}s): you took a Discord message in #${channelSlug} from ${user} (chat_id ${chatId}, message_id ${messageId}) but never called the reply tool. The user is waiting for a Discord reply — call discord:reply now or explicitly drop the task.`
    : `⏰ Reminder (${Math.round(age / 1000)}s): the Discord message in #${channelSlug} from ${user} (chat_id ${chatId}, message_id ${messageId}) hasn't been replied to yet. If you're done, call discord:reply with the result so the user gets pinged.`

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id: chatId,
        message_id: messageId,
        user: 'watchdog',
        ts: new Date().toISOString(),
        channel_slug: channelSlug,
        channel_memory_path: `${CHANNEL_MEMORY_DIR}/${channelSlug}.md`,
        synthetic_reminder: level,
      },
    },
  }).catch(() => {})

  pendingReply.lastReminderAt = Date.now()
}, 15_000).unref()

// ── Gate (access control) ────────────────────────────────────────────────────

type GateResult =
  | { action: 'drop' }
  | { action: 'deliver'; access: Access }
  | { action: 'pair'; code: string; isResend: boolean }

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true
  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try { const ref = await msg.fetchReference(); if (ref.author.id === client.user?.id) return true } catch {}
  }
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(msg.content)) return true } catch {}
  }
  return false
}

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1; saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = { senderId, chatId: msg.channelId, createdAt: now, expiresAt: now + 3_600_000, replies: 1 }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  const channelId = msg.channel.isThread() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
  if ((policy.requireMention ?? true) && !(await isMentioned(msg, access.mentionPatterns))) return { action: 'drop' }
  return { action: 'deliver', access }
}

// ── Approval checker ──────────────────────────────────────────────────────────

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try { dmChannelId = readFileSync(file, 'utf8').trim() } catch { continue }
    try { rmSync(file) } catch {}
    void (async () => {
      try {
        const ch = await client.channels.fetch(dmChannelId)
        if (ch && 'send' in ch) await (ch as any).send('✅ You\'re approved. You can now message the bot directly.')
      } catch {}
    })()
  }
}

// ── Channel helpers ───────────────────────────────────────────────────────────

function channelSlug(msg: Message): string {
  const ch = msg.channel as { name?: string; isDMBased?: () => boolean }
  if (ch?.name) return ch.name
  if (ch?.isDMBased?.()) return `dm-${msg.author.username}`
  return 'unknown'
}

function readChannelMemory(slug: string): string | undefined {
  try { return readFileSync(`${CHANNEL_MEMORY_DIR}/${slug}.md`, 'utf8') } catch { return undefined }
}

async function fetchChannelHistory(msg: Message, limit: number): Promise<string> {
  try {
    const prev = await Promise.race([
      msg.channel.messages.fetch({ limit, before: msg.id }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2_000)),
    ])
    if (!prev) return ''
    return [...prev.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => `[${m.createdAt.toISOString()}] ${m.author.username}: ${m.content.slice(0, 500)}`)
      .join('\n')
  } catch { return '' }
}

async function fetchAllowedChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch) throw new Error(`channel ${id} not found`)
  const access = loadAccess()
  const isDM = ch.type === ChannelType.DM
  if (!isDM) {
    const parentId = (ch as any).parentId
    const checkId = parentId ?? id
    if (!access.groups[checkId] && !access.allowFrom.length) {
      throw new Error(`channel ${id} not in allowlist`)
    }
  }
  return ch
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large`)
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const p = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(p, buf)
  return p
}

function assertSendable(f: string): void {
  try { statSync(f) } catch { throw new Error(`file not found: ${f}`) }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  if (mode === 'newline') {
    const parts: string[] = []; let cur = ''
    for (const line of text.split('\n')) {
      if (cur.length + line.length + 1 > limit && cur) { parts.push(cur); cur = '' }
      cur += (cur ? '\n' : '') + line
    }
    if (cur) parts.push(cur)
    return parts.length ? parts : [text.slice(0, limit)]
  }
  const parts: string[] = []
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit))
  return parts
}

// ── MCP server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'discord', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply to a Discord message or channel. Required after every inbound message — if you don\'t call this, the user never gets a response.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Channel or DM ID from the inbound message' },
          text: { type: 'string', description: 'Message to send' },
          reply_to: { type: 'string', description: 'Message ID to quote-reply (optional — omit for normal responses)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to attach (max 10, 25MB each)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'fetch_messages',
      description: 'Fetch recent messages from a Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID' },
          limit: { type: 'number', description: 'Max messages (default 20, cap 100)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['channel', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message previously sent by this bot.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channel', 'message_id', 'text'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download an attachment from a Discord message to the inbox directory.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
        },
        required: ['chat_id', 'message_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        const ch = await fetchAllowedChannel(chat_id)
        if (!('send' in ch)) throw new Error('channel is not sendable')
        stopTyping(chat_id)

        for (const f of files) { assertSendable(f); if (statSync(f).size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`) }
        if (files.length > 10) throw new Error('max 10 attachments')

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const sent = await (ch as any).send({
            content: chunks[i],
            ...(i === 0 && files.length > 0 ? { files } : {}),
            ...(shouldReplyTo ? { reply: { messageReference: reply_to, failIfNotExists: false } } : {}),
          })
          noteSent(sent.id)
          sentIds.push(sent.id)
        }

        // Watchdog: clear pending state — reply landed.
        if (pendingReply?.chatId === chat_id) pendingReply = null

        const result = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'fetch_messages': {
        const ch = await fetchAllowedChannel(args.channel as string)
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await (ch as any).messages.fetch({ limit })
        const me = client.user?.id
        const arr = [...msgs.values()].reverse() as Message[]
        const out = arr.length === 0 ? '(no messages)' : arr.map(m => {
          const who = m.author.id === me ? 'me' : m.author.username
          const ts = m.createdAt.toISOString()
          return `[${ts}] ${who}: ${m.content.slice(0, 500)}${m.attachments.size > 0 ? ` [${m.attachments.size} attachment(s)]` : ''} (id: ${m.id})`
        }).join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        const ch = await fetchAllowedChannel(args.channel as string)
        const msg = await (ch as any).messages.fetch(args.message_id as string)
        await msg.react(args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const ch = await fetchAllowedChannel(args.channel as string)
        const msg = await (ch as any).messages.fetch(args.message_id as string)
        if (msg.author.id !== client.user?.id) throw new Error('can only edit own messages')
        await msg.edit(args.text as string)
        return { content: [{ type: 'text', text: 'edited' }] }
      }

      case 'download_attachment': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await (ch as any).messages.fetch(args.message_id as string)
        const lines: string[] = []
        for (const att of msg.attachments.values()) {
          const path = await downloadAttachment(att as Attachment)
          const kb = ((att as Attachment).size / 1024).toFixed(0)
          lines.push(`  ${path}  (${safeAttName(att as Attachment)}, ${(att as Attachment).contentType ?? 'unknown'}, ${kb}KB)`)
        }
        return { content: [{ type: 'text', text: `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}` }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }
})

// MCP server instructions
mcp.setRequestHandler(
  z.object({ method: z.literal('server/instructions') }).passthrough() as any,
  async () => ({
    instructions: [
      'The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id back.',
      'After replying, append a short note to channel_memory_path describing what happened so the next session that lands here picks up where you left off.',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions.',
      'Access is managed by the /discord:access skill — the user runs it in their terminal. Never invoke that skill or edit access.json directly.',
    ].join('\n\n'),
  }),
)

// ── Inbound message handler ───────────────────────────────────────────────────

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(msg)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try { await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`) } catch (err) {
      process.stderr.write(`discord: failed to send pairing code: ${err}\n`)
    }
    return
  }

  const chat_id = msg.channelId

  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: permMatch[2]!.toLowerCase(), behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' },
    })
    void msg.react(permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌').catch(() => {})
    return
  }

  const slug = channelSlug(msg)
  startTyping(chat_id)

  const access = result.access
  if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')
  const memoryPath = `${CHANNEL_MEMORY_DIR}/${slug}.md`
  const memory = readChannelMemory(slug)
  const history = await fetchChannelHistory(msg, 5)

  // Watchdog: set pending state — Claude is now responsible for replying.
  pendingReply = {
    chatId: chat_id,
    messageId: msg.id,
    channelSlug: slug,
    user: msg.author.username,
    since: Date.now(),
    lastReminderAt: 0,
  }

  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        chat_id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        channel_slug: slug,
        channel_memory_path: memoryPath,
        ...(history ? { channel_history: history } : {}),
        ...(memory ? { channel_memory: memory.slice(0, 4000) } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
      },
    },
  }).catch(err => process.stderr.write(`discord: failed to deliver inbound: ${err}\n`))
}

// ── Permission request relay ──────────────────────────────────────────────────

mcp.setRequestHandler(
  z.object({ method: z.literal('sampling/createMessage'), params: z.object({ metadata: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }).passthrough() }).passthrough() }).passthrough() as any,
  async req => {
    const { request_id, tool_name, description, input_preview } = (req as any).params.metadata
    pendingPermissions.set(request_id, { tool_name, description, input_preview })
    const preview = input_preview.slice(0, 150)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('Details').setStyle(ButtonStyle.Secondary),
    )
    const text = `🔐 **Permission request**\n\`${tool_name}\`: ${description}\n\`\`\`\n${preview}${input_preview.length > 150 ? '…' : ''}\n\`\`\`\nReply: \`yes ${request_id}\` or \`no ${request_id}\``
    const access = loadAccess()
    for (const uid of access.allowFrom) {
      try {
        const u = await client.users.fetch(uid)
        const dm = await u.createDM()
        await dm.send({ content: text, components: [row] })
      } catch {}
    }
    return {}
  },
)

// ── Discord event handlers ────────────────────────────────────────────────────

client.once('ready', c => {
  process.stderr.write(`discord channel: connected as ${c.user.tag}\n`)
  mkdirSync(APPROVED_DIR, { recursive: true })
  setInterval(checkApprovals, 5_000).unref()
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  if (msg.author.id === client.user?.id) return
  handleInbound(msg).catch(e => process.stderr.write(`discord: handleInbound failed: ${e}\n`))
})

client.on('error', err => process.stderr.write(`discord channel: client error: ${err}\n`))

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
  if (!m) return
  const access = loadAccess()
  if (!access.allowFrom.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m
  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) { await interaction.reply({ content: 'Details no longer available.', ephemeral: true }).catch(() => {}); return }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    )
    await interaction.reply({ content: `🔐 **${details.tool_name}**\n${details.description}\n\`\`\`json\n${details.input_preview.slice(0, 800)}\n\`\`\``, components: [row], ephemeral: true }).catch(() => {})
    return
  }
  void mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id, behavior: behavior === 'allow' ? 'allow' : 'deny' },
  })
  void interaction.reply({ content: behavior === 'allow' ? '✅ Allowed' : '❌ Denied', ephemeral: true }).catch(() => {})
  pendingPermissions.delete(request_id)
})

// ── Boot ──────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return; shuttingDown = true
  process.stderr.write('discord channel: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord channel: login failed: ${err}\n`)
  process.exit(1)
})
