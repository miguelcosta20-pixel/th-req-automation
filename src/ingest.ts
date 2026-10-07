import { simpleParser } from 'mailparser';
import { createHash } from 'crypto';
import type { ParsedEmail, ParsedAttachment } from './types';

export async function ingestEml(raw: string | Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw, { skipTextToHtml: false });

  const messageId = parsed.messageId ?? generateMessageId(raw);

  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map(att => ({
    filename: att.filename ?? 'attachment',
    contentType: att.contentType,
    content: att.content,
    sha256: createHash('sha256').update(att.content).digest('hex'),
  }));

  return {
    messageId,
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
