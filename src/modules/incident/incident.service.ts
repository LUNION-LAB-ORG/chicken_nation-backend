import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  EntityStatus,
  IncidentGeste,
  IncidentGravite,
  IncidentOrigine,
  IncidentPole,
  IncidentRecontact,
  IncidentStatut,
  IncidentSuiviType,
  OrderStatus,
  OrderType,
  Prisma,
  UserRole,
  UserType,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ROLES_SIEGE_INCIDENT } from 'src/modules/auth/constantes/roles-incidents';
import { SettingsService } from 'src/modules/settings/settings.service';
import { FiltresIncidentDto, ListeIncidentDto, StatistiquesIncidentDto } from './incident.dto';
import {
  Acteur,
  CARTES_PAR_COLONNE,
  CLE_BON_FAIBLE,
  CLE_BON_HAUTE,
  CLE_BON_MOYENNE,
  CLE_BON_RESTAURANT,
  CLE_BON_VALIDITE,
  COMMANDES_PROPOSEES,
  DroitsIncident,
  ENTETES_EXPORT,
  EXPORT_MAX,
  JOURS_RECHERCHE_COMMANDE,
  LIBELLE_GESTE,
  LIBELLE_GRAVITE,
  LIBELLE_ORIGINE,
  LIBELLE_POLE,
  LIBELLE_RECONTACT,
  LIBELLE_STATUT,
  LigneStat,
  MESSAGE_COMMANDE,
  MESSAGE_COMMANDE_AUTRE,
  MESSAGE_INTROUVABLE,
  MESSAGE_LECTURE,
  OUVERTS_MAX,
  ReglagesIncident,
  STATS_MAX,
  STATUTS_A_RESOUDRE,
  STATUTS_NON_CLOTURES,
  Statistiques,
  agregerStatistiques,
  bonSuggere,
  bornesPeriode,
  comparerATraiter,
  critereRecherche,
  debutCloturesAuTableau,
  droitsIncident,
  enRetard,
  estCompteRestaurant,
  extrait,
  formatDateExport,
  lireReglages,
  montantsBon,
  nomClient,
  periodeStats,
  peutSignaler,
  peutTraiterIncident,
  peutVoirIncident,
  porteeRestaurant,
  texteSuivi,
  versCsv,
} from './incident.rules';

const JOUR = 24 * 3_600_000;

// ─── Formes rendues ──────────────────────────────────────────────────────────

export interface IncidentLigne {
  id: string;
  code: string;
  statut: IncidentStatut;
  gravite: IncidentGravite;
  origine: IncidentOrigine;
  pole: IncidentPole;
  categorie: { id: string; nom: string };
  extrait: string;
  commande: { id: string; reference: string };
  restaurant: { id: string; name: string };
  /** `telephone` : masqué par l'intercepteur global pour le marketing. */
  client: { id: string; nom: string; telephone: string | null };
  agent: { id: string; fullname: string } | null;
  geste: IncidentGeste | null;
  bon_montant: number | null;
  echeance_at: Date;
  en_retard: boolean;
  created_at: Date;
  resolu_at: Date | null;
  cloture_at: Date | null;
}

export interface ContexteCommande {
  id: string;
  reference: string;
  created_at: Date;
  type: OrderType;
  statut: OrderStatus;
  montant: number;
  restaurant: { id: string; name: string };
  client: { id: string; nom: string; telephone: string | null };
}

export interface IncidentFiche extends Omit<IncidentLigne, 'commande'> {
  description: string;
  cause: string | null;
  action: string | null;
  recontact: IncidentRecontact | null;
  reaction: string | null;
  signale_par: string | null;
  resolu_par: string | null;
  cloture_par: string | null;
  assigne_at: Date | null;
  commande: ContexteCommande;
  bon: {
    code: string;
    montant: number;
    statut: VoucherStatus;
    expire_at: Date | null;
    message_at: Date | null;
    message_canal: string | null;
  } | null;
  /** Résolu avec un bon qui n'a pas pu être créé : « Créer le bon » sur la fiche. */
  bon_a_creer: boolean;
  liens: {
    ticket: { id: string; code: string } | null;
    avis_id: string | null;
    note: { id: string; rating: number } | null;
  };
  autres: { id: string; code: string; statut: IncidentStatut; categorie: string; created_at: Date }[];
  suivis: { id: string; type: IncidentSuiviType; texte: string; note: string | null; auteur_nom: string | null; created_at: Date }[];
  droits: DroitsIncident;
  montants_bon: number[];
  bon_suggere: number;
}

