// AegisHarness plugin manager — author: PT-dove
// Purely static JavaScript scanning. Plugin sources are treated as text: they are
// tokenised, never loaded, never compiled and never run.

import { builtinModules } from 'node:module';
import path from 'node:path';
import { ERROR_CODES, PluginCheckError } from './errors.js';
import { COMPATIBILITY_PROFILE } from './profile.js';
import { decodeUtf8Strict } from './json.js';
import { sha256Hex } from './jcs.js';
import { ALLOWED_EXPORTS, INJECT_NAMES } from './permissions.js';
import { assertSafeRelativePath } from './plugin-manifest.js';

const IDENTIFIER_START = /[A-Za-z_$\u0080-\uffff]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const NUMBER_LITERAL =
  /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/;

const PUNCTUATORS = Object.freeze([
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '!',
  '~',
  '?',
  ':',
  '=',
  '.',
  '#',
  '@',
]);

const PUNCTUATORS_BY_LENGTH = [...PUNCTUATORS].sort((left, right) => right.length - left.length);

const STRING_ESCAPES = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['0', '\0'],
  ['\\', '\\'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['/', '/'],
]);

const DANGEROUS_IDENTIFIERS = new Map([
  ['process', 'the process global is not available to plugins'],
  ['eval', 'code evaluation is not available to plugins'],
  ['Function', 'dynamic function construction is not available to plugins'],
  ['Deno', 'the Deno runtime is not available to plugins'],
  ['Bun', 'the Bun runtime is not available to plugins'],
  ['Worker', 'workers are not available to plugins'],
  ['Atomics', 'shared memory primitives are not available to plugins'],
  ['SharedArrayBuffer', 'shared memory primitives are not available to plugins'],
]);

const BUILTIN_NAMES = new Set();
for (const name of builtinModules) {
  BUILTIN_NAMES.add(name);
  BUILTIN_NAMES.add(name.startsWith('node:') ? name.slice(5) : `node:${name}`);
}

// Keywords after which a `/` starts a regular expression literal rather than a division.
// `return /\d+/.test(x)` is ordinary plugin code and must not be mis-tokenised.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'typeof',
  'void',
  'delete',
  'yield',
  'await',
  'else',
  'do',
  'in',
  'of',
  'new',
  'instanceof',
  'default',
]);

/**
 * Tokenises JavaScript source without evaluating it.
 * @param {string} source
 * @returns {Array<{type: string, value: string, line: number}>}
 */
