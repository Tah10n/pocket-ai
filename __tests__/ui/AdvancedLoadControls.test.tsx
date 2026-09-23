import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Button } from 'react-native';
import { AdvancedLoadControls } from '../../src/components/ui/AdvancedLoadControls';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';

jest.mock('../../src/providers/ThemeProvider', () => {
  const { resolveTheme } = jest.requireActual('../../src/design-system/themes/resolver');
  return { useTheme: () => { const resolvedTheme = resolveTheme('default', 'light'); return { resolvedTheme, colors: resolvedTheme.colors }; } };
});
jest.mock('../../src/components/ui/MaterialSymbols', () => ({ MaterialSymbols: () => null }));
const base: ModelLoadParameters = { contextSize: 512, gpuLayers: 0, kvCacheType: 'f16' };
function setup(overrides: Partial<React.ComponentProps<typeof AdvancedLoadControls>> = {}) {
  const onChange = jest.fn();
  const view = render(<AdvancedLoadControls value={base} onChange={onChange} {...overrides} />);
  fireEvent.press(view.getByTestId('load-advanced-toggle'));
  return { ...view, onChange };
}
function edit(view: ReturnType<typeof setup>, field: string, text: string) {
  fireEvent.changeText(view.getByTestId(`load-${field}`), text);
  fireEvent(view.getByTestId(`load-${field}`), 'endEditing', { nativeEvent: { text } });
}
describe('AdvancedLoadControls', () => {
  it('honors an external load reset while editing without republishing stale native text', () => {
    const view = setup({ value: { ...base, ropeFreqScale: 0 } });
    fireEvent.press(view.getByTestId('load-section-memory'));
    fireEvent.changeText(view.getByTestId('load-ropeFreqScale'), '1.');
    view.rerender(<AdvancedLoadControls value={{ ...base, ropeFreqScale: 1 }} onChange={view.onChange} />);
    expect(view.getByTestId('load-ropeFreqScale').props.value).toBe('1.');
    view.onChange.mockClear();
    view.rerender(<AdvancedLoadControls value={{ ...base, ropeFreqScale: 0 }} onChange={view.onChange} />);
    expect(view.getByTestId('load-ropeFreqScale').props.value).toBe('0');
    fireEvent(view.getByTestId('load-ropeFreqScale'), 'endEditing', { nativeEvent: { text: '1.' } });
    expect(view.onChange).not.toHaveBeenCalled();
    fireEvent.changeText(view.getByTestId('load-ropeFreqScale'), '0.5');
    expect(view.onChange).toHaveBeenLastCalledWith({ ropeFreqScale: 0.5 });
  });

  it('applies the latest valid numeric draft without waiting for native endEditing', () => {
    const onApply = jest.fn();
    function Profile() {
      const [draft, setDraft] = React.useState<ModelLoadParameters>({ ...base, ropeFreqScale: 1 });
      return <>
        <AdvancedLoadControls value={draft} onChange={partial => setDraft(previous => ({ ...previous, ...partial }))} />
        <Button testID="apply-profile" title="Apply" onPress={() => onApply(draft)} />
      </>;
    }
    const view = render(<Profile />);
    fireEvent.press(view.getByTestId('load-advanced-toggle'));
    fireEvent.press(view.getByTestId('load-section-memory'));
    fireEvent.changeText(view.getByTestId('load-ropeFreqScale'), '0.5');
    fireEvent.press(view.getByTestId('apply-profile'));
    expect(onApply).toHaveBeenLastCalledWith({ ...base, ropeFreqScale: 0.5 });
    for (const invalid of ['-', '1e', '-1', '1000001']) {
      fireEvent.changeText(view.getByTestId('load-ropeFreqScale'), invalid);
      fireEvent.press(view.getByTestId('apply-profile'));
      expect(onApply).toHaveBeenLastCalledWith({ ...base, ropeFreqScale: 0.5 });
    }
    fireEvent(view.getByTestId('load-ropeFreqScale'), 'endEditing', { nativeEvent: { text: '-1' } });
    expect(view.getByRole('alert')).toBeTruthy();
  });

  it('edits independent K/V while default clears only that side', () => {
    const view = setup({ value: { ...base, cacheTypeK: 'q8_0', cacheTypeV: 'f32' } });
    fireEvent.press(view.getByTestId('load-section-cache'));
    fireEvent.press(view.getByTestId('load-cacheTypeK-q5_1'));
    expect(view.onChange).toHaveBeenLastCalledWith({ cacheTypeK: 'q5_1' });
    fireEvent.press(view.getByTestId('load-cacheTypeV-default'));
    expect(view.onChange).toHaveBeenLastCalledWith({ cacheTypeV: undefined });
    expect(view.queryByTestId('load-cacheTypeK-bf16')).toBeNull();
  });
  it('keeps meaningful zero and false and rejects invalid ranges', () => {
    const view = setup();
    fireEvent.press(view.getByTestId('load-section-memory'));
    edit(view, 'ropeFreqScale', '0');
    expect(view.onChange).toHaveBeenLastCalledWith({ ropeFreqScale: 0 });
    fireEvent.press(view.getByTestId('load-noExtraBufts-off'));
    expect(view.onChange).toHaveBeenLastCalledWith({ noExtraBufts: false });
    view.onChange.mockClear();
    edit(view, 'ropeFreqBase', '-1');
    edit(view, 'nCpuMoe', '1.5');
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.getAllByRole('alert')).toHaveLength(2);
  });
  it('rejects conflicting draft bounds and zero maximum for enabled MTP', () => {
    const view = setup({ value: { ...base, specDraftNMax: 4, specDraftNMin: 2 }, mtpEnabled: true, hasSpeculativeDraft: true });
    fireEvent.press(view.getByTestId('load-section-draft'));
    edit(view, 'specDraftNMin', '5');
    edit(view, 'specDraftNMax', '0');
    expect(view.onChange).not.toHaveBeenCalled();
    edit(view, 'specDraftPMin', '0');
    expect(view.onChange).toHaveBeenLastCalledWith({ specDraftPMin: 0 });
  });
  it('gates draft fields and disallows unsupported quantized draft V', () => {
    const view = setup({ mtpEnabled: true, hasSpeculativeDraft: true });
    fireEvent.press(view.getByTestId('load-section-draft'));
    fireEvent.press(view.getByTestId('load-specDraftCacheTypeV-q8_0'));
    expect(view.onChange).not.toHaveBeenCalled();
    fireEvent.press(view.getByTestId('load-specDraftCacheTypeV-f32'));
    expect(view.onChange).toHaveBeenLastCalledWith({ specDraftCacheTypeV: 'f32' });
    view.rerender(<AdvancedLoadControls value={base} onChange={view.onChange} mtpEnabled={false} />);
    expect(view.getByTestId('load-specDraftNMax').props.editable).toBe(false);
  });
  it('shows draft, requested and effective profiles separately', () => {
    const translations = jest.requireMock('react-i18next') as { __setTranslationOverride: (key: string, text: string) => void };
    translations.__setTranslationOverride('advancedLoad.profileState', '{{draft}} / {{requested}} / {{effective}}');
    const view = setup({ value: { ...base, cacheTypeV: 'q8_0' }, diagnostics: {
      backendMode: 'cpu', backendDevices: [],
      requestedAdvancedLoad: { cacheTypeV: 'q4_0' }, effectiveAdvancedLoad: { cacheTypeV: 'f16' },
    } });
    fireEvent.press(view.getByTestId('load-section-cache'));
    expect(view.getByTestId('load-effective-cacheTypeV').props.children).toBe('q8_0 / q4_0 / f16');
  });
});
