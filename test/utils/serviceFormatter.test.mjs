/**
 * Guards how service names read in every picker and heading.
 *
 * Service names arrive shouting (`IOTOPSCIMSERVICE`) or in camel case
 * (`StreamMonitorService`). The first must be split on the platform's known
 * words and title-cased; the second must keep its own capitals — title-casing
 * it would turn "StreamMonitor" into "Streammonitor". Acronyms keep their
 * house spelling (IoT, CIM, SSO), and "ALL" — the picker's every-service
 * option — is never rewritten.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatServiceName } from '../../src/utils/serviceFormatter.js';

describe('formatServiceName', () => {
  it('splits an upper-case name on known words', () => {
    assert.equal(formatServiceName('COCAPPSERVICE'), 'Cocapp Service');
    assert.equal(formatServiceName('IOTOPSCIMSERVICE'), 'IoTOps CIM Service');
  });

  it('treats an all-lower-case name the same way', () => {
    assert.equal(formatServiceName('iotopscimservice'), 'IoTOps CIM Service');
    assert.equal(formatServiceName('cimpoc'), 'CIM POC');
  });

  it('keeps the longest known word whole', () => {
    assert.equal(formatServiceName('TIOTSSODASHBOARD'), 'TIoTSSODashboard');
  });

  it('turns separators into spaces and title-cases the pieces', () => {
    assert.equal(formatServiceName('my-app_svc'), 'My App Svc');
    assert.equal(formatServiceName('unknown'), 'Unknown');
  });

  it('keeps a mixed-case name\'s own capitals', () => {
    assert.equal(formatServiceName('StreamMonitorService'), 'StreamMonitor Service');
    assert.equal(formatServiceName('IoTOpsService'), 'IoTOps Service');
  });

  it('leaves the every-service option and empty input alone', () => {
    assert.equal(formatServiceName('all'), 'ALL');
    assert.equal(formatServiceName('ALL'), 'ALL');
    assert.equal(formatServiceName(''), '');
    assert.equal(formatServiceName(null), '');
  });

  it('gives the same answer on repeated calls (the keyword regex is global)', () => {
    assert.equal(formatServiceName('IOTSERVICE'), formatServiceName('IOTSERVICE'));
    assert.equal(formatServiceName('IOTSERVICE'), 'IoT Service');
  });
});
