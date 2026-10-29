'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ADMIN_ASSIGNABLE_ROLES,
  createUserSchema,
  SUPPORTED_LANGUAGES,
  USER_ROLES,
  USER_STATUSES,
  type CreateUserInput,
  type Paginated,
  type UserListItem,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useFormErrors } from '@/lib/use-form-errors';
import { UserStatusBadge } from './user-status-badge';

export const USERS_KEY = ['admin', 'users'] as const;
const PAGE_SIZE = 20;
const FILTER_KEYS = ['q', 'role', 'status'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function UsersPanel() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, validate, applyApiError } = useFormErrors();

  const page = Math.max(1, Number(params.get('page')) || 1);
  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key) ?? '']),
  ) as Record<FilterKey, string>;
  const apiQuery = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  for (const key of FILTER_KEYS) if (filters[key]) apiQuery.set(key, filters[key]);

  const users = useQuery({
    queryKey: [...USERS_KEY, apiQuery.toString()],
    queryFn: () => bff<Paginated<UserListItem>>(`/v1/admin/users?${apiQuery}`),
    placeholderData: (previous) => previous,
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

  function navigate(next: Record<string, string>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    router.replace(query.size ? `${pathname}?${query}` : pathname);
  }

  const totalPages = users.data ? Math.max(1, Math.ceil(users.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card className="order-2 min-w-0 lg:order-1">
        <CardHeader>
          <CardTitle>{t('users.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            role="search"
            className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              navigate(
                Object.fromEntries(FILTER_KEYS.map((key) => [key, String(form.get(key) ?? '')])),
              );
            }}
            // Re-mount when the URL changes so the inputs show the applied filters.
            key={params.toString()}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="users-q">{t('users.search')}</Label>
              <Input id="users-q" name="q" type="search" defaultValue={filters.q} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="users-role">{t('users.role')}</Label>
              <NativeSelect id="users-role" name="role" defaultValue={filters.role}>
                <option value="">{t('users.allRoles')}</option>
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`roles.${role}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="users-status">{t('users.status')}</Label>
              <NativeSelect id="users-status" name="status" defaultValue={filters.status}>
                <option value="">{t('users.allStatuses')}</option>
                {USER_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status === 'ACTIVE' ? t('users.statusActive') : t('users.statusDisabled')}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit">{t('users.apply')}</Button>
          </form>

          {users.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : users.isError ? (
            <ErrorAlert error={users.error} />
          ) : users.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('users.empty')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {t('users.results', { count: users.data.total })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 text-start font-medium">{t('users.fullName')}</th>
                      <th className="py-2 text-start font-medium">{t('users.role')}</th>
                      <th className="py-2 text-start font-medium">{t('users.status')}</th>
                      <th className="py-2 text-start font-medium">{t('users.createdAt')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {users.data.items.map((user) => (
                      <tr key={user.id} className="hover:bg-muted/50">
                        <td className="py-2.5 pe-3">
                          <Link
                            href={`/users/${user.id}`}
                            className="font-medium text-primary hover:underline"
                            aria-label={t('users.open', { name: user.fullName })}
                          >
                            {user.fullName}
                          </Link>
                          <div className="text-xs text-muted-foreground" dir="ltr">
                            {user.email}
                          </div>
                          {user.businessName ? (
                            <div className="text-xs text-muted-foreground">{user.businessName}</div>
                          ) : null}
                        </td>
                        <td className="py-2.5 pe-3">{t(`roles.${user.role}`)}</td>
                        <td className="py-2.5 pe-3">
                          <UserStatusBadge status={user.status} />
                        </td>
                        <td className="py-2.5 whitespace-nowrap text-muted-foreground">
                          {formatDateTime(user.createdAt, i18n.language)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => navigate({ ...filters, page: String(page - 1) })}
                >
                  {t('users.previous')}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t('users.page', { page, pages: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => navigate({ ...filters, page: String(page + 1) })}
                >
                  {t('users.next')}
                </Button>
              </div>
            </>
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
