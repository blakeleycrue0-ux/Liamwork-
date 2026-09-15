import { bootstrap } from '../bootstrap.js';
import { closeDb } from '../db/index.js';

bootstrap();
console.log('[seed] done');
closeDb();
