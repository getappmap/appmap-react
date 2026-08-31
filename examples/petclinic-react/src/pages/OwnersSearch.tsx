import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useOwnerSearch } from '../hooks/useOwnerSearch';

export function OwnersSearch() {
  const [lastName, setLastName] = useState('');
  const { owners, loading, error, search } = useOwnerSearch();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void search(lastName);
  };

  return (
    <section>
      <h2>Find Owners</h2>
      <form onSubmit={onSubmit}>
        <label>
          Last name
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </label>
        <button type="submit" disabled={loading}>
          Find Owner
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {owners && owners.length === 0 && <p>No owners found.</p>}
      {owners && owners.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>City</th>
              <th>Telephone</th>
            </tr>
          </thead>
          <tbody>
            {owners.map((owner) => (
              <tr key={owner.id}>
                <td>
                  <Link to={`/owners/${owner.id}`}>
                    {owner.firstName} {owner.lastName}
                  </Link>
                </td>
                <td>{owner.city}</td>
                <td>{owner.telephone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

