import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ChatDocumentRetrievalControl, DocumentPreparationCard } from '../../src/components/ui/ChatDocumentRetrievalControl';
import en from '../../src/i18n/locales/en.json';
import ru from '../../src/i18n/locales/ru.json';

jest.mock('react-native-css-interop', () => ({ createInteropElement: jest.requireActual<typeof import('react')>('react').createElement }));

const translations = jest.requireMock('react-i18next') as {
  __resetTranslations: () => void;
  __setMockLanguage: (language: string) => void;
  __setTranslationOverride: (key: string, value: string, language?: string) => void;
};
const base = { settings: { mode: 'lexical' as const, rerank: false }, onChange: jest.fn(),
  onPrepare: jest.fn(), onCancel: jest.fn() };

beforeEach(() => { jest.clearAllMocks(); translations.__resetTranslations(); });

it('keeps preparation and both model operations opt-in while exposing independent reranking', () => {
  const expand = jest.fn();
  const view = render(<ChatDocumentRetrievalControl {...base} onExpand={expand} />);
  expect(expand).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('chat-retrieval-expand'));
  expect(expand).toHaveBeenCalledTimes(1);
  expect(base.onPrepare).not.toHaveBeenCalled();
  expect(base.onChange).not.toHaveBeenCalled();
  expect(view.getByTestId('chat-retrieval-mode-lexical').props.accessibilityState.selected).toBe(true);
  fireEvent.press(view.getByTestId('chat-retrieval-rerank'));
  expect(base.onChange).toHaveBeenLastCalledWith({ mode: 'lexical', rerank: true });
  view.rerender(<ChatDocumentRetrievalControl {...base} settings={{ mode: 'lexical', rerank: true }} />);
  fireEvent.press(view.getByTestId('chat-retrieval-mode-hybrid'));
  expect(base.onChange).toHaveBeenLastCalledWith({ mode: 'hybrid', rerank: true });
  fireEvent.press(view.getByTestId('chat-retrieval-expand'));
  expect(expand).toHaveBeenCalledTimes(1);
});

it('disables settings and preparation during native work while keeping cancellation available when collapsed', () => {
  const view = render(<ChatDocumentRetrievalControl {...base} disabled
    settings={{ mode: 'hybrid', rerank: true }} embeddingModelName="Embedding B"
    documents={[{ attachmentId: 'd1', displayName: 'Long document', status: 'preparing', processed: 1, total: 4 }]} />);
  fireEvent.press(view.getByTestId('chat-retrieval-cancel-active'));
  expect(base.onCancel).toHaveBeenCalledWith('d1');
  fireEvent.press(view.getByTestId('chat-retrieval-expand'));
  fireEvent.press(view.getByTestId('chat-retrieval-mode-lexical'));
  fireEvent.press(view.getByTestId('chat-retrieval-rerank'));
  expect(base.onChange).not.toHaveBeenCalled();
  expect(view.getByTestId('document-preparation-progress-d1').props.accessibilityValue.now).toBe(25);
  fireEvent.press(view.getByTestId('document-preparation-cancel-d1'));
  expect(base.onCancel).toHaveBeenCalledTimes(2);
});

it('requires hybrid mode and a selected embedding model before enabling explicit preparation', () => {
  const document = { attachmentId: 'd1', displayName: 'Report', status: 'not_ready' as const };
  const view = render(<ChatDocumentRetrievalControl {...base} documents={[document]} embeddingModelName="Embedding B" />);
  fireEvent.press(view.getByTestId('chat-retrieval-expand'));
  fireEvent.press(view.getByTestId('document-preparation-start-d1'));
  expect(base.onPrepare).not.toHaveBeenCalled();
  view.rerender(<ChatDocumentRetrievalControl {...base} documents={[document]} settings={{ mode: 'hybrid', rerank: false }} />);
  expect(view.getByTestId('document-preparation-start-d1').props.accessibilityState.disabled).toBe(true);
  view.rerender(<ChatDocumentRetrievalControl {...base} documents={[document]} settings={{ mode: 'hybrid', rerank: false }}
    embeddingModelName="Embedding B" />);
  fireEvent.press(view.getByTestId('document-preparation-start-d1'));
  expect(base.onPrepare).toHaveBeenCalledWith('d1');
});

