import { createContext, useContext, type ReactNode } from 'react';

export interface ClinicConfig {
  /** Base URL for the PetClinicGo API. '/api' in the browser (Vite
   * proxies to :8080); tests inject an absolute URL for MSW. */
  apiBase: string;
}

const ClinicContext = createContext<ClinicConfig>({ apiBase: '/api' });

export function ClinicProvider({
  config,
  children,
}: {
  config: ClinicConfig;
  children: ReactNode;
}) {
  return <ClinicContext.Provider value={config}>{children}</ClinicContext.Provider>;
}

export function useClinic(): ClinicConfig {
  return useContext(ClinicContext);
}
