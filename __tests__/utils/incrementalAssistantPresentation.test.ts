import {
  createIncrementalAssistantPresentationParser,
  type AssistantPresentation,
} from '../../src/utils/chatPresentation';

const completedPresentation = (
  finalContent: string,
  thoughtContent = '',
): AssistantPresentation => ({
  finalContent,
  thoughtContent,
  hasThought: thoughtContent.length > 0,
  isThoughtStreaming: false,
});

function expectEveryTwoChunkBoundary(
  input: string,
  expected: AssistantPresentation,
): void {
  for (let boundary = 0; boundary <= input.length; boundary += 1) {
    const parser = createIncrementalAssistantPresentationParser();
    parser.appendDelta(input.slice(0, boundary));
    parser.appendDelta(input.slice(boundary));

    expect({ boundary, presentation: parser.getPresentation() }).toEqual({
      boundary,
      presentation: expected,
    });
    expect(parser.getProcessedCharacterCount()).toBe(input.length);
  }

  const characterParser = createIncrementalAssistantPresentationParser();
  for (const character of input.split('')) {
    characterParser.appendDelta(character);
  }
  expect(characterParser.getPresentation()).toEqual(expected);
  expect(characterParser.getProcessedCharacterCount()).toBe(input.length);
}

describe('IncrementalAssistantPresentationParser', () => {
  const reasoningFormats = [
    {
      label: 'think HTML tag',
      open: '<think>',
      close: '</think>',
    },
    {
      label: 'thinking HTML tag',
      open: '<thinking>',
      close: '</thinking>',
    },
    {
      label: 'bracket marker',
      open: '[THINK]',
      close: '[/THINK]',
    },
    {
      label: 'llama.cpp thinking marker',
      open: '<|start_thinking|>',
      close: '<|end_thinking|>',
    },
    {
      label: 'channel marker',
      open: '<|channel>thought',
      close: '<channel|>',
    },
  ];

  it.each(reasoningFormats)(
    'parses $label at every two-chunk boundary',
    ({ open, close }) => {
      const input = `${open}\nPlan 🌍\n${close}\n\nVisible answer ✅`;
      expectEveryTwoChunkBoundary(
        input,
        completedPresentation('Visible answer ✅', 'Plan 🌍'),
      );
    },
  );

  it('keeps ordinary Unicode text stable at every chunk boundary', () => {
    const input = '\n\nHello 👋 — こんにちは\n\n';

    expectEveryTwoChunkBoundary(input, completedPresentation('Hello 👋 — こんにちは'));
  });

  it.each(reasoningFormats)(
    'hides every partial opening prefix for $label',
    ({ open }) => {
      for (let boundary = 1; boundary < open.length; boundary += 1) {
        const parser = createIncrementalAssistantPresentationParser();
        parser.appendDelta(open.slice(0, boundary));

        expect({ boundary, presentation: parser.getPresentation() }).toEqual({
          boundary,
          presentation: {
            finalContent: '',
            thoughtContent: '',
            hasThought: true,
            isThoughtStreaming: true,
          },
        });
      }
    },
  );

  it.each(reasoningFormats)(
    'holds every partial closing prefix for $label until the marker completes',
    ({ open, close }) => {
      for (let boundary = 1; boundary < close.length; boundary += 1) {
        const parser = createIncrementalAssistantPresentationParser();
        parser.appendDelta(`${open}Plan${close.slice(0, boundary)}`);

        expect({ boundary, presentation: parser.getPresentation() }).toEqual({
          boundary,
          presentation: {
            finalContent: '',
            thoughtContent: 'Plan',
            hasThought: true,
            isThoughtStreaming: true,
          },
        });

        parser.appendDelta(`${close.slice(boundary)}Answer`);
        expect(parser.getPresentation()).toEqual(completedPresentation('Answer', 'Plan'));
      }
    },
  );

  it.each(reasoningFormats)(
    'keeps an unclosed $label block in streaming thought content',
    ({ open }) => {
      const parser = createIncrementalAssistantPresentationParser();
      parser.appendDelta(`${open}\nStill reasoning 🧠\n`);

      expect(parser.getPresentation()).toEqual({
        finalContent: '',
        thoughtContent: 'Still reasoning 🧠',
        hasThought: true,
        isThoughtStreaming: true,
      });
    },
  );

  it('combines multiple sequential reasoning blocks before visible content', () => {
    const input = '<think>First pass</think>\n[THINK]Second pass[/THINK]\n\nAnswer';

    expectEveryTwoChunkBoundary(
      input,
      completedPresentation('Answer', 'First pass\n\nSecond pass'),
    );
  });

  it('supports snapshots, replacement resynchronization, and later deltas', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.appendDelta('<think>Stale plan');
    parser.applySnapshot('<thinking>Fresh plan</thinking>Fresh');
    parser.appendDelta(' answer');

    expect(parser.getPresentation()).toEqual(
      completedPresentation('Fresh answer', 'Fresh plan'),
    );
    expect(parser.getProcessedCharacterCount()).toBe(
      '<think>Stale plan'.length
      + '<thinking>Fresh plan</thinking>Fresh'.length
      + ' answer'.length,
    );
  });

  it('supports accumulated visible snapshots mixed with deltas', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.applyCumulativeSnapshot('Hel');
    parser.applyCumulativeSnapshot('Hello');
    parser.appendDelta(' world');

    expect(parser.getPresentation()).toEqual(completedPresentation('Hello world'));
    expect(parser.getProcessedCharacterCount()).toBe('Hello world'.length);
  });

  it('consumes prefix-growing cumulative snapshots in linear total character work', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const content = Array.from({ length: 512 }, (_, index) => String(index % 10)).join('');

    for (let length = 1; length <= content.length; length += 1) {
      parser.applyCumulativeSnapshot(content.slice(0, length));
      parser.getPresentation();
    }

    expect(parser.getPresentation()).toEqual(completedPresentation(content));
    expect(parser.getProcessedCharacterCount()).toBe(content.length);
  });

  it('does not reprocess deltas repeated by later cumulative snapshots', () => {
    const parser = createIncrementalAssistantPresentationParser();
    let content = '';

    for (let index = 0; index < 256; index += 1) {
      const delta = String(index % 10);
      content += delta;
      parser.appendDelta(delta);
      parser.applyCumulativeSnapshot(content);
      parser.getPresentation();
    }

    expect(parser.getPresentation()).toEqual(completedPresentation(content));
    expect(parser.getProcessedCharacterCount()).toBe(content.length);
  });

  it('fully resynchronizes an explicit snapshot replacement', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const staleSnapshot = '<think>Stale plan</think>Stale answer';
    const freshSnapshot = '<thinking>Fresh plan</thinking>Fresh answer';

    parser.applyCumulativeSnapshot(staleSnapshot);
    parser.applySnapshot(freshSnapshot);

    expect(parser.getPresentation()).toEqual(
      completedPresentation('Fresh answer', 'Fresh plan'),
    );
    expect(parser.getProcessedCharacterCount()).toBe(
      staleSnapshot.length + freshSnapshot.length,
    );
  });

  it('fully resynchronizes a shrinking cumulative content snapshot', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const longerSnapshot = 'A longer stale answer';
    const shorterSnapshot = 'Fresh';

    parser.applyCumulativeSnapshot(longerSnapshot);
    parser.applyCumulativeSnapshot(shorterSnapshot);

    expect(parser.getPresentation()).toEqual(completedPresentation(shorterSnapshot));
    expect(parser.getProcessedCharacterCount()).toBe(
      longerSnapshot.length + shorterSnapshot.length,
    );
  });

  it('lets explicit native reasoning override raw marker-derived reasoning', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.applySnapshot('<think>Raw plan</think>Visible');
    parser.applyExplicitReasoningSnapshot('\nNative plan\n');

    expect(parser.getPresentation()).toEqual({
      finalContent: 'Visible',
      thoughtContent: '\nNative plan\n',
      hasThought: true,
      isThoughtStreaming: false,
    });
  });

  it('keeps explicit reasoning snapshots and prefix-extending deltas distinct', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.applyExplicitReasoningSnapshot('Plan');
    parser.applyExplicitReasoningSnapshot('Plan carefully');
    parser.appendExplicitReasoningDelta('Plan more');
    expect(parser.getPresentation().thoughtContent).toBe('Plan carefullyPlan more');

    parser.applyExplicitReasoningSnapshot('Reset');
    parser.appendExplicitReasoningDelta(' complete');
    expect(parser.getPresentation().thoughtContent).toBe('Reset complete');
  });

  it('consumes cumulative explicit reasoning snapshots in linear total character work', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const reasoning = Array.from({ length: 512 }, (_, index) => String(index % 10)).join('');

    for (let length = 1; length <= reasoning.length; length += 1) {
      parser.applyCumulativeExplicitReasoningSnapshot(reasoning.slice(0, length));
      parser.getPresentation();
    }

    expect(parser.getPresentation().thoughtContent).toBe(reasoning);
    expect(parser.getProcessedCharacterCount()).toBe(reasoning.length);
  });

  it('does not reprocess explicit reasoning deltas repeated by cumulative snapshots', () => {
    const parser = createIncrementalAssistantPresentationParser();
    let reasoning = '';

    for (let index = 0; index < 256; index += 1) {
      const delta = String(index % 10);
      reasoning += delta;
      parser.appendExplicitReasoningDelta(delta);
      parser.applyCumulativeExplicitReasoningSnapshot(reasoning);
      parser.getPresentation();
    }

    expect(parser.getPresentation().thoughtContent).toBe(reasoning);
    expect(parser.getProcessedCharacterCount()).toBe(reasoning.length);
  });

  it('fully resynchronizes a shrinking cumulative explicit reasoning snapshot', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const longerSnapshot = 'A longer stale reasoning trace';
    const shorterSnapshot = 'Fresh plan';

    parser.applyCumulativeExplicitReasoningSnapshot(longerSnapshot);
    parser.applyCumulativeExplicitReasoningSnapshot(shorterSnapshot);

    expect(parser.getPresentation().thoughtContent).toBe(shorterSnapshot);
    expect(parser.getProcessedCharacterCount()).toBe(
      longerSnapshot.length + shorterSnapshot.length,
    );
  });

  it('treats empty raw and explicit chunks as no-ops', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.appendDelta('');
    parser.applySnapshot('');
    parser.appendDelta('Answer');
    parser.appendExplicitReasoningDelta('');

    expect(parser.getPresentation()).toEqual(completedPresentation('Answer'));
    expect(parser.getProcessedCharacterCount()).toBe('Answer'.length);
  });

  it('counts only newly processed delta characters after a snapshot', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const deltaStream = 'abc🙂'.repeat(2_000);

    for (const character of deltaStream.split('')) {
      parser.appendDelta(character);
      parser.getPresentation();
    }
    expect(parser.getProcessedCharacterCount()).toBe(deltaStream.length);

    const snapshot = '[THINK]resynced[/THINK]Visible';
    parser.applySnapshot(snapshot);
    expect(parser.getProcessedCharacterCount()).toBe(deltaStream.length + snapshot.length);

    const tail = ' tail';
    for (const character of tail) {
      parser.appendDelta(character);
      parser.getPresentation();
    }
    expect(parser.getProcessedCharacterCount()).toBe(
      deltaStream.length + snapshot.length + tail.length,
    );
    expect(parser.getPresentation()).toEqual(
      completedPresentation('Visible tail', 'resynced'),
    );
  });

  it('consumes many sequential blocks once even with presentation reads per character', () => {
    const parser = createIncrementalAssistantPresentationParser();
    const stream = Array.from(
      { length: 200 },
      (_, index) => `<think>plan-${index}</think>\n`,
    ).join('') + 'Answer';

    for (const character of stream.split('')) {
      parser.appendDelta(character);
      parser.getPresentation();
    }

    expect(parser.getProcessedCharacterCount()).toBe(stream.length);
    expect(parser.getPresentation().finalContent).toBe('Answer');
    expect(parser.getPresentation().thoughtContent.split('\n\n')).toHaveLength(200);
  });

  it.each([
    ['Answer.', true],
    ['Answer. " )\n', true],
    ['回答！', true],
    ['Answer? still writing', false],
    ['No boundary', false],
  ])('tracks the visible sentence boundary incrementally for %j', (stream, expected) => {
    const parser = createIncrementalAssistantPresentationParser();

    for (const character of stream.split('')) {
      parser.appendDelta(character);
    }

    expect(parser.doesVisibleContentEndAtSentenceBoundary()).toBe(expected);
  });

  it('revisions only materialized visible output and resynchronizes on snapshots', () => {
    const parser = createIncrementalAssistantPresentationParser();

    parser.appendDelta('Answer.');
    const answerRevision = parser.getVisibleContentRevision();
    expect(parser.doesVisibleContentEndAtSentenceBoundary()).toBe(true);

    parser.appendDelta('\n');
    expect(parser.getVisibleContentRevision()).toBe(answerRevision);
    expect(parser.doesVisibleContentEndAtSentenceBoundary()).toBe(true);

    parser.appendDelta('Next');
    expect(parser.getVisibleContentRevision()).toBeGreaterThan(answerRevision);
    expect(parser.doesVisibleContentEndAtSentenceBoundary()).toBe(false);

    const revisionBeforeSnapshot = parser.getVisibleContentRevision();
    parser.applySnapshot('Reset!');
    expect(parser.getVisibleContentRevision()).toBeGreaterThan(revisionBeforeSnapshot);
    expect(parser.doesVisibleContentEndAtSentenceBoundary()).toBe(true);
  });

  it('bounds invalid opening-marker lookahead before treating it as visible text', () => {
    const input = `<think${'x'.repeat(300)}`;
    const parser = createIncrementalAssistantPresentationParser();

    parser.appendDelta(input);

    expect(parser.getPresentation()).toEqual(completedPresentation(input));
    expect(parser.getProcessedCharacterCount()).toBe(input.length);
  });
});
