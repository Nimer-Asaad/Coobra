'use client';

import { useTranslation } from 'react-i18next';
import type { UserStatus } from '@coobra/shared';
import { cn } from '@/lib/utils';

export function UserStatusBadge({ status }: { status: UserStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-xs font-medium',
        status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
      )}
    >
      {status === 'ACTIVE' ? t('users.statusActive') : t('users.statusDisabled')}
    </span>
  );
}
