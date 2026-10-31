'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  actionsInCategory,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_ENTITY_TYPES,
  type AuditCategory,
  type AuditLogListItem,
  type Paginated,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime, startOfLocalDay, startOfNextLocalDay } from '@/lib/format';
import { AuditEntryDialog } from './audit-entry-dialog';
import { AUDIT_KEY } from './keys';

const PAGE_SIZE = 25;
const FILTER_KEYS = [
  'q',
  'category',
  'action',
  'actorId',
  'entityType',
  'entityId',
  'impersonationId',
  'from',
  'to',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

/** Read-only audit log for super admins: filters live in the URL so a view can be shared. */
export function AuditLogPanel() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | undefined>();
  const [category, setCategory] = useState(params.get('category') ?? '');

  const page = Math.max(1, Number(params.get('page')) || 1);
  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key) ?? '']),
  ) as Filters;

  const apiQuery = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  for (const key of [
    'q',
    'category',
    'action',
    'actorId',
    'entityType',
    'entityId',
    'impersonationId',
  ] as const) {
    if (filters[key]) apiQuery.set(key, filters[key]);
  }
  if (filters.from) apiQuery.set('from', startOfLocalDay(filters.from));
  if (filters.to) apiQuery.set('to', startOfNextLocalDay(filters.to));

  const entries = useQuery({
    queryKey: [...AUDIT_KEY, apiQuery.toString()],
    queryFn: () => bff<Paginated<AuditLogListItem>>(`/v1/admin/audit-logs?${apiQuery}`),
    placeholderData: (previous) => previous,
  });

  function navigate(next: Partial<Filters> & { page?: string }) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    router.replace(query.size ? `${pathname}?${query}` : pathname);
  }

  // The person filter is set from the table; show it (by name when the page has them).
  const actorName = filters.actorId
    ? (entries.data?.items.find((entry) => entry.actor?.id === filters.actorId)?.actor?.fullName ??
      filters.actorId)
    : null;
  const totalPages = entries.data ? Math.max(1, Math.ceil(entries.data.total / PAGE_SIZE)) : 1;
  const hasFilters = FILTER_KEYS.some((key) => filters[key]);
  const actionChoices = category
    ? actionsInCategory(category as AuditCategory)
    : [...AUDIT_ACTIONS];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('audit.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('audit.description')}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            role="search"
            noValidate
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const next = Object.fromEntries(
                FILTER_KEYS.map((key) => [key, String(form.get(key) ?? '').trim()]),
              ) as Filters;
              if (next.from && next.to && next.from > next.to) {
                setDateError('validation.audit.dateRange');
                return;
              }
              setDateError(undefined);
              // An event that is not in the chosen area would match nothing.
              if (next.action && next.category) {
                const inCategory = actionsInCategory(next.category as AuditCategory);
                if (!(inCategory as string[]).includes(next.action)) next.action = '';
              }
              navigate(next);
            }}
            // Re-mount when the URL changes so the inputs show the applied filters.
            key={params.toString()}
          >
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="audit-q">{t('audit.search')}</Label>
              <Input
                id="audit-q"
                name="q"
                type="search"
                maxLength={100}
                defaultValue={filters.q}
                placeholder={t('audit.searchHint')}
                aria-describedby="audit-q-hint"
              />
              <span id="audit-q-hint" className="sr-only">
                {t('audit.searchHint')}
              </span>
            </div>
            <Field id="audit-category" label={t('audit.category')}>
              <NativeSelect
                id="audit-category"
                name="category"
                defaultValue={filters.category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">{t('audit.allCategories')}</option>
                {AUDIT_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`audit.categories.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="audit-action" label={t('audit.action')}>
              <NativeSelect id="audit-action" name="action" defaultValue={filters.action}>
                <option value="">{t('audit.allActions')}</option>
                {actionChoices.map((value) => (
                  <option key={value} value={value}>
                    {t(`audit.actions.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="audit-entity-type" label={t('audit.entityType')}>
              <NativeSelect
                id="audit-entity-type"
                name="entityType"
                defaultValue={filters.entityType}
              >
                <option value="">{t('audit.allEntityTypes')}</option>
                {AUDIT_ENTITY_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`audit.entities.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="audit-entity-id" label={t('audit.entityId')}>
              <Input
                id="audit-entity-id"
                name="entityId"
                dir="ltr"
                maxLength={100}
                defaultValue={filters.entityId}
              />
            </Field>
            <Field id="audit-from" label={t('audit.from')}>
              <Input id="audit-from" name="from" type="date" defaultValue={filters.from} />
            </Field>
            <Field id="audit-to" label={t('audit.to')} error={translateValidation(t, dateError)}>
              <Input
                id="audit-to"
                name="to"
                type="date"
                defaultValue={filters.to}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'audit-to-error' : undefined}
              />
            </Field>
            {/* Set by clicking a person in the table; kept while other filters change. */}
            <input type="hidden" name="actorId" value={filters.actorId} />
            <input type="hidden" name="impersonationId" value={filters.impersonationId} />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit">{t('audit.apply')}</Button>
              {actorName ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t('audit.removeActor', { name: actorName })}
                  onClick={() => navigate({ ...filters, actorId: '', page: '' })}
                >
                  {t('audit.actorChip', { name: actorName })} ✕
                </Button>
              ) : null}
              {filters.impersonationId ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t('audit.removeImpersonation')}
                  onClick={() => navigate({ ...filters, impersonationId: '', page: '' })}
                >
                  {t('audit.impersonationChip')} ✕
                </Button>
              ) : null}
              {hasFilters ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCategory('');
                    setDateError(undefined);
                    navigate({});
                  }}
                >
                  {t('audit.clear')}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {entries.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t('common.loading')}
            </p>
          ) : entries.isError ? (
            <div className="flex flex-col items-start gap-3">
              <ErrorAlert error={entries.error} />
              <Button variant="outline" onClick={() => void entries.refetch()}>
                {t('audit.retry')}
              </Button>
            </div>
          ) : entries.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {hasFilters ? t('audit.noResults') : t('audit.empty')}
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
                {t('audit.results', { count: entries.data.total })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 text-start font-medium">{t('audit.when')}</th>
                      <th className="py-2 text-start font-medium">{t('audit.action')}</th>
                      <th className="py-2 text-start font-medium">{t('audit.actor')}</th>
                      <th className="py-2 text-start font-medium">{t('audit.target')}</th>
                      <th className="py-2 text-start font-medium">{t('audit.record')}</th>
                      <th className="py-2 text-start font-medium">{t('audit.summary')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {entries.data.items.map((entry) => {
                      const time = formatDateTime(entry.createdAt, i18n.language);
                      const label = t(`audit.actions.${entry.action}`, {
                        defaultValue: entry.action,
                      });
                      return (
                        <tr key={entry.id} className="align-top hover:bg-muted/50">
                          <td className="py-2.5 pe-3 whitespace-nowrap text-muted-foreground">
                            {time}
                          </td>
                          <td className="py-2.5 pe-3">
                            <button
                              type="button"
                              className="text-start font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                              aria-label={t('audit.open', { action: label, time })}
                              onClick={() => setOpenId(entry.id)}
                            >
                              {label}
                            </button>
                            <div className="text-xs text-muted-foreground">
                              {t(`audit.categories.${entry.category}`)}
                            </div>
                          </td>
                          <td className="py-2.5 pe-3">
                            {entry.actor ? (
                              <button
                                type="button"
                                className="text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                                title={t('audit.filterByActor', { name: entry.actor.fullName })}
                                onClick={() =>
                                  navigate({ ...filters, actorId: entry.actor!.id, page: '' })
                                }
                              >
                                {entry.actor.fullName}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">{t('audit.system')}</span>
                            )}
                            {entry.actor ? (
                              <div className="text-xs text-muted-foreground">
                                {t(`roles.${entry.actor.role}`)}
                              </div>
                            ) : null}
                            {entry.effectiveUser && entry.impersonationId ? (
                              <button
                                type="button"
                                className="text-start text-xs font-medium text-amber-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                                title={t('audit.filterByImpersonation')}
                                onClick={() =>
                                  navigate({
                                    ...filters,
                                    impersonationId: entry.impersonationId!,
                                    page: '',
                                  })
                                }
                              >
                                {t('audit.actingAs', { name: entry.effectiveUser.fullName })}
                              </button>
                            ) : null}
                          </td>
                          <td className="py-2.5 pe-3">{entry.targetUser?.fullName ?? '–'}</td>
                          <td className="py-2.5 pe-3">
                            {entry.entity ? (
                              <button
                                type="button"
                                className="text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                                title={t('audit.filterByRecord')}
                                onClick={() =>
                                  navigate({
                                    ...filters,
                                    entityType: entry.entity!.type,
                                    entityId: entry.entity!.id,
                                    page: '',
                                  })
                                }
                              >
                                {t(`audit.entities.${entry.entity.type}`)}
                              </button>
                            ) : (
                              '–'
                            )}
                          </td>
                          <td className="max-w-[16rem] truncate py-2.5" title={entry.summary ?? ''}>
                            {entry.summary ?? '–'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => navigate({ ...filters, page: String(page - 1) })}
                >
                  {t('audit.previous')}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t('audit.page', { page, pages: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => navigate({ ...filters, page: String(page + 1) })}
                >
                  {t('audit.next')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {openId ? <AuditEntryDialog id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
