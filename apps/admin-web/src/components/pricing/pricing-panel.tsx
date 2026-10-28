'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminQuoteRequestSchema,
  createPricingRuleSchema,
  RETURN_FEE_POLICIES,
  revisePricingRuleSchema,
  type AdminQuoteRequestInput,
  type CreatePricingRuleInput,
  type MerchantOption,
  type PickupZoneRequestItem,
  type PricingQuote,
  type PricingRuleItem,
  type ReturnFeePolicy,
  type RevisePricingRuleInput,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { useAdminZones, ZoneSelect } from '@/components/zones/zone-select';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useFormErrors } from '@/lib/use-form-errors';
import { zoneOptions, zoneText } from '@/lib/zones';

const RULES_KEY = ['admin', 'pricing-rules'];

function useMerchants() {
  return useQuery({
    queryKey: ['admin', 'merchants', ''],
    queryFn: () => bff<MerchantOption[]>('/v1/admin/merchants'),
  });
}

export function PricingPanel({
  canManageRules,
  canSetPickup,
}: {
  canManageRules: boolean;
  canSetPickup: boolean;
}) {
  const { t } = useTranslation();
  const [showInactive, setShowInactive] = useState(false);
  const rules = useQuery({
    queryKey: [...RULES_KEY, showInactive],
    queryFn: () =>
      bff<PricingRuleItem[]>(`/v1/admin/pricing-rules?includeInactive=${showInactive}`),
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('pricing.title')}</h1>
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <Card className="order-2 lg:order-1">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>{t('pricing.rules')}</CardTitle>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
              {t('pricing.showInactive')}
            </label>
          </CardHeader>
          <CardContent>
            {rules.isPending ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : rules.isError ? (
              <ErrorAlert error={rules.error} />
            ) : rules.data.length === 0 ? (
              <Alert>{t('pricing.empty')}</Alert>
            ) : (
              <ul className="divide-y">
                {rules.data.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} canManage={canManageRules} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="order-1 flex flex-col gap-6 lg:order-2">
          {canManageRules ? <CreateRuleForm /> : null}
          <QuoteCalculator />
          {canSetPickup ? <PickupZoneRequests /> : null}
          {canSetPickup ? <PickupZoneForm /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Return charge policy with its failed-attempt fee (shown only for the policy that uses it).
 * Submitted as `returnPolicy` and `attemptFee`.
 */
export function ReturnPolicyFields({
  idPrefix,
  defaultPolicy = 'RETURN_ONLY',
  defaultAttemptFee,
  errors,
}: {
  idPrefix: string;
  defaultPolicy?: ReturnFeePolicy;
  defaultAttemptFee?: string | null;
  errors: Record<string, string | undefined>;
}) {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<ReturnFeePolicy>(defaultPolicy);
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-return-policy`}>{t('pricing.returnPolicy')}</Label>
        <NativeSelect
          id={`${idPrefix}-return-policy`}
          name="returnPolicy"
          value={policy}
          onChange={(event) => setPolicy(event.target.value as ReturnFeePolicy)}
        >
          {RETURN_FEE_POLICIES.map((value) => (
            <option key={value} value={value}>
              {t(`pricing.returnPolicies.${value}`)}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">{t('pricing.returnPolicyHint')}</p>
        {errors.returnPolicy ? (
          <p className="text-sm text-destructive">{translateValidation(t, errors.returnPolicy)}</p>
        ) : null}
      </div>
      {policy === 'REDUCED_ATTEMPT_PLUS_RETURN' ? (
        <FormField
          name="attemptFee"
          dir="ltr"
          inputMode="decimal"
          defaultValue={defaultAttemptFee ?? ''}
          label={t('pricing.attemptFee')}
          hint={t('pricing.attemptFeeHint')}
          error={errors.attemptFee}
        />
      ) : null}
    </>
  );
}

/** Reads the policy fields; the attempt fee is sent only with the policy that uses it. */
function policyValues(form: FormData) {
  const returnPolicy = String(form.get('returnPolicy') ?? 'RETURN_ONLY');
  return {
    returnPolicy,
    attemptFee: returnPolicy === 'REDUCED_ATTEMPT_PLUS_RETURN' ? form.get('attemptFee') : undefined,
  };
}

function RuleRow({ rule, canManage }: { rule: PricingRuleItem; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [revising, setRevising] = useState(false);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const lang = i18n.language;
  const done = () => void queryClient.invalidateQueries({ queryKey: RULES_KEY });
  const revise = useMutation({
    mutationFn: (body: RevisePricingRuleInput) =>
      bff(`/v1/admin/pricing-rules/${rule.id}/revise`, { method: 'POST', body }),
    onSuccess: () => {
      setRevising(false);
      done();
    },
    onError: applyApiError,
  });
  const deactivate = useMutation({
    mutationFn: () => bff(`/v1/admin/pricing-rules/${rule.id}/deactivate`, { method: 'POST' }),
    onSuccess: done,
  });

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {rule.isFallback
              ? t('pricing.fallback')
              : `${zoneText(rule.originZone, lang)} ${lang === 'ar' ? '←' : '→'} ${zoneText(rule.destinationZone, lang)}`}
          </p>
          <p className="text-muted-foreground">
            {rule.merchant
              ? `${t('pricing.merchantRule')}: ${rule.merchant.businessName}`
              : t('pricing.general')}
            {' · '}
            {t('pricing.version', { version: rule.version })}
            {rule.priority ? ` · ${t('pricing.priority')} ${rule.priority}` : ''}
            {' · '}
            {formatDateTime(rule.effectiveFrom, lang)}
            {rule.active ? '' : ` · ${t('zones.inactive')}`}
          </p>
          {rule.note ? <p className="text-muted-foreground">{rule.note}</p> : null}
        </div>
        <div className="text-end text-sm">
          <p className="font-semibold">{formatMoney(rule.deliveryFee, lang)}</p>
          <p className="text-muted-foreground">
            {t('pricing.returnFeeShort')}:{' '}
            {rule.returnFee ? formatMoney(rule.returnFee, lang) : t('pricing.returnFeeUnset')}
          </p>
          <p className="text-muted-foreground">
            {t(`pricing.returnPolicies.${rule.returnPolicy}`)}
            {rule.attemptFee ? ` · ${formatMoney(rule.attemptFee, lang)}` : ''}
          </p>
        </div>
      </div>
      {canManage && rule.active ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setRevising((value) => !value)}>
            {t('pricing.revise')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={deactivate.isPending}
            onClick={() => deactivate.mutate()}
          >
            {t('pricing.deactivate')}
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={deactivate.error} />
      {revising ? (
        <form
          noValidate
          className="grid gap-2 rounded-md border p-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const values = validate(revisePricingRuleSchema, {
              deliveryFee: form.get('deliveryFee'),
              returnFee: form.get('returnFee'),
              ...policyValues(form),
              priority: form.get('priority') || 0,
            });
            if (values) revise.mutate(values);
          }}
        >
          <FormField
            name="deliveryFee"
            dir="ltr"
            inputMode="decimal"
            defaultValue={rule.deliveryFee}
            label={t('pricing.deliveryFee')}
            error={fieldErrors.deliveryFee}
          />
          <FormField
            name="returnFee"
            dir="ltr"
            inputMode="decimal"
            defaultValue={rule.returnFee ?? ''}
            label={t('pricing.returnFee')}
            error={fieldErrors.returnFee}
          />
          <FormField
            name="priority"
            type="number"
            defaultValue={rule.priority}
            label={t('pricing.priority')}
          />
          <div className="flex flex-col gap-2 sm:col-span-3">
            <ReturnPolicyFields
              idPrefix={`revise-${rule.id}`}
              defaultPolicy={rule.returnPolicy}
              defaultAttemptFee={rule.attemptFee}
              errors={fieldErrors}
            />
          </div>
          <div className="sm:col-span-3">
            <ErrorAlert error={revise.error} />
            <Button type="submit" size="sm" disabled={revise.isPending}>
              {t('pricing.reviseSubmit')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function CreateRuleForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const merchants = useMerchants();
  const [fallback, setFallback] = useState(false);
  // Remounts the policy fields after a successful create (form.reset() misses React state).
  const [formKey, setFormKey] = useState(0);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const create = useMutation({
    mutationFn: (body: CreatePricingRuleInput) =>
      bff('/v1/admin/pricing-rules', { method: 'POST', body }),
    onSuccess: () => {
      formRef.current?.reset();
      setFallback(false);
      setFormKey((key) => key + 1);
      void queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: applyApiError,
  });
  const fieldError = (name: string) =>
    fieldErrors[name] ? (
      <p className="text-sm text-destructive">{translateValidation(t, fieldErrors[name])}</p>
    ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.addRule')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const get = (key: string) => String(form.get(key) ?? '') || undefined;
            const values = validate(createPricingRuleSchema, {
              merchantId: get('merchantId'),
              isFallback: fallback,
              originZoneId: fallback ? undefined : get('originZoneId'),
              destinationZoneId: fallback ? undefined : get('destinationZoneId'),
              deliveryFee: form.get('deliveryFee'),
              returnFee: form.get('returnFee'),
              ...policyValues(form),
              priority: form.get('priority') || 0,
              note: get('note'),
            });
            if (values) create.mutate(values);
          }}
        >
          {create.isSuccess ? <Alert variant="success">{t('pricing.created')}</Alert> : null}
          <ErrorAlert error={create.error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-merchant">{t('shipments.fields.merchant')}</Label>
            <NativeSelect id="rule-merchant" name="merchantId" defaultValue="">
              <option value="">{t('pricing.general')}</option>
              {merchants.data?.map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {merchant.businessName}
                </option>
              ))}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fallback}
              onChange={(event) => setFallback(event.target.checked)}
            />
            {t('pricing.fallback')}
          </label>
          {!fallback ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-origin">{t('pricing.origin')}</Label>
                <ZoneSelect id="rule-origin" name="originZoneId" placeholder={t('zones.choose')} />
                {fieldError('originZoneId')}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-destination">{t('pricing.destination')}</Label>
                <ZoneSelect
                  id="rule-destination"
                  name="destinationZoneId"
                  placeholder={t('zones.choose')}
                />
                {fieldError('destinationZoneId')}
              </div>
            </>
          ) : null}
          <FormField
            name="deliveryFee"
            dir="ltr"
            inputMode="decimal"
            label={t('pricing.deliveryFee')}
            error={fieldErrors.deliveryFee}
          />
          <FormField
            name="returnFee"
            dir="ltr"
            inputMode="decimal"
            label={t('pricing.returnFee')}
            hint={t('pricing.returnFeeHint')}
            error={fieldErrors.returnFee}
          />
          <ReturnPolicyFields key={formKey} idPrefix="rule" errors={fieldErrors} />
          <FormField name="priority" type="number" defaultValue={0} label={t('pricing.priority')} />
          <FormField name="note" label={t('pricing.note')} />
          {fieldError('isFallback')}
          <Button type="submit" disabled={create.isPending}>
            {t('pricing.addRule')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function QuoteCalculator() {
  const { t, i18n } = useTranslation();
  const merchants = useMerchants();
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const quote = useMutation({
    mutationFn: (body: AdminQuoteRequestInput) =>
      bff<PricingQuote>('/v1/admin/pricing/quote', { method: 'POST', body }),
    onError: applyApiError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.quoteTitle')}</CardTitle>
        <CardDescription>{t('pricing.pickupHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const values = validate(adminQuoteRequestSchema, {
              merchantId: form.get('merchantId'),
              originZoneId: String(form.get('originZoneId') ?? '') || undefined,
              destinationZoneId: form.get('destinationZoneId'),
            });
            if (values) quote.mutate(values);
          }}
        >
          <NativeSelect
            name="merchantId"
            defaultValue=""
            aria-label={t('shipments.fields.merchant')}
          >
            <option value="" disabled>
              {t('shipments.fields.chooseMerchant')}
            </option>
            {merchants.data?.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.businessName}
              </option>
            ))}
          </NativeSelect>
          {fieldErrors.merchantId ? (
            <p className="text-sm text-destructive">
              {translateValidation(t, fieldErrors.merchantId)}
            </p>
          ) : null}
          <ZoneSelect
            name="originZoneId"
            placeholder={t('shipments.fields.originDefault')}
            aria-label={t('pricing.origin')}
          />
          <ZoneSelect
            name="destinationZoneId"
            placeholder={t('zones.choose')}
            aria-label={t('pricing.destination')}
          />
          <ErrorAlert error={quote.error} />
          {quote.data ? (
            <Alert variant="success">
              <p className="text-lg font-semibold">
                {formatMoney(quote.data.finalFee, i18n.language)}
              </p>
              <p>{t(`pricing.source.${quote.data.source}`)}</p>
              <p className="text-xs">
                {zoneText(quote.data.origin, i18n.language)} {i18n.language === 'ar' ? '←' : '→'}{' '}
                {zoneText(quote.data.destination, i18n.language)}
              </p>
            </Alert>
          ) : null}
          <Button type="submit" variant="outline" disabled={quote.isPending}>
            {t('pricing.quoteSubmit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PickupZoneForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const merchants = useMerchants();
  const [merchantId, setMerchantId] = useState('');
  const save = useMutation({
    mutationFn: (zoneId: string) =>
      bff(`/v1/admin/merchants/${merchantId}/pickup-zone`, { method: 'PUT', body: { zoneId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'merchants'] }),
  });
  const current = merchants.data?.find((merchant) => merchant.id === merchantId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.pickupTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const zoneId = String(new FormData(event.currentTarget).get('zoneId') ?? '');
            if (merchantId && zoneId) save.mutate(zoneId);
          }}
        >
          <NativeSelect
            value={merchantId}
            onChange={(event) => {
              setMerchantId(event.target.value);
              save.reset();
            }}
            aria-label={t('shipments.fields.merchant')}
          >
            <option value="" disabled>
              {t('shipments.fields.chooseMerchant')}
            </option>
            {merchants.data?.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.businessName}
                {merchant.pickupZoneId ? '' : ` — ${t('pricing.pickupMissing')}`}
              </option>
            ))}
          </NativeSelect>
          <ZoneSelect
            key={`${merchantId}-${current?.pickupZoneId ?? ''}`}
            name="zoneId"
            defaultValue={current?.pickupZoneId ?? ''}
            placeholder={t('zones.choose')}
            aria-label={t('pricing.pickupTitle')}
          />
          {save.isSuccess ? <Alert variant="success">{t('pricing.pickupSaved')}</Alert> : null}
          <ErrorAlert error={save.error} />
          <Button type="submit" variant="outline" disabled={!merchantId || save.isPending}>
            {t('common.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const PICKUP_REQUESTS_KEY = ['admin', 'pickup-zone-requests'];

/** Merchant requests to change their pickup area; prices only move once one is approved here. */
function PickupZoneRequests() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const zones = useAdminZones();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const requests = useQuery({
    queryKey: PICKUP_REQUESTS_KEY,
    queryFn: () => bff<PickupZoneRequestItem[]>('/v1/admin/pickup-zone-requests'),
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => {
      const note = notes[id]?.trim();
      return bff<PickupZoneRequestItem>(
        `/v1/admin/pickup-zone-requests/${id}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', body: note ? { note } : {} },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REQUESTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'merchants'] });
    },
  });
  const paths = new Map(
    zoneOptions(zones.data ?? [], i18n.language).map((option) => [option.id, option.path]),
  );
  const pathOf = (id: string | null) => (id ? (paths.get(id) ?? id) : t('pricing.pickupNone'));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.pickupRequestsTitle')}</CardTitle>
        <CardDescription>{t('pricing.pickupHint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {requests.isPending ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : requests.isError ? (
          <ErrorAlert error={requests.error} />
        ) : requests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pricing.pickupRequestsEmpty')}</p>
        ) : (
          <ul className="divide-y">
            {requests.data.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <p className="font-medium">{item.merchant.businessName}</p>
                <p className="text-sm">
                  {t('pricing.pickupFrom')}: {pathOf(item.previousZoneId)}
                  <br />
                  {t('pricing.pickupTo')}: <strong>{pathOf(item.requestedZoneId)}</strong>
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(item.createdAt, i18n.language)}
                </p>
                <Input
                  value={notes[item.id] ?? ''}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                  placeholder={t('pricing.pickupDecisionNote')}
                  aria-label={t('pricing.pickupDecisionNote')}
                  maxLength={500}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: item.id, approve: true })}
                  >
                    {t('pricing.pickupApprove')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: item.id, approve: false })}
                  >
                    {t('pricing.pickupReject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorAlert error={decide.error} />
      </CardContent>
    </Card>
  );
}
