'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createZoneKindSchema,
  createZoneSchema,
  type CreateZoneInput,
  type CreateZoneKindInput,
  type UpdateZoneInput,
  type ZoneItem,
  type ZoneKindItem,
} from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { useFormErrors } from '@/lib/use-form-errors';
import { cn } from '@/lib/utils';
import { zoneOptions } from '@/lib/zones';
import { useAdminZones, ZoneSelect } from './zone-select';

export function ZonesPanel({ canManage }: { canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const zones = useAdminZones();
  const kinds = useQuery({
    queryKey: ['admin', 'zone-kinds'],
    queryFn: () => bff<ZoneKindItem[]>('/v1/admin/zone-kinds'),
  });
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin', 'zones'] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateZoneInput }) =>
      bff<ZoneItem>(`/v1/admin/zones/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setMessage(t('zones.updated'));
      refresh();
    },
  });

  const byId = new Map((zones.data ?? []).map((zone) => [zone.id, zone]));
  const kindName = (id: string) => {
    const kind = kinds.data?.find((item) => item.id === id);
    return kind ? (i18n.language === 'ar' ? kind.nameAr : kind.nameEn) : '';
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('zones.title')}</h1>
      {message ? <Alert variant="success">{message}</Alert> : null}
      <ErrorAlert error={update.error} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card className="order-2 lg:order-1">
          <CardContent className="pt-6">
            {zones.isPending ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : zones.isError ? (
              <ErrorAlert error={zones.error} />
            ) : zones.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('zones.empty')}</p>
            ) : (
              <ul className="divide-y">
                {zoneOptions(zones.data, i18n.language).map((option) => {
                  const zone = byId.get(option.id);
                  if (!zone) return null;
                  return (
                    <ZoneRow
                      key={zone.id}
                      zone={zone}
                      depth={option.depth}
                      kind={kindName(zone.kindId)}
                      effectiveActive={option.active}
                      canManage={canManage}
                      pending={update.isPending}
                      onUpdate={(body) => update.mutate({ id: zone.id, body })}
                    />
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        {canManage ? (
          <div className="order-1 flex flex-col gap-6 lg:order-2">
            <CreateZoneForm
              kinds={kinds.data ?? []}
              onCreated={() => {
                setMessage(t('zones.created'));
                refresh();
              }}
            />
            <KindsCard kinds={kinds.data ?? []} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ZoneRow({
  zone,
  depth,
  kind,
  effectiveActive,
  canManage,
  pending,
  onUpdate,
}: {
  zone: ZoneItem;
  depth: number;
  kind: string;
  effectiveActive: boolean;
  canManage: boolean;
  pending: boolean;
  onUpdate: (body: UpdateZoneInput) => void;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex flex-col gap-2 py-2.5" style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={cn('min-w-0', !effectiveActive && 'text-muted-foreground')}>
          <span className="font-medium">{i18n.language === 'ar' ? zone.nameAr : zone.nameEn}</span>{' '}
          <span className="text-xs text-muted-foreground">
            {kind} ·{' '}
            <span dir="ltr" className="font-mono">
              {zone.code}
            </span>
          </span>
          {!zone.active ? (
            <span className="ms-2 rounded bg-muted px-1.5 text-xs">{t('zones.inactive')}</span>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {t('zones.rename')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onUpdate({ active: !zone.active })}
            >
              {zone.active ? t('zones.deactivate') : t('zones.activate')}
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onUpdate({
              nameAr: String(form.get('nameAr') ?? '').trim(),
              nameEn: String(form.get('nameEn') ?? '').trim(),
            });
            setEditing(false);
          }}
        >
          <Input
            name="nameAr"
            defaultValue={zone.nameAr}
            aria-label={t('zones.nameAr')}
            className="w-48"
          />
          <Input
            name="nameEn"
            defaultValue={zone.nameEn}
            aria-label={t('zones.nameEn')}
            className="w-48"
            dir="ltr"
          />
          <Button size="sm" type="submit">
            {t('common.save')}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function CreateZoneForm({ kinds, onCreated }: { kinds: ZoneKindItem[]; onCreated: () => void }) {
  const { t, i18n } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const create = useMutation({
    mutationFn: (body: CreateZoneInput) =>
      bff<ZoneItem>('/v1/admin/zones', { method: 'POST', body }),
    onSuccess: () => {
      formRef.current?.reset();
      onCreated();
    },
    onError: applyApiError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('zones.addZone')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const parentId = String(form.get('parentId') ?? '');
            const values = validate(createZoneSchema, {
              code: form.get('code'),
              kindId: form.get('kindId'),
              parentId: parentId || undefined,
              nameAr: form.get('nameAr'),
              nameEn: form.get('nameEn'),
              sortOrder: form.get('sortOrder') || 0,
            });
            if (values) create.mutate(values);
          }}
        >
          <ErrorAlert error={create.error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="parentId">{t('zones.parent')}</Label>
            <ZoneSelect
              id="parentId"
              name="parentId"
              placeholder={t('zones.noParent')}
              allowInactive
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="kindId">{t('zones.kind')}</Label>
            <NativeSelect id="kindId" name="kindId" defaultValue="">
              <option value="" disabled>
                {t('zones.kind')}
              </option>
              {kinds.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {i18n.language === 'ar' ? kind.nameAr : kind.nameEn}
                </option>
              ))}
            </NativeSelect>
          </div>
          <FormField name="nameAr" label={t('zones.nameAr')} error={fieldErrors.nameAr} />
          <FormField name="nameEn" dir="ltr" label={t('zones.nameEn')} error={fieldErrors.nameEn} />
          <FormField
            name="code"
            dir="ltr"
            label={t('zones.code')}
            hint={t('zones.codeHint')}
            error={fieldErrors.code ?? fieldErrors.kindId ?? fieldErrors.parentId}
          />
          <FormField name="sortOrder" type="number" min={0} label={t('zones.sortOrder')} />
          <Button type="submit" disabled={create.isPending}>
            {t('zones.addZone')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function KindsCard({ kinds }: { kinds: ZoneKindItem[] }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const create = useMutation({
    mutationFn: (body: CreateZoneKindInput) =>
      bff<ZoneKindItem>('/v1/admin/zone-kinds', { method: 'POST', body }),
    onSuccess: () => {
      formRef.current?.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'zone-kinds'] });
    },
    onError: applyApiError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('zones.kinds')}</CardTitle>
        <CardDescription>
          {kinds.map((kind) => (i18n.language === 'ar' ? kind.nameAr : kind.nameEn)).join(' · ')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const values = validate(createZoneKindSchema, {
              code: form.get('code'),
              nameAr: form.get('nameAr'),
              nameEn: form.get('nameEn'),
              sortOrder: kinds.length,
            });
            if (values) create.mutate(values);
          }}
        >
          <ErrorAlert error={create.error} />
          <FormField name="nameAr" label={t('zones.nameAr')} error={fieldErrors.nameAr} />
          <FormField name="nameEn" dir="ltr" label={t('zones.nameEn')} error={fieldErrors.nameEn} />
          <FormField name="code" dir="ltr" label={t('zones.code')} error={fieldErrors.code} />
          <Button type="submit" variant="outline" disabled={create.isPending}>
            {t('zones.addKind')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
