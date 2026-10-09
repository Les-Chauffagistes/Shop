import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ConfirmDialog contient son propre <form> : un <form> imbriqué est invalide en HTML (le rendu serveur supprime
// la balise intérieure et la confirmation soumettrait le formulaire extérieur, en GET). Le dialogue doit donc
// toujours être rendu HORS de tout <form>. Ce test lit chaque composant et refuse un <ConfirmDialog> placé dans
// un <form> du même fichier (le cas qui se produit en pratique ; une imbrication via un autre composant relève de la revue).

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

const tag = (node: ts.Node): string | null => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
};

/** Lignes des <ConfirmDialog> qui ont un <form> pour ancêtre dans le texte d'un composant. */
function nestedDialogs(text: string): number[] {
  const source = ts.createSourceFile("composant.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: number[] = [];
  const visit = (node: ts.Node, insideForm: boolean) => {
    const name = tag(node);
    if (name === "ConfirmDialog" && insideForm) {
      found.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    const next = insideForm || name === "form";
    node.forEachChild((child) => visit(child, next));
  };
  visit(source, false);
  return found;
}

describe("ConfirmDialog n'est jamais rendu dans un <form>", () => {
  const files = tsxFiles("src");
  const users = files.filter((f) => readFileSync(f, "utf8").includes("<ConfirmDialog"));

  it("le détecteur voit les écrans qui utilisent le dialogue", () => {
    expect(users.length).toBeGreaterThanOrEqual(10);
  });

  it.each(users)("%s", (path) => {
    expect(nestedDialogs(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("le détecteur repère un dialogue imbriqué, pas un dialogue voisin du formulaire", () => {
    expect(nestedDialogs("export const A = () => <form><div><ConfirmDialog open /></div></form>;")).toEqual([1]);
    expect(nestedDialogs("export const B = () => <><form /><ConfirmDialog open /></>;")).toEqual([]);
  });
});
