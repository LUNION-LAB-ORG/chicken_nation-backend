import {
  AvisSolution,
  IncidentGeste,
  IncidentGravite,
  IncidentOrigine,
  IncidentPole,
  IncidentRecontact,
  IncidentStatut,
  IncidentSuiviType,
  UserRole,
  UserType,
} from '@prisma/client';
import {
  Acteur,
  LigneStat,
  MESSAGE_ACTION,
  MESSAGE_BON_INTERDIT,
  MESSAGE_BON_MONTANT,
  MESSAGE_CAUSE,
  MESSAGE_DESCRIPTION,
  MESSAGE_DESCRIPTION_LONGUE,
  MESSAGE_GESTE,
  MESSAGE_PERIODE,
  MESSAGE_REACTION,
  MESSAGE_RECONTACT,
  REGLAGES_DEFAUT,
  agregerStatistiques,
  bonSuggere,
  bornesPeriode,
  celluleCsv,
  codeIncident,
  comparerATraiter,
  critereRecherche,
  droitsIncident,
  echeance,
  enRetard,
  expirationBon,
  extrait,
  lireReglages,
  montantLisible,
  montantsBon,
  nomClient,
  numeroSuivant,
  origineRetenue,
  periodeStats,
  peutLire,
  peutSignaler,
  peutTraiterIncident,
  peutVoirIncident,
  porteeRestaurant,
  prefixeCode,
  saisirDescription,
  saisirNote,
  solutionAvis,
  texteSmsBon,
  texteSuivi,
  verifierCloture,
  verifierResolution,
  versCsv,
} from './incident.rules';

const R1 = 'resto-1';
const R2 = 'resto-2';

const acteur = (role: UserRole, restaurant: string | null = null): Acteur => ({
  id: `u-${role}-${restaurant ?? 'siege'}`,
  role,
  type: restaurant ? UserType.RESTAURANT : UserType.BACKOFFICE,
  restaurant_id: restaurant,
});

const admin = acteur(UserRole.ADMIN);
const callCenter = acteur(UserRole.CALL_CENTER);
const marketing = acteur(UserRole.MARKETING);
const livraisonOps = acteur(UserRole.LIVRAISON_OPS);
const comptable = acteur(UserRole.COMPTABLE);
const manager = acteur(UserRole.MANAGER, R1);
const assistant = acteur(UserRole.ASSISTANT_MANAGER, R1);
const caissier = acteur(UserRole.CAISSIER, R1);
const cuisine = acteur(UserRole.CUISINE, R1);

const incident = (
  p: Partial<{ restaurant_id: string; pole: IncidentPole; statut: IncidentStatut; agent_id: string | null }> = {},
) => ({
  restaurant_id: R1,
  pole: IncidentPole.RESTAURANT,
  statut: IncidentStatut.OUVERT,
  agent_id: null,
  ...p,
});

