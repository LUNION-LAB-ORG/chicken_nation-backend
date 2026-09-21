import { AuditEntry } from 'src/modules/audit/audit.service';
import { KkiapayWebhookDto } from './kkiapay.type';

/**
 * JOURNALISATION DES PAIEMENTS KKiaPay dans le journal d'audit.
 *
 * Pourquoi ce fichier existe : un paiement qui échoue, ou un webhook que nous
 * refusons, ne laissait aucune trace ailleurs que dans les logs du conteneur.
 * Il fallait un accès SSH à la production pour découvrir qu'un secret était
 * désaligné, et pendant ce temps des commandes payées restaient en attente sans
 * que personne ne puisse le constater depuis le backoffice.
 *
 * Ces entrées rendent visibles, dans Audits → Logs :
 *  - les paiements RÉUSSIS (une ligne par paiement, à la première tentative) ;
 *  - les paiements ÉCHOUÉS chez KKiaPay, avec le motif qu'il nous transmet ;
 *  - les webhooks que nous REFUSONS (secret invalide, secret absent, file
 *    indisponible), qui sont invisibles par ailleurs ;
 *  - les paiements dont le TRAITEMENT échoue chez nous après toutes les
 *    tentatives.
 */

/**
 * Identifiant d'auteur SYNTHÉTIQUE pour KKiaPay.
 *
 * La liste déroulante « auteur » du backoffice est bâtie sur les `actor_id`
 * non nuls (`AuditService.filters`) : sans identifiant, ces lignes existeraient
 * dans la table mais seraient impossibles à isoler d'un clic. Cet UUID ne
 * désigne aucun utilisateur et n'est porteur d'aucune clé étrangère — la table
 * d'audit est dénormalisée à dessein, `actor_name` faisant foi à l'affichage.
 */
export const ACTEUR_KKIAPAY_ID = '00000000-0000-0000-0000-000000000001';
export const ACTEUR_KKIAPAY_NOM = 'KKiaPay';
export const ACTEUR_KKIAPAY_ROLE = 'WEBHOOK';

/** Module du journal : les paiements du personnel y sont déjà, ceux-ci les rejoignent. */
const MODULE = 'paiements';

/**
 * Méthode des lignes issues du TRAITEMENT (hors HTTP).
 *
 * Volontairement différente de POST : la vue « Actions » ne retient que les
 * méthodes de mutation HTTP, ces lignes n'y apparaîtront donc pas et ne
 * diluent pas l'audit métier du personnel. Elles restent entières dans « Logs ».
 */
const METHODE_EVENEMENT = 'EVENEMENT';

/** Montant lisible par un humain : « 12 500 F ». */
const montantLisible = (montant?: number): string =>
  Number.isFinite(montant)
    ? `${Math.round(Number(montant)).toLocaleString('fr-FR').replace(/ | /g, ' ')} F`
    : 'montant inconnu';

/**
 * Informations utiles d'un paiement, pour le détail d'une ligne de journal.
 *
 * Le payload du webhook ne porte PAS le client : l'identité se retrouve par la
 * référence de commande, qui est journalisée. Aucun secret n'y figure non plus,
 * ni le secret de webhook ni les clés du compte.
 */
export const infosPaiement = (payload: Partial<KkiapayWebhookDto>) => ({
  transaction: payload.transactionId ?? null,
  evenement: payload.event ?? null,
  montant: payload.amount ?? null,
  frais: payload.fees ?? null,
  moyen: payload.method ?? null,
  // `stateData` porte la référence de la commande (cf. OrderTask et le listener).
  reference_commande: payload.stateData ?? null,
  libelle: payload.label ?? null,
  compte_encaisseur: payload.restaurantId ?? null,
  effectue_le: payload.performedAt ?? null,
  motif_echec: payload.failureMessage ?? null,
  code_echec: payload.failureCode ?? null,
});

const socle = (payload: Partial<KkiapayWebhookDto>, restaurantId: string | null) => ({
  actor_id: ACTEUR_KKIAPAY_ID,
  actor_name: ACTEUR_KKIAPAY_NOM,
  actor_role: ACTEUR_KKIAPAY_ROLE,
  restaurant_id: restaurantId,
  action: 'OTHER',
  module: MODULE,
  // Recherchable : `AuditService.list` cherche dans `entity_id`, on peut donc
  // retrouver un paiement en tapant son identifiant de transaction.
  entity_id: payload.transactionId ?? null,
});

/**
 * Webhook REFUSÉ à l'entrée : nous n'avons pas pris l'événement.
 *
 * C'est le point aveugle qu'a révélé l'incident du 21/09 : KKiaPay appelait,
 * nous répondions 403 sur un secret désaligné, et rien n'en paraissait au
 * backoffice. Le statut est celui réellement renvoyé, donc supérieur à 400 :
 * la case « Erreurs » de l'écran les isole.
 */
