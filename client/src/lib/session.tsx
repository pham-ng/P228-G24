import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Staff } from "./types";

/**
 * Staff session lives in React state only. Browser storage APIs are blocked in
 * the sandboxed preview frame, so persisting the session would crash the page.
 */
type Ctx = {
  staff: Staff | null;
  signIn: (s: Staff) => void;
  signOut: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
};

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const value = useMemo<Ctx>(
    () => ({
      staff,
      signIn: setStaff,
      signOut: () => setStaff(null),
      theme,
      toggleTheme: () =>
        setTheme((t) => {
          const next = t === "light" ? "dark" : "light";
          document.documentElement.classList.toggle("dark", next === "dark");
          return next;
        }),
    }),
    [staff, theme],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
