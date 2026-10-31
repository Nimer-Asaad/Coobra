import {
  IMPERSONATION_HANDOFF_READY_TIMEOUT_MS,
  IMPERSONATION_MESSAGE_CODE,
  IMPERSONATION_MESSAGE_READY,
  IMPERSONATION_MESSAGE_RESULT,
  type ImpersonationInfo,
} from '@coobra/shared';

/** Each maps to `impersonation.handoff.<reason>`. */
export type TabHandoffFailure = 'noOpener' | 'timeout' | 'failed';

export class TabHandoffError extends Error {
  constructor(readonly reason: TabHandoffFailure) {
    super(reason);
  }
}

const CODE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes; only ever held in this function's memory. */
function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The app tab's side of the hand-off (ADR 0003 §8.3): announce a challenge to the console that
 * opened this tab, accept the code only from that window and the console's exact origin, then
 * redeem it with the verifier. The verifier and the code never leave memory: no URL, no
 * storage, no logs. The console learns only whether it worked.
 */
export async function runTabHandoff({
  opener,
  adminOrigin,
  exchange,
  host = window,
  timeoutMs = IMPERSONATION_HANDOFF_READY_TIMEOUT_MS,
}: {
  opener: Window | null;
  adminOrigin: string | undefined;
  exchange: (code: string, codeVerifier: string) => Promise<ImpersonationInfo>;
  host?: Window;
  timeoutMs?: number;
}): Promise<ImpersonationInfo> {
  if (!opener || opener.closed || !adminOrigin) throw new TabHandoffError('noOpener');
  const verifier = newVerifier();
  const challenge = await challengeFor(verifier);

  const code = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      host.removeEventListener('message', onMessage);
      clearInterval(repeat);
      clearTimeout(timer);
    };
    function onMessage(event: MessageEvent) {
      if (event.source !== opener || event.origin !== adminOrigin) return;
      const data = event.data as { type?: unknown; code?: unknown } | null;
      if (data?.type !== IMPERSONATION_MESSAGE_CODE) return;
      if (typeof data.code !== 'string' || !CODE.test(data.code)) return;
      cleanup();
      resolve(data.code);
    }
    // Repeated until the code arrives, in case the console was not listening yet.
    const announce = () =>
      opener.postMessage({ type: IMPERSONATION_MESSAGE_READY, challenge }, adminOrigin);
    host.addEventListener('message', onMessage);
    const repeat = setInterval(announce, 1000);
    const timer = setTimeout(() => {
      cleanup();
      reject(new TabHandoffError('timeout'));
    }, timeoutMs);
    announce();
  });

  try {
    const info = await exchange(code, verifier);
    opener.postMessage({ type: IMPERSONATION_MESSAGE_RESULT, ok: true }, adminOrigin);
    return info;
  } catch {
    opener.postMessage({ type: IMPERSONATION_MESSAGE_RESULT, ok: false }, adminOrigin);
    throw new TabHandoffError('failed');
  }
}
