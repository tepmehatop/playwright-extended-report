/**
 * Minimal, dependency-free MCP client (JSON-RPC 2.0) for the agent:
 * stdio, Streamable HTTP and legacy SSE transports; initialize, tools/list, tools/call.
 *
 * Servers are configured with the usual `mcpServers` JSON (Claude Code / Cursor / GigaCode CLI
 * format), so an existing `.mcp.json` can be reused as is:
 *
 *   { "mcpServers": {
 *       "serena":   { "command": "uvx", "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--project", "${REPO}", "--enable-web-dashboard", "false"] },
 *       "context7": { "type": "http", "url": "http://context7.internal/mcp", "headers": { "Authorization": "Bearer ..." } },
 *       "code-index": { "command": "uvx", "args": ["code-index-mcp", "--project-path", "${REPO}"], "tools": ["search_code_advanced", "find_files"] }
 *   } }
 *
 * Lookup order: --mcp-config, EXTENDED_REPORT_MCP_CONFIG, <repo>/.pw-extended-report/mcp.json,
 * <repo>/.mcp.json, ~/.pw-extended-report/mcp.json. EXTENDED_REPORT_MCP=off disables MCP.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import type { ChildProcessWithoutNullStreams } from 'child_process';

export type McpServerConfig = {
  type?: 'stdio' | 'http' | 'sse' | 'streamable-http';
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Allowlist of tool names exposed to the model (keeps prompts small for local models). */
  tools?: string[];
  disabled?: boolean;
  /** Seconds. */
  timeout?: number;
};

export type McpConfig = { mcpServers: Record<string, McpServerConfig> };

export type McpTool = {
  server: string;
  name: string;
  /** Name sent to the model: server__tool, [A-Za-z0-9_] only (GigaChat requirement). */
  wireName: string;
  description: string;
  inputSchema: any;
};

export type McpServerStatus = { name: string, status: 'connected' | 'error' | 'disabled', tools: number, error?: string };

const kProtocolVersion = '2025-03-26';

/**
 * Default allowlists for servers people commonly use: read-only, useful for debugging tests.
 * Matching is by substring of the configured server name. Unknown servers expose all their tools
 * (capped), override with "tools" in the config.
 */
const kDefaultAllowlists: { match: RegExp, tools: string[] }[] = [
  { match: /serena/i, tools: ['find_symbol', 'find_referencing_symbols', 'get_symbols_overview', 'search_for_pattern', 'read_file', 'find_file', 'list_dir'] },
  { match: /playwright/i, tools: ['browser_navigate', 'browser_snapshot', 'browser_console_messages', 'browser_network_requests', 'browser_evaluate', 'browser_take_screenshot', 'browser_wait_for', 'browser_close', 'browser_generate_locator'] },
  { match: /context7/i, tools: ['resolve-library-id', 'get-library-docs', 'query-docs'] },
  { match: /code.?index/i, tools: ['set_project_path', 'search_code_advanced', 'find_files', 'get_file_summary'] },
];
const kMaxToolsPerServer = 20;

export function loadMcpConfig(options: { configFile?: string, repoDir?: string }): { config: McpConfig, source?: string } {
  if (/^(0|off|false|no)$/i.test(process.env.EXTENDED_REPORT_MCP || ''))
    return { config: { mcpServers: {} } };
  const candidates = [
    options.configFile,
    process.env.EXTENDED_REPORT_MCP_CONFIG,
    options.repoDir && path.join(options.repoDir, '.pw-extended-report', 'mcp.json'),
    options.repoDir && path.join(options.repoDir, '.mcp.json'),
    path.join(os.homedir(), '.pw-extended-report', 'mcp.json'),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    if (!fs.existsSync(file))
      continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const servers = json.mcpServers ?? json.servers ?? {};
    return { config: { mcpServers: substitute(servers, options.repoDir) }, source: file };
  }
  return { config: { mcpServers: {} } };
}

/** ${REPO}, ${HOME} and ${ENV_VAR} in strings. */
function substitute<T>(value: T, repoDir: string | undefined): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => name === 'REPO' ? (repoDir ?? process.cwd()) : name === 'HOME' ? os.homedir() : (process.env[name] ?? '')) as any;
  }
  if (Array.isArray(value))
    return value.map(v => substitute(v, repoDir)) as any;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, repoDir)])) as any;
  return value;
}

