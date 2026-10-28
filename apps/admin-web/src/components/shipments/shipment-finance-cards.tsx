'use client';

import { useTranslation } from 'react-i18next';
import type { ShipmentDetails } from '@coobra/shared';
import {
  Amount,
  InlineAction,
  StatusPill,
  useFieldError,
  useFinanceAction,
} from '@/components/finance/common';
import { FormField } from '@/components/form-field';
import { ReturnInfoBlock } from '@/components/returns/return-actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { bff } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** COD progress, collections and (for finance) the post-delivery fee correction request. */
export function CodCard({
  shipment,
  canCorrectFee,
  queryKey,
}: {
  shipment: ShipmentDetails;
  canCorrectFee: boolean;
  queryKey: string[];
}) {
  const { t, i18n } = useTranslation();
  const cod = shipment.codInfo;
  const correction = useFinanceAction(
    (body: object) =>
      bff(`/v1/admin/finance/shipments/${shipment.id}/fee-correction`, { method: 'POST', body }),
    [queryKey, ['admin', 'finance']],
  );
  const fieldError = useFieldError(correction.error);
  const tone = cod.status === 'PARTIAL' ? 'bad' : cod.status === 'PENDING' ? 'warn' : 'ok';
  const pendingCorrection = shipment.pricing?.overrides.find(
    (override) => override.phase === 'POST_DELIVERY' && override.status === 'PENDING_APPROVAL',
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t('finance.cod.title')}{' '}
          <StatusPill tone={tone}>{t(`finance.cod.status.${cod.status}`)}</StatusPill>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-3 gap-2">
          <div>
            <dt className="text-muted-foreground">{t('finance.expected')}</dt>
            <dd className="font-medium">
              <Amount value={cod.expected} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('finance.collected')}</dt>
            <dd className="font-medium">
              <Amount value={cod.collected} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('finance.outstanding')}</dt>
            <dd className="font-medium">
              <Amount value={cod.outstanding} />
            </dd>
          </div>
        </dl>
        {cod.collections.length > 0 ? (
          <div>
            <p className="mb-1 font-medium">{t('finance.cod.collections')}</p>
            <ul className="flex flex-col gap-1">
              {cod.collections.map((collection) => (
                <li key={collection.id} className="rounded bg-muted px-2 py-1">
                  <Amount value={collection.amount} /> · {collection.driver.fullName} ·{' '}
                  {formatDateTime(collection.recordedAt, i18n.language)}
                  {collection.note ? ` · ${collection.note}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {cod.shortfall ? (
          <p>
            {t('finance.cod.shortfall')}: {t(`finance.shortfallStatus.${cod.shortfall.status}`)}
            {cod.shortfall.resolution
              ? ` · ${t(`finance.resolution.${cod.shortfall.resolution}`)}`
              : ''}
          </p>
        ) : null}
        {pendingCorrection ? (
          <p role="status">
            <StatusPill tone="warn">
              {t('finance.feeCorrectionPending', {
                from: formatMoney(pendingCorrection.previousFee ?? '0', i18n.language),
                to: formatMoney(pendingCorrection.newFee, i18n.language),
              })}
            </StatusPill>
          </p>
        ) : null}
        {canCorrectFee && shipment.status === 'DELIVERED' && !pendingCorrection ? (
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground">{t('finance.feeCorrectionHint')}</p>
            <InlineAction
              label={t('finance.requestFeeCorrection')}
              successMessage={t('finance.feeCorrectionRequested')}
              pending={correction.isPending}
              error={correction.error}
              onSubmit={(form) =>
                correction.mutateAsync({ fee: text(form, 'fee'), reason: text(form, 'reason') })
              }
            >
              <FormField
                name="fee"
                dir="ltr"
                inputMode="decimal"
                label={t('pricing.deliveryFee')}
                defaultValue={shipment.deliveryFee ?? ''}
              />
              {fieldError('fee')}
              <FormField name="reason" label={t('finance.reason')} />
              {fieldError('reason')}
            </InlineAction>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ReturnCard({
  shipment,
  canApprove,
  canDecideFee,
  queryKey,
}: {
  shipment: ShipmentDetails;
  canApprove: boolean;
  canDecideFee: boolean;
  queryKey: string[];
}) {
  const { t } = useTranslation();
  if (!shipment.returnInfo) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('returns.info')}</CardTitle>
        <CardDescription>{t(`shipmentStatus.${shipment.status}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <ReturnInfoBlock
          shipmentId={shipment.id}
          shipmentStatus={shipment.status}
          info={shipment.returnInfo}
          canApprove={canApprove}
          canDecideFee={canDecideFee}
          invalidate={[queryKey, ['admin', 'returns'], ['admin', 'shipments']]}
        />
      </CardContent>
    </Card>
  );
}
