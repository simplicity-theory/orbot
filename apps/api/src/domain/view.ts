import type { RecordVersion, Versioned } from '@orbot/shared';

export function toView<B>(v: RecordVersion<B>): Versioned<B> {
  return { ...v.body, id: v.entityId, version: v.version, updatedAt: v.createdAt, updatedBy: v.actor };
}

export const toViews = <B>(vs: RecordVersion<B>[]) => vs.map(toView);
