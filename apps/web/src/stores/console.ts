import type { Organization } from "@rabbitpost/shared";
import { create } from "zustand";
import { orgsApi } from "../api/orgs";

interface ConsoleState {
  orgs: Organization[];
  currentOrgId: string | null;
  bootstrapped: boolean;

  bootstrap: () => Promise<void>;
  refreshOrgs: () => Promise<void>;
  selectOrg: (orgId: string) => void;
  currentOrg: () => Organization | null;
}

export const useConsoleStore = create<ConsoleState>((set, get) => ({
  orgs: [],
  currentOrgId: null,
  bootstrapped: false,

  bootstrap: async () => {
    try {
      const orgs = await orgsApi.list();
      const stored = localStorage.getItem("rp:consoleOrgId");
      const currentOrgId =
        orgs.find((o) => o.id === stored)?.id ?? orgs[0]?.id ?? null;
      set({ orgs, currentOrgId, bootstrapped: true });
    } catch {
      set({ orgs: [], currentOrgId: null, bootstrapped: true });
    }
  },

  refreshOrgs: async () => {
    const orgs = await orgsApi.list();
    const prev = get().currentOrgId;
    const currentOrgId = orgs.find((o) => o.id === prev)?.id ?? orgs[0]?.id ?? null;
    set({ orgs, currentOrgId });
  },

  selectOrg: (orgId: string) => {
    localStorage.setItem("rp:consoleOrgId", orgId);
    set({ currentOrgId: orgId });
  },

  currentOrg: () => {
    const { orgs, currentOrgId } = get();
    return orgs.find((o) => o.id === currentOrgId) ?? null;
  },
}));
