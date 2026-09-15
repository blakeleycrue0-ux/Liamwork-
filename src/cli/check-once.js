/**
 * One-shot crawler run, handy for cron or for a manual test:
 *   npm run check            -> every website that is due
 *   npm run check -- 1       -> only website #1, ignoring its interval
 */
import { bootstrap } from '../bootstrap.js';
import { checkWebsite, runDueChecks } from '../crawler/index.js';
import { closeDb } from '../db/index.js';

bootstrap();

const id = process.argv[2] ? Number(process.argv[2]) : null;
const outcome = id ? await checkWebsite(id, { force: true }) : await runDueChecks();
console.log(JSON.stringify(outcome, null, 2));
closeDb();
process.exit(0);
