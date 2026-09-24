import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GenerationParameters } from '../../services/SettingsStore';
import {
  ADVANCED_GENERATION_RANGES,
  sanitizeAdvancedGenerationParameters,
  sanitizeChatTemplate,
  sanitizeLogitBias,
  type ChatTemplateSettings,
} from '../../utils/generationControls';
import { prepareStructuredOutput, type StructuredOutputOptions } from '../../utils/structuredOutput';
import { Box } from './box';
import { Button, ButtonText } from './button';
import { Text } from './text';
import { ScreenCard, ScreenInlineInput, ScreenSegmentedControl } from './ScreenShell';

type Props = {
  params: GenerationParameters;
  supportsReasoning: boolean;
  disabled?: boolean;
  onChange: (partial: Partial<GenerationParameters>) => void;
  onPrefill?: () => void;
  onInspectTokens?: () => void;
  diagnosticBusy?: boolean;
  onCancelDiagnostics?: () => void;
};
type NumericKey = keyof typeof ADVANCED_GENERATION_RANGES;
const numericDefaults: Record<NumericKey, number> = {
  penaltyLastN: 64, frequencyPenalty: 0, presencePenalty: 0, typicalP: 1,
  mirostatTau: 5, mirostatEta: 0.1, xtcProbability: 0, xtcThreshold: 0.1,
  dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1,
  topNSigma: -1, nProbs: 0, thinkingBudgetTokens: 0,
};

