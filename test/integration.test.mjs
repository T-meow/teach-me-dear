import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { apply } from '../adapters/dsh/index.mjs';

test('real MCP transport, DSH bridge and Codex hook share one course', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-dear-integration-'));
  const workspace = path.join(root, 'practice'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const previous = process.env.FROSTFORGE_COACH_DATA;
  process.env.FROSTFORGE_COACH_DATA = data;
  const client = new Client({ name: 'integration-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))],
      env: { ...process.env, FROSTFORGE_COACH_DATA: data }, stderr: 'pipe',
    }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 11);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent || JSON.parse(result.content[0].text);
    };
    const started = await call('coach_start', { hostSession: 'codex:test', title: '桥接测试', workspace,
      steps: [{ goal: '创建文件', action: '手动创建文件', expected: '文件存在', standard: 'exercise.txt 存在', check: { kind: 'file_exists', target: 'exercise.txt' } }] });
    const hook = input => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../bin/codex-hook.mjs', import.meta.url))], {
      input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: { ...process.env, FROSTFORGE_COACH_DATA: data },
    }) || '{}');
    const denied = hook({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(hook({ session_id: 'unrelated', hook_event_name: 'PreToolUse', tool_name: 'Bash' }), {});
    const context = hook({ session_id: 'test', turn_id: 'turn1', hook_event_name: 'UserPromptSubmit', prompt: '做完了' });
    assert.match(context.hookSpecificOutput.additionalContext, /桥接测试/);
    for (const [index, prompt] of ['退出教教我', '退出教学模式'].entries()) {
      hook({ session_id: 'test', turn_id: `exit-${index}`, hook_event_name: 'UserPromptSubmit', prompt });
      assert.equal((await call('coach_status', { hostSession: 'codex:test' })).state, null);
      assert.deepEqual(hook({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash' }), {});
      await call('coach_open', { hostSession: 'codex:test', lessonId: started.state.lessonId });
    }

    const definitions = new Map(); let contextProvider, guard;
    const ctx = {
      tools: { register: definition => definitions.set(definition.name, definition), guard: fn => { guard = fn; } },
      systemPrompt: { context: value => { contextProvider = value; return () => {}; } },
      effect: fn => fn(), get: () => undefined,
    };
    apply(ctx, { nodePath: process.execPath });
    assert.equal(definitions.size, 11); assert.ok(guard({ name: 'write' }));
    const messages = [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续刚才的课程' }] } }];
    const session = { header: { id: 'bridge' }, seq: 1, snapshotEvents: () => messages };
    const execution = { agent: { session } };
    const opened = await definitions.get('coach_open').execute({ lessonId: started.state.lessonId }, execution);
    assert.equal(opened.state.title, '桥接测试');
    assert.match(contextProvider.text({ agent: { session } }), /dsh:bridge/);
    await assert.rejects(definitions.get('coach_observe').execute({ lessonId: opened.state.lessonId, revision: opened.state.revision }, execution), /新操作反馈/);
    fs.writeFileSync(path.join(workspace, 'exercise.txt'), 'created by the test learner');
    messages.push({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我已经创建好了' }] } });
    session.seq = 2;
    let state = (await definitions.get('coach_observe').execute({ lessonId: opened.state.lessonId, revision: opened.state.revision }, execution)).state;
    assert.equal(state.current.verification.verdict, 'pass');
    state = (await definitions.get('coach_next').execute({ lessonId: state.lessonId, revision: state.revision }, execution)).state;
    assert.equal(state.phase, 'complete');
    const listed = await call('coach_list', {});
    assert.equal(listed.lessons[0].phase, 'complete');
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.FROSTFORGE_COACH_DATA; else process.env.FROSTFORGE_COACH_DATA = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('teach-me-dear-integration-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
