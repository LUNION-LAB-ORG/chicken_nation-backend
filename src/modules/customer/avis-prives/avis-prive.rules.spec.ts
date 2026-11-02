import { BadRequestException } from '@nestjs/common';
import { AvisCanal, AvisResultat, AvisRessenti, AvisSolution, AvisStatut, AvisSuiviType } from '@prisma/client';
import { NotificationContext } from 'src/modules/notifications/interfaces/notifications.interface';
import { AvisPriveNotificationsTemplate } from './avis-prive-notifications.template';
import {
  celluleCsv,
  changementStatut,
  comparerAvis,
  DELAI_ECHEANCE_MS,
  echeanceActive,
  echeanceAffichee,
  effetsJournal,
  enRetard,
  ENTETES_EXPORT,
  etatInitial,
  extrait,
  formatJourHeure,
  LIBELLE_ACTION,
  LIBELLE_CANAL_ECRAN,
  LIBELLE_CANAL_EXPORT,
  LIBELLE_CANAL_SITE,
  LIBELLE_RESSENTI,
  LIBELLE_RESULTAT,
  LIBELLE_SOLUTION,
  LIBELLE_STATUT,
  libelleSource,
  MESSAGE_CONFLIT,
  MESSAGE_INCIDENT_MANUEL,
  MESSAGE_NUMERO,
  MESSAGE_PLAFOND_GLOBAL,
  MESSAGE_PLAFOND_IP,
  MESSAGE_PLAFOND_NUMERO,
  MESSAGE_SANS_ACCORD,
  MESSAGE_SOLUTION,
  MESSAGE_STORE,
  messageTicket,
  mobileIvoirien,
  nettoyerCommentaire,
  nettoyerPrenom,
  passageIncident,
  SOURCES,
  sourceAutorisee,
  sujetTicket,
  TEXTE_ALERTE,
  TEXTE_RAPPROCHEMENT,
  TEXTE_RETARD,
  texteReception,
  texteSuivi,
  verifierEntreeJournal,
  versCsv,
} from './avis-prive.rules';

const RECU = new Date('2026-11-02T08:42:00.000Z');
const PLUS_TARD = (ms: number) => new Date(RECU.getTime() + ms);
const HEURE = 3_600_000;

describe('statut initial et échéance (3.2)', () => {
  it.each([
    [AvisRessenti.PAS_CONTENT, true, AvisStatut.A_RAPPELER, true],
    [AvisRessenti.PEUT_MIEUX_FAIRE, true, AvisStatut.A_RAPPELER, true],
    [AvisRessenti.AU_TOP, true, AvisStatut.NOUVEAU, false],
    [AvisRessenti.PAS_CONTENT, false, AvisStatut.NOUVEAU, false],
    [AvisRessenti.PEUT_MIEUX_FAIRE, false, AvisStatut.NOUVEAU, false],
    [AvisRessenti.AU_TOP, false, AvisStatut.NOUVEAU, false],
  ])('%s, accord %s : %s, échéance %s', (ressenti, accord, statut, avecEcheance) => {
    const etat = etatInitial(ressenti, accord, RECU);
    expect(etat.statut).toBe(statut);
    expect(etat.echeance_at).toEqual(avecEcheance ? new Date(RECU.getTime() + DELAI_ECHEANCE_MS) : null);
  });

  it('échéance à 24 h pile : reçu le 02/11 à 08:42, à rappeler avant le 03/11 à 08:42', () => {
    expect(formatJourHeure(etatInitial(AvisRessenti.PAS_CONTENT, true, RECU).echeance_at as Date)).toBe(
      '03/11 à 08:42',
    );
  });

  const base = { echeance_at: PLUS_TARD(24 * HEURE), premier_contact_at: null, statut: AvisStatut.A_RAPPELER };

  it('active, puis dépassée une fois l’heure passée', () => {
    expect(echeanceActive(base)).toBe(true);
    expect(enRetard(base, PLUS_TARD(23 * HEURE))).toBe(false);
    expect(enRetard(base, PLUS_TARD(26 * HEURE))).toBe(true);
    expect(echeanceAffichee(base)).toEqual(base.echeance_at);
  });

  it('en cours ou injoignable sans « Joint » : elle court encore', () => {
    for (const statut of [AvisStatut.EN_COURS, AvisStatut.INJOIGNABLE]) {
      expect(enRetard({ ...base, statut }, PLUS_TARD(30 * HEURE))).toBe(true);
    }
  });

  it('tenue par un premier « Joint » : sans objet, même après l’heure', () => {
    const tenue = { ...base, statut: AvisStatut.EN_COURS, premier_contact_at: PLUS_TARD(HEURE) };
    expect(echeanceActive(tenue)).toBe(false);
    expect(enRetard(tenue, PLUS_TARD(30 * HEURE))).toBe(false);
    expect(echeanceAffichee(tenue)).toBeNull();
  });

  it('sans objet pour un incident ouvert, un avis résolu ou classé, ou sans échéance', () => {
    for (const statut of [AvisStatut.INCIDENT_OUVERT, AvisStatut.RESOLU, AvisStatut.CLASSE, AvisStatut.NOUVEAU]) {
      expect(enRetard({ ...base, statut }, PLUS_TARD(30 * HEURE))).toBe(false);
      expect(echeanceAffichee({ ...base, statut })).toBeNull();
    }
    expect(enRetard({ ...base, echeance_at: null }, PLUS_TARD(30 * HEURE))).toBe(false);
  });
});

