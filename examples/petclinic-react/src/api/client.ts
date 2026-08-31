import type { NewOwner, Owner, Vet } from '../types';

// No hand-instrumentation here: every top-level function in src/ is
// auto-instrumented by the Vite plugin (docs/design/03).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, (body as { error?: string })?.error ?? response.statusText);
  }
  return body as T;
}

export async function getVets(base: string): Promise<Vet[]> {
  return request(`${base}/vets`);
}

export async function findOwners(base: string, lastName: string): Promise<Owner[]> {
  return request(`${base}/owners?lastName=${encodeURIComponent(lastName)}`);
}

export async function getOwner(base: string, id: number): Promise<Owner> {
  return request(`${base}/owners/${id}`);
}

export async function createOwner(base: string, owner: NewOwner): Promise<Owner> {
  return request(`${base}/owners`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(owner),
  });
}
