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
});