export function tokenize(source) {
  if (typeof source !== 'string') {
    throw new PluginCheckError(ERROR_CODES.INVALID_ARGUMENT, 'source must be a string');
  }

  /** @type {Array<{type: string, value: string, line: number}>} */
  const tokens = [];
  const length = source.length;
  let index = 0;
  let line = 1;

  function unterminated(what) {
    return new PluginCheckError(ERROR_CODES.INVALID_VALUE, `unterminated ${what} at line ${line}`);
  }

  function lastToken() {
    return tokens.length === 0 ? null : tokens[tokens.length - 1];
  }

  function regexAllowed() {
    const previous = lastToken();
    if (previous === null) return true;
    if (previous.type === 'identifier') {
      return REGEX_PRECEDING_KEYWORDS.has(previous.value);
    }
    if (
      previous.type === 'number' ||
      previous.type === 'string' ||
      previous.type === 'template' ||
      previous.type === 'regex'
    ) {
      return false;
    }
    if (previous.type === 'punctuator') {
      return ![')', ']', '}', '++', '--'].includes(previous.value);
    }
    return true;
  }

  function readQuotedString(quote) {
    const startLine = line;
    index += 1;
    let value = '';
    while (index < length) {
      const ch = source[index];
      if (ch === '\\') {
        const next = source[index + 1];
        if (next === undefined) throw unterminated('string');
        if (next === '\n') {
          line += 1;
          index += 2;
          continue;
        }
        if (next === 'u') {
          index += 2;
          let hex = source.slice(index, index + 4);
          if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            continue;
          }
          value += 'u';
          continue;
        }
        if (next === 'x') {
          const hex = source.slice(index + 2, index + 4);
          if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            continue;
          }
          value += 'x';
          index += 2;
          continue;
        }
        const mapped = STRING_ESCAPES.get(next);
        value += mapped === undefined ? next : mapped;
        index += 2;
        continue;
      }
      if (ch === quote) {
        index += 1;
        tokens.push({ type: 'string', value, line: startLine });
        return;
      }
      if (ch === '\n') throw unterminated('string');
      value += ch;
      index += 1;
    }
    throw unterminated('string');
  }

  /**
   * Scans code until the end of input, or until the `}` that closes a template
   * interpolation when `stopAtBrace` is set.
   */
  function scanCode(stopAtBrace) {
    let braceDepth = 0;
    while (index < length) {
      const ch = source[index];
      const code = source.charCodeAt(index);

      if (ch === '\n') {
        line += 1;
        index += 1;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || code === 0xfeff) {
        index += 1;
        continue;
      }
      if (ch === '/' && source[index + 1] === '/') {
        index += 2;
        while (index < length && source[index] !== '\n') index += 1;
        continue;
      }
      if (ch === '/' && source[index + 1] === '*') {
        index += 2;
        let closed = false;
        while (index < length) {
          if (source[index] === '*' && source[index + 1] === '/') {
            index += 2;
            closed = true;
            break;
          }
          if (source[index] === '\n') line += 1;
          index += 1;
        }
        if (!closed) throw unterminated('block comment');
        continue;
      }
      if (ch === '"' || ch === "'") {
        readQuotedString(ch);
        continue;
      }
      if (ch === '`') {
        scanTemplate();
        continue;
      }
      if ((ch >= '0' && ch <= '9') || (ch === '.' && source[index + 1] >= '0' && source[index + 1] <= '9')) {
        const match = NUMBER_LITERAL.exec(source.slice(index));
        const raw = match === null ? ch : match[0];
        tokens.push({ type: 'number', value: raw, line });
        index += raw.length;
        continue;
      }
      if (IDENTIFIER_START.test(ch)) {
        const start = index;
        index += 1;
        while (index < length && IDENTIFIER_PART.test(source[index])) index += 1;
        tokens.push({ type: 'identifier', value: source.slice(start, index), line });
        continue;
      }
      if (ch === '/' && regexAllowed()) {
        scanRegex();
        continue;
      }
      // A bare backslash outside strings, templates, comments and regex literals can only
      // be an escape inside an identifier (for example `\u0070rocess`). Such escapes would
      // hide a dangerous global from the identifier scan, so they are rejected outright.
      if (ch === '\\') {
        throw new PluginCheckError(
          ERROR_CODES.INVALID_VALUE,
          `escaped identifier sequence at line ${line} is not allowed`,
        );
      }
      if (stopAtBrace) {
        if (ch === '{') {
          braceDepth += 1;
        } else if (ch === '}') {
          if (braceDepth === 0) {
            index += 1;
            return;
          }
          braceDepth -= 1;
        }
      }
      scanPunctuator();
    }
    if (stopAtBrace) throw unterminated('template interpolation');
  }

  function scanTemplate() {
    const startLine = line;
    index += 1;
    let raw = '';
    while (index < length) {
      const ch = source[index];
      if (ch === '\\') {
        const next = source[index + 1];
        raw += ch + (next === undefined ? '' : next);
        if (next === '\n') line += 1;
        index += 2;
        continue;
      }
      if (ch === '`') {
        index += 1;
        tokens.push({ type: 'template', value: raw, line: startLine });
        return;
      }
      if (ch === '$' && source[index + 1] === '{') {
        tokens.push({ type: 'template', value: raw, line: startLine });
        raw = '';
        index += 2;
        scanCode(true);
        continue;
      }
      if (ch === '\n') line += 1;
      raw += ch;
      index += 1;
    }
    throw unterminated('template literal');
  }

  function scanRegex() {
    const startLine = line;
    index += 1;
    let value = '/';
    let inClass = false;
    let closed = false;
    while (index < length) {
      const ch = source[index];
      if (ch === '\\') {
        value += ch + (source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (ch === '\n') break;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) {
        value += '/';
        index += 1;
        closed = true;
        break;
      }
      value += ch;
      index += 1;
    }
    if (!closed) throw unterminated('regular expression');
    while (index < length && /[a-z]/i.test(source[index])) {
      value += source[index];
      index += 1;
    }
    tokens.push({ type: 'regex', value, line: startLine });
  }

  function scanPunctuator() {
    for (const candidate of PUNCTUATORS_BY_LENGTH) {
      if (source.startsWith(candidate, index)) {
        tokens.push({ type: 'punctuator', value: candidate, line });
        index += candidate.length;
        return;
      }
    }
    const ch = source[index];
    index += 1;
    tokens.push({ type: 'punctuator', value: ch, line });
  }

  scanCode(false);
  return tokens;
}

