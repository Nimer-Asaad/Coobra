import { describe, expect, it } from 'vitest';
import { apiUnavailableResponse, toProxyResponse } from './proxy-response';

// QA BUG-002: CSV exports through the BFF lost the UTF-8 BOM and the download headers.
describe('toProxyResponse', () => {
  it('keeps the exact bytes (UTF-8 BOM) and the download headers of a CSV', async () => {
    const csv = '﻿merchant,balance\r\nمتجر الفحص,69.00\r\n';
    const upstream = new Response(new TextEncoder().encode(csv), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="coobra-merchant-balances.csv"',
        'cache-control': 'no-store',
        'set-cookie': 'leak=1',
      },
    });
    const response = await toProxyResponse(upstream);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(csv);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="coobra-merchant-balances.csv"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('passes JSON errors and status codes through unchanged', async () => {
    const upstream = Response.json({ code: 'FORBIDDEN' }, { status: 403 });
    const response = await toProxyResponse(upstream);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'FORBIDDEN' });
  });

  it('returns an empty body for 204', async () => {
    const response = await toProxyResponse(new Response(null, { status: 204 }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('reports an unreachable API as 503 SERVICE_UNAVAILABLE', async () => {
    const response = apiUnavailableResponse();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });
});
