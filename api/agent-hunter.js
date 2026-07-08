/**
 * ═══════════════════════════════════════════════════════════
 *  Agent Hunter — Laura Ballo Coaching
 *  Endpoint : GET /api/agent-hunter?key=XXXX
 *
 *  Architecture :
 *  Étage 1 — Traducteur : GPT-4o-mini lit les instructions Notion
 *            et les convertit en filtres Hunter Discover
 *  Étage 2 — Hunter Discover : trouve les entreprises correspondantes
 *  Étage 2b — Fallback : si <3 entreprises, on lit la liste
 *             de domaines depuis Notion et on fait Domain Search
 *  Étage 3 — Hunter Domain Search : extrait 3 contacts par entreprise
 *            (RH + Responsable formation + DG si PME/ETI)
 *  Étage 4 — Enrichissement : GPT-4o + web search ajoute du contexte
 *            (actus, projets, mentions presse) pour chaque entreprise
 *  Étage 5 — Écriture Notion : une ligne par contact, source = Hunter
 *
 *  Variables d'environnement :
 *  - OPENAI_API_KEY
 *  - NOTION_API_KEY
 *  - HUNTER_API_KEY   (nouveau)
 *  - DASHBOARD_SECRET
 * ═══════════════════════════════════════════════════════════
 */

const INSTRUCTIONS_PAGE = "397075e127d281bdae39cd93b023f9aa";
const ENTREPRISES_DB    = "2fd075e127d2819f9fabd4820a69f7f8";
const PROSPECTS_DB      = "922854e54a5a441da7a00030dd6dfc3f";
const JOURNAL_DB        = "2d38dc00a27b4c17854b689c3607b847";

