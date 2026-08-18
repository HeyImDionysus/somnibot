/**
 * Transcript Generator — Creates HTML transcripts from ticket channels.
 *
 * Reads all messages from a ticket channel, builds a styled HTML document,
 * stores it in Supabase, and optionally posts to a transcript channel / DMs the creator.
 *
 * Architecture doc §19.6
 */

import type { TextChannel, Message, Collection, Snowflake, Guild, AttachmentBuilder } from 'discord.js';
import { AttachmentBuilder as DiscordAttachmentBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbTicket, DbTicketPanel } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { colorToHex, createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { resolveBrandKit, type BrandKit } from '../branding/index.js';
import { voice } from '../branding/voice.js';

const log = createLogger('Transcript');

/**
 * Report a transcript-generation failure: raise an owner alert (alerts table)
 * and emit a 'ticket.transcript_failed' audit event. Previously these branches
 * only log.error'd and returned an error string, so a failed transcript (DB
 * outage, fetch error) was invisible to the owner and left no audit trail.
 */
async function reportTranscriptFailure(
  supabase: SupabaseClient,
  eventBus: PlatformEventBus | undefined,
  guild: Guild,
  ticket: DbTicket,
  errorMessage: string,
): Promise<void> {
  eventBus?.emit('ticket.transcript_failed', guild.id, {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    error: errorMessage,
  });
  try {
    await raiseOwnerAlert(supabase, guild.id, {
      alertType: 'ticket_transcript_failed',
      severity: 'warning',
      title: 'Ticket transcript could not be generated',
      message:
        `The transcript for ticket #${ticket.ticket_number} could not be generated/saved: ${errorMessage}. ` +
        `The conversation record may be missing.`,
      // Raw error strings stay in the alerts ROW (message/metadata above);
      // the channel-visible notice is generic plain language.
      channelMessage:
        `The transcript for ticket #${ticket.ticket_number} couldn't be generated or saved — ` +
        `details are on the dashboard Alerts page. The conversation record may be missing.`,
      metadata: { ticket_id: ticket.id, ticket_number: ticket.ticket_number, error: errorMessage },
      guild,
    });
  } catch (alertErr) {
    log.error('Failed to write transcript-failure alert:', { error: String(alertErr) });
  }
}

interface TranscriptMessage {
  author: {
    id: string;
    tag: string;
    displayName: string;
    avatarUrl: string | null;
    isBot: boolean;
  };
  content: string;
  timestamp: string;
  attachments: { name: string; url: string; contentType: string | null }[];
  embeds: { title: string | null; description: string | null }[];
}

// ── Fetch All Messages ───────────────────────────────────

/** Maximum messages to include in a transcript to prevent timeouts and OOM */
const TRANSCRIPT_MESSAGE_CAP = 10_000;

async function fetchAllMessages(channel: TextChannel): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  let lastId: string | undefined;
  let capped = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // V53 Phase 5 (5.2): Cap at 10k messages to prevent timeouts
    if (messages.length >= TRANSCRIPT_MESSAGE_CAP) {
      capped = true;
      break;
    }

    const options: { limit: number; before?: string } = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch: Collection<Snowflake, Message> = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      messages.push({
        author: {
          id: msg.author.id,
          tag: msg.author.tag,
          displayName: msg.member?.displayName || msg.author.displayName,
          avatarUrl: msg.author.displayAvatarURL({ size: 64 }),
          isBot: msg.author.bot,
        },
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.map((a) => ({
          name: a.name,
          url: a.url,
          contentType: a.contentType,
        })),
        embeds: msg.embeds.map((e) => ({
          title: e.title,
          description: e.description,
        })),
      });
    }

    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }

  if (capped) {
    log.warn(`Message cap reached (${TRANSCRIPT_MESSAGE_CAP}). Ticket channel ${channel.id} has more messages than included.`);
  }

  // Reverse so oldest first
  return messages.reverse();
}

// ── Generate HTML ────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDiscordMarkdown(text: string): string {
  let html = escapeHtml(text);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Code blocks
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  // User mentions
  html = html.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>');
  // Channel mentions
  html = html.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#$1</span>');
  // Role mentions
  html = html.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@role-$1</span>');
  // Newlines
  html = html.replace(/\n/g, '<br>');
  return html;
}

