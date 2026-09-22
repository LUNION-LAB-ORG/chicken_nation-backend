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
}

/** Intitulé lisible, affiché en première ligne du message. */
const TITRES: Record<CodeAlerte, string> = {
  [CodeAlerte.PAIEMENT_NON_CONFIRME]: 'Paiement encaissé, commande NON confirmée',
  [CodeAlerte.COMMANDE_SANS_PAIEMENT]: 'Commande terminée SANS paiement',
  [CodeAlerte.PAIEMENT_PARTIEL]: 'Paiement PARTIEL',
  [CodeAlerte.WEBHOOK_REFUSE]: 'Notifications de paiement refusées',
  [CodeAlerte.LIVRAISON_GRATUITE_ANORMALE]: 'Livraison facturée 0 F sans offre',
  [CodeAlerte.COMMANDE_EN_ATTENTE]: 'Commande en attente de paiement',
};

/**
 * Fenêtre de bridage. Un même incident, pour un même restaurant, n'écrit qu'une
 * alerte par fenêtre ; les suivantes sont comptées et annoncées dans la
 * prochaine. Cinq minutes : assez court pour qu'un vrai problème reste visible
 * en continu, assez long pour qu'une panne ne produise pas cent lignes.
 */
const FENETRE_BRIDE_MS = 5 * 60 * 1000;

/** Garde-fou global, toutes alertes confondues, par fenêtre. */
const PLAFOND_GLOBAL = 12;

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
}

@Injectable()
export class AlertesService {
  private readonly logger = new Logger(AlertesService.name);

  private readonly derniere = new Map<string, { le: number; tues: number }>();
  private fenetreGlobale = { debut: 0, ecrites: 0 };

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
  private brider(cle: string, maintenant: number): number | null {
    const vu = this.derniere.get(cle);
    if (vu && maintenant - vu.le < FENETRE_BRIDE_MS) {
      vu.tues += 1;
      return null;
    }

    if (maintenant - this.fenetreGlobale.debut >= FENETRE_BRIDE_MS) {
      this.fenetreGlobale = { debut: maintenant, ecrites: 0 };
    }
    if (this.fenetreGlobale.ecrites >= PLAFOND_GLOBAL) {
      if (vu) vu.tues += 1;
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
    const tues = this.brider(`${alerte.code}:${cleRestaurant}`, Date.now());
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
