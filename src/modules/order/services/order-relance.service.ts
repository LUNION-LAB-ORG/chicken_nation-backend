import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EntityStatus, OrderStatus, PaymentMethod, Prisma, User, UserRole } from '@prisma/client';
import { ACTEUR_KKIAPAY_ID } from 'src/kkiapay/kkiapay-audit.helper';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { commandeEffective } from 'src/modules/crm/crm.rules';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import {
  RELANCABLE_WHERE,
  estBrouillon,
  estPanierAnnuleParClient,
  estRelancable,
  peutVoirLesBrouillons,
} from '../helpers/brouillons.rules';
import { MESSAGE_TRANSACTION_ILLISIBLE, lireTransactionKkiapay } from '../helpers/confirmation-paiement.rules';
import { A_CONFIRMER_WHERE, estAConfirmer, siteOuRepere } from '../helpers/paiement-livraison.rules';
import { resolveRestaurantScope } from '../helpers/restaurant-scope.helper';
import {
  ACTIONS_JOURNAL_RELANCE,
  MotifRelanceChanged,
  RELANCE_SOCKET_EVENT,
  RelanceChangedPayload,
} from '../relance/relance.events';
import {
  BrouillonLu,
  Classement,
  CommandeEffectiveLue,
  GroupeClasse,
  IGNOREES_HEURES,
  MAX_BROUILLONS_LUS,
  RAISONS_IGNORER,
  RELANCE_SETTINGS,
  ReglesRelance,
  classerBrouillons,
  cleTelephoneCommande,
  groupeDeLaCommande,
  libelleRaison,
  lireRegles,
  messageSortie,
  motifSortie,
  nomClient,
} from '../relance/relance.rules';

/** Mémoire des réglages : une lecture de la table `Setting` toutes les 30 s au plus. */
const DUREE_MEMOIRE_REGLES_MS = 30_000;
const MINUTE = 60_000;

const MESSAGE_ROLE = "Accès réservé au centre d'appels et aux administrateurs.";
const MESSAGE_INTROUVABLE = 'Commande introuvable.';
const MESSAGE_IGNOREE = "Cette commande est ignorée : rétablissez-la d'abord.";
const MESSAGE_DEJA_IGNOREE = 'Cette commande est déjà ignorée.';
const MESSAGE_A_RECHARGER = 'Cette commande vient de changer : rechargez la liste.';
const MESSAGE_A_CONFIRMER_NON_IGNORABLE =
  "Une commande à payer à la livraison ne s'ignore pas\u00a0: transmettez-la au restaurant avec " +
  '«\u00a0Reprendre au téléphone\u00a0», ou annulez-la.';
const MESSAGE_DEJA_ANNULEE_PAR_CLIENT = 'Le client a déjà annulé cette commande.';
const MESSAGE_NON_ANNULABLE = "Seule une commande à payer à la livraison s'annule ici.";
const MESSAGE_PAIEMENT_A_LA_LIVRAISON =
  "Une commande à payer à la livraison n'a aucun paiement en ligne à confirmer : transmettez-la avec " +
  '« Reprendre au téléphone ».';
const MESSAGE_PAIEMENT_PANIER_ANNULE =
  "Le client a annulé ce panier : seul un panier en attente de paiement se confirme ici.";

/** Transactions signalées lues au plus par lecture de la liste. */
const MAX_PAIEMENTS_SIGNALES_LUS = 100;

/** Ce qu'on lit d'un brouillon pour le classer et l'afficher. */
const SELECT_BROUILLON = {
  id: true,
  reference: true,
  created_at: true,
  customer_id: true,
  restaurant_id: true,
  fullname: true,
  phone: true,
  type: true,
  amount: true,
  customer: { select: { phone: true, first_name: true, last_name: true } },
  restaurant: { select: { id: true, name: true } },
  paiements: { select: { status: true, amount: true, total: true, created_at: true } },
  // État : distingue un panier annulé par le client d'un panier en attente.
  auto: true,
  status: true,
  paied: true,
  payment_method: true,
  entity_status: true,
  cancelled_by: true,
  cancelled_at: true,
  // Canal (02/10) : le backoffice signale un panier du site, que l'agent ne
  // reprend pas avec les mêmes mots qu'un panier de l'application.
  channel: true,
  // Repère « à confirmer » (26/11) : une commande de l'application à payer à
  // la réception attend l'appel, comme celle du site.
  a_confirmer: true,
  relance: {
    select: {
      alerte_le: true,
      pris_par_id: true,
      pris_le: true,
      prise_expire_le: true,
      ignore_le: true,
      pris_par: { select: { id: true, fullname: true } },
    },
  },
} satisfies Prisma.OrderSelect;

/** Ce qu'on lit d'une commande avant un geste d'agent. */
const SELECT_COMMANDE = {
  id: true,
  reference: true,
  restaurant_id: true,
  auto: true,
  status: true,
  paied: true,
  payment_method: true,
  entity_status: true,
  cancelled_by: true,
  created_at: true,
  // Obligatoire depuis le 19/10 : sans le canal, une commande du site à
  // confirmer n'est pas reconnue (`estAConfirmer`) et chaque geste répond 409.
  channel: true,
  // De même depuis le 26/11 pour une commande de l'application à confirmer.
  a_confirmer: true,
} satisfies Prisma.OrderSelect;

type CommandeLue = Prisma.OrderGetPayload<{ select: typeof SELECT_COMMANDE }>;

// ---------------------------------------------------------------------------
// Formes renvoyées au backoffice (contrat de `GET /orders/relances`)
// ---------------------------------------------------------------------------

export interface BrouillonLigne {
  id: string;
  reference: string;
  created_at: string;
  client_nom: string;
  telephone: string | null;
  restaurant: { id: string; name: string };
  type: string;
  amount: number;
  paiement_refuse: boolean;
  /** Panier annulé par le client dans l'application, sans avoir payé (01/10). */
  annulee_par_client: boolean;
  /**
   * `Order.channel` tel quel (APP, WEB...), `null` pour une commande antérieure
   * au canal (02/10). Le backoffice en tire la pastille « Site web ».
   */
  channel: string | null;
  /**
   * Commande du site à payer au livreur (WEB et OFFLINE, 19/10), à confirmer
   * ou annulée par le client. Le backoffice en tire la pastille « À la livraison ».
   */
  paiement_a_la_livraison: boolean;
}

