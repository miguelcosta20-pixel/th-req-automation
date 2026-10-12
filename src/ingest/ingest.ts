import { simpleParser } from 'mailparser';
import { createHash } from 'crypto';
import type { ParsedEmail, ParsedAttachment } from '../types';

export async function ingestEml(raw: string | Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw, { skipTextToHtml: false });

  // Strip angle brackets so message-id comparisons are consistent. mailparser
  // returns Message-ID as <id@host> but In-Reply-To normalised differently;
  // we normalise both the same way so idempotency and thread-based correction
  // lookups (requisition.message_id = inReplyTo) actually match.
  const messageId = (parsed.messageId ?? generateMessageId(raw)).replace(/^<|>$/g, '');

  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map(att => ({
    filename: att.filename ?? 'attachment',
    contentType: att.contentType,
    content: att.content,
    sha256: createHash('sha256').update(att.content).digest('hex'),
  }));

  return {
    messageId,
    // In-Reply-To may also arrive as <id@host>; strip to match messageId above.
    inReplyTo: parsed.inReplyTo ? parsed.inReplyTo.replace(/^<|>$/g, '') : null,
    from: {
      name:    parsed.from?.value?.[0]?.name,
      address: parsed.from?.value?.[0]?.address,
    },
    subject:     parsed.subject ?? '(no subject)',
    textBody:    parsed.text    ?? '',
    htmlBody:    typeof parsed.html === 'string' ? parsed.html : '',
    receivedAt:  parsed.date   ?? new Date(),
    attachments,
  };
}

// Stable synthetic ID when the email lacks a Message-ID header (e.g. forwarded emails).
function generateMessageId(raw: string | Buffer): string {
  return 'generated-' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
