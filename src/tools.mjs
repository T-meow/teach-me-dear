const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const integer = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const hostSession = str('当前聊天标识。使用 Hooks 注入的 coachHostSession；DSH 自动填写。');
const lessonId = str('coach_start / coach_list 返回的课程 ID。');
const revision = integer('最近一次状态返回的 revision；过期时先读取状态，禁止盲目重试。', { minimum: 1 });
const check = object({
  kind: str('验收方法。manual 用于用户自评；screen 需要目标窗口截图授权。', { enum: ['file_exists', 'file_contains', 'json_value', 'command', 'screen', 'manual'] }),
  target: str('相对于课程工作目录的文件路径、窗口进程名/标题，或命令ID。command 仅允许 git_version/git_status/node_version/python_version。'),
  expected: str('file_contains 必须包含的原文；json_value 为 JSON 编码的目标值；command 为输出中必须包含的原文。'),
  pointer: str('json_value 使用 RFC6901 JSON Pointer，例如 /application/name。'),
}, ['kind', 'target']);
export const STEP_SCHEMA = object({
  goal: str('一个可完成的小目标，可含几个连续点击。', { minLength: 1, maxLength: 500 }),
  action: str('用户要做的操作。', { minLength: 1, maxLength: 3000 }),
  expected: str('用户能看见的结果。', { minLength: 1, maxLength: 1000 }),
  standard: str('明确、可以观察的合格标准。', { minLength: 1, maxLength: 1000 }),
  check,
}, ['goal', 'action', 'expected', 'standard', 'check']);
const steps = { type: 'array', items: STEP_SCHEMA, minItems: 1, maxItems: 60 };
const base = { hostSession, lessonId, revision };
const tool = (name, description, properties, required, readOnly = false) => ({
  name, description, inputSchema: object(properties, required),
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});

export const TOOLS = [
  tool('coach_list', '列出本机的学习课程，可从 Codex 或 DSH 继续。', {}, [], true),
  tool('coach_start', '建立课程并绑定当前聊天。先理解学习目标和环境；给简短路线，一次推进一个小目标。', {
    hostSession, title: str('课程名称', { minLength: 1, maxLength: 200 }),
    workspace: str('用户实际操作的绝对工作目录；不创建或修改该目录。'),
    steps, detail: integer('讲解等级：1只给目标，2给要点，3手把手。', { minimum: 1, maximum: 3 }),
  }, ['hostSession', 'title', 'workspace', 'steps']),
  tool('coach_open', '继续已有课程并接管进度。另一个聊天会变成只读，暂停的课程仍需 resume。', { hostSession, lessonId }, ['hostSession', 'lessonId']),
  tool('coach_status', '读取当前步骤、核查结果、讲解等级与进度。', { hostSession, lessonId }, ['hostSession'], true),
  tool('coach_observe', '按当前步骤绑定的目标取证。verify 必须在本步收到新的用户操作反馈后使用；inspect 可预查环境，但不计入完成。截图须先选窗并授权。', {
    ...base, purpose: str('默认 verify；inspect 只预查，不能用于过关。', { enum: ['verify', 'inspect'] }),
  }, ['hostSession', 'lessonId', 'revision']),
  tool('coach_windows', '列出当前截图目标匹配的窗口标题（不截图）。唯一窗口自动绑定，多个候选需请用户选择；重开软件后重新列出。', base, ['hostSession', 'lessonId', 'revision']),
  tool('coach_select_window', '绑定用户刚刚选中的候选窗口。必须有列窗之后的真实用户选择，如“第二个”；windowId 从候选列表取得，不能猜测。', {
    ...base, windowId: str('coach_windows 返回的完整窗口 ID。'),
  }, ['hostSession', 'lessonId', 'revision', 'windowId']),
  tool('coach_verify', '对截图提交有依据的判断。文件/命令由程序验收；manual 仅接受用户明确自评。不会自动进入下一步。', {
    ...base, evidenceId: str('本次 coach_observe 返回的证据 ID。'),
    verdict: str('结论', { enum: ['pass', 'fail', 'uncertain'] }),
    reason: str('引用画面上实际可见的事实；不确定就明确说明。', { minLength: 1, maxLength: 1500 }),
  }, ['hostSession', 'lessonId', 'revision', 'evidenceId', 'verdict', 'reason']),
  tool('coach_next', '本步通过或明确跳过后，进入下一步。全部结束则生成掌握情况摘要。', base, ['hostSession', 'lessonId', 'revision']),
  tool('coach_control', '暂停/恢复、跳过、回退、调节提示、退出教学。示范只显示例子，不授权宿主修改工程；示范后由用户完成练习。', {
    ...base,
    action: str('操作。request_screen 发起针对已绑定窗口的授权提问，等待用户新回复后 allow_screen；明确“可以，截吧”也可直接授权。', { enum: ['pause', 'resume', 'skip', 'back', 'detail', 'hint', 'demonstrate', 'exit', 'request_screen', 'allow_screen', 'deny_screen'] }),
    reason: str('跳过、回退、示范的原因；hint 为本次给出的提示。', { maxLength: 2000 }),
    level: integer('detail 的讲解等级', { minimum: 1, maximum: 3 }),
  }, ['hostSession', 'lessonId', 'revision', 'action']),
  tool('coach_replan', '调整当前及后续步骤。已完成步骤保留；当前及受影响步骤的证据失效。用于补课、拆小步骤或改用可用的核查方式。', {
    ...base, steps, reason: str('调整原因', { minLength: 1, maxLength: 1000 }),
  }, ['hostSession', 'lessonId', 'revision', 'steps', 'reason']),
];
