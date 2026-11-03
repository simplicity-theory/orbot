import type { FixSize, HoldPolicy, Severity } from './entities.js';

const SEVERITY = ['low', 'medium', 'high', 'critical'] as const;
const FIX = ['small', 'medium', 'large'] as const;

/** What a bot does with a finding under a policy: fix it now, record it, or hold the work. */
export type FindingDecision = 'fix' | 'record' | 'hold';

/**
 * `fix` is how big the fix would be, or null when it cannot be fixed by the bot at all. A fix
 * within `fixUpTo` is made on the spot; otherwise the finding is recorded, and holds the work
 * when its severity reaches `holdFrom` (never in the automatic mode).
 */
export function decideFinding(
  policy: HoldPolicy,
  severity: Severity,
  fix: FixSize | null,
): FindingDecision {
  const canFix =
    fix !== null && policy.fixUpTo !== 'none' && FIX.indexOf(fix) <= FIX.indexOf(policy.fixUpTo);
  if (canFix) return 'fix';
  if (policy.holdFrom === 'never') return 'record';
  return SEVERITY.indexOf(severity) >= SEVERITY.indexOf(policy.holdFrom) ? 'hold' : 'record';
}

/** The policy that applies to work: the operation's override, else the unit's own. */
export function effectiveHoldPolicy(unit: HoldPolicy, operation: HoldPolicy | null): HoldPolicy {
  return operation ?? unit;
}

export const HOLD_FROM_LABELS: Record<HoldPolicy['holdFrom'], string> = {
  low: 'Any finding holds the work',
  medium: 'Medium and worse hold the work',
  high: 'High and critical hold the work',
  critical: 'Only critical holds the work',
  never: 'Automatic: nothing ever holds',
};

export const FIX_UP_TO_LABELS: Record<HoldPolicy['fixUpTo'], string> = {
  none: 'Never fix: record only',
  small: 'Small fixes: a few lines inside the work under review',
  medium: 'Medium fixes: changes across the work under review',
  large: 'Any fix, rewrites included',
};

/** The policy in a sentence, for briefs, read-backs and the page. */
export function describeHoldPolicy(p: HoldPolicy): string {
  const fix =
    p.fixUpTo === 'none'
      ? 'Findings are recorded, never fixed by the bot'
      : p.fixUpTo === 'large'
        ? 'Findings are fixed on the spot whatever the size of the fix'
        : `Findings with a ${p.fixUpTo === 'small' ? 'small' : 'small or medium'} fix are fixed on the spot, the rest recorded`;
  const hold =
    p.holdFrom === 'never'
      ? 'nothing ever holds the work (automatic)'
      : p.holdFrom === 'low'
        ? 'any finding that is not fixed holds the work for the Commander'
        : `a ${p.holdFrom === 'critical' ? 'critical' : `${p.holdFrom} or worse`} finding that is not fixed holds the work for the Commander`;
  return `${fix}; ${hold}.`;
}
