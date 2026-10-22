import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ChatComparisonPanel } from '../../src/components/ui/ChatComparisonPanel';
import type { ChatComparison } from '../../src/hooks/useChatComparison';
import '../../src/i18n';

jest.mock('react-native-css-interop', () => ({ createInteropElement: jest.requireActual<typeof import('react')>('react').createElement }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {} }));

function comparison(running: boolean): ChatComparison {
  return { running, variants: [
    { state: 'running', content: 'First', thoughtContent: '', generation: { temperature: 0.3, seed: 1, maxTokens: 256, topP: 0.9 } },
    { state: 'completed', content: 'Second', thoughtContent: '', generation: { temperature: 0.8, seed: 2, maxTokens: 256, topP: 0.9 } },
  ] };
}

it('shows separate statuses, stops only the chosen slot, and waits for drain before selection', () => {
  const stop = jest.fn();
  const choose = jest.fn();
  const close = jest.fn();
  const view = render(<ChatComparisonPanel comparison={comparison(true)} onStop={stop} onChoose={choose} onClose={close} />);
  fireEvent.press(view.getByTestId('chat-comparison-stop-0'));
  expect(stop).toHaveBeenCalledWith(0);
  fireEvent.press(view.getByTestId('chat-comparison-choose-1'));
  expect(choose).not.toHaveBeenCalled();
  view.rerender(<ChatComparisonPanel comparison={comparison(false)} onStop={stop} onChoose={choose} onClose={close} />);
  fireEvent.press(view.getByTestId('chat-comparison-choose-1'));
  expect(choose).toHaveBeenCalledWith(1);
  fireEvent.press(view.getByTestId('chat-comparison-close'));
  expect(close).toHaveBeenCalledTimes(1);
});

it('shows validation failures and prevents selecting constrained incomplete output', () => {
  const state = comparison(false);
  state.variants[1].generation.output = { mode: 'gbnf', grammar: 'root ::= "OK"' };
  state.variants[1].structuredOutput = { mode: 'gbnf', status: 'incomplete', error: 'interrupted' };
  const choose = jest.fn();
  const view = render(<ChatComparisonPanel comparison={state} onStop={jest.fn()} onChoose={choose} onClose={jest.fn()} />);
  expect(view.getByText('comparison.validation.incomplete')).toBeTruthy();
  fireEvent.press(view.getByTestId('chat-comparison-choose-1'));
  expect(choose).not.toHaveBeenCalled();
});
