import { Store } from '../src/store.mjs';
import { view } from '../src/engine.mjs';
import { allowedDuringCoaching, compactContext, DENIAL, isTeachingRequest, isTeachingExit } from '../src/policy.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let store;
try {
  const event = JSON.parse(raw || '{}');
  const session = `codex:${event.session_id}`;
  if (!event.session_id) throw new Error('教教我 Hook 缺少 session_id。');
  store = new Store();
  if (event.hook_event_name === 'UserPromptSubmit') {
    if (store.bound(session) || isTeachingRequest(event.prompt || '')) {
      store.recordUser(session, event.turn_id || `${Date.now()}`, event.prompt || '');
    }
    // A direct user exit request releases host guards even if the model fails to call a tool.
    if (isTeachingExit(event.prompt || '')) store.unbind(session);
  }
  const id = store.bound(session);
  const state = id ? view(store.get(id), session, store.exerciseUser(session)) : null;
  if (event.hook_event_name === 'PreToolUse') {
    const name = event.tool_name || '';
    if (state?.phase === 'active' && !allowedDuringCoaching(name)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENIAL,
      } }));
    }
  } else if (['SessionStart', 'UserPromptSubmit', 'PostCompact'].includes(event.hook_event_name)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: event.hook_event_name, additionalContext: compactContext(state, session),
    } }));
  }
} catch (error) {
  process.stderr.write(`教教我 Hook：${error.message}\n`);
  // Exit 2 explicitly denies a supported pending tool. Do not silently continue with broken state.
  try { if (JSON.parse(raw).hook_event_name === 'PreToolUse') process.exitCode = 2; } catch {}
} finally { store?.close(); }
