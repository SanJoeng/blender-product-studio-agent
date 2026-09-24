import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const filename = 'connector-secret';

/** A local capability shared by the UI daemon and same-user MCP subprocesses. */
export function connectorSecret(dataRoot: string): string {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const file = path.join(dataRoot, filename);
  try { fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('本地 MCP 凭证文件损坏，请检查数据目录');
  return secret;
}

export function matchesConnectorSecret(expected: string, candidate: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
}
