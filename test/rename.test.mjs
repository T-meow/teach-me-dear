import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDshPatch } from '../scripts/dsh-patch.mjs';
import { isTeachingRequest, isTeachingExit } from '../src/policy.mjs';

test('Chinese teaching and explicit exit phrases respect ordinary requests', () => {
  for (const text of ['教教我怎么使用 Godot', '手把手教我做这个', '继续上次的练习', '用 $teach-me-dear 教我']) assert.equal(isTeachingRequest(text), true);
  assert.equal(isTeachingRequest('帮我直接修复这个编译错误'), false);
  assert.equal(isTeachingExit('退出教教我！'), true);
  assert.equal(isTeachingExit('退出教学模式'), true);
  assert.equal(isTeachingExit('先不要退出教学模式'), false);
});

test('DSH migration removes duplicate old/new entries and preserves other settings and CRLF', () => {
  const unrelated = '- id: existing\r\n  config:\r\n    enabled: true\r\n';
  const original = unrelated + '# frostforge-coach:begin\r\n- id: old\r\n# frostforge-coach:end\r\n'
    + '# teach-me-dear:begin\r\n- id: duplicate\r\n# teach-me-dear:end\r\n';
  const migrated = updateDshPatch(original, '- id: preset-teach-me-dear\n  name: 教教我');
  assert.ok(migrated.startsWith(unrelated));
  assert.equal(migrated.includes('frostforge-coach'), false);
  assert.equal((migrated.match(/# teach-me-dear:begin/g) || []).length, 1);
  assert.equal(migrated.includes('duplicate'), false);
  assert.equal(/(?<!\r)\n/.test(migrated), false);
  assert.equal(updateDshPatch(migrated, '- id: preset-teach-me-dear\n  name: 教教我'), migrated);
  assert.equal(updateDshPatch(migrated).trimEnd(), unrelated.trimEnd());
});

test('DSH malformed markers stop migration before modifying configuration', () => {
  assert.throws(() => updateDshPatch('# frostforge-coach:begin\n- id: incomplete\n', '- id: new'), /标记不完整/);
});