export interface CategorieIncident {
  id: string;
  nom: string;
  pole: IncidentPole;
  delai_heures: number;
  actif: boolean;
  ordre: number;
}

// ─── Lectures Prisma ─────────────────────────────────────────────────────────

export const INCLURE_LIGNE = {
  categorie: { select: { id: true, nom: true } },
  order: { select: { id: true, reference: true, fullname: true, phone: true } },
  restaurant: { select: { id: true, name: true } },
  customer: { select: { id: true, first_name: true, last_name: true, phone: true } },
  agent: { select: { id: true, fullname: true } },
} satisfies Prisma.IncidentInclude;

export const INCLURE_FICHE = {
  categorie: { select: { id: true, nom: true, delai_heures: true } },
  order: {
    select: {
      id: true,
      reference: true,
      fullname: true,
      phone: true,
      created_at: true,
      type: true,
      status: true,
      amount: true,
    },
  },
  restaurant: { select: { id: true, name: true } },
  customer: { select: { id: true, first_name: true, last_name: true, phone: true } },
  agent: { select: { id: true, fullname: true } },
  voucher: { select: { id: true, code: true, initial_amount: true, status: true, expires_at: true } },
  ticket: { select: { id: true, code: true } },
  comment: { select: { id: true, rating: true } },
  suivis: { orderBy: { created_at: 'asc' as const } },
} satisfies Prisma.IncidentInclude;

const SELECTION_COMMANDE = {
  id: true,
  reference: true,
  fullname: true,
  phone: true,
  created_at: true,
  type: true,
  status: true,
  amount: true,
  restaurant_id: true,
  customer_id: true,
  restaurant: { select: { id: true, name: true } },
  customer: { select: { id: true, first_name: true, last_name: true, phone: true } },
} satisfies Prisma.OrderSelect;

type IncidentAvecLigne = Prisma.IncidentGetPayload<{ include: typeof INCLURE_LIGNE }>;
export type IncidentComplet = Prisma.IncidentGetPayload<{ include: typeof INCLURE_FICHE }>;
export type CommandeLue = Prisma.OrderGetPayload<{ select: typeof SELECTION_COMMANDE }>;

/** « CN-7Q2K » → « ••••2K » : le code se dicte au client, il ne se relève pas. */
export function masquerCode(code: string): string {
  return code.length <= 2 ? '••' : `${'•'.repeat(Math.min(4, code.length - 2))}${code.slice(-2)}`;
}

/**
 * Lectures des incidents sur commande : tableau (kanban), liste, fiche,
 * compteurs, tableau de bord, réglages. Tout est borné au restaurant du
 * compte pour un point de vente ; les écritures sont dans
 * `IncidentTraitementService`.
 */
