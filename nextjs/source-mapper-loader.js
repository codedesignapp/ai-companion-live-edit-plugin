const path = require('path');
const parser = require('@babel/parser');
const _traverse = require('@babel/traverse');

// Handle both ES module and CommonJS exports
const traverse = _traverse.default || _traverse;

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Tags whose content is never visible text on the page.
 * We skip these entirely to avoid injecting data attributes into non-visible elements.
 */
const EXCLUDED_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'head', 'noscript',
  'title', 'html', 'base', 'template',
]);

/**
 * Elements whose `src` attribute is an editable image source.
 */
const IMAGE_ELEMENTS = new Set(['img', 'Image']);

/**
 * Attributes that contain user-visible text worth making editable.
 * Scoped to `placeholder` per the current requirements.
 */
const TEXT_ATTRIBUTES = new Set(['placeholder']);

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Convert character position to line number and character position within line.
 * Returns 0-based indexing (line 0 = first line, char 0 = first character in line).
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

  // Fallback — shouldn't happen with valid positions
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

/**
 * Generate a unique element ID.
 * Uses a file-wide counter to avoid collisions when multiple same-tag
 * elements appear on the same line.
 */
function generateElementId(filePath, lineNumber, elementName, counter) {
  const fileName = path.basename(filePath, path.extname(filePath));
  const cleanFileName = fileName.replace(/[^a-zA-Z0-9]/g, '');
  return `${cleanFileName}-${elementName}-L${lineNumber}-${counter}`;
}

/**
 * Build a region descriptor for injection into data-source-loc.
 */
function makeRegion(source, file, start, end, text, type) {
  const startPos = getLineAndCharPosition(source, start);
  const endPos = getLineAndCharPosition(source, end);
  return {
    file,
    start,
    end,
    text,
    type,
    line: startPos.line,
    character: startPos.character,
    endLine: endPos.line,
    endCharacter: endPos.character,
  };
}

/**
 * Resolve the tag name string from an opening element's name node.
 * Handles JSXIdentifier (`div`) and JSXMemberExpression (`motion.div`).
 * Returns null for unsupported name types (JSXNamespacedName, etc.).
 */
function resolveTagName(nameNode) {
  if (nameNode.type === 'JSXIdentifier') {
    return nameNode.name;
  }
  if (nameNode.type === 'JSXMemberExpression') {
    return nameNode.property.name;
  }
  return null;
}

/**
 * Extract a string literal value from a JSXAttribute's value node.
 * Handles both bare StringLiterals and JSXExpressionContainer wrapping.
 * Returns { value, start, end } or null.
 */
function extractStringFromAttrValue(valueNode) {
  if (!valueNode) return null;

  if (valueNode.type === 'StringLiteral') {
    return {
      value: valueNode.value,
      start: valueNode.start + 1, // skip opening quote
      end: valueNode.end - 1,     // skip closing quote
    };
  }

  if (valueNode.type === 'JSXExpressionContainer') {
    const expr = valueNode.expression;
    if (expr.type === 'StringLiteral') {
      return {
        value: expr.value,
        start: expr.start + 1,
        end: expr.end - 1,
      };
    }
  }

  return null;
}

// ─── Webpack Loader ─────────────────────────────────────────────────────────

/**
 * Custom webpack / Turbopack loader that injects AST-powered source mapping
 * data into JSX elements for live editing.
 *
 * Injects `data-element-id` and `data-source-loc` attributes for:
 *   - Text content (JSXText, string expressions, static template literals)
 *   - Image sources (<img>, <Image> src)
 *   - Text-bearing attributes (placeholder)
 *   - Inline backgroundImage styles
 */