describe('journal : saisie et effets (3.3)', () => {
  it('appel et WhatsApp refusés sans accord de rappel ; la note interne reste possible', () => {
    expect(() => verifierEntreeJournal({ action: 'APPEL', resultat: AvisResultat.JOINT }, false)).toThrow(
      MESSAGE_SANS_ACCORD,
    );
    expect(() => verifierEntreeJournal({ action: 'WHATSAPP', resultat: AvisResultat.JOINT }, false)).toThrow(
      MESSAGE_SANS_ACCORD,
    );
    expect(verifierEntreeJournal({ action: 'NOTE', note: '  Rappel demandé ce soir  ' }, false)).toEqual({
      action: 'NOTE',
      resultat: null,
      note: 'Rappel demandé ce soir',
    });
  });

  it('résultat obligatoire pour un appel ; WhatsApp sans Messagerie ; note obligatoire pour une note', () => {
    expect(() => verifierEntreeJournal({ action: 'APPEL' }, true)).toThrow(BadRequestException);
    expect(() => verifierEntreeJournal({ action: 'WHATSAPP', resultat: AvisResultat.MESSAGERIE }, true)).toThrow(
      BadRequestException,
    );
    expect(() => verifierEntreeJournal({ action: 'NOTE', note: '   ' }, true)).toThrow(BadRequestException);
    expect(() => verifierEntreeJournal({ action: 'NOTE', note: 'x'.repeat(2001) }, true)).toThrow(BadRequestException);
    expect(verifierEntreeJournal({ action: 'APPEL', resultat: AvisResultat.MESSAGERIE, note: '' }, true)).toEqual({
      action: 'APPEL',
      resultat: AvisResultat.MESSAGERIE,
      note: null,
    });
  });

  const entree = (action: 'APPEL' | 'WHATSAPP' | 'NOTE', resultat: AvisResultat | null) => ({
    action,
    resultat,
    note: null,
  });

  it('Joint : premier contact, Nouveau, À rappeler et Injoignable passent En cours', () => {
    for (const statut of [AvisStatut.NOUVEAU, AvisStatut.A_RAPPELER, AvisStatut.INJOIGNABLE]) {
      expect(effetsJournal(statut, entree('APPEL', AvisResultat.JOINT), false)).toEqual({
        statut: AvisStatut.EN_COURS,
        premierContact: true,
        tentative: true,
      });
    }
    // Un incident ouvert ou un avis clos gardent leur statut ; le contact déjà pris reste.
    expect(effetsJournal(AvisStatut.INCIDENT_OUVERT, entree('WHATSAPP', AvisResultat.JOINT), true)).toEqual({
      statut: AvisStatut.INCIDENT_OUVERT,
      premierContact: false,
      tentative: false,
    });
  });

  it('Injoignable ou Messagerie : Nouveau et À rappeler passent Injoignable, En cours reste', () => {
    for (const resultat of [AvisResultat.INJOIGNABLE, AvisResultat.MESSAGERIE]) {
      expect(effetsJournal(AvisStatut.A_RAPPELER, entree('APPEL', resultat), false).statut).toBe(AvisStatut.INJOIGNABLE);
      expect(effetsJournal(AvisStatut.NOUVEAU, entree('APPEL', resultat), false).statut).toBe(AvisStatut.INJOIGNABLE);
      expect(effetsJournal(AvisStatut.EN_COURS, entree('APPEL', resultat), false).statut).toBe(AvisStatut.EN_COURS);
    }
    expect(effetsJournal(AvisStatut.A_RAPPELER, entree('WHATSAPP', AvisResultat.INJOIGNABLE), false)).toEqual({
      statut: AvisStatut.INJOIGNABLE,
      premierContact: false,
      tentative: false,
    });
  });

  it('une note interne ne change rien', () => {
    for (const statut of Object.values(AvisStatut)) {
      expect(effetsJournal(statut, entree('NOTE', null), false)).toEqual({
        statut,
        premierContact: false,
        tentative: false,
      });
    }
  });
});

