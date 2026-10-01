import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EntityStatus, OrderStatus, Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { commandeEffective } from 'src/modules/crm/crm.rules';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { RELANCABLE_WHERE, estPanierAnnuleParClient, estRelancable, peutVoirLesBrouillons } from '../helpers/brouillons.rules';
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
}

export interface GroupeRelance {
  cle: string;
  etat: 'A_RELANCER' | 'PRIS' | 'EN_COURS';
  tete: BrouillonLigne;
  autres: BrouillonLigne[];
  alerte_le: string | null;
  prise: { par: { id: string; fullname: string }; le: string | null; expire_le: string; par_moi: boolean } | null;
  signaux: {
    paiement_refuse: boolean;
    paiement_partiel: { reference: string; recu: number; montant: number; libelle: string } | null;
    commande_recente: { reference: string; created_at: string } | null;
    /** Date d'annulation (ISO) de la tête, ou du panier annulé le plus récent du groupe. */
    annulee_par_client: { le: string } | null;
  };
  crm: { contact_id: string; statut: string; agent: string | null } | null;
}

export interface RelancesReponse {
  maintenant: string;
  regles: { delai_minutes: number; fenetre_heures: number; duree_prise_minutes: number; rappel_minutes: number };
  prochaine_echeance: string | null;
  compteurs: { a_relancer: number; pris: number; pris_par_moi: number; en_cours: number; ignorees: number };
  groupes: GroupeRelance[];
}

export interface IgnoreeLigne extends BrouillonLigne {
  ignore_par: { id: string; fullname: string } | null;
  ignore_le: string;
  raison_code: string;
  raison_libelle: string;
  raison_texte: string | null;
  encore_en_attente: boolean;
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
  };
}

/**
 * RELANCE DES COMMANDES EN ATTENTE (paniers de l'application non payés).
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
          { created_at: { gte: debutFenetre } },
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

    const [crm, ignorees] = await Promise.all([
      this.lireCrm(classement.groupes.map((g) => g.tete.customer_id)),
      this.prisma.orderRelance.count({
        where: {
          ignore_le: { gte: new Date(maintenant.getTime() - IGNOREES_HEURES * 60 * MINUTE) },
          ...(scope ? { order: { restaurant_id: scope } } : {}),
        },
      }),
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
      },
      groupes: classement.groupes.map((g) => this.versGroupeRelance(g, crm)),
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

  /** « Ignorer » pour toute l'équipe, avec une raison. Efface la prise. */
  async ignorer(
    orderId: string,
    corps: { raison_code: string; raison_texte?: string | null },
    user: User,
  ): Promise<{ ok: true; nombre: number }> {
    this.verifierRole(user);
    if (!(RAISONS_IGNORER as readonly string[]).includes(corps?.raison_code)) {
      throw new BadRequestException('Choisissez une raison.');
    }
    const texte = corps.raison_texte?.trim() || null;
    if (corps.raison_code === 'AUTRE' && !texte) throw new BadRequestException('Précisez la raison.');

    const maintenant = new Date();
    const regles = await this.regles();
    const { groupe } = await this.situation(orderId, user, maintenant, regles);
    if (!groupe) throw new ConflictException(MESSAGE_DEJA_IGNOREE);
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
   * supprimée, exclue, trop ancienne). `groupe` vaut null si tous les paniers
   * du client sont ignorés.
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
    if (commande.created_at.getTime() < maintenant.getTime() - regles.fenetre_heures * 60 * MINUTE) {
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
      const crm = await this.lireCrm([trouve.visible.tete.customer_id]);
      return this.versGroupeRelance(trouve.visible, crm);
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

  private versGroupeRelance(
    g: GroupeClasse,
    crm: Map<string, { contact_id: string; statut: string; agent: string | null }>,
  ): GroupeRelance {
    const partiel = g.signaux.paiement_partiel;
    return {
      cle: g.cle,
      etat: g.etat,
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
            }
          : null,
        annulee_par_client: g.signaux.annulee_par_client
          ? { le: g.signaux.annulee_par_client.le.toISOString() }
          : null,
      },
      crm: (g.tete.customer_id && crm.get(g.tete.customer_id)) || null,
    };
  }
}
