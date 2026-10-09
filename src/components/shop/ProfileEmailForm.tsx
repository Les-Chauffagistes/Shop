"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, toFailure, type ApiFailure } from "@/components/backoffice/api";
import { ErrorAlert, Field, issueAt, Notice } from "@/components/backoffice/ui";

/**
 * E-mail de contact du profil (`PATCH /api/profile`). Rien n'est vérifié ici : un e-mail vide ou mal
 * formé est envoyé tel quel et le message du serveur s'affiche sous le champ (il se change, il ne
 * s'efface pas).
 */
export function ProfileEmailForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState(current ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (failure) inputRef.current?.focus();
  }, [failure]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    setSaved(null);
    try {
      const profile = await api<{ email: string | null }>("PATCH", "/api/profile", { email });
      setEmail(profile.email ?? "");
      setSaved("Adresse e-mail enregistrée.");
      router.refresh();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  // Refus qui portent sur le champ : sous le champ ; tout autre refus : dans l'alerte
  const fieldError = failure?.code === "invalid_contact_email" ? failure.message : issueAt(failure, "email");
  const rest = fieldError ? null : failure;

  return (
    <form className="bo-stack" onSubmit={submit} noValidate>
      <Field
        label="Adresse e-mail"
        hint="Elle préremplit vos prochaines commandes. Les commandes déjà passées gardent l'adresse donnée à ce moment-là."
        error={fieldError}
      >
        {(field) => (
          <input
            {...field}
            ref={inputRef}
            className="bo-input"
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setSaved(null);
            }}
          />
        )}
      </Field>
      <ErrorAlert failure={rest} />
      <Notice message={saved} />
      <div className="bo-actions">
        <button type="submit" className="bo-btn bo-btn-primary" disabled={pending}>
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
