/**
 * "Copy as cURL" for failed requests taken from the trace. Secrets are masked unless
 * EXTENDED_REPORT_UNMASK_SECRETS=1 was set when the report was generated.
 */

export type HttpHeader = { name: string, value: string };

const kSecretHeader = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$|token|secret|session|password|api[-_]?key/i;
const kSkippedHeader = /^(content-length|host|connection|accept-encoding|sec-ch-ua.*|sec-fetch-.*|upgrade-insecure-requests)$/i;

export function maskHeaders(headers: HttpHeader[], unmask = false): HttpHeader[] {
  return headers.map(h => ({ name: h.name, value: !unmask && kSecretHeader.test(h.name) ? '***' : h.value }));
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(request: { method: string, url: string, headers?: HttpHeader[], body?: string }): string {
  const lines = [`curl ${shellQuote(request.url)}`];
  if (request.method && request.method !== 'GET')
    lines.push(`  -X ${request.method}`);
  for (const h of request.headers ?? []) {
    if (!kSkippedHeader.test(h.name))
      lines.push(`  -H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  if (request.body)
    lines.push(`  --data-raw ${shellQuote(request.body)}`);
  return lines.join(' \\\n');
}
