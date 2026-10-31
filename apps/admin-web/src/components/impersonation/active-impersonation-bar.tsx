'use client';

import { useTranslation } from 'react-i18next';
import type { ImpersonationInfo } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { Button } from '@/components/ui/button';
import { formatCountdown } from '@/lib/format';
import { useActiveImpersonations, useEndImpersonation, useRemaining } from './use-impersonations';

/**
 * Shown on every console page while this admin is acting as an account in another tab: who,
 * how long is left (server time), and End. Ending here also logs the app tab out.
 */
export function ActiveImpersonationBar({ currentUserId }: { currentUserId: string }) {
  const active = useActiveImpersonations();
  const mine = active.data?.items.find((item) => item.actor.id === currentUserId);
  if (!mine || !active.data) return null;
  return <Bar info={mine} receivedAt={active.data.receivedAt} />;
}

function Bar({ info, receivedAt }: { info: ImpersonationInfo; receivedAt: number }) {
  const { t } = useTranslation();
  const end = useEndImpersonation();
  const remaining = useRemaining(info, receivedAt);
  if (remaining <= 0) return null;
  const soon = remaining <= 5 * 60_000;
  return (
    <section
      aria-label={t('impersonation.admin.bar.label')}
      className={`border-b ${soon ? 'bg-amber-100 text-amber-950' : 'bg-amber-50 text-amber-950'}`}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <p className="font-medium">
          {t('impersonation.admin.bar.actingAs', {
            name: info.target.fullName,
            role: t(`roles.${info.target.role}`),
          })}
        </p>
        <p>
          {t('impersonation.admin.bar.remaining')}{' '}
          <span dir="ltr" className="font-semibold tabular-nums">
            {formatCountdown(remaining)}
          </span>
        </p>
        <Button
          size="sm"
          variant="destructive"
          className="ms-auto"
          disabled={end.isPending}
          onClick={() => end.mutate(info.id)}
        >
          {t('impersonation.banner.end')}
        </Button>
        {end.error ? <ErrorAlert error={end.error} /> : null}
      </div>
    </section>
  );
}