describe('clôture et changement de statut (3.4)', () => {
  const changer = (actuel: AvisStatut, cible: AvisStatut, solution?: AvisSolution | null, accord = true) =>
    changementStatut({ actuel, cible, solution, accordRappel: accord, maintenant: RECU });

  it('Résolu sans solution : refusé', () => {
    expect(() => changer(AvisStatut.EN_COURS, AvisStatut.RESOLU)).toThrow(MESSAGE_SOLUTION);
    expect(() => changer(AvisStatut.EN_COURS, AvisStatut.RESOLU, null)).toThrow(BadRequestException);
  });

  it('Résolu avec solution : résolu et clos maintenant', () => {
    expect(changer(AvisStatut.EN_COURS, AvisStatut.RESOLU, AvisSolution.GESTE_COMMERCIAL)).toEqual({
      statut: AvisStatut.RESOLU,
      solution: AvisSolution.GESTE_COMMERCIAL,
      resolu_at: RECU,
      clos_at: RECU,
    });
  });

  it('Classé : clos, solution facultative, jamais résolu', () => {
    expect(changer(AvisStatut.NOUVEAU, AvisStatut.CLASSE)).toEqual({
      statut: AvisStatut.CLASSE,
      solution: null,
      resolu_at: null,
      clos_at: RECU,
    });
    expect(changer(AvisStatut.NOUVEAU, AvisStatut.CLASSE, AvisSolution.AUCUNE).solution).toBe(AvisSolution.AUCUNE);
  });

  it('Nouveau jamais à la main, Incident ouvert seulement par « Créer un incident »', () => {
    expect(() => changer(AvisStatut.EN_COURS, AvisStatut.NOUVEAU)).toThrow(BadRequestException);
    expect(() => changer(AvisStatut.EN_COURS, AvisStatut.INCIDENT_OUVERT)).toThrow(MESSAGE_INCIDENT_MANUEL);
  });

  it('À rappeler et Injoignable refusés sans accord de rappel', () => {
    expect(() => changer(AvisStatut.NOUVEAU, AvisStatut.A_RAPPELER, null, false)).toThrow(BadRequestException);
    expect(() => changer(AvisStatut.NOUVEAU, AvisStatut.INJOIGNABLE, null, false)).toThrow(BadRequestException);
    expect(changer(AvisStatut.NOUVEAU, AvisStatut.EN_COURS, null, false).statut).toBe(AvisStatut.EN_COURS);
  });

  it('réouverture : quitter Résolu ou Classé vide clos_at, resolu_at et la solution', () => {
    for (const actuel of [AvisStatut.RESOLU, AvisStatut.CLASSE]) {
      expect(changer(actuel, AvisStatut.EN_COURS, AvisSolution.EXCUSES)).toEqual({
        statut: AvisStatut.EN_COURS,
        solution: null,
        resolu_at: null,
        clos_at: null,
      });
    }
    expect(passageIncident(AvisStatut.RESOLU)).toEqual({
      statut: AvisStatut.INCIDENT_OUVERT,
      solution: null,
      resolu_at: null,
      clos_at: null,
    });
  });

  it('reposer Résolu pour changer de solution garde la date de résolution', () => {
    expect(changer(AvisStatut.RESOLU, AvisStatut.RESOLU, AvisSolution.REMBOURSEMENT)).toEqual({
      statut: AvisStatut.RESOLU,
      solution: AvisSolution.REMBOURSEMENT,
    });
  });
});

