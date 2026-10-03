import { prepareSpeechText, TtsTextError } from '../../src/utils/ttsText';

describe('prepareSpeechText', () => {
  it('uses the visible final body and predictably removes ordinary Markdown display markers', () => {
    expect(prepareSpeechText('<think>Hidden plan and file:///data/user/0/private</think>\n\n## Hello\n\n- **World** and [guide](https://example.com)\n> _Quoted_ `x_y`')).toEqual({
      text: 'Hello\n\nWorld and guide\nQuoted x_y', requiresReview: false,
    });
  });

  it.each([
    '<think>Unfinished secret', '[THINK]Hidden[/THINK]Visible',
    '<|start_thinking|>Hidden<|end_thinking|>Visible',
  ])('never includes leading reasoning', input => {
    const prepared = prepareSpeechText(input);
    expect(prepared.text).not.toContain('Hidden');
    expect(prepared.text).not.toContain('secret');
  });

  it.each([
    ['```json\n{"meaningful":42}\n```', 'code'],
    ['Introduction\n\n    x = important_value\n\nConclusion', 'code'],
    ['| Region | Share |\n| --- | ---: |\n| North | 7.5% |\n| South | 12% |', 'table'],
    ['<b>Visible information</b>', 'markup'],
    ['[Reference][label]\n\n[label]: https://example.com', 'markup'],
    ['~~Outdated instruction~~ Use the corrected instruction.', 'markup'],
  ])('retains the exact difficult-content preview (%s)', (input, reason) => {
    expect(prepareSpeechText(input)).toEqual({ text: input, requiresReview: true, reason });
  });

  it('retains exact structured output and detects plain JSON without output-mode metadata', () => {
    const input = '{"example":"_literal_", "count":42}';
    expect(prepareSpeechText(input, { structured: true })).toEqual({
      text: input, requiresReview: true, reason: 'structured',
    });
    expect(prepareSpeechText(input)).toEqual({ text: input, requiresReview: true, reason: 'structured' });
  });

  it.each([
    '<tool_call>{"name":"calculator"}</tool_call>',
    '{"tool_calls":[{"function":{"name":"calculator"}}]}',
    '{"reasoning_content":"secret"}',
    '<|im_start|>assistant\nRaw protocol',
    'Visible then <think>untrusted hidden text</think>',
    'A private file: C:\\Users\\someone\\secrets.txt',
    '/data/user/0/com.example/cache/clip.wav',
    'file:///private/var/mobile/cache/clip.wav',
  ])('rejects residual protocol/diagnostics/private paths without reflecting their contents', input => {
    for (const options of [{}, { structured: true }]) {
      expect(() => prepareSpeechText(input, options)).toThrow(TtsTextError);
      expect(() => prepareSpeechText(input, options)).toThrow('unsafe_content');
    }
  });

  it('preserves content, inline code and ordinary underscore identifiers', () => {
    expect(prepareSpeechText('Use `x_y * 2` with user_name.\n1. First\n2. Second')).toEqual({
      text: 'Use x_y * 2 with user_name.\nFirst\nSecond', requiresReview: false,
    });
    expect(prepareSpeechText('Keep this literal #')).toEqual({ text: 'Keep this literal #', requiresReview: false });
  });

  it('does not rewrite or truncate long text, and permits an empty visible body', () => {
    const input = 'Useful text. '.repeat(1_000).trim();
    expect(prepareSpeechText(input).text).toBe(input);
    expect(prepareSpeechText('  ')).toEqual({ text: '', requiresReview: false });
  });
});
