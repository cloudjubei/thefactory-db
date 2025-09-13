/*
 Utility: stringifyJsonValues
 - Flattens a JSON value into a whitespace-separated string consisting only of primitive values
   (string, number, boolean, null -> 'null').
 - Excludes keys and any structural characters; only values are included.
 - Handles nested arrays/objects by depth-first traversal.
 - Ignores circular references gracefully.
 - Deterministic ordering: object keys are sorted to ensure stable output.
*/

export function stringifyJsonValues(value: unknown): string {
  const seen = new WeakSet<object>();
  const tokens: string[] = [];

  const pushPrimitive = (v: unknown) => {
    switch (typeof v) {
      case 'string':
        if (v.length) tokens.push(v);
        else tokens.push('');
        break;
      case 'number':
        if (Number.isFinite(v as number)) tokens.push(String(v));
        else tokens.push('');
        break;
      case 'boolean':
        tokens.push(String(v));
        break;
      case 'bigint':
        tokens.push(String(v));
        break;
      case 'symbol':
        // ignore symbols
        break;
      case 'undefined':
        // ignore undefined (not representable in JSON)
        break;
      case 'function':
        // ignore functions
        break;
      case 'object':
        if (v === null) tokens.push('null');
        break;
    }
  };

  const visit = (node: unknown): void => {
    // Primitives
    if (node === null || typeof node !== 'object') {
      pushPrimitive(node);
      return;
    }

    // Arrays
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        visit(node[i]);
      }
      return;
    }

    // Objects
    const obj = node as Record<string, unknown>;
    if (seen.has(obj)) return; // avoid cycles
    seen.add(obj);

    // Deterministic ordering by sorted keys
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
      // Exclude keys themselves; only traverse into values
      try {
        visit(obj[k]);
      } catch {
        // Ignore property access errors
      }
    }
  };

  try {
    visit(value);
  } catch {
    // On unexpected errors, fall back to best-effort primitives pushed so far
  }

  // Join using a single space; filter out empty tokens produced by empty strings or unsupported values
  return tokens.filter(t => t !== '').join(' ');
}
