// Make a consistent copy of the database while the server keeps running:
//   npm run backup                                                (on your computer)
//   fly ssh console -C "node /app/scripts/backup.js /data/tcgcopbot.db"   (on Fly.io)
// then download it with:  fly ssh sftp get /data/backups/<file>
// Keep backups somewhere safe, together with DATA_ENCRYPTION_KEY — without
// the key, the encrypted delivery details in a backup can't be read.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadEnvFile } from '../server/config.js';

loadEnvFile();
const dbPath = process.argv[2] || loadConfig().databasePath;
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
const dir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(dir, `tcgcopbot-${stamp}.db`);
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
// Keep the 10 most recent.
const old = fs.readdirSync(dir).filter((f) => /^tcgcopbot-.*\.db$/.test(f)).sort().reverse().slice(10);
for (const f of old) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${file}`);
