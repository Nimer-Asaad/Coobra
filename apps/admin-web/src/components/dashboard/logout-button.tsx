'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { clientFetch } from '@/lib/api-client';

export function LogoutButton() {
  const { t } = useTranslation();
  const router = useRouter();
  const logout = useMutation({
    mutationFn: () => clientFetch('/api/session/logout', { method: 'POST' }),
    onSettled: () => {
      router.replace('/login');
      router.refresh();
    },
  });
  return (
    <Button variant="outline" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
      {t('auth.logout')}
    </Button>
  );
}
