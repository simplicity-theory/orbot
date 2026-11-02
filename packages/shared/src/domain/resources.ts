import type { OperationNeed, ResourceKind, SupplyBody } from './entities.js';

/** The resource kind a depot item counts as, or null if it cannot meet a need. */
export function resourceKindOf(s: SupplyBody): ResourceKind | null {
  switch (s.spec.kind) {
    case 'repository':
      return 'repository';
    case 'credential':
      return 'credential';
    case 'model':
      return 'model';
    case 'environment':
      return s.spec.server ? 'server' : 'environment';
    default:
      return null;
  }
}

/** Whether a depot item meets a need: the right kind (a server is an environment too) and tier. */
export function meetsNeed(need: OperationNeed, s: SupplyBody): boolean {
  if (!s.connected) return false;
  const kind = resourceKindOf(s);
  const kindOk = kind === need.kind || (need.kind === 'environment' && kind === 'server');
  if (!kindOk) return false;
  if (!need.tier) return true;
  return s.spec.kind === 'environment' && (s.spec.details['tier'] ?? 'staging') === need.tier;
}

export interface NeedStatus {
  need: OperationNeed;
  /** Assigned resources that meet it (ids). */
  metBy: string[];
}

/** Each need, with the assigned resources that meet it. */
export function needStatus(
  needs: OperationNeed[],
  assigned: { id: string; body: SupplyBody }[],
): NeedStatus[] {
  return needs.map((need) => ({
    need,
    metBy: assigned.filter((a) => meetsNeed(need, a.body)).map((a) => a.id),
  }));
}

/** Required needs no assigned resource meets: while there are any, the operation is blocked. */
export function missingNeeds(
  needs: OperationNeed[],
  assigned: { id: string; body: SupplyBody }[],
): OperationNeed[] {
  return needStatus(needs, assigned)
    .filter((n) => !n.need.optional && !n.metBy.length)
    .map((n) => n.need);
}

/** "a repository to work in and a production environment to deploy to" */
export function describeNeeds(needs: OperationNeed[]): string {
  const parts = needs.map((n) => n.label.charAt(0).toLowerCase() + n.label.slice(1));
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
