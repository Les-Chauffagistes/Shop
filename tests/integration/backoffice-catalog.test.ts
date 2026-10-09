import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelRoute from "@/app/api/backoffice/models/[modelId]/route";
import * as optionsRoute from "@/app/api/backoffice/models/[modelId]/options/route";
import * as modelsRoute from "@/app/api/backoffice/models/route";
import * as valueRoute from "@/app/api/backoffice/option-values/[valueId]/route";
import * as optionRoute from "@/app/api/backoffice/options/[optionId]/route";
import * as valuesRoute from "@/app/api/backoffice/options/[optionId]/values/route";
import * as partRoute from "@/app/api/backoffice/parts/[partId]/route";
import * as partsRoute from "@/app/api/backoffice/parts/route";
import * as batchesRoute from "@/app/api/backoffice/batches/route";
import { prisma } from "./db";
import { ADMIN, call, signIn } from "./http";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}));

beforeEach(async () => {
  cookieJar.clear();
  await signIn(cookieJar, ADMIN);
});

const S19 = { name: "S19", hashrate: "95000000000000", hashboardQtt: 3, description: "Antminer S19 95 TH/s" };

async function createModel(body: object = S19) {
  const reply = await call(modelsRoute.POST, { body });
  expect(reply.status).toBe(201);
  return reply.body;
}

/** Menu « Kit de ventilation » de specs.md (exemple 1), prix en centimes. */
async function createVentilation(modelId: string) {
  const reply = await call(optionsRoute.POST, {
    params: { modelId },
    body: {
      kind: "choice",
      title: "Kit de ventilation",
      description: "Choisissez le type de ventilation de votre nouvel appareil",
      values: [
        { label: "Sans kit", price: "0", isDefault: true, position: 0 },
        { label: "Air Flow", price: "3500", position: 1 },
        { label: "Silent kit", price: "7500", position: 2 },
      ],
    },
  });
  expect(reply.status).toBe(201);
  return reply.body;
}

const defaults = (option: { values: { label: string; isDefault: boolean }[] }) =>
  option.values.filter((v) => v.isDefault).map((v) => v.label);

describe("accès", () => {
  it("401 sans session, 403 hors whitelist", async () => {
    cookieJar.clear();
    expect(await call(modelsRoute.GET)).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    await signIn(cookieJar, "2");
    expect(await call(modelsRoute.GET)).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });
});

describe("modèles", () => {
  it("crée, lit, modifie ; BIGINT en chaînes", async () => {
    const model = await createModel();
    expect(model).toMatchObject({ name: "S19", hashrate: "95000000000000", hashboardQtt: 3, options: [], batchCount: 0 });

    const patched = await call(modelRoute.PATCH, { params: { modelId: model.id }, body: { name: "S19 Pro", description: null } });
    expect(patched.body).toMatchObject({ name: "S19 Pro", description: null, hashrate: "95000000000000" });

    const list = await call(modelsRoute.GET);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: "S19 Pro", optionCount: 0 });
  });

  it("valide les entrées : hashrate en chaîne, champs inconnus refusés", async () => {
    const reply = await call(modelsRoute.POST, { body: { ...S19, hashrate: 95e12 } });
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe("invalid_input");
    expect(reply.body.error.issues.map((i: { path: string }) => i.path)).toEqual(["hashrate"]);

    const unknown = await call(modelsRoute.POST, { body: { ...S19, hashRate: "1" } });
    expect(unknown.status).toBe(400);

    const notJson = await call(modelsRoute.POST, { body: "{oops" });
    expect(notJson.body.error.code).toBe("invalid_json");
  });

  it("bornes : hashrate 1 H/s à 10 PH/s, hashboards 1 à 20, un seul message exact par champ", async () => {
    const issues = async (body: object) =>
      (await call(modelsRoute.POST, { body: { ...S19, ...body } })).body.error.issues.map(
        (i: { path: string; message: string }) => [i.path, i.message],
      );
    const hashboards = "Nombre de hashboards compris entre 1 et 20 attendu";
    for (const value of [0, -1, 1.5, 21, "3", null]) {
      expect(await issues({ hashboardQtt: value }), String(value)).toEqual([["hashboardQtt", hashboards]]);
    }
    const hashrate = (await issues({ hashrate: "10000000000000001" }))[0];
    expect(hashrate[0]).toBe("hashrate");
    expect(hashrate[1]).toMatch(/entre "1" et "10000000000000000"/);
    expect(await issues({ hashrate: "0" })).toEqual([hashrate]);
    expect((await call(modelsRoute.POST, { body: { ...S19, hashrate: "10000000000000000", hashboardQtt: 20 } })).status).toBe(201);
  });

  it("404 pour un identifiant inconnu ou mal formé", async () => {
    expect((await call(modelRoute.GET, { params: { modelId: "nope" } })).body.error.code).toBe("model_not_found");
    const missing = await call(modelRoute.GET, { params: { modelId: "00000000-0000-4000-8000-000000000000" } });
    expect(missing.status).toBe(404);
  });

  it("supprime un modèle jamais mis en lot, avec ses menus ; refuse sinon", async () => {
    const unused = await createModel();
    await createVentilation(unused.id);
    expect((await call(modelRoute.DELETE, { params: { modelId: unused.id } })).status).toBe(204);
    expect(await prisma.optionValue.count()).toBe(0);

    const used = await createModel();
    await call(batchesRoute.POST, { body: { modelId: used.id, quantity: 4, purchasePrice: "100000" } });
    const refused = await call(modelRoute.DELETE, { params: { modelId: used.id } });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "model_in_use" } } });
    expect(refused.body.error.message).toMatch(/1 lot/);
  });
});

