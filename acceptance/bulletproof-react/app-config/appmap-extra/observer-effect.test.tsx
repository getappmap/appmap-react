// Repro for the recorder side effect found on discussions.test.tsx: the
// recorder captures a hook's return value with JSON.stringify
// (recorder/src/recording.ts formatValue), which reads every getter on
// React Query's *tracked* result object and so subscribes the component to
// every field (isFetching, dataUpdatedAt, ...). A component that only reads
// `data` then re-renders on refetch start, which it does not do unrecorded.
//
// Same hook, wrapped exactly the way the build-time transform wraps a
// top-level `use*` function (autoInstrument), vs. unwrapped. While a
// recording is active (registerAppMapHooks), render counts must be equal.
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';

import { autoInstrument } from '@funwithappmap/react-recorder';

const useThingPlain = () =>
  useQuery({ queryKey: ['thing'], queryFn: () => new Promise<number>((r) => setTimeout(() => r(1), 30)) });
const useThingRecorded = autoInstrument(useThingPlain, {
  definedClass: 'observer-effect',
  methodId: 'useThingRecorded',
  path: 'appmap-extra/observer-effect.test.tsx',
  lineno: 1,
}, []);

async function countRenders(useThing: () => { data?: number }) {
  const client = new QueryClient();
  let renders = 0;
  const Probe = () => {
    renders++;
    const q = useThing();
    return <span>{q.data ?? 'none'}</span>;
  };
  const view = render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.container.textContent).toBe('1'));
  const before = renders;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['thing'] });
  });
  view.unmount();
  return renders - before;
}

test('recorder must not change how often a component re-renders', async () => {
  const plain = await countRenders(useThingPlain);
  const recorded = await countRenders(useThingRecorded);
  expect({ recorded }).toEqual({ recorded: plain });
});