@Injectable()
export class IncidentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ─── Réglages ───────────────────────────────────────────────────────────────

  async reglages(): Promise<ReglagesIncident> {
    const brut = await this.settings.getMany([
      CLE_BON_FAIBLE,
      CLE_BON_MOYENNE,
      CLE_BON_HAUTE,
      CLE_BON_VALIDITE,
      CLE_BON_RESTAURANT,
    ]);
    return lireReglages(brut);
  }

  /** Catégories dans l'ordre de l'écran ; les inactives restent pour les réglages et les filtres. */
  async categories(): Promise<CategorieIncident[]> {
    return this.prisma.incidentCategorie.findMany({
      orderBy: [{ ordre: 'asc' }, { nom: 'asc' }],
      select: { id: true, nom: true, pole: true, delai_heures: true, actif: true, ordre: true },
    });
  }

  async reglagesEtCategories() {
    const [reglages, categories] = await Promise.all([this.reglages(), this.categories()]);
    return { ...reglages, categories };
  }

  // ─── Filtres ────────────────────────────────────────────────────────────────

  where(q: Partial<ListeIncidentDto>, user: Acteur): Prisma.IncidentWhereInput {
    const where: Prisma.IncidentWhereInput = {};
    const restaurant = porteeRestaurant(user, q.restaurantId);
    if (restaurant) where.restaurant_id = restaurant;
    if (q.pole) where.pole = q.pole;
    if (q.categorieId) where.categorie_id = q.categorieId;
    if (q.gravite) where.gravite = q.gravite;
    if (q.statut) where.statut = q.statut;
    if (q.origine) where.origine = q.origine;
    if (q.customerId) where.customer_id = q.customerId;

    const { debut, fin } = bornesPeriode(q.du, q.au);
    if (debut || fin) where.created_at = { ...(debut && { gte: debut }), ...(fin && { lt: fin }) };

    const critere = critereRecherche(q.recherche);
    if (critere) {
      const contient = { contains: critere.texte, mode: 'insensitive' as const };
      // Le marketing voit des numéros masqués : pas de recherche par chiffres,
      // qui les lui ferait retrouver un à un.
      const parNumero = critere.chiffres && user.role !== UserRole.MARKETING;
      where.OR = [
        { code: contient },
        { order: { reference: contient } },
        { order: { fullname: contient } },
        { customer: { first_name: contient } },
        { customer: { last_name: contient } },
        ...(parNumero ? [{ customer: { phone: { contains: critere.chiffres } } }] : []),
      ];
    }
    return where;
  }

  // ─── Formes ─────────────────────────────────────────────────────────────────

  ligne(i: IncidentAvecLigne, maintenant: Date): IncidentLigne {
    return {
      id: i.id,
      code: i.code,
      statut: i.statut,
      gravite: i.gravite,
      origine: i.origine,
      pole: i.pole,
      categorie: { id: i.categorie.id, nom: i.categorie.nom },
      extrait: extrait(i.description),
      commande: { id: i.order.id, reference: i.order.reference },
      restaurant: { id: i.restaurant.id, name: i.restaurant.name },
      client: {
        id: i.customer.id,
        nom: nomClient(i.customer, i.order.fullname),
        telephone: i.customer.phone ?? i.order.phone ?? null,
      },
      agent: i.agent ? { id: i.agent.id, fullname: i.agent.fullname } : null,
      geste: i.geste,
      bon_montant: i.bon_montant,
      echeance_at: i.echeance_at,
      en_retard: enRetard(i, maintenant),
      created_at: i.created_at,
      resolu_at: i.resolu_at,
      cloture_at: i.cloture_at,
    };
  }

  contexte(o: CommandeLue): ContexteCommande {
    return {
      id: o.id,
      reference: o.reference,
      created_at: o.created_at,
      type: o.type,
      statut: o.status,
      montant: o.amount,
      restaurant: { id: o.restaurant.id, name: o.restaurant.name },
      client: {
        id: o.customer.id,
        nom: nomClient(o.customer, o.fullname),
        telephone: o.customer.phone ?? o.phone ?? null,
      },
    };
  }

  // ─── Compteurs, tableau, liste ──────────────────────────────────────────────

  /** Pastille de l'onglet et bandeau du tableau, bornés au restaurant du compte. */
  async compteurs(user: Acteur, restaurantId?: string, maintenant = new Date()) {
    const base = this.where({ restaurantId }, user);
    const [ouverts, en_cours, resolus, en_retard] = await Promise.all([
      this.prisma.incident.count({ where: { ...base, statut: IncidentStatut.OUVERT } }),
      this.prisma.incident.count({ where: { ...base, statut: IncidentStatut.EN_COURS } }),
      this.prisma.incident.count({ where: { ...base, statut: IncidentStatut.RESOLU } }),
      this.prisma.incident.count({
        where: { ...base, statut: { in: STATUTS_A_RESOUDRE }, echeance_at: { lt: maintenant } },
      }),
    ]);
    return { ouverts, en_cours, resolus, en_retard };
  }

  /**
   * Les quatre colonnes. « Ouvert » et « En cours » : les plus pressés
   * d'abord ; « Résolu » : ceux qui attendent leur clôture depuis le plus
   * longtemps ; « Clôturé » : les derniers jours seulement.
   */
  async tableau(q: FiltresIncidentDto, user: Acteur, maintenant = new Date()) {
    const base = this.where(q, user);
    const colonne = async (
      statut: IncidentStatut,
      orderBy: Prisma.IncidentOrderByWithRelationInput,
      plus: Prisma.IncidentWhereInput = {},
    ) => {
      const where = { ...base, ...plus, statut };
      const [incidents, total] = await Promise.all([
        this.prisma.incident.findMany({ where, include: INCLURE_LIGNE, orderBy, take: CARTES_PAR_COLONNE }),
        this.prisma.incident.count({ where }),
      ]);
      return { total, incidents };
    };
    const [ouverts, enCours, resolus, clotures] = await Promise.all([
      colonne(IncidentStatut.OUVERT, { echeance_at: 'asc' }),
      colonne(IncidentStatut.EN_COURS, { echeance_at: 'asc' }),
      colonne(IncidentStatut.RESOLU, { resolu_at: 'asc' }),
      colonne(IncidentStatut.CLOTURE, { cloture_at: 'desc' }, { cloture_at: { gte: debutCloturesAuTableau(maintenant) } }),
    ]);
    const presses = (c: { total: number; incidents: IncidentAvecLigne[] }) => ({
      total: c.total,
      incidents: [...c.incidents].sort((a, b) => comparerATraiter(a, b, maintenant)).map((i) => this.ligne(i, maintenant)),
    });
    const telsQuels = (c: { total: number; incidents: IncidentAvecLigne[] }) => ({
      total: c.total,
      incidents: c.incidents.map((i) => this.ligne(i, maintenant)),
    });
    return {
      colonnes: {
        OUVERT: presses(ouverts),
        EN_COURS: presses(enCours),
        RESOLU: telsQuels(resolus),
        CLOTURE: telsQuels(clotures),
      },
    };
  }

  async liste(q: ListeIncidentDto, user: Acteur, maintenant = new Date()) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where = this.where(q, user);
    const [incidents, total] = await Promise.all([
      this.prisma.incident.findMany({
        where,
        include: INCLURE_LIGNE,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.incident.count({ where }),
    ]);
    return {
      data: incidents.map((i) => this.ligne(i, maintenant)),
      meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** CSV des incidents filtrés (5 000 lignes au plus). Réservé au siège par le contrôleur : les numéros y sont en clair. */
  async exporter(q: Partial<ListeIncidentDto>, user: Acteur) {
    const incidents = await this.prisma.incident.findMany({
      where: this.where(q, user),
      include: INCLURE_LIGNE,
      orderBy: { created_at: 'desc' },
      take: EXPORT_MAX,
    });
    const rangees = incidents.map((i) => [
      i.code,
      formatDateExport(i.created_at),
      LIBELLE_STATUT[i.statut],
      i.categorie.nom,
      LIBELLE_GRAVITE[i.gravite],
      LIBELLE_ORIGINE[i.origine],
      LIBELLE_POLE[i.pole],
      i.restaurant.name,
      i.order.reference,
      nomClient(i.customer, i.order.fullname),
      i.customer.phone ?? i.order.phone ?? '',
      i.description,
      i.cause ?? '',
      i.action ?? '',
      i.geste ? LIBELLE_GESTE[i.geste] : '',
      i.geste === IncidentGeste.BON && i.bon_montant ? i.bon_montant : '',
      formatDateExport(i.resolu_at),
      formatDateExport(i.cloture_at),
      i.recontact ? LIBELLE_RECONTACT[i.recontact] : '',
      i.reaction ?? '',
    ]);
    return { nom: 'incidents.csv', type: 'text/csv; charset=utf-8', contenu: versCsv(ENTETES_EXPORT, rangees) };
  }

  // ─── Tableau de bord ────────────────────────────────────────────────────────

  async statistiques(q: StatistiquesIncidentDto, user: Acteur, maintenant = new Date()): Promise<Statistiques> {
    const periode = periodeStats(q.du, q.au, maintenant);
    if ('refus' in periode) throw new BadRequestException(periode.refus);
    const restaurant = porteeRestaurant(user, q.restaurantId);
    const incidents = await this.prisma.incident.findMany({
      where: {
        created_at: { gte: periode.debut, lt: periode.fin },
        ...(restaurant && { restaurant_id: restaurant }),
      },
      select: {
        id: true,
        code: true,
        statut: true,
        gravite: true,
        origine: true,
        pole: true,
        geste: true,
        bon_montant: true,
        voucher_id: true,
        categorie_id: true,
        restaurant_id: true,
        created_at: true,
        resolu_at: true,
        echeance_at: true,
        cause: true,
        action: true,
        categorie: { select: { nom: true } },
        restaurant: { select: { name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: STATS_MAX,
    });
    const lignes: LigneStat[] = incidents.map((i) => ({
      id: i.id,
      code: i.code,
      statut: i.statut,
      gravite: i.gravite,
      origine: i.origine,
      pole: i.pole,
      geste: i.geste,
      bon_montant: i.bon_montant,
      voucher_id: i.voucher_id,
      categorie_id: i.categorie_id,
      categorie_nom: i.categorie.nom,
      restaurant_id: i.restaurant_id,
      restaurant_nom: i.restaurant.name,
      created_at: i.created_at,
      resolu_at: i.resolu_at,
      echeance_at: i.echeance_at,
      cause: i.cause,
      action: i.action,
    }));
    return agregerStatistiques(lignes, periode, maintenant);
  }

  // ─── Agents ─────────────────────────────────────────────────────────────────

  /** Comptes du siège à qui un incident peut être confié. */
  async agents() {
    return this.prisma.user.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
        type: UserType.BACKOFFICE,
        role: { in: [...ROLES_SIEGE_INCIDENT] },
      },
      select: { id: true, fullname: true, role: true },
      orderBy: { fullname: 'asc' },
    });
  }

  // ─── Commandes ──────────────────────────────────────────────────────────────

  async commande(orderId: string): Promise<CommandeLue> {
    const commande = await this.prisma.order.findUnique({ where: { id: orderId }, select: SELECTION_COMMANDE });
    if (!commande) throw new NotFoundException(MESSAGE_COMMANDE);
    return commande;
  }

  /** Commandes récentes qui répondent à la recherche de « Signaler un incident ». */
  async chercherCommandes(recherche: string, user: Acteur, maintenant = new Date()): Promise<ContexteCommande[]> {
    const critere = critereRecherche(recherche);
    if (!critere) return [];
    const contient = { contains: critere.texte, mode: 'insensitive' as const };
    const restaurant = porteeRestaurant(user);
    const commandes = await this.prisma.order.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        created_at: { gte: new Date(maintenant.getTime() - JOURS_RECHERCHE_COMMANDE * JOUR) },
        ...(restaurant && { restaurant_id: restaurant }),
        OR: [
          { reference: contient },
          { fullname: contient },
          { customer: { first_name: contient } },
          { customer: { last_name: contient } },
          ...(critere.chiffres
            ? [{ customer: { phone: { contains: critere.chiffres } } }, { phone: { contains: critere.chiffres } }]
            : []),
        ],
      },
      select: SELECTION_COMMANDE,
      orderBy: { created_at: 'desc' },
      take: COMMANDES_PROPOSEES,
    });
    return commandes.map((c) => this.contexte(c));
  }

  /** Incidents d'une commande (tiroir de la commande, fenêtre de signalement). */
  async parCommande(orderId: string, user: Acteur, maintenant = new Date()) {
    const commande = await this.commande(orderId);
    if (estCompteRestaurant(user) && user.restaurant_id !== commande.restaurant_id) {
      throw new ForbiddenException(MESSAGE_COMMANDE_AUTRE);
    }
    const incidents = await this.prisma.incident.findMany({
      where: { order_id: orderId },
      include: INCLURE_LIGNE,
      orderBy: { created_at: 'desc' },
    });
    return {
      commande: this.contexte(commande),
      incidents: incidents.map((i) => this.ligne(i, maintenant)),
      peut_signaler: peutSignaler(user, commande.restaurant_id),
    };
  }

  /** Incidents non clôturés, par commande : l'étiquette des listes de commandes. */
  async ouverts(user: Acteur, restaurantId?: string) {
    const restaurant = porteeRestaurant(user, restaurantId);
    const incidents = await this.prisma.incident.findMany({
      where: { statut: { in: STATUTS_NON_CLOTURES }, ...(restaurant && { restaurant_id: restaurant }) },
      select: { id: true, code: true, order_id: true, statut: true, gravite: true, categorie: { select: { nom: true } } },
      orderBy: { created_at: 'desc' },
      take: OUVERTS_MAX,
    });
    return incidents.map((i) => ({
      id: i.id,
      code: i.code,
      order_id: i.order_id,
      statut: i.statut,
      gravite: i.gravite,
      categorie: i.categorie.nom,
    }));
  }

  // ─── Fiche ──────────────────────────────────────────────────────────────────

  async charger(id: string): Promise<IncidentComplet> {
    const incident = await this.prisma.incident.findUnique({ where: { id }, include: INCLURE_FICHE });
    if (!incident) throw new NotFoundException(MESSAGE_INTROUVABLE);
    return incident;
  }

  /** L'incident, s'il est visible de ce compte ; 403 pour celui d'un autre restaurant. */
  async chargerVisible(id: string, user: Acteur): Promise<IncidentComplet> {
    const incident = await this.charger(id);
    if (!peutVoirIncident(user, incident)) throw new ForbiddenException(MESSAGE_LECTURE);
    return incident;
  }

  async fiche(id: string, user: Acteur, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.chargerVisible(id, user);
    const [reglages, autres] = await Promise.all([
      this.reglages(),
      this.prisma.incident.findMany({
        where: { customer_id: i.customer_id, id: { not: i.id } },
        select: { id: true, code: true, statut: true, created_at: true, categorie: { select: { nom: true } } },
        orderBy: { created_at: 'desc' },
        take: 5,
      }),
    ]);
    // Le code du bon se dicte au client : seuls ceux qui traitent l'incident le lisent en clair.
    const codeEnClair = peutTraiterIncident(user, i);
    const code = (c: string) => (codeEnClair ? c : masquerCode(c));

    return {
      id: i.id,
      code: i.code,
      statut: i.statut,
      gravite: i.gravite,
      origine: i.origine,
      pole: i.pole,
      categorie: { id: i.categorie.id, nom: i.categorie.nom },
      extrait: extrait(i.description),
      description: i.description,
      restaurant: { id: i.restaurant.id, name: i.restaurant.name },
      client: {
        id: i.customer.id,
        nom: nomClient(i.customer, i.order.fullname),
        telephone: i.customer.phone ?? i.order.phone ?? null,
      },
      commande: {
        id: i.order.id,
        reference: i.order.reference,
        created_at: i.order.created_at,
        type: i.order.type,
        statut: i.order.status,
        montant: i.order.amount,
        restaurant: { id: i.restaurant.id, name: i.restaurant.name },
        client: {
          id: i.customer.id,
          nom: nomClient(i.customer, i.order.fullname),
          telephone: i.customer.phone ?? i.order.phone ?? null,
        },
      },
      agent: i.agent ? { id: i.agent.id, fullname: i.agent.fullname } : null,
      assigne_at: i.assigne_at,
      geste: i.geste,
      bon_montant: i.bon_montant,
      echeance_at: i.echeance_at,
      en_retard: enRetard(i, maintenant),
      created_at: i.created_at,
      resolu_at: i.resolu_at,
      cloture_at: i.cloture_at,
      cause: i.cause,
      action: i.action,
      recontact: i.recontact,
      reaction: i.reaction,
      signale_par: i.signale_par_nom,
      resolu_par: i.resolu_par_nom,
      cloture_par: i.cloture_par_nom,
      bon: i.voucher
        ? {
            code: code(i.voucher.code),
            montant: i.voucher.initial_amount,
            statut: i.voucher.status,
            expire_at: i.voucher.expires_at,
            message_at: i.bon_message_at,
            message_canal: i.bon_message_canal,
          }
        : null,
      bon_a_creer: i.geste === IncidentGeste.BON && !i.voucher_id && !STATUTS_A_RESOUDRE.includes(i.statut),
      liens: {
        ticket: i.ticket ? { id: i.ticket.id, code: i.ticket.code } : null,
        avis_id: i.avis_id,
        note: i.comment ? { id: i.comment.id, rating: i.comment.rating } : null,
      },
      autres: autres.map((a) => ({
        id: a.id,
        code: a.code,
        statut: a.statut,
        categorie: a.categorie.nom,
        created_at: a.created_at,
      })),
      suivis: i.suivis.map((s) => {
        const meta = (s.meta ?? null) as Record<string, unknown> | null;
        const lisible = meta && typeof meta.code === 'string' ? { ...meta, code: code(meta.code) } : meta;
        return {
          id: s.id,
          type: s.type,
          texte: texteSuivi({ type: s.type, note: s.note, meta: lisible, auteur_nom: s.auteur_nom }),
          note: s.note,
          auteur_nom: s.auteur_nom,
          created_at: s.created_at,
        };
      }),
      droits: droitsIncident(user, i, reglages),
      montants_bon: montantsBon(reglages.bareme),
      bon_suggere: bonSuggere(i.gravite, reglages.bareme),
    };
  }
}
