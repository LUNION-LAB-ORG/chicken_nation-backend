import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  IndicesReperes,
  Reperes,
  assemblerReperes,
  ciblesDeLEntree,
  ciblesRetenues,
  conditionRechercheAudit,
  sansReperes,
} from './audit-reperes.rules';
import { lireFiches } from './audit-reperes.lecture';

/** Entrée brute à journaliser (fournie par l'intercepteur). */
export interface AuditEntry {
  actor_id?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  restaurant_id?: string | null;
  action: string;
  module?: string | null;
  entity_id?: string | null;
  method: string;
  path: string;
  status_code?: number | null;
  duration_ms?: number | null;
  ip?: string | null;
  user_agent?: string | null;
  summary?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  /**
   * Repères lisibles de la cible. Laissés vides, ils sont relus par
   * `record` sur ce que la ligne désigne (`audit-reperes.rules.ts`).
   */
  target_ref?: string | null;
  target_name?: string | null;
  target_phone?: string | null;
  search_text?: string | null;
}

export interface AuditQuery {
  page?: number;
  limit?: number;
  /** 'actions' = mutations réussies du staff ; 'logs' = tout, dont les erreurs. */
  view?: 'actions' | 'logs';
  actor_id?: string;
  module?: string;
  action?: string;
  method?: string;
  /** true = ne garder que les erreurs (status >= 400). */
  errors_only?: boolean;
  search?: string;
  from?: string;
  to?: string;
}

const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Écriture FIRE-AND-FORGET : ne bloque JAMAIS la requête et n'échoue jamais
   * la réponse. Un log d'audit perdu est préférable à une requête cassée.
   *
   * Avant d'écrire, la ligne reçoit ses repères lisibles (référence, personne
   * concernée, numéro) : relus sur ce qu'elle désigne, complétés par ce que
   * l'intercepteur a vu de la requête (`indices`). Des repères introuvables
   * n'empêchent jamais l'écriture.
   */
  record(entry: AuditEntry, indices?: IndicesReperes): void {
    void this.ecrire(entry, indices).catch((e) =>
      this.logger.warn(`Audit non écrit : ${(e as Error)?.message}`),
    );
  }

  private async ecrire(entry: AuditEntry, indices?: IndicesReperes): Promise<void> {
    const reperes = await this.reperes(entry, indices).catch((e) => {
      this.logger.warn(`Audit : repères non lus : ${(e as Error)?.message}`);
      return null;
    });
    await this.prisma.auditLog.create({ data: { ...entry, ...(reperes ?? {}) } as Prisma.AuditLogCreateInput });
  }

  /** Repères de la ligne, ou `null` quand elle n'en a pas (ou les porte déjà). */
  private async reperes(entry: AuditEntry, indices?: IndicesReperes): Promise<Reperes | null> {
    if (sansReperes(entry.path)) return null;
    if (entry.target_ref || entry.target_name || entry.target_phone || entry.search_text) return null;
    const cibles = ciblesRetenues([...(indices?.cibles ?? []), ...ciblesDeLEntree(entry)]);
    const lues = cibles.length
      ? await lireFiches(this.prisma, cibles, (cible, e) =>
          this.logger.warn(`Audit : ${cible.type} ${cible.id ?? cible.reference} non relu : ${(e as Error)?.message}`),
        )
      : [];
    return assemblerReperes([...lues, ...(indices?.fiches ?? [])]);
  }

  /**
   * Liste paginée + filtrée. Deux angles de lecture d'une même table :
   *  - `actions` : les mutations réussies du personnel (audit métier) ;
   *  - `logs` : tout ce qui a été capturé, erreurs comprises (angle technique).
   */
  async list(query: AuditQuery) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 25)));

    const where: Prisma.AuditLogWhereInput = {};
    const and: Prisma.AuditLogWhereInput[] = [];

    if (query.view === 'actions') {
      // Audit métier : mutations réussies (on écarte le bruit technique).
      and.push({ method: { in: MUTATION_METHODS } });
      and.push({ OR: [{ status_code: null }, { status_code: { lt: 400 } }] });
    }
    if (query.errors_only) and.push({ status_code: { gte: 400 } });
    if (query.actor_id) where.actor_id = query.actor_id;
    if (query.module) where.module = query.module;
    if (query.action) where.action = query.action;
    if (query.method) where.method = query.method.toUpperCase();

    if (query.from || query.to) {
      where.created_at = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    // Auteur, chemin, résumé, identifiant ; et les repères de la cible :
    // référence d'une commande, nom ou numéro de la personne concernée.
    const recherche = conditionRechercheAudit(query.search);
    if (recherche) and.push(recherche);

    if (and.length) where.AND = and;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: page * limit < total,
      },
    };
  }

  /** Valeurs de filtres pour l'UI : modules distincts + auteurs récents. */
  async filters() {
    const [modules, actors] = await Promise.all([
      this.prisma.auditLog.findMany({
        distinct: ['module'],
        where: { module: { not: null } },
        select: { module: true },
        orderBy: { module: 'asc' },
        take: 100,
      }),
      this.prisma.auditLog.findMany({
        distinct: ['actor_id'],
        where: { actor_id: { not: null } },
        select: { actor_id: true, actor_name: true },
        orderBy: { actor_name: 'asc' },
        take: 200,
      }),
    ]);

    return {
      modules: modules.map((m) => m.module).filter(Boolean),
      actors: actors
        .filter((a) => a.actor_id)
        .map((a) => ({ id: a.actor_id, name: a.actor_name })),
    };
  }

  /** Purge des logs plus vieux que `days` (rétention). */
  async prune(days: number): Promise<number> {
    if (!(days > 0)) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const res = await this.prisma.auditLog.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    return res.count;
  }
}
