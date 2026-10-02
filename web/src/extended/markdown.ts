import { marked } from 'marked';
import DOMPurify from 'dompurify';

let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled)
    return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    // External links open in a new tab; in-report links (#?...) keep SPA navigation.
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

/** Content comes from an LLM / log parser: never trust it, always sanitize. */
export function sanitizeHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  });
}

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { gfm: true, async: false }) as string;
  return sanitizeHtml(html);
}

export function slugify(text: string): string {
  return text.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
}
