'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { USER_ROLES, type AuditLogDetails, type AuditValue } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { bff } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { AUDIT_KEY } from './keys';

/** The value the API puts in place of a withheld field. */
const REDACTED = '[redacted]';
const ROLE_FIELDS = new Set(['role', 'submittedByRole']);
const STATUS_FIELDS = new Set(['status', 'fromStatus', 'toStatus']);
const TIME_FIELDS = new Set(['submittedAt', 'decidedAt']);

/** Renders one (already redacted) value for people: translated where we know the vocabulary. */
export function formatAuditValue(
  field: string,
  value: AuditValue,
  t: TFunction,
  language: string,
): string {
  if (value === null || value === '') return '–';
  if (value === REDACTED) return t('audit.redactedValue');
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (ROLE_FIELDS.has(field) && (USER_ROLES as readonly string[]).includes(value)) {
      return t(`roles.${value}`);
    }
    if (STATUS_FIELDS.has(field)) return t(`shipmentStatus.${value}`, { defaultValue: value });
    if (TIME_FIELDS.has(field) && !Number.isNaN(Date.parse(value))) {
      return formatDateTime(value, language);
    }
    if (field === 'language') return value === 'ar' ? t('language.arabic') : t('language.english');
    return value;
  }
  return JSON.stringify(value);
}

/** The impersonation an entry belongs to: done during it, or its own start/end event. */
function impersonationOf(entry: AuditLogDetails): string | null {
  return entry.impersonationId ?? (entry.entity?.type === 'IMPERSONATION' ? entry.entity.id : null);
}

export function AuditEntryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const entry = useQuery({
    queryKey: [...AUDIT_KEY, 'entry', id],
    queryFn: () => bff<AuditLogDetails>(`/v1/admin/audit-logs/${id}`),
  });
  const data = entry.data;
  const fieldLabel = (field: string) => t(`audit.fields.${field}`, { defaultValue: field });
  const show = (field: string, value: AuditValue) =>
    formatAuditValue(field, value, t, i18n.language);

  return (
    <Dialog
      open
      title={
        data
          ? t(`audit.actions.${data.action}`, { defaultValue: data.action })
          : t('audit.detailsTitle')
      }
      description={data ? formatDateTime(data.createdAt, i18n.language) : undefined}
      onClose={onClose}
      className="max-w-2xl"
    >
      {entry.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('common.loading')}
        </p>
      ) : entry.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorAlert error={entry.error} />
          <Button variant="outline" onClick={() => void entry.refetch()}>
            {t('audit.retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5 text-sm">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label={t('audit.category')}>{t(`audit.categories.${data!.category}`)}</Item>
            <Item label={t('audit.actor')}>
              {data!.actor
                ? `${data!.actor.fullName} · ${t(`roles.${data!.actor.role}`)}`
                : t('audit.system')}
              {data!.effectiveUser ? (
                <span className="block font-medium text-amber-800">
                  {t('audit.actingAsRole', {
                    name: data!.effectiveUser.fullName,
                    role: t(`roles.${data!.effectiveUser.role}`),
                  })}
                </span>
              ) : null}
            </Item>
            <Item label={t('audit.target')}>
              {data!.targetUser
                ? `${data!.targetUser.fullName} · ${t(`roles.${data!.targetUser.role}`)}`
                : '–'}
            </Item>
            <Item label={t('audit.record')}>
              {data!.entity ? (
                <>
                  {t(`audit.entities.${data!.entity.type}`)}{' '}
                  <span className="font-mono text-xs break-all" dir="ltr">
                    {data!.entity.id}
                  </span>
                </>
              ) : (
                '–'
              )}
            </Item>
            {impersonationOf(data!) ? (
              <Item label={t('audit.impersonation')}>
                <Link
                  className="text-primary hover:underline"
                  href={`/audit?impersonationId=${impersonationOf(data!)}`}
                  onClick={onClose}
                >
                  {t('audit.viewImpersonation')}
                </Link>
              </Item>
            ) : null}
          </dl>

          {data!.changes.length ? (
            <section aria-labelledby="audit-changes">
              <h3 id="audit-changes" className="mb-2 font-semibold">
                {t('audit.changes')}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem]">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-1.5 text-start font-medium" scope="col">
                        <span className="sr-only">{t('audit.otherDetails')}</span>
                      </th>
                      <th className="py-1.5 text-start font-medium" scope="col">
                        {t('audit.before')}
                      </th>
                      <th className="py-1.5 text-start font-medium" scope="col">
                        {t('audit.after')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data!.changes.map((change) => (
                      <tr key={change.field}>
                        <th scope="row" className="py-1.5 pe-3 text-start font-medium">
                          {fieldLabel(change.field)}
                        </th>
                        <td className="py-1.5 pe-3 break-words text-muted-foreground">
                          {show(change.field, change.before)}
                        </td>
                        <td className="py-1.5 break-words">{show(change.field, change.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section aria-labelledby="audit-details">
            <h3 id="audit-details" className="mb-2 font-semibold">
              {t('audit.otherDetails')}
            </h3>
            {Object.keys(data!.details).length ? (
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {Object.entries(data!.details).map(([field, value]) => (
                  <Item key={field} label={fieldLabel(field)}>
                    <span className="break-words">{show(field, value)}</span>
                  </Item>
                ))}
              </dl>
            ) : (
              <p className="text-muted-foreground">{t('audit.noDetails')}</p>
            )}
          </section>

          {data!.redacted.length ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t('audit.redactedNote', { fields: data!.redacted.join(', ') })}
            </p>
          ) : null}

          <section aria-labelledby="audit-request">
            <h3 id="audit-request" className="mb-2 font-semibold">
              {t('audit.request')}
            </h3>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <Item label={t('audit.ipAddress')}>
                <span dir="ltr">{data!.ipAddress ?? '–'}</span>
              </Item>
              <Item label={t('audit.userAgent')}>
                <span className="break-words" dir="ltr">
                  {data!.userAgent ?? '–'}
                </span>
              </Item>
              <Item label={t('audit.entryId')}>
                <span className="font-mono text-xs break-all" dir="ltr">
                  {data!.id}
                </span>
              </Item>
            </dl>
          </section>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>
          {t('audit.close')}
        </Button>
      </div>
    </Dialog>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
