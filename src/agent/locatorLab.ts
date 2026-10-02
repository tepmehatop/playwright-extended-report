/**
 * Locator lab: checks Playwright locators against the page as it was at the moment of failure
 * (static HTML rebuilt from the trace snapshot) in a headless browser, before a fix lands in code.
 *
 * Only plain locator chains are accepted, e.g.
 *   page.getByRole('button', { name: 'Buy', exact: true }).first()
 *   page.locator('div.cart').filter({ hasText: /Cart/ })
 * They are parsed by a tiny parser below, never evaluated as code.
 * JavaScript is disabled on the page; external CSS is not available, so "visible" is approximate.
 */

import path from 'path';

export type LabResult = {
  locator: string;
  ok: boolean;
  count: number;
  visible?: boolean;
  text?: string;
  element?: string;
  error?: string;
};

type Arg = string | number | boolean | RegExp | { [key: string]: Arg };
type Step = { method: string, args: Arg[] };

const kMethods = new Set(['getByRole', 'getByText', 'getByTestId', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'locator', 'filter', 'first', 'last', 'nth']);
const kOptionKeys = new Set(['name', 'exact', 'hasText', 'hasNotText', 'checked', 'disabled', 'expanded', 'includeHidden', 'level', 'pressed', 'selected', 'visible']);

