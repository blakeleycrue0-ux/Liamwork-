/**
 * One-shot run of the monitoring pipeline, for cron or a manual test:
 *   npm run check                -> crawl every website, analyse what moved
 *   npm run check -- 1           -> only website #1
 *   npm run check -- --no-ai     -> crawl and store, but call no model
 */
import { bootstrap } from '../bootstrap.js';
import { crawlWebsite } from '../monitor/crawl.js';
import { runPipeline } from '../monitor/index.js';
import { closeDb } from '../db/index.js';

await bootstrap();

const args = process.argv.slice(2);
const analyze = !args.includes('--no-ai');
const id = args.find((arg) => /^\d+$/.test(arg));

const outcome = id
  ? await crawlWebsite(Number(id), { maxPages: 12 })
  : await runPipeline({ analyze });

console.log(JSON.stringify(outcome, null, 2));
await closeDb();
process.exit(0);
