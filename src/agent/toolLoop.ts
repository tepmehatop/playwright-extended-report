/**
 * "MCP first, then the simple path": the model gets the evidence pack plus tools
 * (MCP servers such as serena / code-index / codebase-memory / context7 / playwright,
 * and the agent's own tools) and may call them a few times before answering.
 * Any failure — the provider rejects tools, a call loop, no final answer — is reported
 * to the caller, which then falls back to a plain prompt with the same evidence.
 */

import { chatWithTools, toolResultMessage } from './llm';
import { finalAnswerNudge } from './prompts';

import type { LlmConfig, LoopMessage, ToolCall, ToolSchema } from './llm';
import type { Lang } from './prompts';

export type AgentTool = ToolSchema & { call: (args: any) => Promise<string> };

export type ToolLoopResult = {
  content: string;
  model: string;
  toolCalls: { name: string, args: any, ok: boolean, preview: string }[];
};

const kMaxResultChars = 6000;

export async function runToolLoop(options: {
  llm: LlmConfig;
  lang: Lang;
  system: string;
  user: string;
  tools: AgentTool[];
  maxSteps?: number;
  log: (text: string) => void;
}): Promise<ToolLoopResult> {
  const { llm, tools, log, lang } = options;
  const byName = new Map(tools.map(t => [t.name, t]));
  const schemas: ToolSchema[] = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages: LoopMessage[] = [{ role: 'system', content: options.system }, { role: 'user', content: options.user }];
  const toolCalls: ToolLoopResult['toolCalls'] = [];
  const seen = new Map<string, number>();
  const maxSteps = options.maxSteps ?? 8;
  let model = llm.model ?? llm.provider;

  for (let step = 0; step < maxSteps; step++) {
    const turn = await chatWithTools(llm, messages, schemas);
    model = turn.model;
    messages.push(turn.assistant);
    if (!turn.calls.length) {
      if (!turn.content.trim())
        throw new Error(lang === 'ru' ? 'модель вернула пустой ответ' : 'the model returned an empty answer');
      return { content: turn.content, model, toolCalls };
    }
    for (const call of turn.calls)
      messages.push(toolResultMessage(llm, call, await execute(call)));
  }
  // Out of steps: ask for the answer without tools.
  messages.push({ role: 'user', content: finalAnswerNudge(lang) });
  const final = await chatWithTools(llm, messages, []);
  if (!final.content.trim())
    throw new Error(lang === 'ru' ? 'модель не дала финальный ответ' : 'no final answer');
  return { content: final.content, model: final.model, toolCalls };

  async function execute(call: ToolCall): Promise<string> {
    const tool = byName.get(call.name);
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    const repeats = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeats);
    if (!tool) {
      log(`${lang === 'ru' ? 'Модель вызвала неизвестный инструмент' : 'Unknown tool'} ${call.name}`);
      return `Unknown tool ${call.name}. Available: ${[...byName.keys()].join(', ')}`;
    }
    if (repeats > 2)
      return lang === 'ru' ? 'Этот вызов уже выполнялся с теми же аргументами. Используй полученный результат или дай ответ.' : 'This exact call was already made. Use its result or answer.';
    log(`${lang === 'ru' ? 'Инструмент' : 'Tool'}: ${call.name}(${JSON.stringify(call.args).slice(0, 160)})`);
    try {
      const result = await tool.call(call.args ?? {});
      const clipped = result.length > kMaxResultChars ? result.slice(0, kMaxResultChars) + '\n…(truncated)' : result;
      toolCalls.push({ name: call.name, args: call.args, ok: true, preview: clipped.slice(0, 300) });
      return clipped || '(empty result)';
    } catch (e) {
      const message = String(e?.message || e).slice(0, 500);
      toolCalls.push({ name: call.name, args: call.args, ok: false, preview: message });
      log(`  ✗ ${message.slice(0, 160)}`);
      return `Error: ${message}`;
    }
  }
}
