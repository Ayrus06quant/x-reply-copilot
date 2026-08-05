import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'X Reply Copilot',
    description:
      'Human-in-the-loop reply suggestions for X. Reads posts you view to generate drafts in your voice.',
    permissions: ['storage', 'clipboardWrite'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
  },
  hooks: {
    /**
     * F1 cost roughly 700 lines of never-executed code and three rounds of debugging inside
     * a module that had never run. The interceptor is only useful if the manifest actually
     * registers it in the page realm before X's bundle issues its first GraphQL request, so
     * the build fails rather than silently shipping a dead interceptor again.
     *
     * The same check enforces I5: no `web_accessible_resources`, because that would put a
     * chrome-extension:// URL in the page.
     */
    'build:manifestGenerated'(_wxt, manifest) {
      const scripts = manifest.content_scripts ?? [];

      const mainWorld = scripts.find(
        (s) => (s as { world?: string }).world === 'MAIN' && s.run_at === 'document_start',
      );
      if (!mainWorld) {
        throw new Error(
          'Manifest assertion failed: no MAIN-world content script at document_start. ' +
            'The GraphQL interceptor would not run. See docs/IMPLEMENTATION_GUIDELINES.md F1.',
        );
      }
      if (!mainWorld.js?.some((path) => path.includes('interceptor'))) {
        throw new Error(
          'Manifest assertion failed: the MAIN-world entry does not include the interceptor bundle.',
        );
      }
      if ((manifest as { web_accessible_resources?: unknown }).web_accessible_resources) {
        throw new Error(
          'Manifest assertion failed: web_accessible_resources would put a chrome-extension:// ' +
            'URL in the page. See docs/IMPLEMENTATION_GUIDELINES.md I5.',
        );
      }
    },
  },
});