describe("menus d'options et valeurs", () => {
  it("crée le menu et ses valeurs en une fois (exemple de la spec)", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    expect(option).toMatchObject({ kind: "choice", title: "Kit de ventilation", position: 0 });
    expect(option.values.map((v: { label: string; price: string }) => [v.label, v.price])).toEqual([
      ["Sans kit", "0"],
      ["Air Flow", "3500"],
      ["Silent kit", "7500"],
    ]);
    expect(defaults(option)).toEqual(["Sans kit"]);

    const detail = await call(modelRoute.GET, { params: { modelId: model.id } });
    expect(detail.body.options).toHaveLength(1);
  });

  it("crée le menu vide puis ses valeurs : la première devient le défaut", async () => {
    const model = await createModel();
    const created = await call(optionsRoute.POST, { params: { modelId: model.id }, body: { kind: "choice", title: "Nettoyage" } });
    expect(created.body.values).toEqual([]);
    const optionId = created.body.id;

    // La première valeur devient le défaut : elle doit être gratuite
    const paidFirst = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Express", price: "1000" } });
    expect(paidFirst).toMatchObject({ status: 422, body: { error: { code: "default_value_not_free" } } });
    const first = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Sans", price: "0" } });
    expect(defaults(first.body)).toEqual(["Sans"]);
    const second = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Nettoyage complet", price: "2000" } });
    expect(defaults(second.body)).toEqual(["Sans"]);
    expect(second.body.values.map((v: { position: number }) => v.position)).toEqual([0, 1]);

    // Une nouvelle valeur par défaut prend la place de l'ancienne, dans la même transaction ; défaut gratuit
    const paid = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Express", price: "1000", isDefault: true } });
    expect(paid).toMatchObject({ status: 422, body: { error: { code: "default_value_not_free" } } });
    const third = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Standard", price: "0", isDefault: true } });
    expect(defaults(third.body)).toEqual(["Standard"]);
  });

  it("refuse plusieurs défauts à la création", async () => {
    const model = await createModel();
    const reply = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: {
        kind: "choice",
        title: "X",
        values: [
          { label: "A", price: "0", isDefault: true },
          { label: "B", price: "0", isDefault: true },
        ],
      },
    });
    expect(reply.status).toBe(400);
  });

  it("change le défaut ; refuse de le retirer sans en désigner un autre", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    const [noKit, airFlow] = option.values;

    const refused = await call(valueRoute.PATCH, { params: { valueId: noKit.id }, body: { isDefault: false } });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "default_value_required" } } });

    // Le défaut est gratuit : un défaut payant est refusé, rien n'est écrit
    const paid = await call(valueRoute.PATCH, { params: { valueId: airFlow.id }, body: { isDefault: true, price: "4000" } });
    expect(paid).toMatchObject({ status: 422, body: { error: { code: "default_value_not_free" } } });
    expect((await call(valueRoute.PATCH, { params: { valueId: airFlow.id }, body: { isDefault: true } })).status).toBe(422);
    const noKitPaid = await call(valueRoute.PATCH, { params: { valueId: noKit.id }, body: { price: "100" } });
    expect(noKitPaid.body.error.code).toBe("default_value_not_free");

    const changed = await call(valueRoute.PATCH, { params: { valueId: airFlow.id }, body: { isDefault: true, price: "0" } });
    expect(changed.status).toBe(200);
    expect(defaults(changed.body)).toEqual(["Air Flow"]);
    expect(changed.body.values[1].price).toBe("0");
  });

  it("Avec/Sans : deux valeurs créées par le serveur, figées", async () => {
    const model = await createModel();
    const part = (await call(partsRoute.POST, { body: { name: "Kit silencieux", reference: "SK-01" } })).body;
    const toggle = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: { kind: "toggle", title: "Kit silencieux", price: "7500", parts: [{ partId: part.id, qty: 2 }] },
    });
    expect(toggle.status).toBe(201);
    expect(toggle.body.values).toMatchObject([
      { label: "Sans", price: "0", isDefault: true, parts: [] },
      { label: "Avec", price: "7500", isDefault: false, parts: [{ id: part.id, name: "Kit silencieux", qty: 2 }] },
    ]);

    const optionId = toggle.body.id;
    const add = await call(valuesRoute.POST, { params: { optionId }, body: { label: "Peut-être", price: "1" } });
    expect(add.body.error.code).toBe("toggle_values_fixed");
    const del = await call(valueRoute.DELETE, { params: { valueId: toggle.body.values[1].id } });
    expect(del.body.error.code).toBe("toggle_values_fixed");

    // « Sans » est toujours le défaut : « Avec » ne l'est jamais
    const avec = await call(valueRoute.PATCH, { params: { valueId: toggle.body.values[1].id }, body: { isDefault: true } });
    expect(avec).toMatchObject({ status: 409, body: { error: { code: "toggle_default_fixed" } } });
    const on = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: { kind: "toggle", title: "Nettoyage", price: "1500", defaultOn: true },
    });
    expect(on).toMatchObject({ status: 400, body: { error: { code: "invalid_input", issues: [{ path: "defaultOn" }] } } });
    const off = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: { kind: "toggle", title: "Nettoyage", price: "1500", defaultOn: false },
    });
    expect(defaults(off.body)).toEqual(["Sans"]);
    expect(off.body.position).toBe(1);
  });

  it("supprime une valeur non utilisée, pas le défaut tant qu'il en reste d'autres", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    const [noKit, airFlow] = option.values;
    expect((await call(valueRoute.DELETE, { params: { valueId: noKit.id } })).body.error.code).toBe("default_value_required");
    const after = await call(valueRoute.DELETE, { params: { valueId: airFlow.id } });
    expect(after.status).toBe(200);
    expect(after.body.values.map((v: { label: string }) => v.label)).toEqual(["Sans kit", "Silent kit"]);
  });

  it("refuse de supprimer un menu ou une valeur réglés sur un lot", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    const silent = option.values[2];
    const batch = await call(batchesRoute.POST, {
      body: { modelId: model.id, quantity: 4, purchasePrice: "100000", optionValues: [{ optionValueId: silent.id, maxQty: 2 }] },
    });
    expect(batch.status).toBe(201);

    const delValue = await call(valueRoute.DELETE, { params: { valueId: silent.id } });
    expect(delValue).toMatchObject({ status: 409, body: { error: { code: "option_value_in_use" } } });
    const delOption = await call(optionRoute.DELETE, { params: { optionId: option.id } });
    expect(delOption).toMatchObject({ status: 409, body: { error: { code: "option_in_use" } } });

    const renamed = await call(optionRoute.PATCH, { params: { optionId: option.id }, body: { title: "Ventilation", position: 3 } });
    expect(renamed.body).toMatchObject({ title: "Ventilation", position: 3 });
  });

  it("supprime un menu inutilisé", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    expect((await call(optionRoute.DELETE, { params: { optionId: option.id } })).status).toBe(204);
    expect(await prisma.option.count()).toBe(0);
  });

  it("une valeur retirée d'un lot ne peut pas devenir le défaut", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    const airFlow = option.values[1];
    await call(batchesRoute.POST, {
      body: { modelId: model.id, quantity: 4, purchasePrice: "100000", optionValues: [{ optionValueId: airFlow.id, enabled: false }] },
    });
    const reply = await call(valueRoute.PATCH, { params: { valueId: airFlow.id }, body: { isDefault: true, price: "0" } });
    expect(reply).toMatchObject({ status: 409, body: { error: { code: "default_value_withdrawn" } } });
  });
});

