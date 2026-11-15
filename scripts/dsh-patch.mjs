export function updateDshPatch(original, source) {
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const body = original.replace(/\r\n/g, '\n');
  const clean = body.replace(/^# (frostforge-coach|teach-me-dear):begin\n[\s\S]*?^# \1:end(?:\n|$)/gm, '');
  if (/^# (?:frostforge-coach|teach-me-dear):(?:begin|end)\b/m.test(clean)) {
    throw new Error('教教我插件标记不完整，请先修复对应 profile；未写入配置。');
  }
  const updated = source === undefined ? clean
    : `${clean.trimEnd()}\n\n# teach-me-dear:begin\n${source.trimEnd()}\n# teach-me-dear:end\n`;
  return updated.replace(/\n/g, lineEnding);
}