/**
 * Transaction KKiaPay réussie qu'un webhook a apportée pour un panier du
 * groupe, sans confirmer la commande (refusé à l'entrée, abandonné par le
 * traitement, ou en échec après toutes ses tentatives). Lue dans le journal
 * d'audit (`kkiapay-audit.helper.ts`) : le client a sans doute payé, l'agent
 * confirme le paiement sans lui demander l'identifiant (14/11).
 */
export interface PaiementSignale {
  /** Panier visé : la tête ou l'un des autres paniers du groupe. */
  order_id: string;
  reference: string;
  transaction_id: string;
  /** Montant annoncé par le webhook ; seul KKiaPay fait foi, à la confirmation. */
  montant: number | null;
  /** PaiementMode annoncé (MOBILE_MONEY, CARD, WALLET). */
  moyen: string | null;
  /** Instant de la ligne du journal (ISO). */
  le: string;
  /** Pourquoi le webhook n'a rien confirmé, tel que le journal le dit. */
  motif: string | null;
}

export interface GroupeRelance {
  cle: string;
  etat: 'A_RELANCER' | 'PRIS' | 'EN_COURS';
  /** La tête est une commande du site à payer à la livraison, à confirmer (19/10). */
  a_confirmer: boolean;
  tete: BrouillonLigne;
  autres: BrouillonLigne[];
  alerte_le: string | null;
  prise: { par: { id: string; fullname: string }; le: string | null; expire_le: string; par_moi: boolean } | null;
  signaux: {
    paiement_refuse: boolean;
    paiement_partiel: { reference: string; recu: number; montant: number; libelle: string } | null;
    /**
     * Commande effective du même client, peu avant : doublon probable.
     * `payee` : elle est payée ; sinon (espèces, à payer à la livraison),
     * l'écran ne parle pas de paiement.
     */
    commande_recente: { reference: string; created_at: string; payee: boolean } | null;
    /** Date d'annulation (ISO) de la tête, ou du panier annulé le plus récent du groupe. */
    annulee_par_client: { le: string } | null;
    /** Tête à confirmer : commande effective du même client créée après elle (doublon possible). */
    commande_suivante: { reference: string; created_at: string } | null;
    /**
     * Tête à confirmer : un autre panier du groupe se paie peut-être en ligne
     * en ce moment (créé ou paiement lancé il y a moins de `delai_minutes`).
     * `jusqua` en ISO.
     */
    paiement_en_ligne_en_cours: { reference: string; jusqua: string } | null;
    /**
     * Paiement signalé sur la tête, sinon sur le premier autre panier qui en
     * a un ; pour un panier, la transaction la plus récente (14/11).
     */
    paiement_signale: PaiementSignale | null;
  };
  crm: { contact_id: string; statut: string; agent: string | null } | null;
}

export interface RelancesReponse {
  maintenant: string;
  regles: { delai_minutes: number; fenetre_heures: number; duree_prise_minutes: number; rappel_minutes: number };
  prochaine_echeance: string | null;
  compteurs: {
    a_relancer: number;
    pris: number;
    pris_par_moi: number;
    en_cours: number;
    ignorees: number;
    /** Groupes à relancer ou pris dont la tête est une commande à confirmer (19/10). */
    a_confirmer: number;
  };
  groupes: GroupeRelance[];
}

export interface IgnoreeLigne extends BrouillonLigne {
  ignore_par: { id: string; fullname: string } | null;
  ignore_le: string;
  raison_code: string;
  raison_libelle: string;
  raison_texte: string | null;
  encore_en_attente: boolean;
  /**
   * Annulée depuis (par un agent, ou en l'ignorant du 23 au 25/11, quand
   * ignorer annulait) : plus rien à rétablir. Ignorer, lui, n'annule plus.
   */
  annulee: boolean;
}

