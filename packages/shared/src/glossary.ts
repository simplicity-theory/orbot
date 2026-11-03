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
  theatre: {
    term: 'Theatre',
    short: 'A project: one codebase and where it deploys',
    meaning:
      'The standing home of a codebase: its repository, its site or environments, and the operations run in it. Open one per project.',
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
  dispute: {
    term: 'Dispute',
    short: 'Units disagree; HQ rules',
    meaning:
      'One unit disagrees with another about its work. HQ rules under their standing orders; if none settles it, you rule. Your ruling is final.',
  },
  connection: {
    term: 'Connection',
    short: 'An outside service ORBOT works with',
    meaning:
      'The code host, issue tracker and build pipeline for a repository. Branches are pushed and pull requests opened there; issues become missions; a red pipeline holds production deploys.',
  },
  'service-record': {
    term: 'Service record',
    short: 'A bot’s history of service',
    meaning:
      'What a bot has done and how: runs, outcomes, spend, refusals, and the lessons it left its unit. Worked out from the record; it never goes into a brief, because knowledge belongs to the unit.',
  },
  commendation: {
    term: 'Commendation',
    short: 'A lesson it left the unit',
    meaning: 'A Field Manual entry that came from this bot’s handover.',
  },
  'daily-brief': {
    term: 'Daily brief',
    short: 'HQ’s morning report to you',
    meaning:
      'Once a day HQ writes what happened, what is under way, what it cost, and what needs you. It is kept with every earlier brief.',
  },
  'sand-table': {
    term: 'Sand table',
    short: 'Rehearse the plan',
    meaning:
      'HQ walks an operation’s plan, mission by mission, against the units’ bots, orders, supply and budgets, and lists what would stop it before the work starts.',
  },
  recon: {
    term: 'Recon',
    short: 'Look before you leap',
    meaning:
      'A read-only survey: a bot studies the code to answer a question and files a report for its unit. It changes nothing.',
  },
  'main-effort': {
    term: 'Main effort',
    short: 'The operation that goes first',
    meaning:
      'The one operation the force puts first. Its tasks start before other work, and other work can pause (with a handover) to free a bot for it.',
  },
  escalation: {
    term: 'Escalation',
    short: 'Sent up the chain',
    meaning:
      'Something a bot or Overseer may not decide alone, waiting on a higher level — ultimately you.',
  },
  handoff: {
    term: 'Handoff',
    short: 'Work passed to the next unit',
    meaning:
      'In an operation, Engineers hand off to Inspection, Inspection to Guard, Guard to Logistics — always on the operation’s integration branch.',
  },
  'send-back': {
    term: 'Send-back',
    short: 'A failed check returns work upstream',
    meaning:
      'When a check fails, HQ sends the work back to the unit that handed it over, with the reason. After the fix, it is handed off again.',
  },
  'orders-log': {
    term: 'Orders log',
    short: 'Every change made from chat',
    meaning:
      'Each change an order in chat made, with the message that caused it. Undo adds a reversing entry; nothing is removed.',
  },
  'read-back': {
    term: 'Read-back',
    short: 'The Overseer repeating what it did',
    meaning:
      'After acting on your message, the Overseer lists every change it made, each with a link and Undo.',
  },
  'cold-start': {
    term: 'Cold-start check',
    short: 'Could a new bot carry on from the documents?',
    meaning:
      'The Overseer gives a notional fresh bot only the unit’s documents and checks it could continue the work. Gaps become Field Manual fixes.',
  },
  'approval-gate': {
    term: 'Approval gate',
    short: 'What waits for you',
    meaning:
      'Per unit: approve everything, approve backbriefs and production deploys (default), or see escalations only.',
  },
  'hold-policy': {
    term: 'Hold policy',
    short: 'What holds the work and comes to you',
    meaning:
      'Per unit, overridable per operation: how big a fix a bot makes on its own, and how bad a finding must be before the work is held for you. Automatic means nothing ever holds.',
  },
  archive: {
    term: 'Archive',
    short: 'Every prior version, kept forever',
    meaning:
      'Nothing is deleted. Rewrites create a new version; the old one is archived with who, when and why.',
  },
};

export type GlossaryKey = keyof typeof GLOSSARY;
