import {
  AUDIT_ENTITY_KEYS,
  type AuditChange,
  type AuditEntity,
  type AuditValue,
} from '@coobra/shared';

/*
 * What the audit log viewer may show of an entry's metadata.
 *
 * 1. Top-level keys must be on the allowlist: the fields services write today. A key the
 *    viewer doesn't know (a future field, a mistake) is withheld until it is reviewed here.
 * 2. At any depth, a key that names a secret (password, token, cookie, API key, hash, ...) is
 *    withheld, and so is a string that looks like a credential (Bearer/JWT/password hash/long
 *    opaque token), whatever its key.
 * 3. Depth, array length and string length are capped.
 * Withheld values are replaced by REDACTED and their paths are listed, never their content.
 */

export const REDACTED = '[redacted]';

const ALLOWED_KEYS = new Set([
  // Identifiers of the entity an entry is about (see AUDIT_ENTITY_KEYS).
  ...Object.values(AUDIT_ENTITY_KEYS),
  'trackingNumber',
  'code',
  'key',
  'parentId',
  'journalEntryId',
  'debtAccount',
  'previousRuleId',
  'previousZoneId',
  'requestedZoneId',
  'previousDriverId',
  'returnDriverId',
  'submittedById',
  // Business facts.
  'amount',
  'attemptFee',
  'countedAmount',
  'declaredAmount',
  'deliveryCharge',
  'deliveryFee',
  'discrepancy',
  'newFee',
  'previousFee',
  'returnFee',
  'waivedDeliveryCharge',
  'outstandingBefore',
  'outstandingAfter',
  'channel',
  'method',
  'reference',
  'receiptReference',
  'feePolicy',
  'returnPolicy',
  'pricingSource',
  'isFallback',
  'version',
  'type',
  'responsibility',
  'resolution',
  'proposedResolution',
  'requestedByMerchant',
  'onBehalfOfMerchant',
  'fromStatus',
  'toStatus',
  'submittedAt',
  'decidedAt',
  'submittedByRole',
  'role',
  'from',
  'to',
  'language',
  'clientApp',
  'sessionsRevoked',
  // Phase 4C impersonation events.
  'endReason',
  'targetRole',
  'expiresAt',
  'via',
  'reason',
  'note',
  // Before/after shapes.
  'before',
  'after',
  'changes',
  'oldValue',
  'newValue',
]);

const SECRET_KEY =
  /pass(word|wd|phrase)?|pwd|secret|token|jwt|bearer|cookie|authori[sz]ation|(api|access|private)[-_]?key|credential|hash|otp|signature|cvv|card[-_]?number|iban/i;
const SECRET_VALUE = [
  /^bearer\s/i,
  /\bbearer\s+\S{16,}/i, // inside a sentence
  /^basic\s+[A-Za-z0-9+/=]{8,}$/i,
  /eyJ[\w-]{5,}\.[\w-]{5,}\./, // JWT, also inside a sentence
  /^\$(argon2|2[aby]?|scrypt|pbkdf2)/i, // password hashes
  /^[A-Za-z0-9_-]{40,}$/, // long opaque tokens (session and reset tokens are 43 chars)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[?&](token|key|secret|password|sig|signature|code)=[^&\s]{6,}/i, // secrets in a URL
  /^[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}$/, // IBAN
];
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_STRING = 500;
/** Longer keys are not field names but data (e.g. a map keyed by token). */
const MAX_KEY = 64;

export interface Redacted {
  value: Record<string, AuditValue>;
  redacted: string[];
}

/** Payment card numbers: 13 to 19 digits (spaces or dashes allowed) passing the Luhn check. */
function looksLikeCard(value: string): boolean {
  if (!/^\d[\d -]{11,22}\d$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

export function looksSecret(value: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(value)) || looksLikeCard(value);
}

/** A key that is itself a secret (or data) is not shown, not even in the withheld list. */
function unsafeKey(key: string): boolean {
  return key.length > MAX_KEY || looksSecret(key);
}

function clean(value: unknown, path: string, depth: number, redacted: string[]): AuditValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (looksSecret(value)) {
      redacted.push(path);
      return REDACTED;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (depth >= MAX_DEPTH) {
    redacted.push(path);
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item, index) => clean(item, `${path}[${index}]`, depth + 1, redacted));
  }
  if (typeof value === 'object') {
    const out: Record<string, AuditValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKey(key)) {
        redacted.push(`${path}.${REDACTED}`);
        out[REDACTED] = REDACTED;
        continue;
      }
      const childPath = `${path}.${key}`;
      if (SECRET_KEY.test(key)) {
        redacted.push(childPath);
        out[key] = REDACTED;
      } else {
        out[key] = clean(item, childPath, depth + 1, redacted);
      }
    }
    return out;
  }
  redacted.push(path);
  return REDACTED;
}

