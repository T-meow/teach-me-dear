// Host tool names are deliberately explicit: do not infer read-only behavior from arbitrary code.
export function allowedDuringCoaching(name) {
  if (/(^|__)coach_(list|start|open|status|observe|verify|next|control|replan|windows|select_window)$/.test(name)) return true;
  if (/^mcp__fastctx__(inspect_local_file|grep|glob)$/.test(name)) return true;
  if (/^(exec|functions\.exec|view_image|web__run|request_user_input|request_user_input_async|update_plan)$/.test(name)) return true;
  if (/^(read|glob|grep|search|fetch|web_search|web_fetch|ask_user|ask_user_question)$/.test(name)) return true;
  return false;
}
export const DENIAL = '「教教我」教学正在进行：请让用户完成操作。取证用 coach_observe；提供示例用 coach_control demonstrate。用户说“退出教教我”或“退出教学模式”时，先 coach_control exit 再恢复普通助手操作。';

export const isTeachingRequest = text => /teach[- ]me[- ]dear|教教我|教练|陪练|教我|手把手教|继续上次的练习/i.test(text);
export const isTeachingExit = text => /^(退出教教我(?:模式)?|退出教学模式|退出教练模式|退出陪练|结束教练模式|exit (?:teach-me-dear|coach))[。！!\s]*$/i.test(text.trim());
const phaseLabel = { active: '学习中', paused: '已暂停', complete: '已完成' };
const verdictLabel = { pass: '通过', fail: '未通过', uncertain: '无法确定' };

export function compactContext(state, session) {
  const identity = `coachHostSession=${session}`;
  if (!state) return `${identity}。仅在用户请求「教教我」（teach-me-dear）教学/陪练时用于教练工具，普通代办请求不自动进入教学。`;
  const s = state.current;
  return `${identity}\n教教我课程 ${state.lessonId} / revision=${state.revision} / ${phaseLabel[state.phase] || state.phase}${state.readOnly ? '（已被其他聊天接管）' : ''}\n`
    + `目标：${state.title}；进度 ${state.progress.current}/${state.progress.total}；讲解等级 ${state.detail}\n`
    + (s ? `当前：${s.goal}\n操作：${s.action}\n合格标准：${s.standard}\n核查：${JSON.stringify(s.check)}\n结论：${verdictLabel[s.verification?.verdict] || '尚未判定'}\n` : '')
    + (state.note || '')
    + (s?.feedbackRequired ? '\n等待本步的新操作反馈；选窗、授权和简单应答不会自动完成练习。' : '')
    + (s?.selectedWindow ? `\n已选窗口：${s.selectedWindow.title}；截图${s.screenshotAllowed ? '已授权' : '未授权'}` : '')
    + (state.consentQuestion ? `\n请向用户提出授权问题并等待回复：${state.consentQuestion}` : '')
    + '\n必须以教练工具返回的状态为准。一次一个小目标；等待用户反馈，不替用户操作。';
}
