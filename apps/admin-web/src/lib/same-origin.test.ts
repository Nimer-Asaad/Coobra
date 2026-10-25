import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './same-origin';

function req(headers: Record<string, string>) {
  return new Request('http://localhost:3000/api/bff/v1/admin/users', { method: 'POST', headers });
}

describe('isSameOriginRequest', () => {
  it('accepts requests from the same host', () => {
    expect(
      isSameOriginRequest(req({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe(true);
  });

  it('rejects cross-site and origin-less requests', () => {
    expect(
      isSameOriginRequest(req({ origin: 'https://evil.example', host: 'localhost:3000' })),
    ).toBe(false);
    expect(isSameOriginRequest(req({ host: 'localhost:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'null', host: 'localhost:3000' }))).toBe(false);
  });
});
