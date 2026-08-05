/**
 * ═══════════════════════════════════════════════════════════
 *  Agent Commercial Autonome v3 — Laura Ballo Coaching
 *  Endpoint : GET /api/agent-prospection?key=XXXX
 *
 *  CHANGEMENTS v2 → v3
 *  1. Sourcing déterministe : la liste d'entreprises vient de
 *     l'API Recherche d'Entreprises (INSEE/Etalab), pas du LLM.
 *     Le LLM ne peut plus inventer une entreprise.
 *  2. Aucun quota dans le prompt (cause n°1 des données inventées).
 *  3. Vérification tri-état : OK / KO / INACCESSIBLE.
 *     "Je n'ai pas pu vérifier" ≠ "c'est faux".
 *  4. LinkedIn vérifié comme email et téléphone (trou de la v2).
 *  5. Cohérence domaine email ↔ domaine du site officiel.
 *  6. Dédup par domaine + SIRET + nom normalisé (plus de sous-chaîne).
 *  7. Liste secteurs alignée sur Notion, secteur déduit du code NAF.
 *
 *  Variables d'environnement :
 *  - OPENAI_API_KEY, NOTION_API_KEY, DASHBOARD_SECRET
 * ═══════════════════════════════════════════════════════════
 */

const INSTRUCTIONS_PAGE = "397075e127d281b18b11c08b5b58945a";
const ENTREPRISES_DB    = "2fd075e127d2819f9fabd4820a69f7f8";
const PROSPECTS_DB      = "922854e54a5a441da7a00030dd6dfc3f";
const JOURNAL_DB        = "2d38dc00a27b4c17854b689c3607b847";

const API_ENTREPRISES = "https://recherche-entreprises.api.gouv.fr/search";

// Tranches INSEE correspondant à 20–500 salariés
const TRANCHES = "12,21,22,31,32";

// Cible : NAF × départements. Modifier ici pour changer le ciblage.
const CIBLES_NAF = [
  "87.10A", "87.30A", "87.20A", "88.10A", "88.10C", "88.99B",
  "84.11Z", "94.99Z", "70.22Z", "62.02A",
];
const DEPARTEMENTS = [
  "75","77","78","91","92","93","94","95",                      // Île-de-France
  "08","21","25","39","51","54","57","67","68","70","88","90",  // Est
  "06","13","30","34","83","84",                                // Sud
  "01","38","42","69",                                          // Lyonnaise
];

// DOIT correspondre exactement aux options de la base Notion.
const SECTEURS = [
  "Santé & Bien-être", "Administration publique", "Industrie",
  "Conseil & Services", "Tech & Digital", "Culture & Médias",
  "Commerce & Distribution", "Éducation & Formation", "Autre",
];

// NAF → secteur Notion : déterministe, plus de choix laissé au LLM
const NAF_SECTEUR = {
  "87.10A": "Santé & Bien-être", "87.30A": "Santé & Bien-être",
  "87.20A": "Santé & Bien-être", "88.10A": "Santé & Bien-être",
  "88.10C": "Santé & Bien-être", "88.99B": "Santé & Bien-être",
  "84.11Z": "Administration publique", "94.99Z": "Autre",
  "70.22Z": "Conseil & Services", "62.02A": "Tech & Digital",
};