/**
 * BRIDAGE DES REFUS — la route du webhook est PUBLIQUE et sans limitation de
 * débit, et le refus est justement ce qui se produit quand l'appelant n'est pas
 * authentifié. Sans bride, n'importe qui sur Internet ferait grossir la table
 * d'audit à volonté, sous l'identité « KKiaPay », jusqu'à noyer les vraies
 * lignes et remplir le disque : le journal deviendrait l'arme au lieu de l'alarme.
 *
 * On garde donc au plus UNE ligne par compte et par motif toutes les 60 s, en
 * indiquant combien de refus ont été tus depuis la dernière. La valeur de
 * diagnostic est intacte : un secret désaligné produit des refus en continu, il
 * apparaîtra à chaque fenêtre.
 */
const FENETRE_REFUS_MS = 60_000;

/**
 * Plafond de la table de bridage.
 *
 * L'identifiant de restaurant vient de l'URL SANS validation ni normalisation
 * (`@Param('restaurantId')`, aucun ParseUUIDPipe) : un appelant hostile peut le
 * faire varier à chaque requête. Sans plafond, la table grandirait à l'infini et
 * la protection contre l'inondation du journal deviendrait elle-même une fuite
 * mémoire. Au-delà du plafond, on purge les entrées périmées, et si cela ne
 * suffit pas on vide : perdre un compteur ne coûte qu'une ligne de journal en
 * trop, une fuite mémoire coûte le service.
 */
const PLAFOND_BRIDE = 500;

/**
 * Plafond GLOBAL, toutes clés confondues : quoi qu'il arrive, le journal ne
 * recevra pas plus de lignes de refus que ceci par fenêtre. Dernier rempart,
 * indépendant de la forme de la clé. Large devant un incident réel (cinq
 * restaurants, cinq relances par paiement), dérisoire devant une inondation.
 */
const PLAFOND_GLOBAL_PAR_FENETRE = 20;

const dernierRefus = new Map<string, { le: number; tus: number }>();
let fenetreGlobale = { debut: 0, ecrites: 0 };

/** `null` = refus à taire (une ligne récente couvre déjà ce cas, ou plafond atteint). */
const brideRefus = (cle: string, maintenant: number): number | null => {
  const vu = dernierRefus.get(cle);
  if (vu && maintenant - vu.le < FENETRE_REFUS_MS) {
    vu.tus += 1;
    return null;
  }

  // Rempart global, évalué AVANT d'ouvrir une nouvelle fenêtre pour cette clé :
  // une clé qui varie à chaque requête ne doit pas pouvoir écrire sans fin.
  if (maintenant - fenetreGlobale.debut >= FENETRE_REFUS_MS) {
    fenetreGlobale = { debut: maintenant, ecrites: 0 };
  }
  if (fenetreGlobale.ecrites >= PLAFOND_GLOBAL_PAR_FENETRE) {
    if (vu) vu.tus += 1;
    return null;
  }

  const tus = vu?.tus ?? 0;

  if (!vu && dernierRefus.size >= PLAFOND_BRIDE) {
    // Purge des seules entrées périmées. Pas de `clear()` : il jetterait les
    // compteurs des comptes légitimes et rouvrirait leur fenêtre d'écriture.
    for (const [k, v] of dernierRefus) {
      if (maintenant - v.le >= FENETRE_REFUS_MS) dernierRefus.delete(k);
    }
    // Toujours plein : on renonce à mémoriser cette clé plutôt que de laisser la
    // table enfler. Le rempart global reste, lui, en vigueur.
    if (dernierRefus.size >= PLAFOND_BRIDE) {
      fenetreGlobale.ecrites += 1;
      return tus;
    }
  }

  dernierRefus.set(cle, { le: maintenant, tus: 0 });
  fenetreGlobale.ecrites += 1;
  return tus;
};

export const journalRefusWebhook = (params: {
  payload: Partial<KkiapayWebhookDto>;
  restaurantId: string | null;
  statut: number;
  motif: string;
  path: string;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Le compte est-il RECONNU chez nous (un secret existe pour cet identifiant) ?
   *
   * Décisif pour la bride. L'identifiant de restaurant vient de l'URL sans
   * validation : le garder dans la clé quand il n'est reconnu de personne
   * suffirait à contourner toute limite, un segment d'adresse au hasard donnant
   * une clé neuve, donc une ligne, à chaque requête. Les comptes inconnus
   * partagent donc UNE seule clé. À l'inverse, un 403 ne survient que sur un
   * compte configuré : l'espace de clés y est borné par le nombre de
   * restaurants, et l'identifiant garde toute sa valeur de diagnostic.
   */
  compteReconnu: boolean;
  maintenant?: number;
}): AuditEntry | null => {
  const cle = params.compteReconnu
    ? `${params.restaurantId ?? 'global'}:${params.statut}`
    : `inconnu:${params.statut}`;
  const tus = brideRefus(cle, params.maintenant ?? Date.now());
  if (tus === null) return null;
  return {
    ...socle(params.payload, params.restaurantId),
    method: 'POST',
    path: params.path,
    status_code: params.statut,
    ip: params.ip ?? null,
    user_agent: params.userAgent ?? null,
    summary:
      `Webhook KKiaPay refusé — ${params.motif}` +
      (tus > 0 ? ` (et ${tus} autre${tus > 1 ? 's' : ''} refus identique${tus > 1 ? 's' : ''} dans la minute précédente)` : ''),
    metadata: {
      ...infosPaiement(params.payload),
      motif_refus: params.motif,
      refus_tus_depuis_la_derniere_ligne: tus,
    },
  };
};

