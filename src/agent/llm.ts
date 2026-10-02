/**
 * LLM client for closed-contour providers. All of them speak the OpenAI
 * Chat Completions format and differ only in authentication:
 *
 *  - openai          any OpenAI-compatible endpoint (proxy LLM, vLLM, Ollama, LiteLLM...): Bearer key
 *  - gigachat        GigaChat: OAuth token from GIGACHAT_AUTH_URL (Basic key + scope), then Bearer
 *  - gigacode-ift-ssl  OpenAI-compatible endpoint behind mutual TLS (client cert + key)
 *  - gigacode-cli    token and model URLs from the GigaCode CLI file ~/.gigacode/gigacode_token.json
 *  - mock            canned answers, for demos and tests
 *
 * Env variable names follow shmoker-ai (LLM_PROVIDER, PROXY_BASE_URL, GIGACHAT_*...) so the
 * same .env can be reused; EXTENDED_REPORT_AI_* take precedence.
 *
 * The agent never relies on native tool calling (GigaChat ignores `tools`, small models skip
 * them): every action is performed by our code, the model only reasons over the collected data.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';

export type LlmProvider = 'openai' | 'gigachat' | 'gigacode-ift-ssl' | 'gigacode-cli' | 'mock';

export type LlmConfig = {
  provider: LlmProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  gigachat?: { authUrl: string, authKey?: string, scope: string };
  /** mTLS client certificate / key (PEM file paths). */
  certFile?: string;
  keyFile?: string;
  /** Skip TLS verification (internal CAs). */
  insecure?: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Budget for the evidence put into one prompt. */
  maxContextChars: number;
  /** Answer language, e.g. "Russian". */
  language?: string;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant', content: string };
export type ChatResult = { content: string, model: string, usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } };

const env = (...names: string[]) => names.map(n => process.env[n]).find(v => v !== undefined && v !== '');
const bool = (value: string | undefined) => value !== undefined && /^(1|true|yes)$/i.test(value);

export function llmConfigFromEnv(overrides: { mock?: boolean } = {}): LlmConfig {
  const rawProvider = (env('EXTENDED_REPORT_AI_PROVIDER', 'LLM_PROVIDER') || 'openai').toLowerCase().replace(/_/g, '-');
  const provider: LlmProvider = overrides.mock ? 'mock'
    : rawProvider === 'proxy' ? 'openai'
      : (['openai', 'gigachat', 'gigacode-ift-ssl', 'gigacode-cli', 'mock'] as LlmProvider[]).includes(rawProvider as LlmProvider) ? rawProvider as LlmProvider
        : 'openai';
  return {
    provider,
    model: env('EXTENDED_REPORT_AI_MODEL', 'LLM_MODEL', 'OPENAI_MODEL') || (provider === 'gigachat' ? 'GigaChat' : provider === 'openai' ? 'gpt-4o-mini' : undefined),
    baseUrl: provider === 'gigachat'
      ? env('EXTENDED_REPORT_AI_BASE_URL', 'GIGACHAT_API_URL') || 'https://gigachat.devices.sberbank.ru/api/v1'
      : env('EXTENDED_REPORT_AI_BASE_URL', 'PROXY_BASE_URL', 'OPENAI_BASE_URL') || (provider === 'openai' ? 'https://api.openai.com/v1' : undefined),
    apiKey: env('EXTENDED_REPORT_AI_API_KEY', 'PROXY_API_KEY', 'OPENAI_API_KEY'),
    gigachat: {
      authUrl: env('GIGACHAT_AUTH_URL') || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      authKey: env('GIGACHAT_AUTHORIZATION_KEY'),
      scope: env('GIGACHAT_SCOPE') || 'GIGACHAT_API_PERS',
    },
    certFile: env('EXTENDED_REPORT_AI_CERT'),
    keyFile: env('EXTENDED_REPORT_AI_KEY'),
    insecure: bool(env('EXTENDED_REPORT_AI_INSECURE')) || (provider === 'gigachat' && env('GIGACHAT_VERIFY_SSL') !== undefined && !bool(env('GIGACHAT_VERIFY_SSL'))) || provider === 'gigacode-ift-ssl',
    maxTokens: Number(env('EXTENDED_REPORT_AI_MAX_TOKENS') || 2500),
    temperature: Number(env('EXTENDED_REPORT_AI_TEMPERATURE') || 0.2),
    timeoutMs: Number(env('EXTENDED_REPORT_AI_TIMEOUT_MS') || 180_000),
    maxContextChars: Number(env('EXTENDED_REPORT_AI_MAX_CHARS') || 48_000),
    language: env('EXTENDED_REPORT_AI_LANGUAGE'),
  };
}

export function describeLlm(config: LlmConfig): string {
  if (config.provider === 'mock')
    return 'mock answers (no model)';
  return `${config.provider}${config.model ? ` · ${config.model}` : ''}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`;
}

