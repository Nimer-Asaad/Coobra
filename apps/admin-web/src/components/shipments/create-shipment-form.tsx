'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminCreateShipmentSchema,
  type AdminCreateShipmentInput,
  type MerchantOption,
  type PricingQuote,
  type ShipmentDetails,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ZoneSelect } from '@/components/zones/zone-select';
import { bff } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useFormErrors } from '@/lib/use-form-errors';
import { zoneText } from '@/lib/zones';

function useDebounced(value: string, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function CreateShipmentForm() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const [merchant, setMerchant] = useState<MerchantOption | null>(null);
  const [merchantQuery, setMerchantQuery] = useState('');
  const debouncedQuery = useDebounced(merchantQuery);
  const addAnother = useRef(false);
  const [lastCreated, setLastCreated] = useState<ShipmentDetails | null>(null);
  const [route, setRoute] = useState({ originZoneId: '', destinationZoneId: '' });

  // Live price preview; the server re-prices on creation anyway.
  const preview = useQuery({
    queryKey: ['admin', 'quote', merchant?.id, route.originZoneId, route.destinationZoneId],
    queryFn: () =>
      bff<PricingQuote>('/v1/admin/pricing/quote', {
        method: 'POST',
        body: {
          merchantId: merchant?.id,
          destinationZoneId: route.destinationZoneId,
          originZoneId: route.originZoneId || undefined,
        },
      }),
    enabled: Boolean(merchant && route.destinationZoneId),
    retry: false,
  });

  const merchants = useQuery({
    queryKey: ['admin', 'merchants', debouncedQuery],
    queryFn: () =>
      bff<MerchantOption[]>(`/v1/admin/merchants?q=${encodeURIComponent(debouncedQuery)}`),
    enabled: !merchant,
  });

  const create = useMutation({
    mutationFn: (body: AdminCreateShipmentInput) =>
      bff<ShipmentDetails>('/v1/admin/shipments', { method: 'POST', body }),
    onSuccess: (shipment) => {
      if (addAnother.current) {
        // Keep the merchant selected for fast consecutive entry.
        formRef.current?.reset();
        setRoute({ originZoneId: '', destinationZoneId: '' });
        setLastCreated(shipment);
        formRef.current?.querySelector<HTMLInputElement>('[name="recipientName"]')?.focus();
      } else {
        router.push(`/shipments/${shipment.id}`);
      }
    },
    onError: applyApiError,
  });

  const field = (name: string) => fieldErrors[name];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('shipments.createTitle')}</h1>
        <Button variant="ghost" asChild>
          <Link href="/shipments">{t('shipments.details.back')}</Link>
        </Button>
      </div>

      {lastCreated ? (
        <Alert variant="success">
          {t('shipments.created', { tracking: lastCreated.trackingNumber })}{' '}
          <Link className="font-medium underline" href={`/shipments/${lastCreated.id}`}>
            {t('shipments.view')}
          </Link>
        </Alert>
      ) : null}
      <ErrorAlert error={create.error} />

      <Card>
        <CardHeader>
          <CardTitle>{t('shipments.fields.merchant')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {merchant ? (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="font-medium">{merchant.businessName}</p>
                <p className="text-sm text-muted-foreground">
                  {merchant.fullName} · <span dir="ltr">{merchant.phone ?? merchant.email}</span>
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setMerchant(null)}>
                {t('shipments.fields.chooseMerchant')}
              </Button>
            </div>
          ) : (
            <>
              <Input
                type="search"
                value={merchantQuery}
                onChange={(event) => setMerchantQuery(event.target.value)}
                placeholder={t('shipments.fields.searchMerchant')}
                aria-label={t('shipments.fields.searchMerchant')}
                aria-invalid={Boolean(field('merchantId'))}
              />
              {field('merchantId') ? (
                <p className="text-sm text-destructive">
                  {translateValidation(t, field('merchantId'))}
                </p>
              ) : null}
              <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
                {merchants.data?.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-start hover:bg-muted"
                      onClick={() => setMerchant(option)}
                    >
                      <span className="font-medium">{option.businessName}</span>{' '}
                      <span className="text-sm text-muted-foreground">
                        {option.fullName} · <span dir="ltr">{option.phone ?? option.email}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {merchants.data?.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-muted-foreground">
                    {t('shipments.noResults')}
                  </li>
                ) : null}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <form
            ref={formRef}
            noValidate
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const get = (key: string) => String(form.get(key) ?? '');
              const values = validate(adminCreateShipmentSchema, {
                merchantId: merchant?.id ?? '',
                recipientName: get('recipientName'),
                recipientPhone: get('recipientPhone'),
                recipientPhoneAlt: get('recipientPhoneAlt'),
                destinationZoneId: get('destinationZoneId'),
                originZoneId: get('originZoneId') || undefined,
                city: get('city'),
                addressLine: get('addressLine'),
                landmark: get('landmark'),
                recipientNotes: get('recipientNotes'),
                merchantNotes: get('merchantNotes'),
                codAmount: get('codAmount'),
                manualFee: get('manualFee'),
                manualFeeReason: get('manualFeeReason'),
              });
              if (values) create.mutate(values);
            }}
          >
            <FormField
              name="recipientName"
              label={t('shipments.fields.recipientName')}
              error={field('recipientName')}
              autoComplete="off"
            />
            <FormField
              name="recipientPhone"
              type="tel"
              dir="ltr"
              label={t('shipments.fields.recipientPhone')}
              hint={t('shipments.hints.phone')}
              error={field('recipientPhone')}
            />
            <FormField
              name="recipientPhoneAlt"
              type="tel"
              dir="ltr"
              label={t('shipments.fields.recipientPhoneAlt')}
              error={field('recipientPhoneAlt')}
            />
            <div className="flex flex-col gap-2">
              <Label htmlFor="destinationZoneId">{t('shipments.fields.destinationZone')}</Label>
              <ZoneSelect
                id="destinationZoneId"
                name="destinationZoneId"
                placeholder={t('zones.choose')}
                aria-invalid={Boolean(field('destinationZoneId'))}
                onChange={(event) =>
                  setRoute((current) => ({ ...current, destinationZoneId: event.target.value }))
                }
              />
              {field('destinationZoneId') ? (
                <p className="text-sm text-destructive">
                  {translateValidation(t, field('destinationZoneId'))}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="originZoneId">{t('shipments.fields.originZone')}</Label>
              <ZoneSelect
                id="originZoneId"
                name="originZoneId"
                placeholder={t('shipments.fields.originDefault')}
                onChange={(event) =>
                  setRoute((current) => ({ ...current, originZoneId: event.target.value }))
                }
              />
            </div>
            <div className="sm:col-span-2">
              {!merchant || !route.destinationZoneId ? (
                <p className="text-sm text-muted-foreground">{t('pricing.chooseDestination')}</p>
              ) : preview.isFetching ? (
                <p className="text-sm text-muted-foreground">{t('pricing.calculating')}</p>
              ) : preview.data ? (
                <Alert variant="success">
                  {t('pricing.estimated')}:{' '}
                  <strong>{formatMoney(preview.data.finalFee, i18n.language)}</strong> ·{' '}
                  {t(`pricing.source.${preview.data.source}`)} ·{' '}
                  {zoneText(preview.data.origin, i18n.language)}{' '}
                  {i18n.language === 'ar' ? '←' : '→'}{' '}
                  {zoneText(preview.data.destination, i18n.language)}
                </Alert>
              ) : (
                <ErrorAlert error={preview.error} />
              )}
            </div>
            <FormField name="city" label={t('shipments.fields.city')} error={field('city')} />
            <FormField
              name="landmark"
              label={t('shipments.fields.landmark')}
              error={field('landmark')}
            />
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="addressLine">{t('shipments.fields.addressLine')}</Label>
              <Textarea
                id="addressLine"
                name="addressLine"
                rows={2}
                aria-invalid={Boolean(field('addressLine'))}
              />
              {field('addressLine') ? (
                <p className="text-sm text-destructive">
                  {translateValidation(t, field('addressLine'))}
                </p>
              ) : null}
            </div>
            <FormField
              name="codAmount"
              inputMode="decimal"
              dir="ltr"
              label={t('shipments.fields.codAmount')}
              hint={t('shipments.hints.codAmount')}
              error={field('codAmount')}
            />
            <FormField
              name="manualFee"
              inputMode="decimal"
              dir="ltr"
              label={t('pricing.manualFee')}
              hint={t('pricing.manualFeeHint')}
              error={field('manualFee')}
            />
            <FormField
              name="manualFeeReason"
              label={t('pricing.manualFeeReason')}
              error={field('manualFeeReason')}
            />
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="recipientNotes">{t('shipments.fields.recipientNotes')}</Label>
              <Textarea id="recipientNotes" name="recipientNotes" rows={2} />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="merchantNotes">{t('shipments.fields.merchantNotes')}</Label>
              <Textarea id="merchantNotes" name="merchantNotes" rows={2} />
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button
                type="submit"
                disabled={create.isPending}
                onClick={() => (addAnother.current = false)}
              >
                {t('shipments.createSubmit')}
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={create.isPending}
                onClick={() => (addAnother.current = true)}
              >
                {t('shipments.createAnother')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
