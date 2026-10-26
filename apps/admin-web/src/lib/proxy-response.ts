/** Upstream API headers the BFF passes through to the browser. */
const FORWARDED_HEADERS = ['content-type', 'content-disposition', 'cache-control'] as const;

/**
 * Turns the API's response into the BFF's response without altering the body: the bytes are
 * copied as-is, so a UTF-8 BOM on CSV exports survives (Excel needs it for Arabic text), and
 * the download headers (content-disposition) are kept.
 */
export async function toProxyResponse(upstream: Response): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers });
}

/** The API could not be reached at all (down, restarting, network error). */
export function apiUnavailableResponse(): Response {
  return Response.json(
    {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is temporarily unavailable',
    },
    { status: 503 },
  );
}