/** All configured servers; connects lazily, keeps connections for the life of the process. */
export class McpHub {
  private _config: McpConfig;
  readonly source?: string;
  private _clients = new Map<string, McpClient>();
  private _status = new Map<string, McpServerStatus>();
  private _tools: McpTool[] | undefined;
  private _connecting: Promise<McpTool[]> | undefined;

  constructor(config: McpConfig, source?: string) {
    this._config = config;
    this.source = source;
  }

  get configured(): boolean {
    return Object.values(this._config.mcpServers).some(s => !s.disabled);
  }

  status(): McpServerStatus[] {
    return Object.keys(this._config.mcpServers).map(name => this._status.get(name) ?? { name, status: this._config.mcpServers[name].disabled ? 'disabled' : 'error', tools: 0, error: 'not connected yet' });
  }

  async tools(onLog?: (text: string) => void): Promise<McpTool[]> {
    if (this._tools)
      return this._tools;
    if (!this._connecting)
      this._connecting = this._connectAll(onLog);
    return this._connecting;
  }

  private async _connectAll(onLog?: (text: string) => void): Promise<McpTool[]> {
    const all: McpTool[] = [];
    await Promise.all(Object.entries(this._config.mcpServers).map(async ([name, config]) => {
      if (config.disabled) {
        this._status.set(name, { name, status: 'disabled', tools: 0 });
        return;
      }
      try {
        const client = new McpClient(name, config);
        await client.connect();
        const tools = await client.listTools();
        const allow = config.tools ?? kDefaultAllowlists.find(a => a.match.test(name))?.tools;
        const selected = (allow ? tools.filter(t => allow.includes(t.name)) : tools).slice(0, kMaxToolsPerServer);
        for (const t of selected)
          all.push({ server: name, name: t.name, wireName: wireName(name, t.name), description: (t.description || '').slice(0, 600), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } });
        this._clients.set(name, client);
        this._status.set(name, { name, status: 'connected', tools: selected.length });
        onLog?.(`MCP ${name}: connected, ${selected.length} tool(s).`);
      } catch (e) {
        this._status.set(name, { name, status: 'error', tools: 0, error: String(e.message || e).slice(0, 300) });
        onLog?.(`MCP ${name}: ${String(e.message || e).slice(0, 200)}`);
      }
    }));
    this._tools = all;
    return all;
  }

  async call(tool: McpTool, args: unknown): Promise<string> {
    const client = this._clients.get(tool.server);
    if (!client)
      throw new Error(`MCP server ${tool.server} is not connected`);
    return client.callTool(tool.name, args);
  }

  async close() {
    await Promise.all([...this._clients.values()].map(c => c.close().catch(() => {})));
    this._clients.clear();
    this._tools = undefined;
    this._connecting = undefined;
  }
}

function wireName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
}

type Pending = { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout };

