// Mirrors the PetClinicGo response shapes
// (FunwithAppMapandClaudeGolang/examples/PetClinicGo/internal/web/handlers.go).

export interface Pet {
  id: number;
  name: string;
  type: string;
}

export interface Owner {
  id: number;
  firstName: string;
  lastName: string;
  city: string;
  telephone: string;
  pets?: Pet[];
}

export interface NewOwner {
  firstName: string;
  lastName: string;
  city: string;
  telephone: string;
}

export interface Vet {
  id: number;
  name: string;
  specialties: string[];
}
