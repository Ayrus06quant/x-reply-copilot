export default defineUnlistedScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    import('../lib/interceptor').then(({ installFetchInterceptor }) => {
      installFetchInterceptor();
    });
  },
});
