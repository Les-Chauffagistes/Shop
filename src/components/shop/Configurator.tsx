"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, toFailure, type ApiFailure } from "@/components/backoffice/api";
import { ErrorAlert, Field } from "@/components/backoffice/ui";
import { formatCents } from "@/lib/decimal";
import { buildLoginUrl, type LoginTarget } from "@/lib/login";
import { machines } from "@/lib/plural";
import { sumCents, timesCents } from "./format";
import { chosenValues, OptionMenus, selectionFrom, type OfferedMenu } from "./OptionMenus";

export type { OfferedMenu };

/**
 * Forme de la quantité seulement : un entier écrit en chiffres, 1 ou plus. Le plafond (par personne,
 * par requête) n'est qu'affiché (`wishlistLimit`) : c'est le serveur qui l'applique et dit ce qui reste.
 */
const MIN_QTY = 1;
const QTY_PATTERN = /^\d+$/;

type Common = {
  batchId: string;
  options: OfferedMenu[];
  /** Prix de la machine nue, centimes (affichage indicatif) */
  basePrice: string;
  /** Valeurs présélectionnées (une par menu au plus ; les autres menus prennent leur défaut) */
  initialValueIds: string[];
  login: LoginTarget;
};

type Props =
  | (Common & {
      mode: "create";
      initialQuantity: number;
      signedIn: boolean;
      alreadyInterested: number;
      /** Plafond par personne annoncé par l'API (`wishlistLimit`), pour information seulement */
      wishlistLimit: number;
    })
  | (Common & { mode: "edit"; wishlistId: string });

/**
 * Refus qui rendent l'envoi probablement sans objet : un lien de sortie est proposé. Le bouton
 * reste actif (le serveur tranche à chaque envoi : le lot a pu être republié entre-temps).
 */
const FINAL_CODES = new Set(["wishlist_closed", "batch_not_found", "wishlist_not_editable", "wishlist_converted", "wishlist_not_found"]);

/**
 * Configuration d'une machine (une valeur par menu) : création d'une manifestation d'intérêt
 * depuis la fiche produit, ou modification d'une manifestation existante. Le prix affiché est
 * indicatif ; le serveur relit les prix en base et refuse ce qui n'est plus proposé.
 */
