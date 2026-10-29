import { describe, expect, it } from 'vitest';
import {
  auditEntity,
  auditSummary,
  REDACTED,
  redactMetadata,
  splitChanges,
} from './audit-redaction.js';

describe('redactMetadata', () => {
  it('keeps the fields services write and withholds unknown ones', () => {
    const { value, redacted } = redactMetadata({
      shipmentId: '0199a1c2-7d3e-7f00-8000-000000000001',
      trackingNumber: 'CB-12345678',
      amount: '120.00',
      reason: 'Customer cancelled',
      somethingNew: 'not reviewed yet',
    });
    expect(value).toEqual({
      shipmentId: '0199a1c2-7d3e-7f00-8000-000000000001',
      trackingNumber: 'CB-12345678',
      amount: '120.00',
      reason: 'Customer cancelled',
      somethingNew: REDACTED,
    });
    expect(redacted).toEqual(['somethingNew']);
  });

  it('withholds secrets by key at any depth', () => {
    const { value, redacted } = redactMetadata({
      password: 'hunter2',
      before: { fullName: 'A', passwordHash: '$argon2id$v=19$abc' },
      changes: { nested: { deeper: { apiKey: 'k', sessionToken: 't', Cookie: 'c' } } },
    });
    expect(value.password).toBe(REDACTED);
    expect(value.before).toEqual({ fullName: 'A', passwordHash: REDACTED });
    expect(value.changes).toEqual({
      nested: { deeper: { apiKey: REDACTED, sessionToken: REDACTED, Cookie: REDACTED } },
    });
    expect(redacted.sort()).toEqual(
      [
        'password',
        'before.passwordHash',
        'changes.nested.deeper.apiKey',
        'changes.nested.deeper.sessionToken',
        'changes.nested.deeper.Cookie',
      ].sort(),
    );
    expect(JSON.stringify(value)).not.toMatch(/hunter2|argon2|"k"|"t"|"c"/);
  });

  it('withholds credential-looking values whatever their key', () => {
    const { value } = redactMetadata({
      note: 'Bearer abc.def',
      reason: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      reference: 'A'.repeat(43),
      newValue: '$2b$10$abcdefghijklmnopqrstuv',
      after: { items: ['ok', 'x_y-Z'.repeat(10)] },
    });
    expect(value).toEqual({
      note: REDACTED,
      reason: REDACTED,
      reference: REDACTED,
      newValue: REDACTED,
      after: { items: ['ok', REDACTED] },
    });
  });

  it('keeps ids, references and Arabic text that only look long', () => {
    const { value, redacted } = redactMetadata({
      journalEntryId: '0199a1c2-7d3e-7f00-8000-000000000001',
      receiptReference: 'RC-1001',
      note: 'تم استلام المبلغ من السائق في المكتب الرئيسي بعد التدقيق الكامل',
    });
    expect(redacted).toEqual([]);
    expect(value.note).toContain('تم استلام');
  });

  it('caps depth, arrays and long strings', () => {
    const { value, redacted } = redactMetadata({
      changes: { a: { b: { c: { d: 'too deep' } } } },
      note: 'x '.repeat(400),
      after: { list: Array.from({ length: 80 }, (_, index) => index) },
    });
    expect(value.changes).toEqual({ a: { b: { c: REDACTED } } });
    expect(redacted).toContain('changes.a.b.c');
    expect((value.note as string).length).toBeLessThanOrEqual(501);
    expect((value.after as { list: number[] }).list).toHaveLength(50);
  });

  it('never throws on odd metadata', () => {
    expect(redactMetadata(null)).toEqual({ value: {}, redacted: [] });
    expect(redactMetadata('raw text')).toEqual({ value: {}, redacted: ['metadata'] });
    expect(redactMetadata([1, 2])).toEqual({ value: {}, redacted: ['metadata'] });
  });

  it('allows no field whose name looks like a secret', () => {
    // A guard for future edits of the allowlist.
    const keys = Object.keys(
      redactMetadata({ key: 'APPROVAL_THRESHOLD', sessionId: 's', debtAccount: 'D' }).value,
    );
    expect(keys).toEqual(['key', 'sessionId', 'debtAccount']);
  });
});

describe('splitChanges', () => {
  it('turns before/after, oldValue/newValue, changes and named pairs into changes', () => {
    const { changes, details } = splitChanges({
      before: { fullName: 'Old', phone: null },
      after: { fullName: 'New', phone: '0599000001' },
      reason: 'Typo',
    });
    expect(changes).toEqual([
      { field: 'fullName', before: 'Old', after: 'New' },
      { field: 'phone', before: null, after: '0599000001' },
    ]);
    expect(details).toEqual({ reason: 'Typo' });

    expect(
      splitChanges({ key: 'APPROVAL_THRESHOLD', oldValue: '500', newValue: '1000' }).changes,
    ).toEqual([{ field: 'APPROVAL_THRESHOLD', before: '500', after: '1000' }]);
    expect(splitChanges({ from: 'ACCOUNTANT', to: 'OPERATIONS' }).changes).toEqual([
      { field: 'role', before: 'ACCOUNTANT', after: 'OPERATIONS' },
    ]);
    expect(splitChanges({ zoneId: 'z', changes: { nameEn: 'Nablus' } })).toEqual({
      changes: [{ field: 'nameEn', before: null, after: 'Nablus' }],
      details: { zoneId: 'z' },
    });
  });
});

describe('auditEntity and auditSummary', () => {
  it('names the entity from the first id key, else the target user', () => {
    expect(auditEntity({ shipmentId: 's1', overrideId: 'o1' }, 'u1')).toEqual({
      type: 'SHIPMENT',
      id: 's1',
    });
    expect(auditEntity({ settlementId: 'st' }, null)).toEqual({ type: 'SETTLEMENT', id: 'st' });
    expect(auditEntity({ reason: 'x' }, 'u1')).toEqual({ type: 'USER', id: 'u1' });
    expect(auditEntity({}, null)).toBeNull();
    expect(auditEntity({ shipmentId: REDACTED }, null)).toBeNull();
  });

  it('summarises with a safe identifier', () => {
    expect(auditSummary({ trackingNumber: 'CB-1', reason: 'r' })).toBe('CB-1');
    expect(auditSummary({ reason: 'Left the company' })).toBe('Left the company');
    expect(auditSummary({ reference: REDACTED })).toBeNull();
  });
});
