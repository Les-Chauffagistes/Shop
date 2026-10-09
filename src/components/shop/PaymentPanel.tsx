"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { btcForWallet, formatBtc, formatSats } from "@/components/money";
import { formatTime } from "@/lib/dates";

/** Intervalle du rafraîchissement automatique d'une facture en attente (lecture serveur légère). */
const POLL_MS = 15_000;

/** Bouton « Copier » : copie un texte, l'annonce aux lecteurs d'écran. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="bo-btn bo-btn-secondary bo-btn-sm"
      aria-label={copied ? `${label} : copié` : `Copier ${label.toLowerCase()}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copié" : "Copier"}
    </button>
  );
}

/** « 12 min 05 s » */
function remaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
}

/**
 * Compte à rebours de la réservation (heure du navigateur : indicatif ; l'heure de fin vient du
 * serveur). Rendu seulement après le montage, pour ne pas différer du rendu serveur.
 */
export function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const [now, setNow] = useState<number | null>(null);
  const expired = useRef(false);
  useEffect(() => {
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (!expired.current && t >= new Date(expiresAt).getTime()) {
        expired.current = true;
        onExpire?.();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, onExpire]);
  if (now === null) return null;
  const left = new Date(expiresAt).getTime() - now;
  return (
    <span className="shop-countdown" role="timer" aria-live="off">
      {left > 0 ? `encore ${remaining(left)}` : "réservation terminée"}
    </span>
  );
}

/**
 * Relit la facture : automatiquement toutes les 15 s tant qu'un paiement est attendu (onglet visible),
 * et à la demande (« Actualiser »). Le serveur seul dit si le paiement est reçu.
 */
export function RefreshStatus({ auto }: { auto: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [at, setAt] = useState<string | null>(null);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      startTransition(() => router.refresh());
      setAt(new Date().toISOString());
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [auto, router]);

  return (
    <div className="shop-refresh">
      <button
        type="button"
        className="bo-btn bo-btn-secondary bo-btn-sm"
        disabled={pending}
        onClick={() => {
          startTransition(() => router.refresh());
          setAt(new Date().toISOString());
        }}
      >
        {pending ? "Actualisation…" : "Actualiser"}
      </button>
      <span className="bo-hint" role="status">
        {at ? `État vérifié à ${formatTime(at)}.` : ""}
        {auto && " Vérification automatique toutes les 15 secondes."}
      </span>
    </div>
  );
}

/**
 * Instructions de paiement : adresse Bitcoin de la facture, montant à envoyer (BTC et sats),
 * compte à rebours de la réservation. `toSendSats` : le reste à payer selon le serveur.
 */
export function PaymentInstructions({
  address,
  toSendSats,
  expiresAt,
  showCountdown,
}: {
  address: string;
  toSendSats: string;
  expiresAt: string;
  showCountdown: boolean;
}) {
  const router = useRouter();
  const btc = btcForWallet(toSendSats);
  return (
    <div className="shop-pay">
      <div className="shop-pay-row">
        <span className="shop-pay-label" id="pay-amount">
          Montant à envoyer
        </span>
        <p className="shop-pay-amount bo-num" aria-labelledby="pay-amount">
          {formatBtc(toSendSats)}
          <small>{formatSats(toSendSats)}</small>
        </p>
        <CopyButton text={btc} label="Le montant en BTC" />
      </div>
      <div className="shop-pay-row">
        <span className="shop-pay-label" id="pay-address">
          Adresse Bitcoin de cette facture
        </span>
        <p className="shop-pay-address bo-mono" aria-labelledby="pay-address">
          {address}
        </p>
        <CopyButton text={address} label="L'adresse" />
      </div>
      <div className="bo-actions">
        <a className="bo-btn bo-btn-secondary bo-btn-sm" href={`bitcoin:${address}?amount=${btc}`}>
          Ouvrir dans mon portefeuille
        </a>
      </div>
      {showCountdown && (
        <p className="shop-pay-deadline">
          Machines réservées jusqu&apos;à <strong>{formatTime(expiresAt)}</strong>{" "}
          <Countdown expiresAt={expiresAt} onExpire={() => router.refresh()} />
        </p>
      )}
    </div>
  );
}
