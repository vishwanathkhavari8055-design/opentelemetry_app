/**
 * The Web Component build (wc-entry.jsx): <observability-ui> and
 * <observability-summary>, as a host page embeds them.
 *
 * What is guarded, and why:
 *  - Each element renders into its OWN shadow root, with the stylesheet
 *    injected there — styles outside a shadow root do not reach inside it.
 *  - `api-base-url` is honoured: requests go to the host's base, and a change
 *    to the attribute re-points them without a remount.
 *  - The /healthz contract probe only WARNS (a wrong base, a non-lib service,
 *    an unreachable host) — it never blocks rendering.
 *  - Removing the element unmounts React, so an embedded screen stops polling
 *    when the host takes it away.
 */
import '../../../../support/dom.mjs';
import { register } from 'node:module';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../../support/fetch.mjs';

register('./inlineCssHooks.mjs', import.meta.url);

const { act, waitFor, within } = await import('@testing-library/react');
const api = await import('../../../../../src/services/api.js');
await import('../../../../../src/wc-entry.jsx');

let fetchStub;
let logs;
let consoleSaved;

const healthz = () => fetchStub.calls.filter((c) => /\/healthz$/.test(c.url));
const said = (level, re) => logs.some(([l, msg]) => l === level && re.test(msg));

async function mountElement(tag, attrs = {}) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  await act(async () => { document.body.appendChild(el); });
  return el;
}

function stubBackend(health) {
  fetchStub = stubFetch([
    [/\/healthz$/, health],
    // Everything else the embedded screens ask for: an empty, well-formed answer.
    [() => true, { status: 404, body: { message: 'not in this test' } }],
  ]);
}

beforeEach(() => {
  logs = [];
  consoleSaved = { warn: console.warn, info: console.info, error: console.error };
  console.warn = (...a) => logs.push(['warn', a.join(' ')]);
  console.info = (...a) => logs.push(['info', a.join(' ')]);
  console.error = () => {};
});

afterEach(async () => {
  await act(async () => { document.body.innerHTML = ''; });
  fetchStub?.restore();
  api.setApiBase('');
  Object.assign(console, consoleSaved);
});

describe('<observability-ui>', () => {
  it('renders the Logs screen inside its own shadow root, with the styles', async () => {
    stubBackend({ service: 'observability-lib', backend: 'openobserve' });
    const el = await mountElement('observability-ui', { 'api-base-url': 'https://host.example/lib/api/' });
    const root = el.shadowRoot;
    assert.ok(root, 'an open shadow root');
    assert.match(root.querySelector('style').textContent, /--bg-color/);
    const mount = root.getElementById('wc-root');
    assert.ok(mount.querySelector('main.container'));
    assert.equal(document.body.querySelector('main.container'), null, 'nothing leaks into the host document');

    await waitFor(() => assert.equal(healthz().length > 0, true));
    assert.equal(healthz()[0].url, 'https://host.example/lib/api/healthz');
    await waitFor(() => assert.ok(said('info', /connected to observability-lib at https:\/\/host.example\/lib\/api \(backend=openobserve\)/)));
    // The screens' own requests go to the host's base.
    await waitFor(() => assert.ok(fetchStub.calls.some((c) => c.url.startsWith('https://host.example/lib/api/') && !/healthz/.test(c.url))));
  });

  it('re-points requests when the host changes api-base-url', async () => {
    stubBackend({ status: 503, body: { message: 'down' } });
    const el = await mountElement('observability-ui', { 'api-base-url': '/a/api' });
    await waitFor(() => assert.ok(said('warn', /\/a\/api returned HTTP 503 on \/healthz/)));
    await act(async () => { el.setAttribute('api-base-url', '/b/api'); });
    await waitFor(() => assert.ok(healthz().some((c) => c.url === '/b/api/healthz')));
    assert.equal(api.getApiBase(), '/b/api');
    // Same value again: no re-render, no second probe.
    const probes = healthz().length;
    await act(async () => { el.setAttribute('api-base-url', '/b/api'); });
    assert.equal(healthz().length, probes);
  });

  it('warns when the base answers but is not the observability lib', async () => {
    stubBackend({ service: 'something-else' });
    await mountElement('observability-ui', { 'api-base-url': '/x/api' });
    await waitFor(() => assert.ok(said('warn', /did not identify as observability-lib/)));
  });

  it('warns when the base cannot be reached, and skips the probe without a base', async () => {
    fetchStub = stubFetch([[/\/healthz$/, () => { throw new TypeError('connection refused'); }]]);
    await mountElement('observability-ui', { 'api-base-url': '/down/api' });
    await waitFor(() => assert.ok(said('warn', /could not reach \/down\/api\/healthz: connection refused/)));
    const before = healthz().length;
    await mountElement('observability-ui');
    assert.equal(healthz().length, before);
  });

  it('unmounts when removed, and remounts cleanly when re-attached', async () => {
    stubBackend({ service: 'observability-lib' });
    const el = await mountElement('observability-ui', { 'api-base-url': '/r/api', 'service-prefill': 'orders' });
    assert.ok(el.shadowRoot.getElementById('wc-root').querySelector('main.container'));
    await act(async () => { el.remove(); });
    assert.equal(el.shadowRoot.getElementById('wc-root').innerHTML, '');
    await act(async () => { document.body.appendChild(el); });
    // A fresh mount point is created for the fresh root.
    const mounts = el.shadowRoot.querySelectorAll('#wc-root');
    assert.equal(mounts.length, 2);
    assert.ok(mounts[1].querySelector('main.container'));
  });
});

describe('<observability-summary>', () => {
  it('renders the Summary screen in its shadow root and follows api-base-url', async () => {
    stubBackend({ service: 'observability-lib' });
    const el = await mountElement('observability-summary', { 'api-base-url': '/s/api' });
    const mount = el.shadowRoot.getElementById('wc-root');
    assert.ok(within(mount).getByRole('heading', { name: 'Metrics & Services' }));
    assert.match(el.shadowRoot.querySelector('style').textContent, /--bg-color/);
    await waitFor(() => assert.ok(healthz().some((c) => c.url === '/s/api/healthz')));
    await act(async () => { el.setAttribute('api-base-url', '/t/api'); });
    assert.equal(api.getApiBase(), '/t/api');
    await act(async () => { el.remove(); });
    assert.equal(mount.innerHTML, '');
  });
});
