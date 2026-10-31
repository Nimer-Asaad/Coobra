import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Modal, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { ConsequenceLine, ConsequencePreview } from '@coobra/shared';
import { ApiError } from '../api-client';
import { formatMoney } from '../shipments/format';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { AppText } from '../ui/text';
import { colors, radius, spacing } from '../ui/theme';
import { useDirection } from '../ui/use-direction';
import { formatCountdown } from './banner';
import { useImpersonationStore } from './store';

/** The server says the confirmation no longer matches: show the new charges and ask again. */
const RECONFIRM_CODES = ['CONSEQUENCE_CHANGED', 'CONSEQUENCE_CONFIRMATION_REQUIRED'];

const sameLines = (a: ConsequenceLine[], b: ConsequenceLine[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * R2 (ADR 0003 §10.3): the charges an impersonated action can lead to, exactly as the API
 * computed and signed them. Confirming sends the server's token; if anything changed meanwhile
 * the API refuses it and the sheet shows the new charges (and what they were) for a fresh
 * confirmation. An expired preview can only be refreshed, never sent.
 */
export function ConsequenceSheet({
  title,
  load,
  confirm,
  onClose,
}: {
  title: string;
  load: () => Promise<ConsequencePreview>;
  /** The write itself, with the token; rejects with the API's error. */
  confirm: (confirmationToken: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { language, direction } = useDirection();
  const { width } = useWindowDimensions();
  const offset = useImpersonationStore((state) =>
    state.info ? Date.parse(state.info.serverNow) - state.receivedAt : 0,
  );
  // Each attempt is a fresh, uncached request: the server signs a new token every time.
  const instance = useId();
  const [attempt, setAttempt] = useState(0);
  const [previous, setPrevious] = useState<ConsequenceLine[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const query = useQuery({
    queryKey: ['impersonation', 'consequences', instance, attempt],
    queryFn: () => loadRef.current(),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = query.data ?? null;
  const loading = query.isFetching;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /** Loads new charges; `before` is what was shown, to point out what changed. */
  function refresh(before: ConsequenceLine[] | null) {
    setError(null);
    setPrevious(before);
    setAttempt((value) => value + 1);
  }

  const remaining = preview ? Date.parse(preview.expiresAt) - (now + offset) : 0;
  const expired = Boolean(preview) && remaining <= 0;
  const changed = previous !== null;

  async function onConfirm() {
    if (!preview) return;
    if (expired) {
      refresh(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await confirm(preview.confirmationToken);
    } catch (failure) {
      if (failure instanceof ApiError && RECONFIRM_CODES.includes(failure.body.code)) {
        refresh(preview.lines);
      } else {
        setError(failure);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const narrow = width < 640;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={[styles.overlay, narrow ? styles.overlayNarrow : styles.overlayWide]}>
        <View
          role="dialog"
          aria-modal
          aria-label={title}
          style={[styles.panel, narrow && styles.panelNarrow, { direction }]}
          testID="consequence-sheet"
        >
          <AppText variant="subtitle" role="heading">
            {title}
          </AppText>
          <AppText variant="muted">{t('impersonation.charges.intro')}</AppText>
          {changed ? (
            <Banner
              message={
                previous && preview && sameLines(previous, preview.lines)
                  ? t('impersonation.charges.detailsChanged')
                  : t('impersonation.charges.changed')
              }
            />
          ) : null}
          {loading ? (
            <ActivityIndicator color={colors.primary} />
          ) : preview ? (
            <View style={styles.lines} testID="consequence-lines">
              {preview.lines.length === 0 ? (
                <AppText>{t('impersonation.charges.none')}</AppText>
              ) : (
                preview.lines.map((line) => (
                  <ChargeLine
                    key={line.kind}
                    line={line}
                    before={previous?.find((item) => item.kind === line.kind)}
                    showChange={changed}
                    language={language}
                  />
                ))
              )}
              <AppText variant="muted" testID="consequence-validity">
                {expired
                  ? t('impersonation.charges.expired')
                  : t('impersonation.charges.validFor', { time: formatCountdown(remaining) })}
              </AppText>
            </View>
          ) : null}
          <ErrorBanner error={error ?? query.error} />
          <AppButton
            title={
              expired || !preview
                ? t('impersonation.charges.refresh')
                : t('impersonation.charges.confirm')
            }
            onPress={() => (preview ? void onConfirm() : refresh(null))}
            loading={submitting}
            disabled={loading}
            testID="consequence-confirm"
          />
          <AppButton variant="link" title={t('common.cancel')} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function ChargeLine({
  line,
  before,
  showChange,
  language,
}: {
  line: ConsequenceLine;
  before: ConsequenceLine | undefined;
  showChange: boolean;
  language: 'ar' | 'en';
}) {
  const { t } = useTranslation();
  const amount = (value: string | null) =>
    value === null ? t('impersonation.charges.undecided') : formatMoney(value, language);
  const moved = showChange && (!before || before.amount !== line.amount);
  return (
    <View style={styles.line} testID={`consequence-${line.kind}`}>
      <View style={styles.lineRow}>
        <AppText variant="label" style={styles.grow}>
          {t(`impersonation.charges.kind.${line.kind}`)}
        </AppText>
        <AppText variant="label">{amount(line.amount)}</AppText>
      </View>
      <AppText variant="muted">
        {t(`impersonation.charges.certainty.${line.certainty}`)} ·{' '}
        {t(`impersonation.charges.trigger.${line.trigger}`)}
      </AppText>
      {moved ? (
        <AppText style={styles.changed}>
          {before
            ? t('impersonation.charges.was', { amount: amount(before.amount) })
            : t('impersonation.charges.new')}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', padding: spacing.lg },
  overlayNarrow: { justifyContent: 'flex-end', padding: 0 },
  overlayWide: { justifyContent: 'center', alignItems: 'center' },
  panel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  panelNarrow: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, maxWidth: '100%' },
  lines: { gap: spacing.md },
  line: {
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
  },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grow: { flexGrow: 1, flexShrink: 1 },
  changed: { color: colors.danger, fontWeight: '600', fontSize: 14 },
});
