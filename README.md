# @codedesign/vite-live-edit-plugin

A Vite plugin for live editing React components with AST-powered source mapping. Enables precise, character-level updates to your source files directly from the browser.

## Features

- 🎯 **AST-Powered Source Mapping** - Injects precise location data into JSX elements
- 📝 **Text Content Editing** - Edit text content directly from the browser
- 🖼️ **Image Source Editing** - Update image sources with validation
- ✅ **Full Validation** - Pre and post-update validation with rollback capability
- 🔒 **Security** - Validates URLs and content before applying changes
- ⚡ **HMR Integration** - Automatically triggers Vite's Hot Module Reload

## Installation

### Option 1: Private npm Registry

```bash
npm install @codedesign/vite-live-edit-plugin --registry=https://registry.npmjs.org/
```

### Option 2: GitHub Packages

```bash
npm install @codedesign/vite-live-edit-plugin --registry=https://npm.pkg.github.com
```

### Option 3: Local Installation (Development)

```bash
npm install /path/to/codedesign-live-edit-plugin
```

Or using a git repository:

```bash
npm install git+https://github.com/your-org/codedesign-live-edit-plugin.git
```

## Usage

### vite.config.js

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sourceMapperPlugin, enhancedLiveEditPlugin } from '@codedesign/vite-live-edit-plugin';

export default defineConfig({
  plugins: [
    sourceMapperPlugin(), // MUST BE FIRST - before any other transformations
    react(),
    enhancedLiveEditPlugin(),
  ],
});
```

### How It Works

1. **Source Mapping**: The `sourceMapperPlugin()` injects `data-element-id` and `data-source-loc` attributes into JSX elements during development.

2. **Live Editing**: The `enhancedLiveEditPlugin()` sets up an API endpoint at `/api/live-edit` that:
   - Receives update requests from the browser
   - Validates the location data
   - Updates the source file
   - Triggers HMR to reflect changes immediately

### API Endpoint

The plugin exposes a POST endpoint at `/api/live-edit`:

```javascript
POST /api/live-edit
Content-Type: application/json

{
  "element": {
    "tagName": "P",
    "elementId": "Home-p-L5-0",
    "sourceLoc": {
      "file": "pages/Home.jsx",
      "start": 123,
      "end": 145,
      "text": "Original text",
      "type": "text-content"
    }
  },
  "content": "New text content"
}
```

## Requirements

- Node.js >= 18.0.0
- Vite >= 4.0.0
- React (for JSX support)

## Development

### Building

This package uses ES modules and doesn't require a build step. The source code is ready to use.

### Testing

1. Install dependencies:
   ```bash
   npm install
   ```

2. Link locally for testing:
   ```bash
   npm link
   ```

3. In your project:
   ```bash
   npm link @codedesign/vite-live-edit-plugin
   ```

## Publishing

### To Private npm Registry

1. **Login to npm**:
   ```bash
   npm login --registry=https://registry.npmjs.org/
   ```

2. **Publish** (package.json already has `"private": true`, so this will fail unless you have a paid npm account):
   ```bash
   npm publish --access restricted
   ```

   Note: For truly private packages, you need an npm paid account or use GitHub Packages.

### To GitHub Packages

1. **Create `.npmrc` in the package directory**:
   ```
   @codedesign:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
   ```

2. **Login**:
   ```bash
   npm login --registry=https://npm.pkg.github.com --scope=@codedesign
   ```

3. **Publish**:
   ```bash
   npm publish
   ```

### To Git Repository (Private)

1. **Remove `"private": true` from package.json** (or keep it, it doesn't affect git installs)

2. **Tag and push**:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. **Install in projects**:
   ```bash
   npm install git+https://github.com/your-org/codedesign-live-edit-plugin.git#v1.0.0
   ```

## Configuration

The plugin automatically:
- Only runs in development mode (`NODE_ENV !== 'production'`)
- Only processes `.jsx` and `.tsx` files in the `src/` directory
- Injects source mapping data into JSX elements

No additional configuration is required.

## License

MIT

## Support

For issues and questions, please open an issue in the repository.
