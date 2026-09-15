import { bootstrap } from '../bootstrap.js';
import { closeDb } from '../db/index.js';

await bootstrap();
console.log('[seed] done');
await closeDb();
