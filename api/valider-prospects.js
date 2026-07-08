/**
 * ═══════════════════════════════════════════════════════════
 *  Validation des prospects — transfert vers le CRM
 *  Endpoint : GET /api/valider-prospects?key=XXXX
 *
 *  Lit la base 🔍 Prospects à valider, prend ceux dont
 *  Décision = "Validé" ET Transféré = false, et les copie
 *  dans 🏢 Entreprises + 👤 Contacts. Coche ensuite
 *  "Transféré" pour ne pas les retraiter.
 *
 *  Workflow :
 *  1. L'agent remplit la base tampon (Décision = "À valider")
 *  2. Laura review dans Notion et passe en "Validé" ou "Rejeté"
 *  3. Laura appelle cet endpoint (ou cron quotidien)
 *  4. Les validés deviennent des fiches CRM prêtes à prospecter
 * ═══════════════════════════════════════════════════════════
 */

const PROSPECTS_DB   = "922854e54a5a441da7a00030dd6dfc3f";
const ENTREPRISES_DB = "2fd075e127d2819f9fabd4820a69f7f8";
const CONTACTS_DB    = "2fd075e127d2818595bed5d438136955";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET uniquement" });

  const SECRET = process.env.DASHBOARD_SECRET;
  if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: "Clé invalide" });

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return res.status(500).json({ error: "NOTION_API_KEY manquante" });

  const notionH = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const text = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const sel = (p, n) => p?.properties?.[n]?.select?.name || "";
  const email = (p, n) => p?.properties?.[n]?.email || "";
  const phone = (p, n) => p?.properties?.[n]?.phone_number || "";
  const url = (p, n) => p?.properties?.[n]?.url || "";
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];

  try {
    // Lire les prospects validés non transférés
    const r = await fetch(`https://api.notion.com/v1/databases/${PROSPECTS_DB}/query`, {
      method: "POST", headers: notionH,
      body: JSON.stringify({
        filter: { and: [
          { property: "Décision", select: { equals: "Validé" } },
          { property: "Transféré", checkbox: { equals: false } },
        ]},
      }),
    });

    if (!r.ok) return res.status(500).json({ error: "Erreur lecture prospects" });
    const data = await r.json();
    const prospects = data.results;

    if (!prospects.length) return res.status(200).json({ ok: true, message: "Aucun prospect à transférer", transferes: 0 });

    let transferes = 0;

    for (const p of prospects) {
      const nomEntreprise = title(p, "Entreprise");
      if (!nomEntreprise) continue;

      // Créer l'entreprise
      const entrepriseProps = {
        "Nom": { title: [{ text: { content: nomEntreprise } }] },
        "Statut": { select: { name: "Lead" } },
        "Source": { select: { name: "Prospection sortante" } },
      };
      const secteur = sel(p, "Secteur");
      if (secteur) entrepriseProps["Secteur d'activité"] = { select: { name: secteur } };
      const siteWeb = url(p, "Site web");
      if (siteWeb) entrepriseProps["Site web"] = { url: siteWeb };
      const adresse = text(p, "Adresse");
      if (adresse) entrepriseProps["Adresse"] = { rich_text: rt(adresse) };
      const notes = text(p, "Notes entreprise");
      const justif = text(p, "Justification");
      if (notes || justif) {
        entrepriseProps["Objectifs de l'entreprise"] = {
          rich_text: rt(`${notes}\n\nQualification agent : ${justif}`.trim()),
        };
      }

      const createE = await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionH,
        body: JSON.stringify({ parent: { database_id: ENTREPRISES_DB }, properties: entrepriseProps }),
      });

      let entrepriseId = null;
      if (createE.ok) entrepriseId = (await createE.json()).id;

      // Créer le contact
      const contactNom = text(p, "Contact nom");
      if (contactNom) {
        const contactProps = {
          "Nom": { title: [{ text: { content: contactNom } }] },
          "Prénom": { rich_text: rt(text(p, "Contact prénom")) },
          "Fonction": { rich_text: rt(text(p, "Contact fonction")) },
          "Source": { select: { name: "Prospection sortante" } },
          "Statut du contact": { select: { name: "Non contacté" } },
          "Contact principal": { checkbox: true },
        };
        const cEmail = email(p, "Contact email");
        if (cEmail) contactProps["Email"] = { email: cEmail };
        const cTel = phone(p, "Contact téléphone");
        if (cTel) contactProps["Téléphone"] = { phone_number: cTel };
        const cLinkedin = url(p, "Contact LinkedIn");
        if (cLinkedin) contactProps["LinkedIn"] = { url: cLinkedin };
        const cNotes = text(p, "Notes contact");
        if (cNotes) contactProps["Notes"] = { rich_text: rt(cNotes) };
        if (entrepriseId) contactProps["Entreprise"] = { relation: [{ id: entrepriseId }] };

        await fetch("https://api.notion.com/v1/pages", {
          method: "POST", headers: notionH,
          body: JSON.stringify({ parent: { database_id: CONTACTS_DB }, properties: contactProps }),
        });
      }

      // Cocher Transféré
      await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
        method: "PATCH", headers: notionH,
        body: JSON.stringify({ properties: { "Transféré": { checkbox: true } } }),
      });

      transferes++;
    }

    return res.status(200).json({
      ok: true,
      transferes,
      message: `${transferes} prospect(s) transféré(s) vers Entreprises + Contacts`,
    });

  } catch (e) {
    console.error("Validation error:", e);
    return res.status(500).json({ error: e.message });
  }
}
