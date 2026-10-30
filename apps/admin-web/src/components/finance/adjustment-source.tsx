'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ADJUSTMENT_SOURCE_TYPES,
  type AdjustmentItem,
  type AdjustmentSourceType,
  type Paginated,
  type ShipmentListItem,
} from '@coobra/shared';
import { FormField } from '@/components/form-field';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff, ClientApiError } from '@/lib/api-client';
import { useFinanceAction } from './common';

const SHIPMENT_SOURCES: AdjustmentSourceType[] = ['SHIPMENT_FEE', 'RETURN_CHARGE', 'COD_SHORTFALL'];

/**
 * What the adjustment corrects (ADR 0003 §10.4). Linking it lets the API refuse a reviewer who
 * was involved in that shipment or posting; an unlinked one needs a reviewer who never acted as
 * the merchant.
 */
export function AdjustmentSourceFields({ error }: { error: (name: string) => ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const [type, setType] = useState<AdjustmentSourceType>('UNLINKED');
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t('finance.provenance.label')}</Label>
        <NativeSelect
          id={id}
          name="sourceType"
          value={type}
          onChange={(event) => setType(event.target.value as AdjustmentSourceType)}
        >
          {ADJUSTMENT_SOURCE_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`finance.provenance.types.${value}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error('sourceType')}
      {SHIPMENT_SOURCES.includes(type) ? (
        <>
          <FormField
            name="sourceTracking"
            dir="ltr"
            autoComplete="off"
            label={t('finance.provenance.tracking')}
            placeholder="CB-12345678"
          />
          {error('sourceShipmentId')}
        </>
      ) : type === 'JOURNAL_ENTRY' ? (
        <>
          <FormField
            name="sourceJournalEntryId"
            dir="ltr"
            autoComplete="off"
            label={t('finance.provenance.journalEntry')}
            hint={t('finance.provenance.journalEntryHint')}
          />
          {error('sourceJournalEntryId')}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('finance.provenance.unlinkedNote')}</p>
      )}
    </>
  );
}

const sourceError = (field: string): ClientApiError =>
  new ClientApiError({
    statusCode: 400,
    code: 'VALIDATION_FAILED',
    message: 'Invalid adjustment source',
    fieldErrors: { [field]: 'validation.finance.adjustmentSource' },
  });

export interface AdjustmentRequest {
  type: string;
  merchantId: string;
  amount: string;
  reason: string;
  sourceType: string;
  sourceTracking: string;
  sourceJournalEntryId: string;
}

/** Finds the merchant's shipment by tracking number, then requests the adjustment. */
export function useRequestAdjustment() {
  return useFinanceAction(async (input: AdjustmentRequest) => {
    const { sourceTracking, sourceJournalEntryId, ...base } = input;
    const body: Record<string, string> = { ...base };
    if (SHIPMENT_SOURCES.includes(input.sourceType as AdjustmentSourceType)) {
      const tracking = sourceTracking.toUpperCase();
      if (!tracking || !input.merchantId) throw sourceError('sourceShipmentId');
      const query = new URLSearchParams({
        q: tracking,
        merchantId: input.merchantId,
        pageSize: '5',
      });
      const found = await bff<Paginated<ShipmentListItem>>(`/v1/admin/shipments?${query}`);
      const shipment = found.items.find((item) => item.trackingNumber === tracking);
      if (!shipment) throw sourceError('sourceShipmentId');
      body.sourceShipmentId = shipment.id;
    } else if (input.sourceType === 'JOURNAL_ENTRY') {
      if (!sourceJournalEntryId) throw sourceError('sourceJournalEntryId');
      body.sourceJournalEntryId = sourceJournalEntryId;
    }
    return bff<AdjustmentItem>('/v1/admin/finance/adjustments', { method: 'POST', body });
  });
}

/** "Linked to: Shipment fee · CB-…" in the review list. */
export function AdjustmentSourceLabel({ item }: { item: AdjustmentItem }) {
  const { t } = useTranslation();
  const detail = item.sourceShipment?.trackingNumber ?? item.sourceJournalEntryId;
  return (
    <p className="text-xs text-muted-foreground">
      {t('finance.provenance.linkedTo')}{' '}
      <span
        className={item.sourceType === 'UNLINKED' ? 'font-medium text-amber-800' : 'font-medium'}
      >
        {t(`finance.provenance.types.${item.sourceType}`)}
      </span>
      {detail ? (
        <>
          {' · '}
          <span dir="ltr" className="font-mono">
            {detail}
          </span>
        </>
      ) : null}
    </p>
  );
}
