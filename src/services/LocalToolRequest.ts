import type { LlamaChatFormatOptions } from './LlamaRuntimeAdapter';

export interface LocalToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Internal formatter data, never accepted from model-generated arguments. */
export interface LocalToolRequest {
  phase: 'tools' | 'final';
  tools: LocalToolDefinition[];
  toolChoice: 'auto' | 'required' | 'none';
  parallelToolCalls: false;
}

export function localToolFormatterOptions(request: LocalToolRequest): LlamaChatFormatOptions {
  return {
    tools: request.tools,
    tool_choice: request.phase === 'tools' ? request.toolChoice : 'none',
    // rc.3 serializes this option to a string, but JSI reads a strict boolean.
    // Omission preserves the native default false; true is unsupported here.
  };
}

export function hasToolProtocol(messages: readonly { role: string; tool_calls?: unknown }[]): boolean {
  return messages.some(message => message.role === 'tool' || message.tool_calls !== undefined);
}
