import type { INestApplication } from '@nestjs/common';
import { Background } from '../common/background.js';
import { TaskRunner } from '../execution/task-runner.js';

/** Wait until background work (curation, mirroring, dispatch) and all bot runs have finished. */
export async function settled(app: INestApplication, timeoutMs = 30_000): Promise<void> {
  const bg = app.get(Background);
  const runner = app.get(TaskRunner);
  const start = Date.now();
  let quiet = 0;
  while (quiet < 3) {
    if (Date.now() - start > timeoutMs)
      throw new Error('Timed out waiting for background work to settle');
    await bg.idle();
    await new Promise((r) => setTimeout(r, 25));
    quiet = bg.isIdle() && runner.runningCount() === 0 ? quiet + 1 : 0;
  }
}
