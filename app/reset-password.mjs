// Locked out? On the server: npm run reset-password -- someone@example.com
// Gives that account a new first password (printed here), reactivates it, and ends its sessions.
import { randomBytes } from 'node:crypto';
import { db } from './store.mjs';
import { updateUser } from './auth.mjs';

const email = process.argv[2];
const u = email && db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!u) { console.error(email ? `No account for ${email}` : 'Usage: npm run reset-password -- <email>'); process.exit(1); }
const password = randomBytes(9).toString('base64url');
updateUser(u.id, { password, active: true });
console.log(`New first password for ${email}: ${password}\nThey choose their own at the next sign-in.`);