/** Valid edits are published before a sheet close can unmount the native input. */
function DraftField({ id, value, hint, disabled = false, multiline = false, maxLength = 32768,
  placeholder, onCommit }: {
  id: string; value: string; hint: string; disabled?: boolean; multiline?: boolean;
  maxLength?: number; placeholder?: string; onCommit: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const committed = useRef(value);
  const pendingValue = useRef<string | undefined>(undefined);
  const receivedValue = useRef(value);
  const ignoreEndEditing = useRef(false);
  useEffect(() => {
    if (value === receivedValue.current) return;
    receivedValue.current = value;
    if (value === pendingValue.current) {
      pendingValue.current = undefined;
      return;
    }
    pendingValue.current = undefined;
    setDraft(value);
    committed.current = value;
    ignoreEndEditing.current = true;
    setInvalid(false);
  }, [value]);
  const commit = (text: string, showInvalid: boolean) => {
    if (disabled) return;
    try {
      if (text !== committed.current) {
        pendingValue.current = Object.prototype.hasOwnProperty.call(ADVANCED_GENERATION_RANGES, id)
          ? (text.trim() ? String(Number(text)) : '')
          : id === 'logitBias' ? JSON.stringify(sanitizeLogitBias(JSON.parse(text)))
          : ['kwargs', 'stop', 'drySequenceBreakers'].includes(id)
            ? (text.trim() ? JSON.stringify(JSON.parse(text)) : '') : text;
        onCommit(text);
        committed.current = text;
      }
      setInvalid(false);
    } catch {
      pendingValue.current = undefined;
      setInvalid(showInvalid);
    }
  };
  const label = t(`advancedGeneration.fields.${id}`);
  return <Box className="gap-2">
    <Text className="text-sm font-semibold">{label}</Text>
    <Text colorRole="secondary" className="text-xs">{hint}</Text>
    <ScreenInlineInput testID={`generation-${id}`} accessibilityLabel={label}
      accessibilityHint={hint} accessibilityState={{ disabled }} editable={!disabled}
      value={draft} placeholder={placeholder} multiline={multiline} maxLength={maxLength}
      autoCapitalize="none" autoCorrect={false}
      onChangeText={text => {
        ignoreEndEditing.current = false;
        setDraft(text);
        commit(text, false);
      }}
      onEndEditing={event => {
        if (ignoreEndEditing.current) return;
        const text = event.nativeEvent?.text ?? draft;
        commit(text, true);
      }} />
    {invalid ? <Text accessibilityRole="alert" colorRole="danger" className="text-xs">
      {t('advancedGeneration.invalid')}
    </Text> : null}
  </Box>;
}

function Choice({ id, value, options, disabled = false, onChange }: {
  id: string; value: string; options: readonly string[]; disabled?: boolean; onChange: (key: string) => void;
}) {
  const { t } = useTranslation();
  return <Box className="gap-2">
    <Text className="text-sm font-semibold">{t(`advancedGeneration.fields.${id}`)}</Text>
    <ScreenSegmentedControl activeKey={value} disabled={disabled}
      options={options.map(key => ({ key, label: t(`advancedGeneration.choices.${key}`),
        accessibilityLabel: `${t(`advancedGeneration.fields.${id}`)}: ${t(`advancedGeneration.choices.${key}`)}`,
        testID: `generation-${id}-${key}` }))} onChange={onChange} />
  </Box>;
}

export function AdvancedGenerationControls({ params, supportsReasoning, disabled = false, onChange, onPrefill,
  onInspectTokens, diagnosticBusy = false, onCancelDiagnostics }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<'sampling' | 'template' | 'output' | null>(null);
  const template = params.template ?? {};
  const output = params.output ?? { mode: 'text' };
  const reasoningInactive = !supportsReasoning || params.reasoningEffort === 'off';
  const patchTemplate = (patch: Partial<ChatTemplateSettings>) => onChange({ template: { ...template, ...patch } });
  const numeric = (key: NumericKey) => {
    const [min, max, integer] = ADVANCED_GENERATION_RANGES[key];
    const inactive = disabled
      || ((params.mirostat ?? 0) !== 0 && !['mirostatTau', 'mirostatEta', 'nProbs', 'thinkingBudgetTokens'].includes(key))
      || (key.startsWith('mirostat') && (params.mirostat ?? 0) === 0)
      || (key === 'xtcThreshold' && (params.xtcProbability ?? 0) === 0)
      || (key.startsWith('dry') && key !== 'dryMultiplier' && (params.dryMultiplier ?? 0) === 0)
      || (key === 'thinkingBudgetTokens' && reasoningInactive);
    return <DraftField key={key} id={key} value={params[key] === undefined ? '' : String(params[key])}
      disabled={inactive} maxLength={24} placeholder={key === 'thinkingBudgetTokens' ? t('advancedGeneration.choices.default') : String(numericDefaults[key])}
      hint={`${t(`advancedGeneration.hints.${key}`)} ${t('advancedGeneration.range', { min, max })}${inactive ? ` ${t('advancedGeneration.inactive')}` : ''}`}
      onCommit={text => {
        if (!text.trim()) { onChange({ [key]: undefined }); return; }
        const value = Number(text);
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error('invalid');
        onChange({ [key]: value });
      }} />;
  };
  const list = (key: 'stop' | 'drySequenceBreakers') => <DraftField id={key}
    value={params[key] === undefined ? '' : JSON.stringify(params[key])} multiline disabled={disabled
      || (key === 'drySequenceBreakers' && ((params.dryMultiplier ?? 0) === 0 || (params.mirostat ?? 0) !== 0))}
    hint={t('advancedGeneration.stringListHint')} placeholder="[]" maxLength={16384}
    onCommit={text => {
      if (!text.trim()) { onChange({ [key]: undefined }); return; }
      const value: unknown = JSON.parse(text);
      const sanitized = sanitizeAdvancedGenerationParameters({ [key]: value });
      if (sanitized[key] === undefined) throw new Error('invalid');
      onChange({ [key]: sanitized[key] });
    }} />;
  const templateFlag = (key: 'jinja' | 'addGenerationPrompt' | 'forcePureContent') => <Choice id={key}
    value={template[key] === undefined ? 'default' : template[key] ? 'on' : 'off'}
    options={['default', 'on', 'off']} disabled={disabled}
    onChange={value => patchTemplate({ [key]: value === 'default' ? undefined : value === 'on' })} />;
  return <ScreenCard testID="advanced-generation-controls">
    <Button action="secondary" accessibilityState={{ expanded }} testID="generation-advanced-toggle"
      onPress={() => setExpanded(value => !value)}>
      <ButtonText>{t('advancedGeneration.title')}</ButtonText>
    </Button>
    {expanded ? <Box className="mt-3 gap-3">
      <Text colorRole="secondary" className="text-sm">{t('advancedGeneration.scope')}</Text>
      {(['sampling', 'template', 'output'] as const).map(group => <Box key={group} className="gap-3">
        <Button action="softPrimary" testID={`generation-section-${group}`}
          accessibilityState={{ expanded: section === group }} onPress={() => setSection(section === group ? null : group)}>
          <ButtonText>{t(`advancedGeneration.sections.${group}`)}</ButtonText>
        </Button>
        {section === group && group === 'sampling' ? <Box className="gap-4">
          {numeric('penaltyLastN')}{numeric('frequencyPenalty')}{numeric('presencePenalty')}{numeric('typicalP')}
          <Choice id="mirostat" value={String(params.mirostat ?? 0)} options={['0', '1', '2']}
            disabled={disabled} onChange={value => {
              if (value === '0' || value === '1' || value === '2') onChange({ mirostat: value === '0' ? 0 : value === '1' ? 1 : 2 });
            }} />
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.mirostatHint')}</Text>
          {numeric('mirostatTau')}{numeric('mirostatEta')}{numeric('xtcProbability')}{numeric('xtcThreshold')}
          {numeric('dryMultiplier')}{numeric('dryBase')}{numeric('dryAllowedLength')}{numeric('dryPenaltyLastN')}
          {list('drySequenceBreakers')}{numeric('topNSigma')}{list('stop')}{numeric('nProbs')}
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.probabilitiesHint')}</Text>
          <Choice id="reasoningFormat" value={params.reasoningFormat ?? 'auto'} options={['none', 'auto', 'deepseek']}
            disabled={disabled || reasoningInactive} onChange={value => {
              if (value === 'none' || value === 'auto' || value === 'deepseek') onChange({ reasoningFormat: value });
            }} />
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.reasoningHint')}</Text>
          {numeric('thinkingBudgetTokens')}
          <DraftField id="thinkingBudgetMessage" value={params.thinkingBudgetMessage ?? ''} multiline maxLength={1024}
            disabled={disabled || reasoningInactive} hint={t('advancedGeneration.thinkingMessageHint')}
            onCommit={value => onChange({ thinkingBudgetMessage: value })} />
          <Box className="gap-2">
            <Text className="text-sm font-semibold">{t('advancedGeneration.fields.ignoreEos')}</Text>
            <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.ignoreEosHint')}</Text>
            <Box className="flex-row gap-2">
              {(['off', 'on'] as const).map(key => {
                const blocked = disabled || (key === 'on' && output.mode !== 'text');
                const selected = (params.ignoreEos === true) === (key === 'on');
                return <Button key={key} size="sm" action={selected ? 'primary' : 'secondary'} disabled={blocked}
                  testID={`generation-ignoreEos-${key}`} accessibilityRole="radio"
                  accessibilityLabel={`${t('advancedGeneration.fields.ignoreEos')}: ${t(`advancedGeneration.choices.${key}`)}`}
                  accessibilityHint={t('advancedGeneration.ignoreEosHint')} accessibilityState={{ selected, disabled: blocked }}
                  onPress={() => { if (!blocked) onChange({ ignoreEos: key === 'on' }); }}>
                  <ButtonText>{t(`advancedGeneration.choices.${key}`)}</ButtonText>
                </Button>;
              })}
            </Box>
          </Box>
          <DraftField id="logitBias" value={JSON.stringify(params.logitBias ?? [])} multiline maxLength={8192}
            disabled={disabled} hint={t('advancedGeneration.logitBiasHint')} placeholder="[]" onCommit={text => {
              const value = sanitizeLogitBias(JSON.parse(text));
              if (value === undefined) throw new Error('invalid');
              onChange({ logitBias: value });
            }} />
        </Box> : null}
        {section === group && group === 'template' ? <Box className="gap-4">
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.templateHint')}</Text>
          <DraftField id="chatTemplate" value={template.chatTemplate ?? ''} multiline disabled={disabled}
            hint={t('advancedGeneration.templateSourceHint')} onCommit={value => patchTemplate({ chatTemplate: value || undefined })} />
          {templateFlag('jinja')}{templateFlag('addGenerationPrompt')}{templateFlag('forcePureContent')}
          <DraftField id="kwargs" value={template.kwargs === undefined ? '' : JSON.stringify(template.kwargs)} multiline disabled={disabled}
            hint={t('advancedGeneration.kwargsHint')} placeholder="{}" onCommit={text => {
              if (!text.trim()) { patchTemplate({ kwargs: undefined }); return; }
              const value: unknown = JSON.parse(text);
              const checked = sanitizeChatTemplate({ kwargs: value });
              if (checked?.kwargs === undefined) throw new Error('invalid');
              patchTemplate({ kwargs: checked.kwargs });
            }} />
          <DraftField id="now" value={template.now === undefined ? '' : String(template.now)} maxLength={24} disabled={disabled}
            hint={t('advancedGeneration.nowHint')} onCommit={text => {
              if (!text.trim()) { patchTemplate({ now: undefined }); return; }
              const checked = sanitizeChatTemplate({ now: text });
              if (checked?.now === undefined) throw new Error('invalid');
              patchTemplate({ now: checked.now });
            }} />
          <DraftField id="prefillText" value={template.prefillText ?? ''} multiline disabled={disabled}
            hint={t('advancedGeneration.prefillHint')} onCommit={value => patchTemplate({ prefillText: value })} />
          <Button action="secondary" disabled={disabled || diagnosticBusy || !onPrefill} testID="generation-prefill" onPress={onPrefill}>
            <ButtonText>{t('advancedGeneration.prefillAction')}</ButtonText>
          </Button>
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.prefillActionHint')}</Text>
          <Button action="secondary" disabled={disabled || diagnosticBusy || !onInspectTokens} testID="generation-inspect-tokens" onPress={onInspectTokens}>
            <ButtonText>{t('advancedGeneration.inspectTokens')}</ButtonText>
          </Button>
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.inspectTokensHint')}</Text>
          {diagnosticBusy && onCancelDiagnostics ? <Button action="secondary" testID="generation-cancel-diagnostics" onPress={onCancelDiagnostics}>
            <ButtonText>{t('advancedGeneration.cancelDiagnostics')}</ButtonText>
          </Button> : null}
        </Box> : null}
        {section === group && group === 'output' ? <Box className="gap-4">
          <Choice id="outputMode" value={output.mode} options={['text', 'json_object', 'json_schema', 'gbnf']} disabled={disabled}
            onChange={mode => {
              if (mode === 'text' || mode === 'json_object') onChange({ output: { mode } });
              if (mode === 'json_schema') onChange({ output: { mode, schema: output.mode === mode ? output.schema : '{}' } });
              if (mode === 'gbnf') onChange({ output: { mode, grammar: output.mode === mode ? output.grammar : 'root ::= "yes" | "no"' } });
            }} />
          <Text colorRole="secondary" className="text-xs">{t('advancedGeneration.outputHint')}</Text>
          {output.mode === 'json_schema' || output.mode === 'gbnf' ? <DraftField key={output.mode}
            id={output.mode === 'json_schema' ? 'schema' : 'grammar'}
            value={output.mode === 'json_schema' ? output.schema : output.grammar} multiline disabled={disabled}
            hint={t(output.mode === 'json_schema' ? 'advancedGeneration.schemaHint' : 'advancedGeneration.grammarHint')}
            onCommit={value => {
              const updated: StructuredOutputOptions = output.mode === 'json_schema'
                ? { mode: 'json_schema', schema: value } : { mode: 'gbnf', grammar: value };
              prepareStructuredOutput(updated);
              onChange({ output: updated });
            }} /> : null}
        </Box> : null}
      </Box>)}
    </Box> : null}
  </ScreenCard>;
}
