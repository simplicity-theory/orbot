import 'reflect-metadata';
import { loadConfig } from './config/config.js';
import { createApp } from './bootstrap.js';
import { RedactingLogger } from './redaction/redacting-logger.js';

const config = loadConfig();
const app = await createApp({ config });
await app.listen(config.apiPort);
app.get(RedactingLogger).log(`${config.productName} API listening on :${config.apiPort}`, 'Bootstrap');
