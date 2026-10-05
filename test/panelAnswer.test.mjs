/**
 * When a dynamic text panel's script runs — see src/grafana/panelAnswer.js.
 *
 * Every "true" here is a full run of the panel's script, which on OSS Engine
 * Overview is ~40 queries. A first load used to answer "true" three times.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAnswer } from '../src/grafana/panelAnswer.js';

const request = { requestId: 'SQR1' };
const frame = { fields: [], length: 0 };

describe('isAnswer, for a panel with a query', () => {
  it('waits out Scenes\' placeholder, which looks like an empty answer', () => {
    assert.equal(isAnswer({ state: 'Done', series: [] }, true), false);
    assert.equal(isAnswer(undefined, true), false);
  });

  it('waits while the query is loading, first time or refresh', () => {
    assert.equal(isAnswer({ state: 'Loading', series: [] }, true), false);
    // A refresh: Loading still carries the previous answer's frames and request.
    assert.equal(isAnswer({ state: 'Loading', series: [frame], request }, true), false);
  });

  it('runs on the answer, including an empty one', () => {
    assert.equal(isAnswer({ state: 'Done', series: [frame], request }, true), true);
    // The query ran and matched nothing: still an answer, and the script must
    // get to draw its "no data" state.
    assert.equal(isAnswer({ state: 'Done', series: [], request }, true), true);
  });

  it('treats frames or an error as an answer even without a request', () => {
    assert.equal(isAnswer({ state: 'Done', series: [frame] }, true), true);
    assert.equal(isAnswer({ state: 'Error', series: [] }, true), true);
  });
});

describe('isAnswer, for a panel with no query', () => {
  it('runs straight away — there is nothing to wait for', () => {
    assert.equal(isAnswer({ state: 'Done', series: [] }, false), true);
    assert.equal(isAnswer(undefined, false), true);
  });
});