function isMemberAccess(tokens, index) {
  const previous = tokens[index - 1];
  return previous !== undefined && previous.type === 'punctuator' && (previous.value === '.' || previous.value === '?.');
}

function isPropertyKey(tokens, index) {
  const next = tokens[index + 1];
  if (next === undefined) return false;
  if (next.type !== 'punctuator' || next.value !== ':') return false;
  const previous = tokens[index - 1];
  if (previous === undefined) return false;
  return previous.type === 'punctuator' && (previous.value === '{' || previous.value === ',');
}

function hasInterpolation(tokens, index) {
  // A template argument is literal only when the token right after it closes the call.
  const next = tokens[index + 1];
  return !(next !== undefined && next.type === 'punctuator' && next.value === ')');
}

function checkInjectLiteral(tokens, start) {
  if (tokens[start] === undefined || tokens[start].type !== 'punctuator' || tokens[start].value !== '[') {
    return { ok: false, names: null };
  }
  const names = [];
  let cursor = start + 1;
  for (;;) {
    const token = tokens[cursor];
    if (token === undefined) return { ok: false, names: null };
    if (token.type === 'punctuator' && token.value === ']') {
      return { ok: true, names };
    }
    if (token.type !== 'string') return { ok: false, names: null };
    names.push(token.value);
    cursor += 1;
    const separator = tokens[cursor];
    if (separator === undefined) return { ok: false, names: null };
    if (separator.type === 'punctuator' && separator.value === ',') {
      cursor += 1;
      continue;
    }
    if (separator.type === 'punctuator' && separator.value === ']') {
      return { ok: true, names };
    }
    return { ok: false, names: null };
  }
}

/**
 * Finds a top level `const|let|var inject = [...]` declaration so that the equally common
 * `const inject = [...]; export { inject };` form can be verified instead of being rejected
 * as "cannot be verified statically".
 * @param {Array<{type: string, value: string, line: number}>} tokens
 * @returns {{ok: boolean, names: string[]|null}|null}
 */
function findTopLevelInjectDeclaration(tokens) {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'punctuator') {
      if (token.value === '{' || token.value === '(' || token.value === '[') depth += 1;
      else if (token.value === '}' || token.value === ')' || token.value === ']') depth -= 1;
      continue;
    }
    if (depth !== 0 || token.type !== 'identifier') continue;
    if (token.value !== 'const' && token.value !== 'let' && token.value !== 'var') continue;
    const name = tokens[index + 1];
    const equals = tokens[index + 2];
    if (name === undefined || name.type !== 'identifier' || name.value !== 'inject') continue;
    if (equals === undefined || equals.type !== 'punctuator' || equals.value !== '=') continue;
    return checkInjectLiteral(tokens, index + 3);
  }
  return null;
}

/**
 * Statically scans one module source file for unsupported imports, dangerous globals
 * and an invalid export shape. Findings go to diagnostics; nothing is thrown.
 * @param {string} source
 * @param {{file?: string, diagnostics: {add: Function}, profile?: object}} options
 * @returns {{specifiers: Array<{specifier: string, kind: string, line: number}>, exports: string[], imports: string[]}}
 */
