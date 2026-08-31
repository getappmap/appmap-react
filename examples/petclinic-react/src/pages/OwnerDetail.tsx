import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getOwner, getVets } from '../api/client';
import { useClinic } from '../context/ClinicContext';
import type { Owner, Vet } from '../types';

export function OwnerDetail() {
  const { ownerId } = useParams();
  const { apiBase } = useClinic();
  const [owner, setOwner] = useState<Owner>();
  const [vets, setVets] = useState<Vet[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    // Two concurrent fetches in one interaction — the 1:N case for
    // full-stack linking (one frontend map, two backend request maps).
    Promise.all([getOwner(apiBase, Number(ownerId)), getVets(apiBase)])
      .then(([ownerResult, vetsResult]) => {
        if (cancelled) return;
        setOwner(ownerResult);
        setVets(vetsResult);
      })
      .catch(() => !cancelled && setError('could not load owner'));
    return () => {
      cancelled = true;
    };
  }, [apiBase, ownerId]);

  if (error) return <p role="alert">{error}</p>;
  if (!owner || !vets) return <p>Loading owner…</p>;
  return (
    <section>
      <h2>
        {owner.firstName} {owner.lastName}
      </h2>
      <p>
        {owner.city} · {owner.telephone}
      </p>
      <h3>Pets</h3>
      {owner.pets?.length ? (
        <ul>
          {owner.pets.map((pet) => (
            <li key={pet.id}>
              {pet.name} ({pet.type})
            </li>
          ))}
        </ul>
      ) : (
        <p>No pets registered.</p>
      )}
      <p>{vets.length} veterinarians on staff.</p>
    </section>
  );
}