export class McpClient {
  readonly name: string;
  private _config: McpServerConfig;
  private _nextId = 1;
  private _pending = new Map<number, Pending>();
  private _child: ChildProcessWithoutNullStreams | undefined;
  private _stderr = '';
  private _sessionId: string | undefined;
  private _sseEndpoint: string | undefined;
  private _sseRequest: http.ClientRequest | undefined;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this._config = config;
  }

  private get _kind(): 'stdio' | 'http' | 'sse' {
    const t = this._config.type ?? this._config.transport;
    if (t === 'sse')
      return 'sse';
    if (t === 'http' || t === 'streamable-http' || (!t && this._config.url && !this._config.command))
      return 'http';
    return 'stdio';
  }

  private get _timeoutMs(): number {
    return (this._config.timeout ?? 60) * 1000;
  }

  async connect() {
    if (this._kind === 'stdio')
      this._startStdio();
    else if (this._kind === 'sse')
      await this._startSse();
    await this._request('initialize', {
      protocolVersion: kProtocolVersion,
      capabilities: {},
      clientInfo: { name: 'playwright-extended-report', version: '1' },
    }, 30_000);
    await this._notify('notifications/initialized', {});
  }

  async listTools(): Promise<{ name: string, description?: string, inputSchema?: any }[]> {
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const result = await this._request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this._request('tools/call', { name, arguments: args ?? {} });
    const text = (result?.content ?? []).map((c: any) => c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? '') : `[${c.type}]`).join('\n');
    if (result?.isError)
      throw new Error(text || 'tool returned an error');
    return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '');
  }

  async close() {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    this._pending.clear();
    this._child?.kill();
    this._sseRequest?.destroy();
  }

  // ---------- transports ----------

  private _startStdio() {
    if (!this._config.command)
      throw new Error('"command" is required for a stdio MCP server');
    const child = spawn(this._config.command, this._config.args ?? [], {
      cwd: this._config.cwd,
      env: { ...process.env, ...this._config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    this._child = child;
    let buffer = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line)
          this._onMessage(line);
      }
    });
    child.stderr.on('data', chunk => {
      this._stderr = (this._stderr + chunk).slice(-2000);
    });
    child.on('error', error => this._failAll(error));
    child.on('exit', code => this._failAll(new Error(`process exited with code ${code}${this._stderr ? `: ${this._stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)));
  }

  private _startSse(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this._config.url!);
      const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', headers: { Accept: 'text/event-stream', ...this._config.headers } }, res => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`SSE HTTP ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf-8');
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = block.match(/^event: ?(.*)$/m)?.[1] ?? 'message';
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (event === 'endpoint') {
              this._sseEndpoint = new URL(data, url).toString();
              resolve();
            } else if (data) {
              this._onMessage(data);
            }
          }
        });
        res.on('end', () => this._failAll(new Error('SSE stream closed')));
      });
      req.on('error', reject);
      req.end();
      this._sseRequest = req;
    });
  }

  private _send(message: object): Promise<void> {
    const body = JSON.stringify(message);
    if (this._kind === 'stdio') {
      this._child!.stdin.write(body + '\n');
      return Promise.resolve();
    }
    const target = new URL(this._kind === 'sse' ? this._sseEndpoint! : this._config.url!);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...this._config.headers,
      };
      if (this._sessionId)
        headers['Mcp-Session-Id'] = this._sessionId;
      if (this._kind === 'http')
        headers['MCP-Protocol-Version'] = kProtocolVersion;
      const req = (target.protocol === 'https:' ? https : http).request(target, { method: 'POST', headers }, res => {
        const session = res.headers['mcp-session-id'];
        if (typeof session === 'string')
          this._sessionId = session;
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', chunk => {
          text += chunk;
          // Streamable HTTP may answer with an SSE stream: dispatch events as they complete.
          if (String(res.headers['content-type']).includes('text/event-stream')) {
            let index;
            while ((index = text.indexOf('\n\n')) !== -1) {
              const block = text.slice(0, index);
              text = text.slice(index + 2);
              const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
              if (data)
                this._onMessage(data);
            }
          }
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`MCP HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          if (text.trim() && String(res.headers['content-type']).includes('application/json'))
            this._onMessage(text);
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private _request(method: string, params: unknown, timeoutMs = this._timeoutMs): Promise<any> {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms${this._stderr ? ` (${this._stderr.trim().split('\n').slice(-1)[0]})` : ''}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params }).catch(error => {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      });
    });
  }

  private _notify(method: string, params: unknown): Promise<void> {
    return this._send({ jsonrpc: '2.0', method, params });
  }

  private _onMessage(text: string) {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    for (const m of Array.isArray(message) ? message : [message]) {
      if (m.id === undefined || !this._pending.has(m.id))
        continue;
      const pending = this._pending.get(m.id)!;
      this._pending.delete(m.id);
      clearTimeout(pending.timer);
      if (m.error)
        pending.reject(new Error(`${m.error.message ?? 'MCP error'}${m.error.data ? `: ${JSON.stringify(m.error.data).slice(0, 200)}` : ''}`));
      else
        pending.resolve(m.result);
    }
  }

  private _failAll(error: Error) {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this._pending.clear();
  }
}
