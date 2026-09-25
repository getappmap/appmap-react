import type { FunctionInfo } from './types.js';
import { activeRecording, runInCall } from './session.js';

// Hand-written instrumentation wrappers. Each is exactly the prologue /
// epilogue the build-time transform (docs/design/03) will inject:
//
//   const token = Enter(fn, args)
//   try { ...body... }
//   finally { Exit(token, outcome) }
//
// `finally` plays the role of Go's `defer` in the sibling repo's recorder.

type AnyFn = (...args: never[]) => unknown;

/** Wrap a plain function. Async functions get their settled value/rejection
 * attributed (the returned promise is followed), so `elapsed` spans the await. */
export function instrument<F extends AnyFn>(fn: F, info: FunctionInfo, argNames?: string[]): F {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const recording = activeRecording();
    if (!recording) return fn.apply(this, args as never[]);

    // argNames declares what to capture; extra positional args (e.g.
    // React's vestigial second argument to function components) are noise.
    const captured = (argNames ? args.slice(0, argNames.length) : args).map((value, i) => ({
      name: argNames?.[i],
      value,
    }));
    const token = recording.enter(info, captured);
    try {
      // Run the body as this call, so calls it makes from async
      // continuations (after an await, in a timer) still nest under it
      // where the runtime has async context (session.ts).
      const result = runInCall(recording, token.callId, () => fn.apply(this, args as never[]));
      if (result instanceof Promise) {
        // The call is yielding control back to its caller now, even
        // though it's still logically open — see the thread-assignment
        // design in recording.ts.
        recording.leaveSyncFrame(token);
        return result.then(
          (value) => {
            recording.exit(token, { returnValue: value });
            return value;
          },
          (err) => {
            recording.exit(token, { exception: err });
            throw err;
          },
        );
      }
      recording.exit(token, { returnValue: result });
      return result;
    } catch (err) {
      recording.exit(token, { exception: err });
      throw err;
    }
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name || info.methodId });
  return wrapped as unknown as F;
}

/** Wrap a React function component: the call event is the render.
 * Props are captured as the single parameter (size-capped). */
export function instrumentComponent<C extends AnyFn>(
  component: C,
  info: Omit<FunctionInfo, 'labels'>,
): C {
  return instrument(component, { ...info, labels: ['component'] }, ['props']);
}

/** Wrap a custom hook. */
export function instrumentHook<F extends AnyFn>(fn: F, info: Omit<FunctionInfo, 'labels'>): F {
  return instrument(fn, { ...info, labels: ['hook'] });
}

/** Wrap an event handler (click, submit, change…). */
export function instrumentHandler<F extends AnyFn>(fn: F, info: Omit<FunctionInfo, 'labels'>): F {
  return instrument(fn, { ...info, labels: ['event-handler'] });
}

/** Runtime entry point for the build-time transform (docs/design/03).
 * Labels from the transform (comments/built-ins) are additive to
 * naming-convention labels (PascalCase → component, use[A-Z]… → hook). */
export function autoInstrument<F extends AnyFn>(
  fn: F,
  info: FunctionInfo,
  argNames?: string[],
): F {
  const conventionLabel = /^use[A-Z]/.test(info.methodId)
    ? 'hook'
    : /^[A-Z]/.test(info.methodId)
      ? 'component'
      : undefined;
  const labels = [
    ...new Set([...(info.labels ?? []), ...(conventionLabel ? [conventionLabel] : [])]),
  ];
  return instrument(fn, { ...info, labels: labels.length ? labels : undefined }, argNames);
}
