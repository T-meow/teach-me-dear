import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { updateDshPatch } from './dsh-patch.mjs';

let root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const prepareOnly = process.argv.includes('--prepare-only');
const relocateIndex = process.argv.indexOf('--relocate-to');
let destination = root;
if (relocateIndex !== -1) {
  if (prepareOnly || !process.argv[relocateIndex + 1]) throw new Error('--relocate-to 必须给出目标路径，且不能与 --prepare-only 同用。');
  destination = path.resolve(process.argv[relocateIndex + 1]);
  if (path.dirname(destination) !== path.dirname(root) || path.basename(destination) !== 'teach-me-dear') {
    throw new Error('改名只允许移动到同级 teach-me-dear 目录。');
  }
  if (destination !== root && fs.existsSync(destination)) throw new Error(`目标目录已存在，拒绝覆盖：${destination}`);
}
const requested = process.argv.includes('--codex-only') ? ['codex'] : process.argv.includes('--dsh-only') ? ['dsh'] : ['codex', 'dsh'];
if (destination !== root && requested.length !== 2) throw new Error('移动项目时必须同时更新 Codex 和 DSH 的安装路径。');

// Prepare all DSH edits before touching installed plugins or moving the project.
const dshEdits = [];
if (!prepareOnly && requested.includes('dsh')) {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const source = fs.readFileSync(path.join(root, 'adapters', 'dsh', 'cordis.patch.yml'), 'utf8')
    .replace("name: '@frostforge/teach-me-dear'", `name: '${pathToFileURL(path.join(destination, 'adapters', 'dsh', 'index.mjs')).href}'`)
    .replace('nodePath: node', `nodePath: '${process.execPath.replaceAll("'", "''")}'`);
  for (const profile of ['desktop', 'web']) {
    const directory = path.join(base, 'profiles', profile);
    if (!fs.existsSync(path.join(directory, 'package.json'))) continue;
    const patch = path.join(directory, 'cordis.patch.yml');
    const original = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '';
    dshEdits.push({ profile, patch, original, updated: updateDshPatch(original, source) });
  }
}

let codex;
if (!prepareOnly && requested.includes('codex')) {
  const cli = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const executable = process.env.CODEX_CLI || process.execPath;
  const prefix = process.env.CODEX_CLI ? [] : [cli];
  if (!process.env.CODEX_CLI && !fs.existsSync(cli)) throw new Error('没有找到 Codex CLI。设置 CODEX_CLI 为 codex 可执行文件路径后重试。');
  codex = (args, quiet = false) => {
    const result = spawnSync(executable, [...prefix, ...args], { cwd: path.dirname(root), encoding: 'utf8', windowsHide: true });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Codex 操作失败：${result.error?.message || result.stderr || result.status}`);
    if (!quiet && result.stdout) process.stdout.write(result.stdout);
    return JSON.parse(result.stdout);
  };
  const installed = codex(['plugin', 'list', '--json'], true).installed || [];
  // A renamed marketplace manifest can hide the old plugin from `plugin list`
  // even while its installed config and trusted hooks still exist.
  const codexConfig = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const configText = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : '';
  const configured = new Set([...configText.matchAll(/^\[plugins\.["']([^"'\r\n]+)["']\]\s*$/gm)].map(match => match[1]));
  const market = codex(['plugin', 'marketplace', 'list', '--json'], true).marketplaces.find(entry => entry.name === 'frostforge-local');
  if (market && path.resolve(market.root) !== destination && installed.some(entry => entry.marketplaceName === 'frostforge-local'
    && !['frostforge-coach', 'teach-me-dear'].includes(entry.name))) {
    throw new Error('frostforge-local 包含其他插件，不能自动移动其市场入口。');
  }
  for (const name of ['frostforge-coach', 'teach-me-dear']) {
    if (configured.has(`${name}@frostforge-local`) || installed.some(entry => entry.pluginId === `${name}@frostforge-local`)) {
      codex(['plugin', 'remove', `${name}@frostforge-local`, '--json']);
    }
  }
  if (market && path.resolve(market.root) !== destination) codex(['plugin', 'marketplace', 'remove', 'frostforge-local', '--json']);
}

if (destination !== root) {
  // Both absolute paths were checked above. This is a move, never a backup copy.
  fs.renameSync(root, destination);
  root = destination;
  console.log(`项目目录已改名：${root}`);
}
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
writeJson(path.join(root, '.mcp.json'), { mcpServers: { teach_me_dear: {
  command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(root, 'bin', 'mcp.mjs')],
  startup_timeout_sec: 30, tool_timeout_sec: 60,
} } });
const hookCommand = `node --disable-warning=ExperimentalWarning "${path.join(root, 'bin', 'codex-hook.mjs').replaceAll('\\', '/')}"`;
const hook = { hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] };
writeJson(path.join(root, 'hooks', 'hooks.json'), { hooks: {
  SessionStart: [hook], UserPromptSubmit: [hook], PostCompact: [hook], PreToolUse: [{ matcher: '*', ...hook }],
} });
if (prepareOnly) {
  console.log('已生成本机 MCP 与 Hooks 配置。');
  process.exit(0);
}

for (const { profile, patch, original, updated } of dshEdits) {
  if (fs.existsSync(patch) && fs.readFileSync(patch, 'utf8') !== original) throw new Error(`DSH 配置在安装期间发生变化，未覆盖：${patch}`);
  fs.writeFileSync(patch, updated);
  console.log(`DSH ${profile}：已替换为“教教我”模式。`);
}
if (requested.includes('dsh') && !dshEdits.length) console.log('尚未发现 DSH profile。首次打开 DSH 后重跑 --dsh-only。');
if (codex) {
  codex(['plugin', 'marketplace', 'add', root, '--json']);
  codex(['plugin', 'add', 'teach-me-dear@frostforge-local', '--json']);
}
console.log('安装完成。Codex 新开聊天使用 $teach-me-dear，并按界面要求信任 Hooks；DSH 重开后选择“教教我”。课程数据目录保持不变。');
