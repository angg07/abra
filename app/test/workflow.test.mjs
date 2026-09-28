import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validWorkflow, fillRefs, loopItems, readAnswer, keyOf, toNumber } from '../workflow.mjs';
import varsCore from '../vars-core.cjs';

const wf = {
  name: 'Daily claim', params: [{ name: 'member', default: 'John Smith' }],
  blocks: [
    { type: 'ai', label: 'Log in', url: '{{appUrl}}', prompt: 'Log in as {{APP_USER}}' },
    { type: 'extract', label: 'Claim', schema: { claimNo: 'string', amount: 'number', rows: 'list' } },
    { type: 'loop', label: 'Each row', over: 'ref', ref: '{{blocks.claim.rows}}', blocks: [{ type: 'validate', label: 'Row shown', prompt: '{{item.name}} is listed' }] },
  ],
};

test('a workflow is normalized; keys come from names and must be unique', () => {
  const v = validWorkflow(wf);
  assert.deepEqual(v.blocks.map(b => b.key), ['log_in', 'claim', 'each_row']);
  assert.equal(v.blocks[2].blocks[0].key, 'row_shown');
  assert.equal(keyOf('2 Buat claim!'), 'b_2_buat_claim');
  assert.throws(() => validWorkflow({ ...wf, blocks: [wf.blocks[0], wf.blocks[0]] }), /Two blocks use the key "log_in"/);
  assert.throws(() => validWorkflow({ name: 'x', blocks: [{ type: 'loop', label: 'a', csv: 'x\n1', blocks: [{ type: 'loop', label: 'b', csv: 'x\n1', blocks: [] }] }] }), /cannot be inside another loop/);
  assert.throws(() => validWorkflow({ name: 'x', blocks: [{ type: 'test', label: 't', test: 'gone' }] }, { testExists: () => false }), /choose a saved test/);
  assert.throws(() => validWorkflow({ name: 'x', blocks: [{ type: 'extract', label: 'e', schema: { 'bad name': 'string' } }] }), /letters, digits/);
});

test('references: params, earlier blocks, loop items; the rest is left alone', () => {
  const ctx = { params: { member: 'John' }, outputs: { claim: { claimNo: 'CL/1', rows: [{ name: 'A' }] } }, item: { name: 'Mary' } };
  assert.equal(fillRefs('{{params.member}} / {{blocks.claim.claimNo}} / {{item.name}} / {{appUrl}} / {{today}}', ctx), 'John / CL/1 / Mary / {{appUrl}} / {{today}}');
  assert.equal(fillRefs('{{blocks.claim.rows}}', ctx), '[{"name":"A"}]');
  assert.throws(() => fillRefs('{{blocks.nope.x}}', ctx), /has no value yet/);
});

test('loop items from CSV or from an earlier list, capped', () => {
  const ctx = { params: { who: 'Budi' }, outputs: { claim: { rows: ['a', 'b'] } } };
  assert.deepEqual(loopItems({ over: 'csv', csv: 'member\n{{params.who}}\nMary' }, ctx, varsCore.parseCsv), [{ member: 'Budi' }, { member: 'Mary' }]);
  assert.deepEqual(loopItems({ over: 'ref', ref: '{{blocks.claim.rows}}' }, ctx, varsCore.parseCsv), ['a', 'b']);
  assert.throws(() => loopItems({ over: 'ref', ref: '{{params.who}}' }, ctx, varsCore.parseCsv), /is not a list/);
});

test('numbers as pages show them, Indonesian and English', () => {
  assert.equal(toNumber('Rp 500.000'), 500000);
  assert.equal(toNumber('Rp 1.250.000,50'), 1250000.5);
  assert.equal(toNumber('$1,250,000.50'), 1250000.5);
  assert.equal(toNumber('12,5'), 12.5);
  assert.equal(toNumber('42'), 42);
  assert.equal(toNumber('n/a'), null);
});

test('reading the AI: extract JSON by schema, validate YES/NO', () => {
  const b = { type: 'extract', schema: { claimNo: 'string', amount: 'number', rows: 'list' } };
  const ok = readAnswer(b, 'RESULT: SUCCESS\n```json\n{"claimNo":"CL/1","amount":"Rp 500.000","rows":"one"}\n```\nFound it.');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.output, { claimNo: 'CL/1', amount: 500000, rows: ['one'] });
  assert.equal(readAnswer(b, 'RESULT: SUCCESS\n```json\n{"claimNo":"CL/1"}\n```').ok, false); // fields missing
  assert.match(readAnswer(b, 'RESULT: SUCCESS\n```json\n{oops}\n```').evidence, /not valid JSON/);
  assert.equal(readAnswer({ type: 'validate' }, 'VALID: YES\nThe status is Submitted').ok, true);
  assert.equal(readAnswer({ type: 'validate' }, 'VALID: NO\nIt says Draft').ok, false);
  assert.equal(readAnswer({ type: 'ai' }, 'RESULT: FAILED\nNo button').ok, false);
});
