import { z } from 'zod';

/**
 * The single status vocabulary used everywhere in the app. Every status is
 * rendered as colour + icon + text label, never colour alone.
 */
export const STATUSES = [
  'idle',
  'queued',
  'working',
  'blocked',
  'failed',
  'awaiting-approval',
  'stood-down',
  'done',
  /** A server's health check. */
  'healthy',
  'degraded',
  'down',
] as const;

export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export type StatusTone = 'neutral' | 'info' | 'active' | 'warning' | 'danger' | 'success' | 'muted';

export interface StatusMeta {
  label: string;
  /** Icon name in the web app's icon set. */
  icon: string;
  tone: StatusTone;
  /** True when this status should surface on the ORBAT attention strip. */
  needsAttention: boolean;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  idle: { label: 'Idle', icon: 'circle', tone: 'neutral', needsAttention: false },
  queued: { label: 'Queued', icon: 'clock', tone: 'info', needsAttention: false },
  working: { label: 'Working', icon: 'activity', tone: 'active', needsAttention: false },
  blocked: { label: 'Blocked', icon: 'octagon-pause', tone: 'warning', needsAttention: true },
  failed: { label: 'Failed', icon: 'triangle-alert', tone: 'danger', needsAttention: true },
  'awaiting-approval': {
    label: 'Awaiting approval',
    icon: 'stamp',
    tone: 'warning',
    needsAttention: true,
  },
  'stood-down': { label: 'Stood down', icon: 'pause', tone: 'muted', needsAttention: false },
  done: { label: 'Done', icon: 'check', tone: 'success', needsAttention: false },
  healthy: { label: 'Healthy', icon: 'check', tone: 'success', needsAttention: false },
  degraded: { label: 'Degraded', icon: 'triangle-alert', tone: 'warning', needsAttention: true },
  down: { label: 'Down', icon: 'x', tone: 'danger', needsAttention: true },
};

export const BotStatus = z.enum(['idle', 'working', 'blocked', 'failed', 'stood-down']);
export type BotStatus = z.infer<typeof BotStatus>;

export const TaskStatus = z.enum([
  'queued',
  'working',
  'blocked',
  'failed',
  'awaiting-approval',
  'stood-down',
  'done',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed'];
