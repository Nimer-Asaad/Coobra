import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPERSONATION_HEADER,
  IMPERSONATION_MESSAGE_CODE,
  IMPERSONATION_MESSAGE_READY,
  IMPERSONATION_MESSAGE_RESULT,
  type ConsequencePreview,
  type ImpersonationInfo,
  type MerchantFinanceSummary,
} from '@coobra/shared';
import { ApiError, createApiClient, type ApiClient } from '../api-client';
import { ApiContext } from '../api-context';
import { FinanceScreen } from '../shipments/finance-screen';
import { renderMobile } from '../test/render';
import { ImpersonationBanner } from './banner';
import { ConsequenceSheet } from './consequence-sheet';
import { runTabHandoff, TabHandoffError } from './handoff';
import { useImpersonationStore } from './store';

const ADMIN = 'http://localhost:3000';
const CODE = 'k'.repeat(43);

const info = (overrides: Partial<ImpersonationInfo> = {}): ImpersonationInfo => ({
  id: 'imp-1',
  actor: { id: 'a-1', fullName: 'Rana Admin' },
  target: { id: 'm-1', fullName: 'Jenin Sweets', role: 'MERCHANT' },
  startedAt: '2026-10-30T10:00:00.000Z',
  expiresAt: '2026-10-30T10:30:00.000Z',
  endedAt: null,
  endedReason: null,
  serverNow: '2026-10-30T10:00:00.000Z',
  writesEnabled: true,
  ...overrides,
});