const montantFormate = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} F`;

function ligne(b: BrouillonLu): BrouillonLigne {
  return {
    id: b.id,
    reference: b.reference,
    created_at: b.created_at.toISOString(),
    client_nom: nomClient(b),
    telephone: b.phone?.trim() || b.customer?.phone?.trim() || null,
    restaurant: { id: b.restaurant?.id ?? b.restaurant_id, name: b.restaurant?.name ?? '' },
    type: b.type,
    amount: b.amount,
    paiement_refuse: (b.paiements ?? []).some((p) => p.status === 'FAILED'),
    annulee_par_client: estPanierAnnuleParClient(b),
    channel: b.channel ?? null,
    // À payer à la réception et à confirmer : du site, ou de l'application
    // quand le réglage demande une confirmation (26/11).
    paiement_a_la_livraison: b.payment_method === PaymentMethod.OFFLINE && siteOuRepere(b),
  };
}

/**
 * RELANCE DES COMMANDES EN ATTENTE (paniers de l'application non payés, et
 * depuis le 19/10 commandes du site à payer à la livraison, à confirmer).
 *
 * Lecture : tout passe par `classerBrouillons`, jamais par un compteur tenu à
 * jour. Gestes d'agent : écritures conditionnées dans une transaction, sur les
 * identifiants TRIÉS du groupe (deux gestes concurrents prennent les verrous de
 * ligne dans le même ordre, aucun interblocage) ; une condition qui échoue
 * annule tout le groupe.
 */
@Injectable()
export class OrderRelanceService {
  private readonly logger = new Logger(OrderRelanceService.name);
  private memoireRegles: { regles: ReglesRelance; expire: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly appGateway: AppGateway,
    // Facultatif : seule la réactivation d'un panier annulé l'emploie, et les
    // tests montent le service sans lui.
    @Optional() private readonly audit?: AuditService,
  ) {}

  // =========================================================================
  // Réglages et lectures communes
  // =========================================================================

  /** Réglages, gardés 30 s en mémoire. Une base injoignable donne les défauts. */
  async regles(): Promise<ReglesRelance> {
    const maintenant = Date.now();
    if (this.memoireRegles && this.memoireRegles.expire > maintenant) return this.memoireRegles.regles;
    try {
      const valeurs = await this.settings.getMany(Object.values(RELANCE_SETTINGS));
      const regles = lireRegles(valeurs);
      this.memoireRegles = { regles, expire: maintenant + DUREE_MEMOIRE_REGLES_MS };
      return regles;
    } catch (e) {
      this.logger.warn(`Réglages de relance illisibles, valeurs par défaut : ${(e as Error)?.message}`);
      return lireRegles({});
    }
  }

  /**
   * Brouillons de la fenêtre et commandes effectives qui peuvent les
   * contredire. La seconde lecture est bornée aux clients des brouillons lus
   * (comptes et fins de numéro) : jamais toutes les commandes du réseau.
   * Les commandes à confirmer sont lues quel que soit leur âge : la fenêtre
   * ne les sort jamais de la liste (19/10).
   */
  async lireBrouillons(
    restaurantId: string | undefined,
    maintenant: Date,
    regles: ReglesRelance,
  ): Promise<{ brouillons: BrouillonLu[]; effectives: CommandeEffectiveLue[] }> {
    const debutFenetre = new Date(maintenant.getTime() - regles.fenetre_heures * 60 * MINUTE);
    const brouillons: BrouillonLu[] = await this.prisma.order.findMany({
      where: {
        AND: [
          RELANCABLE_WHERE,
          { OR: [{ created_at: { gte: debutFenetre } }, A_CONFIRMER_WHERE] },
          ...(restaurantId ? [{ restaurant_id: restaurantId }] : []),
        ],
      },
      select: SELECT_BROUILLON,
      orderBy: { created_at: 'desc' },
      take: MAX_BROUILLONS_LUS,
    });
    if (brouillons.length >= MAX_BROUILLONS_LUS) {
      this.logger.warn(
        `Relance : ${MAX_BROUILLONS_LUS} brouillons lus ou plus dans la fenêtre, les plus anciens sont ignorés.`,
      );
    }
    if (brouillons.length === 0) return { brouillons, effectives: [] };

    const comptes = [...new Set(brouillons.map((b) => b.customer_id).filter((v): v is string => !!v))];
    const cles = [
      ...new Set(brouillons.map((b) => cleTelephoneCommande(b)).filter((v): v is string => !!v)),
    ];
    const plusAncien = brouillons.reduce(
      (min, b) => (b.created_at < min ? b.created_at : min),
      brouillons[0].created_at,
    );

    const effectives: CommandeEffectiveLue[] = await this.prisma.order.findMany({
      where: {
        AND: [
          commandeEffective(),
          { status: { not: OrderStatus.CANCELLED } },
          { created_at: { gte: new Date(plusAncien.getTime() - regles.recente_minutes * MINUTE) } },
          {
            OR: [
              ...(comptes.length ? [{ customer_id: { in: comptes } }] : []),
              ...cles.flatMap((cle) => [
                { phone: { endsWith: cle } },
                { customer: { phone: { endsWith: cle } } },
              ]),
            ],
          },
        ],
      },
      select: {
        id: true,
        reference: true,
        created_at: true,
        status: true,
        // Le signal « commande récente » dit si elle est payée.
        paied: true,
        customer_id: true,
        phone: true,
        customer: { select: { phone: true } },
      },
    });
    return { brouillons, effectives };
  }

  // =========================================================================
  // Lectures
  // =========================================================================

  async lister(user: User, restaurantIdDemande?: string): Promise<RelancesReponse> {
    this.verifierRole(user);
    const scope = resolveRestaurantScope(user, restaurantIdDemande);
    const maintenant = new Date();
    const regles = await this.regles();
    const { brouillons, effectives } = await this.lireBrouillons(scope, maintenant, regles);
    const classement = classerBrouillons({ brouillons, effectives, maintenant, regles, moi: user.id });

    const [crm, ignorees, signales] = await Promise.all([
      this.lireCrm(classement.groupes.map((g) => g.tete.customer_id)),
      this.prisma.orderRelance.count({
        where: {
          ignore_le: { gte: new Date(maintenant.getTime() - IGNOREES_HEURES * 60 * MINUTE) },
          ...(scope ? { order: { restaurant_id: scope } } : {}),
        },
      }),
      this.lirePaiementsSignales(classement.groupes.flatMap((g) => [g.tete, ...g.autres])),
    ]);

    const compter = (filtre: (g: GroupeClasse) => boolean) => classement.groupes.filter(filtre).length;
    return {
      maintenant: maintenant.toISOString(),
      regles: {
        delai_minutes: regles.delai_minutes,
        fenetre_heures: regles.fenetre_heures,
        duree_prise_minutes: regles.duree_prise_minutes,
        rappel_minutes: regles.rappel_minutes,
      },
      prochaine_echeance: classement.prochaineEcheance?.toISOString() ?? null,
      compteurs: {
        a_relancer: compter((g) => g.etat === 'A_RELANCER'),
        pris: compter((g) => g.etat === 'PRIS'),
        pris_par_moi: compter((g) => g.etat === 'PRIS' && !!g.prise?.par_moi),
        en_cours: compter((g) => g.etat === 'EN_COURS'),
        ignorees,
        a_confirmer: compter((g) => g.a_confirmer && (g.etat === 'A_RELANCER' || g.etat === 'PRIS')),
      },
      groupes: classement.groupes.map((g) => this.versGroupeRelance(g, crm, signales)),
    };
  }

  /** Commandes ignorées depuis 24 h, plus récentes d'abord. */
  async listerIgnorees(user: User, restaurantIdDemande?: string): Promise<{ items: IgnoreeLigne[] }> {
    this.verifierRole(user);
    const scope = resolveRestaurantScope(user, restaurantIdDemande);
    const depuis = new Date(Date.now() - IGNOREES_HEURES * 60 * MINUTE);
    const lignes = await this.prisma.orderRelance.findMany({
      where: {
        ignore_le: { gte: depuis },
        ...(scope ? { order: { restaurant_id: scope } } : {}),
      },
      orderBy: { ignore_le: 'desc' },
      take: 200,
      select: {
        ignore_le: true,
        raison_code: true,
        raison_texte: true,
        ignore_par: { select: { id: true, fullname: true } },
        order: { select: { ...SELECT_BROUILLON, relance: false } },
      },
    });
    return {
      items: lignes.map((l) => ({
        ...ligne(l.order),
        ignore_par: l.ignore_par,
        ignore_le: l.ignore_le!.toISOString(),
        raison_code: l.raison_code ?? 'AUTRE',
        raison_libelle: libelleRaison(l.raison_code),
        raison_texte: l.raison_texte,
        // Encore relançable : en attente, ou annulée par le client.
        encore_en_attente: estRelancable(l.order),
        annulee: l.order.status === OrderStatus.CANCELLED && !estPanierAnnuleParClient(l.order),
      })),
    };
  }

  // =========================================================================
  // Gestes d'agent
  // =========================================================================

  /** « Je m'en occupe » : tout le groupe, pour la durée de prise. */
  async prendre(orderId: string, user: User): Promise<{ groupe: GroupeRelance | null }> {
    this.verifierRole(user);
    const maintenant = new Date();
    const regles = await this.regles();
    const { groupe } = await this.situation(orderId, user, maintenant, regles);
    if (!groupe || groupe.ignores.includes(orderId)) throw new ConflictException(MESSAGE_IGNOREE);
    if (groupe.etat === 'EN_COURS') {
      const reste = Math.max(1, Math.ceil(((groupe.echeance?.getTime() ?? 0) - maintenant.getTime()) / MINUTE));
      throw new ConflictException(`Le client est peut-être en train de payer : attendez ${reste} min.`);
    }
    if (groupe.etat === 'PRIS' && groupe.prise && !groupe.prise.par_moi) {
      throw new ConflictException(`Déjà prise par ${groupe.prise.par_nom}.`);
    }

    const expire = new Date(maintenant.getTime() + regles.duree_prise_minutes * MINUTE);
    await this.prisma.$transaction(async (tx) => {
      await tx.orderRelance.createMany({
        data: groupe.ids.map((order_id) => ({ order_id })),
        skipDuplicates: true,
      });
      for (const order_id of groupe.ids) {
        const { count } = await tx.orderRelance.updateMany({
          where: {
            order_id,
            ignore_le: null,
            OR: [{ pris_par_id: null }, { pris_par_id: user.id }, { prise_expire_le: { lte: maintenant } }],
          },
          data: { pris_par_id: user.id, pris_le: maintenant, prise_expire_le: expire },
        });
        if (count !== 1) throw new ConflictException(await this.messageRefus(tx, order_id, 'prendre'));
      }
      await tx.orderRelanceJournal.createMany({
        data: groupe.ids.map((order_id) => ({
          order_id,
          action: ACTIONS_JOURNAL_RELANCE.PRISE,
          user_id: user.id,
        })),
      });
    });
    this.signaler('prise', groupe.ids, user.id);
    return { groupe: await this.groupeAJour(orderId, user) };
  }

  /** Libérer la prise : la sienne, ou celle de n'importe qui pour un administrateur. */
  async liberer(orderId: string, user: User): Promise<{ ok: true }> {
    this.verifierRole(user);
    const maintenant = new Date();
    const regles = await this.regles();
    const { groupe } = await this.situation(orderId, user, maintenant, regles);
    // Groupe entièrement ignoré : l'ignorance a déjà effacé la prise.
    if (!groupe) return { ok: true };
    const admin = user.role === UserRole.ADMIN;
    if (groupe.prise && !groupe.prise.par_moi && !admin) {
      throw new ConflictException(`${groupe.prise.par_nom} s'occupe de cette commande : lui seul peut la libérer.`);
    }

    const liberes: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const order_id of groupe.ids) {
        const { count } = await tx.orderRelance.updateMany({
          where: { order_id, pris_par_id: admin ? { not: null } : user.id },
          data: { pris_par_id: null, pris_le: null, prise_expire_le: null },
        });
        if (count === 1) liberes.push(order_id);
      }
      if (liberes.length) {
        await tx.orderRelanceJournal.createMany({
          data: liberes.map((order_id) => ({
            order_id,
            action: ACTIONS_JOURNAL_RELANCE.LIBERATION,
            user_id: user.id,
          })),
        });
      }
    });
    if (liberes.length) this.signaler('liberation', liberes, user.id);
    return { ok: true };
  }

  /**
   * « Ignorer » pour toute l'équipe, avec une raison. Efface la prise.
   *
   * La commande N'EST PAS annulée : elle reste en attente, hors des alertes,
   * et se rétablit depuis « Ignorées » (décision du 25/11 ; du 23 au 25/11,
   * ignorer l'annulait).
   */
  async ignorer(
    orderId: string,
    corps: { raison_code: string; raison_texte?: string | null },
    user: User,
  ): Promise<{ ok: true; nombre: number }> {
    this.verifierRole(user);
    const texte = this.lireRaison(corps);

    const maintenant = new Date();
    const regles = await this.regles();
    const { groupe } = await this.situation(orderId, user, maintenant, regles);
    if (!groupe) throw new ConflictException(MESSAGE_DEJA_IGNOREE);
    // Ignorée, une commande à confirmer attendrait pour toujours : le client
    // verrait « À confirmer » sans fin. Elle se transmet ou s'annule (19/10).
    if (groupe.a_confirmer) throw new ConflictException(MESSAGE_A_CONFIRMER_NON_IGNORABLE);
    const admin = user.role === UserRole.ADMIN;
    if (groupe.prise && !groupe.prise.par_moi && !admin) {
      throw new ConflictException(`${groupe.prise.par_nom} s'occupe de cette commande : laissez-le conclure.`);
    }

    const raisonJournal = `${libelleRaison(corps.raison_code)}${texte ? ` : ${texte}` : ''}`.slice(0, 200);
    await this.prisma.$transaction(async (tx) => {
      await tx.orderRelance.createMany({
        data: groupe.ids.map((order_id) => ({ order_id })),
        skipDuplicates: true,
      });
      for (const order_id of groupe.ids) {
        const { count } = await tx.orderRelance.updateMany({
          where: {
            order_id,
            ignore_le: null,
            ...(admin
              ? {}
              : {
                  OR: [{ pris_par_id: null }, { pris_par_id: user.id }, { prise_expire_le: { lte: maintenant } }],
                }),
          },
          data: {
            ignore_par_id: user.id,
            ignore_le: maintenant,
            raison_code: corps.raison_code,
            raison_texte: texte,
            pris_par_id: null,
            pris_le: null,
            prise_expire_le: null,
          },
        });
        if (count !== 1) throw new ConflictException(await this.messageRefus(tx, order_id, 'ignorer'));
      }
      await tx.orderRelanceJournal.createMany({
        data: groupe.ids.map((order_id) => ({
          order_id,
          action: ACTIONS_JOURNAL_RELANCE.IGNORE,
          user_id: user.id,
          raison: raisonJournal,
        })),
      });
    });
    this.signaler('ignore', groupe.ids, user.id);
    return { ok: true, nombre: groupe.ids.length };
  }

  /**
   * Rétablir dans les relances. Idempotent. `alerte_le` est conservé : une
   * commande déjà alertée ne sonne pas de nouveau. Accepté même hors de la
   * fenêtre (la commande ne sera simplement plus alertée).
   */
  async retablir(
    orderId: string,
    user: User,
  ): Promise<{ ok: true; hors_fenetre: boolean; encore_en_attente: boolean }> {
    this.verifierRole(user);
    const commande = await this.chargerCommande(orderId, user);
    const maintenant = new Date();
    const regles = await this.regles();
    const horsFenetre = commande.created_at.getTime() < maintenant.getTime() - regles.fenetre_heures * 60 * MINUTE;
    const enAttente = estRelancable(commande);

    // Le groupe du client, s'il est encore suivi ; sinon la seule commande.
    let ids = [orderId];
    if (enAttente && !horsFenetre) {
      const { brouillons, effectives } = await this.lireBrouillons(commande.restaurant_id, maintenant, regles);
      const trouve = groupeDeLaCommande(
        classerBrouillons({ brouillons, effectives, maintenant, regles, moi: user.id }),
        orderId,
      );
      if (trouve) ids = trouve.visible ? trouve.visible.ignores : trouve.ignore.ignores;
      if (!ids.includes(orderId)) ids = [...ids, orderId];
    }
    ids = [...new Set(ids)].sort();

    const retablis: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const order_id of ids) {
        const { count } = await tx.orderRelance.updateMany({
          where: { order_id, ignore_le: { not: null } },
          data: { ignore_par_id: null, ignore_le: null, raison_code: null, raison_texte: null },
        });
        if (count === 1) retablis.push(order_id);
      }
      if (retablis.length) {
        await tx.orderRelanceJournal.createMany({
          data: retablis.map((order_id) => ({
            order_id,
            action: ACTIONS_JOURNAL_RELANCE.RETABLISSEMENT,
            user_id: user.id,
          })),
        });
      }
    });
    if (retablis.length) this.signaler('retablissement', retablis, user.id);
    return { ok: true, hors_fenetre: horsFenetre, encore_en_attente: enAttente };
  }

  /**
   * Reprise au téléphone (bascule de l'application vers le personnel, dans
   * `OrderService.update`) : la prise s'efface, le journal le garde, les
   * agents relisent leur liste. Ne lève jamais : la relance ne doit pas faire
   * échouer la modification d'une commande.
   */
  async noterReprise(orderId: string, userId: string | null, raison?: string | null): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.orderRelance.updateMany({
          where: { order_id: orderId },
          data: { pris_par_id: null, pris_le: null, prise_expire_le: null },
        }),
        this.prisma.orderRelanceJournal.create({
          data: {
            order_id: orderId,
            action: ACTIONS_JOURNAL_RELANCE.REPRISE,
            user_id: userId,
            ...(raison ? { raison: raison.slice(0, 200) } : {}),
          },
        }),
      ]);
    } catch (e) {
      this.logger.warn(`Relance : reprise de ${orderId} non journalisée : ${(e as Error)?.message}`);
    }
    this.signaler('reprise', [orderId], userId ?? undefined);
  }

  // =========================================================================
  // Commandes du site à payer à la livraison (19/10)
  // =========================================================================

  /**
   * Avant « Annuler la commande » (`POST /orders/relances/:orderId/annuler`) :
   * seule une commande du site à confirmer s'annule ici, et pas pendant qu'un
   * collègue l'a en main, sauf pour un administrateur. Lève 400 (raison), 403,
   * 404 ou 409 avec le motif. Renvoie la raison telle qu'elle s'écrit au
   * journal et dans le motif d'annulation de la commande.
   *
   * L'annulation elle-même est une écriture conditionnée
   * (`OrderService.updateStatus`, `conditionEcriture`) : si un collègue la
   * reprend au téléphone entre ce contrôle et l'écriture, la reprise
   * l'emporte et l'annulation répond 409.
   */
  async verifierAnnulable(
    orderId: string,
    corps: { raison_code: string; raison_texte?: string | null },
    user: User,
  ): Promise<string> {
    this.verifierRole(user);
    const texte = this.lireRaison(corps);

    const maintenant = new Date();
    const regles = await this.regles();
    // Plus relançable (reprise, confirmée, annulée par un agent...) : 409 avec
    // le motif, lu par `situation` comme pour tout autre geste.
    const { commande, groupe } = await this.situation(orderId, user, maintenant, regles);
    if (!estAConfirmer(commande)) {
      throw new ConflictException(
        estPanierAnnuleParClient(commande) ? MESSAGE_DEJA_ANNULEE_PAR_CLIENT : MESSAGE_NON_ANNULABLE,
      );
    }
    if (groupe?.prise && !groupe.prise.par_moi && user.role !== UserRole.ADMIN) {
      throw new ConflictException(`${groupe.prise.par_nom} s'occupe de cette commande\u00a0: laissez-le conclure.`);
    }
    return `${libelleRaison(corps.raison_code)}${texte ? `\u00a0: ${texte}` : ''}`.slice(0, 200);
  }

  /**
   * Après l'annulation d'une commande à confirmer depuis « À relancer » : la
   * prise s'efface, le journal garde l'agent et la raison, les agents relisent
   * leur liste. Ne lève jamais : la commande est déjà annulée.
   */
  async noterAnnulation(orderId: string, userId: string, raison: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.orderRelance.updateMany({
          where: { order_id: orderId },
          data: { pris_par_id: null, pris_le: null, prise_expire_le: null },
        }),
        this.prisma.orderRelanceJournal.create({
          data: {
            order_id: orderId,
            action: ACTIONS_JOURNAL_RELANCE.ANNULATION,
            user_id: userId,
            raison: raison.slice(0, 200),
          },
        }),
      ]);
    } catch (e) {
      this.logger.warn(`Relance : annulation de ${orderId} non journalisée : ${(e as Error)?.message}`);
    }
    this.signaler('annulation', [orderId], userId);
  }

  // =========================================================================
  // Paiement KKiaPay resté sans suite (14/11)
  // =========================================================================

  /**
   * Avant « Confirmer le paiement » (`POST /orders/relances/:orderId/confirmer-paiement`) :
   * le client a payé, le webhook n'a rien confirmé. Seul un panier payable en
   * ligne, encore en attente, se confirme ici ; pas pendant qu'un collègue l'a
   * en main, sauf pour un administrateur. Lève 400, 403, 404 ou 409 avec le
   * motif. Renvoie l'identifiant de transaction nettoyé, et la commande telle
   * que le journal la cite.
   *
   * Ni la fenêtre, ni l'ignorance, ni une exclusion du classement n'y font
   * obstacle : l'argent reçu se rattache quel que soit l'âge du panier.
   *
   * La confirmation elle-même (`confirmPaymentManually`) revérifie la
   * transaction auprès de KKiaPay, et son écriture est conditionnée à l'attente
   * (`linkPaiementToOrder`) : un webhook arrivé entre-temps ne fait pas payer
   * deux fois.
   */
  async verifierPaiementConfirmable(
    orderId: string,
    corps: { transaction_id?: string | null },
    user: User,
  ): Promise<{ transactionId: string; commande: { id: string; reference: string; restaurant_id: string } }> {
    this.verifierRole(user);
    const transaction = lireTransactionKkiapay(corps?.transaction_id);
    if (!transaction) throw new BadRequestException(MESSAGE_TRANSACTION_ILLISIBLE);

    const commande = await this.chargerCommande(orderId, user);
    if (estAConfirmer(commande)) throw new ConflictException(MESSAGE_PAIEMENT_A_LA_LIVRAISON);
    if (estPanierAnnuleParClient(commande)) throw new ConflictException(MESSAGE_PAIEMENT_PANIER_ANNULE);
    if (!estBrouillon(commande) || commande.payment_method !== PaymentMethod.ONLINE) {
      const motif = motifSortie(commande);
      const auteur = motif === 'REPRISE' ? await this.auteurReprise(orderId) : null;
      throw new ConflictException(messageSortie(motif, { auteur }));
    }

    if (user.role !== UserRole.ADMIN) {
      const relance = await this.prisma.orderRelance.findUnique({
        where: { order_id: orderId },
        select: { pris_par_id: true, prise_expire_le: true, pris_par: { select: { fullname: true } } },
      });
      const parAutre =
        !!relance?.pris_par_id &&
        relance.pris_par_id !== user.id &&
        !!relance.prise_expire_le &&
        relance.prise_expire_le > new Date();
      if (parAutre) {
        const nom = relance!.pris_par?.fullname?.trim() || 'Un collègue';
        throw new ConflictException(`${nom} s'occupe de cette commande : laissez-le conclure.`);
      }
    }
    return {
      transactionId: transaction,
      commande: { id: commande.id, reference: commande.reference, restaurant_id: commande.restaurant_id },
    };
  }

  /**
   * Après la confirmation d'un paiement depuis « À relancer » : la prise
   * s'efface, le journal garde l'agent et la transaction, le journal d'audit
   * aussi, et les agents relisent leur liste. Ne lève jamais : la commande est
   * déjà confirmée.
   */
  async noterPaiementConfirme(
    commande: { id: string; reference: string; restaurant_id?: string | null },
    user: Pick<User, 'id' | 'fullname' | 'email' | 'role'>,
    transactionId: string,
    effet: { justPaid: boolean; enDouble: boolean },
  ): Promise<void> {
    const raison = `Transaction KKiaPay ${transactionId}`.slice(0, 200);
    try {
      await this.prisma.$transaction([
        this.prisma.orderRelance.updateMany({
          where: { order_id: commande.id },
          data: { pris_par_id: null, pris_le: null, prise_expire_le: null },
        }),
        this.prisma.orderRelanceJournal.create({
          data: {
            order_id: commande.id,
            action: ACTIONS_JOURNAL_RELANCE.PAIEMENT_CONFIRME,
            user_id: user.id,
            raison,
          },
        }),
      ]);
    } catch (e) {
      this.logger.warn(`Relance : paiement de ${commande.id} non journalisé : ${(e as Error)?.message}`);
    }
    try {
      this.audit?.record({
        actor_id: user.id,
        actor_name: user.fullname ?? user.email ?? null,
        actor_role: user.role ?? null,
        restaurant_id: commande.restaurant_id ?? null,
        action: 'PAIEMENT_CONFIRME',
        module: 'orders',
        entity_id: commande.id,
        method: 'POST',
        path: `/orders/relances/${commande.id}/confirmer-paiement`,
        status_code: 200,
        summary: effet.justPaid
          ? `Paiement KKiaPay ${transactionId} confirmé depuis « À relancer » : commande ${commande.reference} transmise au restaurant`
          : `Paiement KKiaPay ${transactionId} rattaché depuis « À relancer » : commande ${commande.reference} déjà confirmée`,
        metadata: {
          reference: commande.reference,
          transaction: transactionId,
          premiere_confirmation: effet.justPaid,
          en_double: effet.enDouble,
        },
      });
    } catch (e) {
      this.logger.warn(`Relance : paiement de ${commande.id} absent du journal d'audit : ${(e as Error)?.message}`);
    }
    this.signaler('paiement', [commande.id], user.id);
  }

  /**
   * RÉACTIVATION d'un panier annulé par le client (reprise au téléphone, dans
   * `OrderService.update`) : il doit être encore relançable au moment du geste.
   * Lève 409, avec le motif en français, s'il ne l'est plus : le client a
   * recommandé, un paiement le couvre, il a passé la fenêtre de relance, ou il
   * n'est plus annulé par le client. Une commande ignorée se réactive : la
   * reprise d'un panier en attente ne regarde pas l'ignorance non plus.
   */
  async verifierReactivable(orderId: string, user: User): Promise<void> {
    this.verifierRole(user);
    const maintenant = new Date();
    const regles = await this.regles();
    await this.situation(orderId, user, maintenant, regles);
  }

  /**
   * Trace de la réactivation : les champs d'annulation sont vidés sur la
   * commande, leur valeur reste ici (journal d'audit) et dans le journal de la
   * relance (REPRISE, écrit par `noterReprise`). Ne lève jamais.
   */
  journaliserReactivation(params: {
    commande: {
      id: string;
      reference: string;
      restaurant_id: string;
      cancelled_at?: Date | null;
      cancelled_reason?: string | null;
      cancelled_by?: string | null;
    };
    acteur?: Pick<User, 'id' | 'fullname' | 'email' | 'role'> | null;
    coupon?: { code: string; type: string; consomme: boolean; remise: number } | null;
    /** Cadeaux rendus à l'annulation, facturés par des articles modifiés à la reprise. */
    cadeauxFactures?: string[];
  }): void {
    const { commande, acteur, coupon, cadeauxFactures } = params;
    try {
      this.audit?.record({
        actor_id: acteur?.id ?? null,
        actor_name: acteur?.fullname ?? acteur?.email ?? null,
        actor_role: acteur?.role ?? null,
        restaurant_id: commande.restaurant_id,
        action: 'COMMANDE_REACTIVEE',
        module: 'orders',
        entity_id: commande.id,
        method: 'PATCH',
        path: `/orders/${commande.id}`,
        status_code: 200,
        summary: `Commande ${commande.reference} annulée par le client, réactivée au téléphone : acceptée, paiement à la caisse`,
        metadata: {
          reference: commande.reference,
          annulee_le: commande.cancelled_at ? commande.cancelled_at.toISOString() : null,
          motif_annulation: commande.cancelled_reason || null,
          annulee_par: commande.cancelled_by ?? null,
          coupon: coupon ?? null,
          ...(cadeauxFactures?.length ? { cadeaux_factures: cadeauxFactures } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(`Relance : réactivation de ${commande.id} non journalisée : ${(e as Error)?.message}`);
    }
  }

  /** Prévient la salle des relances. Ne lève jamais. */
  signaler(motif: MotifRelanceChanged, ids: string[], par?: string, nouvelles: string[] = []): void {
    const charge: RelanceChangedPayload = { motif, ids, nouvelles, ...(par ? { par } : {}) };
    try {
      this.appGateway.emitToRelances(RELANCE_SOCKET_EVENT, charge);
    } catch (e) {
      this.logger.warn(`Relance : événement ${motif} non émis : ${(e as Error)?.message}`);
    }
  }

  // =========================================================================
  // Outils internes
  // =========================================================================

  private verifierRole(user: User | undefined): void {
    if (!peutVoirLesBrouillons(user)) throw new ForbiddenException(MESSAGE_ROLE);
  }

  /** Raison d'ignorer ou d'annuler : connue, et précisée si « Autre ». Renvoie le texte nettoyé. */
  private lireRaison(corps: { raison_code: string; raison_texte?: string | null }): string | null {
    if (!(RAISONS_IGNORER as readonly string[]).includes(corps?.raison_code)) {
      throw new BadRequestException('Choisissez une raison.');
    }
    const texte = corps.raison_texte?.trim() || null;
    if (corps.raison_code === 'AUTRE' && !texte) throw new BadRequestException('Précisez la raison.');
    return texte;
  }

  /**
   * La commande, dans le périmètre du compte. Hors périmètre de restaurant :
   * « introuvable » (404), pas « interdit », pour ne rien apprendre d'une
   * commande étrangère.
   */
  private async chargerCommande(orderId: string, user: User): Promise<CommandeLue> {
    const commande = await this.prisma.order.findUnique({ where: { id: orderId }, select: SELECT_COMMANDE });
    const scope = resolveRestaurantScope(user);
    if (!commande || (scope && commande.restaurant_id !== scope)) {
      throw new NotFoundException(MESSAGE_INTROUVABLE);
    }
    return commande;
  }

  /**
   * État actuel du groupe d'une commande, recalculé au moment du geste. Lève
   * 409 si la commande n'est plus à relancer (payée, annulée, reprise,
   * supprimée, exclue, trop ancienne ; une commande à confirmer n'est jamais
   * trop ancienne). `groupe` vaut null si tous les paniers du client sont
   * ignorés.
   */
  private async situation(
    orderId: string,
    user: User,
    maintenant: Date,
    regles: ReglesRelance,
  ): Promise<{ commande: CommandeLue; classement: Classement; groupe: GroupeClasse | null }> {
    const commande = await this.chargerCommande(orderId, user);
    if (!estRelancable(commande)) {
      const motif = motifSortie(commande);
      const auteur = motif === 'REPRISE' ? await this.auteurReprise(orderId) : null;
      throw new ConflictException(messageSortie(motif, { auteur }));
    }
    // Une commande à confirmer ne sort jamais par l'âge (19/10).
    if (
      !estAConfirmer(commande) &&
      commande.created_at.getTime() < maintenant.getTime() - regles.fenetre_heures * 60 * MINUTE
    ) {
      throw new ConflictException(messageSortie('HORS_FENETRE', { fenetre_heures: regles.fenetre_heures }));
    }

    const { brouillons, effectives } = await this.lireBrouillons(commande.restaurant_id, maintenant, regles);
    const classement = classerBrouillons({ brouillons, effectives, maintenant, regles, moi: user.id });
    const exclusion = classement.exclus.get(orderId);
    if (exclusion) {
      throw new ConflictException(messageSortie(exclusion.motif, { reference: exclusion.reference }));
    }
    const trouve = groupeDeLaCommande(classement, orderId);
    if (!trouve) throw new ConflictException(MESSAGE_A_RECHARGER);
    return { commande, classement, groupe: trouve.visible ?? null };
  }

  /** Groupe recalculé après un geste, tel que la liste l'afficherait. */
  private async groupeAJour(orderId: string, user: User): Promise<GroupeRelance | null> {
    try {
      const commande = await this.chargerCommande(orderId, user);
      const maintenant = new Date();
      const regles = await this.regles();
      const { brouillons, effectives } = await this.lireBrouillons(commande.restaurant_id, maintenant, regles);
      const classement = classerBrouillons({ brouillons, effectives, maintenant, regles, moi: user.id });
      const trouve = groupeDeLaCommande(classement, orderId);
      if (!trouve?.visible) return null;
      const [crm, signales] = await Promise.all([
        this.lireCrm([trouve.visible.tete.customer_id]),
        this.lirePaiementsSignales([trouve.visible.tete, ...trouve.visible.autres]),
      ]);
      return this.versGroupeRelance(trouve.visible, crm, signales);
    } catch (e) {
      this.logger.warn(`Relance : relecture du groupe de ${orderId} impossible : ${(e as Error)?.message}`);
      return null;
    }
  }

  /** Pourquoi une écriture conditionnée n'a rien touché, relu dans la transaction. */
  private async messageRefus(
    tx: Prisma.TransactionClient,
    order_id: string,
    geste: 'prendre' | 'ignorer',
  ): Promise<string> {
    const relance = await tx.orderRelance.findUnique({
      where: { order_id },
      select: { ignore_le: true, pris_par_id: true, pris_par: { select: { fullname: true } } },
    });
    if (relance?.ignore_le) return geste === 'prendre' ? MESSAGE_IGNOREE : MESSAGE_DEJA_IGNOREE;
    if (relance?.pris_par_id) {
      const nom = relance.pris_par?.fullname?.trim() || 'un collègue';
      return geste === 'prendre' ? `Déjà prise par ${nom}.` : `${nom} s'occupe de cette commande : laissez-le conclure.`;
    }
    return MESSAGE_A_RECHARGER;
  }

  /** Agent de la dernière reprise au téléphone, lu dans le journal. */
  private async auteurReprise(orderId: string): Promise<string | null> {
    try {
      const entree = await this.prisma.orderRelanceJournal.findFirst({
        where: { order_id: orderId, action: ACTIONS_JOURNAL_RELANCE.REPRISE },
        orderBy: { created_at: 'desc' },
        select: { user: { select: { fullname: true } } },
      });
      return entree?.user?.fullname?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Fiches CRM des clients (lecture seule) : « Suivi CRM : agent ». Ne lève jamais. */
  private async lireCrm(
    customerIds: (string | null)[],
  ): Promise<Map<string, { contact_id: string; statut: string; agent: string | null }>> {
    const ids = [...new Set(customerIds.filter((v): v is string => !!v))];
    const resultat = new Map<string, { contact_id: string; statut: string; agent: string | null }>();
    if (ids.length === 0) return resultat;
    try {
      const fiches = await this.prisma.crmContact.findMany({
        where: { customer_id: { in: ids }, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true, customer_id: true, status: true, assigned_to: { select: { fullname: true } } },
      });
      for (const f of fiches) {
        if (!f.customer_id) continue;
        resultat.set(f.customer_id, {
          contact_id: f.id,
          statut: f.status,
          agent: f.assigned_to?.fullname?.trim() || null,
        });
      }
    } catch (e) {
      this.logger.warn(`Relance : fiches CRM illisibles : ${(e as Error)?.message}`);
    }
    return resultat;
  }

  /**
   * PAIEMENTS SIGNALÉS (14/11), par identifiant de commande : transactions
   * KKiaPay réussies que le webhook a apportées sans confirmer la commande. Le
   * webhook les écrit au journal d'audit (`kkiapay-audit.helper.ts`), avec la
   * référence de la commande : refusé à l'entrée (403, 503), abandonné par le
   * traitement (409), en échec après toutes ses tentatives (500). Ni les
   * paiements confirmés (200), ni ceux que KKiaPay a refusés (402).
   *
   * Seulement les paniers en ligne en attente reçus, et les lignes postérieures
   * au plus ancien : jamais tout le journal. Un webhook jamais reçu ne laisse
   * aucune ligne : l'agent saisit alors l'identifiant. Ne lève jamais.
   */
  private async lirePaiementsSignales(brouillons: BrouillonLu[]): Promise<Map<string, PaiementSignale>> {
    const resultat = new Map<string, PaiementSignale>();
    const enLigne = brouillons.filter((b) => estBrouillon(b) && b.payment_method === PaymentMethod.ONLINE);
    if (enLigne.length === 0) return resultat;
    const parReference = new Map(enLigne.map((b) => [b.reference, b]));
    const depuis = enLigne.reduce((min, b) => (b.created_at < min ? b.created_at : min), enLigne[0].created_at);
    try {
      const lignes = await this.prisma.auditLog.findMany({
        where: {
          actor_id: ACTEUR_KKIAPAY_ID,
          module: 'paiements',
          created_at: { gte: depuis },
          status_code: { notIn: [200, 402] },
          OR: [...parReference.keys()].map((reference) => ({
            metadata: { path: ['reference_commande'], equals: reference },
          })),
        },
        select: { entity_id: true, created_at: true, metadata: true },
        orderBy: { created_at: 'desc' },
        take: MAX_PAIEMENTS_SIGNALES_LUS,
      });
      for (const l of lignes) {
        const m = (l.metadata ?? {}) as Record<string, unknown>;
        // Un refus à l'entrée journalise aussi les échecs : seuls les paiements réussis comptent.
        if (m.evenement !== 'transaction.success') continue;
        const b = typeof m.reference_commande === 'string' ? parReference.get(m.reference_commande) : undefined;
        const transaction = lireTransactionKkiapay(m.transaction ?? l.entity_id);
        // Plus récente d'abord : la première ligne retenue pour un panier est la bonne.
        if (!b || !transaction || resultat.has(b.id) || l.created_at < b.created_at) continue;
        const motif = [m.motif_non_confirmation, m.motif_refus, m.erreur].find(
          (v): v is string => typeof v === 'string' && v.trim() !== '',
        );
        resultat.set(b.id, {
          order_id: b.id,
          reference: b.reference,
          transaction_id: transaction,
          montant: typeof m.montant === 'number' && Number.isFinite(m.montant) ? m.montant : null,
          moyen: typeof m.moyen === 'string' ? m.moyen : null,
          le: l.created_at.toISOString(),
          motif: motif ? motif.trim().slice(0, 200) : null,
        });
      }
    } catch (e) {
      this.logger.warn(`Relance : paiements signalés illisibles : ${(e as Error)?.message}`);
    }
    return resultat;
  }

  private versGroupeRelance(
    g: GroupeClasse,
    crm: Map<string, { contact_id: string; statut: string; agent: string | null }>,
    signales: Map<string, PaiementSignale> = new Map(),
  ): GroupeRelance {
    const partiel = g.signaux.paiement_partiel;
    const signale = [g.tete, ...g.autres].map((b) => signales.get(b.id)).find((s) => !!s) ?? null;
    return {
      cle: g.cle,
      etat: g.etat,
      a_confirmer: g.a_confirmer,
      tete: ligne(g.tete),
      autres: g.autres.map(ligne),
      alerte_le: g.tete.relance?.alerte_le?.toISOString() ?? null,
      prise: g.prise
        ? {
            par: { id: g.prise.par_id, fullname: g.prise.par_nom },
            le: g.prise.le?.toISOString() ?? null,
            expire_le: g.prise.expire_le.toISOString(),
            par_moi: g.prise.par_moi,
          }
        : null,
      signaux: {
        paiement_refuse: g.signaux.paiement_refuse,
        paiement_partiel: partiel
          ? {
              ...partiel,
              libelle: `Paiement partiel : ${montantFormate(partiel.recu)} reçus sur ${montantFormate(partiel.montant)}`,
            }
          : null,
        commande_recente: g.signaux.commande_recente
          ? {
              reference: g.signaux.commande_recente.reference,
              created_at: g.signaux.commande_recente.created_at.toISOString(),
              payee: g.signaux.commande_recente.payee,
            }
          : null,
        annulee_par_client: g.signaux.annulee_par_client
          ? { le: g.signaux.annulee_par_client.le.toISOString() }
          : null,
        commande_suivante: g.signaux.commande_suivante
          ? {
              reference: g.signaux.commande_suivante.reference,
              created_at: g.signaux.commande_suivante.created_at.toISOString(),
            }
          : null,
        paiement_en_ligne_en_cours: g.signaux.paiement_en_ligne_en_cours
          ? {
              reference: g.signaux.paiement_en_ligne_en_cours.reference,
              jusqua: g.signaux.paiement_en_ligne_en_cours.jusqua.toISOString(),
            }
          : null,
        paiement_signale: signale,
      },
      crm: (g.tete.customer_id && crm.get(g.tete.customer_id)) || null,
    };
  }
}
