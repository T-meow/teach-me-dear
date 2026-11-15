import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateDshPatch } from './dsh-patch.mjs';

const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
for (const profile of ['desktop', 'web']) {
  const target = path.join(base, 'profiles', profile, 'cordis.patch.yml');
  if (!fs.existsSync(target)) continue;
  const text = fs.readFileSync(target, 'utf8');
  const updated = updateDshPatch(text);
  if (updated !== text) { fs.writeFileSync(target, updated); console.log(`已移除 DSH ${profile} 的“教教我”入口，课程保留。`); }
}
