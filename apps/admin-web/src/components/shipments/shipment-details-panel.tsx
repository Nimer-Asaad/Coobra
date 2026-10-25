'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ASSIGNABLE_STATUSES,
  availableShipmentTransitions,
  feeOverrideSchema,
  type DriverOption,
  type FeeOverrideInput,
  type ShipmentDetails,
  type ShipmentStatus,
  type ShipmentTransitionRule,
  type TransitionShipmentRequest,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { bff, ClientApiError } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useFormErrors } from '@/lib/use-form-errors';
import { zoneText } from '@/lib/zones';
import { FormField } from '@/components/form-field';
import { StatusBadge } from './status-badge';

export function ShipmentDetailsPanel({ id, canManage }: { id: string; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const key = ['admin', 'shipments', 'detail', id];
  const shipment = useQuery({
    queryKey: key,
    queryFn: () => bff<ShipmentDetails>(`/v1/admin/shipments/${id}`),
  });

  if (shipment.isPending)
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (shipment.isError) return <ErrorAlert error={shipment.error} />;
  const s = shipment.data;
  const lang = i18n.language;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold" dir="ltr">
            {s.trackingNumber}
          </h1>
          <StatusBadge status={s.status} className="text-sm" />
        </div>
        <Button variant="ghost" asChild>
          <Link href="/shipments">{t('shipments.details.back')}</Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('shipments.details.recipient')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Item label={t('shipments.fields.recipientName')}>{s.recipientName}</Item>
                <Item label={t('shipments.fields.recipientPhone')}>
                  <a href={`tel:${s.recipientPhone}`} dir="ltr" className="text-primary">
                    {s.recipientPhone}
                  </a>
                  {s.recipientPhoneAlt ? (
                    <>
                      {' · '}
                      <a href={`tel:${s.recipientPhoneAlt}`} dir="ltr" className="text-primary">
                        {s.recipientPhoneAlt}
                      </a>
                    </>
                  ) : null}
                </Item>
                <Item label={t('shipments.details.address')}>
                  {zoneText(s.destination, lang) ?? t(`governorates.${s.governorate}`)} — {s.city}
                  <br />
                  {s.addressLine}
                  {s.landmark ? (
                    <span className="block text-muted-foreground">{s.landmark}</span>
                  ) : null}
                </Item>
                <Item label={t('shipments.fields.merchant')}>
                  {s.merchant.businessName}
                  <span className="block text-muted-foreground">
                    {s.merchant.fullName}
                    {s.merchant.phone ? (
                      <>
                        {' · '}
                        <span dir="ltr">{s.merchant.phone}</span>
                      </>
                    ) : null}
                  </span>
                </Item>
                {s.recipientNotes ? (
                  <Item label={t('shipments.details.recipientNotes')}>{s.recipientNotes}</Item>
                ) : null}
                {s.merchantNotes ? (
                  <Item label={t('shipments.details.merchantNotes')}>{s.merchantNotes}</Item>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('shipments.details.payment')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Item label={t('shipments.details.codAmount')}>
                  {formatMoney(s.codAmount, lang, s.currency)}
                </Item>
                <Item label={t('shipments.details.deliveryFee')}>
                  {s.deliveryFee
                    ? formatMoney(s.deliveryFee, lang, s.currency)
                    : t('shipments.fields.deliveryFeePending')}
                </Item>
                {s.cod ? (
                  <Item label={t('shipments.details.cod')}>
                    {s.cod.collected
                      ? t('shipments.details.codCollected', {
                          amount: formatMoney(s.cod.collectedAmount, lang, s.cod.currency),
                          name: s.cod.driver?.fullName ?? '—',
                        })
                      : t('shipments.details.codNotCollected')}
                  </Item>
                ) : null}
                <Item label={t('shipments.fields.deliveryAttempts')}>{s.deliveryAttempts}</Item>
                {s.failureReason ? (
                  <Item label={t('shipments.fields.failureReason')}>{s.failureReason}</Item>
                ) : null}
                {s.returnReason ? (
                  <Item label={t('shipments.fields.returnReason')}>{s.returnReason}</Item>
                ) : null}
                {s.cancellationReason ? (
                  <Item label={t('shipments.fields.cancellationReason')}>
                    {s.cancellationReason}
                  </Item>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <PricingCard shipment={s} canOverride={canManage} queryKey={key} />

          <Card>
            <CardHeader>
              <CardTitle>{t('shipments.details.timeline')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative flex flex-col gap-4 border-s ps-5">
                {[...s.history].reverse().map((entry) => (
                  <li key={entry.id} className="relative">
                    <span className="absolute -start-[1.6rem] top-1.5 size-2.5 rounded-full bg-primary" />
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={entry.toStatus} />
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(entry.createdAt, lang)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm">
                      {entry.driver
                        ? `${t('shipments.details.assignedTo', { name: entry.driver.fullName })} · `
                        : null}
                      {entry.actor
                        ? `${t('shipments.details.by', { name: entry.actor.fullName })} (${t(`roles.${entry.actor.role}`)})`
                        : null}
                    </p>
                    {entry.note ? (
                      <p className="mt-1 rounded bg-muted px-2 py-1 text-sm">{entry.note}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6 text-sm">
              <Item label={t('shipments.fields.driver')}>
                {s.driver ? (
                  <>
                    {s.driver.fullName}
                    {s.driver.phone ? (
                      <span className="block text-muted-foreground" dir="ltr">
                        {s.driver.phone}
                      </span>
                    ) : null}
                  </>
                ) : (
                  t('shipments.fields.unassigned')
                )}
              </Item>
              <Item label={t('shipments.fields.createdAt')}>
                {formatDateTime(s.createdAt, lang)}
              </Item>
              {s.deliveredAt ? (
                <Item label={t('shipments.fields.deliveredAt')}>
                  {formatDateTime(s.deliveredAt, lang)}
                </Item>
              ) : null}
              <Item label={t('shipments.fields.createdBy')}>
                {s.createdBy && s.creatorRole !== 'MERCHANT'
                  ? t('shipments.fields.onBehalf', {
                      name: s.createdBy.fullName,
                      role: t(`roles.${s.creatorRole}`),
                    })
                  : (s.createdBy?.fullName ?? '—')}
              </Item>
            </CardContent>
          </Card>

          {canManage ? (
            <ShipmentActions shipment={s} queryKey={key} />
          ) : (
            <Alert>{t('shipments.actions.readOnly')}</Alert>
          )}
        </div>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function ShipmentActions({
  shipment,
  queryKey,
}: {
  shipment: ShipmentDetails;
  queryKey: string[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const canAssign = (ASSIGNABLE_STATUSES as readonly ShipmentStatus[]).includes(shipment.status);
  const transitions = availableShipmentTransitions(shipment.status, 'STAFF');

  const drivers = useQuery({
    queryKey: ['admin', 'drivers', ''],
    queryFn: () => bff<DriverOption[]>('/v1/admin/drivers'),
    enabled: canAssign,
  });

  function onUpdated(updated: ShipmentDetails, text: string) {
    queryClient.setQueryData(queryKey, updated);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'shipments'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'drivers'] });
    setMessage(text);
  }

  const assign = useMutation({
    mutationFn: (driverId: string) =>
      bff<ShipmentDetails>(`/v1/admin/shipments/${shipment.id}/assign`, {
        method: 'POST',
        body: { driverId },
      }),
    onSuccess: (updated) => onUpdated(updated, t('shipments.actions.assigned')),
  });

  if (!canAssign && transitions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shipments.actions.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {message ? <Alert variant="success">{message}</Alert> : null}
        {canAssign ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const driverId = String(new FormData(event.currentTarget).get('driverId') ?? '');
              if (driverId) assign.mutate(driverId);
            }}
          >
            <Label htmlFor="driverId">
              {shipment.driver ? t('shipments.actions.reassign') : t('shipments.actions.assign')}
            </Label>
            <NativeSelect id="driverId" name="driverId" defaultValue="" required>
              <option value="" disabled>
                {t('shipments.actions.chooseDriver')}
              </option>
              {drivers.data?.map((driver) => (
                <option
                  key={driver.id}
                  value={driver.id}
                  disabled={driver.id === shipment.driver?.id}
                >
                  {driver.fullName} —{' '}
                  {t('shipments.actions.activeCount', { count: driver.activeShipments })}
                </option>
              ))}
            </NativeSelect>
            <ErrorAlert error={assign.error} />
            <Button type="submit" disabled={assign.isPending}>
              {t('shipments.actions.assignSubmit')}
            </Button>
          </form>
        ) : null}
        {transitions.map((rule) => (
          <TransitionForm
            key={rule.to}
            shipment={shipment}
            rule={rule}
            onDone={(updated) => onUpdated(updated, t('shipments.actions.updated'))}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function TransitionForm({
  shipment,
  rule,
  onDone,
}: {
  shipment: ShipmentDetails;
  rule: ShipmentTransitionRule;
  onDone: (updated: ShipmentDetails) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: (body: TransitionShipmentRequest) =>
      bff<ShipmentDetails>(`/v1/admin/shipments/${shipment.id}/transitions`, {
        method: 'POST',
        body,
      }),
    onSuccess: (updated) => {
      setOpen(false);
      setReason('');
      onDone(updated);
    },
  });
  const destructive = rule.to === 'CANCELLED';
  const reasonError =
    mutation.error instanceof ClientApiError ? mutation.error.body.fieldErrors?.reason : undefined;

  if (!open) {
    return (
      <Button variant={destructive ? 'destructive' : 'outline'} onClick={() => setOpen(true)}>
        {t(`shipments.actions.to.${rule.to}`)}
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ toStatus: rule.to, reason: reason.trim() || undefined });
      }}
    >
      <p className="font-medium">{t(`shipments.actions.to.${rule.to}`)}</p>
      {rule.requiresReason ? (
        <>
          <Label htmlFor={`reason-${rule.to}`}>{t('shipments.actions.reason')}</Label>
          <Textarea
            id={`reason-${rule.to}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('shipments.actions.reasonPlaceholder')}
            aria-invalid={Boolean(reasonError)}
            required
            minLength={3}
          />
          {reasonError ? (
            <p className="text-sm text-destructive">{translateValidation(t, reasonError)}</p>
          ) : null}
        </>
      ) : null}
      {reasonError ? null : <ErrorAlert error={mutation.error} />}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant={destructive ? 'destructive' : 'default'}
          disabled={mutation.isPending}
        >
          {t('shipments.actions.confirm')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

const OVERRIDABLE: readonly ShipmentStatus[] = [
  'CREATED',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
];

/** How the fee was priced, every manual change, and the pre-delivery override form. */
function PricingCard({
  shipment,
  canOverride,
  queryKey,
}: {
  shipment: ShipmentDetails;
  canOverride: boolean;
  queryKey: string[];
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const pricing = shipment.pricing;
  const override = useMutation({
    mutationFn: (body: FeeOverrideInput) =>
      bff(`/v1/admin/shipments/${shipment.id}/fee-override`, { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'shipments'] });
    },
    onError: applyApiError,
  });
  const allowed = canOverride && OVERRIDABLE.includes(shipment.status);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Item label={t('pricing.final')}>
            {shipment.deliveryFee
              ? formatMoney(shipment.deliveryFee, lang, shipment.currency)
              : t('shipments.fields.deliveryFeePending')}
          </Item>
          {pricing ? (
            <>
              <Item label={t('pricing.base')}>
                {pricing.baseFee ? formatMoney(pricing.baseFee, lang) : '—'}
                <span className="block text-sm text-muted-foreground">
                  {t(`pricing.source.${pricing.source}`)}
                  {pricing.ruleVersion
                    ? ` · ${t('pricing.version', { version: pricing.ruleVersion })}`
                    : ''}
                </span>
              </Item>
              <Item label={t('pricing.returnFeeShort')}>
                {pricing.returnFee
                  ? formatMoney(pricing.returnFee, lang)
                  : t('pricing.returnFeeUnset')}
              </Item>
              <Item label={t('pricing.origin')}>{zoneText(pricing.origin, lang) ?? '—'}</Item>
            </>
          ) : (
            <Item label={t('pricing.base')}>{t('pricing.source.LEGACY')}</Item>
          )}
        </dl>
        {pricing && pricing.overrides.length > 0 ? (
          <div>
            <p className="mb-2 text-sm font-medium">{t('pricing.overrides')}</p>
            <ul className="flex flex-col gap-2 text-sm">
              {pricing.overrides.map((entry) => (
                <li key={entry.id} className="rounded bg-muted px-3 py-2">
                  {t('pricing.from', {
                    fee: entry.previousFee ? formatMoney(entry.previousFee, lang) : '—',
                    newFee: formatMoney(entry.newFee, lang),
                  })}{' '}
                  · {entry.actor.fullName} ({t(`roles.${entry.actor.role}`)}) ·{' '}
                  {formatDateTime(entry.createdAt, lang)}
                  <span className="block">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {allowed ? (
          open ? (
            <form
              noValidate
              className="flex flex-col gap-3 rounded-md border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const values = validate(feeOverrideSchema, {
                  fee: form.get('fee'),
                  reason: form.get('reason'),
                });
                if (values) override.mutate(values);
              }}
            >
              <p className="text-sm text-muted-foreground">{t('pricing.overrideHint')}</p>
              <FormField
                name="fee"
                dir="ltr"
                inputMode="decimal"
                label={t('pricing.deliveryFee')}
                error={fieldErrors.fee}
              />
              <FormField
                name="reason"
                label={t('pricing.overrideReason')}
                error={fieldErrors.reason}
              />
              {fieldErrors.fee || fieldErrors.reason ? null : <ErrorAlert error={override.error} />}
              <div className="flex gap-2">
                <Button type="submit" disabled={override.isPending}>
                  {t('pricing.overrideSubmit')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
              {t('pricing.override')}
            </Button>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
