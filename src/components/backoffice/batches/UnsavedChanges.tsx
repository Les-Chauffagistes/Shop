"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type UnsavedChanges = { dirty: boolean; setDirty: (dirty: boolean) => void };

const Context = createContext<UnsavedChanges>({ dirty: false, setDirty: () => {} });

/**
 * Saisies non enregistrées du formulaire de lot, partagées avec les actions de la même page
 * (changement de statut, « Proposer sur ce lot ») qui rechargent le lot et effaceraient ces
 * saisies : elles préviennent l'admin avant. Prévient aussi à la fermeture de l'onglet.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const value = useMemo(() => ({ dirty, setDirty }), [dirty]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useUnsavedChanges(): UnsavedChanges {
  return useContext(Context);
}

/** Avertissement à afficher dans une confirmation qui rechargera le lot. */
export function UnsavedWarning({ action }: { action: string }) {
  const { dirty } = useUnsavedChanges();
  if (!dirty) return null;
  return (
    <div className="bo-alert bo-alert-warning" role="note">
      <strong>Modifications non enregistrées.</strong> Les réglages du lot ont des saisies non enregistrées : {action}{" "}
      recharge le lot et elles seront perdues. Pour les garder, fermez cette fenêtre et enregistrez-les d&apos;abord.
    </div>
  );
}
