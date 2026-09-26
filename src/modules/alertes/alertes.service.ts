import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

/**
 * ALERTES OPÉRATIONNELLES — le système parle dans un groupe interne.
 *
 * Aujourd'hui, quand un paiement part de travers, personne n'est prévenu. Il
 * faut qu'un client se plaigne, ou qu'on pense à ouvrir un écran. L'incident du
 * 21/09 l'a montré : des commandes payées sont restées en attente pendant des
 * heures et il a fallu un accès SSH à la production pour comprendre.
 *
 * Une alerte est donc postée dans les groupes marqués « reçoit les alertes ».
 * Ce sont des conversations ordinaires : les membres peuvent y répondre, se
 * répartir le travail, dire que c'est traité. Le fil d'équipe et le signal
 * vivent au même endroit, ce qui est précisément ce qu'on veut d'une main
 * courante.
 *
 * Deux règles de conduite, non négociables :
 *  - ne JAMAIS lever. Une alerte est un effet de bord ; elle ne doit pas faire
 *    échouer le paiement ou la commande qu'elle signale.
 *  - ne JAMAIS inonder. Une panne produit le même incident des dizaines de fois
 *    en quelques minutes, et un canal illisible ne prévient plus personne.
 */

export enum CodeAlerte {
  /** Argent encaissé chez KKiaPay, commande restée en attente. */
  PAIEMENT_NON_CONFIRME = 'PAIEMENT_NON_CONFIRME',
  /** Commande terminée ou livrée sans qu'aucun paiement ne soit enregistré. */
  COMMANDE_SANS_PAIEMENT = 'COMMANDE_SANS_PAIEMENT',
  /** Encaissé strictement inférieur au montant dû. */
  PAIEMENT_PARTIEL = 'PAIEMENT_PARTIEL',
  /** KKiaPay appelle, nous refusons : secret désaligné. */
  WEBHOOK_REFUSE = 'WEBHOOK_REFUSE',
  /** Livraison facturée zéro sans qu'aucune offre ne s'applique. */
  LIVRAISON_GRATUITE_ANORMALE = 'LIVRAISON_GRATUITE_ANORMALE',
  /** Commande en ligne en attente de paiement depuis trop longtemps. */
  COMMANDE_EN_ATTENTE = 'COMMANDE_EN_ATTENTE',
  /** Facturé et base ne se recollent pas par la remise enregistrée. */
  TARIF_LIVRAISON_INCOHERENT = 'TARIF_LIVRAISON_INCOHERENT',
  /** Commande rattachée à un restaurant nettement plus loin que le plus proche. */
  ACHEMINEMENT_SUSPECT = 'ACHEMINEMENT_SUSPECT',
  /** Course exceptionnellement longue. */
  LIVRAISON_TRES_LOIN = 'LIVRAISON_TRES_LOIN',
}

/**
 * Les codes qui viennent de la livraison.
 *
 * Ils partagent un sous-plafond : trois contrôles tournent sur CHAQUE commande,
 * là où les codes de paiement ne parlent qu'en cas d'incident. Sans cette
 * séparation, une grille mal réglée qui ferait crier une commande sur deux
 * consommerait le plafond global et ferait taire les alertes de paiement, qui
 * sont les plus graves.
 */
const FAMILLE_LIVRAISON: ReadonlySet<CodeAlerte> = new Set([
  CodeAlerte.TARIF_LIVRAISON_INCOHERENT,
  CodeAlerte.ACHEMINEMENT_SUSPECT,
  CodeAlerte.LIVRAISON_TRES_LOIN,
  CodeAlerte.LIVRAISON_GRATUITE_ANORMALE,
]);

/** Intitulé lisible, affiché en première ligne du message. */
const TITRES: Record<CodeAlerte, string> = {
  [CodeAlerte.PAIEMENT_NON_CONFIRME]: 'Paiement encaissé, commande NON confirmée',
  [CodeAlerte.COMMANDE_SANS_PAIEMENT]: 'Commande terminée SANS paiement',
  [CodeAlerte.PAIEMENT_PARTIEL]: 'Paiement PARTIEL',
  [CodeAlerte.WEBHOOK_REFUSE]: 'Notifications de paiement refusées',
  [CodeAlerte.LIVRAISON_GRATUITE_ANORMALE]: 'Livraison facturée 0 F sans offre',
  [CodeAlerte.COMMANDE_EN_ATTENTE]: 'Commande en attente de paiement',
  [CodeAlerte.TARIF_LIVRAISON_INCOHERENT]: 'Frais de livraison incohérents',
  [CodeAlerte.ACHEMINEMENT_SUSPECT]: 'Commande partie au mauvais restaurant ?',
  [CodeAlerte.LIVRAISON_TRES_LOIN]: 'Livraison très éloignée',
};