describe("pièces", () => {
  it("CRUD, association aux valeurs, suppression refusée si utilisée", async () => {
    const model = await createModel();
    const option = await createVentilation(model.id);
    const silent = option.values[2];

    const part = (await call(partsRoute.POST, { body: { name: "Ventilateur silencieux" } })).body;
    expect(part).toMatchObject({ name: "Ventilateur silencieux", reference: null });
    const renamed = await call(partRoute.PATCH, { params: { partId: part.id }, body: { reference: "NF-A12" } });
    expect(renamed.body.reference).toBe("NF-A12");

    const linked = await call(valueRoute.PATCH, { params: { valueId: silent.id }, body: { parts: [{ partId: part.id, qty: 4 }] } });
    expect(linked.body.values[2].parts).toEqual([{ id: part.id, name: "Ventilateur silencieux", reference: "NF-A12", qty: 4 }]);

    const unknownPart = await call(valueRoute.PATCH, {
      params: { valueId: silent.id },
      body: { parts: [{ partId: "00000000-0000-4000-8000-000000000000" }] },
    });
    expect(unknownPart).toMatchObject({ status: 422, body: { error: { code: "unknown_part" } } });

    expect((await call(partRoute.DELETE, { params: { partId: part.id } })).body.error.code).toBe("part_in_use");
    await call(valueRoute.PATCH, { params: { valueId: silent.id }, body: { parts: [] } });
    expect((await call(partRoute.DELETE, { params: { partId: part.id } })).status).toBe(204);
    expect((await call(partsRoute.GET)).body.items).toEqual([]);
  });
});