describe('incidents : qui voit, signale, traite', () => {
  it('le siège voit tout le réseau, un point de vente seulement son restaurant', () => {
    for (const u of [admin, callCenter, marketing, livraisonOps]) {
      expect(peutVoirIncident(u, { restaurant_id: R1 })).toBe(true);
      expect(peutVoirIncident(u, { restaurant_id: R2 })).toBe(true);
    }
    for (const u of [manager, assistant, caissier]) {
      expect(peutVoirIncident(u, { restaurant_id: R1 })).toBe(true);
      expect(peutVoirIncident(u, { restaurant_id: R2 })).toBe(false);
    }
  });

  it('le comptable et la cuisine ne lisent pas les incidents', () => {
    expect(peutLire(comptable)).toBe(false);
    expect(peutLire(cuisine)).toBe(false);
    expect(peutVoirIncident(cuisine, { restaurant_id: R1 })).toBe(false);
  });

  it('un compte de restaurant sans restaurant rattaché ne voit rien', () => {
    const orphelin: Acteur = { ...manager, restaurant_id: null };
    expect(peutVoirIncident(orphelin, { restaurant_id: R1 })).toBe(false);
    expect(porteeRestaurant(orphelin, R1)).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('la portée ignore le filtre pour un point de vente et le suit pour le siège', () => {
    expect(porteeRestaurant(manager, R2)).toBe(R1);
    expect(porteeRestaurant(callCenter, R2)).toBe(R2);
    expect(porteeRestaurant(callCenter)).toBeUndefined();
    expect(porteeRestaurant(callCenter, '')).toBeUndefined();
  });

  it('signalent : administrateur, call center, manager, assistant, caissier, sur leurs commandes', () => {
    expect(peutSignaler(admin, R2)).toBe(true);
    expect(peutSignaler(callCenter, R2)).toBe(true);
    expect(peutSignaler(manager, R1)).toBe(true);
    expect(peutSignaler(caissier, R1)).toBe(true);
    expect(peutSignaler(caissier, R2)).toBe(false);
    expect(peutSignaler(marketing, R1)).toBe(false);
    expect(peutSignaler(livraisonOps, R1)).toBe(false);
  });

  it('traitent : le siège partout ; manager et assistant, leur restaurant et le pôle restaurant seulement', () => {
    const duRestaurant = { restaurant_id: R1, pole: IncidentPole.RESTAURANT };
    const deLaLivraison = { restaurant_id: R1, pole: IncidentPole.LIVRAISON };
    expect(peutTraiterIncident(admin, deLaLivraison)).toBe(true);
    expect(peutTraiterIncident(callCenter, duRestaurant)).toBe(true);
    expect(peutTraiterIncident(manager, duRestaurant)).toBe(true);
    expect(peutTraiterIncident(assistant, duRestaurant)).toBe(true);
    expect(peutTraiterIncident(manager, deLaLivraison)).toBe(false);
    expect(peutTraiterIncident(manager, { restaurant_id: R2, pole: IncidentPole.RESTAURANT })).toBe(false);
    expect(peutTraiterIncident(caissier, duRestaurant)).toBe(false);
    expect(peutTraiterIncident(marketing, duRestaurant)).toBe(false);
  });

  it('un call center rattaché par erreur à un restaurant ne traite pas le réseau', () => {
    const egare: Acteur = { ...callCenter, type: UserType.RESTAURANT, restaurant_id: R1 };
    expect(peutTraiterIncident(egare, { restaurant_id: R2, pole: IncidentPole.CALL_CENTER })).toBe(false);
  });
});

describe('incidents : droits de la fiche', () => {
  const avecBon = { bon_restaurant: true };
  const sansBon = { bon_restaurant: false };

  it('ouvert : le siège prend, confie, résout ; ni clôture ni réouverture', () => {
    expect(droitsIncident(callCenter, incident(), avecBon)).toEqual({
      traiter: true,
      noter: true,
      prendre: true,
      assigner: true,
      resoudre: true,
      bon: true,
      cloturer: false,
      rouvrir: false,
    });
  });

  it('le manager prend et résout son incident, sans changer le responsable', () => {
    const d = droitsIncident(manager, incident(), avecBon);
    expect(d).toMatchObject({ noter: true, prendre: true, assigner: false, resoudre: true, bon: true, rouvrir: false });
    expect(droitsIncident(manager, incident(), sansBon).bon).toBe(false);
    expect(droitsIncident(callCenter, incident(), sansBon).bon).toBe(true);
  });

  it("le manager ne touche pas à l'incident confié à la livraison, mais peut le noter", () => {
    const d = droitsIncident(manager, incident({ pole: IncidentPole.LIVRAISON }), avecBon);
    expect(d).toEqual({
      traiter: false,
      noter: true,
      prendre: false,
      assigner: false,
      resoudre: false,
      bon: false,
      cloturer: false,
      rouvrir: false,
    });
  });

  it('le caissier note, sans rien traiter ; le marketing ne fait que lire', () => {
    expect(droitsIncident(caissier, incident(), avecBon)).toMatchObject({ noter: true, prendre: false, resoudre: false });
    expect(Object.values(droitsIncident(marketing, incident(), avecBon)).some(Boolean)).toBe(false);
    expect(Object.values(droitsIncident(livraisonOps, incident(), avecBon)).some(Boolean)).toBe(false);
  });

  it("aucun droit sur l'incident d'un autre restaurant", () => {
    expect(Object.values(droitsIncident(manager, incident({ restaurant_id: R2 }), avecBon)).some(Boolean)).toBe(false);
  });

  it("déjà à mon nom : plus rien à prendre ; au nom d'un collègue : je peux le reprendre", () => {
    const enCours = incident({ statut: IncidentStatut.EN_COURS, agent_id: callCenter.id });
    expect(droitsIncident(callCenter, enCours, avecBon).prendre).toBe(false);
    expect(droitsIncident(admin, enCours, avecBon).prendre).toBe(true);
  });

  it('résolu : on clôture, le siège rouvre ; clôturé : seule la réouverture reste', () => {
    const resolu = incident({ statut: IncidentStatut.RESOLU });
    expect(droitsIncident(manager, resolu, avecBon)).toMatchObject({ resoudre: false, cloturer: true, rouvrir: false, bon: false });
    expect(droitsIncident(callCenter, resolu, avecBon)).toMatchObject({ cloturer: true, rouvrir: true, assigner: false });
    const cloture = incident({ statut: IncidentStatut.CLOTURE });
    expect(droitsIncident(callCenter, cloture, avecBon)).toMatchObject({ cloturer: false, rouvrir: true, resoudre: false, prendre: false });
    // Le manager traite toujours cet incident clôturé : il peut renvoyer le SMS du bon.
    expect(droitsIncident(manager, cloture, avecBon)).toMatchObject({ traiter: true, cloturer: false, rouvrir: false });
    expect(droitsIncident(caissier, cloture, avecBon).traiter).toBe(false);
  });
});

describe('incidents : textes saisis', () => {
  it('la description est nettoyée, bornée à 5 et 2 000 caractères', () => {
    expect(saisirDescription('  Poulet   servi tiède \r\n\r\n\r\n\r\n rien  ')).toEqual({ texte: 'Poulet   servi tiède\n\n rien' });
    expect(saisirDescription('abc')).toEqual({ refus: MESSAGE_DESCRIPTION });
    expect(saisirDescription(undefined)).toEqual({ refus: MESSAGE_DESCRIPTION });
    expect(saisirDescription('a'.repeat(2001))).toEqual({ refus: MESSAGE_DESCRIPTION_LONGUE });
    expect(saisirDescription('a'.repeat(2000))).toEqual({ texte: 'a'.repeat(2000) });
  });

  it('une note prend un caractère au moins', () => {
    expect(saisirNote(' ok ')).toEqual({ texte: 'ok' });
    expect('refus' in saisirNote('   ')).toBe(true);
    expect('refus' in saisirNote('a'.repeat(2001))).toBe(true);
  });

  it("l'extrait tient sur une ligne et se termine par des points de suspension", () => {
    expect(extrait('court')).toBe('court');
    expect(extrait('un\ndeux   trois')).toBe('un deux trois');
    expect(extrait('a'.repeat(200), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('le nom du client : prénom et nom, sinon le nom de la commande, sinon « Client »', () => {
    expect(nomClient({ first_name: ' Awa ', last_name: 'Koné' }, 'autre')).toBe('Awa Koné');
    expect(nomClient({ first_name: null, last_name: null }, ' Mme Koffi ')).toBe('Mme Koffi');
    expect(nomClient(null, null)).toBe('Client');
  });
});

describe('incidents : origine', () => {
  it('le lien impose son origine, quoi que dise le formulaire', () => {
    expect(origineRetenue('ticket', IncidentOrigine.APPEL)).toBe(IncidentOrigine.TICKET);
    expect(origineRetenue('avis', undefined)).toBe(IncidentOrigine.AVIS);
    expect(origineRetenue('note', IncidentOrigine.WHATSAPP)).toBe(IncidentOrigine.NOTE);
  });

  it("sans lien, l'agent choisit parmi appel, WhatsApp, sur place, constat interne", () => {
    expect(origineRetenue(null, IncidentOrigine.SUR_PLACE)).toBe(IncidentOrigine.SUR_PLACE);
    expect(origineRetenue(null, IncidentOrigine.CONSTAT_INTERNE)).toBe(IncidentOrigine.CONSTAT_INTERNE);
    expect(origineRetenue(null, undefined)).toBeNull();
    // Une origine réservée à un lien ne se déclare pas à la main.
    expect(origineRetenue(null, IncidentOrigine.TICKET)).toBeNull();
    expect(origineRetenue(null, IncidentOrigine.RAPPEL)).toBeNull();
  });
});

describe('incidents : code, délai, tri', () => {
  const jour = new Date('2026-11-11T23:30:00.000Z');

  it('le code porte le jour et une suite à trois chiffres', () => {
    expect(prefixeCode(jour)).toBe('INC-261111-');
    expect(codeIncident(jour, 1)).toBe('INC-261111-001');
    expect(codeIncident(new Date('2027-01-05T00:00:00.000Z'), 42)).toBe('INC-270105-042');
    expect(numeroSuivant(null)).toBe(1);
    expect(numeroSuivant('INC-261111-007')).toBe(8);
    expect(numeroSuivant('INC-261111-xyz')).toBe(1);
  });

  it("l'échéance suit le délai de la catégorie ; en retard seulement tant que l'incident n'est pas résolu", () => {
    const creation = new Date('2026-11-11T10:00:00.000Z');
    const limite = echeance(creation, 24);
    expect(limite.toISOString()).toBe('2026-11-12T10:00:00.000Z');
    const apres = new Date('2026-11-12T10:00:01.000Z');
    expect(enRetard({ statut: IncidentStatut.OUVERT, echeance_at: limite }, apres)).toBe(true);
    expect(enRetard({ statut: IncidentStatut.EN_COURS, echeance_at: limite }, apres)).toBe(true);
    expect(enRetard({ statut: IncidentStatut.RESOLU, echeance_at: limite }, apres)).toBe(false);
    expect(enRetard({ statut: IncidentStatut.OUVERT, echeance_at: limite }, limite)).toBe(false);
  });

  it('à traiter : en retard, puis le plus grave, puis le plus ancien', () => {
    const maintenant = new Date('2026-11-12T12:00:00.000Z');
    const ligne = (nom: string, gravite: IncidentGravite, echeanceIso: string, creeIso: string) => ({
      nom,
      statut: IncidentStatut.OUVERT,
      gravite,
      echeance_at: new Date(echeanceIso),
      created_at: new Date(creeIso),
    });
    const lignes = [
      ligne('faible récent', IncidentGravite.FAIBLE, '2026-11-13T10:00:00Z', '2026-11-12T10:00:00Z'),
      ligne('haute', IncidentGravite.HAUTE, '2026-11-13T10:00:00Z', '2026-11-12T11:00:00Z'),
      ligne('faible ancien', IncidentGravite.FAIBLE, '2026-11-13T09:00:00Z', '2026-11-12T09:00:00Z'),
      ligne('en retard', IncidentGravite.FAIBLE, '2026-11-12T11:00:00Z', '2026-11-11T11:00:00Z'),
    ];
    expect(lignes.sort((a, b) => comparerATraiter(a, b, maintenant)).map((l) => l.nom)).toEqual([
      'en retard',
      'haute',
      'faible ancien',
      'faible récent',
    ]);
  });
});

describe('incidents : bon de réduction', () => {
  it('les réglages absents ou hors bornes reprennent le défaut', () => {
    expect(lireReglages({})).toEqual(REGLAGES_DEFAUT);
    expect(
      lireReglages({
        'incident.bon_faible': '500',
        'incident.bon_moyenne': 'abc',
        'incident.bon_haute': '999999',
        'incident.bon_validite_jours': '15',
        'incident.bon_restaurant': 'false',
      }),
    ).toEqual({ bareme: { FAIBLE: 500, MOYENNE: 2000, HAUTE: 3000 }, validite_jours: 15, bon_restaurant: false });
    expect(lireReglages({ 'incident.bon_restaurant': 'TRUE ' }).bon_restaurant).toBe(true);
    expect(lireReglages({ 'incident.bon_validite_jours': '0' }).validite_jours).toBe(30);
  });

  it('les montants proposés sont ceux du barème, sans doublon, triés', () => {
    expect(montantsBon({ FAIBLE: 1000, MOYENNE: 2000, HAUTE: 3000 })).toEqual([1000, 2000, 3000]);
    expect(montantsBon({ FAIBLE: 2000, MOYENNE: 2000, HAUTE: 1000 })).toEqual([1000, 2000]);
    expect(bonSuggere(IncidentGravite.HAUTE, REGLAGES_DEFAUT.bareme)).toBe(3000);
  });

  it('le bon expire après la validité, et le SMS dit le montant, le code et la date', () => {
    const expire = expirationBon(new Date('2026-11-11T10:00:00.000Z'), 30);
    expect(expire.toISOString()).toBe('2026-12-11T10:00:00.000Z');
    const sms = texteSmsBon({ montant: 2000, code: 'CN7Q2KXP', expire });
    expect(sms).toContain('2 000 F');
    expect(sms).toContain('code CN7Q2KXP');
    expect(sms).toContain("jusqu'au 11/12/2026");
  });

  it("le SMS reste dans l'alphabet des SMS : un seul caractère de trop double la facture", () => {
    // Le plus long : montant maximal, code de huit caractères (« CN » et six signes).
    const sms = texteSmsBon({ montant: 100000, code: 'CN7Q2KXP', expire: new Date('2027-01-03T00:00:00Z') });
    // Alphabet GSM 03.38 : lettres sans accent, chiffres, ponctuation simple, é è à ù.
    expect(sms).toMatch(/^[A-Za-z0-9 .,:;!?'\/\-()éèàù]+$/);
    expect(sms.length).toBeLessThanOrEqual(160);
  });

  it('les montants se lisent avec des espaces ordinaires', () => {
    expect(montantLisible(1000)).toBe('1 000 F');
    expect(montantLisible(12500)).toBe('12 500 F');
    expect(montantLisible(500)).toBe('500 F');
  });
});

describe('incidents : résoudre', () => {
  const contexte = { peutOffrirBon: true, bareme: REGLAGES_DEFAUT.bareme, bonExistant: null };
  const base = { cause: 'Oubli à la préparation', action: 'Liste de contrôle avant de fermer le sac' };

  it('il faut la cause, l’action corrective et le geste', () => {
    expect(verifierResolution({ ...base, cause: ' ', geste: IncidentGeste.EXCUSES }, contexte)).toEqual({ refus: MESSAGE_CAUSE });
    expect(verifierResolution({ ...base, action: 'ok', geste: IncidentGeste.EXCUSES }, contexte)).toEqual({ refus: MESSAGE_ACTION });
    expect(verifierResolution({ ...base, geste: null }, contexte)).toEqual({ refus: MESSAGE_GESTE });
    expect(verifierResolution({ ...base, geste: IncidentGeste.EXCUSES }, contexte)).toEqual({
      cause: base.cause,
      action: base.action,
      geste: IncidentGeste.EXCUSES,
      bon_montant: null,
    });
  });

  it('un geste sans bon ignore le montant envoyé', () => {
    expect(verifierResolution({ ...base, geste: IncidentGeste.REMPLACEMENT, bon_montant: 3000 }, contexte)).toMatchObject({
      geste: IncidentGeste.REMPLACEMENT,
      bon_montant: null,
    });
  });

  it('un bon prend un montant du barème, rien d’autre', () => {
    expect(verifierResolution({ ...base, geste: IncidentGeste.BON, bon_montant: 2000 }, contexte)).toMatchObject({ bon_montant: 2000 });
    expect(verifierResolution({ ...base, geste: IncidentGeste.BON }, contexte)).toEqual({ refus: MESSAGE_BON_MONTANT });
    expect(verifierResolution({ ...base, geste: IncidentGeste.BON, bon_montant: 50000 }, contexte)).toEqual({ refus: MESSAGE_BON_MONTANT });
  });

  it('qui ne peut pas offrir de bon est refusé', () => {
    expect(
      verifierResolution({ ...base, geste: IncidentGeste.BON, bon_montant: 2000 }, { ...contexte, peutOffrirBon: false }),
    ).toEqual({ refus: MESSAGE_BON_INTERDIT });
  });

  it('un bon déjà créé reste acquis : jamais de second bon, quel que soit le geste', () => {
    const dejaBon = { ...contexte, peutOffrirBon: false, bonExistant: 3000 };
    expect(verifierResolution({ ...base, geste: IncidentGeste.BON, bon_montant: 1000 }, dejaBon)).toMatchObject({
      geste: IncidentGeste.BON,
      bon_montant: 3000,
    });
    expect(verifierResolution({ ...base, geste: IncidentGeste.EXCUSES }, dejaBon)).toMatchObject({
      geste: IncidentGeste.EXCUSES,
      bon_montant: 3000,
    });
  });
});

describe('incidents : clôturer', () => {
  it('client informé : sa réaction est obligatoire', () => {
    expect(verifierCloture({ recontact: null })).toEqual({ refus: MESSAGE_RECONTACT });
    expect(verifierCloture({ recontact: IncidentRecontact.INFORME, reaction: ' ' })).toEqual({ refus: MESSAGE_REACTION });
    expect(verifierCloture({ recontact: IncidentRecontact.INFORME, reaction: ' Satisfait du geste ' })).toEqual({
      recontact: IncidentRecontact.INFORME,
      reaction: 'Satisfait du geste',
    });
  });

  it('injoignable ou sans recontact : la réaction est facultative', () => {
    expect(verifierCloture({ recontact: IncidentRecontact.INJOIGNABLE })).toEqual({
      recontact: IncidentRecontact.INJOIGNABLE,
      reaction: null,
    });
    expect(verifierCloture({ recontact: IncidentRecontact.SANS_RECONTACT, reaction: 'Constat interne' })).toEqual({
      recontact: IncidentRecontact.SANS_RECONTACT,
      reaction: 'Constat interne',
    });
  });

  it('la solution de l’avis suit le geste', () => {
    expect(solutionAvis(IncidentGeste.BON)).toBe(AvisSolution.GESTE_COMMERCIAL);
    expect(solutionAvis(IncidentGeste.EXCUSES)).toBe(AvisSolution.EXCUSES);
    expect(solutionAvis(IncidentGeste.REMPLACEMENT)).toBe(AvisSolution.REMPLACEMENT);
    expect(solutionAvis(IncidentGeste.REMBOURSEMENT)).toBe(AvisSolution.REMBOURSEMENT);
    expect(solutionAvis(IncidentGeste.AUCUN)).toBe(AvisSolution.AUCUNE);
    expect(solutionAvis(null)).toBe(AvisSolution.AUCUNE);
  });
});

describe('incidents : journal', () => {
  const ligne = (type: IncidentSuiviType, meta: Record<string, unknown> | null = null, auteur: string | null = 'Awa') =>
    texteSuivi({ type, note: null, meta, auteur_nom: auteur });

  it('dit qui a fait quoi, en mots', () => {
    expect(ligne(IncidentSuiviType.CREATION, { origine: 'WHATSAPP' })).toBe('Signalé par Awa (WhatsApp)');
    expect(ligne(IncidentSuiviType.ASSIGNATION, { prise: true })).toBe('Pris en charge par Awa');
    expect(ligne(IncidentSuiviType.ASSIGNATION, { pole: 'LIVRAISON', agent: null })).toBe('Confié à : Livraison, par Awa');
    expect(ligne(IncidentSuiviType.ASSIGNATION, { pole: 'CALL_CENTER', agent: 'Ruth' })).toBe('Confié à : Call center, Ruth, par Awa');
    expect(ligne(IncidentSuiviType.RESOLUTION, { geste: 'BON' })).toBe('Résolu par Awa : bon de réduction');
    expect(ligne(IncidentSuiviType.CLOTURE, { recontact: 'INFORME' })).toBe('Clôturé par Awa : client informé');
    expect(ligne(IncidentSuiviType.REOUVERTURE)).toBe('Rouvert par Awa');
    expect(ligne(IncidentSuiviType.NOTE)).toBe('Note de Awa');
    expect(ligne(IncidentSuiviType.RETARD, null, null)).toBe('Délai dépassé. Alerte envoyée.');
  });

  it('le bon : son code, son montant, sa date ; ou son échec', () => {
    expect(ligne(IncidentSuiviType.BON, { code: 'CN-7Q2K', montant: 2000, expire: '11/12/2026' })).toBe(
      "Bon CN-7Q2K de 2 000 F créé, valable jusqu'au 11/12/2026",
    );
    expect(ligne(IncidentSuiviType.BON, {}, null)).toBe("Le bon n'a pas pu être créé");
    expect(ligne(IncidentSuiviType.MESSAGE, { envoye: true }, null)).toBe('Code du bon envoyé au client par SMS');
    expect(ligne(IncidentSuiviType.MESSAGE, { envoye: false }, null)).toBe("Le SMS du bon n'est pas parti");
  });

  it('une ligne du système le dit', () => {
    expect(ligne(IncidentSuiviType.CREATION, { origine: 'AVIS' }, null)).toBe('Signalé par Système (Avis du site)');
  });
});

describe('incidents : recherche et période', () => {
  it('la recherche garde le texte et les chiffres d’un numéro', () => {
    expect(critereRecherche(' 07 07 00 00 01 ')).toEqual({ texte: '07 07 00 00 01', chiffres: '0707000001' });
    expect(critereRecherche('ORD-261110-50950')).toEqual({ texte: 'ORD-261110-50950', chiffres: '26111050950' });
    expect(critereRecherche('Koné')).toEqual({ texte: 'Koné', chiffres: '' });
    expect(critereRecherche('a')).toBeNull();
    expect(critereRecherche(undefined)).toBeNull();
  });

  it('une période prend ses deux jours en entier', () => {
    const { debut, fin } = bornesPeriode('2026-11-10', '2026-11-11');
    expect(debut?.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(fin?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(bornesPeriode(undefined, 'pas une date')).toEqual({ debut: null, fin: null });
  });

  it('le tableau de bord prend les 30 derniers jours par défaut, un an au plus', () => {
    const maintenant = new Date('2026-11-11T15:00:00.000Z');
    const defaut = periodeStats(undefined, undefined, maintenant);
    expect(defaut).toMatchObject({ du: '2026-10-13', au: '2026-11-11' });
    const inversee = periodeStats('2026-11-11', '2026-11-01', maintenant);
    expect(inversee).toMatchObject({ du: '2026-11-01', au: '2026-11-11' });
    expect(periodeStats('2025-01-01', '2026-11-11', maintenant)).toEqual({ refus: MESSAGE_PERIODE });
  });
});

describe('incidents : tableau de bord', () => {
  const periode = {
    debut: new Date('2026-11-09T00:00:00.000Z'),
    fin: new Date('2026-11-12T00:00:00.000Z'),
    du: '2026-11-09',
    au: '2026-11-11',
  };
  const maintenant = new Date('2026-11-11T18:00:00.000Z');
  let n = 0;
  const ligne = (p: Partial<LigneStat>): LigneStat => ({
    id: `i-${++n}`,
    code: `INC-${n}`,
    statut: IncidentStatut.OUVERT,
    gravite: IncidentGravite.MOYENNE,
    origine: IncidentOrigine.APPEL,
    pole: IncidentPole.RESTAURANT,
    geste: null,
    bon_montant: null,
    voucher_id: null,
    categorie_id: 'c-qualite',
    categorie_nom: 'Qualité du plat',
    restaurant_id: R1,
    restaurant_nom: 'Angré',
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    resolu_at: null,
    echeance_at: new Date('2026-11-11T10:00:00.000Z'),
    cause: null,
    action: null,
    ...p,
  });

  it('compte par statut, catégorie, restaurant, jour, et mesure les délais', () => {
    const lignes = [
      // Ouvert, échéance passée : en retard.
      ligne({}),
      // Résolu en 4 h, dans les délais, avec un bon.
      ligne({
        statut: IncidentStatut.RESOLU,
        resolu_at: new Date('2026-11-10T14:00:00.000Z'),
        geste: IncidentGeste.BON,
        bon_montant: 2000,
        voucher_id: 'bon-1',
        cause: 'Plat tiède',
        action: 'Mise en sac au départ du livreur',
      }),
      // Clôturé, résolu en 30 h, hors délai, autre restaurant et catégorie.
      ligne({
        statut: IncidentStatut.CLOTURE,
        created_at: new Date('2026-11-09T08:00:00.000Z'),
        echeance_at: new Date('2026-11-10T08:00:00.000Z'),
        resolu_at: new Date('2026-11-10T14:00:00.000Z'),
        geste: IncidentGeste.EXCUSES,
        categorie_id: 'c-retard',
        categorie_nom: 'Livraison tardive',
        restaurant_id: R2,
        restaurant_nom: 'Faya',
        pole: IncidentPole.LIVRAISON,
        origine: IncidentOrigine.AVIS,
        gravite: IncidentGravite.HAUTE,
      }),
      // Bon demandé mais jamais créé : pas compté dans les bons.
      ligne({ statut: IncidentStatut.RESOLU, resolu_at: new Date('2026-11-11T09:00:00.000Z'), geste: IncidentGeste.BON, bon_montant: 3000 }),
    ];
    const s = agregerStatistiques(lignes, periode, maintenant);
    expect(s).toMatchObject({ total: 4, ouverts: 1, en_cours: 0, resolus: 2, clotures: 1, en_retard: 1 });
    // (4 h + 30 h + 23 h) / 3 = 19 h
    expect(s.delai_moyen_heures).toBe(19);
    // Deux sur trois avant leur échéance.
    expect(s.dans_les_delais_pct).toBe(67);
    expect(s.par_categorie).toEqual([
      { id: 'c-qualite', nom: 'Qualité du plat', total: 3, ouverts: 1 },
      { id: 'c-retard', nom: 'Livraison tardive', total: 1, ouverts: 0 },
    ]);
    expect(s.par_restaurant.map((r) => [r.name, r.total])).toEqual([
      ['Angré', 3],
      ['Faya', 1],
    ]);
    expect(s.par_pole).toEqual([
      { pole: IncidentPole.RESTAURANT, total: 3 },
      { pole: IncidentPole.LIVRAISON, total: 1 },
    ]);
    expect(s.par_jour).toEqual([
      { jour: '2026-11-09', total: 1 },
      { jour: '2026-11-10', total: 3 },
      { jour: '2026-11-11', total: 0 },
    ]);
    expect(s.gestes).toEqual([
      { geste: IncidentGeste.BON, total: 2 },
      { geste: IncidentGeste.EXCUSES, total: 1 },
    ]);
    expect(s.bons).toEqual({ nombre: 1, montant: 2000 });
    expect(s.corrections).toHaveLength(1);
    expect(s.corrections[0]).toMatchObject({ categorie: 'Qualité du plat', restaurant: 'Angré', cause: 'Plat tiède' });
  });

  it('sans incident : des zéros, et pas de délai inventé', () => {
    const s = agregerStatistiques([], periode, maintenant);
    expect(s).toMatchObject({ total: 0, en_retard: 0, delai_moyen_heures: null, dans_les_delais_pct: null });
    expect(s.par_categorie).toEqual([]);
    expect(s.par_jour).toHaveLength(3);
    expect(s.bons).toEqual({ nombre: 0, montant: 0 });
  });
});

describe('incidents : export', () => {
  it('une cellule ne se lit jamais comme une formule', () => {
    expect(celluleCsv('=SOMME(A1)')).toBe(`"'=SOMME(A1)"`);
    expect(celluleCsv('+2250707000001')).toBe(`"'+2250707000001"`);
    expect(celluleCsv('dit « non » puis "oui"')).toBe('"dit « non » puis ""oui"""');
    expect(celluleCsv(null)).toBe('""');
    expect(celluleCsv(2000)).toBe('"2000"');
  });

  it('le fichier s’ouvre dans Excel : marque d’ordre des octets et points-virgules', () => {
    const csv = versCsv(['A', 'B'], [['1', 'deux']]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('"A";"B"\r\n"1";"deux"\r\n');
  });
});
