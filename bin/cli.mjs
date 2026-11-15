import { Store } from '../src/store.mjs';

const store = new Store();
try {
  const action = process.argv[2] || 'status';
  const input = process.argv[3] ? JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8')) : {};
  if (input.user) store.recordUser(input.hostSession, input.user.event, input.user.text);
  let result;
  if (action === 'call') {
    const { Engine } = await import('../src/engine.mjs');
    result = await new Engine(store).call(input.name, input.args);
  } else if (action === 'context') {
    const { view } = await import('../src/engine.mjs');
    const id = store.bound(input.hostSession);
    result = { state: id ? view(store.get(id), input.hostSession, store.exerciseUser(input.hostSession)) : null };
  } else if (action === 'screen') {
    result = store.transaction(() => {
      const lesson = store.get(input.lessonId);
      const target = lesson.steps[lesson.index]?.check.target;
      const win = lesson.screenBindings?.[target];
      if (input.allow && !win) throw new Error('先在课程里选定实际窗口。');
      if (input.allow) lesson.screenGrants = [...new Set([...(lesson.screenGrants || []), win.id])];
      else lesson.screenGrants = [];
      lesson.pendingConsent = null;
      lesson.revision += 1;
      store.save(lesson, 'local-screen-setting');
      return { lessonId: lesson.id, allowedWindows: lesson.screenGrants };
    });
  } else if (action === 'status') result = { dataDirectory: store.directory, lessons: store.list() };
  else throw new Error('未知命令。可用：status / call / context / screen。');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally { store.close(); }
