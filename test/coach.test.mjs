import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { allowedDuringCoaching } from '../src/policy.mjs';
import { digest } from '../src/observe.mjs';

const step = (kind = 'file_contains', target = 'exercise.txt') => ({ goal: '完成练习', action: '手动编辑练习文件', expected: '文件含 hello', standard: '包含 hello', check: { kind, target, ...(kind === 'file_contains' ? { expected: 'hello' } : {}) } });
export function fixture(t, observer, windowLister = async () => [{ id: 'win-1', title: '练习窗口', pid: 101, process: 'test-window' }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-dear-test-'));
  const workspace = path.join(root, 'practice'); fs.mkdirSync(workspace);
  const store = new Store(path.join(root, 'data'));
  const engine = new Engine(store, observer, windowLister);
  const extraStores = [];
  t.after(() => {
    for (const connection of extraStores) connection.close();
    store.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('teach-me-dear-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = async (steps = [step()]) => {
    store.recordUser('codex:a', 'opening', '教我完成这个练习');
    return (await engine.call('coach_start', { hostSession: 'codex:a', title: '练习', workspace, steps })).state;
  };
  let feedbackNumber = 0;
  const respond = (text = '我做完了') => store.recordUser('codex:a', `reply-${++feedbackNumber}`, text);
  const args = state => ({ hostSession: 'codex:a', lessonId: state.lessonId, revision: state.revision });
  return { root, workspace, store, engine, start, args, extraStores, respond };
}

test('real file failure cannot be overridden; new evidence passes and advances', async t => {
  const f = fixture(t); let s = await f.start();
  fs.writeFileSync(path.join(f.workspace, 'exercise.txt'), 'wrong');
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  assert.equal(s.current.verification.verdict, 'fail');
  await assert.rejects(f.engine.call('coach_next', f.args(s)), /尚未通过/);
  await assert.rejects(f.engine.call('coach_verify', { ...f.args(s), evidenceId: s.current.evidence.id, verdict: 'pass', reason: '口头声明' }));
  fs.writeFileSync(path.join(f.workspace, 'exercise.txt'), 'hello');
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  s = (await f.engine.call('coach_next', f.args(s))).state;
  assert.equal(s.phase, 'complete'); assert.equal(s.progress.independent, 1);
});

test('cross-host resume survives another process connection and rejects stale writers', async t => {
  const f = fixture(t); const s = await f.start();
  const other = new Store(path.join(f.root, 'data')); f.extraStores.push(other);
  const dsh = new Engine(other);
  const opened = (await dsh.call('coach_open', { hostSession: 'dsh:b', lessonId: s.lessonId })).state;
  assert.equal(opened.title, s.title);
  await assert.rejects(f.engine.call('coach_control', { ...f.args(s), action: 'pause' }), /另一个聊天/);
  const stale = { hostSession: 'dsh:b', lessonId: s.lessonId, revision: s.revision, action: 'pause' };
  await assert.rejects(dsh.call('coach_control', stale), /revision/);
});

test('replan invalidates evidence and keeps completed progress', async t => {
  const f = fixture(t); let s = await f.start([step(), step()]);
  fs.writeFileSync(path.join(f.workspace, 'exercise.txt'), 'hello');
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  s = (await f.engine.call('coach_next', f.args(s))).state;
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  const old = s.current.evidence.id;
  s = (await f.engine.call('coach_replan', { ...f.args(s), steps: [step('file_exists', 'different.txt')], reason: '改目标' })).state;
  assert.equal(s.progress.independent, 1); assert.equal(s.current.evidence, null);
  f.respond();
  await assert.rejects(f.engine.call('coach_verify', { ...f.args(s), evidenceId: old, verdict: 'pass', reason: '旧证据' }), /不匹配/);
});

test('pause blocks checks; back invalidates old results; explicit skip stays skipped', async t => {
  const f = fixture(t); let s = await f.start([step(), step()]);
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'pause' })).state;
  await assert.rejects(f.engine.call('coach_observe', f.args(s)), /恢复/);
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'resume' })).state;
  f.respond('这一步先跳过');
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'skip', reason: '用户选择' })).state;
  s = (await f.engine.call('coach_next', f.args(s))).state;
  assert.equal(s.progress.skipped, 1);
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'back' })).state;
  assert.equal(s.progress.skipped, 0); assert.equal(s.current.verification, null);
});

