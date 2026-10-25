import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createShipmentSchema, GOVERNORATES, type Governorate } from '@coobra/shared';
import { useFormErrors } from '../form-errors';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { TextField } from '../ui/text-field';
import { useCreateShipment } from './api';
import { ChoiceField } from './components';

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

/** Merchant shipment entry, optimised for adding several shipments in a row. */
export function CreateShipmentScreen() {
  const { t } = useTranslation();
  const [form, setForm] = useState(EMPTY);
  const [governorate, setGovernorate] = useState<Governorate | ''>('');
  const [created, setCreated] = useState<string | null>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const create = useCreateShipment();
  const update = (key: keyof typeof EMPTY) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  function submit(addAnother: boolean) {
    const values = validate(createShipmentSchema, { ...form, governorate });
    if (!values) return;
    create.mutate(values, {
      onError: applyApiError,
      onSuccess: (shipment) => {
        if (addAnother) {
          // Keep the governorate and city: consecutive shipments often go to the same area.
          setForm((current) => ({ ...EMPTY, city: current.city }));
          setCreated(shipment.trackingNumber);
        } else {
          router.replace({ pathname: '/shipments/[id]', params: { id: shipment.id } });
        }
      },
    });
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
        label={t('shipments.fields.governorate')}
        placeholder={t('shipments.fields.chooseGovernorate')}
        options={GOVERNORATES.map((code) => ({ value: code, label: t(`governorates.${code}`) }))}
        value={governorate}
        onChange={setGovernorate}
        error={fieldErrors.governorate}
        testID="shipment-governorate"
      />
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
        testID="shipment-submit"
      />
      <AppButton
        variant="outline"
        title={t('shipments.createAnother')}
        onPress={() => submit(true)}
        disabled={create.isPending}
        testID="shipment-submit-another"
      />
    </Screen>
  );
}
