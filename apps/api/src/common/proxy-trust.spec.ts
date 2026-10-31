import { proxyTrustProblem } from './proxy-trust.js';

describe('proxyTrustProblem', () => {
  it('accepts a direct deployment and a matching proxy count', () => {
    expect(proxyTrustProblem(0, undefined)).toBeNull();
    expect(proxyTrustProblem(1, '203.0.113.7')).toBeNull();
    expect(proxyTrustProblem(2, '203.0.113.7, 10.0.0.2')).toBeNull();
    // More entries than trusted hops: the extra ones are client-supplied and ignored by Express.
    expect(proxyTrustProblem(1, 'spoofed, 203.0.113.7')).toBeNull();
  });

  it('reports a proxy that is not trusted', () => {
    expect(proxyTrustProblem(0, '203.0.113.7')).toBe('UNTRUSTED_PROXY');
  });

  it('reports fewer hops than configured (the API reached around the proxy)', () => {
    expect(proxyTrustProblem(1, undefined)).toBe('FEWER_HOPS');
    expect(proxyTrustProblem(2, '203.0.113.7')).toBe('FEWER_HOPS');
    expect(proxyTrustProblem(1, ' , ')).toBe('FEWER_HOPS');
  });
});
