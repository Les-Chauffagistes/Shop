import { describe, expect, it } from "vitest";
import { mailtoHref } from "@/components/backoffice/orders/ContactEmails";

// L'e-mail vient d'un client et la base n'en contrôle que le format : il ne doit jamais ajouter un
// destinataire, un objet ou un corps au message que l'admin ouvre.
describe("mailtoHref", () => {
  it("garde l'arobase et encode ce qui a un sens dans une URL mailto", () => {
    expect(mailtoHref("alice@exemple.fr")).toBe("mailto:alice@exemple.fr");
    expect(mailtoHref("alice+boutique@exemple.fr")).toBe("mailto:alice%2Bboutique@exemple.fr");
  });

  it("une partie locale piégée ne crée ni copie cachée, ni objet, ni corps", () => {
    for (const email of ["a?bcc=pirate@evil.test", "a&subject=x@evil.test", "a,pirate@evil.test", "a%0Abcc=x@evil.test"]) {
      const href = mailtoHref(email);
      expect(href).not.toMatch(/[?&,]/);
      expect(href.match(/@/g)).toHaveLength(1);
      expect(decodeURIComponent(href.slice("mailto:".length))).toBe(email);
    }
  });
});