describe('sources (liste blanche)', () => {
  it('garde les codes connus, ramène tout le reste à « site »', () => {
    expect(sourceAutorisee('marque-page')).toBe('marque-page');
    expect(sourceAutorisee(' Ticket ')).toBe('ticket');
    expect(sourceAutorisee('sac')).toBe('sac');
    for (const brut of [undefined, null, '', 'inconnue', '<script>', 'marque page', 42, 'x'.repeat(41)]) {
      expect(sourceAutorisee(brut)).toBe('site');
    }
    expect(libelleSource('marque-page')).toBe('QR code marque-page');
    expect(libelleSource('inconnue')).toBe('Site web');
  });

  it('jumelle du back-office : les quatre sources et leurs libellés', () => {
    expect(SOURCES).toEqual({
      'marque-page': 'QR code marque-page',
      ticket: 'QR code ticket de caisse',
      sac: 'QR code sac',
      site: 'Site web',
    });
  });
});

describe('mots (3.1)', () => {
  it('« Téléphone » s’affiche « Manuel » à l’écran, reste « Téléphone » sur le site et à l’export', () => {
    expect(LIBELLE_CANAL_SITE.TELEPHONE).toBe('Téléphone');
    expect(LIBELLE_CANAL_ECRAN.TELEPHONE).toBe('Manuel');
    expect(LIBELLE_CANAL_EXPORT.TELEPHONE).toBe('Téléphone');
    expect(LIBELLE_CANAL_ECRAN.APPLI).toBe('Appli');
    expect(LIBELLE_CANAL_SITE.APPLI).toBe('Appli Chicken Nation');
    expect(LIBELLE_CANAL_ECRAN.SUR_PLACE).toBe('Sur place');
    for (const canal of Object.values(AvisCanal)) {
      expect(LIBELLE_CANAL_ECRAN[canal]).toBeTruthy();
      expect(LIBELLE_CANAL_EXPORT[canal]).toBeTruthy();
    }
  });

  it('statuts, solutions et résultats nommés comme la maquette', () => {
    expect(Object.values(LIBELLE_STATUT)).toEqual([
      'Nouveau',
      'À rappeler',
      'En cours',
      'Injoignable',
      'Incident ouvert',
      'Résolu',
      'Classé',
    ]);
    expect(Object.values(LIBELLE_SOLUTION)).toEqual([
      'Excuses',
      'Geste commercial',
      'Remplacement',
      'Remboursement',
      'Aucune',
    ]);
    expect(Object.values(LIBELLE_RESULTAT)).toEqual(['Joint', 'Injoignable', 'Messagerie']);
    expect(LIBELLE_ACTION).toEqual({ APPEL: 'Appel', WHATSAPP: 'Message WhatsApp', NOTE: 'Note interne' });
    expect(LIBELLE_RESSENTI).toEqual({ PAS_CONTENT: 'Pas content', PEUT_MIEUX_FAIRE: 'Peut mieux faire', AU_TOP: 'Au top' });
  });
});

describe('saisie publique', () => {
  it('mobile ivoirien : 07, 05 et 01, toutes graphies, en +225 canonique', () => {
    expect(mobileIvoirien('07 07 00 00 01')).toBe('+2250707000001');
    expect(mobileIvoirien('+225 05 05 00 00 02')).toBe('+2250505000002');
    expect(mobileIvoirien('2250101000004')).toBe('+2250101000004');
    expect(mobileIvoirien('+2250707000001')).toBe('+2250707000001');
  });

  it('fixe, étranger, ancien numéro à 8 chiffres ou saisie farfelue : refusés', () => {
    for (const brut of ['27 21 71 21 30', '+33612345678', '07070707', '+225 7070 00001', 'abc', '', null, 42]) {
      expect(mobileIvoirien(brut)).toBeNull();
    }
  });

  it('commentaire sans caractères de contrôle, retours à la ligne gardés', () => {
    expect(nettoyerCommentaire('  Frites\u0000 froides\r\nEt\tboisson\u0007 oubliée  ')).toBe(
      'Frites froides\nEt boisson oubliée',
    );
    expect(nettoyerPrenom('  Awa \n Marie ')).toBe('Awa Marie');
    expect(nettoyerPrenom('   ')).toBeNull();
    expect(nettoyerPrenom('x'.repeat(80))).toHaveLength(60);
  });
});