function withApi(api: Partial<ApiClient>, ui: ReactElement, language: 'en' | 'ar' = 'en') {
  return renderMobile(<ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>, {
    language,
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  useImpersonationStore.setState({ mode: 'none', info: null, receivedAt: 0, endedReason: null });
});
afterEach(() => vi.useRealTimers());

describe('tab hand-off', () => {
  function opener() {
    const host = new EventTarget();
    const win = { closed: false, postMessage: vi.fn() };
    const send = (data: unknown, { origin = ADMIN, source = win as unknown } = {}) =>
      host.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
    return { host: host as unknown as Window, win, send };
  }

  it('announces a challenge, accepts the code only from its opener and the console origin', async () => {
    const { host, win, send } = opener();
    const exchange = vi.fn(async () => info());
    const run = runTabHandoff({
      opener: win as unknown as Window,
      adminOrigin: ADMIN,
      host,
      exchange,
    });
    await waitFor(() => expect(win.postMessage).toHaveBeenCalled());
    const [ready, target] = win.postMessage.mock.calls[0]!;
    expect(target).toBe(ADMIN);
    expect(ready).toMatchObject({ type: IMPERSONATION_MESSAGE_READY });
    expect((ready as { challenge: string }).challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    send({ type: IMPERSONATION_MESSAGE_CODE, code: CODE }, { origin: 'https://evil.test' });
    send({ type: IMPERSONATION_MESSAGE_CODE, code: CODE }, { source: {} });
    expect(exchange).not.toHaveBeenCalled();
    send({ type: IMPERSONATION_MESSAGE_CODE, code: CODE });
    await expect(run).resolves.toMatchObject({ id: 'imp-1' });

    const [code, verifier] = exchange.mock.calls[0]! as unknown as [string, string];
    expect(code).toBe(CODE);
    // The verifier matches the announced challenge and never appears in a message.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect((ready as { challenge: string }).challenge).toBe(challenge);
    expect(JSON.stringify(win.postMessage.mock.calls)).not.toContain(verifier);
    expect(win.postMessage).toHaveBeenLastCalledWith(
      { type: IMPERSONATION_MESSAGE_RESULT, ok: true },
      ADMIN,
    );
  });

  it('fails safely without an opener, on timeout, and when the exchange is refused', async () => {
    await expect(
      runTabHandoff({ opener: null, adminOrigin: ADMIN, exchange: vi.fn() }),
    ).rejects.toEqual(new TabHandoffError('noOpener'));

    const late = opener();
    await expect(
      runTabHandoff({
        opener: late.win as unknown as Window,
        adminOrigin: ADMIN,
        host: late.host,
        exchange: vi.fn(),
        timeoutMs: 50,
      }),
    ).rejects.toEqual(new TabHandoffError('timeout'));

    const refused = opener();
    const run = runTabHandoff({
      opener: refused.win as unknown as Window,
      adminOrigin: ADMIN,
      host: refused.host,
      exchange: vi.fn(async () => Promise.reject(new Error('IMPERSONATION_CODE_INVALID'))),
    });
    await waitFor(() => expect(refused.win.postMessage).toHaveBeenCalled());
    refused.send({ type: IMPERSONATION_MESSAGE_CODE, code: CODE });
    await expect(run).rejects.toEqual(new TabHandoffError('failed'));
    expect(refused.win.postMessage).toHaveBeenLastCalledWith(
      { type: IMPERSONATION_MESSAGE_RESULT, ok: false },
      ADMIN,
    );
  });
});

describe('API client in an impersonation tab', () => {
  it('sends the header and ends the impersonation (never the real session) on 401', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'no' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthenticated = vi.fn();
    const onImpersonationLost = vi.fn();
    const api = createApiClient({
      apiUrl: 'http://api',
      getToken: () => null,
      onUnauthenticated,
      isImpersonating: () => true,
      onImpersonationLost,
    });
    await expect(api.request('/v1/auth/me')).rejects.toBeInstanceOf(ApiError);
    const headers = (
      fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    )[1].headers;
    expect(headers[IMPERSONATION_HEADER]).toBe('1');
    expect(onImpersonationLost).toHaveBeenCalled();
    expect(onUnauthenticated).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps the marker in this tab only and survives a reload as ended', () => {
    useImpersonationStore.getState().activate(info());
    expect(window.sessionStorage.getItem('coobra.impersonation')).toBe('active');
    expect(window.localStorage.getItem('coobra.impersonation')).toBeNull();
    useImpersonationStore.getState().end('EXPIRED');
    expect(window.sessionStorage.getItem('coobra.impersonation')).toBe('ended');
    expect(useImpersonationStore.getState().info).toBeNull();
  });
});

describe('ImpersonationBanner', () => {
  it('counts down by the server clock, shows view only, and ends after confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The local clock is 2 hours off: the countdown still uses the server's time.
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    useImpersonationStore
      .getState()
      .activate(info({ serverNow: '2026-10-30T10:10:00.000Z', writesEnabled: false }));
    const request = vi.fn(async () => info({ endedAt: '2026-10-30T10:11:00.000Z' }));
    withApi({ request } as Partial<ApiClient>, <ImpersonationBanner />);

    expect(screen.getByRole('region', { name: 'Acting as another account' })).toBeTruthy();
    expect(screen.getByText('Acting as Jenin Sweets (Merchant)')).toBeTruthy();
    expect(screen.getByText('Administrator: Rana Admin')).toBeTruthy();
    expect(screen.getByTestId('impersonation-view-only').textContent).toBe('View only');
    expect(screen.getByTestId('impersonation-remaining').textContent).toBe('20:00');

    fireEvent.click(screen.getByTestId('impersonation-end'));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('impersonation-end-confirm'));
    await waitFor(() => expect(useImpersonationStore.getState().mode).toBe('ended'));
    expect(request).toHaveBeenCalledWith('/v1/impersonation/end', { method: 'POST' });
    expect(useImpersonationStore.getState().endedReason).toBe('MANUAL');
  });

  it('ends the tab when the time is up, and renders in Arabic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-30T10:29:58.000Z'));
    useImpersonationStore.getState().activate(info({ serverNow: '2026-10-30T10:29:58.000Z' }));
    withApi({ request: vi.fn() } as Partial<ApiClient>, <ImpersonationBanner />, 'ar');
    expect(screen.getByText('تعمل بحساب Jenin Sweets (تاجر)')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(useImpersonationStore.getState().mode).toBe('ended');
    expect(useImpersonationStore.getState().endedReason).toBe('EXPIRED');
  });
});