export function Configurator(props: Props) {
  const { batchId, options, basePrice, initialValueIds, login } = props;
  const router = useRouter();
  const [selected, setSelected] = useState(() => selectionFrom(options, initialValueIds));
  const [quantityText, setQuantityText] = useState(String(props.mode === "create" ? props.initialQuantity : 1));
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [closed, setClosed] = useState(false);
  const [created, setCreated] = useState<number | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  useEffect(() => {
    if (created !== null) successRef.current?.focus();
  }, [created]);

  // Valeur retenue par menu : le choix s'il est toujours proposé (les options ont pu changer
  // après un rechargement), sinon la valeur par défaut
  const chosen = chosenValues(options, selected);
  const unitPrice = sumCents([basePrice, ...chosen.map((c) => c.value?.price ?? "0")]);
  const quantity = Number(quantityText.trim());
  const quantityValid = QTY_PATTERN.test(quantityText.trim()) && Number.isSafeInteger(quantity) && quantity >= MIN_QTY;
  const choices = chosen.flatMap((c) => (c.value ? [{ optionId: c.menu.id, optionValueId: c.value.id }] : []));

  /** Retour après connexion : la fiche, avec la configuration en cours. */
  function loginHref(): string {
    if (props.mode === "edit") return buildLoginUrl(login, `/mes-interets/${props.wishlistId}`);
    const query = new URLSearchParams({
      choix: choices.map((c) => c.optionValueId).join(","),
      quantite: quantityValid ? String(quantity) : "1",
    });
    return buildLoginUrl(login, `/lots/${batchId}?${query}`);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (props.mode === "create" && !props.signedIn) {
      window.location.assign(loginHref());
      return;
    }
    if (props.mode === "create" && !quantityValid) {
      setQuantityError("Indiquez un nombre entier de machines (1 ou plus).");
      quantityRef.current?.focus();
      return;
    }
    setPending(true);
    setFailure(null);
    setClosed(false);
    setCreated(null);
    try {
      if (props.mode === "create") {
        const result = await api<{ items: unknown[] }>("POST", "/api/wishlists", { batchId, choices, quantity });
        setCreated(result.items.length);
        setQuantityText("1");
        router.refresh();
      } else {
        await api("PATCH", `/api/wishlists/${props.wishlistId}`, { choices });
        router.push(`/mes-interets?modifie=${props.wishlistId}`);
      }
    } catch (error) {
      const f = toFailure(error);
      if (f.status === 401) {
        window.location.assign(loginHref());
        return;
      }
      setFailure(f);
      if (FINAL_CODES.has(f.code)) setClosed(true);
      // Options retirées entre-temps : recharge l'offre du lot (les choix périmés reviennent au défaut)
      if (f.code === "option_not_offered") router.refresh();
    } finally {
      setPending(false);
    }
  }

  const backLink =
    props.mode === "create" ? (
      <Link className="bo-btn bo-btn-secondary" href="/">
        Voir les lots disponibles
      </Link>
    ) : (
      <Link className="bo-btn bo-btn-secondary" href="/mes-interets">
        Retour à mes intérêts
      </Link>
    );

  return (
    <form className="shop-config" onSubmit={submit} noValidate aria-labelledby="configurer">
      <h2 id="configurer">{props.mode === "create" ? "Configurez votre machine" : "Modifier la configuration"}</h2>

      <OptionMenus
        options={options}
        selected={selected}
        onSelect={(menuId, valueId) => setSelected((cur) => ({ ...cur, [menuId]: valueId }))}
      />

      {props.mode === "create" && (
        <Field
          label="Nombre de machines"
          hint={`Toutes avec cette configuration. Jusqu'à ${machines(props.wishlistLimit)} par personne sur ce lot.`}
          error={quantityError}
        >
          {(field) => (
            <input
              {...field}
              ref={quantityRef}
              className="bo-input bo-num shop-qty"
              type="number"
              inputMode="numeric"
              min={MIN_QTY}
              step={1}
              value={quantityText}
              onChange={(e) => {
                setQuantityText(e.target.value);
                setQuantityError(null);
              }}
            />
          )}
        </Field>
      )}

      <div className="shop-summary">
        <div className="shop-summary-line" aria-live="polite">
          <span>Prix par machine</span>
          <strong className="bo-num">{formatCents(unitPrice)}</strong>
        </div>
        {props.mode === "create" && quantityValid && quantity > 1 && (
          <div className="shop-summary-line">
            <span>Total pour {machines(quantity)}</span>
            <strong className="bo-num">{formatCents(timesCents(unitPrice, quantity))}</strong>
          </div>
        )}
        <p className="bo-hint">Prix indicatif, sans engagement : aucun paiement n&apos;est demandé maintenant.</p>
      </div>

      {failure && (
        <div ref={alertRef} tabIndex={-1} className="shop-alert-focus">
          <ErrorAlert failure={failure}>
            {failure.code === "option_not_offered" && (
              <p style={{ marginTop: 6 }}>Les options proposées ont été mises à jour : vérifiez votre configuration.</p>
            )}
            {closed && <div className="bo-actions">{backLink}</div>}
          </ErrorAlert>
        </div>
      )}

      {created !== null && (
        <div ref={successRef} tabIndex={-1} className="bo-alert bo-alert-success shop-alert-focus" role="status">
          <strong>C&apos;est noté : votre intérêt pour {machines(created)} est enregistré.</strong>
          <p style={{ marginTop: 4 }}>
            Vous serez prioritaire à l&apos;ouverture des précommandes. <Link href="/mes-interets">Voir mes intérêts</Link>
          </p>
        </div>
      )}

      <button type="submit" className="bo-btn bo-btn-primary shop-cta" disabled={pending}>
        {pending
          ? "Envoi en cours…"
          : props.mode === "create"
            ? "Manifester mon intérêt"
            : "Enregistrer la configuration"}
      </button>
      {props.mode === "create" && !props.signedIn && (
        <p className="bo-hint shop-center">Connexion requise : vous reviendrez ici avec votre configuration.</p>
      )}
      {props.mode === "create" && props.signedIn && props.alreadyInterested > 0 && (
        <p className="bo-hint shop-center">
          Vous suivez déjà {machines(props.alreadyInterested)} de ce lot. <Link href="/mes-interets">Mes intérêts</Link>
        </p>
      )}
      {props.mode === "edit" && (
        <Link className="bo-btn bo-btn-ghost shop-center" href="/mes-interets">
          Annuler
        </Link>
      )}
    </form>
  );
}
