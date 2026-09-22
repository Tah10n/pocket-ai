import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { AdvancedGenerationControls } from '../../src/components/ui/AdvancedGenerationControls';
import type { GenerationParameters } from '../../src/services/SettingsStore';

jest.mock('../../src/providers/ThemeProvider', () => {
  const { resolveTheme } = jest.requireActual('../../src/design-system/themes/resolver');
  return { useTheme: () => { const resolvedTheme = resolveTheme('default', 'light'); return { resolvedTheme, colors: resolvedTheme.colors }; } };
});
jest.mock('../../src/components/ui/MaterialSymbols', () => ({ MaterialSymbols: () => null }));

const base: GenerationParameters = {
  temperature: 0.7, topP: 0.9, topK: 40, minP: 0.05, repetitionPenalty: 1,
  maxTokens: 512, reasoningEffort: 'auto', seed: null,
};
function setup(partial: Partial<GenerationParameters> = {}, supportsReasoning = true) {
  const onChange = jest.fn();
  const view = render(<AdvancedGenerationControls params={{ ...base, ...partial }} supportsReasoning={supportsReasoning} onChange={onChange} />);
  fireEvent.press(view.getByTestId('generation-advanced-toggle'));
  return { ...view, onChange };
}
function edit(view: ReturnType<typeof setup>, field: string, text: string) {
  fireEvent.changeText(view.getByTestId(`generation-${field}`), text);
  fireEvent(view.getByTestId(`generation-${field}`), 'endEditing', { nativeEvent: { text } });
}

