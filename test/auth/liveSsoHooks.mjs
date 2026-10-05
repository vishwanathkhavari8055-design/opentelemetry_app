/**
 * Loads src/auth/constants.js as if built with VITE_SSO_MOCK=false.
 *
 * `SSO_CONFIG` is frozen and read from `import.meta.env`, which only Vite
 * fills in; under Node the mock is always on. This hook swaps the literal
 * default `'true') !==` for `'false')!==` — the SAME length, so every line and
 * column of the file stays where coverage expects it — which is exactly what
 * the build does when the flag is set to "false".
 *
 * Registered by authServiceLive.test.mjs only; each test file runs in its own
 * process, so no other test sees the live configuration.
 */
const FROM = "'true') !==";
const TO = "'false')!==";

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:') || !/\/src\/auth\/constants\.js$/.test(url)) return result;
  const source = String(result.source);
  if (!source.includes(FROM)) throw new Error('liveSsoHooks: the SSO_CONFIG.MOCK default moved; update the hook');
  return { ...result, source: source.replace(FROM, TO), shortCircuit: true };
}
