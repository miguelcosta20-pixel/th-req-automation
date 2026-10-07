import type { ParsedAttachment, DocumentBlock } from './types';

export interface AttachmentSelection {
  documentBlocks: DocumentBlock[];
  // Filenames of PDFs skipped because they exceeded the page limit.
  overLimitFilenames: string[];
}

// Heuristic page counter that avoids pulling in a full PDF library.
// Counts /Type /Page (not /Pages) objects in the raw PDF byte stream.
// Works for the vast majority of well-formed PDFs. Falls back to 1 on parse
// failure so a single-page scan is never wrongly rejected.
export function countPdfPages(data: Buffer): number {
  try {
    const text = data.toString('latin1');
    // /Type /Page but NOT /Type /Pages
    const matches = text.match(/\/Type\s*\/Page(?!\s*s\b)/g);
    return matches ? Math.max(matches.length, 1) : 1;
  } catch {
    return 1;
  }
}

export function selectAttachments(
  attachments: ParsedAttachment[],
  pageLimit: number,
): AttachmentSelection {
  const documentBlocks: DocumentBlock[] = [];
  const overLimitFilenames: string[] = [];

  for (const att of attachments) {
    if (!att.contentType.toLowerCase().includes('pdf')) continue;

    const pages = countPdfPages(att.content);
    if (pages > pageLimit) {
      overLimitFilenames.push(att.filename);
      continue;
    }

    documentBlocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: att.content.toString('base64'),
      },
      title: att.filename,
    });
  }

  return { documentBlocks, overLimitFilenames };
}
