import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.FROSTFORGE_COACH_DATA || path.join(
  process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')),
  'FrostForge', 'Coach',
);

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
