import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type ProxyTrustProblem = 'UNTRUSTED_PROXY' | 'FEWER_HOPS';

/**
 * Compares TRUST_PROXY with what actually reaches the API, without guessing a hop count:
 * - X-Forwarded-For present while TRUST_PROXY=0: a proxy is in front, so every client shares
 *   its address in rate limits and the audit log.
 * - fewer forwarded hops than TRUST_PROXY: the API is reachable around the proxy, or the
 *   setting is too high; either way a client can choose the address the API sees.
 */
export function proxyTrustProblem(
  trustProxy: number,
  forwardedFor: string | string[] | undefined,
): ProxyTrustProblem | null {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const hops = header ? header.split(',').filter((part) => part.trim()).length : 0;
  if (trustProxy === 0) return hops > 0 ? 'UNTRUSTED_PROXY' : null;
  return hops < trustProxy ? 'FEWER_HOPS' : null;
}

const MESSAGES: Record<ProxyTrustProblem, string> = {
  UNTRUSTED_PROXY:
    'Requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY is 0: all clients share the proxy address in rate limits and the audit log. See docs/deployment.md.',
  FEWER_HOPS:
    'A request arrived with fewer forwarded hops than TRUST_PROXY: the API may be reachable without the proxy, which lets clients choose their address. See docs/deployment.md.',
};

/** Logs each kind of mismatch once per process; never logs addresses. */
export function proxyTrustMonitor(trustProxy: number) {
  const logger = new Logger('ProxyTrust');
  const reported = new Set<ProxyTrustProblem>();
  return (request: Request, _response: Response, next: NextFunction) => {
    if (reported.size < 2) {
      const problem = proxyTrustProblem(trustProxy, request.headers['x-forwarded-for']);
      if (problem && !reported.has(problem)) {
        reported.add(problem);
        logger.error(MESSAGES[problem]);
      }
    }
    next();
  };
}
