import { useEffect, useState } from 'react';
import { getVets } from '../api/client';
import { useClinic } from '../context/ClinicContext';
import type { Vet } from '../types';

export function VetsList() {
  const { apiBase } = useClinic();
  const [vets, setVets] = useState<Vet[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    getVets(apiBase)
      .then((result) => !cancelled && setVets(result))
      .catch(() => !cancelled && setError('could not load veterinarians'));
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  if (error) return <p role="alert">{error}</p>;
  if (!vets) return <p>Loading veterinarians…</p>;
  return (
    <section>
      <h2>Veterinarians</h2>
      <ul>
        {vets.map((vet) => (
          <li key={vet.id}>
            {vet.name}
            {vet.specialties.length > 0 && <em> — {vet.specialties.join(', ')}</em>}
          </li>
        ))}
      </ul>
    </section>
  );
}