describe('tri par défaut (3.9) sur l’exemple de la maquette', () => {
  const d = (j: number, h: number, m: number) => new Date(Date.UTC(2026, 10, j, h, m));
  const exemple = [
    { id: 'koffi', ressenti: AvisRessenti.PEUT_MIEUX_FAIRE, statut: AvisStatut.EN_COURS, created_at: d(1, 21, 3) },
    { id: 'fatou', ressenti: AvisRessenti.PEUT_MIEUX_FAIRE, statut: AvisStatut.RESOLU, created_at: d(0, 20, 44) },
    { id: 'sans-prenom', ressenti: AvisRessenti.PAS_CONTENT, statut: AvisStatut.A_RAPPELER, created_at: d(2, 10, 15) },
    { id: 'mariam', ressenti: AvisRessenti.PAS_CONTENT, statut: AvisStatut.INCIDENT_OUVERT, created_at: d(1, 19, 27) },
    { id: 'yao', ressenti: AvisRessenti.AU_TOP, statut: AvisStatut.CLASSE, created_at: d(1, 13, 10) },
    { id: 'awa', ressenti: AvisRessenti.PAS_CONTENT, statut: AvisStatut.A_RAPPELER, created_at: d(2, 8, 42) },
  ];

  it('« Pas content » non traités d’abord, du plus ancien au plus récent, puis le reste du plus récent au plus ancien', () => {
    expect([...exemple].sort(comparerAvis).map((a) => a.id)).toEqual([
      'awa',
      'sans-prenom',
      'koffi',
      'mariam',
      'yao',
      'fatou',
    ]);
  });
});

