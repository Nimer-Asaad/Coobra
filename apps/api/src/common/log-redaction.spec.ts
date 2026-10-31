import { randomBytes, createHash } from 'node:crypto';
import { redactForLog } from './log-redaction.js';

describe('redactForLog', () => {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

  it('removes hashes, tokens, bearer values, cookies and secret fields from errors', () => {
    const error = new Error(
      [
        'Invalid `tx.session.create()` invocation:',
        `  data: { tokenHash: "${tokenHash}", userId: "0190f2a4-0000-7000-8000-000000000001" }`,
        `  passwordHash: '${passwordHash}'`,
        `  authorization: Bearer ${token}`,
        `  cookie: coobra_imp_session=${token}; coobra_session=${token}`,
        `  { "code": "${token}", "codeVerifier": "${token}", "password": "hunter2-secret" }`,
      ].join('\n'),
    );
    const text = redactForLog(error);
    for (const secret of [token, tokenHash, passwordHash, 'hunter2-secret']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
    // Ids stay readable for debugging.
    expect(text).toContain('0190f2a4-0000-7000-8000-000000000001');
  });

  it('handles strings and objects', () => {
    expect(redactForLog(`Bearer ${token}`)).toBe('Bearer [redacted]');
    expect(redactForLog({ password: 'p4ssword-value' })).not.toContain('p4ssword-value');
  });
});
