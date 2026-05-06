import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Env } from '@opssage/config-schema';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  name?: string;
}

export interface ChatResponse {
  content: string;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  usage: { input?: number; output?: number; total?: number };
}

export interface ChatProvider {
  readonly model: string;
  readonly providerName: 'anthropic' | 'cursor';
  chat(input: { system: string; messages: ChatMessage[]; tools: ToolDef[] }): Promise<ChatResponse>;
}

/**
 * Build a provider matching `env.PROVIDER`. The plan calls for Cursor as the
 * production target; Anthropic is the fallback for local dev (and what we
 * recommend until the flue Cursor module name is confirmed).
 */
export function buildProvider(env: Env): ChatProvider {
  if (env.PROVIDER === 'cursor') {
    if (!env.CURSOR_API_KEY) throw new Error('PROVIDER=cursor but CURSOR_API_KEY is not set');
    return new CursorProvider({
      apiKey: env.CURSOR_API_KEY,
      baseURL: env.CURSOR_BASE_URL,
      model: env.CURSOR_MODEL,
    });
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error('PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
}

class AnthropicProvider implements ChatProvider {
  readonly providerName = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(cfg: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async chat(input: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDef[];
  }): Promise<ChatResponse> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: input.system,
      // SDK named types for the tool input schema vary across versions;
      // ToolDef.parameters is already a JSON-Schema-shaped object, so we
      // cast at the boundary and let the SDK do its own validation.
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        // biome-ignore lint/suspicious/noExplicitAny: SDK type drift
      })) as any,
      messages: toAnthropicMessages(input.messages),
    });

    let text = '';
    const toolCalls: ChatResponse['tool_calls'] = [];
    for (const block of resp.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return {
      content: text,
      tool_calls: toolCalls,
      usage: {
        input: resp.usage?.input_tokens,
        output: resp.usage?.output_tokens,
        total: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
      },
    };
  }
}

// SDK's MessageParam / ContentBlockParam types are unstable across
// versions; the runtime shape is stable, so we build plain objects.
// biome-ignore lint/suspicious/noExplicitAny: SDK type drift
type AnthropicMessageParam = any;

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessageParam[] {
  // System messages are passed top-level; only user/assistant/tool here.
  const out: AnthropicMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: AnthropicMessageParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeJson(tc.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

class CursorProvider implements ChatProvider {
  readonly providerName = 'cursor' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(cfg: { apiKey: string; baseURL: string; model: string }) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
  }

  async chat(input: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDef[];
  }): Promise<ChatResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((m) => {
          if (m.role === 'tool') {
            return {
              role: 'tool' as const,
              content: m.content,
              tool_call_id: m.tool_call_id ?? '',
            };
          }
          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            return {
              role: 'assistant' as const,
              content: m.content,
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            };
          }
          return { role: m.role, content: m.content } as
            | { role: 'user'; content: string }
            | { role: 'assistant'; content: string };
        }),
      ],
      tools: input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });
    const choice = completion.choices[0];
    const msg = choice?.message;
    return {
      content: msg?.content ?? '',
      tool_calls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      usage: {
        input: completion.usage?.prompt_tokens,
        output: completion.usage?.completion_tokens,
        total: completion.usage?.total_tokens,
      },
    };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
