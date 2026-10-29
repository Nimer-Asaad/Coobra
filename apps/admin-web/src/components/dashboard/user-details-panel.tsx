'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  changeUserRoleSchema,
  changeUserStatusSchema,
  isRoleChangeable,
  ROLE_CHANGEABLE_ROLES,
  SUPPORTED_LANGUAGES,
  updateUserProfileSchema,
  type UserAuditEntry,
  type UserDetails,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { bff, ClientApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useFormErrors } from '@/lib/use-form-errors';
import { USERS_KEY } from './users-panel';
import { UserStatusBadge } from './user-status-badge';

type DialogKind = 'edit' | 'status' | 'role';
type Notice = 'saved' | 'deactivated' | 'reactivated' | 'roleChanged';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** One user's account, history and the changes a super admin may make to it. */
export function UserDetailsPanel({ id, currentUserId }: { id: string; currentUserId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<DialogKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const key = [...USERS_KEY, 'details', id];

  const user = useQuery({
    queryKey: key,
    queryFn: () => bff<UserDetails>(`/v1/admin/users/${id}`),
  });

  function done(next: UserDetails, message: Notice) {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: USERS_KEY, exact: false });
    setOpen(null);
    setNotice(message);
  }

  if (user.isPending) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (user.isError) return <ErrorAlert error={user.error} />;
  const data = user.data;
  const isSelf = data.id === currentUserId;
  const roleLocked = !isRoleChangeable(data.role);
  const close = () => setOpen(null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/users" className="text-sm text-primary hover:underline">
            {t('users.backToList')}
          </Link>
          <h1 className="truncate text-2xl font-semibold">{data.fullName}</h1>
          <p className="text-sm text-muted-foreground" dir="ltr">
            {data.email}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
            {t(`roles.${data.role}`)}
          </span>
          <UserStatusBadge status={data.status} />
        </div>
      </div>

      {notice ? (
        <Alert variant="success" role="status">
          {t(`users.${notice}`)}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('users.details')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label={t('users.phoneEdit')}>
                {data.phone ? <span dir="ltr">{data.phone}</span> : '–'}
              </Detail>
              <Detail label={t('users.language')}>
                {data.language === 'ar' ? t('language.arabic') : t('language.english')}
              </Detail>
              {data.merchant ? (
                <Detail label={t('users.business')}>{data.merchant.businessName}</Detail>
              ) : null}
              <Detail label={t('users.verified')}>{data.emailVerified ? '✓' : '–'}</Detail>
              <Detail label={t('users.createdAt')}>
                {formatDateTime(data.createdAt, i18n.language)}
              </Detail>
              <Detail label={t('users.createdBy')}>{data.createdBy?.fullName ?? '–'}</Detail>
              <Detail label={t('users.lastSignIn')}>
                {data.lastSignInAt
                  ? formatDateTime(data.lastSignInAt, i18n.language)
                  : t('users.never')}
              </Detail>
              <Detail label={t('users.activeSessions')}>{data.activeSessions}</Detail>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('users.actions')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button variant="outline" onClick={() => setOpen('edit')}>
              {t('users.editProfile')}
            </Button>
            {isSelf ? (
              <p className="text-sm text-muted-foreground">{t('users.selfNote')}</p>
            ) : (
              <>
                {roleLocked ? (
                  <p className="text-sm text-muted-foreground">{t('users.roleLockedNote')}</p>
                ) : (
                  <Button variant="outline" onClick={() => setOpen('role')}>
                    {t('users.changeRole')}
                  </Button>
                )}
                <Button
                  variant={data.status === 'ACTIVE' ? 'destructive' : 'default'}
                  onClick={() => setOpen('status')}
                >
                  {data.status === 'ACTIVE' ? t('users.deactivate') : t('users.reactivate')}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('users.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('users.noHistory')}</p>
          ) : (
            <ol className="divide-y text-sm">
              {data.history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {open === 'edit' ? (
        <EditProfileDialog
          user={data}
          onClose={close}
          onDone={(next) => done(next, 'saved')}
          onStale={() => void user.refetch()}
        />
      ) : null}
      {open === 'status' ? (
        <StatusDialog
          user={data}
          onClose={close}
          onDone={(next) => done(next, next.status === 'ACTIVE' ? 'reactivated' : 'deactivated')}
          onStale={() => void user.refetch()}
        />
      ) : null}
      {open === 'role' ? (
        <RoleDialog
          user={data}
          onClose={close}
          onDone={(next) => done(next, 'roleChanged')}
          onStale={() => void user.refetch()}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function HistoryRow({ entry }: { entry: UserAuditEntry }) {
  const { t, i18n } = useTranslation();
  const meta = entry.metadata ?? {};
  const reason = typeof meta.reason === 'string' ? meta.reason : null;
  const from = typeof meta.from === 'string' ? meta.from : null;
  const to = typeof meta.to === 'string' ? meta.to : null;
  return (
    <li className="flex flex-col gap-0.5 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {t(`users.actionsLabel.${entry.action}`, { defaultValue: entry.action })}
          {from && to ? ` · ${t(`roles.${from}`)} → ${t(`roles.${to}`)}` : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(entry.createdAt, i18n.language)}
        </span>
      </div>
      {entry.actor ? (
        <span className="text-xs text-muted-foreground">
          {t('users.by', { name: entry.actor.fullName })}
        </span>
      ) : null}
      {reason ? <span className="text-muted-foreground">{reason}</span> : null}
    </li>
  );
}

interface DialogProps {
  user: UserDetails;
  onClose: () => void;
  onDone: (next: UserDetails) => void;
  /** Someone else changed the user: reload so the next attempt uses the new version. */
  onStale: () => void;
}

function useUserMutation(path: string, method: 'PATCH' | 'POST', props: DialogProps) {
  const form = useFormErrors();
  const mutation = useMutation({
    mutationFn: (body: object) =>
      bff<UserDetails>(`/v1/admin/users/${props.user.id}${path}`, { method, body }),
    onSuccess: props.onDone,
    onError: (error) => {
      form.applyApiError(error);
      if (error instanceof ClientApiError && error.body.code === 'USER_CHANGED') props.onStale();
    },
  });
  return { ...form, mutation };
}

function DialogButtons({
  pending,
  label,
  destructive,
  onClose,
}: {
  pending: boolean;
  label: string;
  destructive?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" onClick={onClose}>
        {t('users.cancel')}
      </Button>
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
        {label}
      </Button>
    </div>
  );
}

function ReasonField({ error }: { error?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const message = translateValidation(t, error);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t('users.reason')}</Label>
      <Textarea
        id={id}
        name="reason"
        rows={3}
        aria-invalid={Boolean(message)}
        aria-describedby={message ? `${id}-error` : undefined}
      />
      {message ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function EditProfileDialog(props: DialogProps) {
  const { t } = useTranslation();
  const { user, onClose } = props;
  const { fieldErrors, validate, mutation } = useUserMutation('', 'PATCH', props);
  return (
    <Dialog open title={t('users.editTitle', { name: user.fullName })} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const values = validate(updateUserProfileSchema, {
            fullName: text(form, 'fullName'),
            phone: text(form, 'phone'),
            language: form.get('language'),
            ...(user.merchant ? { businessName: text(form, 'businessName') } : {}),
            expectedUpdatedAt: user.updatedAt,
          });
          if (values) mutation.mutate(values);
        }}
      >
        <ErrorAlert error={mutation.error} />
        <FormField
          name="fullName"
          label={t('users.fullName')}
          defaultValue={user.fullName}
          error={fieldErrors.fullName}
        />
        <FormField
          name="phone"
          type="tel"
          dir="ltr"
          label={t('users.phoneEdit')}
          defaultValue={user.phone ?? ''}
          error={fieldErrors.phone}
        />
        {user.merchant ? (
          <FormField
            name="businessName"
            label={t('users.businessName')}
            defaultValue={user.merchant.businessName}
            error={fieldErrors.businessName}
          />
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-language">{t('users.language')}</Label>
          <NativeSelect id="edit-language" name="language" defaultValue={user.language}>
            {SUPPORTED_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language === 'ar' ? t('language.arabic') : t('language.english')}
              </option>
            ))}
          </NativeSelect>
        </div>
        <DialogButtons pending={mutation.isPending} label={t('users.save')} onClose={onClose} />
      </form>
    </Dialog>
  );
}

function StatusDialog(props: DialogProps) {
  const { t } = useTranslation();
  const { user, onClose } = props;
  const deactivating = user.status === 'ACTIVE';
  const { fieldErrors, validate, mutation } = useUserMutation(
    deactivating ? '/deactivate' : '/reactivate',
    'POST',
    props,
  );
  return (
    <Dialog
      open
      title={t(deactivating ? 'users.deactivateTitle' : 'users.reactivateTitle', {
        name: user.fullName,
      })}
      description={t(deactivating ? 'users.deactivateHint' : 'users.reactivateHint')}
      onClose={onClose}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const values = validate(changeUserStatusSchema, {
            reason: text(form, 'reason'),
            expectedUpdatedAt: user.updatedAt,
          });
          if (values) mutation.mutate(values);
        }}
      >
        <ErrorAlert error={mutation.error} />
        <ReasonField error={fieldErrors.reason} />
        <DialogButtons
          pending={mutation.isPending}
          label={t(deactivating ? 'users.deactivate' : 'users.reactivate')}
          destructive={deactivating}
          onClose={onClose}
        />
      </form>
    </Dialog>
  );
}

function RoleDialog(props: DialogProps) {
  const { t } = useTranslation();
  const { user, onClose } = props;
  const { fieldErrors, validate, mutation } = useUserMutation('/role', 'POST', props);
  const choices = ROLE_CHANGEABLE_ROLES.filter((role) => role !== user.role);
  return (
    <Dialog
      open
      title={t('users.changeRoleTitle', { name: user.fullName })}
      description={t('users.changeRoleHint')}
      onClose={onClose}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const values = validate(changeUserRoleSchema, {
            role: form.get('role'),
            reason: text(form, 'reason'),
            expectedUpdatedAt: user.updatedAt,
          });
          if (values) mutation.mutate(values);
        }}
      >
        <ErrorAlert error={mutation.error} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-role">{t('users.newRole')}</Label>
          <NativeSelect id="new-role" name="role" defaultValue={choices[0]}>
            {choices.map((role) => (
              <option key={role} value={role}>
                {t(`roles.${role}`)}
              </option>
            ))}
          </NativeSelect>
          {fieldErrors.role ? (
            <p className="text-sm text-destructive">{translateValidation(t, fieldErrors.role)}</p>
          ) : null}
        </div>
        <ReasonField error={fieldErrors.reason} />
        <DialogButtons pending={mutation.isPending} label={t('users.confirm')} onClose={onClose} />
      </form>
    </Dialog>
  );
}
