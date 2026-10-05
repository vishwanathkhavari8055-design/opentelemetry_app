/**
 * Guards the category → product → service registry.
 *
 * The registry's rules are what make a product's count mean something:
 *  - one entry is ONE exact service_name; `IoTOpsApiSvc` (production, OTel SDK)
 *    and `iotopsapisvc` (dev/nightly pod scraper) lowercase identically, and
 *    resolving by lowercase alone would silently blend a dev environment's
 *    logs into a production product. The exact spelling must win, and the
 *    DISCOVERED spelling is what goes into the query.
 *  - the filter applied and the coverage list shown come from one function,
 *    so they cannot disagree.
 *  - nothing a category owns directly is reported as "unclaimed".
 * The data invariants (unique keys, every product in one category, no service
 * claimed twice) are asserted too: a typo there loses a row silently.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATEGORIES,
  PRODUCTS,
  categoryProducts,
  describeCategoryServices,
  describeProductServices,
  getCategory,
  getProduct,
  resolveCategoryServices,
  resolveProductServices,
  unclaimedServices,
} from '../../src/config/products.js';

const PROVISIONING = 'trinity-iot-provisioning';

describe('registry data', () => {
  it('has unique product keys, each listed by exactly one category', () => {
    const keys = PRODUCTS.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length);
    const listed = CATEGORIES.flatMap((c) => c.products);
    assert.equal(new Set(listed).size, listed.length, 'no product in two categories');
    assert.deepEqual([...listed].sort(), [...keys].sort());
  });

  it('claims each service_name once, case-insensitively, as a single non-empty string', () => {
    const services = [...PRODUCTS, ...CATEGORIES].flatMap((p) => p.services.map((s) => s.service));
    for (const s of services) assert.ok(typeof s === 'string' && s.length > 0, JSON.stringify(s));
    assert.equal(new Set(services.map((s) => s.toLowerCase())).size, services.length);
  });

  it('keeps dev/nightly deployments out of the production products', () => {
    const names = describeProductServices(PROVISIONING, []).map((r) => r.service);
    assert.deepEqual(names, ['IoTOpsSvc', 'IoTOpsLingualSvc', 'IoTOpsApiSvc', 'IoTOpsCIMService']);
  });
});

describe('getProduct / getCategory', () => {
  it('finds entries by key and returns null otherwise', () => {
    assert.equal(getProduct(PROVISIONING).family, 'trinityIoT');
    assert.equal(getProduct('nope'), null);
    assert.equal(getCategory('dlh').name, 'DLH');
    assert.equal(getCategory(undefined), null);
  });
});

describe('describeProductServices', () => {
  it('prefers the exact spelling over a case-folded twin', () => {
    const rows = describeProductServices(PROVISIONING, [
      { name: 'iotopsapisvc', count: 900 },
      { name: 'IoTOpsApiSvc', count: 12 },
    ]);
    const api = rows.find((r) => r.service === 'IoTOpsApiSvc');
    assert.deepEqual(api, { label: 'IoTOpsAPIService', service: 'IoTOpsApiSvc', env: null, name: 'IoTOpsApiSvc', count: 12, present: true });
  });

  it('falls back to a case-insensitive match, reporting the discovered spelling', () => {
    const rows = describeProductServices(PROVISIONING, ['iotopssvc']);
    const svc = rows.find((r) => r.service === 'IoTOpsSvc');
    assert.equal(svc.name, 'iotopssvc');
    assert.equal(svc.count, null, 'a bare string carries no count');
    assert.equal(svc.present, true);
  });

  it('keeps absent services in the list, marked not present', () => {
    const rows = describeProductServices(PROVISIONING, null);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.present === false && r.name === null && r.count === null));
  });

  it('skips malformed availability entries and unknown products', () => {
    const rows = describeProductServices(PROVISIONING, [null, { count: 3 }, { name: 'IoTOpsSvc' }]);
    assert.equal(rows.find((r) => r.service === 'IoTOpsSvc').present, true);
    assert.deepEqual(describeProductServices('nope', ['IoTOpsSvc']), []);
  });
});

describe('resolveProductServices', () => {
  it('returns only the present services, in their discovered spelling', () => {
    assert.deepEqual(
      resolveProductServices(PROVISIONING, ['IOTOPSSVC', 'IoTOpsCIMService', 'unrelated']),
      ['IOTOPSSVC', 'IoTOpsCIMService'],
    );
    assert.deepEqual(resolveProductServices('trinity-iot-api-esb', ['tiotapi']), [], 'an empty product resolves to nothing');
  });
});

describe('categoryProducts / describeCategoryServices', () => {
  it('lists a category\'s products in declared order', () => {
    const products = categoryProducts('applications');
    assert.equal(products[0].key, PROVISIONING);
    assert.equal(products.length, getCategory('applications').products.length);
    assert.deepEqual(categoryProducts('platform'), []);
    assert.deepEqual(categoryProducts('nope'), []);
  });

  it('describes the services a category owns directly', () => {
    assert.deepEqual(describeCategoryServices('dlh', [{ name: 'dlhbackendservice', count: 5 }]), [
      { label: 'dlhbackendservice', service: 'dlhbackendservice', env: null, name: 'dlhbackendservice', count: 5, present: true },
    ]);
    assert.deepEqual(describeCategoryServices('applications', ['x']), []);
    assert.deepEqual(describeCategoryServices('nope', ['x']), []);
  });
});

describe('resolveCategoryServices', () => {
  it('unions its products\' services and its own, de-duplicated', () => {
    const available = ['IoTOpsSvc', 'StreamMonitorService', 'dlhbackendservice', 'kafka1'];
    assert.deepEqual(resolveCategoryServices('applications', available), ['IoTOpsSvc', 'StreamMonitorService']);
    assert.deepEqual(resolveCategoryServices('dlh', available), ['dlhbackendservice']);
    assert.deepEqual(resolveCategoryServices('tools', available), ['kafka1']);
    assert.deepEqual(resolveCategoryServices('nope', available), []);
  });
});

describe('unclaimedServices', () => {
  it('reports only what nothing claims, including category-owned services as claimed', () => {
    assert.deepEqual(
      unclaimedServices(['IoTOpsSvc', 'dlhbackendservice', 'iotopsapisvc', 'brand-new-svc', { name: 'kafka2', count: 1 }]),
      ['brand-new-svc'],
      'iotopsapisvc is claimed loosely: a case twin is covered, not hidden',
    );
    assert.deepEqual(unclaimedServices(undefined), []);
  });
});