module.exports = function sourceMapperLoader(source) {
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
  const isInSourceDir = sourceDirs.some(
    dir => relativePath.startsWith(dir + path.sep) || relativePath.startsWith(dir + '/')
  );

  if (!isInSourceDir) {
    return source;
  }

  // Compute the relative path from the matching source dir (for element IDs / location data)
  const matchingDir = sourceDirs.find(
    dir => relativePath.startsWith(dir + path.sep) || relativePath.startsWith(dir + '/')
  );
  const relativeToSrcDir = matchingDir
    ? path.relative(matchingDir, relativePath)
    : relativePath;

  const modifications = [];
  let elementCounter = 0; // file-wide counter to avoid ID collisions

  try {
    const ast = parser.parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    traverse(ast, {
      JSXElement(astPath) {
        const { node } = astPath;
        const openingElement = node.openingElement;

        // ── Resolve tag name ─────────────────────────────────────────────
        const tagName = resolveTagName(openingElement.name);
        if (!tagName) return; // unsupported name type

        // ── Skip non-visible elements ────────────────────────────────────
        if (EXCLUDED_TAGS.has(tagName.toLowerCase())) return;

        const { line } = openingElement.loc.start;

        // Collect all editable regions for this element
        const regions = [];

        // ── 1. IMAGE SOURCES ─────────────────────────────────────────────
        if (IMAGE_ELEMENTS.has(tagName)) {
          const srcAttr = openingElement.attributes.find(
            attr => attr.type === 'JSXAttribute' && attr.name && attr.name.name === 'src'
          );

          if (srcAttr && srcAttr.value) {
            const extracted = extractStringFromAttrValue(srcAttr.value);

            if (extracted) {
              regions.push(
                makeRegion(source, relativeToSrcDir, extracted.start, extracted.end, extracted.value, 'image-src')
              );
            }
            // If src is a dynamic expression (variable, template literal with expressions), skip it
          }
        }

        // ── 2. TEXT CHILDREN ─────────────────────────────────────────────
        // Process ALL children (not just the first) to capture every editable text segment.
        for (const child of node.children) {
          // 2a. Direct JSXText with non-whitespace content
          if (child.type === 'JSXText') {
            const raw = child.value;
            const trimmed = raw.trim();
            if (trimmed.length > 0) {
              // Adjust start/end to the trimmed text boundaries (not the full node which includes whitespace)
              const trimStart = child.start + raw.indexOf(trimmed);
              const trimEnd = trimStart + trimmed.length;
              regions.push(
                makeRegion(source, relativeToSrcDir, trimStart, trimEnd, trimmed, 'text-content')
              );
            }
          }

          // 2b. String literal inside expression container: {"Hello"}
          if (child.type === 'JSXExpressionContainer') {
            const expr = child.expression;

            if (expr.type === 'StringLiteral') {
              regions.push(
                makeRegion(
                  source, relativeToSrcDir,
                  expr.start + 1, // skip opening quote
                  expr.end - 1,   // skip closing quote
                  expr.value,
                  'string-expression'
                )
              );
            }

            // 2c. Static template literal (no expressions): {`Hello`}
            if (
              expr.type === 'TemplateLiteral' &&
              expr.expressions.length === 0 &&
              expr.quasis.length === 1
            ) {
              const quasi = expr.quasis[0];
              const text = quasi.value.cooked || quasi.value.raw;
              if (text.trim().length > 0) {
                regions.push(
                  makeRegion(
                    source, relativeToSrcDir,
                    quasi.start, // template quasi start is after the backtick
                    quasi.end,   // template quasi end is before the closing backtick
                    text,
                    'template-literal'
                  )
                );
              }
            }
          }
        }

        // ── 3. TEXT-BEARING ATTRIBUTES ───────────────────────────────────
        for (const attr of openingElement.attributes) {
          if (attr.type !== 'JSXAttribute' || !attr.name) continue;

          const attrName = attr.name.name;
          if (!TEXT_ATTRIBUTES.has(attrName)) continue;

          const extracted = extractStringFromAttrValue(attr.value);
          if (extracted && extracted.value.trim().length > 0) {
            regions.push(
              makeRegion(
                source, relativeToSrcDir,
                extracted.start, extracted.end,
                extracted.value,
                `attribute:${attrName}`
              )
            );
          }
        }

        // ── 4. INLINE backgroundImage STYLE ──────────────────────────────
        const styleAttr = openingElement.attributes.find(
          attr => attr.type === 'JSXAttribute' && attr.name && attr.name.name === 'style'
        );

        if (styleAttr && styleAttr.value && styleAttr.value.type === 'JSXExpressionContainer') {
          const styleExpr = styleAttr.value.expression;

          // style={{ backgroundImage: 'url(...)' }} or style={{ backgroundImage: "url(...)" }}
          if (styleExpr.type === 'ObjectExpression') {
            for (const prop of styleExpr.properties) {
              if (
                prop.type === 'ObjectProperty' &&
                prop.key &&
                (prop.key.name === 'backgroundImage' || prop.key.value === 'backgroundImage')
              ) {
                if (prop.value.type === 'StringLiteral') {
                  const bgValue = prop.value.value;
                  // Extract URL from url('...') or url("...") or url(...)
                  const urlMatch = bgValue.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/);
                  if (urlMatch) {
                    const url = urlMatch[1];
                    // Find the position of the URL within the full string literal value
                    const urlIndexInValue = bgValue.indexOf(url);
                    // prop.value.start + 1 skips the opening quote of the string literal
                    const urlStart = prop.value.start + 1 + urlIndexInValue;
                    const urlEnd = urlStart + url.length;

                    regions.push(
                      makeRegion(
                        source, relativeToSrcDir,
                        urlStart, urlEnd,
                        url,
                        'style-background-image'
                      )
                    );
                  }
                }

                // style={{ backgroundImage: `url(...)` }} — static template literal
                if (
                  prop.value.type === 'TemplateLiteral' &&
                  prop.value.expressions.length === 0 &&
                  prop.value.quasis.length === 1
                ) {
                  const quasi = prop.value.quasis[0];
                  const bgValue = quasi.value.cooked || quasi.value.raw;
                  const urlMatch = bgValue.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/);
                  if (urlMatch) {
                    const url = urlMatch[1];
                    const urlIndexInValue = bgValue.indexOf(url);
                    const urlStart = quasi.start + urlIndexInValue;
                    const urlEnd = urlStart + url.length;

                    regions.push(
                      makeRegion(
                        source, relativeToSrcDir,
                        urlStart, urlEnd,
                        url,
                        'style-background-image'
                      )
                    );
                  }
                }
              }
            }
          }
        }

        // ── INJECT ───────────────────────────────────────────────────────
        if (regions.length > 0) {
          const currentId = generateElementId(relativeToSrcDir, line, tagName, elementCounter++);

          const insertPosition = openingElement.selfClosing
            ? openingElement.end - 2  // Before '/>'
            : openingElement.end - 1; // Before '>'

          const locJson = JSON.stringify(regions).replace(/'/g, '&apos;');
          const attributes = ` data-element-id="${currentId}" data-source-loc='${locJson}'`;

          modifications.push({ position: insertPosition, text: attributes });
        }
      },
    });

    // Apply modifications from end to start to preserve character positions
    if (modifications.length > 0) {
      let transformedCode = source.split('');
      modifications
        .sort((a, b) => b.position - a.position)
        .forEach(mod => {
          transformedCode.splice(mod.position, 0, mod.text);
        });
      return transformedCode.join('');
    }
  } catch (e) {
    // Don't break the build on parse errors — just skip transformation
    console.error(`❌ [nextjs-live-edit] Failed to parse ${relativePath}:`, e.message);
  }

  return source;
};