it.each(['ready', 'stale', 'cancelled', 'error'] as const)('reports %s per-document status without claiming a search result', status => {
  const view = render(<DocumentPreparationCard document={{ attachmentId: 'd1', displayName: 'Report', status }}
    disabled={false} onPrepare={base.onPrepare} onCancel={base.onCancel} />);
  expect(view.getByText(`chat.retrieval.status.${status}`)).toBeTruthy();
  expect(view.queryByTestId('chat-retrieval-actual-mode')).toBeNull();
  expect(view.queryByTestId('document-preparation-start-d1') !== null).toBe(status !== 'ready');
});

it.each([NaN, Infinity, -1])('keeps invalid progress %s bounded', processed => {
  const view = render(<DocumentPreparationCard document={{ attachmentId: 'd1', displayName: 'Report', status: 'preparing', processed, total: 4 }}
    disabled onPrepare={base.onPrepare} onCancel={base.onCancel} />);
  expect(view.getByTestId('document-preparation-progress-d1').props.accessibilityValue.now).toBe(0);
});

it('shows cancellation while the native operation drains and prevents repeat cancellation', () => {
  const view = render(<DocumentPreparationCard document={{ attachmentId: 'd1', displayName: 'Report',
    status: 'preparing', processed: 2, total: 4, cancelling: true }}
    disabled onPrepare={base.onPrepare} onCancel={base.onCancel} />);
  expect(view.getByTestId('document-preparation-status-d1').props.children[0]).toBe('chat.retrieval.status.cancelling');
  expect(view.getByTestId('document-preparation-cancel-d1').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(view.getByTestId('document-preparation-cancel-d1'));
  expect(base.onCancel).not.toHaveBeenCalled();
});

it.each([['en', en], ['ru', ru]] as const)('shows selected model names and actual fallback in %s', (language, locale) => {
  function addStrings(value: Record<string, unknown>, prefix = '') {
    Object.entries(value).forEach(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'string') translations.__setTranslationOverride(path, child, language);
      else if (child && typeof child === 'object') addStrings(child as Record<string, unknown>, path);
    });
  }
  addStrings(locale);
  translations.__setMockLanguage(language);
  const view = render(<ChatDocumentRetrievalControl {...base} settings={{ mode: 'hybrid', rerank: true }}
    embeddingModelName="Embedding B" rerankerModelName="Reranker C" actualMode="lexical" fallbackReason="profile_unverified" />);
  const actual = view.getByTestId('chat-retrieval-actual-mode').props.children.join('');
  expect(actual).toContain(locale.chat.retrieval.modes.lexical);
  expect(actual).toContain(locale.chat.retrieval.reasons.profile_unverified);
  fireEvent.press(view.getByTestId('chat-retrieval-expand'));
  expect(view.getByText(locale.chat.retrieval.embeddingModel.replace('{{name}}', 'Embedding B'))).toBeTruthy();
  expect(view.getByText(locale.chat.retrieval.rerankerModel.replace('{{name}}', 'Reranker C'))).toBeTruthy();
  expect(view.getByText(locale.chat.retrieval.description)).toBeTruthy();
});

it.each(['quota_exceeded', 'cache_write_failed'] as const)('reports an unsaved %s cache without relabeling Hybrid context as a fallback', reason => {
  const view = render(<ChatDocumentRetrievalControl {...base} settings={{ mode: 'hybrid', rerank: true }}
    actualMode="hybrid+rerank" cacheFailures={[{ attachmentId: 'd1', reason }]} />);
  const actual = view.getByTestId('chat-retrieval-actual-mode').props.children.join('');
  expect(actual).toContain('chat.retrieval.actualMode');
  expect(actual).not.toContain('chat.retrieval.fallback');
  expect(view.getByTestId('chat-retrieval-cache-unsaved')).toBeTruthy();
  expect(base.onPrepare).not.toHaveBeenCalled();
});
