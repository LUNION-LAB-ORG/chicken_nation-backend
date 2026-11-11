import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AvisCanal,
  AvisResultat,
  AvisRessenti,
  AvisSolution,
  AvisStatut,
  AvisSuiviType,
  EntityStatus,
  OrderChannel,
  Prisma,
  User,
  UserType,
} from '@prisma/client';
import { coordonneesMasquees } from 'src/common/securite/masquer-contacts.interceptor';
import { customerPhoneVariants } from 'src/common/utils/customer-phone.util';
import { PrismaService } from 'src/database/services/prisma.service';
import { ROLES_TRAITEMENT_AVIS } from 'src/modules/auth/constantes/roles-avis-prives';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { rolePeut } from 'src/modules/auth/utils/role-peut';
import {
  assertCanAccessRestaurant,
  resolveRestaurantScope,
} from 'src/modules/order/helpers/restaurant-scope.helper';
import { ListeAvisQueryDto, STORE_AUCUN } from './avis-prive.dto';
import {
  chiffres,
  debutDuJour,
  DERNIERES_COMMANDES,
  echeanceAffichee,
  ENTETES_EXPORT,
  enRetard,
  EXPORT_MAX,
  EXTRAIT_LISTE,
  extrait,
  formatDateExport,
  JE_NE_SAIS_PAS,
  LIBELLE_CANAL_EXPORT,
  LIBELLE_RESSENTI,
  LIBELLE_SOLUTION,
  LIBELLE_STATUT,
  libelleSource,
  MESSAGE_INTROUVABLE,
  prenomAffiche,
  sqlEnRetard,
  sqlResolusSurSeptJours,
  SQL_TRI,
  STATUTS_CLOS,
  texteSuivi,
  TEXTE_RAPPROCHEMENT,
  versCsv,
} from './avis-prive.rules';

const JOUR = 86_400_000;

// ─── Formes rendues (contrat 4.2) ────────────────────────────────────────────
// Les numéros sont rangés sous les clés `telephone` ou `phone` : l'intercepteur
// global les masque pour le marketing.

export interface AvisLigne {
  id: string;
  created_at: Date;
  ressenti: AvisRessenti;
  canal: AvisCanal;
  restaurant: { id: string; name: string } | null;
  commentaire_extrait: string;
  prenom: string | null;
  telephone: string | null;
  rapproche: boolean;
  statut: AvisStatut;
  echeance_at: Date | null;
  en_retard: boolean;
  agent: { id: string; fullname: string } | null;
}

export interface CommandeRecente {
  id: string;
  reference: string;
  created_at: Date;
  restaurant: { id: string; name: string };
  channel: OrderChannel | null;
  auto: boolean;
  status: string;
  type: string;
  amount: number;
  plats: string[];
}

export interface LigneJournal {
  id: string;
  created_at: Date;
  type: AvisSuiviType;
  resultat: AvisResultat | null;
  auteur: string;
  texte: string;
}

export interface AvisFiche extends AvisLigne {
  commentaire: string;
  accord_rappel: boolean;
  source: string;
  solution: AvisSolution | null;
  premier_contact_at: Date | null;
  tentatives_appel: number;
  client: {
    customer_id: string | null;
    first_name: string | null;
    last_name: string | null;
    telephone: string | null;
    crm_contact_id: string | null;
  };
  order_id: string | null;
  ticket: { id: string; code: string; status: string } | null;
  /** Incident ouvert à partir de cet avis, le plus récent (« Créer un incident », 11/11). */
  incident: { id: string; code: string; statut: string } | null;
  dernieres_commandes: CommandeRecente[] | null;
  journal: LigneJournal[];
}

export interface CompteursAvis {
  nouveaux: number;
  a_rappeler: number;
  echeance_depassee: number;
  resolus_7j: number;
  a_traiter: number;
}

export interface FichierExport {
  nom: string;
  type: string;
  contenu: Buffer;
}

const INCLUDE_AVIS = {
  restaurant: { select: { id: true, name: true } },
  customer: { select: { id: true, first_name: true, last_name: true, phone: true } },
  agent: { select: { id: true, fullname: true } },
  order: { select: { id: true, reference: true } },
  ticket: { select: { id: true, code: true, status: true } },
  incidents: { select: { id: true, code: true, statut: true }, orderBy: { created_at: 'desc' }, take: 1 },
} satisfies Prisma.AvisPriveInclude;