describe('textes du serveur', () => {
  it('réception : phrases mises bout à bout', () => {
    expect(texteReception({ rapproche: true, statut: AvisStatut.A_RAPPELER, accordRappel: true })).toBe(
      'Avis reçu. Client rapproché automatiquement. Statut « À rappeler », échéance 24 h.',
    );
    expect(texteReception({ rapproche: false, statut: AvisStatut.NOUVEAU, accordRappel: false })).toBe(
      "Avis reçu. Client non rapproché. Statut « Nouveau ». Pas d'accord de rappel.",
    );
  });

  it('lignes du journal (3.10)', () => {
    const s = { resultat: null, note: null, statut_apres: null, solution: null, meta: null };
    expect(texteSuivi({ ...s, type: AvisSuiviType.APPEL, resultat: AvisResultat.JOINT, note: 'Bon de 2 000 F.' })).toBe(
      'Appel · Joint. Bon de 2 000 F.',
    );
    expect(texteSuivi({ ...s, type: AvisSuiviType.WHATSAPP, resultat: AvisResultat.INJOIGNABLE })).toBe(
      'Message WhatsApp · Injoignable.',
    );
    expect(texteSuivi({ ...s, type: AvisSuiviType.NOTE, note: 'À rappeler ce soir.' })).toBe(
      'Note interne. À rappeler ce soir.',
    );
    expect(
      texteSuivi({ ...s, type: AvisSuiviType.STATUT, statut_apres: AvisStatut.RESOLU, solution: AvisSolution.GESTE_COMMERCIAL }),
    ).toBe('Statut « Résolu ». Solution : Geste commercial.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.COMMANDE, meta: { reference: 'CN-A1B2' } })).toBe('Commande CN-A1B2 cochée.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.COMMANDE })).toBe('Commande décochée.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.AGENT, meta: { agent: 'Gbonhi Max' } })).toBe('Agent : Gbonhi Max.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.AGENT })).toBe('Agent retiré.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.INCIDENT, meta: { code: 'QUA-00012' } })).toBe(
      'Incident ouvert : ticket QUA-00012.',
    );
    expect(texteSuivi({ ...s, type: AvisSuiviType.SUPPRESSION })).toBe('Avis supprimé.');
    expect(texteSuivi({ ...s, type: AvisSuiviType.SYSTEME, note: TEXTE_ALERTE })).toBe(TEXTE_ALERTE);
  });

  it('ticket : sujet et premier message, « Manuel » pour une commande par téléphone', () => {
    const a = { created_at: RECU, ressenti: AvisRessenti.PAS_CONTENT, canal: AvisCanal.TELEPHONE, commentaire: 'Frites froides.' };
    expect(sujetTicket(a, 'Yopougon')).toBe('Avis du 02/11 · Pas content · Yopougon');
    expect(messageTicket(a, 'Yopougon')).toBe('Avis du 02/11 · 08:42 (Pas content, Manuel, Yopougon) : Frites froides.');
    expect(sujetTicket(a, null)).toBe('Avis du 02/11 · Pas content · Store inconnu');
  });

  it('cloche : extrait à 80 caractères, échéance ou absence d’accord', () => {
    const long = 'Commande arrivée avec 1 h de retard et les frites froides, la boisson manquait aussi et le livreur';
    const court = extrait(long, 80);
    expect(court.endsWith('…')).toBe(true);
    expect(court.length).toBeLessThanOrEqual(81);
    expect(court.startsWith(long.slice(0, 70))).toBe(true);
    expect(extrait('Frites froides.', 80)).toBe('Frites froides.');

    const contexte = <T>(data: T): NotificationContext<T> => ({
      actor: { id: 'x', type: 'backoffice_user', name: 'x' },
      recipients: [],
      data,
    });
    const pasContent = (echeance: string | null) =>
      AvisPriveNotificationsTemplate.PAS_CONTENT.message(contexte({ nom: 'Awa', store: 'Yopougon', extrait: court, echeance }));
    expect(pasContent('03/11 à 08:42')).toBe(`Awa · Yopougon : « ${court} ». À rappeler avant le 03/11 à 08:42.`);
    expect(pasContent(null)).toBe(`Awa · Yopougon : « ${court} ». Pas d'accord de rappel.`);
    expect(AvisPriveNotificationsTemplate.PAS_CONTENT.title(contexte({ nom: '', store: '', extrait: '', echeance: null }))).toBe(
      'Client pas content',
    );
    expect(
      AvisPriveNotificationsTemplate.RETARD.message(contexte({ nom: 'Awa', store: 'Yopougon', echeance: '03/11 à 08:42' })),
    ).toBe('Awa · Yopougon : rappel promis avant le 03/11 à 08:42.');
  });

  it('aucun tiret cadratin ni demi-cadratin dans les textes du serveur', () => {
    const textes = [
      ...Object.values(LIBELLE_STATUT),
      ...Object.values(LIBELLE_SOLUTION),
      ...Object.values(LIBELLE_RESULTAT),
      ...Object.values(LIBELLE_ACTION),
      ...Object.values(LIBELLE_RESSENTI),
      ...Object.values(LIBELLE_CANAL_SITE),
      ...Object.values(LIBELLE_CANAL_ECRAN),
      ...Object.values(SOURCES),
      ...ENTETES_EXPORT,
      MESSAGE_NUMERO,
      MESSAGE_STORE,
      MESSAGE_PLAFOND_NUMERO,
      MESSAGE_PLAFOND_GLOBAL,
      MESSAGE_PLAFOND_IP,
      MESSAGE_CONFLIT,
      MESSAGE_SOLUTION,
      MESSAGE_INCIDENT_MANUEL,
      MESSAGE_SANS_ACCORD,
      TEXTE_ALERTE,
      TEXTE_RAPPROCHEMENT,
      TEXTE_RETARD,
      texteReception({ rapproche: false, statut: AvisStatut.NOUVEAU, accordRappel: false }),
      AvisPriveNotificationsTemplate.PAS_CONTENT.title({} as never),
      AvisPriveNotificationsTemplate.RETARD.title({} as never),
    ];
    for (const t of textes) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('export CSV', () => {
  it('neutralise une formule en tête de cellule (=, +, -, @, tabulation, retour chariot)', () => {
    expect(celluleCsv('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(celluleCsv('+2250707000001')).toBe(`'+2250707000001`);
    expect(celluleCsv('-1')).toBe(`'-1`);
    expect(celluleCsv('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(celluleCsv('\tx')).toBe(`'\tx`);
    expect(celluleCsv('\rx')).toBe(`"'\rx"`);
    expect(celluleCsv('Yopougon')).toBe('Yopougon');
  });

  it('échappe le point-virgule, les guillemets et les retours à la ligne', () => {
    expect(celluleCsv('a;b')).toBe('"a;b"');
    expect(celluleCsv('il a dit "non"')).toBe('"il a dit ""non"""');
    expect(celluleCsv('ligne 1\nligne 2')).toBe('"ligne 1\nligne 2"');
    expect(celluleCsv(null)).toBe('');
  });

  it('BOM, point-virgule, en-têtes du contrat', () => {
    const texte = versCsv(ENTETES_EXPORT, [['02/11/2026 08:42', 'Pas content']]).toString('utf8');
    expect(texte.startsWith('﻿Reçu le;Ressenti;Prénom;Téléphone;Client rapproché;Store;Canal;Commentaire;')).toBe(true);
    expect(texte.split('\r\n')[1]).toBe('02/11/2026 08:42;Pas content');
    expect(ENTETES_EXPORT).toHaveLength(17);
  });
});
