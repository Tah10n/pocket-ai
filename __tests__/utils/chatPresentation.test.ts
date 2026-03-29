import {
  getAssistantPresentation,
  getCopyableAssistantContent,
  getVisibleAssistantContent,
} from '../../src/utils/chatPresentation';

describe('chatPresentation', () => {
  it('extracts a leading thought block from the final assistant content', () => {
    const presentation = getAssistantPresentation(
      '<think>Plan the answer</think>\n\n## Final\n\n- item',
    );

    expect(presentation).toEqual({
      finalContent: '## Final\n\n- item',
      thoughtContent: 'Plan the answer',
      hasThought: true,
      isThoughtStreaming: false,
    });
  });

  it('extracts a leading thinking block from the final assistant content', () => {
    const presentation = getAssistantPresentation(
      '<thinking>Plan the answer</thinking>\n\n## Final\n\n- item',
    );

    expect(presentation).toEqual({
      finalContent: '## Final\n\n- item',
      thoughtContent: 'Plan the answer',
      hasThought: true,
      isThoughtStreaming: false,
    });
  });

  it('combines multiple leading thought blocks before the final answer', () => {
    const presentation = getAssistantPresentation(
      '<think>First pass</think>\n<think>Second pass</think>\n\nVisible answer',
    );

    expect(presentation.thoughtContent).toBe('First pass\n\nSecond pass');
    expect(presentation.finalContent).toBe('Visible answer');
  });

  it('treats an unclosed leading thought block as streaming reasoning', () => {
    const presentation = getAssistantPresentation('<think>Still reasoning', {
      isStreaming: true,
    });

    expect(presentation).toEqual({
      finalContent: '',
      thoughtContent: 'Still reasoning',
      hasThought: true,
      isThoughtStreaming: true,
    });
    expect(getVisibleAssistantContent('<think>Still reasoning')).toBe('');
  });

  it('treats an unclosed leading thinking block as streaming reasoning', () => {
    const presentation = getAssistantPresentation('<thinking>Still reasoning', {
      isStreaming: true,
    });

    expect(presentation).toEqual({
      finalContent: '',
      thoughtContent: 'Still reasoning',
      hasThought: true,
      isThoughtStreaming: true,
    });
    expect(getVisibleAssistantContent('<thinking>Still reasoning')).toBe('');
  });

  it('keeps literal think tags inside a normal answer untouched', () => {
    const content = 'Use the literal string `<think>...</think>` in your parser.';

    expect(getAssistantPresentation(content)).toEqual({
      finalContent: content,
      thoughtContent: '',
      hasThought: false,
      isThoughtStreaming: false,
    });
    expect(getCopyableAssistantContent(content)).toBe(content);
    expect(getVisibleAssistantContent(content)).toBe(content);
  });

  it('keeps literal thinking tags inside a normal answer untouched', () => {
    const content = 'Use the literal string `<thinking>...</thinking>` in your parser.';

    expect(getAssistantPresentation(content)).toEqual({
      finalContent: content,
      thoughtContent: '',
      hasThought: false,
      isThoughtStreaming: false,
    });
    expect(getCopyableAssistantContent(content)).toBe(content);
    expect(getVisibleAssistantContent(content)).toBe(content);
  });

  it('returns only the visible reply content when thoughts are present', () => {
    expect(getVisibleAssistantContent('<think>Hidden reasoning</think>\n\nVisible answer')).toBe('Visible answer');
  });

  it('returns only the visible reply content when thinking tags are present', () => {
    expect(getVisibleAssistantContent('<thinking>Hidden reasoning</thinking>\n\nVisible answer')).toBe('Visible answer');
  });

  it('trims boundary blank lines from visible assistant content during normal replies', () => {
    const content = '\n\nHello there\n\n';

    expect(getAssistantPresentation(content)).toEqual({
      finalContent: 'Hello there',
      thoughtContent: '',
      hasThought: false,
      isThoughtStreaming: false,
    });
    expect(getVisibleAssistantContent(content)).toBe('Hello there');
    expect(getCopyableAssistantContent(content)).toBe(content);
  });
});