const HUNTER_BASE = "https://api.hunter.io/v2";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET uniquement" });

  const SECRET = process.env.DASHBOARD_SECRET;
  if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: "Clé invalide" });

  const { OPENAI_API_KEY, NOTION_API_KEY, HUNTER_API_KEY } = process.env;
  if (!OPENAI_API_KEY || !NOTION_API_KEY || !HUNTER_API_KEY) {
    return res.status(500).json({ error: "Clés API manquantes (OPENAI_API_KEY, NOTION_API_KEY, HUNTER_API_KEY)" });
  }

  const t0 = Date.now();
  const notionH = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // ─── Utilitaires ───
  const fmtId = (id) => {
    const clean = id.replace(/-/g, "");
    if (clean.length !== 32) return id;
    return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
  };

  async function getPageContent(pageId) {
    const r = await fetch(`https://api.notion.com/v1/blocks/${fmtId(pageId)}/children?page_size=100`, { headers: notionH });
    if (!r.ok) return "";
    const data = await r.json();
    return data.results.map(b => {
      const t = b[b.type];
      return t?.rich_text ? t.rich_text.map(r => r.plain_text).join("") : "";
    }).filter(Boolean).join("\n");
  }

  async function queryAll(dbId, body = {}) {
    let results = [], cursor;
    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${fmtId(dbId)}/query`, {
        method: "POST", headers: notionH,
        body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!r.ok) break;
      const data = await r.json();
      results = results.concat(data.results);
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  }

  const title = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];

  async function createProspect(c, source) {
    const props = {
      "Entreprise": { title: [{ text: { content: c.entreprise } }] },
      "Décision": { select: { name: "À valider" } },
      "Date trouvé": { date: { start: new Date().toISOString().slice(0, 10) } },
      "Transféré": { checkbox: false },
      "Source de collecte": { select: { name: source } },
    };
    if (c.secteur) props["Secteur"] = { select: { name: c.secteur } };
    if (c.siteWeb) props["Site web"] = { url: c.siteWeb };
    if (c.adresse) props["Adresse"] = { rich_text: rt(c.adresse) };
    if (c.notesEntreprise) props["Notes entreprise"] = { rich_text: rt(c.notesEntreprise) };
    if (c.nom) props["Contact nom"] = { rich_text: rt(c.nom) };
    if (c.prenom) props["Contact prénom"] = { rich_text: rt(c.prenom) };
    if (c.fonction) props["Contact fonction"] = { rich_text: rt(c.fonction) };
    if (c.email) props["Contact email"] = { email: c.email };
    if (c.telephone) props["Contact téléphone"] = { phone_number: c.telephone };
    if (c.linkedin) props["Contact LinkedIn"] = { url: c.linkedin };
    if (c.notesContact) props["Notes contact"] = { rich_text: rt(c.notesContact) };
    if (c.pertinence) props["Pertinence"] = { select: { name: c.pertinence } };
    if (c.justification) props["Justification"] = { rich_text: rt(c.justification) };
    if (c.sourceRecherche) props["Source recherche"] = { rich_text: rt(c.sourceRecherche) };

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: notionH,
      body: JSON.stringify({ parent: { database_id: fmtId(PROSPECTS_DB) }, properties: props }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("Notion createProspect error:", err);
      throw new Error(`Notion createProspect failed: ${r.status}`);
    }
  }

  async function logExecution(log) {
    const lr = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: notionH,
      body: JSON.stringify({
        parent: { database_id: fmtId(JOURNAL_DB) },
        properties: {
          "Résumé": { title: [{ text: { content: log.resume } }] },
          "Date exécution": { date: { start: new Date().toISOString() } },
          "Prospects trouvés": { number: log.trouves },
          "Prospects ajoutés": { number: log.ajoutes },
          "Doublons évités": { number: log.doublons },
          "Requêtes effectuées": { rich_text: rt(log.requetes) },
          "Détail complet": { rich_text: rt(log.detail) },
          "Statut": { select: { name: log.statut } },
          "Durée (secondes)": { number: log.duree },
        },
      }),
    });
    if (!lr.ok) console.error("Notion logExecution error:", await lr.text());
  }

  // ─── Étape 1 : Traducteur GPT-4o-mini (strict) ───
  const HUNTER_HEADCOUNT_VALID = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
  const HUNTER_DEPARTMENTS_VALID = ["executive", "finance", "human_resources", "information_technology", "marketing", "operations", "sales", "support"];
  const HUNTER_SENIORITY_VALID = ["junior", "senior", "executive"];

  async function traduireInstructions(instructions) {
    const prompt = `Tu convertis des instructions de prospection en francais en filtres pour l'API Hunter Discover.

Instructions de Laura :
${instructions}

Retourne UNIQUEMENT un JSON strict avec ces champs :
{
  "industries": [tableau de 1 a 5 slugs Hunter valides],
  "headcount": [tableau de paliers Hunter valides couvrant la fourchette demandee],
  "country": "FR",
  "departments": [tableau de 1 a 3 departments Hunter valides],
  "seniority": "senior" ou "executive",
  "max_entreprises": 10,
  "min_score_email": 70,
  "postes_cibles_fr": [liste des postes cibles en francais tels que Laura les a ecrits]
}

REGLES CRITIQUES :
- headcount doit etre un TABLEAU de valeurs EXACTES parmi : ${HUNTER_HEADCOUNT_VALID.join(", ")}. Pour "20 a 500 salaries", choisir ["11-50", "51-200", "201-500"]. Ne jamais inventer d'autre valeur.
- departments doit contenir uniquement des valeurs EXACTES parmi : ${HUNTER_DEPARTMENTS_VALID.join(", ")}. Pour "RH, formation, DG" : ["human_resources", "executive"].
- seniority doit etre "senior" ou "executive" (pas "senior_and_up").
- industries : choisir 1 a 5 slugs pertinents dans la taxonomie Hunter ci-dessous.

Taxonomie industries Hunter (choisir 1 a 5 valeurs exactes) : accounting, airlines_aviation, alternative_medicine, animation, apparel_fashion, architecture_planning, arts_crafts, automotive, aviation_aerospace, banking, biotechnology, broadcast_media, building_materials, business_supplies_equipment, capital_markets, chemicals, civic_social_organization, civil_engineering, commercial_real_estate, computer_hardware, computer_networking, computer_software, construction, consumer_electronics, consumer_goods, consumer_services, cosmetics, dairy, defense_space, design, e_learning, education_management, electrical_electronic_manufacturing, entertainment, environmental_services, events_services, executive_office, facilities_services, farming, financial_services, fine_art, fishery, food_beverages, food_production, fund_raising, furniture, gambling_casinos, glass_ceramics_concrete, government_administration, government_relations, graphic_design, health_wellness_fitness, higher_education, hospital_health_care, hospitality, human_resources, import_export, individual_family_services, industrial_automation, information_services, information_technology_and_services, insurance, international_affairs, international_trade_and_development, internet, investment_banking, investment_management, judiciary, law_enforcement, law_practice, legal_services, legislative_office, leisure_travel_tourism, libraries, logistics_and_supply_chain, luxury_goods_jewelry, machinery, management_consulting, maritime, market_research, marketing_and_advertising, mechanical_or_industrial_engineering, media_production, medical_devices, medical_practice, mental_health_care, military, mining_metals, motion_pictures_and_film, museums_and_institutions, music, nanotechnology, newspapers, non_profit_organization_management, oil_energy, online_media, outsourcing_offshoring, package_freight_delivery, packaging_and_containers, paper_and_forest_products, performing_arts, pharmaceuticals, philanthropy, photography, plastics, political_organization, primary_secondary_education, printing, professional_training_and_coaching, program_development, public_policy, public_relations_and_communications, public_safety, publishing, railroad_manufacture, ranching, real_estate, recreational_facilities_and_services, religious_institutions, renewables_and_environment, research, restaurants, retail, security_and_investigations, semiconductors, shipbuilding, sporting_goods, sports, staffing_and_recruiting, supermarkets, telecommunications, textiles, think_tanks, tobacco, translation_and_localization, transportation_trucking_railroad, utilities, venture_capital_and_private_equity, veterinary, warehousing, wholesale, wine_and_spirits, wireless, writing_and_editing.`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error("Erreur GPT-4o-mini traducteur : " + await r.text());
    const data = await r.json();
    const filtres = JSON.parse(data.choices[0].message.content);

    // Validation post-traduction : on nettoie ce que GPT aurait mal généré
    filtres.headcount = Array.isArray(filtres.headcount)
      ? filtres.headcount.filter(v => HUNTER_HEADCOUNT_VALID.includes(v))
      : [];
    filtres.departments = Array.isArray(filtres.departments)
      ? filtres.departments.filter(v => HUNTER_DEPARTMENTS_VALID.includes(v))
      : [];
    if (!HUNTER_SENIORITY_VALID.includes(filtres.seniority)) filtres.seniority = "senior";
    filtres.industries = Array.isArray(filtres.industries) ? filtres.industries : [];
    return filtres;
  }

  // ─── Étape 2 : Hunter Discover (une passe) ───
  // Convertit "government_administration" → "Government Administration" (format attendu par Hunter Discover)
  const industryToHunter = (slug) => slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  async function hunterDiscoverPasse(filtres, industriesSubset = null) {
    const body = {
      limit: Math.min(filtres.max_entreprises || 10, 25),
      country: filtres.country || "FR",
    };
    const industriesSlugs = industriesSubset || filtres.industries;
    if (industriesSlugs?.length) body.industry = industriesSlugs.map(industryToHunter);
    if (filtres.headcount?.length) body.headcount = filtres.headcount;
    if (filtres.departments?.length) body.department = filtres.departments;
    if (filtres.seniority) body.seniority = filtres.seniority;

    const r = await fetch(`${HUNTER_BASE}/discover?api_key=${HUNTER_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("Hunter Discover error:", errText);
      return { entreprises: [], erreur: errText.slice(0, 300), body };
    }
    const data = await r.json();
    const entreprises = (data.data?.companies || []).map(c => ({
      nom: c.organization,
      domaine: c.domain,
      secteur: c.industry,
      taille: c.headcount,
      ville: c.city,
      pays: c.country,
      description: c.description,
    }));
    return { entreprises, erreur: null, body };
  }

  // ─── Étape 2 multi-passes : d'abord toutes les industries, puis une par une ───
  async function hunterDiscoverMultiPasses(filtres) {
    const journal = [];
    const dejaVus = new Set();
    const toutes = [];

    // Passe 1 : toutes les industries ensemble
    const p1 = await hunterDiscoverPasse(filtres);
    journal.push(`Passe globale [${(filtres.industries || []).join(", ") || "sans industrie"}] → ${p1.entreprises.length} résultat(s)${p1.erreur ? " (erreur : " + p1.erreur + ")" : ""}`);
    for (const e of p1.entreprises) {
      if (!dejaVus.has(e.domaine)) { dejaVus.add(e.domaine); toutes.push(e); }
    }

    // Passe 2 : si on a besoin de plus, on interroge chaque industrie séparément
    if (toutes.length < (filtres.max_entreprises || 10) && (filtres.industries?.length || 0) > 1) {
      for (const ind of filtres.industries) {
        if (toutes.length >= (filtres.max_entreprises || 10)) break;
        const p = await hunterDiscoverPasse(filtres, [ind]);
        journal.push(`Passe [${ind}] → ${p.entreprises.length} résultat(s)${p.erreur ? " (erreur : " + p.erreur + ")" : ""}`);
        for (const e of p.entreprises) {
          if (!dejaVus.has(e.domaine)) { dejaVus.add(e.domaine); toutes.push(e); }
        }
      }
    }

    return { entreprises: toutes.slice(0, filtres.max_entreprises || 10), journal };
  }

  // ─── Étape 3 : Hunter Domain Search ───
  async function hunterDomainSearch(domaine, departments, seuil) {
    const params = new URLSearchParams({
      api_key: HUNTER_API_KEY,
      domain: domaine,
      limit: "10",
      type: "personal",
    });
    if (departments?.length) params.append("department", departments.join(","));

    const r = await fetch(`${HUNTER_BASE}/domain-search?${params}`);
    if (!r.ok) return { organisation: null, emails: [] };
    const data = await r.json();
    const emails = (data.data?.emails || [])
      .filter(e => e.confidence >= seuil)
      .map(e => ({
        email: e.value,
        prenom: e.first_name,
        nom: e.last_name,
        fonction: e.position,
        seniority: e.seniority,
        department: e.department,
        confidence: e.confidence,
        linkedin: e.linkedin,
        telephone: e.phone_number,
        sources: (e.sources || []).slice(0, 2).map(s => s.uri),
      }));
    return {
      organisation: data.data?.organization,
      emails,
    };
  }

  // Filtre les contacts pour ne garder que les postes cibles (RH + Formation + DG si PME/ETI)
  function selectionnerContacts(emails, taille, postesCibles) {
    const postesRegex = /(rh|resource humain|formation|talent|développement|competence|drh|gpec|learning|training)/i;
    const dgRegex = /(directeur|directrice|ceo|dg|général|generale|founder|fondateur|président|presidente)/i;

    const rh = emails.filter(e => postesRegex.test((e.fonction || "") + " " + (e.department || "")));
    const rhTop = rh.slice(0, 2);

    // DG uniquement si PME/ETI (jusqu'à 500 salariés)
    const taillesPME = ["1-10", "11-50", "51-200", "201-500"];
    let dg = [];
    if (taille && taillesPME.includes(taille)) {
      dg = emails.filter(e => dgRegex.test(e.fonction || "") || e.seniority === "executive").slice(0, 1);
    }

    // Dédoublonner par email
    const vus = new Set();
    return [...rhTop, ...dg].filter(c => {
      if (vus.has(c.email)) return false;
      vus.add(c.email);
      return true;
    });
  }

  // ─── Étape 4 : Enrichissement web via GPT-4o ───
  async function enrichirEntreprise(nomEntreprise) {
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          tools: [{ type: "web_search_preview" }],
          instructions: `Tu enrichis des fiches d'entreprise pour de la prospection commerciale en formation professionnelle. Sois factuel et concis (3 phrases maximum). Retourne du texte simple, sans markdown.`,
          input: `Cherche les actualités récentes de "${nomEntreprise}" : projets de transformation, offres d'emploi RH/formation récentes, mentions dans la presse, appels d'offres. Résume en 2-3 phrases ce qui peut être utile pour une approche commerciale en formation professionnelle. Si rien de pertinent, retourne "Pas d'actualité récente identifiée".`,
        }),
      });
      if (!r.ok) return "";
      const data = await r.json();
      let text = "";
      for (const item of (data.output || [])) {
        if (item.type === "message" && item.content) {
          for (const c of item.content) if (c.type === "output_text") text += c.text;
        }
      }
      return text.trim().slice(0, 500);
    } catch {
      return "";
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Exécution principale
  // ═══════════════════════════════════════════════════════

  try {
    // 1. Instructions
    const instructions = await getPageContent(INSTRUCTIONS_PAGE);
    if (!instructions || instructions.length < 50) {
      return res.status(400).json({ error: "Instructions trop courtes ou page introuvable" });
    }

    // 2. Anti-doublon
    const [existing, pending] = await Promise.all([
      queryAll(ENTREPRISES_DB),
      queryAll(PROSPECTS_DB),
    ]);
    const existingNames = [
      ...existing.map(e => title(e, "Nom").toLowerCase().trim()),
      ...pending.map(e => title(e, "Entreprise").toLowerCase().trim()),
    ].filter(Boolean);

    // 3. Traduire les instructions en filtres Hunter
    const filtres = await traduireInstructions(instructions);
    const seuil = filtres.min_score_email || 70;
    const maxEntreprises = filtres.max_entreprises || 10;

    // 4. Hunter Discover multi-passes
    const { entreprises, journal: journalDiscover } = await hunterDiscoverMultiPasses(filtres);

    if (!entreprises.length) {
      await logExecution({
        resume: "Hunter Discover 0 résultat",
        trouves: 0, ajoutes: 0, doublons: 0,
        requetes: JSON.stringify(filtres).slice(0, 500),
        detail: journalDiscover.join("\n") + "\n\nAjustez les instructions (secteurs plus larges, taille différente) et relancez.",
        statut: "Partiel",
        duree: Math.round((Date.now() - t0) / 1000),
      });
      return res.status(200).json({
        ok: true,
        message: "Aucune entreprise trouvée",
        filtres,
        journal_discover: journalDiscover,
      });
    }

    // 5. Pour chaque entreprise : Domain Search + sélection contacts + enrichissement + écriture
    let ajoutes = 0, doublons = 0, entreprisesAvecContact = 0, tousContacts = 0;
    const journalContacts = [];

    for (const ent of entreprises) {
      const nomLower = (ent.nom || "").toLowerCase().trim();
      if (existingNames.some(n => n.includes(nomLower) || nomLower.includes(n))) {
        doublons++;
        journalContacts.push(`${ent.nom} → doublon existant`);
        continue;
      }

      const search = await hunterDomainSearch(ent.domaine, filtres.departments, seuil);
      const contacts = selectionnerContacts(search.emails, ent.taille, filtres.postes_cibles_fr);
      tousContacts += contacts.length;

      // Journal transparent : combien d'emails Hunter connaît, combien passent nos filtres
      journalContacts.push(`${ent.nom} (${ent.domaine}) → ${search.emails.length} email(s) Hunter avec score ≥${seuil}, ${contacts.length} retenu(s) après filtre poste`);

      if (!contacts.length) continue;

      entreprisesAvecContact++;
      const notesEnt = await enrichirEntreprise(ent.nom);

      for (const c of contacts) {
        await createProspect({
          entreprise: ent.nom,
          secteur: null,
          siteWeb: `https://${ent.domaine}`,
          adresse: ent.ville || null,
          notesEntreprise: `${ent.description || ""}${ent.taille ? ` · ${ent.taille} salariés` : ""}\n\n${notesEnt}`.trim(),
          nom: c.nom,
          prenom: c.prenom,
          fonction: c.fonction,
          email: c.email,
          telephone: c.telephone,
          linkedin: c.linkedin,
          notesContact: `Score Hunter : ${c.confidence}/100 · Séniorité : ${c.seniority || "?"} · Département : ${c.department || "?"}`,
          pertinence: c.confidence >= 80 ? "Haute" : (c.confidence >= 60 ? "Moyenne" : "Basse"),
          justification: `Correspond à la cible ${filtres.postes_cibles_fr?.join(" / ") || "définie"}. Extraction Hunter Domain Search.`,
          sourceRecherche: (c.sources || [])[0] || null,
        }, "Hunter Discover");
        ajoutes++;
      }
      existingNames.push(nomLower);
    }

    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: `${ajoutes} contact(s) via Hunter Discover sur ${entreprisesAvecContact}/${entreprises.length} entreprise(s)`,
      trouves: tousContacts, ajoutes, doublons,
      requetes: `Filtres : ${JSON.stringify(filtres).slice(0, 400)}\n\nMulti-passes Discover :\n${journalDiscover.join("\n")}`,
      detail: journalContacts.join("\n"),
      statut: ajoutes > 0 ? "Succès" : "Partiel",
      duree,
    });

    return res.status(200).json({
      ok: true,
      duree: `${duree}s`,
      source: "Hunter Discover",
      entreprises_decouvertes: entreprises.length,
      entreprises_avec_contact: entreprisesAvecContact,
      contacts_ajoutes: ajoutes,
      doublons_evites: doublons,
      filtres_utilises: filtres,
      journal_discover: journalDiscover,
      journal_contacts: journalContacts,
    });

  } catch (e) {
    console.error("Agent Hunter error:", e);
    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: `Erreur Hunter : ${e.message?.slice(0, 100)}`,
      trouves: 0, ajoutes: 0, doublons: 0, requetes: "",
      detail: e.stack?.slice(0, 1800) || e.message,
      statut: "Erreur", duree,
    }).catch(() => {});
    return res.status(500).json({ error: e.message, stack: e.stack?.split("\n").slice(0, 5) });
  }
}
