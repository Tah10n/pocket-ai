import { getVisibleAssistantContent } from './chatPresentation';

export interface PreparedSpeechText {
  readonly text: string;
  readonly requiresReview: boolean;
  readonly reason?: 'structured' | 'code' | 'table' | 'markup';
}

export class TtsTextError extends Error {
  readonly code = 'unsafe_content';
  constructor() {
    super('unsafe_content');
    this.name = 'TtsTextError';
  }
}

function assertVisibleContentOnly(text: string): void {
  // Do not repair raw protocol/diagnostics or internal paths into something speakable.
  // The caller supplies only a finished message's visible body, never tool rounds.
  const protocol = /<\|[^\n]*|<channel\||<\/?(?:think|thinking|tool_call|tool_calls|tool_response|function_call)\b|\[\/?THINK\]|"(?:tool_calls|tool_call_id|reasoning_content|media_paths)"\s*:/i;
  const privatePath = /\bfile:\/\/|\b[a-z]:[\\/]|\/(?:data\/(?:user|data)|storage\/emulated|private\/var|var\/mobile)\//i;
  if (protocol.test(text) || privatePath.test(text)) throw new TtsTextError();
}

function simplifyMarkdownLine(line: string): string {
  const heading = /^ {0,3}#{1,6}\s+/.test(line);
  const withoutBlockMarkers = (heading ? line.replace(/^ {0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') : line)
    .replace(/^ {0,3}(?:>\s*)+/, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
  // Preserve inline code bytes while removing only their display delimiters.
  return withoutBlockMarkers.split(/(`+[^`]*`+)/g).map((part, index) => {
    if (index % 2 === 1) {
      const match = part.match(/^(`+)([\s\S]*?)\1$/);
      return match ? match[2] : part;
    }
    return part
      .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+.!>~-])/g, '$1');
  }).join('');
}

/** The returned text is the exact preview and exact synthesis input; no model rewrites it. */
export function prepareSpeechText(input: string, options: { structured?: boolean } = {}): PreparedSpeechText {
  const visible = (options.structured ? input : getVisibleAssistantContent(input)).trim();
  assertVisibleContentOnly(visible);
  if (options.structured || /^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(visible)) {
    return { text: visible, requiresReview: true, reason: 'structured' };
  }
  if (/^ {0,3}(?:`{3,}|~{3,})|^(?: {4}|\t)\S/m.test(visible)) {
    return { text: visible, requiresReview: true, reason: 'code' };
  }
  if (/^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)+\s*$/m.test(visible)) {
    return { text: visible, requiresReview: true, reason: 'table' };
  }
  // Preserve unhandled HTML/reference-link syntax for an explicit review instead of deleting it.
  if (/<\/?[a-z][^>]*>|^\s*\[[^\]]+\]:\s*\S|\[[^\]]+\]\[[^\]]*\]|~~[^~]+~~/im.test(visible)) {
    return { text: visible, requiresReview: true, reason: 'markup' };
  }
  const text = visible.split(/\r?\n/).map(simplifyMarkdownLine).join('\n').trim();
  return { text, requiresReview: false };
}
