import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createShipmentSchema, zoneOptions } from '@coobra/shared';
import { ApiError } from '../api-client';
import { useFormErrors } from '../form-errors';
import { useSessionStore } from '../state/session-store';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { useDirection } from '../ui/use-direction';
import { useCreateShipment, usePickupZone, useQuote, useRequestPickupZone, useZones } from './api';
import { ChoiceField, Section } from './components';
import { formatDateTime, formatMoney } from './format';

const EMPTY = {
  recipientName: '',
  recipientPhone: '',
  recipientPhoneAlt: '',
  city: '',
  addressLine: '',
  landmark: '',
  recipientNotes: '',
  merchantNotes: '',
  codAmount: '',
};

/**
 * Merchant shipment entry, optimised for adding several shipments in a row. The delivery fee
 * comes from a server quote that is re-checked when the shipment is created.
 */
export function CreateShipmentScreen() {
  const { t } = useTranslation();
  const { language } = useDirection();
  const pickupZoneId = useSessionStore((state) => state.user?.merchant?.pickupZoneId ?? null);
  const [form, setForm] = useState(EMPTY);
  const [destinationZoneId, setDestinationZoneId] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const zones = useZones();
  const quote = useQuote();
  const create = useCreateShipment();
  // Refreshes the approved zone (staff may have approved a request since sign-in).
  const pickup = usePickupZone();
  const requestPickup = useRequestPickupZone();
  const options = zoneOptions(zones.data ?? [], language)
    .filter((option) => option.active)
    .map((option) => ({ value: option.id, label: option.path }));
  const update = (key: keyof typeof EMPTY) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const requestQuote = quote.mutate;
  useEffect(() => {
    if (destinationZoneId && pickupZoneId) requestQuote({ destinationZoneId });
  }, [destinationZoneId, pickupZoneId, requestQuote]);

  function submit(addAnother: boolean) {
    // The previous "created" notice belongs to the previous shipment.
    setCreated(null);
    const values = validate(createShipmentSchema, {
      ...form,
      destinationZoneId,
      quoteId: quote.data?.quoteId ?? undefined,
    });
    if (!values) return;
    create.mutate(values, {
      onError: (error) => {
        applyApiError(error);
        // The price moved or the quote expired: fetch a fresh one for the merchant to confirm.
        if (
          error instanceof ApiError &&
          ['PRICE_CHANGED', 'QUOTE_INVALID'].includes(error.body.code) &&
          destinationZoneId
        ) {
          requestQuote({ destinationZoneId });
        }
      },
      onSuccess: (shipment) => {
        if (addAnother) {
          // Keep the area and city: consecutive shipments often go to the same place.
          setForm((current) => ({ ...EMPTY, city: current.city }));
          setCreated(shipment.trackingNumber);
          requestQuote({ destinationZoneId });
        } else {
          router.replace({ pathname: '/shipments/[id]', params: { id: shipment.id } });
        }
      },
    });
  }

  if (!pickupZoneId) {
    const pending = pickup.data?.pending;
    return (
      <Screen>
        {pending ? (
          <Banner
            tone="info"
            message={`${t('pricing.pickupAwaiting')} ${t('pricing.pickupPending', {
              zone: options.find((option) => option.value === pending.requestedZoneId)?.label ?? '',
            })}`}
          />
        ) : (
          <>
            <Banner message={t('errors.ORIGIN_ZONE_REQUIRED')} />
            <ChoiceField
              label={t('pricing.pickupTitle')}
              placeholder={t('zones.choose')}
              searchPlaceholder={t('zones.search')}
              options={options}
              value=""
              onChange={(zoneId) => requestPickup.mutate(zoneId)}
              testID="pickup-zone"
            />
            <AppText variant="muted">{t('pricing.pickupHint')}</AppText>
          </>
        )}
        <ErrorBanner error={requestPickup.error ?? pickup.error ?? zones.error} />
      </Screen>
    );
  }

  return (
    <Screen>
      {created ? (
        <Banner tone="success" message={t('shipments.created', { tracking: created })} />
      ) : null}
      <ErrorBanner error={create.error} />
      <TextField
        label={t('shipments.fields.recipientName')}
        value={form.recipientName}
        onChangeText={update('recipientName')}
        error={fieldErrors.recipientName}
        testID="shipment-recipientName"
      />
      <TextField
        label={t('shipments.fields.recipientPhone')}
        value={form.recipientPhone}
        onChangeText={update('recipientPhone')}
        keyboardType="phone-pad"
        forceLtr
        hint={t('shipments.hints.phone')}
        error={fieldErrors.recipientPhone}
        testID="shipment-recipientPhone"
      />
      <TextField
        label={t('shipments.fields.recipientPhoneAlt')}
        value={form.recipientPhoneAlt}
        onChangeText={update('recipientPhoneAlt')}
        keyboardType="phone-pad"
        forceLtr
        error={fieldErrors.recipientPhoneAlt}
      />
      <ChoiceField
        label={t('shipments.fields.destinationZone')}
        placeholder={t('zones.choose')}
        searchPlaceholder={t('zones.search')}
        options={options}
        value={destinationZoneId}
        onChange={setDestinationZoneId}
        error={fieldErrors.destinationZoneId}
        testID="shipment-destination"
      />
      <Section>
        <AppText variant="label">{t('pricing.estimated')}</AppText>
        {!destinationZoneId ? (
          <AppText variant="muted">{t('pricing.chooseDestination')}</AppText>
        ) : quote.isPending ? (
          <AppText variant="muted">{t('pricing.calculating')}</AppText>
        ) : quote.data ? (
          <>
            <AppText variant="title" testID="quote-fee">
              {formatMoney(quote.data.finalFee, language)}
            </AppText>
            {quote.data.expiresAt ? (
              <AppText variant="muted">
                {t('pricing.estimatedHint', {
                  time: formatDateTime(quote.data.expiresAt, language),
                })}
              </AppText>
            ) : null}
          </>
        ) : (
          <ErrorBanner error={quote.error} />
        )}
      </Section>
      <TextField
        label={t('shipments.fields.city')}
        value={form.city}
        onChangeText={update('city')}
        error={fieldErrors.city}
        testID="shipment-city"
      />
      <TextField
        label={t('shipments.fields.addressLine')}
        value={form.addressLine}
        onChangeText={update('addressLine')}
        multiline
        error={fieldErrors.addressLine}
        testID="shipment-addressLine"
      />
      <TextField
        label={t('shipments.fields.landmark')}
        value={form.landmark}
        onChangeText={update('landmark')}
        error={fieldErrors.landmark}
      />
      <TextField
        label={t('shipments.fields.codAmount')}
        value={form.codAmount}
        onChangeText={update('codAmount')}
        keyboardType="decimal-pad"
        forceLtr
        hint={t('shipments.hints.codAmount')}
        error={fieldErrors.codAmount}
        testID="shipment-codAmount"
      />
      <TextField
        label={t('shipments.fields.recipientNotes')}
        value={form.recipientNotes}
        onChangeText={update('recipientNotes')}
        multiline
        error={fieldErrors.recipientNotes}
      />
      <TextField
        label={t('shipments.fields.merchantNotes')}
        value={form.merchantNotes}
        onChangeText={update('merchantNotes')}
        multiline
        error={fieldErrors.merchantNotes}
      />
      <AppButton
        title={t('shipments.createSubmit')}
        onPress={() => submit(false)}
        loading={create.isPending}
        disabled={!quote.data}
        testID="shipment-submit"
      />
      <AppButton
        variant="outline"
        title={t('shipments.createAnother')}
        onPress={() => submit(true)}
        disabled={create.isPending || !quote.data}
        testID="shipment-submit-another"
      />
    </Screen>
  );
}
