'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ADMIN_ASSIGNABLE_ROLES,
  createUserSchema,
  SUPPORTED_LANGUAGES,
  type CreateUserInput,
  type UserListItem,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { useFormErrors } from '@/lib/use-form-errors';

const USERS_KEY = ['admin', 'users'] as const;

export function UsersPanel() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();

  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => bff<{ items: UserListItem[] }>('/v1/admin/users'),
  });

  const create = useMutation({
    mutationFn: (body: CreateUserInput) =>
      bff<UserListItem>('/v1/admin/users', { method: 'POST', body }),
    onSuccess: () => {
      formRef.current?.reset();
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: applyApiError,
  });

  const dateFormat = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card className="order-2 lg:order-1">
        <CardHeader>
          <CardTitle>{t('users.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : users.isError ? (
            <ErrorAlert error={users.error} />
          ) : users.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('users.empty')}</p>
          ) : (
            <ul className="divide-y">
              {users.data.items.map((user) => (
                <li
                  key={user.id}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{user.fullName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      <span dir="ltr">{user.email}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-muted px-2 py-1">{t(`roles.${user.role}`)}</span>
                    <span className="rounded bg-muted px-2 py-1">
                      {user.status === 'ACTIVE'
                        ? t('users.statusActive')
                        : t('users.statusDisabled')}
                    </span>
                    {user.emailVerified ? (
                      <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">
                        {t('users.verified')}
                      </span>
                    ) : null}
                    <span className="px-2 py-1 text-muted-foreground">
                      {dateFormat.format(new Date(user.createdAt))}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="order-1 lg:order-2">
        <CardHeader>
          <CardTitle>{t('users.createTitle')}</CardTitle>
          <CardDescription>{t('users.createDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            ref={formRef}
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const phone = String(form.get('phone') ?? '').trim();
              const values = validate(createUserSchema, {
                fullName: form.get('fullName'),
                email: form.get('email'),
                phone: phone || undefined,
                role: form.get('role'),
                language: form.get('language'),
              });
              if (values) create.mutate(values);
            }}
          >
            {create.isSuccess ? <Alert variant="success">{t('users.created')}</Alert> : null}
            <ErrorAlert error={create.error} />
            <FormField name="fullName" label={t('users.fullName')} error={fieldErrors.fullName} />
            <FormField
              name="email"
              type="email"
              dir="ltr"
              label={t('users.email')}
              error={fieldErrors.email}
            />
            <FormField
              name="phone"
              type="tel"
              dir="ltr"
              label={t('users.phone')}
              error={fieldErrors.phone}
            />
            <div className="flex flex-col gap-2">
              <Label htmlFor="role">{t('users.role')}</Label>
              <NativeSelect id="role" name="role" defaultValue="OPERATIONS">
                {ADMIN_ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`roles.${role}`)}
                  </option>
                ))}
              </NativeSelect>
              {fieldErrors.role ? (
                <p className="text-sm text-destructive">
                  {translateValidation(t, fieldErrors.role)}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="language">{t('users.language')}</Label>
              <NativeSelect id="language" name="language" defaultValue={i18n.language}>
                {SUPPORTED_LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {language === 'ar' ? t('language.arabic') : t('language.english')}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={create.isPending}>
              {t('users.create')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
