import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';
import { isControlReply, screenDecision, isAffirmation, windowChoice, isCompletion } from './feedback.mjs';

export class Store {
  constructor(directory = DATA_DIR) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'coach-v1.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(session TEXT PRIMARY KEY, lesson TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(session TEXT PRIMARY KEY, event TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS exercise_users(session TEXT PRIMARY KEY, event TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM lessons WHERE id=?').get(id);
    if (!row) throw new Error('找不到课程。请先 coach_list，再用 coach_open 继续。');
    return JSON.parse(row.data);
  }
  list() {
    return this.db.prepare('SELECT data FROM lessons ORDER BY updated DESC LIMIT 100').all().map(row => {
      const value = JSON.parse(row.data);
      return { id: value.id, title: value.title, workspace: value.workspace, phase: value.phase,
        current: value.index + 1, total: value.steps.length, updatedAt: value.updatedAt };
    });
  }
  save(lesson, kind, detail = {}) {
    lesson.updatedAt = Date.now();
    this.db.prepare('INSERT INTO lessons VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data')
      .run(lesson.id, lesson.updatedAt, JSON.stringify(lesson));
    this.db.prepare('INSERT INTO events(lesson,at,kind,data) VALUES(?,?,?,?)')
      .run(lesson.id, lesson.updatedAt, kind, JSON.stringify(detail));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bind(session, lesson) {
    this.db.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(session) DO UPDATE SET lesson=excluded.lesson').run(session, lesson);
  }
  bound(session) { return this.db.prepare('SELECT lesson FROM bindings WHERE session=?').get(session)?.lesson; }
  unbind(session) { this.db.prepare('DELETE FROM bindings WHERE session=?').run(session); }
  user(session) { return this.db.prepare('SELECT * FROM users WHERE session=?').get(session); }
  exerciseUser(session) { return this.db.prepare('SELECT * FROM exercise_users WHERE session=?').get(session); }
  recordUser(session, event, text) {
    if (typeof session !== 'string' || !session || typeof text !== 'string') return;
    if (this.user(session)?.event === String(event)) return;
    // Keep only the most recent prompt, not another copy of the full chat transcript.
    this.transaction(() => {
      const at = Date.now();
      const id = this.bound(session);
      const lesson = id ? this.get(id) : null;
      const choosingWindow = windowChoice(text, lesson?.steps[lesson.index]?.windowOptions?.windows || []);
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET event=excluded.event,text=excluded.text,at=excluded.at')
        .run(session, String(event), text.slice(0, 16000), at);
      if (!isControlReply(text) && (!choosingWindow || isCompletion(text))) this.db.prepare('INSERT INTO exercise_users VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET event=excluded.event,text=excluded.text,at=excluded.at')
        .run(session, String(event), text.slice(0, 16000), at);
      if (lesson) {
        if (lesson.owner !== session) return;
        if (screenDecision(text) === 'deny') {
          lesson.screenGrants = []; lesson.pendingConsent = null; lesson.revision += 1;
          this.save(lesson, 'user-revoked-screenshots');
        } else if (lesson.pendingConsent && !isAffirmation(text) && screenDecision(text) !== 'grant') {
          lesson.pendingConsent = null; lesson.revision += 1;
          this.save(lesson, 'consent-question-dismissed');
        }
      }
    });
  }
  close() { this.db.close(); }
}