/** The metadata as the viewer may show it. Never throws; anything unexpected is withheld. */
export function redactMetadata(metadata: unknown): Redacted {
  const redacted: string[] = [];
  const value: Record<string, AuditValue> = {};
  if (metadata === null || metadata === undefined) return { value, redacted };
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { value, redacted: ['metadata'] };
  }
  for (const [key, item] of Object.entries(metadata as Record<string, unknown>)) {
    if (unsafeKey(key)) {
      redacted.push(REDACTED);
      value[REDACTED] = REDACTED;
    } else if (!ALLOWED_KEYS.has(key) || SECRET_KEY.test(key)) {
      redacted.push(key);
      value[key] = REDACTED;
    } else {
      value[key] = clean(item, key, 1, redacted);
    }
  }
  // A setting change (key, oldValue, newValue) whose key names a secret: withhold both values.
  if (typeof value.key === 'string' && SECRET_KEY.test(value.key)) {
    for (const field of ['oldValue', 'newValue']) {
      if (field in value && value[field] !== REDACTED) {
        value[field] = REDACTED;
        redacted.push(field);
      }
    }
  }
  return { value, redacted };
}

/** The entity an entry is about: the first entity id in the metadata, else the target user. */
export function auditEntity(
  metadata: Record<string, AuditValue>,
  targetUserId: string | null,
): AuditEntity | null {
  for (const [type, key] of Object.entries(AUDIT_ENTITY_KEYS)) {
    const id = metadata[key];
    if (typeof id === 'string' && id !== REDACTED) return { type: type as AuditEntity['type'], id };
  }
  return targetUserId ? { type: 'USER', id: targetUserId } : null;
}

const PAIRS: [field: string, before: string, after: string][] = [
  ['role', 'from', 'to'],
  ['status', 'fromStatus', 'toStatus'],
  ['fee', 'previousFee', 'newFee'],
  ['outstanding', 'outstandingBefore', 'outstandingAfter'],
  ['zone', 'previousZoneId', 'requestedZoneId'],
];

/**
 * Splits redacted metadata into before/after changes and the remaining details. Covers the
 * shapes services write: before/after objects, oldValue/newValue, `changes` (new values only)
 * and the named pairs above.
 */
export function splitChanges(metadata: Record<string, AuditValue>): {
  changes: AuditChange[];
  details: Record<string, AuditValue>;
} {
  const details = { ...metadata };
  const changes: AuditChange[] = [];
  const isObject = (value: AuditValue | undefined): value is Record<string, AuditValue> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const before = details.before;
  const after = details.after;
  if (isObject(before) || isObject(after)) {
    const from = isObject(before) ? before : {};
    const to = isObject(after) ? after : {};
    for (const field of new Set([...Object.keys(from), ...Object.keys(to)])) {
      changes.push({ field, before: from[field] ?? null, after: to[field] ?? null });
    }
    delete details.before;
    delete details.after;
  }
  if ('oldValue' in details || 'newValue' in details) {
    const field = typeof details.key === 'string' ? details.key : 'value';
    changes.push({ field, before: details.oldValue ?? null, after: details.newValue ?? null });
    delete details.oldValue;
    delete details.newValue;
  }
  if (isObject(details.changes)) {
    for (const [field, value] of Object.entries(details.changes)) {
      changes.push({ field, before: null, after: value });
    }
    delete details.changes;
  }
  for (const [field, beforeKey, afterKey] of PAIRS) {
    if (beforeKey in details && afterKey in details) {
      changes.push({ field, before: details[beforeKey]!, after: details[afterKey]! });
      delete details[beforeKey];
      delete details[afterKey];
    }
  }
  return { changes, details };
}

/** A short, safe hint for the list. */
export function auditSummary(metadata: Record<string, AuditValue>): string | null {
  for (const key of ['trackingNumber', 'receiptReference', 'reference', 'code', 'key', 'reason']) {
    const value = metadata[key];
    if (typeof value === 'string' && value && value !== REDACTED) {
      return value.length > 80 ? `${value.slice(0, 80)}…` : value;
    }
  }
  return null;
}
