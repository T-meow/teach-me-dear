import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../../src/tools.mjs';
import { allowedDuringCoaching, compactContext, DENIAL } from '../../src/policy.mjs';

export const name = 'teach-me-dear';
export const inject = ['tools', 'systemPrompt'];
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url));
const guide = readFileSync(new URL('../../skills/teach-me-dear/SKILL.md', import.meta.url), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function identity(session) {
  const id = session?.header?.id || session?.id;
  if (!id) throw new Error('教教我无法取得当前 DSH 会话 ID。');
  return `dsh:${id}`;
}
function latestUser(session) {
  const events = session.snapshotEvents?.(0, session.seq) || [];
  const event = [...events].reverse().find(e => e.type === 'user/message' && e.data?.source?.kind === 'user');
  return event ? { event: String(event.seq), text: (event.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') } : null;
}
function parse(stdout) {
  const result = JSON.parse(stdout);
  if (result.error) throw new Error(result.error);
  return result;
}

export function apply(ctx, config = {}) {
  const node = config.nodePath || 'node';
  const cache = new WeakMap();
  ctx.tools.guard(execution => allowedDuringCoaching(execution?.name || '') ? undefined : DENIAL);
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'teach-me-dear:state', order: 130,
    text: assemble => {
      const session = assemble?.agent?.session;
      if (!session) return '';
      try {
        const hostSession = identity(session);
        let entry = cache.get(session);
        if (!entry || entry.seq !== session.seq) {
          const result = parse(execFileSync(node, ['--disable-warning=ExperimentalWarning', cli, 'context', encoded({ hostSession, user: latestUser(session) })], { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
          entry = { seq: session.seq, state: result.state }; cache.set(session, entry);
        }
        return `${guide}\n\n${compactContext(entry.state, hostSession)}`;
      } catch (error) { return `${guide}\n教教我状态读取失败：${error.message}。请报告错误，不能口头假装推进。`; }
    },
  }), 'teach-me-dear.context');

  for (const tool of TOOLS) {
    const parameters = structuredClone(tool.inputSchema);
    delete parameters.properties.hostSession;
    parameters.required = parameters.required.filter(key => key !== 'hostSession');
    ctx.tools.register({
      name: tool.name, description: tool.description, parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const { _image, ...text } = value;
          return [{ type: 'text', text: JSON.stringify(text) }, ...(_image ? [{ type: 'image', attachment: _image }] : [])];
        },
      },
      execute: async (args, execution) => {
        const session = execution?.agent?.session;
        const hostSession = identity(session);
        const input = { name: tool.name, hostSession, user: latestUser(session), args: tool.name === 'coach_list' ? {} : { ...args, hostSession } };
        let result;
        try {
          const { stdout } = await exec(node, ['--disable-warning=ExperimentalWarning', cli, 'call', encoded(input)], { windowsHide: true, timeout: 45000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, signal: execution?.signal });
          result = parse(stdout);
        } catch (error) {
          if (error.stdout) parse(error.stdout);
          throw error;
        }
        cache.delete(session);
        if (result.imagePath) {
          const attachments = ctx.get('attachments');
          if (!attachments?.saveImage) throw new Error('宿主附件服务不可用；截图已保存，请改用文件核查或自评。');
          result._image = await attachments.saveImage({ data: readFileSync(result.imagePath), mediaType: 'image/png', name: 'coach-evidence.png' });
          delete result.imagePath;
        }
        return result;
      },
    });
  }
}
