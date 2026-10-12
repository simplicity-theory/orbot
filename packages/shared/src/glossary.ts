/**
 * The single source for every military term shown in the UI. Glossary tooltips
 * read from here; add a term here and it becomes hoverable everywhere.
 */
export interface GlossaryEntry {
  term: string;
  short: string;
  meaning: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  orbat: {
    term: 'ORBAT',
    short: 'Order of battle',
    meaning: 'The home screen: every unit, who commands it, what it is doing, and what needs you.',
  },
  hq: {
    term: 'HQ',
    short: 'Headquarters',
    meaning:
      'The planning layer between you and the units. Splits operations into missions and routes cross-unit orders.',
  },
  overseer: {
    term: 'Overseer',
    short: 'Unit commander bot',
    meaning:
      'The bot that commands a unit: it takes your orders, directs the unit’s bots and reports back.',
  },
  operation: {
    term: 'Operation',
    short: 'A large piece of work owned by HQ',
    meaning:
      'Starts from your statement of intent and is split into missions, one per unit involved.',
  },
  mission: {
    term: 'Mission',
    short: 'A unit’s share of an operation',
    meaning: 'Owned by one Overseer, with a goal and a definition of done. Broken down into tasks.',
  },
  intent: {
    term: 'Intent',
    short: 'What you want achieved and why',
    meaning: 'Your statement of the outcome. Everything in an operation is planned from it.',
  },
  'o-group': {
    term: 'O Group',
    short: 'Orders group',
    meaning: 'The briefing where HQ issues orders to the Overseers involved in an operation.',
  },
  backbrief: {
    term: 'Backbrief',
    short: 'A unit’s plan, briefed back for approval',
    meaning:
      'After orders, each Overseer explains how its unit will carry them out. You approve or amend it.',
  },
  sitrep: {
    term: 'Sitrep',
    short: 'Situation report',
    meaning: 'A short progress report from a bot, a unit or HQ.',
  },
  frago: {
    term: 'Frago',
    short: 'Fragmentary order',
    meaning:
      'A change to orders already given — e.g. “drop the mobile layout for now”. Can be issued at any time.',
  },
  'after-action': {
    term: 'After Action review',
    short: 'Lessons learned',
    meaning: 'Held at the end of an operation. Lasting lessons become standing orders.',
  },
  wilco: {
    term: 'Wilco',
    short: 'Will comply',
    meaning:
      'The Overseer understood your order and has acted on it. The read-back card lists exactly what changed.',
  },
  'standing-orders': {
    term: 'Standing orders',
    short: 'Rules that always apply to a unit',
    meaning: 'Apply to every task the unit runs until you change them.',
  },
  roe: {
    term: 'Rules of engagement',
    short: 'What a bot may do alone',
    meaning: 'Splits actions into those a bot may take on its own and those it must escalate.',
  },
  'war-diary': {
    term: 'War Diary',
    short: 'The unit’s running log',
    meaning: 'Written automatically as bots work: decisions, surprises and notes.',
  },
  'field-manual': {
    term: 'Field Manual',
    short: 'The unit’s lasting knowledge',
    meaning: 'Curated by the Overseer from handovers. Any replacement bot is briefed from it.',
  },
  handover: {
    term: 'Handover',
    short: 'Notes for whoever comes next',
    meaning:
      'Written by every bot at the end of every task: state, next steps, what failed, open problems.',
  },
  supply: {
    term: 'Supply',
    short: 'What a unit is allowed to use',
    meaning:
      'Repositories, environments, tools, credential references and compute budget, issued from the Supply Depot.',
  },
  'supply-depot': {
    term: 'Supply Depot',
    short: 'Everything you have connected',
    meaning: 'Only what you have connected exists. Units draw their supply from here.',
  },
  'stood-down': {
    term: 'Stood down',
    short: 'Halted, ready to resume',
    meaning: 'Work is paused with a handover so it can be picked up again.',
  },
  escalation: {
    term: 'Escalation',
    short: 'Sent up the chain',
    meaning:
      'Something a bot or Overseer may not decide alone, waiting on a higher level — ultimately you.',
  },
  archive: {
    term: 'Archive',
    short: 'Every prior version, kept forever',
    meaning:
      'Nothing is deleted. Rewrites create a new version; the old one is archived with who, when and why.',
  },
};

export type GlossaryKey = keyof typeof GLOSSARY;
