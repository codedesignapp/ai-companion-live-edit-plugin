const path = require('path');
const fs = require('fs');
const parser = require('@babel/parser');
const _traverse = require('@babel/traverse');

// Handle both ES module and CommonJS exports
const traverse = _traverse.default || _traverse;

/**
 * Convert character position to line number and character position within line
 * Returns 0-based indexing (line 0 = first line, char 0 = first character in line)
 */
function getLineAndCharPosition(content, charPosition) {
  const lines = content.split('\n');
  let currentPos = 0;
  
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineLength = lines[lineIndex].length + 1; // +1 for newline character
    
    if (charPosition < currentPos + lineLength) {
      const charInLine = charPosition - currentPos;
      return {
        line: lineIndex,
        character: charInLine
      };
    }
    
    currentPos += lineLength;
  }
  
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

/**
 * Validate that the location data is correct in the current source file
 * Returns validation result with details
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
    return { valid: false, error: `Invalid location: end position ${location.end} exceeds file length ${originalContent.length}` };
  }

  // 2. Verify the text at the location matches what we expect
  const actualText = originalContent.substring(location.start, location.end);
  const expectedText = location.text;
  
  if (actualText !== expectedText) {
    return { 
      valid: false, 
      error: `Location mismatch: expected "${expectedText}" but found "${actualText}". Source file may have changed.` 
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
      // Validate JSXText node
      traverse(ast, {
        JSXText(astPath) {
          const { node } = astPath;
          if (node.start === location.start && node.end === location.end) {
            foundMatchingNode = true;
            astPath.stop();
          }
        }
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST structure mismatch: no JSXText node found at position ${location.start}-${location.end}. Source structure may have changed.`
        };
      }
    } else if (locationType === 'image-src') {
      // Validate img src attribute
      traverse(ast, {
        JSXAttribute(astPath) {
          const { node } = astPath;
          if (node.name.name === 'src' && node.value) {
            let valueNode = node.value;
            
            // Handle string literals and expression containers
            if (valueNode.type === 'JSXExpressionContainer') {
              valueNode = valueNode.expression;
            }
            
            if (valueNode.type === 'StringLiteral') {
              const actualStart = valueNode.start + 1;
              const actualEnd = valueNode.end - 1;
              
              if (actualStart === location.start && actualEnd === location.end) {
                foundMatchingNode = true;
                astPath.stop();
              }
            }
          }
        }
      });

      if (!foundMatchingNode) {
        return {
          valid: false,
          error: `AST structure mismatch: no img src attribute found at position ${location.start}-${location.end}. Source structure may have changed.`
        };
      }
    }
  } catch (parseError) {
    return {
      valid: false,
      error: `Source file has syntax errors: ${parseError.message}`
    };
  }

  return { valid: true };
}

/**
 * Validate that the updated content is syntactically valid
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
      details: error
    };
  }
}

/**
 * Validate image URL for security and correctness
 */
function validateImageUrl(url) {
  // Reject potentially harmful protocols
  const dangerousProtocols = ['javascript:', 'data:text/html', 'vbscript:'];
  const lowerUrl = url.toLowerCase();
  
  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      return { valid: false, error: `Dangerous protocol detected: ${protocol}` };
    }
  }

  // Basic length check
  if (url.length > 2000) {
    return { valid: false, error: 'Image URL too long (max 2000 characters)' };
  }

  // Allow relative paths, http(s), data:image, and common protocols
  const validPatterns = [
    /^https?:\/\//,           // http:// or https://
    /^\/[^\/]/,               // Absolute path (starts with single /)
    /^\.\.?\//,               // Relative path (starts with ./ or ../)
    /^[a-zA-Z0-9]/,           // Relative path (no protocol)
    /^data:image\//,          // Data URI for images only
  ];

  const isValid = validPatterns.some(pattern => pattern.test(url));
  
  if (!isValid) {
    return { valid: false, error: 'Invalid image URL format' };
  }

  return { valid: true };
}

/**
 * Handle text and image updates using AST-injected location data
 * PRODUCTION-READY with full validation and rollback capability
 * 
 * @param {Object} data - The update data from the client
 * @param {Object} options - Configuration options
 * @param {string[]} options.sourceDirs - Source directories to search (default: ['app', 'components', 'src'])
 * @param {string} options.projectRoot - Project root directory (default: process.cwd())
 */