describe("noms uniques (casse et espaces de bord ignorés)", () => {
  const expectTaken = (reply: { status: number; body: { error?: { code: string } } }, code: string) =>
    expect({ status: reply.status, code: reply.body.error?.code }).toEqual({ status: 409, code });

  it("modèles : nom global, à la création et à la modification", async () => {
    const s19 = await createModel();
    expectTaken(await call(modelsRoute.POST, { body: { ...S19, name: "  s19 " } }), "model_name_taken");
    const other = await createModel({ ...S19, name: "S21" });
    expectTaken(await call(modelRoute.PATCH, { params: { modelId: other.id }, body: { name: "S19" } }), "model_name_taken");
    // Changer la casse de son propre nom reste permis
    expect((await call(modelRoute.PATCH, { params: { modelId: s19.id }, body: { name: "s19" } })).body.name).toBe("s19");
  });

  it("menus : titre unique par modèle, pas d'un modèle à l'autre", async () => {
    const model = await createModel();
    const ventilation = await createVentilation(model.id);
    const dup = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: { kind: "toggle", title: "KIT DE VENTILATION", price: "100" },
    });
    expectTaken(dup, "option_title_taken");
    expect(dup.body.error.message).toMatch(/déjà un menu d'options de ce titre/);
    expect(await prisma.option.count()).toBe(1); // rien n'a été créé (transaction)

    const cleaning = await call(optionsRoute.POST, { params: { modelId: model.id }, body: { kind: "toggle", title: "Nettoyage", price: "100" } });
    expectTaken(
      await call(optionRoute.PATCH, { params: { optionId: cleaning.body.id }, body: { title: "kit de ventilation" } }),
      "option_title_taken",
    );
    const otherModel = await createModel({ ...S19, name: "S21" });
    expect((await createVentilation(otherModel.id)).id).not.toBe(ventilation.id);
  });

  it("valeurs : libellé unique par menu, à la création du menu, à l'ajout et à la modification", async () => {
    const model = await createModel();
    const inline = await call(optionsRoute.POST, {
      params: { modelId: model.id },
      body: { kind: "choice", title: "Firmware", values: [{ label: "Stock", price: "0" }, { label: "stock ", price: "500" }] },
    });
    expectTaken(inline, "option_value_label_taken");

    const option = await createVentilation(model.id);
    expectTaken(
      await call(valuesRoute.POST, { params: { optionId: option.id }, body: { label: "air flow", price: "100" } }),
      "option_value_label_taken",
    );
    expectTaken(
      await call(valueRoute.PATCH, { params: { valueId: option.values[2].id }, body: { label: "Sans Kit" } }),
      "option_value_label_taken",
    );
    // Le même libellé dans un autre menu est permis
    const cleaning = await call(optionsRoute.POST, { params: { modelId: model.id }, body: { kind: "toggle", title: "Nettoyage", price: "100" } });
    expect(cleaning.status).toBe(201);
    expect((await call(valueRoute.PATCH, { params: { valueId: cleaning.body.values[1].id }, body: { label: "Air Flow" } })).status).toBe(200);
  });

  it("produits : nom global, à la création et à la modification", async () => {
    await call(partsRoute.POST, { body: { name: "Ventilateur silencieux" } });
    expectTaken(await call(partsRoute.POST, { body: { name: " VENTILATEUR silencieux" } }), "part_name_taken");
    const other = (await call(partsRoute.POST, { body: { name: "Filtre" } })).body;
    const dup = await call(partRoute.PATCH, { params: { partId: other.id }, body: { name: "ventilateur silencieux" } });
    expectTaken(dup, "part_name_taken");
    expect(dup.body.error.message).toBe("Un produit porte déjà ce nom (majuscules et espaces ignorés). Choisissez un autre nom.");
  });

  it("deux créations simultanées du même nom : une seule passe", async () => {
    const replies = await Promise.all([
      call(modelsRoute.POST, { body: S19 }),
      call(modelsRoute.POST, { body: { ...S19, name: "s19" } }),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.model.count()).toBe(1);
  });
});
