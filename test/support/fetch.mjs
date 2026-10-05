/**
 * A stand-in for the backend: `stubFetch(routes)` replaces global fetch with one
 * that answers from `routes` and records every call, and returns a restore
 * function. Components reach the backend only through src/services/api.js, and
 * api.js only through fetch, so this is the one seam component tests need.
 *
 *   const { calls, restore } = stubFetch([
 *     [/\/api\/alerts$/, { list: [] }],                      // JSON body, 200
 *     [/\/api\/logs/, (url, init) => ({ status: 500, body: { message: 'x' } })],
 *   ]);
 *   ...
 *   restore();
 *
 * A route is `[matcher, answer]`. The matcher is a RegExp tested against the
 * URL, or a function `(url, init) => boolean`. The answer is a JSON-able body,
 * a `{ status, body, headers }` object (mark it with `status`), or a function
 * returning either. Unmatched requests answer 404 so a missing stub shows up as
 * the app's own error state rather than a hang.
 */
const toResponse = (answer) => {
  const isShaped = answer && typeof answer === 'object' && 'status' in answer && 'body' in answer;
  const status = isShaped ? answer.status : 200;
  const body = isShaped ? answer.body : answer;
  const headers = { 'content-type': 'application/json', ...(isShaped ? answer.headers : {}) };
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return new Response(status === 204 ? null : text, { status, headers });
};

export function stubFetch(routes = []) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const route = routes.find(([match]) => (match instanceof RegExp ? match.test(url) : match(url, init)));
    if (!route) return toResponse({ status: 404, body: { message: `no stub for ${url}` } });
    const answer = typeof route[1] === 'function' ? await route[1](url, init) : route[1];
    return toResponse(answer);
  };
  if (globalThis.window) globalThis.window.fetch = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = original;
    if (globalThis.window) globalThis.window.fetch = original;
  };
  return { calls, restore };
}