function generateTranscriptHtml(
  messages: TranscriptMessage[],
  ticket: DbTicket,
  guildName: string,
  kit: BrandKit,
): string {
  // White-label: the accent hues come from the owner's brand kit (primary for
  // bot/embed accents, accent for links) while the neutral dark theme stays
  // untouched for readability.
  const accent = colorToHex(kit.primaryColor);
  const linkAccent = colorToHex(kit.accentColor);
  const accentR = (kit.primaryColor >> 16) & 0xff;
  const accentG = (kit.primaryColor >> 8) & 0xff;
  const accentB = kit.primaryColor & 0xff;
  const footerText = kit.poweredByAttribution
    ? `Generated by ${escapeHtml(kit.brandName)} • ${escapeHtml(kit.poweredByAttribution)}`
    : `Generated by ${escapeHtml(kit.brandName)}`;
  const transcriptVoice = voice(kit.voicePreset, 'success', {
    message: `${kit.brandName} support transcript — the conversation is preserved below.`,
  });

  const participants = [...new Set(messages.map((m) => m.author.tag))];
  const createdDate = new Date(ticket.created_at).toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const closedDate = ticket.closed_at
    ? new Date(ticket.closed_at).toLocaleString('en-US', {
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : 'N/A';

  const messageHtml = messages
    .map((msg) => {
      const time = new Date(msg.timestamp).toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        month: 'short',
        day: 'numeric',
      });

      const attachmentHtml = msg.attachments
        .map(
          (a) =>
            `<div class="attachment"><a href="${escapeHtml(a.url)}" target="_blank">📎 ${escapeHtml(a.name)}</a></div>`,
        )
        .join('');

      const embedHtml = msg.embeds
        .map(
          (e) =>
            `<div class="embed">${e.title ? `<div class="embed-title">${escapeHtml(e.title)}</div>` : ''}${e.description ? `<div class="embed-desc">${escapeHtml(e.description)}</div>` : ''}</div>`,
        )
        .join('');

      return `
      <div class="message ${msg.author.isBot ? 'bot-message' : ''}">
        <div class="avatar">
          ${msg.author.avatarUrl ? `<img src="${escapeHtml(msg.author.avatarUrl)}" alt="" />` : '<div class="avatar-placeholder"></div>'}
        </div>
        <div class="content">
          <div class="header">
            <span class="author ${msg.author.isBot ? 'bot' : ''}">${escapeHtml(msg.author.displayName)}</span>
            ${msg.author.isBot ? '<span class="bot-badge">BOT</span>' : ''}
            <span class="timestamp">${time}</span>
          </div>
          ${msg.content ? `<div class="text">${formatDiscordMarkdown(msg.content)}</div>` : ''}
          ${attachmentHtml}
          ${embedHtml}
        </div>
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ticket #${ticket.ticket_number} — Transcript</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      background: #313338;
      color: #dcddde;
      line-height: 1.5;
    }
    .header-bar {
      background: #1e1f22;
      border-bottom: 1px solid #3f4147;
      padding: 20px 24px;
    }
    .header-bar h1 {
      font-size: 18px;
      color: #f2f3f5;
      margin-bottom: 8px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
      color: #949ba4;
    }
    .brand-voice {
      margin-top: 8px;
      color: ${linkAccent};
      font-size: 13px;
    }
    .meta span { display: flex; align-items: center; gap: 4px; }
    .messages { padding: 16px 0; }
    .message {
      display: flex;
      gap: 12px;
      padding: 4px 24px;
      min-height: 2.75rem;
    }
    .message:hover { background: #2e3035; }
    .avatar { flex-shrink: 0; width: 40px; height: 40px; }
    .avatar img {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }
    .avatar-placeholder {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: ${accent};
    }
    .content { flex: 1; min-width: 0; }
    .header { display: flex; align-items: baseline; gap: 8px; }
    .author { font-weight: 600; font-size: 15px; color: #f2f3f5; }
    .author.bot { color: ${accent}; }
    .bot-badge {
      background: ${accent};
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
    }
    .timestamp { font-size: 12px; color: #949ba4; }
    .text { font-size: 15px; word-wrap: break-word; margin-top: 2px; }
    .text code {
      background: #2b2d31;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 13px;
    }
    .text pre {
      background: #2b2d31;
      padding: 8px;
      border-radius: 4px;
      margin: 4px 0;
      overflow-x: auto;
    }
    .text strong { color: #f2f3f5; }
    .mention {
      background: rgba(${accentR}, ${accentG}, ${accentB}, 0.3);
      color: #dee0fc;
      padding: 0 2px;
      border-radius: 3px;
      font-weight: 500;
    }
    .attachment {
      margin-top: 4px;
      padding: 8px 12px;
      background: #2b2d31;
      border-radius: 4px;
      border: 1px solid #3f4147;
    }
    .attachment a { color: ${linkAccent}; text-decoration: none; }
    .attachment a:hover { text-decoration: underline; }
    .embed {
      margin-top: 4px;
      padding: 8px 12px;
      background: #2b2d31;
      border-left: 3px solid ${accent};
      border-radius: 4px;
    }
    .embed-title { font-weight: 600; color: #f2f3f5; margin-bottom: 4px; }
    .embed-desc { font-size: 14px; color: #dcddde; }
    .footer {
      background: #1e1f22;
      border-top: 1px solid #3f4147;
      padding: 16px 24px;
      text-align: center;
      font-size: 12px;
      color: #949ba4;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <h1>🎫 Ticket #${ticket.ticket_number} — Transcript</h1>
    <p class="brand-voice">${escapeHtml(transcriptVoice)}</p>
    <div class="meta">
      <span>📌 Server: ${escapeHtml(guildName)}</span>
      <span>👤 Created by: ${escapeHtml(messages[0]?.author.tag || ticket.creator_id)}</span>
      <span>📅 Opened: ${createdDate}</span>
      <span>🔒 Closed: ${closedDate}</span>
      <span>💬 Messages: ${messages.length}</span>
      <span>👥 Participants: ${participants.length}</span>
    </div>
  </div>
  <div class="messages">
    ${messageHtml}
  </div>
  <div class="footer">
    ${footerText} • ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}
  </div>
</body>
</html>`;
}

// ── Generate & Store Transcript ──────────────────────────

export async function generateTranscript(
  guild: Guild,
  ticket: DbTicket,
  supabase: SupabaseClient,
  eventBus?: PlatformEventBus,
): Promise<{ success: boolean; html?: string; error?: string }> {
  if (!ticket.channel_id) {
    return { success: false, error: 'Ticket has no channel.' };
  }
  const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: 'Ticket channel not found.' };
  }

  try {
    const messages = await fetchAllMessages(channel);
    const kit = await resolveBrandKit(supabase, guild.id, { fallbackName: guild.name });
    const html = generateTranscriptHtml(messages, ticket, guild.name, kit);
    const participantIds = [...new Set(messages.filter((m) => !m.author.isBot).map((m) => m.author.id))];

    // Save transcript to DB
    const { error: dbError } = await supabase.from('ticket_transcripts').insert({
      guild_id: guild.id,
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      creator_id: ticket.creator_id,
      closed_by_id: ticket.closed_by || 'unknown',
      message_count: messages.length,
      participant_ids: participantIds,
      html_content: html,
    });

    const isTranscriptReplay = dbError?.code === '23505' && [dbError.message, dbError.details, dbError.hint]
      .some((field) => field?.includes('ticket_transcripts_guild_ticket_key'));
    if (isTranscriptReplay) {
      const { data: stored, error: storedError } = await supabase
        .from('ticket_transcripts')
        .select('html_content')
        .eq('guild_id', guild.id)
        .eq('ticket_id', ticket.id)
        .single();
      if (!storedError && stored) return { success: true, html: stored.html_content };
    }
    if (dbError) {
      log.error('Failed to save transcript:', dbError.message);
      await reportTranscriptFailure(supabase, eventBus, guild, ticket, dbError.message);
      return { success: false, error: 'Failed to save transcript.' };
    }

    // Update ticket with message count
    await supabase
      .from('tickets')
      .update({ message_count: messages.length, transcript_path: `transcript:${ticket.ticket_number}` })
      .eq('id', ticket.id);

    // Post to transcript channel if configured
    const { data: panel } = await supabase
      .from('ticket_panels')
      .select('transcript_channel_id, dm_transcript_to_creator')
      .eq('id', ticket.panel_id)
      .single();

    if (panel?.transcript_channel_id) {
      const transcriptChannel = guild.channels.cache.get(panel.transcript_channel_id) as TextChannel | undefined;
      if (transcriptChannel) {
        const file = new DiscordAttachmentBuilder(Buffer.from(html, 'utf-8'), {
          name: `ticket-${ticket.ticket_number}-transcript.html`,
        });
        await transcriptChannel.send({
          content: voice(kit.voicePreset, 'success', {
            message: `Transcript for ${kit.brandName} ticket #${ticket.ticket_number} (${messages.length} messages)`,
          }),
          files: [file],
          // an archived transcript must not re-ping anyone quoted in it.
          allowedMentions: { parse: [] },
        });
      }
    }

    // DM transcript to creator if enabled
    if (panel?.dm_transcript_to_creator) {
      try {
        const member = await guild.members.fetch(ticket.creator_id);
        const file = new DiscordAttachmentBuilder(Buffer.from(html, 'utf-8'), {
          name: `ticket-${ticket.ticket_number}-transcript.html`,
        });
        await member.send({
          content: voice(kit.voicePreset, 'success', {
            message: `Here is the transcript for your closed ${kit.brandName} ticket #${ticket.ticket_number}.`,
          }),
          files: [file],
          // an archived transcript must not re-ping anyone quoted in it.
          allowedMentions: { parse: [] },
        });
      } catch {
        log.warn('Could not DM transcript to ticket creator');
      }
    }

    log.info(`Transcript generated for ticket #${ticket.ticket_number} (${messages.length} messages)`);
    return { success: true, html };
  } catch (err) {
    log.error('Transcript generation failed:', { error: String(err) });
    await reportTranscriptFailure(supabase, eventBus, guild, ticket, String(err));
    return { success: false, error: 'Transcript generation failed.' };
  }
}
