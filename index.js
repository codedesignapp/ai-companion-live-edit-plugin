import path from 'path';
import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';

// Handle both ES module and CommonJS exports
const traverse = _traverse.default || _traverse;

/**
 * AST-powered source mapping plugin
 * Injects precise character-level location data for 100% accurate updates
 */
export function sourceMapperPlugin() {
  return {
    name: 'source-mapper',
    enforce: 'pre',
    transform(code, id) {
      // Only run in development mode
      if (process.env.NODE_ENV === 'production') {
        return null;
      }

      // Only process JSX/TSX files in src directory
      if (!id.includes('/src/') || !(/\.(jsx|tsx)$/.test(id))) {
        return null;
      }

      const srcDir = path.resolve(process.cwd(), 'src');
      const relativePath = path.relative(srcDir, id);
      
      // Use AST to inject precise location data
      const modifications = [];

      try {
        const ast = parser.parse(code, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript'],
        });

        traverse(ast, {
          JSXElement(astPath) {
            const { node } = astPath;
            const openingElement = node.openingElement;
            const tagName = openingElement.name.name;
            const { line } = openingElement.loc.start;

            // === HANDLE IMAGE ELEMENTS (both <img> and <Image>) ===
            const isImageElement = tagName === 'img' || tagName === 'Image';
            
            if (isImageElement) {
              // Find the src attribute
              const srcAttribute = openingElement.attributes.find(attr => 
                attr.type === 'JSXAttribute' && attr.name.name === 'src'
              );

              if (srcAttribute && srcAttribute.value) {
                let srcValue, srcStart, srcEnd;

                // Handle different src value types
                if (srcAttribute.value.type === 'StringLiteral') {
                  // src="image.jpg"
                  srcValue = srcAttribute.value.value;
                  srcStart = srcAttribute.value.start + 1; // Skip opening quote
                  srcEnd = srcAttribute.value.end - 1;     // Skip closing quote
                } else if (srcAttribute.value.type === 'JSXExpressionContainer') {
                  // src={variable} or src={`template`}
                  const expression = srcAttribute.value.expression;
                  if (expression.type === 'StringLiteral') {
                    srcValue = expression.value;
                    srcStart = expression.start + 1;
                    srcEnd = expression.end - 1;
                  } else if (expression.type === 'TemplateLiteral') {
                    // For template literals, we'll skip for now as they're dynamic
                    console.log(`⏭️  Skipping ${tagName} with template literal src at line ${line} in ${relativePath}`);
                    return;
                  } else {
                    // Skip dynamic expressions (variables, etc.)
                    console.log(`⏭️  Skipping ${tagName} with dynamic expression src at line ${line} in ${relativePath}`);
                    return;
                  }
                }

                if (srcValue !== undefined) {
                  // Get line-based positions for chat AI mode
                  const startLinePos = getLineAndCharPosition(code, srcStart);
                  const endLinePos = getLineAndCharPosition(code, srcEnd);
                  
                  const locationData = {
                    file: relativePath,
                    start: srcStart,
                    end: srcEnd,
                    text: srcValue,
                    type: 'image-src', // Mark this as an image source
                    // Line-based information for chat AI mode (0-based indexing)
                    line: startLinePos.line,
                    character: startLinePos.character,
                    endLine: endLinePos.line,
                    endCharacter: endLinePos.character
                  };

                  const elementId = generateElementId(relativePath, line, tagName, 0);
                  
                  const insertPosition = openingElement.selfClosing 
                    ? openingElement.end - 2  // Before '/>'
                    : openingElement.end - 1; // Before '>'

                  const attributes = ` data-element-id="${elementId}" data-source-loc='${JSON.stringify(locationData).replace(/'/g, "&apos;")}'`;

                  modifications.push({ position: insertPosition, text: attributes });
                  console.log(`✅ Injected source mapping for ${tagName} at line ${line} in ${relativePath} (src: ${srcValue})`);
                }
              } else {
                console.log(`⚠️  ${tagName} at line ${line} in ${relativePath} has no src attribute or src is empty`);
              }
              return; // Done processing this image element
            }

            // === HANDLE TEXT CONTENT ELEMENTS ===
            // Find text content children
            const textChildren = node.children.filter(child => 
              child.type === 'JSXText' && child.value.trim().length > 0
            );

            // Skip if no text content
            if (textChildren.length === 0) return;

            // FIXED: Only inject once per element, using the FIRST text child
            // (Multiple text children means mixed content like "text <strong>more</strong> text")
            const firstTextNode = textChildren[0];
            
            // Get line-based positions for chat AI mode
            const startLinePos = getLineAndCharPosition(code, firstTextNode.start);
            const endLinePos = getLineAndCharPosition(code, firstTextNode.end);
            
            const locationData = {
              file: relativePath,
              start: firstTextNode.start,
              end: firstTextNode.end,
              text: firstTextNode.value.trim(),
              type: 'text-content', // Mark this as text content
              // Line-based information for chat AI mode (0-based indexing)
              line: startLinePos.line,
              character: startLinePos.character,
              endLine: endLinePos.line,
              endCharacter: endLinePos.character
            };

            const elementId = generateElementId(relativePath, line, tagName, 0);
            
            // Inject attributes into the opening tag
            const insertPosition = openingElement.selfClosing 
              ? openingElement.end - 2  // Before '/>'
              : openingElement.end - 1; // Before '>'

            const attributes = ` data-element-id="${elementId}" data-source-loc='${JSON.stringify(locationData).replace(/'/g, "&apos;")}'`;

            modifications.push({ position: insertPosition, text: attributes });
          },
        });

        // Apply modifications from end to start to preserve positions
        if (modifications.length > 0) {
          let transformedCode = code.split('');
          modifications.sort((a, b) => b.position - a.position).forEach(mod => {
            transformedCode.splice(mod.position, 0, mod.text);
          });
          return { code: transformedCode.join(''), map: null };
        }

      } catch (e) {
        console.error(`❌ Failed to parse ${relativePath}:`, e.message);
      }

      return null;
    },
  };
}

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
        line: lineIndex,        // 0-based line number
        character: charInLine   // 0-based character position within line
      };
    }
    
    currentPos += lineLength;
  }
  
  // Fallback - shouldn't happen with valid positions
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

