# @codedesignai/nextjs-live-edit-plugin

A Next.js plugin for live editing React components with AST-powered source mapping. Enables precise, character-level updates to your source files directly from the browser.

This is the Next.js port of `@codedesignai/vite-live-edit-plugin` with 100% feature parity.

## Features

- 🎯 **AST-Powered Source Mapping** — Injects precise location data into JSX elements via a custom webpack loader
- 📝 **Text Content Editing** — Edit text content directly from the browser
- 🖼️ **Image Source Editing** — Update image sources with validation
- ✅ **Full Validation** — Pre and post-update validation with rollback capability
- 🔒 **Security** — Validates URLs and content before applying changes
- ⚡ **Fast Refresh Integration** — Changes trigger Next.js Fast Refresh automatically

## Installation

```bash
npm install @codedesignai/nextjs-live-edit-plugin
```

Or from Git:

```bash
npm install git+https://github.com/codedesignapp/ai-companion-live-edit-plugin.git#nextjs
```

## Setup

### 1. Update `next.config.js`

```javascript
const { withLiveEdit } = require('@codedesignai/nextjs-live-edit-plugin');

module.exports = withLiveEdit({
  // your existing Next.js config options
});
```

Or with TypeScript/ESM (`next.config.ts`):

```typescript
import { withLiveEdit } from '@codedesignai/nextjs-live-edit-plugin';

export default withLiveEdit({
  // your existing Next.js config options
});
```

#### Custom Source Directories

By default, the plugin processes `.jsx` and `.tsx` files in `app/`, `components/`, and `src/`. To customize:

```javascript
module.exports = withLiveEdit(
  { /* next config */ },
  { sourceDirs: ['app', 'components', 'src', 'features'] }
);
```

### 2. Add the API Route

#### App Router (`app/api/live-edit/route.js`)

```javascript
const { createLiveEditHandler } = require('@codedesignai/nextjs-live-edit-plugin/live-edit-handler');

const { POST, OPTIONS } = createLiveEditHandler();

module.exports = { POST, OPTIONS };
```

Or with TypeScript/ESM:

```typescript
import { createLiveEditHandler } from '@codedesignai/nextjs-live-edit-plugin/live-edit-handler';

export const { POST, OPTIONS } = createLiveEditHandler();
```

#### Pages Router (`pages/api/live-edit.js`)

```javascript
const { createPagesApiHandler } = require('@codedesignai/nextjs-live-edit-plugin/live-edit-handler');

module.exports = createPagesApiHandler();
```

## How It Works

1. **Source Mapping** (build time): The webpack loader parses `.jsx`/`.tsx` files with `@babel/parser`, walks the AST, and injects `data-element-id` and `data-source-loc` attributes into JSX elements that contain text or image sources.

2. **Live Editing** (runtime): The `/api/live-edit` endpoint receives update requests from the browser, validates the location data against the actual source file (including AST-level verification), applies the text/image change, and lets Next.js Fast Refresh handle the reload.

### API Endpoint

```
POST /api/live-edit
Content-Type: application/json

{
  "element": {
    "tagName": "P",
    "elementId": "Home-p-L5-0",
    "sourceLoc": {
      "file": "page.tsx",
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
- Next.js >= 13.0.0
- React (for JSX support)

## Configuration

The plugin automatically:
- Only runs in development mode
- Only processes `.jsx` and `.tsx` files in configured source directories
- Only adds the webpack loader for client-side builds (not server-side)
- Injects source mapping data into JSX elements for browser interaction

No additional configuration is required beyond the two setup steps above.

## Comparison with Vite Plugin

| Concept | Vite Plugin | Next.js Plugin |
|---|---|---|
| Source mapping | `sourceMapperPlugin()` (Vite transform hook) | Custom webpack loader |
| Live edit API | `enhancedLiveEditPlugin()` (dev server middleware) | Next.js API route |
| Hot reload | `server.reloadModule()` | Automatic Fast Refresh |
| File filter | `src/` directory | `app/`, `components/`, `src/` (configurable) |

## License

MIT
