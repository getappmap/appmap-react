import { http, HttpResponse } from 'msw';
import type { NewOwner, Owner, Vet } from '../../src/types';

// Mock of the PetClinicGo HTTP surface (internal/web/handlers.go):
// same routes, same response shapes, same {"error": "..."} envelope.

export const API_BASE = 'http://localhost:8080';

const vets: Vet[] = [
  { id: 1, name: 'James Carter', specialties: [] },
  { id: 2, name: 'Helen Leary', specialties: ['radiology'] },
  { id: 3, name: 'Linda Douglas', specialties: ['surgery', 'dentistry'] },
];

const owners: Owner[] = [
  {
    id: 1,
    firstName: 'George',
    lastName: 'Franklin',
    city: 'Madison',
    telephone: '6085551023',
    pets: [{ id: 1, name: 'Leo', type: 'cat' }],
  },
  {
    id: 2,
    firstName: 'Betty',
    lastName: 'Davis',
    city: 'Sun Prairie',
    telephone: '6085551749',
    pets: [{ id: 2, name: 'Basil', type: 'hamster' }],
  },
];

export const handlers = [
  http.get(`${API_BASE}/vets`, () => HttpResponse.json(vets)),

  http.get(`${API_BASE}/owners`, ({ request }) => {
    const lastName = new URL(request.url).searchParams.get('lastName') ?? '';
    return HttpResponse.json(
      owners.filter((o) => o.lastName.toLowerCase().startsWith(lastName.toLowerCase())),
    );
  }),

  http.get(`${API_BASE}/owners/:id`, ({ params }) => {
    const owner = owners.find((o) => o.id === Number(params.id));
    if (!owner) return HttpResponse.json({ error: 'owner not found' }, { status: 404 });
    return HttpResponse.json(owner);
  }),

  http.post(`${API_BASE}/owners`, async ({ request }) => {
    const body = (await request.json()) as NewOwner;
    for (const field of ['firstName', 'lastName', 'city', 'telephone'] as const) {
      if (!body[field]) {
        return HttpResponse.json({ error: `invalid owner: ${field} is required` }, { status: 400 });
      }
    }
    const created: Owner = { id: 90 + owners.length, ...body, pets: [] };
    owners.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
];
