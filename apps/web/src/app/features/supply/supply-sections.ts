import type { SupplyView } from '@orbot/shared';
import type { IconName } from '../../ui/icons';

/** The depot's sections, in the order you set things up: a server needs its key stored first. */
export const SUPPLY_SECTIONS = [
  {
    id: 'repositories',
    label: 'Repositories',
    icon: 'git-branch',
    add: 'Connect repository',
    lede: 'Code your units work on. Each task gets its own git worktree from the local clone. Start one from a template (a single HTML file) or connect your own.',
    empty: 'No repositories yet',
    emptyBody:
      'Start a repository from a template, or connect a local repository or a clone URL. Then issue it to the units that should work on it.',
  },
  {
    id: 'credentials',
    label: 'Credentials',
    icon: 'key',
    add: 'Store credential',
    lede: 'Tokens, passwords and SSH keys. Values are write-only; everything refers to them by name.',
    empty: 'No credentials yet',
    emptyBody:
      'Store a token for GitHub, or an SSH private key for a server. Nobody, bots included, ever sees the value again.',
  },
  {
    id: 'environments',
    label: 'Servers & environments',
    icon: 'server',
    add: 'Add server or environment',
    lede: 'Dev servers bots build and test on, staging, production, and static sites ORBOT publishes itself. Issuing production gives deploy rights.',
    empty: 'No servers or environments yet',
    emptyBody:
      'Add a dev server for bots to build and test on, the staging and production environments they deploy to, or a static site ORBOT publishes with no server at all.',
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'bot',
    add: null,
    lede: 'Language models served from your own servers over an OpenAI-compatible API, with their keys by name.',
    empty: 'No models yet',
    emptyBody:
      'Open a server with a GPU under Servers & environments and install vLLM on it: the model it serves appears here.',
  },
  {
    id: 'connections',
    label: 'Connections',
    term: 'connection',
    icon: 'link',
    add: 'Connect GitHub',
    lede: 'Code host, issue tracker and build pipeline for a repository. Manage issues in Connections.',
    empty: 'No connections yet',
    emptyBody:
      'Connect GitHub for a repository: bots push branches and open pull requests, take issues on as missions, and a red pipeline holds production deploys.',
  },
] as const satisfies readonly {
  id: string;
  label: string;
  term?: string;
  icon: IconName;
  add: string | null;
  lede: string;
  empty: string;
  emptyBody: string;
}[];
export type SupplySection = (typeof SUPPLY_SECTIONS)[number]['id'];

export function sectionOf(s: SupplyView): SupplySection {
  switch (s.spec.kind) {
    case 'repository':
      return 'repositories';
    case 'credential':
      return 'credentials';
    case 'connection':
      return 'connections';
    case 'model':
      return 'models';
    default:
      return 'environments';
  }
}

/** `?connect=` is what an Overseer said was missing, e.g. "billing repository". */
export function parseWanted(wanted: string): { section: SupplySection; name: string } {
  const section: SupplySection = /environment|server/i.test(wanted)
    ? 'environments'
    : /credential|token|key/i.test(wanted)
      ? 'credentials'
      : 'repositories';
  const name = wanted.replace(/\b(repository|environment|server|credential)\b/gi, '').trim();
  return { section, name };
}

export function tierOf(s: SupplyView): string | null {
  return s.spec.kind === 'environment' ? (s.spec.details['tier'] ?? null) : null;
}

export function iconOf(s: SupplyView): IconName {
  switch (s.spec.kind) {
    case 'repository':
      return 'git-branch';
    case 'credential':
      return 'key';
    case 'connection':
      return 'link';
    case 'model':
      return 'bot';
    case 'environment':
      return s.spec.server ? 'server' : s.spec.site ? 'file-text' : 'grid';
    default:
      return 'coins';
  }
}