/**
 * Fenêtre de bridage. Un même incident, pour un même restaurant, n'écrit qu'une
 * alerte par fenêtre ; les suivantes sont comptées et annoncées dans la
 * prochaine. Cinq minutes : assez court pour qu'un vrai problème reste visible
 * en continu, assez long pour qu'une panne ne produise pas cent lignes.
 */
const FENETRE_BRIDE_MS = 5 * 60 * 1000;

/**
 * Garde-fou global, toutes alertes confondues, par fenêtre.
 *
 * Porté de 12 à 20 en même temps que les contrôles de livraison : ceux-là
 * s'exécutent sur chaque commande, et le pic mesuré est de 6 commandes par
 * fenêtre de 5 minutes.
 */
const PLAFOND_GLOBAL = 20;

/**
 * Sous-plafond de la famille livraison, par fenêtre.
 *
 * Quoi qu'il arrive côté livraison, il reste donc au moins 16 créneaux pour les
 * alertes de paiement. Un canal saturé par des frais mal calculés ne doit pas
 * masquer un encaissement perdu.
 */
const PLAFOND_LIVRAISON = 4;

/** Au-delà, la table de bridage est purgée : elle ne doit pas enfler sans fin. */
const PLAFOND_CLES = 200;

export interface Alerte {
  code: CodeAlerte;
  /** Restaurant concerné, s'il y en a un. Sert aussi de clé de bridage. */
  restaurant?: string | null;
  /**
   * À défaut du nom, son identifiant : le service ira le chercher. Les
   * appelants ont presque toujours l'un sous la main et jamais l'autre, et on
   * ne va pas faire porter une jointure à chaque endroit qui signale un
   * incident.
   */
  restaurantId?: string | null;
  /** Référence de commande, quand elle est connue. */
  reference?: string | null;
  /** Lignes de détail, une par information utile. */
  details?: (string | null | undefined)[];
  /** Données brutes, conservées dans le message pour un diagnostic ultérieur. */
  meta?: Record<string, unknown>;
  /**
   * Clé de bridage, quand celle par défaut ne convient pas.
   *
   * Par défaut la clé vaut `code:restaurant`, ce qui est juste pour un incident
   * d'infrastructure — une panne KKiaPay doit écrire une ligne, pas une par
   * transaction. C'est faux pour un contrôle qui porte sur UNE commande : deux
   * commandes du même restaurant dans la même fenêtre de cinq minutes se
   * feraient taire l'une l'autre, et 9 % des fenêtres comptent plus d'une
   * commande au même restaurant.
   *
   * Les contrôles par commande passent donc `code:reference`.
   */
  cleBridage?: string;
}

@Injectable()
export class AlertesService {
  private readonly logger = new Logger(AlertesService.name);

  private readonly derniere = new Map<string, { le: number; tues: number }>();
  private fenetreGlobale = { debut: 0, ecrites: 0, livraison: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly appGateway: AppGateway,
  ) {}

  /**
   * Signale un incident. FIRE-AND-FORGET : ne bloque rien, ne lève rien.
   *
   * L'appelant n'a pas à savoir s'il existe un groupe d'alertes, ni si la base
   * répond. Il énonce le problème, c'est tout.
   */
  signaler(alerte: Alerte): void {
    void this.poster(alerte).catch((e) =>
      this.logger.warn(`Alerte non postée (${alerte.code}) : ${(e as Error)?.message}`),
    );
  }

  /** `null` = alerte à taire, une ligne récente couvre déjà ce cas. */
  private brider(cle: string, maintenant: number, code: CodeAlerte): number | null {
    const vu = this.derniere.get(cle);
    if (vu && maintenant - vu.le < FENETRE_BRIDE_MS) {
      vu.tues += 1;
      return null;
    }

    if (maintenant - this.fenetreGlobale.debut >= FENETRE_BRIDE_MS) {
      this.fenetreGlobale = { debut: maintenant, ecrites: 0, livraison: 0 };
    }

    const familleLivraison = FAMILLE_LIVRAISON.has(code);
    const sature =
      this.fenetreGlobale.ecrites >= PLAFOND_GLOBAL ||
      (familleLivraison && this.fenetreGlobale.livraison >= PLAFOND_LIVRAISON);

    if (sature) {
      if (vu) vu.tues += 1;
      // Une clé inconnue perdue au plafond ne serait comptée nulle part : elle
      // n'a pas d'entrée où incrémenter `tues`, et la prochaine alerte de cette
      // clé annoncerait « 0 occurrence tue ». On le journalise au moins.
      else this.logger.warn(`Alerte ${code} perdue : plafond de fenêtre atteint (${cle}).`);
      return null;
    }

    const tues = vu?.tues ?? 0;

    if (!vu && this.derniere.size >= PLAFOND_CLES) {
      for (const [k, v] of this.derniere) {
        if (maintenant - v.le >= FENETRE_BRIDE_MS) this.derniere.delete(k);
      }
      if (this.derniere.size >= PLAFOND_CLES) this.derniere.clear();
    }

    this.derniere.set(cle, { le: maintenant, tues: 0 });
    this.fenetreGlobale.ecrites += 1;
    if (familleLivraison) this.fenetreGlobale.livraison += 1;
    return tues;
  }

