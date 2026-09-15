import { hashPassword } from '../api/password.js';

const password = process.argv[2];
if (!password) {
  console.error('Uso: npm run hash-password -- "tuPassword"');
  process.exit(1);
}
console.log(await hashPassword(password));
