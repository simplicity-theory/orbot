import { z } from 'zod';

/**
 * Who is acting. Every request, bot action and system job carries a Principal,
 * so ranks and additional officers can be added later without touching call sites.
 */
export const PrincipalKind = z.enum(['commander', 'officer', 'bot', 'system']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const Principal = z.object({
  kind: PrincipalKind,
  id: z.string().min(1),
  displayName: z.string().min(1),
  /** For people: the Commander's rank is `commander`; officers carry theirs. */
  rank: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;

/** Stable string form stored in the record, e.g. `bot:7f1c…`. */
export type ActorRef = `${PrincipalKind}:${string}`;

export function actorRef(p: Pick<Principal, 'kind' | 'id'>): ActorRef {
  return `${p.kind}:${p.id}`;
}

export function parseActorRef(ref: string): { kind: PrincipalKind; id: string } {
  const idx = ref.indexOf(':');
  const kind = PrincipalKind.parse(ref.slice(0, idx));
  return { kind, id: ref.slice(idx + 1) };
}

export const SYSTEM_PRINCIPAL: Principal = {
  kind: 'system',
  id: 'orbot',
  displayName: 'ORBOT system',
};

/**
 * Officers' ranks, highest first. A Commander commands everything; a Captain commands the
 * units assigned to them; an Observer reads everything and orders nothing.
 */
export const Rank = z.enum(['commander', 'captain', 'observer']);
export type Rank = z.infer<typeof Rank>;
export const RANK_LABEL: Record<Rank, string> = {
  commander: 'Commander',
  captain: 'Captain',
  observer: 'Observer',
};
