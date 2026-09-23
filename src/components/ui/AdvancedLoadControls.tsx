import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelLoadParameters } from '../../services/SettingsStore';
import type { EngineDiagnostics } from '../../types/models';
import { assertAdvancedLoadParameterCombinations, isPublicKvCacheType, PUBLIC_KV_CACHE_TYPES,
  sanitizeAdvancedLoadParameters, type AdvancedLoadParameters } from '../../utils/advancedLoadProfile';
import { Box } from './box';
import { Button, ButtonText } from './button';
import { Text } from './text';
import { ScreenCard, ScreenInlineInput, ScreenSegmentedControl } from './ScreenShell';

interface Props {
  value: ModelLoadParameters;
  onChange: (partial: Partial<ModelLoadParameters>) => void;
  disabled?: boolean;
  mtpEnabled?: boolean;
  hasSpeculativeDraft?: boolean;
  supportsMoe?: boolean;
  diagnostics?: EngineDiagnostics | null;
}
const ranges = {
  ropeFreqBase: [0, 1e9, false], ropeFreqScale: [0, 1e6, false], nCpuMoe: [0, 4096, true],
  specDraftNMax: [0, 64, true], specDraftNMin: [0, 64, true],
  specDraftPMin: [0, 1, false], specDraftPSplit: [0, 1, false], specDraftNGpuLayers: [-1, 4096, true],
} as const;
type NumericKey = keyof typeof ranges;
type CacheKey = 'cacheTypeK' | 'cacheTypeV' | 'specDraftCacheTypeK' | 'specDraftCacheTypeV';

