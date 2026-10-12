import type { EntityType } from '@orbot/shared';

export function entityTitle(type: EntityType | string, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'unit':
      return String(b['name']);
    case 'bot':
      return `Bot ${String(b['callsign'])}`;
    case 'task':
      return `Task #${String(b['number'])}: ${String(b['title'])}`;
    case 'operation':
      return `Operation ${String(b['name'])}`;
    case 'mission':
      return String(b['goal']);
    case 'supply':
      return String(b['name']);
    case 'document':
      return String(b['title']);
    case 'fm-entry':
      return `Field Manual: ${String(b['title'])}`;
    case 'backbrief':
      return `Backbrief: ${String(b['summary'])}`;
    default:
      return type;
  }
}

export const TYPE_LABELS: Record<string, string> = {
  document: 'Documents',
  task: 'Tasks',
  bot: 'Bots',
  unit: 'Units',
  mission: 'Missions',
  operation: 'Operations',
  supply: 'Supply',
  'diary.entry': 'War Diary',
  sitrep: 'Sitreps',
  'bot.step': 'Working record',
  artifact: 'Commits & files',
  'chat.message': 'Chat',
  'fm-entry': 'Field Manual entries',
  backbrief: 'Backbriefs',
  curation: 'Field Manual curation',
  'coldstart.check': 'Cold-start checks',
  'task.status': 'Status changes',
  'credential.used': 'Credential use',
  'redaction.applied': 'Redactions',
};
