import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { inside } from './paths.mjs';
import { runWindowScript } from './windows.mjs';

const runFile = promisify(execFile);
export const COMMANDS = {
  git_version: ['git', ['--version']],
  git_status: ['git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1']],
  node_version: [process.execPath, ['--version']],
  python_version: ['python', ['--version']],
};
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export async function fileInWorkspace(workspace, target) {
  const root = await fs.realpath(workspace);
  const resolved = path.resolve(root, target);
  if (!inside(root, resolved)) throw new Error('核查目标必须位于本课程工作目录内。');
  // Resolve the nearest existing ancestor as well: missing files under an external junction are not allowed.
  let ancestor = resolved;
  while (true) {
    try {
      const canonical = await fs.realpath(ancestor);
      if (!inside(root, canonical)) throw new Error('核查路径经过了指向工作目录外的链接。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return resolved;
}

function jsonPointer(data, pointer) {
  if (pointer === '') return data;
  if (!pointer.startsWith('/')) throw new Error('JSON Pointer 必须为空字符串或以 / 开头。');
  return pointer.slice(1).split('/').reduce((value, key) => {
    const name = key.replace(/~1/g, '/').replace(/~0/g, '~');
    return value != null && Object.hasOwn(value, name) ? value[name] : undefined;
  }, data);
}

export async function observe(lesson, directory, user) {
  const step = lesson.steps[lesson.index];
  const { check } = step;
  const result = {
    id: randomUUID(), stepId: step.id, attempt: step.attempt,
    criteriaHash: digest({ standard: step.standard, check }), kind: check.kind, target: check.target,
    capturedAt: Date.now(), userEvent: user?.event || '', ok: false, passed: null, detail: '',
  };
  try {
    if (check.kind.startsWith('file_') || check.kind === 'json_value') {
      const target = await fileInWorkspace(lesson.workspace, check.target);
      const stat = await fs.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (check.kind === 'file_exists') {
        result.ok = true;
        result.passed = stat !== null;
        result.detail = stat ? `路径存在：${check.target}（${stat.isDirectory() ? '目录' : `${stat.size} 字节`}）` : `路径不存在：${check.target}`;
      } else {
        if (!stat?.isFile()) throw new Error('目标文件不存在或不是普通文件。');
        if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB，请缩小验收目标或改为截图。');
        const data = await fs.readFile(target);
        result.contentHash = digest(data);
        const text = data.toString('utf8').replace(/^\uFEFF/, '');
        result.ok = true;
        if (check.kind === 'file_contains') {
          result.passed = text.includes(check.expected);
          const index = text.indexOf(check.expected);
          result.detail = result.passed ? `找到要求的内容：${text.slice(Math.max(0, index - 80), index + check.expected.length + 160)}`
            : `未找到要求的原文：${check.expected}`;
        } else {
          const actual = jsonPointer(JSON.parse(text), check.pointer || '');
          result.passed = isDeepStrictEqual(actual, JSON.parse(check.expected));
          result.detail = `字段 ${check.pointer || '/'}：实际 ${JSON.stringify(actual)}；要求 ${check.expected}`;
        }
      }
    } else if (check.kind === 'command') {
      const command = COMMANDS[check.target];
      if (!command) throw new Error('未注册的核查命令。');
      const { stdout, stderr } = await runFile(command[0], command[1], {
        cwd: lesson.workspace, timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
      });
      const output = `${stdout}\n${stderr}`.trim();
      result.ok = true;
      result.passed = check.expected ? output.includes(check.expected) : true;
      result.detail = output.slice(0, 4000) || '命令成功执行，输出为空。';
      result.contentHash = digest(output);
    } else if (check.kind === 'screen') {
      if (process.platform !== 'win32') throw new Error('第一版自动截图只支持 Windows。');
      const win = lesson.screenBindings?.[check.target];
      if (!win) throw new Error('请先 coach_windows 列出并选择目标窗口。');
      if (!(lesson.screenGrants || []).includes(win.id)) throw new Error(`尚未授权截取“${win.title}”。请先 request_screen 发起一次明确的授权提问。`);
      const destination = path.join(directory, 'shots', lesson.id);
      await fs.mkdir(destination, { recursive: true });
      const imagePath = path.join(destination, `${result.id}.png`);
      const shot = await runWindowScript({ target: check.target, windowId: win.id, outPath: imagePath });
      if (shot?.error === 'window_changed') throw new Error('选定窗口已关闭或软件已重开。请重新 coach_windows 选窗并授权；不会自动改截另一窗口。');
      if (!shot?.ok) throw new Error(`截图失败：${shot?.reason || shot?.error || '没有取得有效画面'}。请将目标窗口恢复并切到前台；可在下一次用户反馈后重试。`);
      if (shot.windowId !== win.id) throw new Error('返回的画面与选定窗口不一致，已拒绝。');
      const data = await fs.readFile(imagePath);
      if (data.length > 8 * 1024 * 1024) throw new Error('截图超过 8 MiB，请缩小窗口后重试。');
      result.ok = true;
      result.imagePath = imagePath;
      result.windowId = shot.windowId;
      result.contentHash = digest(data);
      result.detail = `窗口 ${shot.title}（${shot.process}），${shot.width}×${shot.height}，${shot.method || 'window'}。请只按画面可见事实判定。`;
    } else {
      result.ok = true;
      result.detail = '本步骤使用用户自评，可以自然回复“这步我自己做完了”“完成了”等。结果仍会单独标为自评。';
    }
  } catch (error) {
    result.ok = false;
    result.passed = null;
    result.detail = String(error.message || error).slice(0, 1500);
  }
  result.detail = result.detail.slice(0, 5000);
  return result;
}