/** Parses a locator chain; returns the parsed steps and how many characters were consumed. */
export function parseLocatorChain(source: string): { steps: Step[], consumed: number } | undefined {
  let i = 0;
  const s = source;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]))
      i++;
  };
  const ident = (): string | undefined => {
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m)
      return undefined;
    i += m[0].length;
    return m[0];
  };
  const str = (): string | undefined => {
    const quote = s[i];
    if (quote !== '\'' && quote !== '"' && quote !== '`')
      return undefined;
    let out = '';
    i++;
    while (i < s.length && s[i] !== quote) {
      if (quote === '`' && s[i] === '$' && s[i + 1] === '{')
        return undefined;
      if (s[i] === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += s[i++];
    }
    if (s[i] !== quote)
      return undefined;
    i++;
    return out;
  };
  const arg = (): Arg | undefined => {
    ws();
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`')
      return str();
    if (c === '/') {
      const m = /^\/((?:\\.|[^/\\\n])+)\/([gimsuy]*)/.exec(s.slice(i));
      if (!m)
        return undefined;
      i += m[0].length;
      try {
        return new RegExp(m[1], m[2]);
      } catch {
        return undefined;
      }
    }
    if (/[-\d]/.test(c)) {
      const m = /^-?\d+/.exec(s.slice(i));
      if (!m)
        return undefined;
      i += m[0].length;
      return Number(m[0]);
    }
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (c === '{') {
      i++;
      const obj: { [key: string]: Arg } = {};
      while (true) {
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        const key = s[i] === '\'' || s[i] === '"' ? str() : ident();
        if (!key || !kOptionKeys.has(key))
          return undefined;
        ws();
        if (s[i] !== ':')
          return undefined;
        i++;
        const value = arg();
        if (value === undefined || (typeof value === 'object' && !(value instanceof RegExp)))
          return undefined;
        obj[key] = value;
        ws();
        if (s[i] === ',')
          i++;
      }
    }
    return undefined;
  };

  const steps: Step[] = [];
  ws();
  if (s.startsWith('page.', i))
    i += 5;
  let lastGood = 0;
  while (true) {
    const start = i;
    const method = ident();
    if (!method || !kMethods.has(method) || s[i] !== '(') {
      i = start;
      break;
    }
    i++;
    const args: Arg[] = [];
    ws();
    let failed = false;
    while (s[i] !== ')') {
      const a = arg();
      if (a === undefined) {
        failed = true;
        break;
      }
      args.push(a);
      ws();
      if (s[i] === ',') {
        i++;
        ws();
      } else if (s[i] !== ')') {
        failed = true;
        break;
      }
    }
    if (failed || s[i] !== ')') {
      i = start;
      break;
    }
    i++;
    steps.push({ method, args });
    lastGood = i;
    if (s[i] !== '.')
      break;
    i++;
  }
  if (!steps.length || !['getByRole', 'getByText', 'getByTestId', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'locator'].includes(steps[0].method))
    return undefined;
  return { steps, consumed: lastGood };
}

/** Finds locator expressions (page.getBy…(…)… chains) in code, e.g. in a proposed fix. */
export function extractLocators(code: string): string[] {
  const found = new Set<string>();
  let index = code.indexOf('page.');
  while (index !== -1) {
    const parsed = parseLocatorChain(code.slice(index));
    if (parsed)
      found.add(code.slice(index, index + parsed.consumed).trim());
    index = code.indexOf('page.', index + 5);
  }
  return [...found];
}

export function normalizeLocator(code: string): string {
  const trimmed = code.trim().replace(/;$/, '');
  return trimmed.startsWith('page.') ? trimmed : 'page.' + trimmed;
}

// ---------- browser ----------

let browserPromise: Promise<any> | undefined;
let idleTimer: NodeJS.Timeout | undefined;

function resolvePlaywrightCore(fromDirs: string[]): any {
  const resolveFrom = (request: string, paths: string[]) => require.resolve(request, { paths });
  for (const dir of fromDirs) {
    try {
      const testPkg = resolveFrom('@playwright/test/package.json', [dir]);
      const pwPkg = resolveFrom('playwright/package.json', [path.dirname(testPkg)]);
      return require(resolveFrom('playwright-core', [path.dirname(pwPkg)]));
    } catch {
    }
    try {
      return require(resolveFrom('playwright-core', [dir]));
    } catch {
    }
  }
  return require('playwright-core');
}

async function getBrowser(fromDirs: string[]) {
  if (idleTimer)
    clearTimeout(idleTimer);
  if (!browserPromise) {
    const core = resolvePlaywrightCore(fromDirs);
    if (process.env.EXTENDED_REPORT_TESTID_ATTRIBUTE)
      core.selectors.setTestIdAttribute(process.env.EXTENDED_REPORT_TESTID_ATTRIBUTE);
    const launching: Promise<any> = core.chromium.launch({ headless: true });
    launching.catch(() => {
      browserPromise = undefined;
    });
    browserPromise = launching;
  }
  const browser = await browserPromise;
  // Keep the browser warm for a minute between checks.
  idleTimer = setTimeout(() => {
    const p = browserPromise;
    browserPromise = undefined;
    p?.then(b => b.close()).catch(() => {});
  }, 60_000);
  idleTimer.unref?.();
  return browser;
}

export async function closeLocatorLab() {
  if (idleTimer)
    clearTimeout(idleTimer);
  const p = browserPromise;
  browserPromise = undefined;
  await p?.then(b => b.close()).catch(() => {});
}

export async function runLocatorLab(html: string, locators: string[], options: { fromDirs?: string[] } = {}): Promise<LabResult[]> {
  const unique = [...new Set(locators.map(normalizeLocator))].slice(0, 12);
  if (!unique.length)
    return [];
  const browser = await getBrowser([...(options.fromDirs ?? []), process.cwd()]);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const results: LabResult[] = [];
    for (const code of unique) {
      const parsed = parseLocatorChain(code);
      if (!parsed || parsed.consumed !== code.length) {
        results.push({ locator: code, ok: false, count: 0, error: 'not a plain locator chain (only page.getBy…/locator/filter/first/last/nth with literal arguments)' });
        continue;
      }
      try {
        let target: any = page;
        for (const step of parsed.steps)
          target = target[step.method](...step.args);
        const count: number = await target.count();
        const result: LabResult = { locator: code, ok: count === 1, count };
        if (count > 0) {
          const first = count > 1 ? target.first() : target;
          result.visible = await first.isVisible();
          result.text = ((await first.textContent({ timeout: 1000 })) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          result.element = await first.evaluate((e: any) => {
            const attrs = Array.from(e.attributes as any[]).slice(0, 4).map((a: any) => `${a.name}="${a.value.slice(0, 40)}"`).join(' ');
            return `<${e.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`;
          }, undefined, { timeout: 1000 });
        }
        results.push(result);
      } catch (e) {
        results.push({ locator: code, ok: false, count: 0, error: String(e.message || e).split('\n')[0].slice(0, 200) });
      }
    }
    return results;
  } finally {
    await context.close().catch(() => {});
  }
}

export function describeLab(results: LabResult[], lang: 'ru' | 'en'): string {
  return results.map(r => {
    if (r.error)
      return `- \`${r.locator}\` — ${lang === 'ru' ? 'ошибка' : 'error'}: ${r.error}`;
    if (r.count === 0)
      return `- \`${r.locator}\` — ✗ ${lang === 'ru' ? '0 элементов' : '0 elements'}`;
    const many = r.count > 1 ? (lang === 'ru' ? ` ⚠ ${r.count} элементов (нарушение strict mode, нужен более точный локатор)` : ` ⚠ ${r.count} elements (strict mode violation, needs a more specific locator)`) : (lang === 'ru' ? ' ✓ 1 элемент' : ' ✓ 1 element');
    return `- \`${r.locator}\` —${many}${r.element ? `: \`${r.element}\`` : ''}${r.text ? ` «${r.text}»` : ''}${r.visible === false ? (lang === 'ru' ? ' (скрыт)' : ' (hidden)') : ''}`;
  }).join('\n');
}
