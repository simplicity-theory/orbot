import {
  BadRequestException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { AlertKind, RecordEvent } from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { Background } from '../common/background.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { HQ_ACTOR } from './overseers.js';

interface Alert {
  kind: AlertKind | 'test';
  title: string;
  text: string;
  /** App route the alert opens. */
  link: string;
  urgent?: boolean;
}

/** HTTP headers are Latin-1: fold typographic punctuation, drop the rest. */
const ascii = (s: string) =>
  s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '');

/**
 * Phone alerts. When something needs the Commander (an escalation reaches them, a plan or
 * a production deploy waits for approval, a dispute is referred, work is held at a budget
 * cap, a rehearsal says no-go, the daily brief is ready), HQ pushes a short alert to an
 * ntfy-style URL: POST the text, with Title, Priority, Tags and Click headers. The URL is
 * a secret, used by name from the secrets store and never recorded. Every alert is on the
 * record (`alert.sent`), redacted, with whether delivery worked.
 */
@Injectable()
export class AlertService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;
  /** Things already alerted (per process), so a revision doesn't alert twice. */
  private readonly seen = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly redaction: RedactionService,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      const alert = n.type === 'version' ? this.fromVersion(n.version) : this.fromEvent(n.event);
      if (alert) this.background.run('hq:alerts', 'alert', () => this.notify(alert));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private once(key: string, alert: Alert): Alert | null {
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    return alert;
  }

  private fromVersion(v: {
    entityType: string;
    entityId: string;
    unitId: string | null;
    version: number;
    body: unknown;
  }): Alert | null {
    const b = v.body as Record<string, unknown>;
    if (v.entityType === 'backbrief' && b['status'] === 'awaiting-approval') {
      return this.once(`bb:${v.entityId}:${String(b['round'])}`, {
        kind: 'approval',
        title: 'A plan waits for your approval',
        text: String(b['summary'] ?? 'A backbrief is ready.'),
        link: `/approvals#backbrief-${v.entityId}`,
      });
    }
    if (v.entityType === 'task' && b['status'] === 'awaiting-approval' && b['kind'] === 'deploy') {
      return this.once(`deploy:${v.entityId}`, {
        kind: 'deploy',
        title: `Production deploy waits for you: task #${String(b['number'])}`,
        text: String(b['title']),
        link: `/units/${String(b['unitId'])}/tasks/${v.entityId}`,
        urgent: true,
      });
    }
    if (v.entityType === 'dispute' && b['status'] === 'referred') {
      return this.once(`dispute:${v.entityId}`, {
        kind: 'dispute',
        title: 'A dispute is yours to rule on',
        text: String(b['claim']),
        link: `/disputes#dispute-${v.entityId}`,
        urgent: true,
      });
    }
    if (v.entityType === 'document' && b['kind'] === 'daily-brief' && v.version === 1) {
      return this.once(`brief:${v.entityId}`, {
        kind: 'daily-brief',
        title: String(b['title']),
        text: 'HQ has written your daily brief.',
        link: '/brief',
      });
    }
    return null;
  }

  private fromEvent(e: RecordEvent): Alert | null {
    if (e.kind === 'escalation') {
      const x = (e as RecordEvent<'escalation'>).body;
      if (x.level !== 'commander') return null;
      return this.once(`esc:${x.chainId}`, {
        kind: 'escalation',
        title: 'Escalated to you',
        text: `${x.text} ${x.action}`,
        link: '/approvals',
        urgent: true,
      });
    }
    if (e.kind === 'task.status') {
      const x = (e as RecordEvent<'task.status'>).body;
      if (x.to !== 'blocked' || !x.reason?.includes('Compute budget cap reached')) return null;
      return this.once(`budget:${e.taskId}:${e.id}`, {
        kind: 'budget',
        title: 'Work held at a budget cap',
        text: x.reason,
        link: e.unitId ? `/units/${e.unitId}` : '/',
      });
    }
    if (e.kind === 'sand-table') {
      const x = (e as RecordEvent<'sand-table'>).body;
      if (x.verdict !== 'no-go' || !e.operationId) return null;
      return this.once(`sand:${e.id}`, {
        kind: 'sand-table',
        title: 'Sand table: no-go',
        text: x.findings
          .filter((f) => f.severity === 'blocker')
          .map((f) => f.text)
          .join(' '),
        link: `/operations/${e.operationId}#sand-table`,
      });
    }
    return null;
  }

  /** Send an alert if alerts are on and the Commander wants this kind. */
  async notify(alert: Alert): Promise<RecordEvent<'alert.sent'> | null> {
    const s = (await this.settings.get()).alerts;
    if (!s?.enabled || !s.credentialName) return null;
    if (alert.kind !== 'test' && !s.kinds.includes(alert.kind)) return null;
    return this.deliver(alert, s.credentialName);
  }

  /** A test alert, whatever the kinds chosen. */
  async test(actor: string): Promise<RecordEvent<'alert.sent'>> {
    const s = (await this.settings.get()).alerts;
    if (!s?.credentialName) {
      throw new BadRequestException({
        message: 'No push URL is set for phone alerts.',
        action:
          'Store your push URL as a credential in the Supply Depot, then choose it under Settings → Phone alerts.',
      });
    }
    return this.deliver(
      {
        kind: 'test',
        title: 'ORBOT test alert',
        text: 'Phone alerts are working. You will hear from HQ when something needs you.',
        link: '/settings',
      },
      s.credentialName,
      actor,
    );
  }

  async recent(limit = 10): Promise<RecordEvent<'alert.sent'>[]> {
    // Newest first.
    return (
      (await this.record.listEvents(
        { kinds: ['alert.sent'], limit },
        { latest: true },
      )) as RecordEvent<'alert.sent'>[]
    ).reverse();
  }

  private async deliver(
    alert: Alert,
    credentialName: string,
    actor = HQ_ACTOR,
  ): Promise<RecordEvent<'alert.sent'>> {
    const title = this.redaction.clean(alert.title);
    const text = this.redaction.clean(alert.text).slice(0, 1000);
    const click = `${this.config.webOrigin.replace(/\/$/, '')}${alert.link}`;
    let error: string | null = null;
    try {
      const url = await this.secrets.reveal(credentialName);
      const res = await fetch(url, {
        method: 'POST',
        body: text,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: ascii(title),
          Priority: alert.urgent ? 'high' : 'default',
          Tags: alert.kind,
          Click: click,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) error = `The push service answered ${res.status} ${res.statusText}.`;
    } catch (err) {
      error = (err as Error).message;
    }
    return (await this.record.event(
      'alert.sent',
      {
        kind: alert.kind,
        title,
        text,
        link: alert.link,
        credentialName,
        delivered: !error,
        // Never the URL: errors are redacted, and the URL itself is a registered secret.
        error: error ? this.redaction.clean(error) : null,
      },
      {},
      actor,
    )) as RecordEvent<'alert.sent'>;
  }
}
