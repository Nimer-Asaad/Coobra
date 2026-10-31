'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IMPERSONATION_TARGET_ROLES,
  type ImpersonationTargetRole,
  type UserListItem,
} from '@coobra/shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StartImpersonationDialog } from './start-impersonation-dialog';
import { useActiveImpersonations } from './use-impersonations';

export type ImpersonationAppUrls = Record<ImpersonationTargetRole, string | null>;

const isTarget = (role: string): role is ImpersonationTargetRole =>
  (IMPERSONATION_TARGET_ROLES as readonly string[]).includes(role);

/**
 * "Act as this account" for SUPER_ADMINs, on a merchant's or driver's page (`layout="panel"`)
 * or in a row of the users list (`layout="row"`: smaller, named after the account, nothing for
 * staff). When it is not possible the button stays visible but disabled, with the reason next
 * to it. The API checks all of it again when the session starts.
 */
export function ImpersonateAction({
  user,
  currentUserId,
  appUrls,
  layout = 'panel',
}: {
  user: Pick<UserListItem, 'id' | 'fullName' | 'role' | 'status'>;
  currentUserId: string;
  appUrls: ImpersonationAppUrls;
  layout?: 'panel' | 'row';
}) {
  const row = layout === 'row';
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const active = useActiveImpersonations(isTarget(user.role));
  if (!isTarget(user.role)) {
    if (row) return null;
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
    <div className={row ? 'flex max-w-[12rem] flex-col items-start gap-1' : 'flex flex-col gap-2'}>
      {started ? (
        row ? (
          <p role="status" className="text-xs text-emerald-700">
            {t('impersonation.admin.started', { name: user.fullName })}
          </p>
        ) : (
          <Alert variant="success" role="status">
            {t('impersonation.admin.started', { name: user.fullName })}
          </Alert>
        )
      ) : null}
      <Button
        variant="outline"
        size={row ? 'sm' : undefined}
        disabled={Boolean(blocked) || active.isPending}
        aria-label={row ? t('impersonation.admin.startFor', { name: user.fullName }) : undefined}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => {
          setStarted(false);
          setOpen(true);
        }}
      >
        {t('impersonation.admin.start')}
      </Button>
      {blocked ? (
        <p
          id={reasonId}
          className={row ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}
        >
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
