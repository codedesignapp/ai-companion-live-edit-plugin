const path = require('path');
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
 * Custom webpack loader that injects AST-powered source mapping data
 * into JSX elements. This is the Next.js equivalent of the Vite
 * sourceMapperPlugin() transform hook.
 *
 * Injects `data-element-id` and `data-source-loc` attributes into:
 * - Text content elements (JSXText nodes)
 * - Image elements (<img> and <Image>) with src attributes
 */
module.exports = function sourceMapperLoader(source) {
  // Only run in development mode
  if (process.env.NODE_ENV === 'production') {
    return source;
  }

  const resourcePath = this.resourcePath;
  const options = this.getOptions() || {};
  
  // Configurable source directories (default: app, components, src)
  const sourceDirs = options.sourceDirs || ['app', 'components', 'src'];
  const projectRoot = options.projectRoot || process.cwd();

  // Only process JSX/TSX files
  if (!/\.(jsx|tsx)$/.test(resourcePath)) {
    return source;
  }

  // Check if the file is in one of the configured source directories
  const relativePath = path.relative(projectRoot, resourcePath);
  const isInSourceDir = sourceDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath.startsWith(dir + '/'));
  
  if (!isInSourceDir) {
    return source;
  }

  // Use the first matching source dir to compute the relative path for element IDs
  const matchingDir = sourceDirs.find(dir => relativePath.startsWith(dir + path.sep) || relativePath.startsWith(dir + '/'));
  const relativeToSrcDir = matchingDir ? path.relative(matchingDir, relativePath) : relativePath;

  const modifications = [];

  try {
    const ast = parser.parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    traverse(ast, {
      JSXElement(astPath) {
        const { node } = astPath;
        const openingElement = node.openingElement;
        
        // Handle JSXIdentifier and JSXMemberExpression
        let tagName;
        if (openingElement.name.type === 'JSXIdentifier') {
          tagName = openingElement.name.name;
        } else if (openingElement.name.type === 'JSXMemberExpression') {
          // e.g., motion.div → use the property name
          tagName = openingElement.name.property.name;
        } else {
          return; // Skip unsupported tag name types
        }
        
        const { line } = openingElement.loc.start;

        // === HANDLE IMAGE ELEMENTS (both <img> and <Image>) ===
        const isImageElement = tagName === 'img' || tagName === 'Image';
        
        if (isImageElement) {
          // Find the src attribute
          const srcAttribute = openingElement.attributes.find(attr => 
            attr.type === 'JSXAttribute' && attr.name && attr.name.name === 'src'
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
                return;
              } else {
                // Skip dynamic expressions (variables, etc.)
                return;
              }
            }

            if (srcValue !== undefined) {
              // Get line-based positions for chat AI mode
              const startLinePos = getLineAndCharPosition(source, srcStart);
              const endLinePos = getLineAndCharPosition(source, srcEnd);
              
              const locationData = {
                file: relativeToSrcDir,
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

              const elementId = generateElementId(relativeToSrcDir, line, tagName, 0);
              
              const insertPosition = openingElement.selfClosing 
                ? openingElement.end - 2  // Before '/>'
                : openingElement.end - 1; // Before '>'

              const attributes = ` data-element-id="${elementId}" data-source-loc='${JSON.stringify(locationData).replace(/'/g, "&apos;")}'`;

              modifications.push({ position: insertPosition, text: attributes });
            }
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

        // Only inject once per element, using the FIRST text child
        const firstTextNode = textChildren[0];
        
        // Get line-based positions for chat AI mode
        const startLinePos = getLineAndCharPosition(source, firstTextNode.start);
        const endLinePos = getLineAndCharPosition(source, firstTextNode.end);
        
        const locationData = {
          file: relativeToSrcDir,
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

        const elementId = generateElementId(relativeToSrcDir, line, tagName, 0);
        
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
      let transformedCode = source.split('');
      modifications.sort((a, b) => b.position - a.position).forEach(mod => {
        transformedCode.splice(mod.position, 0, mod.text);
      });
      return transformedCode.join('');
    }

  } catch (e) {
    // Don't break the build on parse errors - just skip transformation
    console.error(`❌ [nextjs-live-edit] Failed to parse ${relativePath}:`, e.message);
  }

  return source;
};