describe('AdvancedGenerationControls', () => {
  it('starts compact and shows one group at a time', () => {
    const view = render(<AdvancedGenerationControls params={base} supportsReasoning onChange={jest.fn()} />);
    expect(view.queryByTestId('generation-section-sampling')).toBeNull();
    fireEvent.press(view.getByTestId('generation-advanced-toggle'));
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    expect(view.getByTestId('generation-nProbs')).toBeTruthy();
    fireEvent.press(view.getByTestId('generation-section-template'));
    expect(view.queryByTestId('generation-nProbs')).toBeNull();
    expect(view.getByTestId('generation-now')).toBeTruthy();
  });
  it('preserves numeric zero, explicit empty list and meaningful stop whitespace', () => {
    const view = setup();
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    edit(view, 'penaltyLastN', '0');
    expect(view.onChange).toHaveBeenLastCalledWith({ penaltyLastN: 0 });
    edit(view, 'stop', '[]');
    expect(view.onChange).toHaveBeenLastCalledWith({ stop: [] });
    edit(view, 'stop', '[" stop ","\\n"]');
    expect(view.onChange).toHaveBeenLastCalledWith({ stop: [' stop ', '\n'] });
    edit(view, 'stop', '');
    expect(view.onChange).toHaveBeenLastCalledWith({ stop: undefined });
  });
  it('rejects invalid complete drafts without replacing the applied value', () => {
    const view = setup({ nProbs: 3 });
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    edit(view, 'nProbs', '11');
    edit(view, 'penaltyLastN', '0.5');
    edit(view, 'stop', '[""]');
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.getAllByRole('alert').length).toBe(3);
  });
  it('makes dependent samplers and unsupported reasoning inactive', () => {
    const view = setup({}, false);
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    for (const field of ['mirostatTau', 'mirostatEta', 'xtcThreshold', 'dryBase', 'drySequenceBreakers', 'thinkingBudgetTokens', 'thinkingBudgetMessage']) {
      expect(view.getByTestId(`generation-${field}`).props.editable).toBe(false);
    }
    fireEvent.press(view.getByTestId('generation-reasoningFormat-deepseek'));
    expect(view.onChange).not.toHaveBeenCalled();
  });
  it('activates dependent values and does not silently replace stored zeros', () => {
    const view = setup({ mirostat: 2, mirostatEta: 0, xtcProbability: 0.2, dryMultiplier: 1, thinkingBudgetTokens: 0 });
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    expect(view.getByTestId('generation-mirostatEta').props.editable).toBe(true);
    expect(view.getByTestId('generation-mirostatEta').props.value).toBe('0');
    expect(view.getByTestId('generation-xtcThreshold').props.editable).toBe(false);
    expect(view.getByTestId('generation-dryBase').props.editable).toBe(false);
    expect(view.getByTestId('generation-frequencyPenalty').props.editable).toBe(false);
    expect(view.getByTestId('generation-thinkingBudgetTokens').props.value).toBe('0');
  });
  it('cannot enable unsafe rc3 options and can clear imported unsupported values', () => {
    const view = setup({ ignoreEos: true, logitBias: [[1, 2]] });
    fireEvent.press(view.getByTestId('generation-section-sampling'));
    fireEvent.press(view.getByTestId('generation-ignoreEos-on'));
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.getByTestId('generation-logitBias').props.editable).toBe(false);
    fireEvent.press(view.getByTestId('generation-clear-unsupported'));
    expect(view.onChange).toHaveBeenCalledWith({ ignoreEos: false, logitBias: [] });
  });
  it('preserves false, zero, empty kwargs and parser whitespace without native passthrough', () => {
    const view = setup({ template: { chatTemplate: 'local template' } });
    fireEvent.press(view.getByTestId('generation-section-template'));
    fireEvent.press(view.getByTestId('generation-jinja-off'));
    expect(view.onChange).toHaveBeenLastCalledWith({ template: { chatTemplate: 'local template', jinja: false } });
    edit(view, 'now', '0');
    expect(view.onChange).toHaveBeenLastCalledWith({ template: { chatTemplate: 'local template', now: '0' } });
    edit(view, 'kwargs', '{}');
    expect(view.onChange).toHaveBeenLastCalledWith({ template: { chatTemplate: 'local template', kwargs: {} } });
    edit(view, 'prefillText', '  {\n');
    expect(view.onChange).toHaveBeenLastCalledWith({ template: { chatTemplate: 'local template', prefillText: '  {\n' } });
    view.onChange.mockClear();
    edit(view, 'kwargs', '{"nested": {"value": 1}}');
    expect(view.onChange).not.toHaveBeenCalled();
  });
  it('validates schema drafts locally and switching to text clears the constraint', () => {
    const view = setup({ output: { mode: 'json_schema', schema: '{"type":"object"}' } });
    fireEvent.press(view.getByTestId('generation-section-output'));
    edit(view, 'schema', '{"$ref":"https://example.com/schema"}');
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.getByRole('alert')).toBeTruthy();
    edit(view, 'schema', '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}');
    expect(view.onChange).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByTestId('generation-outputMode-text'));
    expect(view.onChange).toHaveBeenLastCalledWith({ output: { mode: 'text' } });
  });
  it('exposes prefill only when the caller supplies an available operation', () => {
    const onPrefill = jest.fn();
    const view = render(<AdvancedGenerationControls params={base} supportsReasoning onChange={jest.fn()} onPrefill={onPrefill} />);
    fireEvent.press(view.getByTestId('generation-advanced-toggle'));
    fireEvent.press(view.getByTestId('generation-section-template'));
    fireEvent.press(view.getByTestId('generation-prefill'));
    expect(onPrefill).toHaveBeenCalledTimes(1);
  });
  it('blocks diagnostic starts while busy and leaves cancellation available', () => {
    const onPrefill = jest.fn();
    const onInspectTokens = jest.fn();
    const onCancelDiagnostics = jest.fn();
    const view = render(<AdvancedGenerationControls params={base} supportsReasoning onChange={jest.fn()}
      onPrefill={onPrefill} onInspectTokens={onInspectTokens} diagnosticBusy onCancelDiagnostics={onCancelDiagnostics} />);
    fireEvent.press(view.getByTestId('generation-advanced-toggle'));
    fireEvent.press(view.getByTestId('generation-section-template'));
    fireEvent.press(view.getByTestId('generation-prefill'));
    fireEvent.press(view.getByTestId('generation-inspect-tokens'));
    expect(onPrefill).not.toHaveBeenCalled();
    expect(onInspectTokens).not.toHaveBeenCalled();
    fireEvent.press(view.getByTestId('generation-cancel-diagnostics'));
    expect(onCancelDiagnostics).toHaveBeenCalledTimes(1);
  });
});