export async function chat(config: LlmConfig, messages: ChatMessage[], mockAnswer?: () => string): Promise<ChatResult> {
  if (config.provider === 'mock')
    return { content: mockAnswer ? mockAnswer() : 'Mock answer.', model: 'mock' };

  const { url, headers } = await endpoint(config);
  const body = JSON.stringify({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  });
  let response = await request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body }, config);
  // GigaChat answers 404 when the model tier is unavailable / out of tokens: retry with the base model.
  if (config.provider === 'gigachat' && response.status === 404 && config.model !== 'GigaChat')
    response = await request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(body), model: 'GigaChat' }) }, config);
  if (response.status === 401 && config.provider === 'gigachat')
    gigachatToken = undefined;
  if (response.status < 200 || response.status >= 300)
    throw new Error(`LLM ${config.provider} HTTP ${response.status}: ${response.text.slice(0, 500)}`);
  let json: any;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new Error(`LLM ${config.provider} returned non-JSON: ${response.text.slice(0, 300)}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error(`LLM ${config.provider} returned an empty message`);
  return { content: stripThinking(content), model: json.model || config.model || config.provider, usage: json.usage };
}

/** qwen3 / deepseek style reasoning blocks are noise for the user. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function endpoint(config: LlmConfig): Promise<{ url: string, headers: Record<string, string> }> {
  switch (config.provider) {
    case 'gigachat': {
      const token = await getGigachatToken(config);
      return { url: joinUrl(config.baseUrl!, '/chat/completions'), headers: { Authorization: `Bearer ${token}` } };
    }
    case 'gigacode-cli': {
      const cli = readGigacodeCli(config.model);
      return { url: joinUrl(cli.baseUrl, '/chat/completions'), headers: { Authorization: `Bearer ${cli.token}` } };
    }
    default: {
      if (!config.baseUrl)
        throw new Error('EXTENDED_REPORT_AI_BASE_URL (or PROXY_BASE_URL) is not set');
      const headers: Record<string, string> = {};
      if (config.apiKey && config.apiKey !== 'none')
        headers.Authorization = `Bearer ${config.apiKey}`;
      return { url: joinUrl(config.baseUrl, '/chat/completions'), headers };
    }
  }
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix;
}

let gigachatToken: { value: string, expiresAt: number } | undefined;

async function getGigachatToken(config: LlmConfig): Promise<string> {
  if (gigachatToken && Date.now() < gigachatToken.expiresAt - 60_000)
    return gigachatToken.value;
  const g = config.gigachat!;
  if (!g.authKey)
    throw new Error('GIGACHAT_AUTHORIZATION_KEY is not set');
  const response = await request(g.authUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${g.authKey}`,
      'RqUID': crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `scope=${encodeURIComponent(g.scope)}`,
  }, config);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`GigaChat auth HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  const json = JSON.parse(response.text);
  // expires_at is a unix timestamp in milliseconds; tokens live 30 minutes.
  const expiresAt = typeof json.expires_at === 'number' ? json.expires_at : Date.now() + 25 * 60_000;
  gigachatToken = { value: json.access_token, expiresAt: Math.min(expiresAt, Date.now() + 30 * 60_000) };
  return gigachatToken.value;
}

/** Reads ~/.gigacode/gigacode_token.json: {token, expiryDate, config: {chat: {models: [{model, url}]}}}. */
export function readGigacodeCli(model?: string): { token: string, baseUrl: string, model: string } {
  const file = process.env.GIGACODE_TOKEN_FILE || path.join(os.homedir(), '.gigacode', 'gigacode_token.json');
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`GigaCode CLI token file not readable: ${file} (${e.message}). Log in with the GigaCode CLI first.`);
  }
  const token = data.token || data.access_token;
  if (!token)
    throw new Error(`No token in ${file}`);
  const models: any[] = data?.config?.chat?.models || data?.config?.agent?.models || data?.models || [];
  const entry = models.find(m => (m.model || m.name || m.id) === model) || models[0];
  const url = entry?.url || entry?.base_url || entry?.endpoint || process.env.EXTENDED_REPORT_AI_BASE_URL;
  if (!url)
    throw new Error(`No model URL in ${file}; set EXTENDED_REPORT_AI_BASE_URL`);
  return { token, baseUrl: String(url).replace(/\/(chat\/)?completions\/?$/, ''), model: model || entry?.model || entry?.name || entry?.id };
}

type RawResponse = { status: number, text: string };

function request(url: string, options: { method: string, headers: Record<string, string>, body?: string }, config: LlmConfig): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const tls: https.RequestOptions = isHttps ? {
      rejectUnauthorized: !config.insecure,
      cert: config.certFile ? fs.readFileSync(config.certFile) : undefined,
      key: config.keyFile ? fs.readFileSync(config.keyFile) : undefined,
    } : {};
    const req = (isHttps ? https : http).request(target, {
      method: options.method,
      headers: { ...options.headers, ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body) } : {}) },
      timeout: config.timeoutMs,
      ...tls,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`LLM request timed out after ${config.timeoutMs}ms`)));
    req.on('error', reject);
    if (options.body)
      req.write(options.body);
    req.end();
  });
}