describe('ConsequenceSheet', () => {
  const preview = (fee: string, expiresAt = '2026-10-30T10:05:00.000Z'): ConsequencePreview => ({
    lines: [
      {
        kind: 'RETURN_DELIVERY_CHARGE',
        party: 'MERCHANT',
        amount: fee,
        currency: 'ILS',
        certainty: 'FIXED',
        trigger: 'ON_RETURN_COMPLETED',
      },
      {
        kind: 'RETURN_FEE',
        party: 'MERCHANT',
        amount: null,
        currency: 'ILS',
        certainty: 'UNDECIDED',
        trigger: 'ON_RETURN_COMPLETED',
      },
    ],
    confirmationToken: `v1.k1.${fee}.signature-of-the-server`,
    expiresAt,
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'));
    useImpersonationStore.getState().activate(info());
  });

  it('shows the server charges and asks again, with the old amount, when they changed', async () => {
    const load = vi
      .fn<() => Promise<ConsequencePreview>>()
      .mockResolvedValueOnce(preview('10.00'))
      .mockResolvedValueOnce(preview('15.00'));
    const confirm = vi
      .fn<(token: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiError({ statusCode: 409, code: 'CONSEQUENCE_CHANGED', message: 'changed' }),
      )
      .mockResolvedValueOnce(undefined);
    withApi(
      {},
      <ConsequenceSheet title="Delivery failed" load={load} confirm={confirm} onClose={vi.fn()} />,
    );

    const charge = await screen.findByTestId('consequence-RETURN_DELIVERY_CHARGE');
    expect(charge.textContent).toContain('Return delivery charge');
    expect(charge.textContent).toContain('Fixed · charged only if the return is completed');
    expect(screen.getByTestId('consequence-RETURN_FEE').textContent).toContain(
      'Decided later by finance',
    );
    expect(screen.getByTestId('consequence-validity').textContent).toBe('Valid for 5:00');

    fireEvent.click(screen.getByTestId('consequence-confirm'));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenNthCalledWith(1, 'v1.k1.10.00.signature-of-the-server');
    expect(
      await screen.findByText(
        'The charges changed since you looked. Check the new amounts and confirm again.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('consequence-RETURN_DELIVERY_CHARGE').textContent).toMatch(
      /Was .*10\.00/,
    );

    fireEvent.click(screen.getByTestId('consequence-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenLastCalledWith('v1.k1.15.00.signature-of-the-server');
  });

  it('never sends an expired confirmation: it only offers a refresh', async () => {
    const load = vi.fn(async () => preview('10.00', '2026-10-30T10:00:02.000Z'));
    const confirm = vi.fn(async () => undefined);
    withApi(
      {},
      <ConsequenceSheet title="Return" load={load} confirm={confirm} onClose={vi.fn()} />,
    );
    await screen.findByTestId('consequence-lines');
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('consequence-validity').textContent).toBe(
      'These charges are out of date. Refresh them to continue.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh charges' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('blocked actions during an impersonation', () => {
  const finance: MerchantFinanceSummary = {
    pending: '0.00',
    balance: '21.00',
    reserved: '0.00',
    available: '21.00',
    payouts: [],
  };
  const api = {
    request: vi.fn(async (path: string) =>
      path === '/v1/merchant/finance/shortfalls' ? [] : finance,
    ),
  };

  it('keeps financial consent visible but disabled, with the reason', async () => {
    useImpersonationStore.getState().activate(info());
    withApi(api as Partial<ApiClient>, <FinanceScreen />);
    const submit = await screen.findByTestId('payout-submit');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    const reason = screen.getByTestId('payout-submit-reason');
    expect(reason.textContent).toBe(
      'Only the merchant can decide this. Use the admin console if needed.',
    );
    expect(submit.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('changes nothing outside an impersonation', async () => {
    withApi(api as Partial<ApiClient>, <FinanceScreen />);
    await screen.findByTestId('payout-submit');
    expect(screen.queryByTestId('payout-submit-reason')).toBeNull();
  });
});