const NB_CANDIDATS  = 12; // entreprises soumises au LLM par exécution
const MAX_PROSPECTS = 15; // plafond dur — jamais un objectif

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET uniquement" });

  const SECRET = process.env.DASHBOARD_SECRET;
  // Header Authorization accepté en priorité (le ?key= finit dans les logs)
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.key;
  if (!SECRET || provided !== SECRET) return res.status(401).json({ error: "Clé invalide" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!OPENAI_API_KEY || !NOTION_API_KEY) return res.status(500).json({ error: "Clés API manquantes" });

  const t0 = Date.now();
  const notionH = {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // ─────────────── Utilitaires ───────────────

  const fmtId = (id) => {
    const c = id.replace(/-/g, "");
    return c.length !== 32 ? id
      : `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
  };

  /** Domaine racine, sans protocole ni www. Clé de dédup et de cohérence. */
  const normDomain = (u) => {
    if (!u) return null;
    try {
      const h = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
      return h.replace(/^www\./, "");
    } catch { return null; }
  };

  /** Nom normalisé : sans accents, sans forme juridique, sans ponctuation. */
  const normName = (s) => (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(sarl|sas|sasu|sa|eurl|snc|scop|scic|asso|association|groupe|ste|societe|etablissement|ets)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();

  const withTimeout = async (url, opts = {}, ms = 8000) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LauraBalloBot/1.0)", ...(opts.headers || {}) },
      });
    } finally { clearTimeout(to); }
  };

  // ─────────────── Notion ───────────────

  async function getPageContent(pageId) {
    const r = await withTimeout(`https://api.notion.com/v1/blocks/${fmtId(pageId)}/children?page_size=100`, { headers: notionH });
    if (!r.ok) return "";
    const data = await r.json();
    return data.results.map(b => {
      const t = b[b.type];
      return t?.rich_text ? t.rich_text.map(x => x.plain_text).join("") : "";
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

  const title    = (p, n) => p?.properties?.[n]?.title?.[0]?.plain_text || "";
  const propUrl  = (p, n) => p?.properties?.[n]?.url || "";
  const propText = (p, n) => (p?.properties?.[n]?.rich_text || []).map(t => t.plain_text).join("");
  const rt = (s) => s ? [{ text: { content: String(s).slice(0, 1900) } }] : [];

  async function createProspect(p) {
    const props = {
      "Entreprise": { title: [{ text: { content: p.entreprise } }] },
      "Décision":   { select: { name: "À valider" } },
      "Date trouvé": { date: { start: new Date().toISOString().slice(0, 10) } },
      "Transféré":  { checkbox: false },
      "Source de collecte": { select: { name: "API Entreprises" } },
    };
    const set = (key, val, build) => { if (val) props[key] = build(val); };

    set("Secteur",            p.secteur,          v => ({ select: { name: v } }));
    set("Site web",           p.siteWeb,          v => ({ url: v }));
    set("Domaine",            p.domaine,          v => ({ rich_text: rt(v) }));
    set("SIRET",              p.siret,            v => ({ rich_text: rt(v) }));
    set("Code NAF",           p.codeNaf,          v => ({ rich_text: rt(v) }));
    set("Tranche effectif",   p.trancheEffectif,  v => ({ rich_text: rt(v) }));
    set("Département",        p.departement,      v => ({ rich_text: rt(v) }));
    set("Adresse",            p.adresse,          v => ({ rich_text: rt(v) }));
    set("Notes entreprise",   p.notesEntreprise,  v => ({ rich_text: rt(v) }));
    set("Contact nom",        p.contactNom,       v => ({ rich_text: rt(v) }));
    set("Contact prénom",     p.contactPrenom,    v => ({ rich_text: rt(v) }));
    set("Contact fonction",   p.contactFonction,  v => ({ rich_text: rt(v) }));
    set("Contact email",      p.contactEmail,     v => ({ email: v }));
    set("Contact téléphone",  p.contactTel,       v => ({ phone_number: v }));
    set("Contact LinkedIn",   p.contactLinkedin,  v => ({ url: v }));
    set("Notes contact",      p.notesContact,     v => ({ rich_text: rt(v) }));
    set("Pertinence",         p.pertinence,       v => ({ select: { name: v } }));
    set("Justification",      p.justification,    v => ({ rich_text: rt(v) }));
    set("Source recherche",   p.sourceRecherche,  v => ({ rich_text: rt(v) }));
    set("URL source contact", p.urlSourceContact, v => ({ url: v }));
    set("Email vérifié",      p.emailVerifie,     v => ({ select: { name: v } }));

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: notionH,
      body: JSON.stringify({ parent: { database_id: fmtId(PROSPECTS_DB) }, properties: props }),
    });
    if (!r.ok) throw new Error(`Notion createProspect ${r.status} — ${(await r.text()).slice(0, 300)}`);
  }

  async function logExecution(log) {
    await fetch("https://api.notion.com/v1/pages", {
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
    }).catch(e => console.error("logExecution:", e));
  }

  // ─────────────── Étape 1 : sourcing officiel ───────────────

  /**
   * Récupère des entreprises RÉELLES depuis l'API publique de l'État.
   * Aucune donnée n'est produite par un LLM à cette étape.
   */
  async function sourceEntreprises(naf, dept) {
    const url = `${API_ENTREPRISES}?activite_principale=${encodeURIComponent(naf)}`
      + `&departement=${dept}`
      + `&tranche_effectif_salarie=${TRANCHES}`
      + `&etat_administratif=A&per_page=25&page=1`;

    const r = await withTimeout(url, {}, 10000);
    if (!r.ok) throw new Error(`API Entreprises ${r.status} sur ${naf}/${dept}`);
    const data = await r.json();

    return (data.results || []).map(e => {
      const siege = e.siege || {};
      return {
        nom: e.nom_complet || e.nom_raison_sociale || "",
        siren: e.siren || null,
        siret: siege.siret || e.siret || null,
        codeNaf: e.activite_principale || siege.activite_principale || naf,
        trancheEffectif: e.tranche_effectif_salarie || siege.tranche_effectif_salarie || null,
        departement: siege.departement || dept,
        commune: siege.libelle_commune || siege.commune || "",
        adresse: siege.adresse || siege.geo_adresse || "",
      };
    }).filter(e => e.nom);
  }

  // ─────────────── Étape 4 : vérifications mécaniques ───────────────

  /** Décode les emails protégés par Cloudflare (data-cfemail). */
  const decodeCfEmail = (hex) => {
    try {
      const k = parseInt(hex.slice(0, 2), 16);
      let out = "";
      for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
      return out.toLowerCase();
    } catch { return ""; }
  };

  /**
   * Vérification TRI-ÉTAT — la correction centrale de la v2.
   *   "ok"           : la donnée est présente sur la page citée
   *   "ko"           : la page est lisible et la donnée n'y est PAS → rejet
   *   "inaccessible" : page injoignable ou rendue en JS → on garde, on signale
   * En v2, "ko" et "inaccessible" produisaient le même résultat (null),
   * ce qui supprimait des données pourtant valides.
   */
  async function verifyOnPage(url, needle, kind = "text") {
    if (!url || !/^https?:\/\//i.test(url)) return "ko";
    let html;
    try {
      const r = await withTimeout(url, { redirect: "follow" }, 8000);
      if (!r.ok) return "inaccessible";
      html = (await r.text()).toLowerCase();
    } catch { return "inaccessible"; }

    // Page sans contenu textuel utile = rendue côté client → on ne peut pas conclure
    const texte = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    if (texte.replace(/\s+/g, "").length < 400) return "inaccessible";

    const target = String(needle).toLowerCase();

    if (kind === "email") {
      if (html.includes(target)) return "ok";
      // Protection Cloudflare
      for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/g)) {
        if (decodeCfEmail(m[1]) === target) return "ok";
      }
      // Obfuscations courantes : [at] (at) &#64; espaces
      const deobf = html
        .replace(/\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*|&#64;|&commat;/g, "@")
        .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*/g, ".")
        .replace(/\s+@\s+/g, "@");
      return deobf.includes(target) ? "ok" : "ko";
    }

    if (kind === "phone") {
      // Comparaison sur les 9 derniers chiffres, mais uniquement à l'intérieur
      // de séquences ressemblant à un numéro. La v2 aplatissait toute la page
      // en chiffres, ce qui produisait des faux positifs (dates, identifiants).
      const digits = target.replace(/\D/g, "");
      if (digits.length < 9) return "ko";
      const cible = digits.slice(-9);
      const candidats = texte.match(/[\d][\d\s.\-()+]{7,20}[\d]/g) || [];
      return candidats.some(c => c.replace(/\D/g, "").endsWith(cible)) ? "ok" : "ko";
    }

    return html.includes(target) ? "ok" : "ko";
  }

  /** Le site officiel répond-il ? */
  async function siteRepond(url) {
    try {
      const r = await withTimeout(url, { method: "GET", redirect: "follow" }, 8000);
      return r.ok;
    } catch { return false; }
  }

  // ─────────────── Exécution ───────────────

  const rejets = [];
  const noteRejet = (entreprise, motif) => rejets.push(`${entreprise} — ${motif}`);

  try {
    const instructions = await getPageContent(INSTRUCTIONS_PAGE);
    if (!instructions || instructions.length < 50) {
      return res.status(400).json({ error: "Instructions trop courtes ou page introuvable" });
    }

    // Base de dédup : domaines + noms normalisés + SIRET déjà connus.
    // La v2 comparait par sous-chaîne dans les deux sens, ce qui écartait
    // à tort toute entreprise contenant un nom court déjà en base.
    const [existing, pending] = await Promise.all([
      queryAll(ENTREPRISES_DB),
      queryAll(PROSPECTS_DB),
    ]);
    const knownDomains = new Set();
    const knownNames   = new Set();
    const knownSirets  = new Set();
    for (const e of existing) {
      const d = normDomain(propUrl(e, "Site web"));      if (d) knownDomains.add(d);
      const n = normName(title(e, "Nom"));               if (n) knownNames.add(n);
      const s = propText(e, "SIRET").replace(/\D/g, ""); if (s) knownSirets.add(s);
    }
    for (const e of pending) {
      const d = normDomain(propUrl(e, "Site web"));      if (d) knownDomains.add(d);
      const n = normName(title(e, "Entreprise"));        if (n) knownNames.add(n);
      const s = propText(e, "SIRET").replace(/\D/g, ""); if (s) knownSirets.add(s);
    }

    // Rotation NAF × département : varie d'une exécution à l'autre
    const seed = Math.floor(Date.now() / 86400000);
    const combos = [];
    for (let i = 0; i < 6; i++) {
      combos.push({
        naf:  CIBLES_NAF[(seed + i) % CIBLES_NAF.length],
        dept: DEPARTEMENTS[(seed * 3 + i * 7) % DEPARTEMENTS.length],
      });
    }

    // Étape 1 — liste d'entreprises réelles
    const candidats = [];
    const requetes = [];
    for (const { naf, dept } of combos) {
      if (candidats.length >= NB_CANDIDATS) break;
      requetes.push(`${naf}/${dept}`);
      try {
        const lot = await sourceEntreprises(naf, dept);
        for (const e of lot) {
          if (candidats.length >= NB_CANDIDATS) break;
          const nn = normName(e.nom);
          const ss = (e.siret || "").replace(/\D/g, "");
          if (knownNames.has(nn) || (ss && knownSirets.has(ss))) continue;
          knownNames.add(nn);
          candidats.push(e);
        }
      } catch (err) {
        console.error("sourceEntreprises:", err.message);
      }
    }

    if (!candidats.length) {
      const duree = Math.round((Date.now() - t0) / 1000);
      await logExecution({
        resume: "Aucune entreprise nouvelle depuis l'API Entreprises",
        trouves: 0, ajoutes: 0, doublons: 0,
        requetes: requetes.join(" | "),
        detail: "L'API n'a renvoyé que des entreprises déjà connues, ou était injoignable.",
        statut: "Partiel", duree,
      });
      return res.status(200).json({ ok: true, en_attente_validation: 0, message: "Aucune entreprise nouvelle" });
    }

    // Étapes 2-3 — le LLM enrichit une liste FERMÉE. Il ne choisit rien.
    const systemPrompt = `Tu es un assistant de recherche pour Laura Ballo Coaching, organisme de formation certifié Qualiopi.

On te donne une liste d'entreprises RÉELLES, vérifiées auprès du registre officiel des entreprises françaises. Ta seule tâche : pour chacune, retrouver son site web officiel et un contact professionnel publié dessus.

TU NE CHOISIS PAS LES ENTREPRISES. Tu n'en ajoutes aucune. Tu n'en inventes aucune. Tu traites exactement celles de la liste fournie, ni plus ni moins.

INSTRUCTIONS MÉTIER DE LAURA :
${instructions}

RÈGLES ABSOLUES :
1. Tu es évalué sur l'exactitude, jamais sur le volume. Retourner une liste vide est une réponse parfaitement acceptable.
2. Chaque donnée de contact doit avoir été LUE par toi sur une page web pendant cette session. Aucune déduction, aucun schéma d'adresse ("prenom.nom@..."), aucune connaissance générale.
3. "url_source_contact" doit être l'URL EXACTE de la page où la donnée est visible. Chaque email, téléphone et URL LinkedIn sera automatiquement revérifié sur cette page après ta réponse. Une donnée absente de la page citée fait rejeter le prospect entier.
4. Le domaine de l'email doit correspondre au domaine du site officiel de l'entreprise. Un email sur un autre domaine sera rejeté.
5. N'accepte jamais un annuaire (societe.com, pagesjaunes, verif.com) comme site officiel.
6. Ne scrape jamais LinkedIn. Tu peux relever une URL LinkedIn si elle est affichée sur le site officiel.
7. Si une donnée est introuvable, mets null (le mot-clé JSON). Si tu ne trouves ni site officiel ni contact pour une entreprise, ne la fais pas figurer dans ta réponse.

FORMAT (JSON strict, sans markdown) :
{
  "recherches_effectuees": [],
  "prospects": [
    {
      "siret": "le SIRET fourni dans la liste, recopié tel quel",
      "entreprise": "la dénomination fournie, recopiée telle quelle",
      "site_web": null,
      "contact_nom": null,
      "contact_prenom": null,
      "contact_fonction": null,
      "contact_email": null,
      "contact_telephone": null,
      "contact_linkedin": null,
      "notes_entreprise": null,
      "notes_contact": null,
      "url_source_contact": null,
      "justification": null
    }
  ],
  "resume": null
}

Ne renseigne ni "secteur" ni "pertinence" : ils sont calculés automatiquement.`;

    const listeCandidats = candidats.map((e, i) =>
      `${i + 1}. ${e.nom} — SIRET ${e.siret} — NAF ${e.codeNaf} — ${e.commune} (${e.departement})`
    ).join("\n");

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        tools: [{ type: "web_search_preview" }],
        instructions: systemPrompt,
        input: `Nous sommes le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}.

Voici les entreprises à traiter :
${listeCandidats}

Pour chacune : trouve le site officiel, puis un contact publié dessus (page Contact, Équipe, Mentions légales, Recrutement). Retourne le JSON demandé.`,
      }),
    });

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      await logExecution({
        resume: "Erreur API OpenAI", trouves: 0, ajoutes: 0, doublons: 0,
        requetes: requetes.join(" | "), detail: err.slice(0, 1800),
        statut: "Erreur", duree: Math.round((Date.now() - t0) / 1000),
      });
      return res.status(502).json({ error: "Erreur API OpenAI" });
    }

    const openaiData = await openaiResponse.json();
    let jsonText = "";
    for (const item of openaiData.output || []) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) if (c.type === "output_text") jsonText += c.text;
      }
    }
    jsonText = jsonText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const repair = (s) => s
      .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
    const extractBalanced = (s) => {
      const start = s.indexOf("{");
      if (start === -1) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === "{") depth++;
        if (c === "}" && --depth === 0) return s.slice(start, i + 1);
      }
      return null;
    };

    let result = tryParse(jsonText) || tryParse(repair(jsonText));
    if (!result) {
      const bal = extractBalanced(jsonText);
      if (bal) result = tryParse(bal) || tryParse(repair(bal));
    }
    if (!result) throw new Error("Parsing impossible : " + jsonText.slice(0, 400));

    // ─── Étape 4 : validation mécanique, puis écriture ───

    const bySiret = new Map(candidats.map(c => [(c.siret || "").replace(/\D/g, ""), c]));
    const proposes = result.prospects || [];
    let ajoutes = 0, doublons = 0, rejetes = 0, nonVerifies = 0;

    for (const p of proposes) {
      if (ajoutes >= MAX_PROSPECTS) break;

      // 4.1 — le prospect doit correspondre à une entreprise de la liste officielle
      const siret = String(p.siret || "").replace(/\D/g, "");
      const officiel = bySiret.get(siret);
      if (!officiel) {
        rejetes++; noteRejet(p.entreprise || "?", "hors liste officielle (SIRET inconnu)");
        continue;
      }

      // 4.2 — site officiel joignable
      const site = /^https?:\/\//i.test(p.site_web || "") ? p.site_web.trim() : null;
      if (!site) { rejetes++; noteRejet(officiel.nom, "aucun site officiel"); continue; }
      const domaine = normDomain(site);
      if (!domaine) { rejetes++; noteRejet(officiel.nom, "URL de site invalide"); continue; }
      if (knownDomains.has(domaine)) { doublons++; continue; }
      if (!(await siteRepond(site))) { rejetes++; noteRejet(officiel.nom, "site injoignable"); continue; }

      // 4.3 — URL source obligatoire
      const src = /^https?:\/\//i.test(p.url_source_contact || "") ? p.url_source_contact.trim() : null;
      if (!src) { rejetes++; noteRejet(officiel.nom, "url_source_contact absente"); continue; }

      // 4.4 — cohérence du domaine de l'email (attrape les emails déduits)
      let email = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(p.contact_email || "")
        ? p.contact_email.trim().toLowerCase() : null;
      if (email) {
        const dEmail = email.split("@")[1];
        if (dEmail !== domaine && !dEmail.endsWith(`.${domaine}`) && !domaine.endsWith(`.${dEmail}`)) {
          noteRejet(officiel.nom, `domaine email incohérent (${dEmail} ≠ ${domaine})`);
          email = null;
        }
      }

      // 4.5 — vérification tri-état sur la page citée
      let statutEmail = "Non vérifié";
      if (email) {
        const v = await verifyOnPage(src, email, "email");
        if (v === "ko") { email = null; noteRejet(officiel.nom, "email absent de la page citée"); }
        else if (v === "ok") statutEmail = "Vérifié";
        else { statutEmail = "Non vérifiable"; nonVerifies++; }
      }

      let tel = (p.contact_telephone || "").trim() || null;
      if (tel && (await verifyOnPage(src, tel, "phone")) === "ko") tel = null;

      // LinkedIn désormais vérifié lui aussi — c'était LE trou de la v2 :
      // un prospect entièrement inventé pouvait survivre par ce seul champ.
      let linkedin = /linkedin\.com\/(in|company)\//i.test(p.contact_linkedin || "")
        ? p.contact_linkedin.trim() : null;
      if (linkedin && (await verifyOnPage(src, linkedin)) === "ko") linkedin = null;

      // 4.6 — au moins un moyen de contact survivant
      if (!email && !tel && !linkedin) { rejetes++; noteRejet(officiel.nom, "aucun contact vérifié"); continue; }

      // 4.7 — pertinence calculée, plus déclarée par le LLM
      const fonction = (p.contact_fonction || "").toLowerCase();
      const cible = /formation|rh|ressources humaines|comp[ée]tence|qvt/.test(fonction);
      const nomme = Boolean(p.contact_nom);
      let pertinence = "Basse";
      if (cible && nomme && email && statutEmail === "Vérifié") pertinence = "Haute";
      else if (cible || (nomme && email)) pertinence = "Moyenne";

      const secteur = NAF_SECTEUR[officiel.codeNaf] || "Autre";

      await createProspect({
        entreprise: officiel.nom,
        siret: officiel.siret,
        codeNaf: officiel.codeNaf,
        trancheEffectif: officiel.trancheEffectif,
        departement: officiel.departement,
        adresse: officiel.adresse || officiel.commune,
        secteur: SECTEURS.includes(secteur) ? secteur : "Autre",
        siteWeb: site,
        domaine,
        notesEntreprise: p.notes_entreprise || null,
        contactNom: p.contact_nom || null,
        contactPrenom: p.contact_prenom || null,
        contactFonction: p.contact_fonction || null,
        contactEmail: email,
        contactTel: tel,
        contactLinkedin: linkedin,
        notesContact: p.notes_contact || null,
        pertinence,
        justification: p.justification || null,
        sourceRecherche: src,
        urlSourceContact: src,
        emailVerifie: statutEmail,
      });

      knownDomains.add(domaine);
      ajoutes++;
    }

    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: ajoutes ? `${ajoutes} prospect(s) à valider` : "Aucun prospect n'a passé les contrôles",
      trouves: proposes.length, ajoutes, doublons,
      requetes: requetes.join(" | "),
      detail: `${candidats.length} entreprise(s) officielle(s) soumise(s) · ${proposes.length} enrichie(s) par le LLM · ${rejetes} rejetée(s) · ${nonVerifies} email(s) non vérifiable(s)\n\nREJETS :\n${rejets.join("\n") || "aucun"}`,
      statut: ajoutes > 0 ? "Succès" : (proposes.length > 0 ? "Partiel" : "Erreur"),
      duree,
    });

    return res.status(200).json({
      ok: true, duree: `${duree}s`,
      entreprises_officielles: candidats.length,
      prospects_proposes: proposes.length,
      en_attente_validation: ajoutes,
      doublons_evites: doublons,
      rejetes,
      emails_non_verifiables: nonVerifies,
      motifs_rejet: rejets,
    });

  } catch (e) {
    console.error("Agent error:", e);
    const duree = Math.round((Date.now() - t0) / 1000);
    await logExecution({
      resume: `Erreur : ${e.message?.slice(0, 100)}`,
      trouves: 0, ajoutes: 0, doublons: 0, requetes: "",
      detail: e.stack?.slice(0, 1800) || e.message, statut: "Erreur", duree,
    }).catch(() => {});
    return res.status(500).json({ error: e.message });
  }
}
