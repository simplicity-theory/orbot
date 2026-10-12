import type { RecordEvent } from '@orbot/shared';
import type { IconName } from '../../ui/icons';

export interface EventSummary {
  icon: IconName;
  label: string;
  /** Glossary key for the label, if any. */
  term?: string;
  text: string;
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
}

/** One line per record event, in the Commander's vocabulary. */
export function describeEvent(e: RecordEvent): EventSummary {
  const b = e.body as Record<string, unknown>;
  const s = (k: string) => String(b[k] ?? '');
  switch (e.kind) {
    case 'task.assigned':
      return {
        icon: 'flag',
        label: 'Assigned',
        text: `Task #${s('taskNumber')}: ${s('title')}`,
        tone: 'neutral',
      };
    case 'task.status': {
      const to = s('to');
      const tone =
        to === 'done'
          ? 'success'
          : to === 'failed'
            ? 'danger'
            : to === 'blocked'
              ? 'warning'
              : 'info';
      return {
        icon: 'activity',
        label: 'Status',
        text: `${s('from')} → ${to}${b['reason'] ? ` — ${s('reason')}` : ''}`,
        tone,
      };
    }
    case 'workspace.prepared':
      return {
        icon: 'git-branch',
        label: 'Workspace',
        text: `Branch ${s('branch')} from ${s('baseCommit').slice(0, 8)}`,
        tone: 'neutral',
      };
    case 'bot.step':
      return {
        icon: 'terminal',
        label: 'Step',
        text: `${s('action')}: ${s('detail')}${b['outcome'] ? ` (${s('outcome')})` : ''}`,
        tone: 'neutral',
      };
    case 'diary.entry':
      return {
        icon: 'book',
        label: 'War Diary',
        term: 'war-diary',
        text: `${s('category')}: ${s('text')}`,
        tone: 'info',
      };
    case 'sitrep':
      return { icon: 'radio', label: 'Sitrep', term: 'sitrep', text: s('text'), tone: 'info' };
    case 'artifact':
      return s('kind') === 'commit'
        ? {
            icon: 'git-commit',
            label: 'Commit',
            text: `${s('summary')} (${s('ref').slice(0, 10)})`,
            tone: 'neutral',
          }
        : { icon: 'file-text', label: 'File', text: s('summary'), tone: 'neutral' };
    case 'cost':
      return {
        icon: 'coins',
        label: 'Cost',
        text: `+${s('units')} units (total ${s('total')})`,
        tone: 'neutral',
      };
    case 'credential.used':
      return {
        icon: 'key',
        label: 'Credential',
        text: `Used ${s('secretName')} to ${s('purpose')}`,
        tone: 'neutral',
      };
    case 'policy.check':
      return {
        icon: 'shield',
        label: 'Policy',
        text: `${s('action')}: ${b['allowed'] ? 'allowed' : 'held'} — ${s('reason')}`,
        tone: b['allowed'] ? 'neutral' : 'warning',
      };
    case 'redaction.applied':
      return {
        icon: 'shield',
        label: 'Redacted',
        text: `Masked ${s('count')} secret-like value(s) in ${s('where')}`,
        tone: 'warning',
      };
    case 'run.started':
      return {
        icon: 'activity',
        label: 'Run started',
        text: `Runtime: ${s('runtime')}`,
        tone: 'neutral',
      };
    case 'run.finished':
      return {
        icon: 'check',
        label: 'Run finished',
        text: `Outcome: ${s('outcome')}`,
        tone: s('outcome') === 'done' ? 'success' : 'warning',
      };
    case 'task.briefed':
      return {
        icon: 'book',
        label: 'Briefed',
        text: `${b['handoverId'] ? `Handover v${s('handoverVersion')}` : 'No handover'}, ${(b['fieldManualEntryIds'] as unknown[]).length} Field Manual entries, ${(b['diaryEventIds'] as unknown[]).length} diary entries`,
        tone: 'info',
      };
    case 'task.reassigned':
      return { icon: 'arrow-right', label: 'Reassigned', text: s('reason'), tone: 'neutral' };
    case 'curation':
      return {
        icon: 'book',
        label: 'Field Manual',
        term: 'field-manual',
        text: `${s('action')} “${s('title')}” — ${s('reason')}`,
        tone: 'info',
      };
    case 'coldstart.check':
      return {
        icon: 'activity',
        label: 'Cold start',
        term: 'cold-start',
        text: `${s('score')}/100${(b['gaps'] as unknown[]).length ? ` — ${(b['gaps'] as string[]).join(' ')}` : ''}`,
        tone: Number(b['score']) === 100 ? 'success' : 'warning',
      };
    case 'docs.synced':
      return {
        icon: 'git-commit',
        label: 'Docs',
        text: `${(b['files'] as unknown[]).length} file(s) committed${(b['imported'] as unknown[]).length ? `, imported ${(b['imported'] as string[]).join(', ')}` : ''}`,
        tone: 'neutral',
      };
    case 'chat.message':
      return { icon: 'user', label: 'Chat', text: s('text'), tone: 'neutral' };
    case 'secret.stored':
    case 'secret.revoked':
      return {
        icon: 'key',
        label: e.kind === 'secret.stored' ? 'Secret stored' : 'Secret revoked',
        text: s('secretName'),
        tone: 'neutral',
      };
    default:
      return { icon: 'info', label: e.kind, text: JSON.stringify(b), tone: 'neutral' };
  }
}
