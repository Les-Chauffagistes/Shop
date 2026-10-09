"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { getModel } from "@/server/catalog";
import { hashesToTerahashInput, terahashToHashes } from "@/lib/decimal";

/** Bornes de l'API (docs/api.md, « Bornes de saisie ») : 1 à 20 hashboards, 10 000 TH/s au plus. */
const MAX_HASHBOARDS = 20;
const MAX_HASHES = 10n ** 16n;
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field, Notice, splitFieldFailure } from "../ui";

type Model = Awaited<ReturnType<typeof getModel>>;

/** Lots qui utilisent le modèle (ce qui bloque sa suppression). */
export type ModelUsage = { batches: { id: string; name: string }[]; total: number };

/** Création ou modification des caractéristiques d'un modèle. */
export function ModelForm({ model, returnTo, usage }: { model?: Model; returnTo?: "lot"; usage?: ModelUsage }) {
  const router = useRouter();
  const [name, setName] = useState(model?.name ?? "");
  const [hashrate, setHashrate] = useState(model ? hashesToTerahashInput(model.hashrate) : "");
  const [hashboards, setHashboards] = useState(model ? String(model.hashboardQtt) : "3");
  const [description, setDescription] = useState(model?.description ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<ApiFailure | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Nom déjà pris : le message du serveur s'affiche sous le champ « Nom du modèle »
  const { fieldError: nameTaken, rest: formFailure } = splitFieldFailure(failure, "model_name_taken");
  useEffect(() => {
    if (nameTaken) nameRef.current?.focus(); // le lecteur d'écran lit le champ avec son erreur
  }, [nameTaken]);

  const hashes = terahashToHashes(hashrate);
  const hashboardQtt = Number(hashboards);
  // Validité calculée sans `touched` : l'envoi ne part jamais avec une saisie refusée localement
  const nameValid = name.trim() !== "";
  const hashboardsValid =
    hashboards.trim() !== "" && Number.isInteger(hashboardQtt) && hashboardQtt >= 1 && hashboardQtt <= MAX_HASHBOARDS;
  const hashrateValid = hashes !== null && BigInt(hashes) <= MAX_HASHES;
  const nameError = touched && !nameValid ? "Indiquez le nom du modèle, ex. S19." : null;
  const hashrateError =
    touched && !hashrateValid ? "Indiquez un hashrate positif en TH/s, au plus 10 000 TH/s, ex. 95 ou 13,5." : null;
  const hashboardsError = touched && !hashboardsValid ? "Nombre entier de hashboards compris entre 1 et 20." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    setFailure(null);
    if (!nameValid || !hashrateValid || !hashboardsValid) return; // erreurs affichées sous les champs
    setPending(true);
    setFailure(null);
    const body = { name, hashrate: hashes, hashboardQtt, description: description.trim() || null };
    try {
      if (model) {
        await api("PATCH", `/api/backoffice/models/${model.id}`, body);
        setNotice("Modèle enregistré.");
        router.refresh();
      } else {
        const created = await api<Model>("POST", "/api/backoffice/models", body);
        router.push(`/backoffice/modeles/${created.id}${returnTo ? `?retour=${returnTo}` : ""}`);
      }
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!model) return;
    setPending(true);
    setDeleteFailure(null);
    try {
      await api("DELETE", `/api/backoffice/models/${model.id}`);
      router.push("/backoffice/modeles");
      router.refresh();
    } catch (error) {
      setDeleteFailure(toFailure(error));
      setPending(false);
    }
  }

  return (
    <>
    <form className="bo-form" onSubmit={submit} noValidate>
      <div className="bo-fields">
        <Field label="Nom du modèle" hint="Nom court affiché aux clients, ex. S19." error={nameError ?? nameTaken}>
          {(p) => (
            <input
              {...p}
              ref={nameRef}
              className="bo-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameTaken) setFailure(null);
              }}
              required
              maxLength={120}
              autoFocus={!model}
            />
          )}
        </Field>
        <Field label="Hashrate théorique" error={hashrateError}>
          {(p) => (
            <div className="bo-input-affix">
              <input
                {...p}
                className="bo-input bo-num"
                inputMode="decimal"
                value={hashrate}
                onChange={(e) => setHashrate(e.target.value)}
                required
                autoComplete="off"
              />
              <span aria-hidden="true" style={{ right: 12 }}>
                TH/s
              </span>
            </div>
          )}
        </Field>
        <Field label="Nombre de hashboards" hint="Utile pour le contrôle à réception." error={hashboardsError}>
          {(p) => (
            <input
              {...p}
              className="bo-input bo-num"
              type="number"
              min={1}
              max={MAX_HASHBOARDS}
              step={1}
              value={hashboards}
              onChange={(e) => setHashboards(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Description" optional hint="Courte description affichée sur la fiche produit." wide>
          {(p) => (
            <textarea
              {...p}
              className="bo-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          )}
        </Field>
      </div>
      <ErrorAlert failure={formFailure} />
      <Notice message={notice} />
      <div className="bo-actions">
        <button className="bo-btn bo-btn-primary" type="submit" disabled={pending}>
          {pending ? "Enregistrement…" : model ? "Enregistrer" : "Créer le modèle"}
        </button>
        {model && (
          <button
            type="button"
            className="bo-btn bo-btn-ghost"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setDeleteFailure(null);
              setConfirmDelete(true);
            }}
          >
            Supprimer le modèle
          </button>
        )}
      </div>
    </form>
      {model && (
        <ConfirmDialog
          open={confirmDelete}
          title={`Supprimer le modèle « ${model.name} » ?`}
          confirmLabel="Supprimer"
          confirmTone="danger"
          pending={pending}
          confirmDisabled={Boolean(usage && usage.total > 0)}
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        >
          {usage && usage.total > 0 ? (
            <div className="bo-alert bo-alert-warning">
              <strong>
                Ce modèle est utilisé par {usage.total > 1 ? `${usage.total} lots` : "un lot"} : il ne peut pas être
                supprimé.
              </strong>
              <ul>
                {usage.batches.map((b) => (
                  <li key={b.id}>
                    <Link href={`/backoffice/lots/${b.id}`}>{b.name}</Link>
                  </li>
                ))}
                {usage.total > usage.batches.length && <li>et {usage.total - usage.batches.length} autres</li>}
              </ul>
            </div>
          ) : (
            <p>Ses menus d&apos;options seront supprimés aussi. Un modèle utilisé par un lot ne peut pas être supprimé.</p>
          )}
          <ErrorAlert failure={deleteFailure} />
        </ConfirmDialog>
      )}
    </>
  );
}
