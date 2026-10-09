import { describe, expect, it } from "vitest";
import { buildLoginUrl, isSafeLocalPath, safeReturnPath } from "@/lib/login";

const target = { loginPage: "https://login.example/login", publicOrigin: "https://boutique.example" };
/** Adresse de retour transmise à la page de connexion. */
const back = (path: string, fallback?: string) =>
  new URL(buildLoginUrl(target, path, fallback)).searchParams.get("redirect");

describe("isSafeLocalPath", () => {
  it("accepte un chemin du site, avec sa requête et ses caractères encodés", () => {
    for (const path of [
      "/",
      "/mes-interets",
      "/mes-interets/0b0e7f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      "/lots/abc?choix=a,b&quantite=2",
      "/lots/abc?choix=a%2Cb",
      "/recherche?q=%2F%2Fpas-un-hote",
      "/mes-interets?modifie=x#machine",
    ]) {
      expect(isSafeLocalPath(path), path).toBe(true);
    }
  });

  it("refuse toute adresse qui sortirait du site", () => {
    for (const path of [
      "",
      "mes-interets",
      "//evil.com",
      "//evil.com/mes-interets",
      "///evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "\\/evil.com",
      "/mes-interets\\..\\..\\evil",
      "https://evil.com",
      "https://boutique.example/mes-interets",
      "http:/evil.com",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/%2F%2Fevil.com",
      "/%2f/evil.com",
      "/%5Cevil.com",
      "/%5cevil.com",
      "/%E0%A4%A",
      "/\t/evil.com",
      "/\n/evil.com",
      "/%09/evil.com",
      " /mes-interets",
    ]) {
      expect(isSafeLocalPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe("safeReturnPath", () => {
  it("remplace un chemin dangereux par le repli, et un repli dangereux par l'accueil", () => {
    expect(safeReturnPath("/lots/x?quantite=2", "/mes-interets")).toBe("/lots/x?quantite=2");
    expect(safeReturnPath("//evil.com", "/mes-interets")).toBe("/mes-interets");
    expect(safeReturnPath("//evil.com", "//evil.com")).toBe("/");
  });
});

describe("buildLoginUrl", () => {
  it("renvoie exactement sur le chemin demandé, requête comprise, sur l'origine publique", () => {
    expect(back("/mes-interets/abc")).toBe("https://boutique.example/mes-interets/abc");
    expect(back("/lots/abc?choix=a,b&quantite=2")).toBe("https://boutique.example/lots/abc?choix=a,b&quantite=2");
    expect(buildLoginUrl(target, "/mes-interets?modifie=x")).toBe(
      `https://login.example/login?redirect=${encodeURIComponent("https://boutique.example/mes-interets?modifie=x")}`,
    );
  });

  it("n'utilise que l'origine de PUBLIC_URL (chemin éventuel ignoré)", () => {
    expect(new URL(buildLoginUrl({ ...target, publicOrigin: "https://boutique.example/sous/chemin" }, "/a")).searchParams.get("redirect")).toBe(
      "https://boutique.example/a",
    );
  });

  it("cas hostiles : retour sur le repli, jamais ailleurs que sur la boutique", () => {
    for (const path of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com/x",
      "javascript:alert(1)",
      "/%2F%2Fevil.com",
      "/%5Cevil.com",
      "/\t/evil.com",
    ]) {
      const url = back(path, "/mes-interets");
      expect(url, JSON.stringify(path)).toBe("https://boutique.example/mes-interets");
    }
    expect(back("//evil.com")).toBe("https://boutique.example/");
    expect(back("//evil.com", "https://evil.com")).toBe("https://boutique.example/");
  });

  it("un chemin à points reste sur la boutique", () => {
    expect(new URL(back("/../../evil.com")!).origin).toBe("https://boutique.example");
  });
});
