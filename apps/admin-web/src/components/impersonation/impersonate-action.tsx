'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IMPERSONATION_TARGET_ROLES,
  type ImpersonationTargetRole,
  type UserDetails,
} from '@coobra/shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StartImpersonationDialog } from './start-impersonation-dialog';
import { useActiveImpersonations } from './use-impersonations';

export type ImpersonationAppUrls = Record<ImpersonationTargetRole, string | null>;

const isTarget = (role: string): role is ImpersonationTargetRole =>
  (IMPERSONATION_TARGET_ROLES as readonly string[]).includes(role);

/**
 * "Act as this account" on a merchant's or driver's page, for SUPER_ADMINs. When it is not
 * possible the button stays visible but disabled, with the reason next to it.
 */
export function ImpersonateAction({
  user,
  currentUserId,
  appUrls,
}: {
  user: UserDetails;
  currentUserId: string;
  appUrls: ImpersonationAppUrls;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const active = useActiveImpersonations(isTarget(user.role));
  if (!isTarget(user.role)) {
    return (
      <p className="text-sm text-muted-foreground">{t('impersonation.admin.unavailable.staff')}</p>
    );
  }
  const appUrl = appUrls[user.role];
  const items = active.data?.items ?? [];
  const blocked =
    user.status !== 'ACTIVE'
      ? 'inactive'
      : !appUrl
        ? 'notConfigured'
        : items.some((item) => item.actor.id === currentUserId)
          ? 'youAreActive'
          : items.some((item) => item.target.id === user.id)
            ? 'targetActive'
            : null;
  const reasonId = `impersonate-blocked-${user.id}`;

  return (
    <div className="flex flex-col gap-2">
      {started ? (
        <Alert variant="success" role="status">
          {t('impersonation.admin.started', { name: user.fullName })}
        </Alert>
      ) : null}
      <Button
        variant="outline"
        disabled={Boolean(blocked) || active.isPending}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => {
          setStarted(false);
          setOpen(true);
        }}
      >
        {t('impersonation.admin.start')}
      </Button>
      {blocked ? (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {t(`impersonation.admin.unavailable.${blocked}`)}
        </p>
      ) : null}
      {open && appUrl ? (
        <StartImpersonationDialog
          target={{ id: user.id, fullName: user.fullName, role: user.role }}
          appUrl={appUrl}
          onClose={() => setOpen(false)}
          onStarted={() => {
            setOpen(false);
            setStarted(true);
          }}
        />
      ) : null}
    </div>
  );
}
