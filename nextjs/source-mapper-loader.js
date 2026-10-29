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

// ─── Template content maps ──────────────────────────────────────────────────
//
// AI Companion templates render text through t(key) → __baked_text(key), which
// reads a module-level __BAKED_CONTENT object, and images through
// imageValue(content, key), which reads `content` from src/app/generated-data.ts.
// Keys are often built at runtime (`hero.${active}.title`), so none of these
// values were tagged: on recent sites Edit Mode could edit 18% of images and 70%
// of text. Each key is mapped to its value literal here, and the element is tagged
// at render time with the region for the key it actually rendered. Regions carry
// contentKey so the handler finds the literal again by key if the file changed.
// Dev only: published builds (NODE_ENV=production) don't get the maps.

const CONTENT_TYPES = { text: 'string-expression', image: 'image-src' };

function unwrapExpression(node) {
  while (
    node &&
    (node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'ParenthesizedExpression')
  ) {
    node = node.expression;
  }
  return node;
}

function propertyKeyName(prop) {
  if (!prop || prop.type !== 'ObjectProperty' || prop.computed) return null;
  if (prop.key.type === 'StringLiteral') return prop.key.value;
  if (prop.key.type === 'Identifier') return prop.key.name;
  return null;
}

/** { start, end } of a string literal's (or static template literal's) contents. */
function literalContentRange(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return { start: node.start + 1, end: node.end - 1 };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return { start: node.quasis[0].start, end: node.quasis[0].end };
  }
  return null;
}

/**
 * Regions for every text/image entry of the object literal assigned to
 * `objectName` at the top level of the module: { key: region }.
 */
function collectContentRegions(source, ast, file, objectName) {
  const regions = {};
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (!decl || decl.type !== 'VariableDeclaration') continue;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== 'Identifier' || declarator.id.name !== objectName) continue;
      const obj = unwrapExpression(declarator.init);
      if (!obj || obj.type !== 'ObjectExpression') continue;
      for (const prop of obj.properties) {
        const key = propertyKeyName(prop);
        const entry = prop.type === 'ObjectProperty' ? unwrapExpression(prop.value) : null;
        if (key === null || !entry || entry.type !== 'ObjectExpression') continue;
        let kind = null;
        let valueNode = null;
        for (const field of entry.properties) {
          const name = propertyKeyName(field);
          if (name === 'type' && field.value.type === 'StringLiteral') kind = field.value.value;
          if (name === 'value') valueNode = field.value;
        }
        const range = literalContentRange(valueNode);
        if (!range || !CONTENT_TYPES[kind]) continue;
        regions[key] = {
          ...makeRegion(source, file, range.start, range.end, source.slice(range.start, range.end), CONTENT_TYPES[kind]),
          contentKey: key,
          contentObject: objectName,
        };
      }
    }
  }
  return regions;
}

// generated-data.ts parsed once per change (the loader runs per module).
const generatedContentCache = new Map();

function loadGeneratedContentRegions(projectRoot, sourceDirs) {
  for (const dir of sourceDirs) {
    for (const rel of ['app/generated-data.ts', 'generated-data.ts']) {
      const abs = path.resolve(projectRoot, dir, rel);
      let stat;
      try {
        stat = require('fs').statSync(abs);
      } catch {
        continue;
      }
      const cached = generatedContentCache.get(abs);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.regions;
      let regions = {};
      try {
        const source = require('fs').readFileSync(abs, 'utf-8');
        const ast = parser.parse(source, { sourceType: 'module', plugins: ['typescript'] });
        regions = collectContentRegions(source, ast, rel, 'content');
      } catch (e) {
        console.error(`❌ [nextjs-live-edit] Failed to read ${abs}:`, e.message);
      }
      generatedContentCache.set(abs, { mtimeMs: stat.mtimeMs, regions });
      return regions;
    }
  }
  return {};
}

