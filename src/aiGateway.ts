/**
 * Minimal "Ask AI" backend used by the Insights tab.
 *
 * The report is a static file and must not contain API keys, so the button
 * POSTs the prompt to this handler, which forwards it to an OpenAI-compatible
 * Chat Completions API (OpenAI, Azure OpenAI proxy, vLLM, Ollama, LiteLLM, an
 * internal gateway...). Mounted by `pw-extended-report show --ai` or run
 * standalone with `pw-extended-report ai-gateway`.
 */

import type http from 'http';

import type { AskAiRequest, AskAiResponse } from './shared/insightsFormat';

export type AiOptions = {
  mode: 'openai' | 'mock';
  /** e.g. https://api.openai.com/v1 or http://llm.internal/v1 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Answer language, e.g. "Russian". */
  language?: string;
  /** Allowed CORS origin for the standalone gateway ("*" by default). */
  corsOrigin?: string;
};

export function aiOptionsFromEnv(mock: boolean): AiOptions {
  return {
    mode: mock ? 'mock' : 'openai',
    baseUrl: process.env.EXTENDED_REPORT_AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.EXTENDED_REPORT_AI_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.EXTENDED_REPORT_AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    language: process.env.EXTENDED_REPORT_AI_LANGUAGE,
  };
}

/** Handles /api/ai/status and /api/ai/ask. Returns false for other URLs. */
export function handleAiRequest(options: AiOptions, request: http.IncomingMessage, response: http.ServerResponse, cors: boolean): boolean {
  const url = new URL(request.url || '/', 'http://localhost');
  if (!url.pathname.endsWith('/api/ai/status') && !url.pathname.endsWith('/api/ai/ask'))
    return false;
  if (cors) {
    response.setHeader('Access-Control-Allow-Origin', options.corsOrigin || '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return true;
    }
  }
  if (url.pathname.endsWith('/api/ai/status')) {
    sendJson(response, 200, { enabled: true, model: options.mode === 'mock' ? 'mock' : options.model });
    return true;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'POST expected' });
    return true;
  }
  readBody(request).then(async body => {
    const ask = JSON.parse(body) as AskAiRequest;
    if (typeof ask.prompt !== 'string' || !ask.prompt)
      throw new Error('prompt is required');
    const answer = options.mode === 'mock' ? mockAnswer(ask) : await callChatCompletions(options, ask.prompt);
    sendJson(response, 200, answer);
  }).catch(e => sendJson(response, 500, { error: String(e?.message || e) }));
  return true;
}

async function callChatCompletions(options: AiOptions, prompt: string): Promise<AskAiResponse> {
  if (!options.apiKey && /openai\.com/.test(options.baseUrl || ''))
    throw new Error('No API key: set EXTENDED_REPORT_AI_API_KEY (or OPENAI_API_KEY), or EXTENDED_REPORT_AI_BASE_URL for a keyless internal model');
  const system = 'You help QA engineers triage failed Playwright tests. Be precise and concise, base conclusions on the provided evidence only.'
    + (options.language ? ` Answer in ${options.language}.` : '');
  const response = await fetch(options.baseUrl!.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  });
  if (!response.ok)
    throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as any;
  const markdown = json?.choices?.[0]?.message?.content;
  if (typeof markdown !== 'string')
    throw new Error('LLM API returned no message content');
  return { markdown, model: json.model || options.model };
}

/** Deterministic answer built from the prompt, to try the flow without a model. */
function mockAnswer(ask: AskAiRequest): AskAiResponse {
  const classification = ask.prompt.match(/## Rule-based classification\n(.+)/)?.[1] ?? 'unclassified';
  const kind = classification.split(' (')[0];
  const advice: Record<string, string> = {
    'product bug': 'Report it to the developers with the trace and the browser error; keep the assertion as is.',
    'test bug': 'Update the locator / expectation in the test. Check the page snapshot in the prompt for the element that is actually rendered.',
    'environment': 'Check the backend / stand health for the failing endpoint before touching the test; rerun after the service recovers.',
    'UI change': 'If the change is intended, update the baseline with `--update-snapshots`; otherwise report a visual regression.',
    'flaky': 'Compare the failed and passed attempts; replace timing assumptions with web-first assertions and stabilise test data.',
  };
  return {
    model: 'mock (no LLM configured)',
    markdown: [
      `> This is a **mock** answer: \`pw-extended-report show --ai-mock\` was used. Configure a model with \`--ai\` to get a real analysis.`,
      '',
      `**Test:** ${ask.test.titlePath.join(' › ') || ask.test.title} (\`${ask.test.file}:${ask.test.line}\`)`,
      '',
      `**Classification:** ${classification}`,
      '',
      `**Suggested next step:** ${advice[kind] ?? 'Open the trace and inspect the step that failed.'}`,
    ].join('\n'),
  };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.on('error', reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
