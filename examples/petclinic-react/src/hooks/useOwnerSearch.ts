import { useCallback, useState } from 'react';
import { instrumentHandler } from '@funwithappmap/react-recorder';
import { findOwners, ApiError } from '../api/client';
import { useClinic } from '../context/ClinicContext';
import type { Owner } from '../types';

export interface OwnerSearch {
  owners: Owner[] | undefined;
  loading: boolean;
  error: string | undefined;
  search: (lastName: string) => Promise<void>;
}

// The hook itself is auto-instrumented (top-level, use* naming → hook
// label). The nested `search` callback is below the transform's
// granularity, so it keeps a hand-applied wrapper.
export function useOwnerSearch(): OwnerSearch {
  const { apiBase } = useClinic();
  const [owners, setOwners] = useState<Owner[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const search = useCallback(
    instrumentHandler(
      async (lastName: string) => {
        setLoading(true);
        setError(undefined);
        try {
          setOwners(await findOwners(apiBase, lastName));
        } catch (err) {
          setOwners(undefined);
          setError(err instanceof ApiError ? err.message : 'search failed');
        } finally {
          setLoading(false);
        }
      },
      {
        definedClass: 'useOwnerSearch',
        methodId: 'search',
        path: 'src/hooks/useOwnerSearch.ts',
        lineno: 25,
      },
    ),
    [apiBase],
  );

  return { owners, loading, error, search };
}