/**
 * Paiement encaissé ET commande confirmée. Écrite APRÈS le traitement, jamais
 * avant : le corps du webhook n'est pas la source de vérité, le code le
 * revérifie auprès de KKiaPay et contrôle que le montant couvre la commande.
 * Annoncer « réussi » sur la seule foi du payload afficherait en vert des
 * commandes restées en attente.
 */
export const journalPaiementConfirme = (payload: KkiapayWebhookDto): AuditEntry => ({
  ...socle(payload, payload.restaurantId ?? null),
  method: METHODE_EVENEMENT,
  path: `/kkiapay/webhook/${payload.restaurantId ?? 'global'}`,
  status_code: 200,
  summary:
    `Paiement encaissé et commande confirmée — ${montantLisible(payload.amount)} par ${payload.method}` +
    (payload.stateData ? `, commande ${payload.stateData}` : ''),
  metadata: infosPaiement(payload),
});

/**
 * Paiement encaissé mais commande NON confirmée : le traitement a renoncé
 * délibérément (commande introuvable, transaction démentie par KKiaPay, montant
 * qui ne couvre pas la commande). Aucune exception n'est levée dans ce cas, donc
 * sans cette ligne l'incident serait parfaitement invisible.
 *
 * Statut 409 : au-dessus de 400, donc présent sous le filtre « Erreurs », là où
 * le gérant cherche ce qui appelle une action.
 */
export const journalPaiementNonConfirme = (
  payload: KkiapayWebhookDto,
  motif?: string,
): AuditEntry => ({
  ...socle(payload, payload.restaurantId ?? null),
  method: METHODE_EVENEMENT,
  path: `/kkiapay/webhook/${payload.restaurantId ?? 'global'}`,
  status_code: 409,
  summary:
    `Paiement encaissé mais commande NON confirmée — ${montantLisible(payload.amount)}` +
    (payload.stateData ? `, commande ${payload.stateData}` : '') +
    ` — ${motif ?? 'motif non précisé'}`,
  metadata: { ...infosPaiement(payload), motif_non_confirmation: motif ?? null },
});

/**
 * Paiement REFUSÉ par KKiaPay (le client n'a pas payé).
 *
 * Statut 402 « Payment Required » : le code dit la nature de l'événement, et
 * étant supérieur à 400 il fait apparaître la ligne sous le filtre « Erreurs »,
 * là où le gérant va chercher ce qui n'a pas marché.
 */
export const journalPaiementEchoue = (payload: KkiapayWebhookDto): AuditEntry => ({
  ...socle(payload, payload.restaurantId ?? null),
  method: METHODE_EVENEMENT,
  path: `/kkiapay/webhook/${payload.restaurantId ?? 'global'}`,
  status_code: 402,
  summary:
    `Paiement échoué — ${montantLisible(payload.amount)} par ${payload.method}` +
    (payload.stateData ? `, commande ${payload.stateData}` : '') +
    (payload.failureMessage ? ` — ${payload.failureMessage}` : ''),
  metadata: infosPaiement(payload),
});

/**
 * Le paiement est bon chez KKiaPay mais NOTRE traitement a échoué, toutes
 * tentatives épuisées. La commande ne sera pas confirmée sans intervention :
 * c'est la ligne la plus importante du lot.
 */
export const journalTraitementEnEchec = (
  payload: KkiapayWebhookDto,
  tentatives: number,
  message: string,
): AuditEntry => ({
  ...socle(payload, payload.restaurantId ?? null),
  method: METHODE_EVENEMENT,
  path: `/kkiapay/webhook/${payload.restaurantId ?? 'global'}`,
  status_code: 500,
  summary:
    `Paiement encaissé mais NON traité après ${tentatives} tentatives — ` +
    `${montantLisible(payload.amount)}` +
    (payload.stateData ? `, commande ${payload.stateData}` : '') +
    ` — ${message}`,
  metadata: { ...infosPaiement(payload), tentatives, erreur: message },
});
