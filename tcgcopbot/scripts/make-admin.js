// Give an existing account admin access:  npm run make-admin -- you@example.com
// (Or set ADMIN_EMAILS and log in again.)

import { loadConfig, loadEnvFile } from '../server/config.js';
import { Db } from '../server/db.js';
import { Repo } from '../server/repo.js';

loadEnvFile();
const email = String(process.argv[2] || '').toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- you@example.com');
  process.exit(1);
}
const cfg = loadConfig();
const db = new Db(cfg.databasePath);
const repo = new Repo(db, cfg);
const user = repo.userByEmail(email);
if (!user) {
  console.error(`No account for ${email}. Sign up first, then run this again.`);
  process.exit(1);
}
repo.updateUser(user.id, { role: 'admin' });
repo.audit(null, user.id, 'make-admin', `${email} (command line)`);
db.close();
console.log(`${email} is now an admin. Open ${cfg.baseUrl}/admin`);
