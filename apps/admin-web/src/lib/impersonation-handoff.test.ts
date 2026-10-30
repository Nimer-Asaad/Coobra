import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMPERSONATION_MESSAGE_CODE,
  IMPERSONATION_MESSAGE_READY,
  IMPERSONATION_MESSAGE_RESULT,
  type ImpersonationStartResponse,
} from '@coobra/shared';
import { HandoffError, runImpersonationHandoff, type HandoffSteps } from './impersonation-handoff';

const APP = 'http://localhost:8082';
const CHALLENGE = 'c'.repeat(43);
const CODE = 'k'.repeat(43);

function fakePopup() {
  return {
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    postMessage: vi.fn(),
  };
}

function setup(overrides: Partial<HandoffSteps> = {}) {
  const host = new EventTarget();
  const popup = fakePopup();
  const started: ImpersonationStartResponse = {
    impersonation: {
      id: 'imp-1',
      actor: { id: 'a', fullName: 'Admin' },
      target: { id: 'm', fullName: 'Merchant', role: 'MERCHANT' },
      startedAt: '2026-10-30T10:00:00.000Z',
      expiresAt: '2026-10-30T10:30:00.000Z',
      endedAt: null,
      endedReason: null,
      serverNow: '2026-10-30T10:00:00.000Z',
      writesEnabled: false,
    },
    code: CODE,
    appOrigin: APP,
  };
  const steps = {
    popup: popup as unknown as Window,
    appOrigin: APP,
    host: host as unknown as Window,
    reauthenticate: vi.fn(async () => undefined),
    start: vi.fn(async () => started),
    end: vi.fn(async () => undefined),
    timeouts: { ready: 200, result: 200 },
    ...overrides,
  };
  const send = (data: unknown, { origin = APP, source = popup as unknown } = {}) =>
    host.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
  return { steps, popup, send, started };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('runImpersonationHandoff', () => {
  it('posts the code only to the opened tab at the app origin, after its challenge', async () => {
    const { steps, popup, send } = setup();
    const run = runImpersonationHandoff(steps);
    send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE });
    await tick();
    expect(steps.start).toHaveBeenCalledWith(CHALLENGE);
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: IMPERSONATION_MESSAGE_CODE, code: CODE },
      APP,
    );
    send({ type: IMPERSONATION_MESSAGE_RESULT, ok: true });
    await expect(run).resolves.toMatchObject({ id: 'imp-1' });
    expect(steps.end).not.toHaveBeenCalled();
  });

  it('ignores messages from another origin or another window', async () => {
    const { steps, send } = setup();
    const run = runImpersonationHandoff(steps);
    send(
      { type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE },
      { origin: 'https://evil.test' },
    );
    send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE }, { source: {} });
    send({ type: IMPERSONATION_MESSAGE_READY, challenge: 'short' });
    await expect(run).rejects.toEqual(new HandoffError('noResponse'));
    // Nothing was started, so nothing needs ending.
    expect(steps.start).not.toHaveBeenCalled();
    expect(steps.end).not.toHaveBeenCalled();
  });

  it('starts nothing when the browser blocked the tab', async () => {
    const { steps } = setup({ popup: null });
    await expect(runImpersonationHandoff(steps)).rejects.toEqual(new HandoffError('popupBlocked'));
    expect(steps.reauthenticate).not.toHaveBeenCalled();
  });

  it('closes the tab and starts nothing when the password is wrong', async () => {
    const wrong = new Error('INVALID_CREDENTIALS');
    const { steps, popup } = setup({ reauthenticate: vi.fn(async () => Promise.reject(wrong)) });
    await expect(runImpersonationHandoff(steps)).rejects.toBe(wrong);
    expect(steps.start).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
  });

  it('ends the impersonation when the tab never confirms the exchange', async () => {
    const { steps, popup, send } = setup();
    const run = runImpersonationHandoff(steps);
    send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE });
    await expect(run).rejects.toEqual(new HandoffError('noResponse'));
    expect(steps.end).toHaveBeenCalledWith('imp-1');
    expect(popup.close).toHaveBeenCalled();
  });

  it('ends the impersonation when the exchange failed or the tab was closed', async () => {
    const failed = setup();
    const run = runImpersonationHandoff(failed.steps);
    failed.send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE });
    await tick();
    failed.send({ type: IMPERSONATION_MESSAGE_RESULT, ok: false });
    await expect(run).rejects.toEqual(new HandoffError('failed'));
    expect(failed.steps.end).toHaveBeenCalledWith('imp-1');

    const closed = setup({ timeouts: { ready: 200, result: 2_000 } });
    const second = runImpersonationHandoff(closed.steps);
    closed.send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE });
    await tick();
    closed.popup.closed = true;
    await expect(second).rejects.toEqual(new HandoffError('tabClosed'));
    expect(closed.steps.end).toHaveBeenCalledWith('imp-1');
  });

  it('refuses a start answer for a different app origin', async () => {
    const { steps, send, started } = setup();
    steps.start = vi.fn(async () => ({ ...started, appOrigin: 'http://localhost:8081' }));
    const run = runImpersonationHandoff(steps);
    send({ type: IMPERSONATION_MESSAGE_READY, challenge: CHALLENGE });
    await expect(run).rejects.toEqual(new HandoffError('failed'));
    expect(steps.end).toHaveBeenCalledWith('imp-1');
  });
});