export type AvisCharge = Prisma.AvisPriveGetPayload<{ include: typeof INCLUDE_AVIS }>;

/** Filtres de la liste et de l'export (sans la pagination). */
export type FiltresAvis = Omit<ListeAvisQueryDto, 'page' | 'limit'>;

/** Qui lit la liste : son rôle décide si la recherche par numéro lui est ouverte. */
export type LecteurAvis = Pick<User, 'role'> | null | undefined;

/**
 * Lecture des retours privés : liste, compteurs, fiche, export, agents, et le
 * rapprochement d'un numéro avec un compte client (partagé avec le dépôt).
 *
 * Avis supprimés : absents de tout, fiche en 404. Compte de point de vente :
 * son restaurant seulement (filtre forcé par RestaurantQueryScopeGuard sur les
 * listes, contrôle sur la fiche).
 */
@Injectable()
export class AvisPriveService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Rapprochement (3.5) ──────────────────────────────────────────────────

  /**
   * Compte client du numéro canonique, toutes graphies héritées comprises
   * (`+225…` et `225…`) : non supprimé, l'actif d'abord, puis le plus récent.
   */
  async trouverClient(telephone: string): Promise<{ id: string; first_name: string | null } | null> {
    const comptes = await this.prisma.customer.findMany({
      where: { phone: { in: customerPhoneVariants(telephone) }, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, first_name: true, entity_status: true, created_at: true },
      orderBy: { created_at: 'desc' },
    });
    const compte = comptes.find((c) => c.entity_status === EntityStatus.ACTIVE) ?? comptes[0];
    return compte ? { id: compte.id, first_name: compte.first_name } : null;
  }

  // ─── Chargement ───────────────────────────────────────────────────────────

  /** Avis non supprimé, ou 404. */
  async charger(id: string): Promise<AvisCharge> {
    const avis = await this.prisma.avisPrive.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      include: INCLUDE_AVIS,
    });
    if (!avis) throw new NotFoundException(MESSAGE_INTROUVABLE);
    return avis;
  }

  /** Avis dans l'ordre des identifiants donnés. */
  private async chargerDansLOrdre(ids: string[]): Promise<AvisCharge[]> {
    if (ids.length === 0) return [];
    const avis = await this.prisma.avisPrive.findMany({ where: { id: { in: ids } }, include: INCLUDE_AVIS });
    const parId = new Map(avis.map((a) => [a.id, a]));
    return ids.map((id) => parId.get(id)).filter((a): a is AvisCharge => !!a);
  }

  // ─── Filtres SQL (alias `a` = AvisPrive, `c` = Customer) ──────────────────

  private filtreStore(restaurantId: string | undefined): Prisma.Sql {
    if (!restaurantId) return Prisma.empty;
    if (restaurantId.toLowerCase() === STORE_AUCUN) return Prisma.sql`AND a.restaurant_id IS NULL`;
    return Prisma.sql`AND a.restaurant_id = ${restaurantId}::uuid`;
  }

  /**
   * Conditions de la liste et de l'export : périmètre, store, ressenti,
   * statut, retard, résolus sur 7 jours, période, recherche.
   *
   * Recherche par chiffres (4 ou plus) : dans le numéro de l'avis, SAUF pour
   * un rôle qui reçoit les numéros masqués (marketing). Pour lui, la
   * recherche est ignorée : la présence ou l'absence d'un avis dans la
   * réponse dirait sinon si une suite de chiffres figure dans le numéro, et
   * quelques centaines de recherches reconstitueraient un numéro masqué.
   */
  filtre(q: FiltresAvis, maintenant: Date, lecteur?: LecteurAvis): Prisma.Sql {
    const parties: Prisma.Sql[] = [Prisma.sql`a.entity_status::text <> 'DELETED'`, this.filtreStore(q.restaurantId)];
    if (q.ressenti) parties.push(Prisma.sql`AND a.ressenti::text = ${q.ressenti}`);
    if (q.statut) parties.push(Prisma.sql`AND a.statut::text = ${q.statut}`);
    if (q.en_retard === 'true') parties.push(Prisma.sql`AND ${sqlEnRetard(maintenant)}`);
    if (q.resolus_7j === 'true') parties.push(Prisma.sql`AND ${sqlResolusSurSeptJours(maintenant)}`);

    const periode = q.periode ?? '7j';
    if (periode === 'aujourdhui') parties.push(Prisma.sql`AND a.created_at >= ${debutDuJour(maintenant)}`);
    if (periode === '7j') parties.push(Prisma.sql`AND a.created_at >= ${new Date(maintenant.getTime() - 7 * JOUR)}`);
    if (periode === '30j') parties.push(Prisma.sql`AND a.created_at >= ${new Date(maintenant.getTime() - 30 * JOUR)}`);

    const terme = (q.recherche ?? '').trim();
    if (terme.length >= 2) {
      const numeros = chiffres(terme);
      if (/^[\d\s+.\-()]+$/.test(terme) && numeros.length >= 4) {
        if (!coordonneesMasquees(lecteur?.role)) {
          parties.push(Prisma.sql`AND regexp_replace(coalesce(a.telephone, ''), '[^0-9]', '', 'g') LIKE ${`%${numeros}%`}`);
        }
      } else {
        const motif = `%${terme.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        parties.push(Prisma.sql`AND (a.prenom ILIKE ${motif} OR a.commentaire ILIKE ${motif}
          OR c.first_name ILIKE ${motif} OR c.last_name ILIKE ${motif})`);
      }
    }
    return Prisma.join(parties, ' ');
  }

  /** Identifiants dans l'ordre du tri par défaut (3.9). */
  private async idsTries(filtre: Prisma.Sql, limite: number, decalage: number): Promise<string[]> {
    const lignes = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM "AvisPrive" a LEFT JOIN "Customer" c ON c.id = a.customer_id
      WHERE ${filtre}
      ${SQL_TRI}
      LIMIT ${limite} OFFSET ${decalage}`;
    return lignes.map((l) => l.id);
  }

  // ─── Liste, compteurs ─────────────────────────────────────────────────────

  async liste(q: ListeAvisQueryDto, lecteur?: LecteurAvis, maintenant = new Date()) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const filtre = this.filtre(q, maintenant, lecteur);
    const [compte] = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM "AvisPrive" a LEFT JOIN "Customer" c ON c.id = a.customer_id
      WHERE ${filtre}`;
    const total = compte?.total ?? 0;
    const avis = await this.chargerDansLOrdre(await this.idsTries(filtre, limit, (page - 1) * limit));
    return {
      data: avis.map((a) => this.versLigne(a, maintenant)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Compteurs du haut de la liste, sur le périmètre de l'utilisateur et le
   * filtre Store seulement. `a_traiter` (tout sauf Résolu et Classé) fait la
   * pastille de l'onglet.
   */
  async compteurs(restaurantId: string | undefined, maintenant = new Date()): Promise<CompteursAvis> {
    const [c] = await this.prisma.$queryRaw<CompteursAvis[]>`
      SELECT
        count(*) FILTER (WHERE a.statut::text = 'NOUVEAU')::int AS nouveaux,
        count(*) FILTER (WHERE a.statut::text = 'A_RAPPELER')::int AS a_rappeler,
        count(*) FILTER (WHERE ${sqlEnRetard(maintenant)})::int AS echeance_depassee,
        count(*) FILTER (WHERE ${sqlResolusSurSeptJours(maintenant)})::int AS resolus_7j,
        count(*) FILTER (WHERE a.statut::text NOT IN (${Prisma.join(STATUTS_CLOS)}))::int AS a_traiter
      FROM "AvisPrive" a
      WHERE a.entity_status::text <> 'DELETED' ${this.filtreStore(restaurantId)}`;
    return {
      nouveaux: c?.nouveaux ?? 0,
      a_rappeler: c?.a_rappeler ?? 0,
      echeance_depassee: c?.echeance_depassee ?? 0,
      resolus_7j: c?.resolus_7j ?? 0,
      a_traiter: c?.a_traiter ?? 0,
    };
  }

  /** Agents qui peuvent recevoir un avis : comptes actifs du siège, administrateurs et call center. */
  async agents(): Promise<{ id: string; fullname: string }[]> {
    return this.prisma.user.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
        type: UserType.BACKOFFICE,
        role: { in: [...ROLES_TRAITEMENT_AVIS] },
      },
      select: { id: true, fullname: true },
      orderBy: { fullname: 'asc' },
    });
  }

  versLigne(a: AvisCharge, maintenant: Date): AvisLigne {
    return {
      id: a.id,
      created_at: a.created_at,
      ressenti: a.ressenti,
      canal: a.canal,
      restaurant: a.restaurant ? { id: a.restaurant.id, name: a.restaurant.name } : null,
      commentaire_extrait: extrait(a.commentaire, EXTRAIT_LISTE),
      prenom: prenomAffiche(a.prenom, a.customer?.first_name),
      telephone: a.telephone,
      rapproche: !!a.customer_id,
      statut: a.statut,
      echeance_at: echeanceAffichee(a),
      en_retard: enRetard(a, maintenant),
      agent: a.agent ? { id: a.agent.id, fullname: a.agent.fullname } : null,
    };
  }

  // ─── Fiche ────────────────────────────────────────────────────────────────

  /**
   * Fiche d'un avis. Un avis encore « Non rapproché » est rapproché à
   * nouveau (le client a pu créer son compte depuis). Un compte de point de
   * vente n'ouvre que les avis de son restaurant (403 sinon, avis sans store
   * compris).
   */
  async fiche(id: string, user: User, maintenant = new Date()): Promise<AvisFiche> {
    let a = await this.charger(id);
    assertCanAccessRestaurant(user, a.restaurant_id);

    if (!a.customer_id && a.telephone && (await this.rapprocherPlusTard(a.id, a.telephone, maintenant))) {
      a = await this.charger(id);
    }

    const [crmContactId, commandes, suivis] = await Promise.all([
      this.ficheCrm(a.customer_id, a.telephone),
      this.dernieresCommandes(a, user),
      this.prisma.avisPriveSuivi.findMany({ where: { avis_id: a.id }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }),
    ]);

    return {
      ...this.versLigne(a, maintenant),
      commentaire: a.commentaire,
      accord_rappel: a.accord_rappel,
      source: a.source,
      solution: a.solution,
      premier_contact_at: a.premier_contact_at,
      tentatives_appel: a.tentatives_appel,
      client: {
        customer_id: a.customer_id,
        first_name: a.customer?.first_name ?? null,
        last_name: a.customer?.last_name ?? null,
        telephone: a.customer?.phone ?? null,
        crm_contact_id: crmContactId,
      },
      order_id: a.order_id,
      ticket: a.ticket ? { id: a.ticket.id, code: a.ticket.code, status: a.ticket.status } : null,
      incident: a.incidents?.[0] ?? null,
      dernieres_commandes: commandes,
      journal: suivis.map((s) => ({
        id: s.id,
        created_at: s.created_at,
        type: s.type,
        resultat: s.resultat,
        auteur: s.auteur_nom ?? 'Système',
        texte: texteSuivi(s),
      })),
    };
  }

  /**
   * Nouvel essai de rapprochement ; seul le premier qui écrit ajoute la ligne
   * au journal. Rend `true` dès qu'un compte existe (écrit ici ou par une
   * ouverture simultanée) : la fiche est alors relue.
   */
  private async rapprocherPlusTard(id: string, telephone: string, maintenant: Date): Promise<boolean> {
    const client = await this.trouverClient(telephone);
    if (!client) return false;
    await this.prisma.$transaction(async (tx) => {
      const pris = await tx.avisPrive.updateMany({
        where: { id, customer_id: null, entity_status: { not: EntityStatus.DELETED } },
        data: { customer_id: client.id, rapproche_at: maintenant },
      });
      if (pris.count === 0) return;
      await tx.avisPriveSuivi.create({
        data: { avis_id: id, type: AvisSuiviType.SYSTEME, note: TEXTE_RAPPROCHEMENT, created_at: maintenant },
      });
    });
    return true;
  }

  /**
   * Fiche CRM du client : celle de son compte, sinon une fiche sans compte au
   * même numéro (10 derniers chiffres). Aucune : pas de bouton.
   */
  private async ficheCrm(customerId: string | null, telephone: string | null): Promise<string | null> {
    if (customerId) {
      const fiche = await this.prisma.crmContact.findFirst({
        where: { customer_id: customerId, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true },
      });
      if (fiche) return fiche.id;
    }
    const cle = telephone ? chiffres(telephone).slice(-10) : '';
    if (cle.length !== 10) return null;
    const fiche = await this.prisma.crmContact.findFirst({
      where: { phone_key: cle, customer_id: null, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
    });
    return fiche?.id ?? null;
  }

  /**
   * Cinq dernières commandes du client, plus la commande cochée si elle est
   * plus ancienne. `null` pour un rôle qui ne voit pas les commandes
   * (marketing) ; restaurant du compte pour un point de vente.
   */
  private async dernieresCommandes(a: AvisCharge, user: User): Promise<CommandeRecente[] | null> {
    if (!rolePeut(user?.role, Modules.COMMANDES, Action.READ)) return null;
    if (!a.customer_id) return [];
    const restaurant = resolveRestaurantScope(user);
    const where: Prisma.OrderWhereInput = {
      customer_id: a.customer_id,
      entity_status: { not: EntityStatus.DELETED },
      ...(restaurant ? { restaurant_id: restaurant } : {}),
    };
    const select = {
      id: true,
      reference: true,
      created_at: true,
      channel: true,
      auto: true,
      status: true,
      type: true,
      amount: true,
      restaurant: { select: { id: true, name: true } },
      order_items: { select: { dish: { select: { name: true } } }, orderBy: { created_at: 'asc' }, take: 2 },
    } satisfies Prisma.OrderSelect;
    const commandes = await this.prisma.order.findMany({
      where,
      select,
      orderBy: { created_at: 'desc' },
      take: DERNIERES_COMMANDES,
    });
    if (a.order_id && !commandes.some((c) => c.id === a.order_id)) {
      const cochee = await this.prisma.order.findFirst({ where: { ...where, id: a.order_id }, select });
      if (cochee) commandes.push(cochee);
    }
    return commandes.map((c) => ({
      id: c.id,
      reference: c.reference,
      created_at: c.created_at,
      restaurant: { id: c.restaurant.id, name: c.restaurant.name },
      channel: c.channel,
      auto: c.auto,
      status: c.status,
      type: c.type,
      amount: c.amount,
      plats: c.order_items.map((i) => i.dish?.name).filter((n): n is string => !!n),
    }));
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  /** Export CSV des avis filtrés, dans l'ordre de la liste, 5 000 lignes au plus. */
  async exporter(q: FiltresAvis, lecteur?: LecteurAvis, maintenant = new Date()): Promise<FichierExport> {
    const avis = await this.chargerDansLOrdre(await this.idsTries(this.filtre(q, maintenant, lecteur), EXPORT_MAX, 0));
    const rangees = avis.map((a) => [
      formatDateExport(a.created_at),
      LIBELLE_RESSENTI[a.ressenti],
      prenomAffiche(a.prenom, a.customer?.first_name) ?? '',
      a.telephone ?? '',
      a.customer_id ? 'Oui' : 'Non',
      a.restaurant?.name ?? JE_NE_SAIS_PAS,
      LIBELLE_CANAL_EXPORT[a.canal],
      a.commentaire,
      a.accord_rappel ? 'Oui' : 'Non',
      libelleSource(a.source),
      LIBELLE_STATUT[a.statut],
      formatDateExport(echeanceAffichee(a)),
      a.solution ? LIBELLE_SOLUTION[a.solution] : '',
      a.agent?.fullname ?? '',
      a.order?.reference ?? '',
      a.ticket?.code ?? '',
      formatDateExport(a.resolu_at),
    ]);
    return {
      nom: `avis-prives-${maintenant.toISOString().slice(0, 10)}.csv`,
      type: 'text/csv; charset=utf-8',
      contenu: versCsv(ENTETES_EXPORT, rangees),
    };
  }
}
