import { z } from 'zod';
import { CLIENT_APPS, ADMIN_ASSIGNABLE_ROLES } from './roles.js';
import { SUPPORTED_LANGUAGES } from './language.js';
import { normalizePhone } from './shipments.js';

/*
 * Validation messages are i18n keys (see @coobra/i18n `validation.*`), so the same
 * schemas produce translated errors on every client and on the API.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const languageSchema = z.enum(SUPPORTED_LANGUAGES, { error: 'validation.language.invalid' });

export const emailSchema = z
  .string({ error: 'validation.required' })
  .trim()
  .toLowerCase()
  .min(1, { error: 'validation.required' })
  .max(254, { error: 'validation.email.invalid' })
  .pipe(z.email({ error: 'validation.email.invalid' }));

export const passwordSchema = z
  .string({ error: 'validation.required' })
  .min(PASSWORD_MIN_LENGTH, { error: 'validation.password.tooShort' })
  .max(PASSWORD_MAX_LENGTH, { error: 'validation.password.tooLong' })
  .regex(/\p{L}/u, { error: 'validation.password.needsLetter' })
  .regex(/\p{N}/u, { error: 'validation.password.needsNumber' });

/** Login only checks presence; strength rules apply when a password is set. */
const loginPasswordSchema = z
  .string({ error: 'validation.required' })
  .min(1, { error: 'validation.required' })
  .max(PASSWORD_MAX_LENGTH, { error: 'validation.password.tooLong' });

const nameSchema = z
  .string({ error: 'validation.required' })
  .trim()
  .min(2, { error: 'validation.name.tooShort' })
  .max(120, { error: 'validation.name.tooLong' });

/**
 * Account phone numbers (merchant registration, staff and driver accounts). Normalised like
 * recipient phones first, so Arabic-Indic digits, spaces, dashes and a 00 prefix are accepted.
 */
export const phoneSchema = z
  .string({ error: 'validation.required' })
  .trim()
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\+?[0-9]{7,15}$/, { error: 'validation.phone.invalid' }));

const tokenSchema = z
  .string({ error: 'validation.token.invalid' })
  .trim()
  .min(20, { error: 'validation.token.invalid' })
  .max(200, { error: 'validation.token.invalid' });

export const registerMerchantSchema = z.object({
  fullName: nameSchema,
  businessName: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
  language: languageSchema,
});
export type RegisterMerchantInput = z.infer<typeof registerMerchantSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
  clientApp: z.enum(CLIENT_APPS, { error: 'validation.clientApp.invalid' }),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: tokenSchema,
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({
  token: tokenSchema,
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const updatePreferencesSchema = z.object({
  language: languageSchema,
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const createUserSchema = z.object({
  fullName: nameSchema,
  email: emailSchema,
  phone: phoneSchema.optional(),
  role: z.enum(ADMIN_ASSIGNABLE_ROLES, { error: 'validation.role.invalid' }),
  language: languageSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Converts zod issues into `{ "field.path": "i18n.key" }`, keeping the first issue per field.
 */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!(path in fieldErrors)) {
      fieldErrors[path] = issue.message;
    }
  }
  return fieldErrors;
}
