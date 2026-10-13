import { SETTINGS_ID } from '@orbot/shared';
import type { RecordService } from '../record/record.service.js';

/** The missions of the main-effort operation (empty when there is none). */
export async function mainEffortMissionIds(record: RecordService): Promise<Set<string>> {
  const me = (await record.getActive('settings', SETTINGS_ID))?.body.mainEffort;
  if (!me) return new Set();
  const op = await record.getActive('operation', me.operationId);
  return new Set(op?.body.missionIds ?? []);
}

/** Main-effort tasks first; otherwise the queue keeps its order. */
export function mainEffortFirst<
  T extends { missionId: string | null } | { body: { missionId: string | null } },
>(tasks: T[], missionIds: Set<string>): T[] {
  const first = (t: T) => {
    const m = 'body' in t ? t.body.missionId : t.missionId;
    return m && missionIds.has(m) ? 0 : 1;
  };
  return [...tasks].sort((a, b) => first(a) - first(b));
}
