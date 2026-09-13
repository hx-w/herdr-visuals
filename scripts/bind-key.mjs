import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

// Explicit setup command. Preserve comments and unrelated settings byte-for-byte.
const file = process.env.HERDR_CONFIG_PATH || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr', 'config.toml');
const before = await fs.readFile(file, 'utf8');
const config = parse(before);
const existing = (config.keys?.command || []).filter(binding => binding.key === 'prefix+v');
if (existing.length) {
  if (existing.length !== 1 || existing[0].type !== 'plugin_action' || existing[0].command !== 'hx-w.visuals.open') {
    throw new Error(`prefix+v already has a custom binding in ${file}. No changes made.`);
  }
  console.log(`Already bound: prefix+v -> hx-w.visuals.open (${file})`);
} else {
  const after = before + '\n# Herdr Visuals\n[[keys.command]]\nkey = "prefix+v"\ntype = "plugin_action"\ncommand = "hx-w.visuals.open"\ndescription = "Visual previews"\n';
  parse(after);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backup = `${file}.visuals-backup-${stamp}`;
  await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
  if (await fs.readFile(file, 'utf8') !== before) throw new Error('Config changed during setup. No binding written.');
  const temporary = `${file}.visuals-${process.pid}.tmp`;
  const stat = await fs.stat(file);
  await fs.writeFile(temporary, after, { mode: stat.mode & 0o777, flag: 'wx' });
  await fs.rename(temporary, file);
  console.log(`Bound prefix+v -> hx-w.visuals.open\nBackup: ${backup}\nRun: herdr server reload-config`);
}
