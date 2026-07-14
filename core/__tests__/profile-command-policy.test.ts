const assert = require('node:assert/strict');
const test = require('node:test');

const {
  alignProfileCommandsWithPortablePolicy,
} = require('../profile-command-policy') as typeof import('../profile-command-policy');

test('profile command policy alignment follows stable identity instead of array position', () => {
  const aligned = alignProfileCommandsWithPortablePolicy('test', [
    { command: 'close', commandId: 'close-step' },
    { command: 'open', commandId: 'open-step' },
  ], [
    { command: 'open', commandId: 'open-step', waitMs: 100 },
    { command: 'close', commandId: 'close-step', waitMs: 200 },
  ]);

  assert.deepEqual(aligned.map(({ command, planCommand }) => ({
    commandId: command.commandId,
    waitMs: planCommand.waitMs,
  })), [
    { commandId: 'close-step', waitMs: 200 },
    { commandId: 'open-step', waitMs: 100 },
  ]);
});

test('profile command policy alignment rejects missing and extra platform commands', () => {
  assert.throws(() => alignProfileCommandsWithPortablePolicy('test', [
    { command: 'open', commandId: 'open-step' },
  ], [
    { command: 'open', commandId: 'open-step' },
    { command: 'close', commandId: 'close-step' },
  ]), /omit portable command policy "close-step"/u);

  assert.throws(() => alignProfileCommandsWithPortablePolicy('test', [
    { command: 'open', commandId: 'open-step' },
    { command: 'extra', commandId: 'extra-step' },
  ], [
    { command: 'open', commandId: 'open-step' },
  ]), /has no matching portable command policy/u);
});

test('profile command policy alignment rejects missing or mismatched stable identity', () => {
  assert.throws(() => alignProfileCommandsWithPortablePolicy('test', [
    { command: 'toggle' },
  ], [
    { command: 'toggle', commandId: 'open-toggle' },
  ]), /require a stable commandId/u);

  assert.throws(() => alignProfileCommandsWithPortablePolicy('test', [
    { command: 'toggle', commandId: 'adapter-toggle' },
  ], [
    { command: 'toggle', commandId: 'portable-toggle' },
  ]), /has no matching portable command policy/u);
});
