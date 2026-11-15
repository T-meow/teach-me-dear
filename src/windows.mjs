import { execFile } from 'node:child_process';
import { captureScript } from './capture.mjs';

export async function runWindowScript(options) {
  if (process.platform !== 'win32') throw new Error('自动窗口核查目前只支持 Windows，可改用文件核查或自评。');
  const script = captureScript({ outPath: '', maxWidth: 1440, maxHeight: 900, selfPid: process.pid,
    blocked: ['deepseek harness', 'dsh', 'codex'], blockedTitles: ['deepseek harness', 'codex'], ...options });
  // Keep the Win32 command line short even for long paths and window titles.
  const bootstrap = '$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); & ([scriptblock]::Create($source))';
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true, encoding: 'utf8',
    }, (error, output) => error ? reject(error) : resolve(output));
    child.stdin.on('error', () => {}); // The process callback reports launch/exit failures.
    child.stdin.end(Buffer.from(script, 'utf16le').toString('base64'));
  });
  const line = stdout.trim().split(/\r?\n/).reverse().find(value => value.trim().startsWith('{'));
  if (!line) throw new Error('窗口服务没有返回有效结果。');
  return JSON.parse(line);
}
export async function listWindows(target) {
  const result = await runWindowScript({ target, listOnly: true });
  if (!result.ok) throw new Error(`读取窗口失败：${result.error || '未知原因'}`);
  return result.windows || [];
}
