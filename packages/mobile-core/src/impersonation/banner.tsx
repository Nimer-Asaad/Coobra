import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ImpersonationInfo, MeResponse } from '@coobra/shared';
import { ApiError, NetworkError } from '../api-client';
import { useApi } from '../api-context';
import { spacing, radius } from '../ui/theme';
import { useDirection } from '../ui/use-direction';
import { useImpersonationStore } from './store';

/** How often the tab asks the API whether the impersonation is still active. */
const CHECK_INTERVAL_MS = 30_000;
const SOON_MS = 5 * 60_000;

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Milliseconds left by the server's clock (`serverNow` was received at `receivedAt`). */
export function useRemaining(info: ImpersonationInfo, receivedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const offset = Date.parse(info.serverNow) - receivedAt;
  return Date.parse(info.expiresAt) - (now + offset);
}

/**
 * Fixed at the top of every screen of an impersonation tab and never dismissable: whose account
 * this is, the admin acting, the time left and End. A screen reader hears the time only at
 * 5 minutes and 1 minute left, not every second.
 */
export function ImpersonationBanner() {
  const info = useImpersonationStore((state) => state.info);
  const receivedAt = useImpersonationStore((state) => state.receivedAt);
  if (!info) return null;
  return <BannerContent info={info} receivedAt={receivedAt} />;
}

function BannerContent({ info, receivedAt }: { info: ImpersonationInfo; receivedAt: number }) {
  const { t } = useTranslation();
  const { direction } = useDirection();
  const api = useApi();
  const remaining = useRemaining(info, receivedAt);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);
  const soon = remaining <= SOON_MS;
  const minutesLeft = Math.ceil(remaining / 60_000);
  const announcement =
    minutesLeft <= 1
      ? t('impersonation.banner.oneMinuteLeft')
      : minutesLeft <= 5
        ? t('impersonation.banner.fiveMinutesLeft')
        : '';

  useEffect(() => {
    if (remaining <= 0) useImpersonationStore.getState().end('EXPIRED');
  }, [remaining]);

  // Ended from the console, revoked, or the admin signed out: the next check notices
  // (a 401 is handled by the API client).
  useEffect(() => {
    const timer = setInterval(() => {
      api
        .request<MeResponse>('/v1/auth/me')
        .then((me) => {
          const store = useImpersonationStore.getState();
          if (!me.impersonation || me.impersonation.endedAt) {
            store.end(me.impersonation?.endedReason ?? 'LOST');
          } else store.update(me.impersonation);
        })
        .catch(() => undefined);
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api]);

  async function endSession() {
    setEnding(true);
    setFailed(false);
    try {
      await api.request('/v1/impersonation/end', { method: 'POST' });
      useImpersonationStore.getState().end('MANUAL');
    } catch (error) {
      // Already gone on the server: the tab ends too.
      if (error instanceof ApiError && error.body.statusCode === 401) {
        useImpersonationStore.getState().end('LOST');
        return;
      }
      setFailed(error instanceof NetworkError || error instanceof ApiError);
      setEnding(false);
    }
  }

  return (
    <View
      role="region"
      aria-label={t('impersonation.banner.label')}
      style={[styles.bar, soon && styles.soon, { direction }]}
      testID="impersonation-banner"
    >
      <View style={styles.row}>
        <Text style={[styles.strong, styles.grow]} numberOfLines={2}>
          {t('impersonation.banner.actingAs', {
            name: info.target.fullName,
            role: t(`roles.${info.target.role}`),
          })}
        </Text>
        {info.writesEnabled ? null : (
          <View style={styles.chip} testID="impersonation-view-only">
            <Text style={styles.chipText}>{t('impersonation.banner.viewOnly')}</Text>
          </View>
        )}
      </View>
      <View style={styles.row}>
        <Text style={[styles.text, styles.grow]}>
          {t('impersonation.banner.by', { name: info.actor.fullName })}
        </Text>
        <Text style={styles.text}>
          {t('impersonation.banner.remaining')}{' '}
          <Text style={[styles.strong, styles.ltr]} testID="impersonation-remaining">
            {formatCountdown(remaining)}
          </Text>
        </Text>
        {confirming ? (
          <View style={styles.row}>
            <BarButton
              label={t('impersonation.banner.confirmEnd')}
              onPress={() => void endSession()}
              disabled={ending}
              strong
              testID="impersonation-end-confirm"
            />
            <BarButton
              label={t('common.cancel')}
              onPress={() => setConfirming(false)}
              disabled={ending}
            />
          </View>
        ) : (
          <BarButton
            label={t('impersonation.banner.end')}
            onPress={() => setConfirming(true)}
            strong
            testID="impersonation-end"
          />
        )}
      </View>
      {failed ? (
        <Text role="alert" style={styles.text}>
          {t('impersonation.banner.endFailed')}
        </Text>
      ) : null}
      <Text aria-live="polite" style={styles.hidden}>
        {announcement}
      </Text>
    </View>
  );
}

function BarButton({
  label,
  onPress,
  disabled,
  strong,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  strong?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={Boolean(disabled)}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, strong && styles.buttonStrong, disabled && styles.disabled]}
      testID={testID}
    >
      <Text style={[styles.buttonText, strong && styles.buttonTextStrong]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Dark amber/red with white text: AA contrast, distinct from every normal screen.
  bar: {
    backgroundColor: '#78350f',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  soon: { backgroundColor: '#991b1b' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  grow: { flexGrow: 1, flexShrink: 1 },
  text: { color: '#ffffff', fontSize: 14 },
  strong: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  ltr: { writingDirection: 'ltr' },
  chip: {
    backgroundColor: '#ffffff',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { color: '#78350f', fontSize: 13, fontWeight: '700' },
  button: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#ffffff',
  },
  buttonStrong: { backgroundColor: '#ffffff' },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  buttonTextStrong: { color: '#7f1d1d' },
  disabled: { opacity: 0.6 },
  // Visually hidden, still read by screen readers.
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0,
  },
});