/** Local names bound to `(key) => __baked_text(key)`. */
function collectBakedTextAliases(ast) {
  const aliases = new Set(['__baked_text']);
  traverse(ast, {
    VariableDeclarator(astPath) {
      const { id, init } = astPath.node;
      if (id.type !== 'Identifier' || !init) return;
      if (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression') return;
      let body = init.body;
      if (body.type === 'BlockStatement') {
        const ret = body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? body.body[0].argument : null;
        body = ret;
      }
      const param = init.params[0];
      if (
        body && body.type === 'CallExpression' &&
        body.callee.type === 'Identifier' && body.callee.name === '__baked_text' &&
        param && param.type === 'Identifier' &&
        body.arguments[0] && body.arguments[0].type === 'Identifier' && body.arguments[0].name === param.name
      ) {
        aliases.add(id.name);
      }
    },
  });
  return aliases;
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

    const dynamicTagging = process.env.NODE_ENV !== 'production';
    const bakedRegions = dynamicTagging ? collectContentRegions(source, ast, relativeToSrcDir, '__BAKED_CONTENT') : {};
    const bakedTextAliases = dynamicTagging ? collectBakedTextAliases(ast) : new Set();
    let contentRegions = null; // generated-data.ts, loaded on first use
    let usesBaked = false;
    let usesContent = false;
    const keySource = (node) => source.slice(node.start, node.end);
    // Static prefixes of the keys looked up here ('' = any key), so the maps only
    // carry entries this module can render.
    const keyPrefixes = { b: new Set(), c: new Set() };
    const notePrefix = (map, node) => {
      node = unwrapExpression(node);
      if (node.type === 'StringLiteral') keyPrefixes[map].add(node.value);
      else if (node.type === 'TemplateLiteral') keyPrefixes[map].add(node.quasis[0].value.cooked || '');
      else keyPrefixes[map].add('');
    };
    const pickKeys = (regions, prefixes) => {
      const out = {};
      for (const [key, region] of Object.entries(regions)) {
        for (const prefix of prefixes) {
          if (key.startsWith(prefix)) { out[key] = region; break; }
        }
      }
      return out;
    };

    // ['b'|'c', keyExpression] for a content lookup, or null.
    //   b: __baked_text(key) / t(key) / __baked_image(key)   (this module's __BAKED_CONTENT)
    //   c: textValue(content, key) / imageValue(content, key) (generated-data.ts)
    const lookupOf = (call) => {
      if (!dynamicTagging || !call || call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return null;
      const name = call.callee.name;
      if ((bakedTextAliases.has(name) || name === '__baked_image') && call.arguments.length >= 1) {
        usesBaked = true;
        notePrefix('b', call.arguments[0]);
        return ['b', keySource(call.arguments[0])];
      }
      if ((name === 'textValue' || name === 'imageValue') && call.arguments.length >= 2) {
        usesContent = true;
        notePrefix('c', call.arguments[1]);
        return ['c', keySource(call.arguments[1])];
      }
      return null;
    };

    // The lookup behind `photo.src` (photo bound to imageValue/__baked_image) or
    // `imageValue(...).src`.
    const imageLookupOf = (expr, astPath) => {
      expr = unwrapExpression(expr);
      if (!expr || expr.type !== 'MemberExpression' || expr.computed || expr.property.name !== 'src') return null;
      const obj = unwrapExpression(expr.object);
      if (obj.type === 'CallExpression') return lookupOf(obj);
      if (obj.type !== 'Identifier') return null;
      const binding = astPath.scope.getBinding(obj.name);
      const init = binding && binding.path.isVariableDeclarator() ? unwrapExpression(binding.path.node.init) : null;
      return init ? lookupOf(init) : null;
    };

    // Module-level `const` values: AI-written components keep text and image URLs
    // in constants and data arrays (`src={LOGO_SRC}`, `{rooms[0].name}`,
    // `rooms.map((room) => ... {room.name})`), which were never tagged either.
    const moduleConsts = new Map();
    for (const stmt of ast.program.body) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (!decl || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
      for (const declarator of decl.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.init) {
          moduleConsts.set(declarator.id.name, unwrapExpression(declarator.init));
        }
      }
    }
    const isModuleConst = (scopePath, name) => {
      const binding = scopePath.scope.getBinding(name);
      return Boolean(binding && binding.kind === 'const' && binding.scope.block.type === 'Program' && moduleConsts.has(name));
    };
    const memberKey = (member) => {
      if (!member.computed && member.property.type === 'Identifier') return member.property.name;
      if (member.computed && (member.property.type === 'NumericLiteral' || member.property.type === 'StringLiteral')) {
        return member.property.value;
      }
      return undefined;
    };
    // The literal node behind a module const, through static object keys / array indexes.
    const resolveStatic = (expr, scopePath) => {
      expr = unwrapExpression(expr);
      if (!expr) return null;
      if (expr.type === 'Identifier') return isModuleConst(scopePath, expr.name) ? moduleConsts.get(expr.name) : null;
      if (expr.type !== 'MemberExpression') return null;
      const base = resolveStatic(expr.object, scopePath);
      const key = memberKey(expr);
      if (!base || key === undefined) return null;
      if (base.type === 'ArrayExpression' && typeof key === 'number') return unwrapExpression(base.elements[key]) || null;
      if (base.type === 'ObjectExpression') {
        const prop = base.properties.find((p) => propertyKeyName(p) === String(key));
        return prop ? unwrapExpression(prop.value) : null;
      }
      return null;
    };
    // A static region at the literal (it can sit anywhere in the module).
    const staticLiteralRegion = (expr, scopePath, type) => {
      const range = literalContentRange(resolveStatic(expr, scopePath));
      if (!range) return null;
      return { ...makeRegion(source, relativeToSrcDir, range.start, range.end, source.slice(range.start, range.end), type), anywhere: true };
    };
    // `item.prop` inside `ARR.map((item) => ...)`, ARR a module const array of
    // object literals: per-index regions, looked up with ARR.indexOf(item).
    const arrayRegions = {};
    let usesArrays = false;
    const mapItemLookup = (expr, scopePath) => {
      expr = unwrapExpression(expr);
      if (!dynamicTagging || !expr || expr.type !== 'MemberExpression' || expr.object.type !== 'Identifier') return null;
      const prop = memberKey(expr);
      const itemName = expr.object.name;
      const binding = scopePath.scope.getBinding(itemName);
      if (prop === undefined || !binding || binding.kind !== 'param') return null;
      const fnPath = binding.scope.path;
      if (fnPath.node.params[0] !== binding.identifier) return null;
      const callPath = fnPath.parentPath;
      if (!callPath || !callPath.isCallExpression() || callPath.node.arguments[0] !== fnPath.node) return null;
      const callee = callPath.node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'map' || callee.object.type !== 'Identifier') return null;
      const arrName = callee.object.name;
      const arr = isModuleConst(callPath, arrName) ? moduleConsts.get(arrName) : null;
      if (!arr || arr.type !== 'ArrayExpression') return null;
      let found = false;
      arr.elements.forEach((el, index) => {
        el = unwrapExpression(el);
        const field = el && el.type === 'ObjectExpression' ? el.properties.find((p) => propertyKeyName(p) === String(prop)) : null;
        const range = field ? literalContentRange(unwrapExpression(field.value)) : null;
        if (!range) return;
        found = true;
        arrayRegions[`${arrName}.${prop}:${index}`] = {
          ...makeRegion(source, relativeToSrcDir, range.start, range.end, source.slice(range.start, range.end), 'string-expression'),
          anywhere: true,
        };
      });
      if (!found) return null;
      usesArrays = true;
      return ['a', `(${JSON.stringify(`${arrName}.${prop}:`)} + ${arrName}.indexOf(${itemName}))`];
    };

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
        // Template content lookups resolved at render time: [lookup, regionType]
        const dynamicItems = [];

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
            } else if (srcAttr.value.type === 'JSXExpressionContainer') {
              const srcExpr = srcAttr.value.expression;
              const lookup = imageLookupOf(srcExpr, astPath) || mapItemLookup(srcExpr, astPath);
              const constRegion = lookup ? null : staticLiteralRegion(srcExpr, astPath, 'image-src');
              if (lookup) dynamicItems.push([lookup, 'image-src']);
              else if (constRegion) regions.push(constRegion);
            }
          }
        }

        // ── 2. TEXT CHILDREN ─────────────────────────────────────────────
        // Process ALL children (not just the first) to capture every editable text segment.
        for (const child of node.children) {
          // 2a. Direct JSXText with non-whitespace content
          if (child.type === 'JSXText') {
            // The source text, not child.value: Babel decodes HTML entities there
            // ("&middot;" → "·", "&amp;" → "&"), so the region text never matched
            // the file and saving any text with an entity failed.
            const raw = source.slice(child.start, child.end);
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

            // Template text: {t(`hero.${active}.title`)}, {textValue(content, "x")};
            // module constants: {TAGLINE}, {rooms[0].name}; map items: {room.name}
            const lookup = lookupOf(unwrapExpression(expr)) || mapItemLookup(expr, astPath);
            if (lookup) {
              dynamicItems.push([lookup, 'string-expression']);
            } else if (expr.type === 'Identifier' || expr.type === 'MemberExpression') {
              const constRegion = staticLiteralRegion(expr, astPath, 'string-expression');
              if (constRegion) regions.push(constRegion);
            }

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

                // style={{ backgroundImage: `url(${photo.src})` }} — template image lookup
                if (prop.value.type === 'TemplateLiteral' && prop.value.expressions.length === 1) {
                  const bgExpr = prop.value.expressions[0];
                  const lookup = imageLookupOf(bgExpr, astPath) || mapItemLookup(bgExpr, astPath);
                  const constRegion = lookup ? null : staticLiteralRegion(bgExpr, astPath, 'style-background-image');
                  if (lookup) dynamicItems.push([lookup, 'style-background-image']);
                  else if (constRegion) regions.push(constRegion);
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
        if (regions.length > 0 || dynamicItems.length > 0) {
          const currentId = generateElementId(relativeToSrcDir, line, tagName, elementCounter++);

          const insertPosition = openingElement.selfClosing
            ? openingElement.end - 2  // Before '/>'
            : openingElement.end - 1; // Before '>'

          let attributes;
          if (dynamicItems.length > 0) {
            // Expression attributes: the regions for the keys rendered right now.
            // Element ids include the key so items rendered from one JSX site stay distinct.
            const items = [
              ...regions.map((r) => JSON.stringify(r)),
              ...dynamicItems.map(([[map, key], type]) => `[${JSON.stringify(map)}, (${key}), ${JSON.stringify(type)}]`),
            ].join(', ');
            attributes = ` data-element-id={__cdLiveEditId(${JSON.stringify(currentId)}, [${items}])}` +
              ` data-source-loc={__cdLiveEditLoc([${items}])}`;
          } else {
            // A JSX string attribute decodes HTML entities, so `&` is escaped too:
            // otherwise text written as `&amp;` in the source came back as `&` and
            // the handler rejected the save as a location mismatch.
            const locJson = JSON.stringify(regions).replace(/&/g, '&amp;').replace(/'/g, '&apos;');
            attributes = ` data-element-id="${currentId}" data-source-loc='${locJson}'`;
          }

          modifications.push({ position: insertPosition, text: attributes });
        }
      },
    });

    // Maps and helpers for the expression attributes, appended to the module
    // (function declarations are hoisted; the maps are read at render time).
    if (usesBaked || usesContent || usesArrays) {
      if (usesContent) contentRegions = loadGeneratedContentRegions(projectRoot, sourceDirs);
      const helpers =
        `\n;const __cdLiveEditMaps = { b: ${JSON.stringify(usesBaked ? pickKeys(bakedRegions, keyPrefixes.b) : {})}, ` +
        `c: ${JSON.stringify(usesContent ? pickKeys(contentRegions, keyPrefixes.c) : {})}, a: ${JSON.stringify(arrayRegions)} };\n` +
        `function __cdLiveEditLoc(items) { var out = []; for (var i = 0; i < items.length; i++) { var it = items[i]; ` +
        `if (Array.isArray(it)) { var r = __cdLiveEditMaps[it[0]][String(it[1])]; if (r) { var c = {}; for (var k in r) c[k] = r[k]; c.type = it[2]; out.push(c); } } ` +
        `else if (it) out.push(it); } return out.length ? JSON.stringify(out) : undefined; }\n` +
        `function __cdLiveEditId(base, items) { for (var i = 0; i < items.length; i++) { if (Array.isArray(items[i])) return base + "::" + String(items[i][1]); } return base; }\n`;
      modifications.push({ position: source.length, text: helpers });
    }

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
