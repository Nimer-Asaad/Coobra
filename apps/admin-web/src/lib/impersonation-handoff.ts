import {
  IMPERSONATION_HANDOFF_READY_TIMEOUT_MS,
  IMPERSONATION_HANDOFF_RESULT_TIMEOUT_MS,
  IMPERSONATION_MESSAGE_CODE,
  IMPERSONATION_MESSAGE_READY,
  IMPERSONATION_MESSAGE_RESULT,
  type ImpersonationInfo,
  type ImpersonationStartResponse,
} from '@coobra/shared';

/** Why a hand-off did not finish; each maps to `impersonation.admin.failure.<reason>`. */
export type HandoffFailure = 'popupBlocked' | 'noResponse' | 'tabClosed' | 'failed';

export class HandoffError extends Error {
  constructor(readonly reason: HandoffFailure) {
    super(reason);
  }
}

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export interface HandoffSteps {
  /** The window opened synchronously in the click handler (null when the browser blocked it). */
  popup: Window | null;
  /** The target app's exact origin, e.g. https://merchant.coobra.ps */
  appOrigin: string;
  /** Password step-up; runs while the new tab loads. */
  reauthenticate: () => Promise<void>;
  start: (codeChallenge: string) => Promise<ImpersonationStartResponse>;
  /** Ends an impersonation whose hand-off failed (best effort; it also expires on its own). */
  end: (impersonationId: string) => Promise<unknown>;
  /** Where the console listens (the console's own window). */
  host?: Window;
  timeouts?: { ready: number; result: number };
}

/**
 * The console side of the ADR 0003 §8.3 hand-off. Messages are accepted only from the window
 * this console opened and only from the target app's exact origin; the code is posted only to
 * that origin and then dropped. Any failure after the start ends the impersonation, so no active
 * impersonation is left without a working tab.
 */
export async function runImpersonationHandoff(steps: HandoffSteps): Promise<ImpersonationInfo> {
  const { popup, appOrigin } = steps;
  if (!popup) throw new HandoffError('popupBlocked');
  const host = steps.host ?? window;
  const timeouts = steps.timeouts ?? {
    ready: IMPERSONATION_HANDOFF_READY_TIMEOUT_MS,
    result: IMPERSONATION_HANDOFF_RESULT_TIMEOUT_MS,
  };

  const got: { challenge: string | null; result: boolean | null } = {
    challenge: null,
    result: null,
  };
  let wake: (() => void) | null = null;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== popup || event.origin !== appOrigin) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const message = data as { type?: unknown; challenge?: unknown; ok?: unknown };
    if (message.type === IMPERSONATION_MESSAGE_READY && got.challenge === null) {
      if (typeof message.challenge === 'string' && CHALLENGE.test(message.challenge)) {
        got.challenge = message.challenge;
      }
    } else if (message.type === IMPERSONATION_MESSAGE_RESULT && got.result === null) {
      got.result = message.ok === true;
    }
    wake?.();
  };

  /** Resolves when `done()` holds; rejects on timeout or when the tab is closed. */
  const waitFor = (done: () => boolean, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: HandoffError) => {
        clearTimeout(timer);
        clearInterval(closedCheck);
        wake = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new HandoffError('noResponse')), ms);
      const closedCheck = setInterval(() => {
        if (popup.closed) finish(new HandoffError('tabClosed'));
      }, 250);
      wake = () => {
        if (done()) finish();
      };
      wake();
    });

  host.addEventListener('message', onMessage);
  let impersonationId: string | null = null;
  try {
    // The tab announces itself while the password is checked.
    const ready = waitFor(() => got.challenge !== null, timeouts.ready);
    ready.catch(() => undefined);
    await steps.reauthenticate();
    await ready;

    const started = await steps.start(got.challenge!);
    impersonationId = started.impersonation.id;
    if (started.appOrigin !== appOrigin) throw new HandoffError('failed');
    popup.postMessage({ type: IMPERSONATION_MESSAGE_CODE, code: started.code }, appOrigin);

    await waitFor(() => got.result !== null, timeouts.result);
    if (got.result !== true) throw new HandoffError('failed');
    return started.impersonation;
  } catch (error) {
    if (impersonationId) await steps.end(impersonationId).catch(() => undefined);
    if (!popup.closed) popup.close();
    throw error;
  } finally {
    host.removeEventListener('message', onMessage);
  }
}
