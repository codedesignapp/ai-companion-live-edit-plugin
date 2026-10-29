const path = require('path');

/**
 * Next.js config wrapper that enables the live edit plugin.
 * Uses Turbopack's built-in webpack loader support via turbopack.rules.
 *
 * NOTE: Only Turbopack is supported. Adding a `webpack` key to the config
 * causes hydration mismatches in Next.js 16 because the loader would only
 * run on client-side builds, while server-rendered HTML has no data attributes.
 *
 * Usage in next.config.js (CommonJS):
 *
 *   const { withLiveEdit } = require('@codedesignai/nextjs-live-edit-plugin');
 *   module.exports = withLiveEdit({
 *     // your normal Next.js config
 *   });
 *
 * Usage in next.config.ts (ESM):
 *
 *   import { withLiveEdit } from '@codedesignai/nextjs-live-edit-plugin';
 *   export default withLiveEdit({
 *     // your normal Next.js config
 *   });
 *
 * @param {Object} nextConfig - Your Next.js configuration object
 * @param {Object} pluginOptions - Plugin-specific options
 * @param {string[]} pluginOptions.sourceDirs - Directories to process (default: ['app', 'components', 'src'])
 * @returns {Object} Modified Next.js configuration
 */
function withLiveEdit(nextConfig = {}, pluginOptions = {}) {
  const sourceDirs = pluginOptions.sourceDirs || ['app', 'components', 'src'];
  const projectRoot = pluginOptions.projectRoot || process.cwd();

  const loaderPath = path.resolve(__dirname, 'source-mapper-loader.js');
  const loaderConfig = {
    loader: loaderPath,
    options: {
      sourceDirs,
      projectRoot,
    },
  };

  // Merge with existing turbopack config
  const existingTurbopack = nextConfig.turbopack || {};
  const existingRules = existingTurbopack.rules || {};

  // Merge allowedDevOrigins — sandbox domains need cross-origin HMR access
  // for React hydration to complete (which <Script strategy="afterInteractive"> depends on)
  const existingOrigins = nextConfig.allowedDevOrigins || [];

  // Merge with existing experimental config — disable caching that prevents
  // live-edit changes from being reflected in SSR output on overlayfs containers
  const existingExperimental = nextConfig.experimental || {};

  // Merge rewrites — add sidecar proxy (/__sc → localhost:9960) so the backend
  // can reach the sandbox-server through the ALB's public URL.
  const existingRewrites = nextConfig.rewrites;

  return {
    ...nextConfig,
    experimental: {
      ...existingExperimental,
      // Turbopack's persistent filesystem cache does not reliably invalidate
      // on overlayfs (Docker/ECS), causing stale SSR renders after file edits
      // The HMR cache retains server component render results between refreshes,
      // preventing edited content from appearing on full-page loads
      serverComponentsHmrCache: false,
    },
    allowedDevOrigins: [...existingOrigins, '*.miraqal.com', '*.codedesign.one', '*.cdsn.app'],
    async rewrites() {
      // Sidecar rewrite — always present
      const sidecarRewrites = [
        { source: '/__sc/:path*', destination: 'http://127.0.0.1:9960/:path*' },
      ];
      // Merge with user-defined rewrites (if any)
      if (typeof existingRewrites === 'function') {
        const userRewrites = await existingRewrites();
        if (Array.isArray(userRewrites)) {
          return [...sidecarRewrites, ...userRewrites];
        }
        // User returned { beforeFiles, afterFiles, fallback } shape
        return {
          ...userRewrites,
          beforeFiles: [...sidecarRewrites, ...(userRewrites.beforeFiles || [])],
        };
      }
      return sidecarRewrites;
    },
    turbopack: {
      ...existingTurbopack,
      rules: {
        ...existingRules,
        // Apply our source mapper loader to JSX and TSX files
        '*.jsx': {
          loaders: [loaderConfig],
        },
        '*.tsx': {
          loaders: [loaderConfig],
        },
      },
    },
  };
}

module.exports = { withLiveEdit };
