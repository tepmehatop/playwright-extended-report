/**
 * Copying that works where navigator.clipboard does not: VS Code / IDE webviews, reports served
 * over plain http (Jenkins), denied permissions. Order:
 *  1. document.execCommand('copy') — synchronous, inside the click, works in webviews and on http;
 *  2. navigator.clipboard.writeText — secure contexts;
 *  3. otherwise the caller shows the text selected for manual Ctrl+C / ⌘C.
 */

import * as React from 'react';
import { texts } from './i18n';

function copyWithSelection(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0';
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  active?.focus?.();
  return ok;
}

/** Must be called directly from a click handler (before any await). */
export async function copyText(text: string): Promise<boolean> {
  if (copyWithSelection(text))
    return true;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  return false;
}

/** Copy state + a fallback box with the selected text when the browser blocks copying. */
export function useCopy(): { copied: string | undefined, failedText: string | undefined, copy: (key: string, text: string) => void, fallback: React.ReactNode } {
  const [copied, setCopied] = React.useState<string>();
  const [failedText, setFailedText] = React.useState<string>();
  const copy = React.useCallback((key: string, text: string) => {
    copyText(text).then(ok => {
      if (ok) {
        setFailedText(undefined);
        setCopied(key);
        setTimeout(() => setCopied(current => current === key ? undefined : current), 2500);
      } else {
        setFailedText(text);
      }
    });
  }, []);
  const fallback = failedText !== undefined ? <ManualCopy text={failedText} onClose={() => setFailedText(undefined)} /> : null;
  return { copied, failedText, copy, fallback };
}

const ManualCopy: React.FC<{ text: string, onClose: () => void }> = ({ text, onClose }) => {
  const t = texts();
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [text]);
  return <div className='manual-copy' data-testid='manual-copy'>
    <div className='manual-copy-header'>
      <span>{t.copyManually}</span>
      <button className='link-button' onClick={onClose}>✕</button>
    </div>
    <textarea ref={ref} readOnly value={text} rows={Math.min(12, text.split('\n').length + 1)} onFocus={e => e.currentTarget.select()} />
  </div>;
};