export function scanModuleSource(source, options = {}) {
  const {
    file = 'module.js',
    diagnostics,
    profile = COMPATIBILITY_PROFILE,
    isEntry = true,
  } = options;
  const result = { specifiers: [], exports: [], imports: [] };

  let activeLine;
  const usedFindings = new Map();
  const report = (code, message) => {
    if (!diagnostics || typeof diagnostics.add !== 'function') return;
    const base = activeLine === undefined ? `/${file}` : `/${file}:${activeLine}`;
    const key = `${code}|${base}`;
    const seen = (usedFindings.get(key) ?? 0) + 1;
    usedFindings.set(key, seen);
    const pointer = seen === 1 ? base : `${base}#${seen}`;
    diagnostics.add(code, pointer, `${file}: ${message}`);
  };

  let tokens;
  try {
    tokens = tokenize(source);
  } catch (error) {
    const code = error instanceof PluginCheckError ? error.code : ERROR_CODES.INVALID_VALUE;
    report(code, error instanceof Error ? error.message : String(error));
    return result;
  }

  /** @type {Array<{specifier: string, kind: string, line: number}>} */
  const specifiers = [];
  /** @type {string[]} */
  const imports = [];
  /** @type {string[]} */
  const exportedNames = [];
  let injectState = null;
  let hasApply = false;

  const declaredInject = findTopLevelInjectDeclaration(tokens);
  if (declaredInject !== null) {
    if (!declaredInject.ok) {
      injectState = 'bad';
    } else {
      const unknownInject = declaredInject.names.filter((entry) => !INJECT_NAMES.includes(entry));
      if (unknownInject.length > 0) {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          `inject declares unsupported names: ${unknownInject.join(', ')}; allowed: ${INJECT_NAMES.join(', ')}`,
        );
        injectState = 'reported';
      } else {
        injectState = 'ok';
      }
    }
  }

  function recordExport(name) {
    exportedNames.push(name);
    if (name === 'apply') hasApply = true;
    if (name === 'inject' && injectState === null) injectState = 'unknown';
  }

  function recordSpecifier(specifier, kind, line) {
    specifiers.push({ specifier, kind, line });
    if (typeof specifier !== 'string' || specifier === '') {
      report(ERROR_CODES.UNSUPPORTED_API, 'empty module specifier is not allowed');
      return;
    }

    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (!specifier.endsWith('.js')) {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          `relative import "${specifier}" is not allowed: only relative .js modules may be imported`,
        );
        return;
      }
      const directory = path.posix.dirname(file);
      const resolved = path.posix.normalize(
        directory === '.' ? specifier : path.posix.join(directory, specifier),
      );
      if (
        resolved.startsWith('../') ||
        resolved === '..' ||
        path.posix.isAbsolute(resolved) ||
        resolved.split('/').includes('..')
      ) {
        report(
          ERROR_CODES.ENTRY_ESCAPE,
          `relative import "${specifier}" escapes the plugin package root`,
        );
        return;
      }
      try {
        assertSafeRelativePath(resolved, { allowNested: true });
      } catch (error) {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          `relative import "${specifier}" is not a safe package path: ${error.message}`,
        );
        return;
      }
      imports.push(resolved);
      return;
    }

    if (specifier === profile.cordisPackage) return;

    if (specifier.startsWith(`${profile.cordisPackage}/`)) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `subpath import "${specifier}" is not allowed: only the fixed ${profile.cordisPackage} root entry may be imported`,
      );
      return;
    }
    if (specifier.startsWith('node:')) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `Node builtin module "${specifier}" is not available to plugins`,
      );
      return;
    }
    if (BUILTIN_NAMES.has(specifier)) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `Node builtin module "${specifier}" is not available to plugins`,
      );
      return;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `URL specifier "${specifier}" is not allowed: plugins must be fully local`,
      );
      return;
    }
    report(
      ERROR_CODES.UNSUPPORTED_API,
      `bare package specifier "${specifier}" is not allowed: plugins may only import relative .js modules and ${profile.cordisPackage}`,
    );
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier') continue;
    const name = token.value;
    activeLine = token.line;
    if (isMemberAccess(tokens, index) || isPropertyKey(tokens, index)) continue;

    if (name === 'import') {
      const next = tokens[index + 1];
      if (next === undefined) continue;

      if (next.type === 'punctuator' && next.value === '.') {
        const member = tokens[index + 2];
        const dot = tokens[index + 3];
        const inner = tokens[index + 4];
        if (
          member !== undefined &&
          member.type === 'identifier' &&
          member.value === 'meta' &&
          dot !== undefined &&
          dot.type === 'punctuator' &&
          dot.value === '.' &&
          inner !== undefined &&
          inner.type === 'identifier' &&
          inner.value === 'resolve'
        ) {
          report(
            ERROR_CODES.UNSUPPORTED_API,
            'import.meta.resolve is not available to plugins: module resolution is fixed by the host',
          );
        }
        continue;
      }

      if (next.type === 'punctuator' && next.value === '(') {
        const argument = tokens[index + 2];
        if (argument !== undefined && argument.type === 'string') {
          recordSpecifier(argument.value, 'dynamic', argument.line);
        } else if (
          argument !== undefined &&
          argument.type === 'template' &&
          !hasInterpolation(tokens, index + 2)
        ) {
          recordSpecifier(argument.value, 'dynamic', argument.line);
        } else {
          report(
            ERROR_CODES.UNSUPPORTED_API,
            'dynamic import() with a non literal specifier cannot be verified statically',
          );
        }
        continue;
      }

      if (next.type === 'string') {
        recordSpecifier(next.value, 'side-effect', next.line);
        continue;
      }

      let cursor = index + 1;
      let guard = 0;
      while (cursor < tokens.length && guard < 256) {
        const candidate = tokens[cursor];
        if (candidate.type === 'string') {
          recordSpecifier(candidate.value, 'static', candidate.line);
          break;
        }
        if (candidate.type === 'punctuator' && candidate.value === ';') break;
        if (candidate.type === 'identifier' && candidate.value === 'import' && cursor !== index) break;
        cursor += 1;
        guard += 1;
      }
      continue;
    }

    if (name === 'export') {
      const next = tokens[index + 1];
      if (next === undefined) continue;

      if (next.type === 'identifier' && next.value === 'default') {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          'export default is not allowed: export the named apply/dispose/inject surface',
        );
        continue;
      }

      if (next.type === 'punctuator' && next.value === '*') {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          'export * from is not allowed: export the named apply/dispose/inject surface',
        );
        let cursor = index + 2;
        let guard = 0;
        while (cursor < tokens.length && guard < 64) {
          if (tokens[cursor].type === 'string') {
            recordSpecifier(tokens[cursor].value, 'static', tokens[cursor].line);
            break;
          }
          if (tokens[cursor].type === 'punctuator' && tokens[cursor].value === ';') break;
          cursor += 1;
          guard += 1;
        }
        continue;
      }

      if (next.type === 'punctuator' && next.value === '{') {
        let cursor = index + 2;
        let guard = 0;
        while (cursor < tokens.length && guard < 256) {
          const candidate = tokens[cursor];
          if (candidate.type === 'punctuator' && candidate.value === '}') break;
          if (candidate.type === 'identifier') {
            const after = tokens[cursor + 1];
            if (after !== undefined && after.type === 'identifier' && after.value === 'as') {
              const alias = tokens[cursor + 2];
              if (alias !== undefined && alias.type === 'identifier') {
                recordExport(alias.value);
                cursor += 3;
                guard += 3;
                continue;
              }
            }
            recordExport(candidate.value);
          }
          cursor += 1;
          guard += 1;
        }
        const fromToken = tokens[cursor + 1];
        const specToken = tokens[cursor + 2];
        if (
          fromToken !== undefined &&
          fromToken.type === 'identifier' &&
          fromToken.value === 'from' &&
          specToken !== undefined &&
          specToken.type === 'string'
        ) {
          recordSpecifier(specToken.value, 'static', specToken.line);
        }
        continue;
      }

      if (next.type === 'identifier') {
        if (next.value === 'function' || next.value === 'class') {
          let cursor = index + 2;
          if (tokens[cursor] !== undefined && tokens[cursor].type === 'punctuator' && tokens[cursor].value === '*') {
            cursor += 1;
          }
          const named = tokens[cursor];
          if (named !== undefined && named.type === 'identifier') recordExport(named.value);
          continue;
        }
        if (next.value === 'async') {
          const keyword = tokens[index + 2];
          if (keyword !== undefined && keyword.type === 'identifier' && keyword.value === 'function') {
            let cursor = index + 3;
            if (
              tokens[cursor] !== undefined &&
              tokens[cursor].type === 'punctuator' &&
              tokens[cursor].value === '*'
            ) {
              cursor += 1;
            }
            const named = tokens[cursor];
            if (named !== undefined && named.type === 'identifier') recordExport(named.value);
          }
          continue;
        }
        if (next.value === 'const' || next.value === 'let' || next.value === 'var') {
          let cursor = index + 2;
          let guard = 0;
          while (cursor < tokens.length && guard < 256) {
            const declared = tokens[cursor];
            if (declared === undefined || declared.type !== 'identifier') break;
            const exportedName = declared.value;
            recordExport(exportedName);
            let valueIndex = cursor + 1;
            if (tokens[valueIndex] !== undefined && tokens[valueIndex].type === 'punctuator' && tokens[valueIndex].value === '=') {
              valueIndex += 1;
              if (exportedName === 'inject') {
                const literal = checkInjectLiteral(tokens, valueIndex);
                if (!literal.ok) {
                  injectState = 'bad';
                } else {
                  const unknown = literal.names.filter((entry) => !INJECT_NAMES.includes(entry));
                  if (unknown.length > 0) {
                    report(
                      ERROR_CODES.UNSUPPORTED_API,
                      `inject declares unsupported names: ${unknown.join(', ')}; allowed: ${INJECT_NAMES.join(', ')}`,
                    );
                    injectState = 'reported';
                  } else {
                    injectState = 'ok';
                  }
                }
              }
              let depth = 0;
              let scan = valueIndex;
              while (scan < tokens.length) {
                const candidate = tokens[scan];
                if (candidate.type === 'punctuator') {
                  if (candidate.value === '(' || candidate.value === '[' || candidate.value === '{') depth += 1;
                  else if (candidate.value === ')' || candidate.value === ']' || candidate.value === '}') {
                    if (depth === 0) break;
                    depth -= 1;
                  } else if (depth === 0 && (candidate.value === ',' || candidate.value === ';')) {
                    break;
                  }
                }
                scan += 1;
              }
              cursor = scan;
            }
            if (tokens[cursor] !== undefined && tokens[cursor].type === 'punctuator' && tokens[cursor].value === ',') {
              cursor += 1;
              guard += 1;
              continue;
            }
            break;
          }
          continue;
        }
      }
      continue;
    }

    if (DANGEROUS_IDENTIFIERS.has(name)) {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `"${name}" is not available: ${DANGEROUS_IDENTIFIERS.get(name)}`,
      );
      continue;
    }

    if (name === 'globalThis' || name === 'global') {
      const dot = tokens[index + 1];
      if (dot !== undefined && dot.type === 'punctuator' && (dot.value === '.' || dot.value === '[')) {
        const member = tokens[index + 2];
        const memberName =
          member === undefined
            ? null
            : member.type === 'string'
              ? member.value
              : member.type === 'identifier'
                ? member.value
                : null;
        if (typeof memberName === 'string' && DANGEROUS_IDENTIFIERS.has(memberName)) {
          report(
            ERROR_CODES.UNSUPPORTED_API,
            `"${name}.${memberName}" is not available: ${DANGEROUS_IDENTIFIERS.get(memberName)}`,
          );
        }
      }
      continue;
    }

    if (name === 'require') {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        'CommonJS require is not supported: plugins must be ESM only',
      );
      continue;
    }

    if (name === 'module') {
      const dot = tokens[index + 1];
      const member = tokens[index + 2];
      if (
        dot !== undefined &&
        dot.type === 'punctuator' &&
        dot.value === '.' &&
        member !== undefined &&
        member.type === 'identifier' &&
        member.value === 'exports'
      ) {
        report(ERROR_CODES.UNSUPPORTED_API, 'CommonJS module.exports is not supported: plugins must be ESM only');
      }
      continue;
    }

    if (name === 'exports') {
      const dot = tokens[index + 1];
      if (dot !== undefined && dot.type === 'punctuator' && (dot.value === '.' || dot.value === '[')) {
        report(
          ERROR_CODES.UNSUPPORTED_API,
          'CommonJS exports assignment is not supported: plugins must be ESM only',
        );
      }
      continue;
    }
  }

  activeLine = undefined;
  // The export surface contract (named apply/dispose/inject only) applies to the entry
  // module; helper modules in the same package keep an unrestricted internal surface.
  if (isEntry) {
    for (const exportedName of exportedNames) {
      if (!ALLOWED_EXPORTS.includes(exportedName)) {
        report(
          ERROR_CODES.EXPORT_SHAPE_INVALID,
          `export "${exportedName}" is not allowed; only ${ALLOWED_EXPORTS.join(', ')} may be exported`,
        );
      }
    }
    if (!hasApply) {
      report(
        ERROR_CODES.EXPORT_SHAPE_INVALID,
        'the entry module must export a named function "apply"',
      );
    }
    if (injectState === 'bad') {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        `inject must be a literal array of ${INJECT_NAMES.join(', ')}`,
      );
    }
    if (injectState === 'unknown') {
      report(
        ERROR_CODES.UNSUPPORTED_API,
        'inject is exported but its value cannot be verified statically; declare it as a literal array',
      );
    }
  }

  result.specifiers = specifiers;
  result.exports = exportedNames;
  result.imports = imports;
  return result;
}

