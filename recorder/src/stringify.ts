// Side-effect-free value capture (the observer-effect fix).
//
// The recorder must never change what the app does. JSON.stringify does:
// it calls every getter and every toJSON on the value it walks. React
// Query's *tracked* query result, for one, is an object of getters that
// subscribe the component to whichever fields are read — serializing it
// subscribed components to every field and made them re-render on
// changes they otherwise ignore (a real app's test went from passing to
// failing only under the recorder). react-hook-form's formState works
// the same way.
//
// So values are rendered by reading property *descriptors* only:
//
// - own enumerable data properties are rendered, JSON-style, so plain
//   data prints exactly as JSON.stringify would print it;
// - accessor properties are never invoked: they render as "[getter]";
// - toJSON, toString, valueOf and friends are never called on unknown
//   objects (Date is the one exception: Date.prototype.toISOString is a
//   builtin, called on a real Date, never user code);
// - functions render as "[function name]" instead of disappearing;
// - depth, key count and output length are bounded, so a huge or
//   cyclic object costs no more than the cap it is cut to.
//
// Proxies remain the one thing JavaScript can't detect: reading their
// keys and descriptors goes through their traps.

const MAX_DEPTH = 4;
const MAX_KEYS = 50;

/** Class name of a value, read without invoking any accessor. */
export function className(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object' && typeof v !== 'function') return typeof v;
  const own = Object.getOwnPropertyDescriptor(v, 'constructor');
  let ctor: unknown = own && 'value' in own ? own.value : undefined;
  if (!own) {
    const proto = Object.getPrototypeOf(v);
    if (proto === null) return 'Object';
    const inherited = findDescriptor(proto, 'constructor');
    ctor = inherited && 'value' in inherited ? inherited.value : undefined;
  }
  const name = typeof ctor === 'function' ? functionName(ctor) : '';
  return name || (typeof v === 'function' ? 'Function' : 'Object');
}

/** A function's own `name`, read from its descriptor. */
export function functionName(fn: unknown): string {
  if (typeof fn !== 'function') return '';
  const d = Object.getOwnPropertyDescriptor(fn, 'name');
  return d && typeof d.value === 'string' ? d.value : '';
}

/** Read a data property without invoking accessors; undefined if the
 * property is missing or is an accessor. */
export function readDataProperty(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  const d = findDescriptor(obj as object, key);
  return d && 'value' in d ? d.value : undefined;
}

function findDescriptor(obj: object, key: string): PropertyDescriptor | undefined {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return d;
  }
  return undefined;
}

/**
 * Render a value as a string of at most roughly `budget` characters
 * (callers cut it to their exact cap).
 */
export function safeStringify(v: unknown, budget: number): string {
  let out = '';
  const full = () => out.length > budget;
  const ancestors: object[] = [];

  const emitString = (s: string) => {
    out += JSON.stringify(s);
  };

  const walk = (value: unknown, depth: number, inArray: boolean): void => {
    if (full()) return;
    switch (typeof value) {
      case 'string':
        emitString(value);
        return;
      case 'number':
        out += Number.isFinite(value) ? String(value) : 'null';
        return;
      case 'boolean':
        out += String(value);
        return;
      case 'bigint':
        out += `${value}n`;
        return;
      case 'undefined':
        out += inArray ? 'null' : 'undefined';
        return;
      case 'symbol':
        emitString(value.toString());
        return;
      case 'function':
        emitString(`[function ${functionName(value) || 'anonymous'}]`);
        return;
    }
    if (value === null) {
      out += 'null';
      return;
    }
    const obj = value as object;
    if (ancestors.includes(obj)) {
      emitString('[Circular]');
      return;
    }
    if (obj instanceof Date) {
      let iso: string;
      try {
        iso = Date.prototype.toISOString.call(obj);
      } catch {
        iso = 'Invalid Date';
      }
      emitString(iso);
      return;
    }
    const isArray = Array.isArray(obj);
    if (depth >= MAX_DEPTH) {
      emitString(isArray ? '[Array]' : `[${className(obj)}]`);
      return;
    }
    ancestors.push(obj);
    try {
      if (isArray) {
        const d = Object.getOwnPropertyDescriptor(obj, 'length');
        const length = d && typeof d.value === 'number' ? d.value : 0;
        out += '[';
        for (let i = 0; i < length && !full(); i++) {
          if (i > 0) out += ',';
          if (i >= MAX_KEYS) {
            emitString(`[${length - i} more]`);
            break;
          }
          const item = Object.getOwnPropertyDescriptor(obj, String(i));
          if (!item) out += 'null';
          else if ('value' in item) walk(item.value, depth + 1, true);
          else emitString('[getter]');
        }
        out += ']';
        return;
      }
      out += '{';
      let n = 0;
      for (const key of Object.keys(obj)) {
        if (full()) break;
        const d = Object.getOwnPropertyDescriptor(obj, key);
        if (!d) continue;
        // JSON.stringify leaves out undefined-valued keys; so do we.
        if ('value' in d && d.value === undefined) continue;
        if (n > 0) out += ',';
        if (n >= MAX_KEYS) {
          emitString('…');
          break;
        }
        n++;
        out += `${JSON.stringify(key)}:`;
        if ('value' in d) walk(d.value, depth + 1, false);
        else emitString('[getter]');
      }
      out += '}';
    } finally {
      ancestors.pop();
    }
  };

  walk(v, 0, false);
  return out;
}
