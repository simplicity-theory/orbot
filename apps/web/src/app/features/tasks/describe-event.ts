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
    case 'server.command': {
      const code = b['exitCode'];
      const last = s('output').trim().split('\n').pop() ?? '';
      return {
        icon: 'terminal',
        label: 'Server',
        text: `${s('server')}: ${s('command')} → ${code === null ? 'stopped' : `exit ${String(code)}`}${last ? ` — ${last.slice(0, 160)}` : ''}`,
        tone: code === 0 ? 'neutral' : 'warning',
      };
    }
    case 'app.install': {
      const st = s('status');
      const verb =
        {
          started: 'install started',
          installed: 'installed',
          failed: 'failed',
          removed: 'removed',
        }[st] ?? st;
      return {
        icon: 'server',
        label: 'App',
        text: `${s('app')} on ${s('server')}: ${verb}${b['message'] ? ` — ${s('message')}` : ''}`,
        tone: st === 'failed' ? 'danger' : st === 'installed' ? 'success' : 'neutral',
      };
    }
    case 'server.workspace':
      return {
        icon: 'user',
        label: 'Workspace',
        text: `Bot workspace set up on ${s('server')}: bots' dev work runs as ${s('user')}`,
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
    case 'operation.phase':
      return {
        icon: 'flag',
        label: 'Phase',
        term: 'operation',
        text: `${s('from')} → ${s('to')}: ${s('reason')}`,
        tone: 'info',
      };
    case 'handoff':
      return {
        icon: 'arrow-right',
        label: 'Handoff',
        term: 'handoff',
        text: `Handed off at ${s('commit').slice(0, 10)}`,
        tone: 'success',
      };
    case 'sendback':
      return {
        icon: 'undo',
        label: 'Send-back',
        term: 'send-back',
        text: s('reason'),
        tone: 'warning',
      };
    case 'integration':
      return {
        icon: 'git-commit',
        label: 'Integrated',
        text: `${s('from')} → ${s('branch')}`,
        tone: 'neutral',
      };
    case 'deployment':
      return {
        icon: 'check',
        label: 'Deployed',
        text: `${s('environment')} at ${s('commit').slice(0, 10)}`,
        tone: 'success',
      };
    case 'deploy.approval':
      return {
        icon: 'stamp',
        label: 'Deploy',
        text: `${s('status')}${b['note'] ? `: ${s('note')}` : ''}`,
        tone: s('status') === 'approved' ? 'success' : 'warning',
      };
    case 'after-action':
      return {
        icon: 'book',
        label: 'After Action',
        term: 'after-action',
        text: `${(b['lessons'] as unknown[]).length} lesson(s) kept as standing orders`,
        tone: 'info',
      };
    case 'dispute.raised':
      return {
        icon: 'users',
        label: 'Dispute',
        term: 'dispute',
        text: `With ${s('against')}: ${s('claim')}`,
        tone: 'warning',
      };
    case 'deconfliction':
      return {
        icon: 'git-branch',
        label: 'Deconfliction',
        text: `${(b['paths'] as string[]).join(', ')} changed by ${(b['taskIds'] as string[]).length} active tasks`,
        tone: 'warning',
      };
    case 'escalation': {
      const level =
        { overseer: 'Overseer', hq: 'HQ', commander: 'To you' }[s('level')] ?? s('level');
      return {
        icon: 'arrow-right',
        label: `Escalation · ${level}`,
        term: 'escalation',
        text: `${s('text')} ${s('action')}`,
        tone: s('level') === 'commander' ? 'danger' : 'warning',
      };
    }
    case 'escalation.resolved':
      return { icon: 'check', label: 'Escalation closed', text: s('note'), tone: 'success' };
    case 'budget.warning':
      return {
        icon: 'coins',
        label: 'Budget warning',
        text: `${s('label')} has used ${String(b['spent'])} of ${String(b['cap'])} units`,
        tone: 'warning',
      };
    case 'budget.set':
      return {
        icon: 'coins',
        label: 'Budget set',
        text: `Cap ${String(b['from'] ?? 'none')} → ${String(b['to'] ?? 'none')}`,
        tone: 'info',
      };
    case 'sand-table':
      return {
        icon: 'activity',
        label: 'Sand table',
        term: 'sand-table',
        text: b['verdict'] === 'go' ? 'Rehearsal: go.' : 'Rehearsal: no-go.',
        tone: b['verdict'] === 'go' ? 'success' : 'danger',
      };
    case 'connection.pr':
      return {
        icon: 'link',
        label: 'Pull request',
        term: 'connection',
        text: `#${String(b['number'])} opened for ${s('branch')} → ${s('base')}.`,
        tone: 'info',
      };
    case 'pipeline.status':
      return {
        icon: 'activity',
        label: 'Pipeline',
        term: 'connection',
        text: `${s('branch')} at ${s('sha').slice(0, 10)}: ${
          b['state'] === 'success' ? 'passed' : b['state'] === 'failure' ? 'failed' : 'running'
        }.`,
        tone: b['state'] === 'success' ? 'success' : b['state'] === 'failure' ? 'danger' : 'info',
      };
    case 'issue.taken':
      return {
        icon: 'link',
        label: 'Issue taken on',
        term: 'connection',
        text: `#${String(b['number'])} ${s('title')}`,
        tone: 'info',
      };
    case 'issue.closed':
      return {
        icon: 'check',
        label: 'Issue closed',
        term: 'connection',
        text: `#${String(b['number'])}: ${s('comment')}`,
        tone: 'success',
      };
    case 'connection.error':
      return {
        icon: 'triangle-alert',
        label: 'Connection error',
        term: 'connection',
        text: `${s('what')}: ${s('error')}`,
        tone: 'danger',
      };
    case 'report.filed':
      return {
        icon: 'search',
        label: 'Report filed',
        term: 'recon',
        text: s('title'),
        tone: 'info',
      };
    case 'main-effort':
      return {
        icon: 'crosshair',
        label: 'Main effort',
        term: 'main-effort',
        text: b['operationId']
          ? `A new main effort was named: ${s('reason')}`
          : `No main effort any more: ${s('reason')}`,
        tone: 'info',
      };
    case 'main-effort.yield':
      return {
        icon: 'crosshair',
        label: 'Made way',
        term: 'main-effort',
        text:
          b['how'] === 'moved'
            ? 'Moved to a free bot so the main effort starts now.'
            : 'Paused with a handover to free a bot for the main effort; back in the queue.',
        tone: 'info',
      };
    case 'stand-down':
      return {
        icon: 'octagon-pause',
        label: 'Stand down',
        term: 'stood-down',
        text: `${b['scope'] === 'all' ? 'All units' : `One ${String(b['scope'])}`}: ${s('reason')}`,
        tone: 'warning',
      };
    case 'stand-down.lifted':
      return {
        icon: 'activity',
        label: 'Resumed',
        term: 'stood-down',
        text: `Stand-down lifted: ${s('reason')}`,
        tone: 'success',
      };
    case 'frago':
      return { icon: 'radio', label: 'Frago', term: 'frago', text: s('text'), tone: 'warning' };
    case 'orders.log':
      return { icon: 'book', label: 'Order', term: 'orders-log', text: s('summary'), tone: 'info' };
    case 'chat.readback':
      return {
        icon: 'check',
        label: 'Read-back',
        term: 'read-back',
        text: s('text'),
        tone: 'neutral',
      };
    case 'pending.action':
      return { icon: 'clock', label: 'Pending', text: s('summary'), tone: 'warning' };
    case 'pending.resolved':
      return { icon: 'check', label: 'Answered', text: s('outcome'), tone: 'neutral' };
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