async function handleEnhancedTextUpdate(data, options = {}) {
  const { element, content, imageUrl, updateType } = data;
  const { sourceDirs = ['app', 'components', 'src'], projectRoot = process.cwd() } = options;
  
  // Normalize content field - handle both 'content' and 'imageUrl'
  const actualContent = content || imageUrl;
  
  // === INPUT VALIDATION ===
  if (!element || !actualContent) {
    console.error('❌ Live edit failed: Missing element or content data');
    console.error('   Received data:', { hasElement: !!element, hasContent: !!content, hasImageUrl: !!imageUrl, updateType });
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
    return { success: false, error: 'No source location data available - element may not have been compiled with source mapping' };
  }

  let originalContent = null; // Backup for rollback
  let fullFilePath = null;

  try {
    // Parse the location data (it's a JSON string)
    const location = typeof sourceLocAttr === 'string' 
      ? JSON.parse(sourceLocAttr.replace(/&apos;/g, "'")) 
      : sourceLocAttr;
    
    // Validate location object structure
    if (!location || !location.file || typeof location.start !== 'number' || typeof location.end !== 'number') {
      return { success: false, error: 'Invalid location data structure' };
    }

    const locationType = location.type || 'text-content';
    
    console.log(`🎯 Updating ${location.file} [${locationType}] at characters ${location.start}-${location.end}`);
    
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
    
    // === PRE-FLIGHT VALIDATION ===
    const preValidation = validateLocationInSource(originalContent, location);
    if (!preValidation.valid) {
      console.error(`❌ Pre-flight validation failed: ${preValidation.error}`);
      return { success: false, error: `Validation failed: ${preValidation.error}` };
    }
    
    console.log('✓ Pre-flight validation passed');
    
    // === EXTRACT NEW CONTENT ===
    let newContent;
    
    if (locationType === 'image-src') {
      // For images, extract the src value
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
    } else {
      // For text content, extract text from HTML if needed
      newContent = actualContent;
      if (actualContent.startsWith('<') && actualContent.endsWith('>')) {
        newContent = actualContent.replace(/<[^>]*>/g, '');
      }

      // Sanitize text content
      if (newContent.length > 10000) {
        return { success: false, error: 'Content too large (max 10000 characters)' };
      }
    }

    // === APPLY UPDATE ===
    const updatedContent = 
      originalContent.substring(0, location.start) + 
      newContent + 
      originalContent.substring(location.end);
    
    // === POST-UPDATE VALIDATION ===
    const postValidation = validateUpdatedContent(updatedContent, fullFilePath);
    if (!postValidation.valid) {
      console.error(`❌ Post-update validation failed: ${postValidation.error}`);
      return { 
        success: false, 
        error: `Updated content has syntax errors: ${postValidation.error}. Changes not applied.` 
      };
    }
    
    console.log('✓ Post-update validation passed');
    
    // === WRITE CHANGES (only after all validation passes) ===
    fs.writeFileSync(fullFilePath, updatedContent, 'utf-8');

    // Next.js Fast Refresh will automatically detect the file change
    // No need to manually trigger HMR like in Vite

    const updateLabel = locationType === 'image-src' ? '🖼️  Image' : '📝 Text';
    console.log(`✅ ${updateLabel} updated in ${location.file}`);
    console.log(`   "${location.text}" → "${newContent}"`);
    
    return { 
      success: true, 
      message: `Updated ${path.basename(fullFilePath)}`,
      file: fullFilePath,
      type: locationType
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

/**
 * CORS headers for the live-edit API
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
    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
      return new Response(
        JSON.stringify({ success: false, error: 'Live editing is only available in development mode' }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    try {
      const data = await request.json();
      console.log('🔄 Received enhanced live edit request:', JSON.stringify(data, null, 2));

      const result = await handleEnhancedTextUpdate(data, handlerOptions);
      
      if (result.success) {
        return new Response(
          JSON.stringify({ success: true, message: result.message }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      } else {
        return new Response(
          JSON.stringify({ success: false, error: result.error }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    } catch (error) {
      console.error('❌ Error processing enhanced live edit request:', error);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
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

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Only allow POST
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'Method Not Allowed' });
      return;
    }

    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ success: false, error: 'Live editing is only available in development mode' });
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

module.exports = {
  handleEnhancedTextUpdate,
  validateLocationInSource,
  validateUpdatedContent,
  validateImageUrl,
  createLiveEditHandler,
  createPagesApiHandler,
};