/**
 * Generate a unique element ID
 */
function generateElementId(filePath, lineNumber, elementName, index = 0) {
  const fileName = path.basename(filePath, path.extname(filePath));
  const cleanFileName = fileName.replace(/[^a-zA-Z0-9]/g, '');
  return `${cleanFileName}-${elementName}-L${lineNumber}-${index}`;
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
          // Check if this JSXText node is at the expected position
          if (node.start === location.start && node.end === location.end) {
            foundMatchingNode = true;
            astPath.stop(); // Stop traversal once found
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
              // Account for quotes: value.start+1 to value.end-1
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
    // If we can't parse the original file, it's already broken
    return {
      valid: false,
      error: `Source file has syntax errors: ${parseError.message}`
    };
  }

  return { valid: true };
}

/**
 * Validate that the updated content is syntactically valid
 * Returns true if valid, false otherwise
 */
function validateUpdatedContent(content, filePath) {
  try {
    // Parse the updated content to ensure it's valid
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
 */
async function handleEnhancedTextUpdate(data, server) {
  const { element, content, imageUrl, updateType } = data;
  
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
    
    const fs = await import('fs');
    const srcDir = path.resolve(process.cwd(), 'src');
    fullFilePath = path.resolve(srcDir, location.file);

    // Validate file exists
    if (!fs.existsSync(fullFilePath)) {
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
      // Content might be full <img> tag or just URL
      if (actualContent.startsWith('<img')) {
        // Extract src from img tag
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
      // DO NOT WRITE - content is invalid
      return { 
        success: false, 
        error: `Updated content has syntax errors: ${postValidation.error}. Changes not applied.` 
      };
    }
    
    console.log('✓ Post-update validation passed');
    
    // === WRITE CHANGES (only after all validation passes) ===
    fs.writeFileSync(fullFilePath, updatedContent, 'utf-8');

    const updateType = locationType === 'image-src' ? '🖼️  Image' : '📝 Text';
    console.log(`✅ ${updateType} updated in ${location.file}`);
    console.log(`   "${location.text}" → "${newContent}"`);

    // === TRIGGER HMR ===
    const module = server.moduleGraph.getModuleById(fullFilePath);
    if (module) {
      server.reloadModule(module);
    }
    
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
        const fs = await import('fs');
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
 * Enhanced live edit plugin that uses source mapping
 */
export function enhancedLiveEditPlugin() {
  return {
    name: 'enhanced-live-edit',
    config: () => ({
      server: {
        allowedHosts: true
      }
    }),
    configureServer(server) {
      // Add API endpoint for receiving text changes with source mapping
      server.middlewares.use('/api/live-edit', (req, res, next) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }

        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });

        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            console.log('🔄 Received enhanced live edit request:', JSON.stringify(data, null, 2));

            const result = await handleEnhancedTextUpdate(data, server);
            
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, message: result.message }));
            } else {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, error: result.error }));
            }
          } catch (error) {
            console.error('❌ Error processing enhanced live edit request:', error);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: error.message }));
          }
        });
      });

      // Handle OPTIONS requests for CORS
      server.middlewares.use('/api/live-edit', (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.statusCode = 200;
          res.end();
          return;
        }
        next();
      });
    }
  };
}
