/**
 * A recording stand-in for global fetch, shared by the service-client tests.
 *
 * Each test installs one with `stubFetch(responder)` and the returned `restore`
 * puts the real fetch back (call it from afterEach). Every request is recorded
 * with its URL parsed against a dummy origin, so assertions can read the path
 * and query params without caring whether the client sent a relative URL.
 */

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export const text = (body, status = 200) => new Response(body, { status });

export const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * @param {(url: string, options: object, call: object) => Response|Promise<Response>} responder
 *   answers each request; throwing / rejecting simulates a network failure.
 */
export function stubFetch(responder = () => json({})) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const call = {
      raw: url,
      url: new URL(url, 'http://test.invalid'),
      options,
      method: options?.method ?? 'GET',
      body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body,
    };
    calls.push(call);
    return responder(url, options, call);
  };
  return {
    calls,
    get last() { return calls[calls.length - 1]; },
    restore() { globalThis.fetch = original; },
  };
}

/** Query params of a recorded call as a plain object; repeated keys become arrays. */
export const paramsOf = (call) => {
  const out = {};
  for (const [k, v] of call.url.searchParams) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
};