  /** Corps du message, tel qu'un humain le lira dans le fil. */
  private composer(alerte: Alerte, tues: number): string {
    const lignes: string[] = [`⚠️ ${TITRES[alerte.code] ?? alerte.code}`];

    const entete = [alerte.reference, alerte.restaurant].filter(Boolean).join(' · ');
    if (entete) lignes.push(entete);

    for (const detail of alerte.details ?? []) {
      if (detail && detail.trim()) lignes.push(detail.trim());
    }

    if (tues > 0) {
      lignes.push(
        `(+ ${tues} incident${tues > 1 ? 's' : ''} identique${tues > 1 ? 's' : ''} dans les minutes précédentes)`,
      );
    }

    return lignes.join('\n');
  }

  private async poster(alerte: Alerte): Promise<void> {
    // Le bridage porte sur l'identifiant quand on l'a : il est stable, là où le
    // nom peut manquer sur un appel et pas sur le suivant.
    const cleRestaurant = alerte.restaurantId ?? alerte.restaurant ?? 'reseau';
    const cle = alerte.cleBridage ?? `${alerte.code}:${cleRestaurant}`;
    const tues = this.brider(cle, Date.now(), alerte.code);
    if (tues === null) return;

    let nomRestaurant = alerte.restaurant ?? null;
    if (!nomRestaurant && alerte.restaurantId) {
      const resto = await this.prisma.restaurant
        .findUnique({ where: { id: alerte.restaurantId }, select: { name: true } })
        .catch(() => null);
      nomRestaurant = resto?.name ?? null;
    }
    const enrichie: Alerte = { ...alerte, restaurant: nomRestaurant };

    const groupes = await this.prisma.conversation.findMany({
      where: { receivesAlerts: true, customerId: null },
      select: { id: true, users: { select: { userId: true } } },
      take: 10,
    });

    if (groupes.length === 0) {
      // Aucun canal configuré : on n'invente pas de destinataire, on trace.
      this.logger.warn(
        `Alerte ${alerte.code} sans destinataire : aucun groupe ne reçoit les alertes.`,
      );
      return;
    }

    const body = this.composer(enrichie, tues);

    for (const groupe of groupes) {
      try {
        const message = await this.prisma.message.create({
          data: {
            conversationId: groupe.id,
            // AUCUN auteur : c'est le système qui parle. Le comptage des non
            // lus vise explicitement ce cas, un test « écrit par un autre que
            // moi » aurait silencieusement ignoré ces messages.
            authorUserId: null,
            authorCustomerId: null,
            body,
            meta: {
              type: 'ALERTE',
              code: alerte.code,
              restaurant: nomRestaurant,
              restaurant_id: alerte.restaurantId ?? null,
              reference: alerte.reference ?? null,
              ...(alerte.meta ?? {}),
            },
          },
          select: { id: true, body: true, meta: true, createdAt: true },
        });

        // La conversation remonte en tête de liste comme pour un vrai message.
        await this.prisma.conversation.update({
          where: { id: groupe.id },
          data: { updatedAt: new Date() },
        });

        const charge = {
          id: message.id,
          conversationId: groupe.id,
          body: message.body,
          meta: message.meta,
          isRead: false,
          authorUser: null,
          authorCustomer: null,
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
          // Même forme que les autres messages : une alerte ne cite rien et
          // ne mentionne personne.
          replyTo: null,
          mentions: [],
        };

        groupe.users.forEach((membre) => {
          this.appGateway.emitToUser(membre.userId, 'user', 'new:message', charge);
        });
      } catch (e) {
        this.logger.warn(
          `Alerte ${alerte.code} non postée dans ${groupe.id} : ${(e as Error)?.message}`,
        );
      }
    }
  }
}