function NumericField({ field, value, disabled, hint, onCommit }: {
  field: NumericKey; value?: number; disabled: boolean; hint: string; onCommit: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  const committed = useRef(text);
  const pendingValue = useRef<string | undefined>(undefined);
  const receivedValue = useRef(value);
  const ignoreEndEditing = useRef(false);
  useEffect(() => {
    if (value === receivedValue.current) return;
    receivedValue.current = value;
    const next = value === undefined ? '' : String(value);
    if (next === pendingValue.current) {
      pendingValue.current = undefined;
      return;
    }
    pendingValue.current = undefined;
    setText(next);
    committed.current = next;
    ignoreEndEditing.current = true;
    setInvalid(false);
  }, [value]);
  const commit = (next: string, showInvalid: boolean) => {
    if (disabled) return;
    try {
      if (next !== committed.current) {
        pendingValue.current = next.trim() ? String(Number(next)) : '';
        onCommit(next);
        committed.current = next;
      }
      setInvalid(false);
    } catch {
      pendingValue.current = undefined;
      setInvalid(showInvalid);
    }
  };
  return <Box className="gap-2">
    <Text className="text-sm font-semibold">{t(`advancedLoad.fields.${field}`)}</Text>
    <Text colorRole="secondary" className="text-xs">{hint}</Text>
    <ScreenInlineInput testID={`load-${field}`} value={text} editable={!disabled} maxLength={24}
      accessibilityLabel={t(`advancedLoad.fields.${field}`)} accessibilityHint={hint} accessibilityState={{ disabled }}
      autoCapitalize="none" autoCorrect={false} placeholder={t('advancedLoad.default')}
      onChangeText={next => {
        ignoreEndEditing.current = false;
        setText(next);
        commit(next, false);
      }} onEndEditing={event => {
        if (ignoreEndEditing.current) return;
        commit(event.nativeEvent?.text ?? text, true);
      }} />
    {invalid ? <Text accessibilityRole="alert" colorRole="danger" className="text-xs">{t('advancedLoad.invalid')}</Text> : null}
  </Box>;
}

export function AdvancedLoadControls({ value, onChange, disabled = false, mtpEnabled = false,
  hasSpeculativeDraft = false, supportsMoe, diagnostics }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState<'cache' | 'memory' | 'draft' | null>(null);
  const format = (input: unknown) => input === undefined ? t('advancedLoad.default')
    : typeof input === 'boolean' ? t(input ? 'advancedLoad.on' : 'advancedLoad.off') : String(input);
  const applied = (field: keyof AdvancedLoadParameters) => {
    const effective = diagnostics?.effectiveAdvancedLoad;
    const requested = diagnostics?.requestedAdvancedLoad;
    if (field === 'loraAdapters' || !effective) return null;
    return <Text testID={`load-effective-${field}`} colorRole="secondary" className="text-xs">
      {t('advancedLoad.profileState', { draft: format(value[field]), requested: format(requested?.[field]), effective: format(effective[field]) })}
    </Text>;
  };
  const numeric = (field: NumericKey) => {
    const [min, max, integer] = ranges[field];
    const inactive = disabled || (field === 'nCpuMoe' && supportsMoe === false)
      || (field.startsWith('specDraft') && !mtpEnabled)
      || (field === 'specDraftNGpuLayers' && !hasSpeculativeDraft);
    return <Box key={field} className="gap-1">
      <NumericField field={field} value={value[field]} disabled={inactive}
        hint={`${t(`advancedLoad.hints.${field}`)} ${t('advancedGeneration.range', { min, max })} ${t('advancedLoad.reload')}${inactive ? ` ${t('advancedLoad.inactive')}` : ''}`}
        onCommit={text => {
          const number = text.trim() ? Number(text) : undefined;
          if (number !== undefined && (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number)))) throw new Error('invalid');
          const patch = { [field]: number };
          assertAdvancedLoadParameterCombinations(sanitizeAdvancedLoadParameters({ ...value, ...patch }), mtpEnabled);
          onChange(patch);
        }} />{applied(field)}
    </Box>;
  };
  const cache = (field: CacheKey) => {
    const inactive = disabled || (field.startsWith('specDraft') && (!mtpEnabled || !hasSpeculativeDraft));
    return <Box className="gap-2">
      <Text className="text-sm font-semibold">{t(`advancedLoad.fields.${field}`)}</Text>
      <Text colorRole="secondary" className="text-xs">{t('advancedLoad.cacheHint')} {t('advancedLoad.reload')}</Text>
      <Box className="flex-row flex-wrap gap-2">
        {['default', ...PUBLIC_KV_CACHE_TYPES].map(type => {
          const blocked = inactive || (field === 'specDraftCacheTypeV' && !['default', 'f16', 'f32'].includes(type));
          const selected = (value[field] ?? 'default') === type;
          return <Button key={type} size="sm" action={selected ? 'primary' : 'secondary'}
            testID={`load-${field}-${type}`} disabled={blocked} accessibilityRole="radio"
            accessibilityLabel={`${t(`advancedLoad.fields.${field}`)}: ${type === 'default' ? t('advancedLoad.default') : type}`}
            accessibilityState={{ selected, disabled: blocked }} onPress={() => {
              if (type === 'default') onChange({ [field]: undefined });
              else if (isPublicKvCacheType(type)) onChange({ [field]: type });
            }}><ButtonText>{type === 'default' ? t('advancedLoad.default') : type}</ButtonText></Button>;
        })}
      </Box>
      {field === 'specDraftCacheTypeV' ? <Text colorRole="secondary" className="text-xs">{t('advancedLoad.draftVUnavailable')}</Text> : null}
      {applied(field)}
    </Box>;
  };
  const flag = (field: 'noExtraBufts' | 'swaFull') => <Box className="gap-2">
    <Text className="text-sm font-semibold">{t(`advancedLoad.fields.${field}`)}</Text>
    <Text colorRole="secondary" className="text-xs">{t(`advancedLoad.hints.${field}`)} {t('advancedLoad.reload')}</Text>
    <ScreenSegmentedControl activeKey={value[field] === undefined ? 'default' : value[field] ? 'on' : 'off'} disabled={disabled}
      options={['default', 'on', 'off'].map(key => ({ key, label: t(`advancedLoad.${key}`), testID: `load-${field}-${key}`,
        accessibilityLabel: `${t(`advancedLoad.fields.${field}`)}: ${t(`advancedLoad.${key}`)}` }))}
      onChange={key => onChange({ [field]: key === 'default' ? undefined : key === 'on' })} />{applied(field)}
  </Box>;
  return <ScreenCard variant="inset" padding="compact" testID="advanced-load-controls">
    <Button action="secondary" testID="load-advanced-toggle" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
      <ButtonText>{t('advancedLoad.title')}</ButtonText>
    </Button>
    {expanded ? <Box className="mt-3 gap-3">
      <Text colorRole="secondary" className="text-sm">{t('advancedLoad.scope')}</Text>
      {(['cache', 'memory', 'draft'] as const).map(section => <Box key={section} className="gap-3">
        <Button action="softPrimary" testID={`load-section-${section}`} accessibilityState={{ expanded: group === section }}
          onPress={() => setGroup(group === section ? null : section)}><ButtonText>{t(`advancedLoad.sections.${section}`)}</ButtonText></Button>
        {group === section && section === 'cache' ? <Box className="gap-4">
          <Text colorRole="secondary" className="text-xs">{t('advancedLoad.cachePrecedence')}</Text>
          {cache('cacheTypeK')}{cache('cacheTypeV')}
        </Box> : null}
        {group === section && section === 'memory' ? <Box className="gap-4">
          {numeric('ropeFreqBase')}{numeric('ropeFreqScale')}{flag('noExtraBufts')}{flag('swaFull')}{numeric('nCpuMoe')}
        </Box> : null}
        {group === section && section === 'draft' ? <Box className="gap-4">
          <Text colorRole="secondary" className="text-xs">{t('advancedLoad.draftHint')}</Text>
          {numeric('specDraftNMax')}{numeric('specDraftNMin')}{numeric('specDraftPMin')}{numeric('specDraftPSplit')}
          {numeric('specDraftNGpuLayers')}{cache('specDraftCacheTypeK')}{cache('specDraftCacheTypeV')}
        </Box> : null}
      </Box>)}
    </Box> : null}
  </ScreenCard>;
}
