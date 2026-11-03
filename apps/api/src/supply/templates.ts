import type { ProjectShape } from '@orbot/shared';

/**
 * What a new repository starts with. Kept small: the product is what the units build, the
 * template only fixes its shape and says so where every bot will read it (the README).
 */
export interface RepositoryTemplate {
  id: 'single-html' | 'empty';
  label: string;
  /** The first commit's message. */
  commit: string;
  project: ProjectShape | null;
  files: (name: string) => Record<string, string>;
}

const SINGLE_HTML_README = (name: string) => `# ${name}

This project is **one self-contained HTML file**: \`index.html\` is the whole product.

Rules that come with that shape:

- No build step, no package manager, no server. Markup, styles and scripts live inline in
  \`index.html\`. Nothing is fetched from a CDN or any other origin at runtime.
- It must work opened straight from disk (\`file://\`) and when served as a plain file.
- Anything the product remembers lives in the browser (\`localStorage\` or files the user
  saves and opens again).
- Keep it accessible (keyboard, labels, contrast) and usable on a phone.
- Tests, if any, are a second file (\`test.html\`) that loads nothing but \`index.html\`'s code;
  the product itself ships as the one file.

Deploying means publishing \`index.html\` as it is on the main branch. ORBOT does that: the
deploy task publishes it to the project's static site, and the same file can be downloaded and
opened anywhere.
`;

const SINGLE_HTML_INDEX = (name: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <!--
      ${name} is a single-file web app: everything it needs is in this file.
      No build step, no server, no requests to other origins at runtime.
    -->
    <style>
      :root {
        color-scheme: light dark;
        --space: 1rem;
      }
      body {
        margin: 0;
        padding: var(--space);
        font-family: system-ui, sans-serif;
        line-height: 1.5;
        max-width: 48rem;
        margin-inline: auto;
      }
      main {
        display: grid;
        gap: var(--space);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p>Nothing here yet. The units build the product in this file.</p>
    </main>
    <script>
      // The app's code starts here. Keep it in this file.
    </script>
  </body>
</html>
`;

export const TEMPLATES: RepositoryTemplate[] = [
  {
    id: 'single-html',
    label: 'Single HTML file',
    commit: 'Start the project: one self-contained HTML file',
    project: { kind: 'single-html', entry: 'index.html' },
    files: (name) => ({
      'README.md': SINGLE_HTML_README(name),
      'index.html': SINGLE_HTML_INDEX(name),
    }),
  },
  {
    id: 'empty',
    label: 'Empty',
    commit: 'Start the project',
    project: null,
    files: (name) => ({ 'README.md': `# ${name}\n` }),
  },
];

export function templateById(id: RepositoryTemplate['id']): RepositoryTemplate {
  return TEMPLATES.find((t) => t.id === id)!;
}
