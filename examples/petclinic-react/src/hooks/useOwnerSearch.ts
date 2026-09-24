import { useCallback, useState } from 'react';
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
// label). The nested `search` callback — the first argument to
// useCallback — is instrumented by the transform too (docs/design/03):
// no manual instrumentHandler / hardcoded line numbers needed.
export function useOwnerSearch(): OwnerSearch {
  const { apiBase } = useClinic();
  const [owners, setOwners] = useState<Owner[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const search = useCallback(
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
    [apiBase],
  );

  return { owners, loading, error, search };
}
