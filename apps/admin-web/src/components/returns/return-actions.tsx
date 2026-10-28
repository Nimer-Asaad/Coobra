'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DriverOption, ShipmentReturnInfo } from '@coobra/shared';
import {
  Amount,
  InlineAction,
  StatusPill,
  useFieldError,
  useFinanceAction,
} from '@/components/finance/common';
import { FormField } from '@/components/form-field';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** Return details plus the actions the viewer may take (approve with driver, fee decisions). */
export function ReturnInfoBlock({
  shipmentId,
  shipmentStatus,
  info,
  canApprove,
  canDecideFee,
  invalidate,
}: {
  shipmentId: string;
  shipmentStatus: string;
  info: ShipmentReturnInfo;
  canApprove: boolean;
  canDecideFee: boolean;
  invalidate: string[][];
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const drivers = useQuery({
    queryKey: ['admin', 'drivers', ''],
    queryFn: () => bff<DriverOption[]>('/v1/admin/drivers'),
    enabled: canApprove,
  });
  const approve = useFinanceAction(
    (body: object) =>
      bff(`/v1/admin/shipments/${shipmentId}/return/approve`, { method: 'POST', body }),
    invalidate,
  );
  const setFee = useFinanceAction(
    (body: object) => bff(`/v1/admin/returns/${shipmentId}/fee`, { method: 'POST', body }),
    invalidate,
  );
  const waive = useFinanceAction(
    (body: object) => bff(`/v1/admin/returns/${shipmentId}/waive`, { method: 'POST', body }),
    invalidate,
  );
  const feeError = useFieldError(setFee.error);
  const waiveError = useFieldError(waive.error);
  const feeOpen = info.feeStatus === 'RETURN_FEE_UNCONFIGURED' || info.feeStatus === 'SET';
  const tone = info.feeStatus === 'RETURN_FEE_UNCONFIGURED' ? 'bad' : info.closedAt ? 'ok' : 'warn';

  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('returns.requestReason')}</dt>
          <dd>{info.requestReason ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('returns.requested')}</dt>
          <dd>
            {formatDateTime(info.requestedAt, lang)}
            {info.requestedBy ? ` · ${info.requestedBy.fullName}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('returns.returnDriver')}</dt>
          <dd>
            {info.returnDriver?.fullName ?? (info.approvedAt ? t('returns.officePickup') : '—')}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('returns.fee')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <StatusPill tone={tone}>{t(`returns.feeStatus.${info.feeStatus}`)}</StatusPill>
            {info.feeAmount !== null ? <Amount value={info.feeAmount} /> : null}
            {info.feeReason ? (
              <span className="text-muted-foreground">{info.feeReason}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('returns.policy')}</dt>
          <dd>{t(`pricing.returnPolicies.${info.feePolicy}`)}</dd>
        </div>
        {info.deliveryCharge !== '0.00' ? (
          <div>
            <dt className="text-muted-foreground">{t('returns.deliveryCharge')}</dt>
            <dd>
              <Amount value={info.deliveryCharge} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted-foreground">{t('returns.totalCharge')}</dt>
          <dd className="font-medium">
            {info.totalCharge !== null ? <Amount value={info.totalCharge} /> : '—'}
          </dd>
        </div>
        {info.completedAt ? (
          <div>
            <dt className="text-muted-foreground">{t('returns.completed')}</dt>
            <dd>{formatDateTime(info.completedAt, lang)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {canApprove &&
        (shipmentStatus === 'RETURN_REQUESTED' || shipmentStatus === 'RETURN_APPROVED') ? (
          <InlineAction
            label={
              shipmentStatus === 'RETURN_APPROVED'
                ? t('returns.changeDriver')
                : t('returns.approve')
            }
            variant={shipmentStatus === 'RETURN_APPROVED' ? 'outline' : 'default'}
            pending={approve.isPending}
            error={approve.error}
            onSubmit={(form) =>
              approve.mutateAsync({
                driverId: text(form, 'driverId') || undefined,
                note: text(form, 'note') || undefined,
              })
            }
          >
            <NativeSelect
              name="driverId"
              defaultValue={info.returnDriver?.id ?? ''}
              aria-label={t('returns.returnDriver')}
            >
              <option value="">{t('returns.officePickup')}</option>
              {drivers.data?.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.fullName}
                </option>
              ))}
            </NativeSelect>
            <FormField name="note" label={t('finance.note')} />
          </InlineAction>
        ) : null}
        {canDecideFee && feeOpen ? (
          <>
            <InlineAction
              label={t('returns.setFee')}
              pending={setFee.isPending}
              error={setFee.error}
              onSubmit={(form) =>
                setFee.mutateAsync({ amount: text(form, 'amount'), reason: text(form, 'reason') })
              }
            >
              <FormField
                name="amount"
                dir="ltr"
                inputMode="decimal"
                label={t('finance.amount')}
                defaultValue={info.feeAmount ?? ''}
              />
              {feeError('amount')}
              <FormField name="reason" label={t('finance.reason')} />
              {feeError('reason')}
            </InlineAction>
            <InlineAction
              label={t('returns.waive')}
              pending={waive.isPending}
              error={waive.error}
              onSubmit={(form) => waive.mutateAsync({ reason: text(form, 'reason') })}
            >
              <p className="text-xs text-muted-foreground">{t('returns.waiveHint')}</p>
              <FormField name="reason" label={t('finance.reason')} />
              {waiveError('reason')}
            </InlineAction>
          </>
        ) : null}
      </div>
    </div>
  );
}
