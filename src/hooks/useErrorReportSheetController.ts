import { useCallback, useState } from 'react';

export type ErrorReportContextSection = Record<string, unknown>;

export type ErrorReportContext = {
  model?: ErrorReportContextSection;
  engine?: ErrorReportContextSection;
  options?: ErrorReportContextSection;
  extra?: ErrorReportContextSection;
};

export type ErrorReportDraft = {
  scope: string;
  error: unknown;
  context?: ErrorReportContext;
};

export type ErrorReportSheetProps = {
  visible: boolean;
  onClose: () => void;
  scope: string;
  error: unknown;
  context?: ErrorReportContext;
};

export function useErrorReportSheetController() {
  const [draft, setDraft] = useState<ErrorReportDraft | null>(null);

  const openErrorReport = useCallback((nextDraft: ErrorReportDraft) => {
    setDraft(nextDraft);
  }, []);

  const closeErrorReport = useCallback(() => {
    setDraft(null);
  }, []);

  const sheetProps: ErrorReportSheetProps = {
    visible: draft !== null,
    onClose: closeErrorReport,
    scope: draft?.scope ?? '',
    error: draft?.error ?? null,
    context: draft?.context,
  };

  return { openErrorReport, closeErrorReport, sheetProps };
}

