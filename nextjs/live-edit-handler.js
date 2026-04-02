const path = require('path');
const fs = require('fs');
const parser = require('@babel/parser');
const _traverse = require('@babel/traverse');

// Handle both ES module and CommonJS exports
const traverse = _traverse.default || _traverse;

// ─── Cache Invalidation ─────────────────────────────────────────────────────

/**
 * Force Turbopack server-side RSC cache invalidation.
 *
 * Turbopack maintains separate caches for client HMR and server-side RSC
 * rendering. When we write to a source file via fs.writeFileSync(), the
 * file-system watcher triggers client HMR (so the browser updates), but the
 * server-side RSC cache is NOT always invalidated. This means subsequent
 * full-page requests (new tabs, refreshes) still render with old code,
 * causing hydration mismatches.
 *
 * Turbopack uses CONTENT HASHING — simply touching the file (updating mtime)
 * does NOT trigger a recompilation. We must actually change the file content.
 *
 * Strategy: toggle a harmless trailing comment in layout.tsx. This changes
 * the content hash, forcing Turbopack to recompile the entire server module
 * graph and clearing the stale RSC cache.
 */
const CACHE_BUST_MARKER = '/* live-edit-cache-bust */';

function invalidateServerCache(projectRoot) {
  const layoutCandidates = [
    path.resolve(projectRoot, 'app', 'layout.tsx'),
    path.resolve(projectRoot, 'app', 'layout.jsx'),
    path.resolve(projectRoot, 'app', 'layout.js'),
  ];

  for (const layoutPath of layoutCandidates) {
    try {
      if (fs.existsSync(layoutPath)) {
        let content = fs.readFileSync(layoutPath, 'utf-8');

        // Toggle the cache-bust marker: add if absent, remove if present.
        // This ensures every edit produces a genuine content change.
        if (content.includes(CACHE_BUST_MARKER)) {
          content = content.replace(CACHE_BUST_MARKER, '');
        } else {
          content = content + '\n' + CACHE_BUST_MARKER + '\n';
        }

        fs.writeFileSync(layoutPath, content, 'utf-8');
        console.log(`🔄 Toggled cache-bust marker in ${path.basename(layoutPath)} to invalidate server RSC cache`);
        return;
      }
    } catch (e) {
      console.warn(`⚠️ Could not modify ${path.basename(layoutPath)} for cache invalidation:`, e.message);
    }
  }

  console.warn('⚠️ No layout file found to invalidate server cache');
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Convert character position to line number and character position within line.
 * Returns 0-based indexing.
 */
function getLineAndCharPosition(content, charPosition) {
  const lines = content.split('\n');
  let currentPos = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineLength = lines[lineIndex].length + 1;

    if (charPosition < currentPos + lineLength) {
      return {
        line: lineIndex,
        character: charPosition - currentPos,
      };
    }

    currentPos += lineLength;
  }

  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate that the location data is correct in the current source file.
 * Performs bounds checking, text matching, and AST-level verification.
 */
function validateLocationInSource(originalContent, location) {
  // 1. Basic bounds checking
  if (location.start < 0 || location.end < 0) {
    return { valid: false, error: 'Invalid location: negative positions' };
  }

  if (location.start >= location.end) {
    return { valid: false, error: 'Invalid location: start >= end' };
  }

  if (location.end > originalContent.length) {
    return {
      valid: false,
      error: `Invalid location: end position ${location.end} exceeds file length ${originalContent.length}`,
    };
  }

  // 2. Verify the text at the location matches what we expect
  // The stored text may be trimmed, but start/end may span the full JSXText node
  // (which includes surrounding whitespace). Compare trimmed versions.
  const actualText = originalContent.substring(location.start, location.end);
  const expectedText = location.text;

  if (actualText.trim() !== expectedText.trim()) {
    return {
      valid: false,
      error: `Location mismatch: expected "${expectedText}" but found "${actualText}". Source file may have changed.`,
    };
  }

  // 3. AST verification based on type
  const locationType = location.type || 'text-content';

  try {
    const ast = parser.parse(originalContent, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    let foundMatchingNode = false;

    if (locationType === 'text-content') {
      // Validate JSXText node at the expected position
      traverse(ast, {
        JSXText(astPath) {
          const { node } = astPath;
          // Location start/end may be trimmed (whitespace stripped), so check
          // that they fall within the JSXText node's boundaries
          if (node.start <= location.start && node.end >= location.end) {
            foundMatchingNode = true;
            astPath.stop();
          }
        },
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST mismatch: no JSXText node at position ${location.start}-${location.end}.`,
        };
      }
    } else if (locationType === 'string-expression') {
      // Validate StringLiteral inside a JSXExpressionContainer
      traverse(ast, {
        JSXExpressionContainer(astPath) {
          const expr = astPath.node.expression;
          if (
            expr.type === 'StringLiteral' &&
            expr.start + 1 === location.start &&
            expr.end - 1 === location.end
          ) {
            foundMatchingNode = true;
            astPath.stop();
          }
        },
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST mismatch: no StringLiteral expression at position ${location.start}-${location.end}.`,
        };
      }
    } else if (locationType === 'template-literal') {
      // Validate static TemplateLiteral inside a JSXExpressionContainer
      traverse(ast, {
        JSXExpressionContainer(astPath) {
          const expr = astPath.node.expression;
          if (
            expr.type === 'TemplateLiteral' &&
            expr.expressions.length === 0 &&
            expr.quasis.length === 1
          ) {
            const quasi = expr.quasis[0];
            if (quasi.start === location.start && quasi.end === location.end) {
              foundMatchingNode = true;
              astPath.stop();
            }
          }
        },
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST mismatch: no static TemplateLiteral at position ${location.start}-${location.end}.`,
        };
      }
    } else if (locationType === 'image-src') {
      // Validate img/Image src attribute StringLiteral
      traverse(ast, {
        JSXAttribute(astPath) {
          const { node } = astPath;
          if (node.name.name === 'src' && node.value) {
            let valueNode = node.value;

            if (valueNode.type === 'JSXExpressionContainer') {
              valueNode = valueNode.expression;
            }

            if (valueNode.type === 'StringLiteral') {
              if (
                valueNode.start + 1 === location.start &&
                valueNode.end - 1 === location.end
              ) {
                foundMatchingNode = true;
                astPath.stop();
              }
            }
          }
        },
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST mismatch: no src attribute at position ${location.start}-${location.end}.`,
        };
      }
    } else if (locationType.startsWith('attribute:')) {
      // Validate a named attribute with StringLiteral value
      const attrName = locationType.split(':')[1];
      traverse(ast, {
        JSXAttribute(astPath) {
          const { node } = astPath;
          if (node.name.name === attrName && node.value) {
            let valueNode = node.value;

            if (valueNode.type === 'JSXExpressionContainer') {
              valueNode = valueNode.expression;
            }

            if (valueNode.type === 'StringLiteral') {
              if (
                valueNode.start + 1 === location.start &&
                valueNode.end - 1 === location.end
              ) {
                foundMatchingNode = true;
                astPath.stop();
              }
            }
          }
        },
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST mismatch: no ${attrName} attribute at position ${location.start}-${location.end}.`,
        };
      }
    } else if (locationType === 'style-background-image') {
      // For background images, we do positional text verification only (already done above).
      // Full AST verification of nested style objects is complex and the text match is sufficient.
      foundMatchingNode = true;
    }
  } catch (parseError) {
    return {
      valid: false,
      error: `Source file has syntax errors: ${parseError.message}`,
    };
  }

  return { valid: true };
}

/**
 * Validate that the updated content is syntactically valid JSX/TSX.
 */
function validateUpdatedContent(content, filePath) {
  try {
    parser.parse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Syntax error in updated content: ${error.message}`,
      details: error,
    };
  }
}

/**
 * Validate image URL for security and correctness.
 */
function validateImageUrl(url) {
  const dangerousProtocols = ['javascript:', 'data:text/html', 'vbscript:'];
  const lowerUrl = url.toLowerCase();

  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      return { valid: false, error: `Dangerous protocol detected: ${protocol}` };
    }
  }

  if (url.length > 2000) {
    return { valid: false, error: 'Image URL too long (max 2000 characters)' };
  }

  const validPatterns = [
    /^https?:\/\//,     // http:// or https://
    /^\/[^\/]/,         // Absolute path (starts with single /)
    /^\.\.?\//,         // Relative path (starts with ./ or ../)
    /^[a-zA-Z0-9]/,     // Relative path (no protocol)
    /^data:image\//,    // Data URI for images only
  ];

  if (!validPatterns.some(pattern => pattern.test(url))) {
    return { valid: false, error: 'Invalid image URL format' };
  }

  return { valid: true };
}

// ─── Core Update Logic ──────────────────────────────────────────────────────

/**
 * Handle text and image updates using AST-injected location data.
 * Supports all region types: text-content, string-expression, template-literal,
 * image-src, attribute:*, and style-background-image.
 *
 * @param {Object} data - The update data from the client
 * @param {Object} options - Configuration options
 * @param {string[]} options.sourceDirs - Source directories to search
 * @param {string} options.projectRoot - Project root directory
 */
async function handleEnhancedTextUpdate(data, options = {}) {
  const { element, content, imageUrl, updateType } = data;
  const {
    sourceDirs = ['app', 'components', 'src'],
    projectRoot = process.cwd(),
  } = options;

  // Normalize content field
  const actualContent = content || imageUrl;

  // === INPUT VALIDATION ===
  if (!element || !actualContent) {
    console.error('❌ Live edit failed: Missing element or content data');
    console.error('   Received data:', {
      hasElement: !!element,
      hasContent: !!content,
      hasImageUrl: !!imageUrl,
      updateType,
    });
    return { success: false, error: 'Missing element or content data' };
  }

  if (typeof actualContent !== 'string' || actualContent.length === 0) {
    console.error('❌ Live edit failed: Invalid content type or empty');
    return { success: false, error: 'Invalid content: must be a non-empty string' };
  }

  // Extract location data from element
  const sourceLocAttr = element.sourceLoc || element['data-source-loc'];
  const elementId = element.elementId || element['data-element-id'];

  console.log(`📥 Live edit request for element: ${elementId}, tagName: ${element.tagName}`);

  if (!sourceLocAttr) {
    console.error(`❌ Live edit failed: No source location data for element ${elementId}`);
    console.error('   Element data:', JSON.stringify(element, null, 2));
    return {
      success: false,
      error: 'No source location data available - element may not have been compiled with source mapping',
    };
  }

  let originalContent = null;
  let fullFilePath = null;

  try {
    // Parse the location data — handle both legacy single-object and new array format
    let parsed =
      typeof sourceLocAttr === 'string'
        ? JSON.parse(sourceLocAttr.replace(/&apos;/g, "'"))
        : sourceLocAttr;

    // Normalize to array
    const allRegions = Array.isArray(parsed) ? parsed : [parsed];

    // Determine which region(s) to edit.
    // The client can specify `regionIndex` to target a specific region,
    // or `regionType` to target by type.
    const explicitRegionIndex = data.regionIndex;
    const explicitRegionType = data.regionType;
    const hasExplicitTarget = typeof explicitRegionIndex === 'number' || !!explicitRegionType;

    // Pick the primary location (used for file resolution and type detection)
    let location;
    if (typeof explicitRegionIndex === 'number' && explicitRegionIndex < allRegions.length) {
      location = allRegions[explicitRegionIndex];
    } else if (explicitRegionType) {
      location = allRegions.find(r => r.type === explicitRegionType);
    }
    if (!location) {
      location = allRegions[0]; // default to first region
    }

    // Validate location object structure
    if (
      !location ||
      !location.file ||
      typeof location.start !== 'number' ||
      typeof location.end !== 'number'
    ) {
      return { success: false, error: 'Invalid location data structure' };
    }

    const locationType = location.type || 'text-content';

    // Collect all text-content regions (for multi-region replacement)
    const TEXT_TYPES = ['text-content', 'string-expression', 'template-literal'];
    const textRegions = allRegions
      .filter(r => TEXT_TYPES.includes(r.type))
      .sort((a, b) => a.start - b.start);

    // Determine if this is a multi-region text update:
    // - updateType is 'text' (or locationType is text-like)
    // - Element has more than one text region
    // - Client did NOT explicitly target a specific region
    const isTextType = TEXT_TYPES.includes(locationType) || (locationType && locationType.startsWith('attribute:'));
    const isMultiRegionTextUpdate =
      isTextType &&
      textRegions.length > 1 &&
      !hasExplicitTarget;

    console.log(
      `🎯 Updating ${location.file} [${locationType}] at characters ${location.start}-${location.end}` +
      (isMultiRegionTextUpdate ? ` (multi-region: ${textRegions.length} text regions)` : '')
    );

    // Try to find the file in any of the source directories
    fullFilePath = null;
    for (const dir of sourceDirs) {
      const candidate = path.resolve(projectRoot, dir, location.file);
      if (fs.existsSync(candidate)) {
        fullFilePath = candidate;
        break;
      }
    }

    // Also try resolving directly from project root
    if (!fullFilePath) {
      const directPath = path.resolve(projectRoot, location.file);
      if (fs.existsSync(directPath)) {
        fullFilePath = directPath;
      }
    }

    if (!fullFilePath) {
      return { success: false, error: `Source file not found: ${location.file}` };
    }

    // === READ & BACKUP ORIGINAL ===
    originalContent = fs.readFileSync(fullFilePath, 'utf-8');

    // === EXTRACT NEW CONTENT ===
    let newContent;

    if (locationType === 'image-src' || locationType === 'style-background-image') {
      // For images / background images — extract the URL
      if (actualContent.startsWith('<img')) {
        const srcMatch = actualContent.match(/src=["']([^"']+)["']/);
        if (srcMatch) {
          newContent = srcMatch[1];
        } else {
          return { success: false, error: 'Could not extract src from img tag' };
        }
      } else {
        newContent = actualContent;
      }

      // Validate image URL
      const urlValidation = validateImageUrl(newContent);
      if (!urlValidation.valid) {
        return { success: false, error: `Image URL validation failed: ${urlValidation.error}` };
      }

      // === Single-region image replacement ===
      const preValidation = validateLocationInSource(originalContent, location);
      if (!preValidation.valid) {
        console.error(`❌ Pre-flight validation failed: ${preValidation.error}`);
        return { success: false, error: `Validation failed: ${preValidation.error}` };
      }

      const updatedContent =
        originalContent.substring(0, location.start) +
        newContent +
        originalContent.substring(location.end);

      const postValidation = validateUpdatedContent(updatedContent, fullFilePath);
      if (!postValidation.valid) {
        console.error(`❌ Post-update validation failed: ${postValidation.error}`);
        return {
          success: false,
          error: `Updated content has syntax errors: ${postValidation.error}. Changes not applied.`,
        };
      }

      fs.writeFileSync(fullFilePath, updatedContent, 'utf-8');
      invalidateServerCache(projectRoot);
      const label = locationType === 'image-src' ? '🖼️  Image' : '🖼️  Background Image';
      console.log(`✅ ${label} updated in ${location.file}`);
      console.log(`   "${location.text}" → "${newContent}"`);

      return {
        success: true,
        message: `Updated ${path.basename(fullFilePath)}`,
        file: fullFilePath,
        type: locationType,
      };
    }

    // === TEXT CONTENT UPDATE ===

    // Strip HTML tags from client content
    newContent = actualContent;
    if (actualContent.startsWith('<') && actualContent.endsWith('>')) {
      newContent = actualContent.replace(/<[^>]*>/g, '');
    }

    // Sanitize text content
    if (newContent.length > 10000) {
      return { success: false, error: 'Content too large (max 10000 characters)' };
    }

    let updatedContent;

    if (isMultiRegionTextUpdate) {
      // ══════════════════════════════════════════════════════════════════
      // MULTI-REGION TEXT REPLACEMENT
      // When the element has multiple text regions (e.g., text split by <br />),
      // replace the entire span from the first region's start to the last
      // region's end. This removes intermediate elements (like <br />) and
      // replaces all text regions with the user's new single text.
      // ══════════════════════════════════════════════════════════════════

      const spanStart = textRegions[0].start;
      const spanEnd = textRegions[textRegions.length - 1].end;

      console.log(`   Multi-region span: ${spanStart}-${spanEnd} (${textRegions.length} regions)`);

      // Validate each region's text still matches the source file
      for (const region of textRegions) {
        const actualAtRegion = originalContent.substring(region.start, region.end);
        if (actualAtRegion.trim() !== region.text.trim()) {
          console.error(`❌ Multi-region validation failed for region ${region.start}-${region.end}`);
          console.error(`   Expected: "${region.text}", Found: "${actualAtRegion}"`);
          return {
            success: false,
            error: `Region mismatch at ${region.start}-${region.end}: source file may have changed.`,
          };
        }
      }

      updatedContent =
        originalContent.substring(0, spanStart) +
        newContent +
        originalContent.substring(spanEnd);

    } else {
      // ══════════════════════════════════════════════════════════════════
      // SINGLE-REGION TEXT REPLACEMENT
      // ══════════════════════════════════════════════════════════════════

      const preValidation = validateLocationInSource(originalContent, location);
      if (!preValidation.valid) {
        console.error(`❌ Pre-flight validation failed: ${preValidation.error}`);
        return { success: false, error: `Validation failed: ${preValidation.error}` };
      }

      console.log('✓ Pre-flight validation passed');

      // For text-content type: preserve leading/trailing whitespace from the
      // original JSXText node so formatting stays intact
      if (locationType === 'text-content') {
        const originalNodeText = originalContent.substring(location.start, location.end);
        const leadingWs = originalNodeText.match(/^(\s*)/)[1];
        const trailingWs = originalNodeText.match(/(\s*)$/)[1];
        newContent = leadingWs + newContent.trim() + trailingWs;
      }

      updatedContent =
        originalContent.substring(0, location.start) +
        newContent +
        originalContent.substring(location.end);
    }

    // === POST-UPDATE VALIDATION ===
    const postValidation = validateUpdatedContent(updatedContent, fullFilePath);
    if (!postValidation.valid) {
      console.error(`❌ Post-update validation failed: ${postValidation.error}`);
      return {
        success: false,
        error: `Updated content has syntax errors: ${postValidation.error}. Changes not applied.`,
      };
    }

    console.log('✓ Post-update validation passed');

    // === WRITE CHANGES (only after all validation passes) ===
    fs.writeFileSync(fullFilePath, updatedContent, 'utf-8');
    invalidateServerCache(projectRoot);

    console.log(`✅ 📝 Text updated in ${location.file}`);
    if (isMultiRegionTextUpdate) {
      console.log(`   [${textRegions.length} regions merged] → "${newContent}"`);
    } else {
      console.log(`   "${location.text}" → "${newContent}"`);
    }

    return {
      success: true,
      message: `Updated ${path.basename(fullFilePath)}`,
      file: fullFilePath,
      type: locationType,
    };
  } catch (error) {
    console.error('❌ Error updating source file:', error);

    // === ROLLBACK ON ERROR ===
    if (originalContent && fullFilePath) {
      try {
        fs.writeFileSync(fullFilePath, originalContent, 'utf-8');
        console.log('↩️  Rolled back to original content');
      } catch (rollbackError) {
        console.error('❌ Failed to rollback:', rollbackError);
      }
    }

    return { success: false, error: error.message };
  }
}

// ─── API Route Handlers ─────────────────────────────────────────────────────

/**
 * CORS headers for the live-edit API.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Create a Next.js App Router API route handler for live editing.
 *
 * Usage in app/api/live-edit/route.js:
 *
 *   const { createLiveEditHandler } = require('@codedesignai/nextjs-live-edit-plugin/live-edit-handler');
 *   const { POST, OPTIONS } = createLiveEditHandler();
 *   module.exports = { POST, OPTIONS };
 *
 * Or for ES modules (app/api/live-edit/route.ts):
 *
 *   import { createLiveEditHandler } from '@codedesignai/nextjs-live-edit-plugin/live-edit-handler';
 *   export const { POST, OPTIONS } = createLiveEditHandler();
 *
 * @param {Object} options
 * @param {string[]} options.sourceDirs - Directories to search for source files
 * @param {string} options.projectRoot - Project root directory
 */
function createLiveEditHandler(options = {}) {
  const handlerOptions = {
    sourceDirs: options.sourceDirs || ['app', 'components', 'src'],
    projectRoot: options.projectRoot || process.cwd(),
  };

  async function POST(request) {

    try {
      const data = await request.json();
      console.log('🔄 Received enhanced live edit request:', JSON.stringify(data, null, 2));

      const result = await handleEnhancedTextUpdate(data, handlerOptions);

      if (result.success) {
        return new Response(JSON.stringify({ success: true, message: result.message }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } else {
        return new Response(JSON.stringify({ success: false, error: result.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    } catch (error) {
      console.error('❌ Error processing enhanced live edit request:', error);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  }

  async function OPTIONS() {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  return { POST, OPTIONS };
}

/**
 * Create a Pages Router API handler (for pages/api/live-edit.js)
 *
 * Usage:
 *   const { createPagesApiHandler } = require('@codedesignai/nextjs-live-edit-plugin/live-edit-handler');
 *   module.exports = createPagesApiHandler();
 */
function createPagesApiHandler(options = {}) {
  const handlerOptions = {
    sourceDirs: options.sourceDirs || ['app', 'components', 'src'],
    projectRoot: options.projectRoot || process.cwd(),
  };

  return async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'Method Not Allowed' });
      return;
    }


    try {
      const data = req.body;
      console.log('🔄 Received enhanced live edit request:', JSON.stringify(data, null, 2));

      const result = await handleEnhancedTextUpdate(data, handlerOptions);

      if (result.success) {
        res.status(200).json({ success: true, message: result.message });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error('❌ Error processing enhanced live edit request:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  handleEnhancedTextUpdate,
  validateLocationInSource,
  validateUpdatedContent,
  validateImageUrl,
  createLiveEditHandler,
  createPagesApiHandler,
};
