import 'reflect-metadata';
import { loadConfig } from '../config/config.js';
import { createApp } from '../bootstrap.js';
import { seedDemoForce } from './seed.js';

/**
 * ORBOT_SEED picks what to seed into an empty record:
 *   demo  (default) the demo force with repositories, an operation in flight and a chat
 *   force           the four units with Overseers, bots and Field Manuals only (production)
 *   none            nothing
 */
const mode = process.env['ORBOT_SEED'] ?? 'demo';
if (!['demo', 'force', 'none'].includes(mode)) {
  console.error(`ORBOT_SEED must be demo, force or none (got "${mode}").`);
  process.exit(1);
}
if (mode === 'none') {
  console.log('ORBOT_SEED=none: nothing seeded.');
} else {
  // Seeding plays simulated tasks out instantly.
  const config = loadConfig({ ORBOT_SIM_SPEED: '0', ORBOT_LOG_LEVEL: 'warn' });
  const app = await createApp({ config });
  await app.init();
  try {
    const r = await seedDemoForce(app, { demo: mode === 'demo' });
    console.log(
      r.seeded
        ? mode === 'demo'
          ? `Seeded demo force: ${r.units} units, ${r.bots} bots, ${r.tasks} tasks.`
          : `Seeded the force: ${r.units} units, ${r.bots} bots. Connect your repositories in the Supply Depot.`
        : `Record already has ${r.units} units; seed skipped.`,
    );
  } finally {
    await app.close();
  }
}
