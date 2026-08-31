import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { instrumentHandler } from '@funwithappmap/react-recorder';
import { createOwner, ApiError } from '../api/client';
import { useClinic } from '../context/ClinicContext';

export function CreateOwner() {
  const { apiBase } = useClinic();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', city: '', telephone: '' });
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = instrumentHandler(
    async () => {
      setSubmitting(true);
      setError(undefined);
      try {
        const owner = await createOwner(apiBase, form);
        navigate(`/owners/${owner.id}`);
      } catch (err) {
        // The backend's validation error path: POST /owners → 400
        // {"error": "..."} rendered in the UI.
        setError(err instanceof ApiError ? err.message : 'could not create owner');
      } finally {
        setSubmitting(false);
      }
    },
    {
      definedClass: 'CreateOwner',
      methodId: 'submit',
      path: 'src/pages/CreateOwner.tsx',
      lineno: 17,
    },
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <section>
      <h2>Add Owner</h2>
      <form onSubmit={onSubmit}>
        <label>
          First name
          <input value={form.firstName} onChange={set('firstName')} />
        </label>
        <label>
          Last name
          <input value={form.lastName} onChange={set('lastName')} />
        </label>
        <label>
          City
          <input value={form.city} onChange={set('city')} />
        </label>
        <label>
          Telephone
          <input value={form.telephone} onChange={set('telephone')} />
        </label>
        <button type="submit" disabled={submitting}>
          Add Owner
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

