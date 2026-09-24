import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(APP_ROOT, '.env'))) process.loadEnvFile(path.join(APP_ROOT, '.env'));
export const SKILL_ROOT = path.join(APP_ROOT, 'skills', 'blender-product-studio');
export const DATA_ROOT = path.resolve(process.env.STUDIO_DATA_DIR || path.join(APP_ROOT, '.studio'));
export const PORT = Number(process.env.STUDIO_PORT || 4318);
const exec = promisify(execFile);

export async function discoverExecutable(kind: 'blender' | 'codex'): Promise<string | null> {
  const override = process.env[kind === 'blender' ? 'BLENDER_PATH' : 'CODEX_PATH'];
  if (override) return existsSync(override) ? realpathSync(override) : null;
  try {
    const result = await exec(process.platform === 'win32' ? 'where' : 'which', [kind]);
    const candidate = result.stdout.trim().split(/\r?\n/)[0];
    if (candidate && existsSync(candidate)) return candidate;
  } catch { /* Platform defaults below. */ }
  const candidates = kind === 'blender'
    ? ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender']
    : ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'];
  return candidates.find(p => existsSync(p)) ?? null;
}

export async function environmentStatus() {
  const [blender, codex] = await Promise.all([discoverExecutable('blender'), discoverExecutable('codex')]);
  async function check(exe: string | null, args: string[]) {
    if (!exe) return { ok: false, detail: '未找到程序' };
    try {
      const r = await exec(exe, args, { timeout: 10000 });
      return { ok: true, detail: (r.stdout + r.stderr).trim().slice(0, 500) };
    } catch (e) { return { ok: false, detail: String((e as Error).message).slice(0, 300) }; }
  }
  const [b, c] = await Promise.all([check(blender, ['--version']), check(codex, ['login', 'status'])]);
  return { blender: { path: blender, ...b }, codex: { path: codex, ...c }, model: process.env.STUDIO_MODEL || '', dataRoot: DATA_ROOT, version: '0.1.0' };
}
