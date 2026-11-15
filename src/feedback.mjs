// Interpret bounded, direct user replies. Quoted examples/questions are not consent.
const clean = text => String(text || '').normalize('NFKC').trim();
const quotedOrQuestion = text => /["“”‘’「」『』?？]|(?:什么意思|是什么意思|例如|比如|假如|如果|是否|能不能|可不可以)/.test(text);
const clauses = text => clean(text).split(/[,，。.!！;；\n]+/).map(s => s.trim()).filter(Boolean);
const affirmation = /^(?:好|好的|可以|行|没问题|同意|允许|嗯|yes|ok|okay|sure)$/i;
const grant = /^(?:我)?(?:允许|同意|授权|开启)(?:你|教练|教教我)?(?:现在|直接)?(?:截图|截屏|抓屏)(?:吧|了|一次|就行)?$|^(?:请|麻烦)?(?:你|帮我)?(?:可以)?(?:截吧|截图|截屏|抓屏|截一下|截一张(?:图)?)(?:吧|看看|看一下|就行)?$|^(?:please\s+)?(?:allow|enable|take)(?:\s+a)?\s+(?:screenshots?|screen(?:\s+capture)?)$/i;
const denial = /(?:不要|不用|暂不|先不|别|不允许|不同意|禁止|停止|取消|撤回|不再)(?:你|再|继续|给我)?(?:截图|截屏|抓屏|截了|截取)|(?:截图|截屏)(?:权限)?(?:取消|撤回)|^(?:stop|disable|deny)\s+(?:screenshots?|screen(?:\s+capture)?)$/i;
const completion = /^(?:(?:我|这一步|这步|当前步骤|练习|任务|已经|已|刚刚|现在|自己|独立|按要求|按你说的))*?(?:做完|完成|做好|弄好|搞定)(?:了)?(?:可以继续|继续吧|请检查|你看看)?$|^(?:好了|自评通过|I (?:have )?completed (?:it|this step)(?: independently)?)$/i;
const selectionNumber = /^(?:选|选择|就选|用)?\s*(?:第\s*)?([1-9]\d*|[一二两三四五六七八九十])\s*(?:个|项|号|个窗口|窗口)?(?:吧|就行)?$/;

export const feedbackKey = (session, user) => user ? JSON.stringify([session, String(user.event)]) : null;
export const isAffirmation = text => affirmation.test(clean(text).replace(/[。.!！]+$/, ''));
export function screenDecision(text) {
  const value = clean(text);
  if (quotedOrQuestion(value)) return null;
  if (denial.test(value)) return 'deny';
  return clauses(value).some(part => grant.test(part)) ? 'grant' : null;
}
export function isCompletion(text) {
  const value = clean(text);
  if (quotedOrQuestion(value) || /没(?:有)?(?:做完|完成|做好)|未完成|还没|不能|不算|并未|没有独立/.test(value)) return false;
  return clauses(value).some(part => completion.test(part));
}
export function isSkipRequest(text) {
  const value = clean(text);
  if (quotedOrQuestion(value) || /不要|别|不想/.test(value)) return false;
  return /(?:先|请|我想|我要)?(?:跳过|略过)(?:这一步|这步|当前步骤)?|^(?:这一步|这步)(?:先)?跳过/.test(value);
}
export function windowChoice(text, windows) {
  const value = clean(text);
  if (quotedOrQuestion(value) || /不要|别选|不选/.test(value)) return null;
  const choices = new Set();
  for (const part of clauses(value)) {
    const match = selectionNumber.exec(part);
    if (match) {
      const number = Number(match[1]) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })[match[1]];
      if (windows[number - 1]) choices.add(windows[number - 1].id);
    }
    for (const win of windows) if (part === win.title || part === `选${win.title}` || part === `选择${win.title}`) choices.add(win.id);
  }
  return choices.size === 1 ? [...choices][0] : null;
}
export function isControlReply(text) {
  const value = clean(text);
  if (isCompletion(value)) return false;
  return clauses(value).length > 0 && clauses(value).every(part => affirmation.test(part) || grant.test(part)
    || denial.test(part) || selectionNumber.test(part)
    || /^(?:继续|继续吧|继续下一步|下一步|再来下一步|接着来|继续上次的练习|继续刚才的课程|暂停|今天先到这|退出教教我|退出教学模式)$/.test(part));
}
