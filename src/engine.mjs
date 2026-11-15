import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { TOOLS } from './tools.mjs';
import { observe, digest, COMMANDS } from './observe.mjs';
import { inside } from './paths.mjs';
import { feedbackKey, screenDecision, isAffirmation, isCompletion, isSkipRequest, windowChoice } from './feedback.mjs';
import { listWindows } from './windows.mjs';

const ajv = new Ajv({ allErrors: true });
const validators = new Map(TOOLS.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
const active = lesson => { if (lesson.phase !== 'active') throw new Error(`课程当前为 ${lesson.phase}，请先恢复课程。`); };
const current = lesson => lesson.steps[lesson.index];
const freshAttempt = step => ({ ...step, attempt: randomUUID(), evidence: null, inspection: null, verification: null,
  outcome: null, hints: step.hints || 0, demonstrated: step.demonstrated || false, failed: 0, checkErrors: 0,
  uncertain: 0, shots: [], windowOptions: null, waitingSession: null, feedbackAfter: null });
const hasFeedback = (lesson, session, user) => current(lesson)?.waitingSession === session
  && feedbackKey(session, user) !== null && feedbackKey(session, user) !== current(lesson)?.feedbackAfter;

function normalizeSteps(input, workspace) {
  return input.map(step => {
    const check = { ...step.check };
    if (['file_exists', 'file_contains', 'json_value'].includes(check.kind)) {
      if (!check.target || !inside(workspace, path.resolve(workspace, check.target))) throw new Error('文件核查目标必须位于课程工作目录内。');
    }
    if (check.kind === 'file_contains' && !check.expected) throw new Error('file_contains 必须填写非空 expected。');
    if (check.kind === 'json_value') {
      if (check.expected === undefined) throw new Error('json_value 必须填写 expected。');
      try { JSON.parse(check.expected); } catch { throw new Error('json_value.expected 必须是 JSON 编码的值。'); }
      if (check.pointer && !check.pointer.startsWith('/')) throw new Error('JSON Pointer 必须以 / 开头。');
    }
    if (check.kind === 'command' && !Object.hasOwn(COMMANDS, check.target)) throw new Error(`命令 ID 必须是 ${Object.keys(COMMANDS).join(', ')}。`);
    if (check.kind === 'screen' && (!check.target.trim() || check.target === 'foreground')) throw new Error('请指定实际窗口进程名或标题，不接受 foreground，避免切换聊天后截错窗口。');
    return freshAttempt({ ...step, check, id: randomUUID() });
  });
}

export function view(lesson, session, exerciseUser) {
  const step = current(lesson);
  const selectedWindow = lesson.screenBindings?.[step?.check.target] || null;
  return {
    lessonId: lesson.id, title: lesson.title, workspace: lesson.workspace, revision: lesson.revision,
    phase: lesson.phase, readOnly: lesson.owner !== session, detail: lesson.detail,
    progress: { current: Math.min(lesson.index + 1, lesson.steps.length), total: lesson.steps.length,
      independent: lesson.steps.filter(s => s.outcome === 'independent').length,
      assisted: lesson.steps.filter(s => s.outcome === 'assisted').length,
      selfReported: lesson.steps.filter(s => s.outcome === 'self_reported').length,
      skipped: lesson.steps.filter(s => s.outcome === 'skipped').length },
    roadmap: lesson.steps.map((s, index) => ({ number: index + 1, goal: s.goal, outcome: s.outcome })),
    current: lesson.phase === 'complete' || !step ? null : {
      id: step.id, goal: step.goal, action: step.action, expected: step.expected, standard: step.standard,
      check: step.check, evidence: step.evidence, verification: step.verification,
      hints: step.hints, demonstrated: step.demonstrated, failures: step.failed,
      checkErrors: step.checkErrors || 0, uncertain: step.uncertain || 0,
      inspection: step.inspection || null, feedbackRequired: !hasFeedback(lesson, session, exerciseUser),
      selectedWindow, windowOptions: step.windowOptions?.windows || [],
      screenshotAllowed: !!selectedWindow && (lesson.screenGrants || []).includes(selectedWindow.id),
    },
    consentQuestion: lesson.pendingConsent?.question || null,
    note: lesson.phase === 'paused' ? '课程已暂停。恢复前不继续布置操作。'
      : lesson.phase === 'complete' ? '课程完成。按完成方式复盘，不把跳过或演示算成独立掌握。'
        : step?.checkErrors >= 2 ? '取证多次失败：请排查窗口、路径或读取方式；这不等于用户没学会。'
          : step?.failed >= 3 ? '已连续失败：换一种解释、拆小目标、调整证据，或让用户选择跳过/暂停。' : undefined,
  };
}

export class Engine {
  constructor(store, observer = observe, windowLister = listWindows) { this.store = store; this.observer = observer; this.windowLister = windowLister; }
  snapshot(lesson, session) { return view(lesson, session, this.store.exerciseUser(session)); }
  arm(lesson, session) {
    const step = current(lesson);
    if (!step) return;
    step.waitingSession = session;
    step.feedbackAfter = feedbackKey(session, this.store.exerciseUser(session));
    step.evidence = null; step.verification = null; step.windowOptions = null;
    lesson.pendingConsent = null;
  }
  requireFeedback(lesson, session) {
    const user = this.store.exerciseUser(session);
    if (!hasFeedback(lesson, session, user)) throw new Error('请先给出本步目标并等待用户的新操作反馈。选窗、授权或简单应答不算完成；预查环境可以用 purpose="inspect"。');
    return user;
  }
  bindWindow(lesson, window) {
    const step = current(lesson), previous = lesson.screenBindings?.[step.check.target];
    lesson.screenBindings ||= {};
    lesson.screenBindings[step.check.target] = window;
    if (previous?.id !== window?.id) {
      step.evidence = null; step.verification = null; lesson.pendingConsent = null;
    }
  }
  resolve(args) { return args.lessonId || this.store.bound(args.hostSession); }
  owned(args, { requireActive = true } = {}) {
    const lesson = this.store.get(args.lessonId);
    if (this.store.bound(args.hostSession) !== lesson.id || lesson.owner !== args.hostSession) throw new Error('这门课程已由另一个聊天接管，或尚未绑定。先 coach_open；不要并行推进同一课程。');
    if (lesson.revision !== args.revision) throw new Error('课程已变化：revision 过期。请 coach_status 读取最新步骤再决定操作。');
    if (requireActive) active(lesson);
    return lesson;
  }
  change(args, kind, fn, options) {
    return this.store.transaction(() => {
      const lesson = this.owned(args, options);
      fn(lesson);
      lesson.revision += 1;
      this.store.save(lesson, kind);
      return { state: this.snapshot(lesson, args.hostSession) };
    });
  }
  async call(name, args = {}) {
    const validate = validators.get(name);
    if (!validate) throw new Error('未知教练工具。');
    if (!validate(args)) throw new Error(`参数错误：${ajv.errorsText(validate.errors)}`);
    if (name === 'coach_list') return { lessons: this.store.list() };
    if (name === 'coach_status') {
      const id = this.resolve(args);
      return id ? { state: this.snapshot(this.store.get(id), args.hostSession) } : { hostSession: args.hostSession, state: null, message: '当前聊天没有课程。可 coach_start 或 coach_list。' };
    }
    if (name === 'coach_start') {
      if (!path.isAbsolute(args.workspace) || !fs.statSync(args.workspace).isDirectory()) throw new Error('workspace 必须是现有目录的绝对路径。');
      const workspace = fs.realpathSync(args.workspace);
      const lesson = { schemaVersion: 1, id: randomUUID().slice(0, 8), title: args.title, workspace,
        steps: normalizeSteps(args.steps, workspace), index: 0, revision: 1, phase: 'active',
        detail: args.detail || 2, owner: args.hostSession, screenBindings: {}, screenGrants: [], consentEvents: {}, createdAt: Date.now() };
      this.arm(lesson, args.hostSession);
      return this.store.transaction(() => {
        this.store.save(lesson, 'start'); this.store.bind(args.hostSession, lesson.id);
        return { state: this.snapshot(lesson, args.hostSession) };
      });
    }
    if (name === 'coach_open') {
      return this.store.transaction(() => {
        const lesson = this.store.get(args.lessonId);
        if (lesson.owner !== args.hostSession || !current(lesson)?.waitingSession) this.arm(lesson, args.hostSession);
        lesson.owner = args.hostSession; lesson.revision += 1;
        this.store.bind(args.hostSession, lesson.id); this.store.save(lesson, 'open', { hostSession: args.hostSession });
        return { state: this.snapshot(lesson, args.hostSession) };
      });
    }
    if (name === 'coach_windows') {
      const lesson = this.owned(args), step = current(lesson);
      if (step.check.kind !== 'screen') throw new Error('当前步骤不需要窗口截图。');
      const userKey = feedbackKey(args.hostSession, this.store.user(args.hostSession));
      const windows = await this.windowLister(step.check.target);
      return this.change(args, 'windows', fresh => {
        if (feedbackKey(args.hostSession, this.store.user(args.hostSession)) !== userKey) throw new Error('列窗期间收到新反馈，请重新列出。');
        const s = current(fresh);
        s.windowOptions = { windows, userKey };
        const bound = fresh.screenBindings?.[s.check.target];
        if (bound && windows.some(win => win.id === bound.id)) this.bindWindow(fresh, windows.find(win => win.id === bound.id));
        else this.bindWindow(fresh, windows.length === 1 ? windows[0] : null);
      });
    }
    if (name === 'coach_select_window') return this.change(args, 'select-window', lesson => {
      const options = current(lesson).windowOptions;
      const user = this.store.user(args.hostSession);
      if (!options || feedbackKey(args.hostSession, user) === options.userKey
        || windowChoice(user?.text || '', options.windows) !== args.windowId) {
        throw new Error('请先列出窗口，等待用户明确选择（如“第二个”），再绑定相应 windowId。');
      }
      const selected = options.windows.find(win => win.id === args.windowId);
      if (!selected) throw new Error('窗口不在当前候选列表中，请重新列出。');
      this.bindWindow(lesson, selected);
    });
    if (name === 'coach_observe') {
      const lesson = this.owned(args);
      const step = current(lesson);
      const purpose = args.purpose || 'verify';
      const exerciseUser = purpose === 'verify' ? this.requireFeedback(lesson, args.hostSession) : this.store.exerciseUser(args.hostSession);
      const user = this.store.user(args.hostSession);
      if (step.check.kind === 'screen' && step.shots.filter(s => s.event === (user?.event || '')).length >= 3) {
        throw new Error('本轮已截图 3 次。请说明失败原因，等用户调整窗口并回复后再试，或改用其他核查方式。');
      }
      const evidence = await this.observer(lesson, this.store.directory, user);
      evidence.purpose = purpose; evidence.sourceSession = args.hostSession;
      evidence.feedbackKey = feedbackKey(args.hostSession, exerciseUser);
      const output = this.change(args, 'observe', fresh => {
        if ((this.store.user(args.hostSession)?.event || '') !== evidence.userEvent) throw new Error('取证期间收到新反馈，请按最新反馈重新取证。');
        const s = current(fresh);
        if (purpose === 'inspect') s.inspection = evidence;
        else { s.evidence = evidence; s.verification = null; s.outcome = null; }
        if (s.check.kind === 'screen') s.shots.push({ event: evidence.userEvent });
        if (!evidence.ok) s.checkErrors = (s.checkErrors || 0) + 1;
        if (purpose === 'verify' && evidence.ok && typeof evidence.passed === 'boolean') {
          s.verification = { verdict: evidence.passed ? 'pass' : 'fail', source: 'program', evidenceId: evidence.id, feedbackKey: evidence.feedbackKey, reason: evidence.detail };
          if (!evidence.passed) s.failed += 1;
        }
      });
      return { ...output, ...(evidence.imagePath ? { imagePath: evidence.imagePath } : {}) };
    }
    if (name === 'coach_verify') return this.change(args, 'verify', lesson => {
      const step = current(lesson), evidence = step.evidence;
      const user = this.requireFeedback(lesson, args.hostSession);
      if (!evidence || evidence.id !== args.evidenceId || evidence.attempt !== step.attempt
        || evidence.stepId !== step.id || evidence.criteriaHash !== digest({ standard: step.standard, check: step.check })) {
        throw new Error('证据与当前步骤、核查对象或验收标准不匹配。先 coach_observe。');
      }
      if (!evidence.ok) throw new Error('取证失败，不能提交通过结论。请重试或调整核查方式。');
      if (step.verification?.evidenceId === evidence.id) throw new Error('这份证据已经判定。重复判定必须重新取证。');
      if (typeof evidence.passed === 'boolean') throw new Error('本步由程序验收，模型不能覆盖程序结论。');
      if (evidence.sourceSession !== args.hostSession || evidence.feedbackKey !== feedbackKey(args.hostSession, user)) throw new Error('这是最新操作反馈之前或另一个聊天的证据，请重新取证。');
      if (step.check.kind === 'screen' && (!evidence.windowId || lesson.screenBindings?.[step.check.target]?.id !== evidence.windowId
        || !(lesson.screenGrants || []).includes(evidence.windowId))) throw new Error('截图窗口已切换或授权已撤回，请重新选择、授权并取证。');
      if (step.check.kind === 'manual' && args.verdict === 'pass' && !isCompletion(user?.text || '')) {
        throw new Error('请用户直接说明是否完成，例如“这步我自己做完了”或“自评通过”；模型不能替用户确认。');
      }
      step.verification = { verdict: args.verdict, source: step.check.kind === 'manual' ? 'self_report' : 'vision', evidenceId: evidence.id, feedbackKey: evidence.feedbackKey, reason: args.reason };
      if (args.verdict === 'fail') step.failed += 1;
      if (args.verdict === 'uncertain') step.uncertain = (step.uncertain || 0) + 1;
    });
    if (name === 'coach_next') return this.change(args, 'next', lesson => {
      const step = current(lesson);
      if (step.outcome !== 'skipped' && step.verification?.verdict !== 'pass') throw new Error('当前步骤尚未通过或明确跳过。');
      const user = this.requireFeedback(lesson, args.hostSession);
      if (step.outcome !== 'skipped' && step.verification.feedbackKey !== feedbackKey(args.hostSession, user)) throw new Error('收到新的操作反馈后需要重新核查，不能沿用之前的通过结论。');
      if (step.outcome !== 'skipped') step.outcome = step.verification.source === 'self_report' ? 'self_reported'
        : step.hints > 0 || step.demonstrated ? 'assisted' : 'independent';
      lesson.index += 1;
      if (lesson.index >= lesson.steps.length) lesson.phase = 'complete';
      else this.arm(lesson, args.hostSession);
    });
    if (name === 'coach_replan') return this.change(args, 'replan', lesson => {
      const replacement = normalizeSteps(args.steps, lesson.workspace);
      replacement[0].hints = current(lesson).hints || 0;
      replacement[0].demonstrated = current(lesson).demonstrated || false;
      if (lesson.index + replacement.length > 60) throw new Error('课程最多 60 个目标，请拆成多门课程。');
      lesson.steps = [...lesson.steps.slice(0, lesson.index), ...replacement];
      lesson.lastPlanReason = args.reason;
      this.arm(lesson, args.hostSession);
    });
    if (name === 'coach_control') return this.change(args, `control:${args.action}`, lesson => {
      const step = current(lesson);
      if (['pause', 'exit', 'hint', 'demonstrate', 'detail', 'deny_screen'].includes(args.action)) lesson.pendingConsent = null;
      switch (args.action) {
        case 'pause': if (lesson.phase !== 'active') throw new Error('只有进行中的课程可以暂停。'); lesson.phase = 'paused'; break;
        case 'resume': if (lesson.phase !== 'paused') throw new Error('课程没有暂停。'); lesson.phase = 'active'; break;
        case 'exit': this.store.unbind(args.hostSession); lesson.owner = ''; if (lesson.phase === 'active') lesson.phase = 'paused'; break;
        case 'detail': if (!args.level) throw new Error('请提供 level=1/2/3。'); lesson.detail = args.level; break;
        case 'back': {
          if (lesson.phase === 'paused') throw new Error('先恢复课程再回退。');
          if (lesson.index === 0) throw new Error('已经是第一步。需要重做当前步骤可 coach_replan。');
          lesson.index -= 1; lesson.phase = 'active';
          lesson.steps = lesson.steps.map((s, i) => i >= lesson.index ? freshAttempt(s) : s); break;
        }
        case 'skip': active(lesson); this.requireFeedback(lesson, args.hostSession);
          if (!args.reason?.trim() || !isSkipRequest(this.store.user(args.hostSession)?.text || '')) throw new Error('跳过需要用户明确提出，并记录原因。');
          step.outcome = 'skipped'; step.skipReason = args.reason; break;
        case 'hint': active(lesson); step.hints += 1; if (step.hints >= 2) lesson.detail = 3; break;
        case 'demonstrate': active(lesson); step.demonstrated = true; step.hints += 1; break;
        case 'request_screen': case 'allow_screen': {
          active(lesson);
          if (step.check.kind !== 'screen') throw new Error('当前步骤不需要截图。');
          const win = lesson.screenBindings?.[step.check.target];
          if (!win) throw new Error('先用 coach_windows 确认并选择实际窗口，再请求截图授权。');
          lesson.screenGrants ||= []; lesson.consentEvents ||= {};
          if (lesson.screenGrants.includes(win.id)) break;
          const user = this.store.user(args.hostSession), key = feedbackKey(args.hostSession, user);
          if (args.action === 'request_screen') {
            lesson.pendingConsent = { windowId: win.id, after: key, question: `是否允许截取“${win.title}”窗口，并把图片提供给当前模型核查？可以回复“可以”或“暂不截图”。` }; break;
          }
          const pending = lesson.pendingConsent;
          const allowed = screenDecision(user?.text || '') === 'grant' || (pending?.windowId === win.id
            && key !== null && key !== pending.after && isAffirmation(user?.text || ''));
          if (!allowed || (lesson.consentEvents[key] && lesson.consentEvents[key] !== win.id)) throw new Error('需要用户明确授权，如“可以，截吧”；或先 request_screen 提问，等待用户新的确认。授权不能复用于另一窗口。');
          lesson.screenGrants.push(win.id); lesson.consentEvents[key] = win.id; lesson.pendingConsent = null; break;
        }
        case 'deny_screen': lesson.screenGrants = []; break;
      }
      if (args.action === 'back') this.arm(lesson, args.hostSession);
    }, { requireActive: false });
    throw new Error('未实现的工具。');
  }
}