test('manual result needs a real user event and remains self-reported', async t => {
  const f = fixture(t); let s = await f.start([step('manual', '用户操作')]);
  f.respond('还不太确定');
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  const verify = () => f.engine.call('coach_verify', { ...f.args(s), evidenceId: s.current.evidence.id, verdict: 'pass', reason: '用户自评' });
  await assert.rejects(verify(), /用户直接说/);
  f.store.recordUser('codex:a', 'turn2', '我已独立完成');
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  s = (await verify()).state;
  s = (await f.engine.call('coach_next', f.args(s))).state;
  assert.equal(s.progress.selfReported, 1); assert.equal(s.progress.independent, 0);
});

test('screenshot consent comes from user event and is limited to the selected target', async t => {
  const f = fixture(t); let s = await f.start([step('screen', 'blender')]);
  s = (await f.engine.call('coach_windows', f.args(s))).state;
  await assert.rejects(f.engine.call('coach_control', { ...f.args(s), action: 'allow_screen' }), /明确授权/);
  f.store.recordUser('codex:a', 'turn2', '允许截图');
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'allow_screen' })).state;
  assert.equal(s.current.screenshotAllowed, true);
  s = (await f.engine.call('coach_replan', { ...f.args(s), reason: '换软件', steps: [step('screen', 'godot')] })).state;
  assert.equal(s.current.screenshotAllowed, false);
});

test('path traversal and symlink escape cannot be used for file evidence', async t => {
  const f = fixture(t);
  await assert.rejects(f.start([step('file_exists', '../outside.txt')]), /工作目录/);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'x.txt'), 'hello');
  fs.symlinkSync(external, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  let s = await f.start([step('file_contains', 'escape/x.txt')]);
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  assert.equal(s.current.evidence.ok, false); assert.match(s.current.evidence.detail, /链接/);
});

test('hints change mastery classification and guard blocks alternate execution tools', async t => {
  const f = fixture(t); let s = await f.start();
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'hint', reason: '给一个提示' })).state;
  fs.writeFileSync(path.join(f.workspace, 'exercise.txt'), 'hello');
  f.respond();
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  s = (await f.engine.call('coach_next', f.args(s))).state;
  assert.equal(s.progress.assisted, 1);
  for (const name of ['Bash', 'apply_patch', 'mcp__fastctx__replace', 'mcp__node_repl__js', 'spawn_agent']) assert.equal(allowedDuringCoaching(name), false);
  assert.equal(allowedDuringCoaching('mcp__teach_me_dear__coach_observe'), true);
  assert.equal(allowedDuringCoaching('mcp__fastctx__inspect_local_file'), true);
});

test('screenshots become stale after feedback and retry budget resets on new feedback', async t => {
  let serial = 0;
  const f = fixture(t, async (lesson, _dir, user) => {
    const s = lesson.steps[lesson.index];
    return { id: `screen-${++serial}`, stepId: s.id, attempt: s.attempt,
      criteriaHash: digest({ standard: s.standard, check: s.check }), kind: 'screen', target: s.check.target,
      ok: true, passed: null, windowId: lesson.screenBindings?.[s.check.target]?.id,
      userEvent: user?.event || '', detail: 'synthetic window observation' };
  });
  let s = await f.start([step('screen', 'test-window')]);
  s = (await f.engine.call('coach_windows', f.args(s))).state;
  f.respond('允许截图');
  s = (await f.engine.call('coach_control', { ...f.args(s), action: 'allow_screen' })).state;
  f.store.recordUser('codex:a', 'turn1', '做完了');
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  f.store.recordUser('codex:a', 'turn2', '又改了一次');
  await assert.rejects(f.engine.call('coach_verify', { ...f.args(s), evidenceId: s.current.evidence.id, verdict: 'pass', reason: '旧画面' }), /重新取证/);
  for (let i = 0; i < 3; i++) s = (await f.engine.call('coach_observe', f.args(s))).state;
  await assert.rejects(f.engine.call('coach_observe', f.args(s)), /3 次/);
  f.store.recordUser('codex:a', 'turn3', '窗口已经恢复');
  s = (await f.engine.call('coach_observe', f.args(s))).state;
  assert.equal(s.current.evidence.userEvent, 'turn3');
});
