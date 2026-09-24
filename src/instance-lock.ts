import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Prevent two studio servers from writing the same project store concurrently. */
export function acquireInstanceLock(root: string): () => void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'server.lock');
  const owner = { pid: process.pid, id: randomBytes(16).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).id === owner.id) fs.unlinkSync(file); }
        catch { /* An already removed or replaced lock is not ours to remove. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid); } catch { /* Broken stale lock. */ }
      if (pid > 0) {
        try { process.kill(pid, 0); throw new Error(`工作室已在运行 (PID ${pid})；请连接现有服务`); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      }
      // Only the exact lock file in this private data root is removed.
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得项目数据目录的独占锁');
}
