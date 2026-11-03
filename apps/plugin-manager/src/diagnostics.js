// AegisHarness plugin manager — author: PT-dove
// Ordered, de-duplicated diagnostic sink. Every finding is data, never an exception.

/**
 * Normalises a diagnostic path into JSON Pointer form ('' for the document root).
 * @param {unknown} path
 * @returns {string}
 */
function normalizePath(path) {
  if (path === null || path === undefined) return '';
  const value = typeof path === 'string' ? path : String(path);
  return value === '' ? '' : value;
}

/**
 * Appends a diagnostic to a plain array unless the same (code, path) pair already exists.
 * @param {Array<{code: string, path: string, message: string}>} list
 * @param {string} code
 * @param {string|null} path
 * @param {string} message
 */
export function pushDiagnostic(list, code, path, message) {
  const pointer = normalizePath(path);
  for (const existing of list) {
    if (existing.code === code && existing.path === pointer) return existing;
  }
  const entry = { code, path: pointer, message };
  list.push(entry);
  return entry;
}

/**
 * Creates a diagnostics collector with insertion-ordered, frozen output.
 */
export function createDiagnostics() {
  /** @type {Array<{code: string, path: string, message: string}>} */
  const items = [];
  return {
    /**
     * @param {string} code
     * @param {string|null} path
     * @param {string} message
     */
    add(code, path, message) {
      pushDiagnostic(items, code, path, message);
    },
    /** @returns {ReadonlyArray<{code: string, path: string, message: string}>} */
    list() {
      return Object.freeze(items.map((item) => Object.freeze({ ...item })));
    },
    /** @returns {boolean} */
    hasErrors() {
      return items.length > 0;
    },
    /** @returns {ReadonlyArray<string>} distinct codes in first-seen order */
    codes() {
      const out = [];
      for (const item of items) {
        if (!out.includes(item.code)) out.push(item.code);
      }
      return Object.freeze(out);
    },
  };
}
