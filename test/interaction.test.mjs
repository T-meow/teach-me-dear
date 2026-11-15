import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { digest } from '../src/observe.mjs';
import { captureScript } from '../src/capture.mjs';
import { runWindowScript } from '../src/windows.mjs';
import { screenDecision, isCompletion } from '../src/feedback.mjs';

const step = (kind = 'file_exists') => ({ goal: '完成当前目标', action: '按要求操作', expected: '目标达成', standard: '核对当前目标', check: { kind, target: kind === 'screen' ? 'godot' : 'exercise.txt' } });
const windows = [{ id: '101:11:1000', title: 'Godot - 工程甲', pid: 101, process: 'godot' }, { id: '202:22:2000', title: 'Godot - 工程乙', pid: 202, process: 'godot' }];
function setup(t, { listing = async () => windows, observer } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-dear-interaction-'));
  const store = new Store(path.join(root, 'data'));
  const engine = new Engine(store, observer, listing);
  let state, serial = 0;
  const call = async (name, extra = {}) => {
    const result = await engine.call(name, { hostSession: 'codex:a', lessonId: state.lessonId, revision: state.revision, ...extra });
    state = result.state; return state;
  };
  const reply = async text => {
    store.recordUser('codex:a', `event-${++serial}`, text);
    if (state) state = (await engine.call('coach_status', { hostSession: 'codex:a' })).state;
  };
  t.after(() => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('teach-me-dear-interaction-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, engine, call, reply, get state() { return state; },
    start: async (steps = [step()]) => {
      await reply('教我完成练习');
      state = (await engine.call('coach_start', { hostSession: 'codex:a', title: '互动练习', workspace: root, steps })).state;
      return state;
    } };
}
const fakeScreen = async (lesson, _directory, user) => {
  const s = lesson.steps[lesson.index];
  return { id: `${s.attempt}-${user.event}`, kind: 'screen', target: s.check.target, stepId: s.id, attempt: s.attempt,
    ok: true, passed: null, userEvent: user.event, windowId: lesson.screenBindings?.[s.check.target]?.id,
    criteriaHash: digest({ standard: s.standard, check: s.check }), detail: 'synthetic window evidence' };
};

test('inspection and an existing file cannot complete successive steps without new feedback', async t => {
  const f = setup(t); await f.start([step(), step()]);
  fs.writeFileSync(path.join(f.root, 'exercise.txt'), 'already exists');
  await assert.rejects(f.call('coach_observe'), /新操作反馈/);
  await f.call('coach_observe', { purpose: 'inspect' });
  assert.equal(f.state.current.inspection.passed, true);
  assert.equal(f.state.current.verification, null);
  await assert.rejects(f.call('coach_next'), /尚未通过/);
  await f.reply('可以');
  await assert.rejects(f.call('coach_observe'), /新操作反馈/);
  await f.reply('这一步做完了');
  await f.call('coach_observe'); await f.call('coach_next');
  await assert.rejects(f.call('coach_observe'), /新操作反馈/);
  await assert.rejects(f.call('coach_control', { action: 'skip', reason: 'AI想省事' }), /新操作反馈/);
  await f.reply('给我一点提示');
  await assert.rejects(f.call('coach_control', { action: 'skip', reason: 'AI想省事' }), /用户明确/);
});

test('short screenshot confirmation needs a fresh answer to the exact selected window', async t => {
  const f = setup(t, { listing: async () => [windows[0]], observer: fakeScreen });
  await f.start([step('screen')]); await f.call('coach_windows');
  await f.reply('可以');
  await assert.rejects(f.call('coach_control', { action: 'allow_screen' }), /明确授权/);
  await f.call('coach_control', { action: 'request_screen' });
  await assert.rejects(f.call('coach_control', { action: 'allow_screen' }), /明确授权/);
  await f.reply('可以'); await f.call('coach_control', { action: 'allow_screen' });
  assert.equal(f.state.current.screenshotAllowed, true);
  await assert.rejects(f.call('coach_observe'), /新操作反馈/);
  await f.reply('别截图了');
  assert.equal(f.state.current.screenshotAllowed, false);
  await f.call('coach_control', { action: 'request_screen' });
  await f.reply('给我一个提示'); await f.reply('可以');
  await assert.rejects(f.call('coach_control', { action: 'allow_screen' }), /明确授权/);
});

test('ambiguous windows require user choice; consent preserves earlier exercise feedback', async t => {
  const f = setup(t, { observer: fakeScreen });
  await f.start([step('screen')]); await f.reply('我做好了');
  await f.call('coach_windows'); assert.equal(f.state.current.selectedWindow, null);
  await assert.rejects(f.call('coach_select_window', { windowId: windows[0].id }), /用户明确选择/);
  await f.reply('第二个，可以截吧');
  await assert.rejects(f.call('coach_select_window', { windowId: windows[0].id }), /用户明确选择/);
  await f.call('coach_select_window', { windowId: windows[1].id });
  await f.call('coach_control', { action: 'allow_screen' });
  assert.equal(f.state.current.selectedWindow.title, windows[1].title);
  assert.equal(f.state.current.feedbackRequired, false);
  await f.call('coach_observe');
  await f.call('coach_verify', { evidenceId: f.state.current.evidence.id, verdict: 'pass', reason: '匹配选定窗口' });
  await f.call('coach_next'); assert.equal(f.state.phase, 'complete');
});

test('a reopened window does not inherit the old window permission', async t => {
  let currentWindows = [windows[0]];
  const f = setup(t, { listing: async () => currentWindows });
  await f.start([step('screen')]); await f.call('coach_windows');
  await f.reply('可以，截吧'); await f.call('coach_control', { action: 'allow_screen' });
  currentWindows = [{ ...windows[0], id: '101:11:9999' }];
  await f.call('coach_windows');
  assert.equal(f.state.current.screenshotAllowed, false);
  await assert.rejects(f.call('coach_control', { action: 'allow_screen' }), /另一窗口/);
});

test('self reports accept natural Chinese but retain their classification and reject questions', async t => {
  const f = setup(t); await f.start([step('manual')]);
  await f.reply('我这步算完成了吗？'); await f.call('coach_observe');
  await assert.rejects(f.call('coach_verify', { evidenceId: f.state.current.evidence.id, verdict: 'pass', reason: '猜测' }), /直接说明/);
  await f.reply('这步我自己做完了'); await f.call('coach_observe');
  await f.call('coach_verify', { evidenceId: f.state.current.evidence.id, verdict: 'pass', reason: '用户确认完成' });
  await f.call('coach_next'); assert.equal(f.state.progress.selfReported, 1);
});

test('replanning preserves assistance and resets feedback; capture errors are not learner failures', async t => {
  const f = setup(t); await f.start([{ ...step(), check: { kind: 'file_contains', target: 'absent.txt', expected: 'hello' } }]);
  await f.call('coach_control', { action: 'hint', reason: '给出提示' });
  await f.reply('我已经做完了'); await f.call('coach_observe');
  assert.equal(f.state.current.failures, 0); assert.equal(f.state.current.checkErrors, 1);
  await f.call('coach_replan', { steps: [step()], reason: '拆小目标' });
  assert.equal(f.state.current.hints, 1); assert.equal(f.state.current.feedbackRequired, true);
});

test('quoted grants and negated/question completion statements do not count', () => {
  assert.equal(screenDecision('可以，截吧'), 'grant');
  assert.equal(screenDecision('允许截图这句话是什么意思'), null);
  assert.equal(screenDecision('他说“允许截图”'), null);
  assert.equal(screenDecision('暂不截图'), 'deny');
  assert.equal(isCompletion('我还没有做完'), false);
  assert.equal(isCompletion('你说的“完成了”是什么意思'), false);
  assert.equal(isCompletion('完成了，继续吧'), true);
});

test('generated PowerShell window binding script parses without touching the desktop', { skip: process.platform !== 'win32' }, () => {
  const script = captureScript({ target: 'godot', outPath: '', maxWidth: 1440, maxHeight: 900, selfPid: process.pid, listOnly: true });
  const payload = Buffer.from(script, 'utf16le').toString('base64');
  const validator = '$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}';
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(validator, 'utf16le').toString('base64')], { input: payload, windowsHide: true, timeout: 15000 });
});

test('Windows bootstrap enumerates without capturing or exposing unrelated windows', { skip: process.platform !== 'win32' }, async () => {
  const result = await runWindowScript({ target: '__teach_me_dear_no_matching_window__', listOnly: true });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.windows, []);
});