/**
 * Walks the static module graph from the entry file using a read-only reader.
 * @param {{packageRoot: string, entryRelativePath: string, readFile: Function, diagnostics: {add: Function}, profile?: object}} options
 * @returns {{modules: Array<{path: string, sha256: string, bytes: number, specifiers: Array<object>, exports: string[]}>, entrySource: string}}
 */
export function collectModuleGraph(options) {
  const {
    packageRoot,
    entryRelativePath,
    readFile,
    diagnostics,
    profile = COMPATIBILITY_PROFILE,
  } = options;

  const report = (code, pathLabel, message) => {
    if (diagnostics && typeof diagnostics.add === 'function') {
      diagnostics.add(code, pathLabel, message);
    }
  };

  const maxFiles = profile?.limits?.sourceFiles ?? COMPATIBILITY_PROFILE.limits.sourceFiles;
  const maxBytes = profile?.limits?.sourceFileBytes ?? COMPATIBILITY_PROFILE.limits.sourceFileBytes;

  /** @type {Array<{path: string, sha256: string, bytes: number, specifiers: Array<object>, exports: string[]}>} */
  const modules = [];
  const seen = new Set();
  const queue = [entryRelativePath];
  let entrySource = '';

  while (queue.length > 0) {
    const relative = queue.shift();
    if (relative === undefined || seen.has(relative)) continue;
    seen.add(relative);

    if (modules.length >= maxFiles) {
      report(
        ERROR_CODES.LIMIT_EXCEEDED,
        '',
        `module graph exceeds the ${maxFiles} file limit; remaining modules were not scanned`,
      );
      break;
    }

    const absolute = path.join(packageRoot, ...relative.split('/'));
    let buffer;
    try {
      buffer = readFile(absolute);
    } catch (error) {
      report(
        ERROR_CODES.ENTRY_MISSING,
        `/${relative}`,
        `cannot read module "${relative}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!(buffer instanceof Uint8Array)) {
      report(ERROR_CODES.INVALID_ARGUMENT, `/${relative}`, `reader did not return bytes for "${relative}"`);
      continue;
    }
    if (buffer.length > maxBytes) {
      report(
        ERROR_CODES.LIMIT_EXCEEDED,
        `/${relative}`,
        `module "${relative}" is ${buffer.length} bytes, the limit is ${maxBytes}`,
      );
      continue;
    }

    let text;
    try {
      text = decodeUtf8Strict(buffer, relative);
    } catch (error) {
      const code = error instanceof PluginCheckError ? error.code : ERROR_CODES.INVALID_UNICODE;
      report(code, `/${relative}`, error instanceof Error ? error.message : String(error));
      continue;
    }

    if (relative === entryRelativePath) entrySource = text;

    const scan = scanModuleSource(text, {
      file: relative,
      diagnostics,
      profile,
      isEntry: relative === entryRelativePath,
    });
    modules.push({
      path: relative,
      sha256: sha256Hex(buffer),
      bytes: buffer.length,
      specifiers: scan.specifiers,
      exports: scan.exports,
    });
    for (const imported of scan.imports) {
      if (!seen.has(imported)) queue.push(imported);
    }
  }

  return { modules, entrySource };
}
