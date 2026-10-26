'use client';

import { useQuery } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { ZoneItem } from '@coobra/shared';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { zoneOptions } from '@/lib/zones';

/** All zones (including inactive) for the admin console, cached across pages. */
export function useAdminZones() {
  return useQuery({
    queryKey: ['admin', 'zones'],
    queryFn: () => bff<ZoneItem[]>('/v1/admin/zones'),
  });
}

/** Zone picker with indented "Parent / Child" labels; inactive zones are disabled. */
export function ZoneSelect({
  placeholder,
  allowInactive = false,
  ...props
}: ComponentProps<'select'> & { placeholder: string; allowInactive?: boolean }) {
  const { i18n } = useTranslation();
  const zones = useAdminZones();
  const options = zoneOptions(zones.data ?? [], i18n.language);
  return (
    <NativeSelect {...props}>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id} disabled={!allowInactive && !option.active}>
          {option.path}
        </option>
      ))}
    </NativeSelect>
  );
}
