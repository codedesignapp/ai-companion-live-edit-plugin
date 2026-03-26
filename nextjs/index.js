const path = require('path');

/**
 * Next.js config wrapper that enables the live edit plugin.
 * Uses Turbopack's built-in webpack loader support via turbopack.rules.
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

  // Only add source mapping in development mode
  if (process.env.NODE_ENV === 'production') {
    return nextConfig;
  }

  const loaderPath = path.resolve(__dirname, 'source-mapper-loader.js');
  const loaderConfig = {
    loader: loaderPath,
    options: {
      sourceDirs,
      projectRoot: process.cwd(),
    },
  };

  // Merge with existing turbopack config
  const existingTurbopack = nextConfig.turbopack || {};
  const existingRules = existingTurbopack.rules || {};

  return {
    ...nextConfig,
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
