import 'reflect-metadata';
import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { seedDemoForce } from './seed.js';

// Seeding plays simulated tasks out instantly.
const config = loadConfig({ ORBOT_SIM_SPEED: '0', ORBOT_LOG_LEVEL: 'warn' });
const app = await createApp({ config });
await app.init();
try {
  const r = await seedDemoForce(app);
  console.log(
    r.seeded
      ? `Seeded demo force: ${r.units} units, ${r.bots} bots, ${r.tasks} tasks.`
      : `Record already has ${r.units} units; seed skipped.`,
  );
} finally {
  await app.close();
}
