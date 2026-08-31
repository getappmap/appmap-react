import { Link, Route, Routes } from 'react-router-dom';
import { VetsList } from './pages/VetsList';
import { OwnersSearch } from './pages/OwnersSearch';
import { OwnerDetail } from './pages/OwnerDetail';
import { CreateOwner } from './pages/CreateOwner';

export function App() {
  return (
    <>
      <header>
        <h1>PetClinic</h1>
        <nav>
          <Link to="/owners">Find Owners</Link> · <Link to="/owners/new">Add Owner</Link> ·{' '}
          <Link to="/vets">Veterinarians</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<OwnersSearch />} />
          <Route path="/owners" element={<OwnersSearch />} />
          <Route path="/owners/new" element={<CreateOwner />} />
          <Route path="/owners/:ownerId" element={<OwnerDetail />} />
          <Route path="/vets" element={<VetsList />} />
        </Routes>
      </main>
    </>
  );
}
