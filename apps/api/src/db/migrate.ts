import { loadConfig } from '../config/config.js';
import { migrate } from './migrator.js';

const config = loadConfig();
const record = await migrate(config.recordDb.owner, 'record');
const secrets = await migrate(config.secretsDb, 'secrets');
const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'up to date');
console.log(`record:  ${list(record)}`);
console.log(`secrets: ${list(secrets)}`);
