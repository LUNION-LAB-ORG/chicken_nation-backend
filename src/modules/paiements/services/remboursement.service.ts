import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaiementStatus, User } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { RembourserPaiementDto } from '../dto/rembourser-paiement.dto';
import { PaiementEvent } from '../events/paiement.event';
import {
  DELAI_DEMANDE_MS,
  MESSAGE_CHANGE,
  MESSAGE_DEJA_REMBOURSE,
  MESSAGE_DROIT,
  MESSAGE_EN_COURS,
  MESSAGE_INCERTAIN,
  MESSAGE_INTROUVABLE,
  MESSAGE_MANUEL,
  MESSAGE_PAS_REMBOURSE_KKIAPAY,
  MESSAGE_PAS_REUSSI,
  bilanRemboursement,
  estPaiementKkiapay,
  estRembourseeChezKkiapay,
  libelleStatutKkiapay,
  messageRefusKkiapay,
  montantLisible,
  peutRembourser,
  statutKkiapay,
} from '../helpers/remboursement.rules';
import { PaiementsService } from './paiements.service';

const MESSAGE_INJOIGNABLE = 'KKiaPay ne répond pas. Réessayez dans un instant.';
/** Le paiement est remboursé chez KKiaPay mais pas encore chez nous : l'écran propose de l'enregistrer. */
export const CODE_REMBOURSEE_CHEZ_KKIAPAY = 'REMBOURSEE_CHEZ_KKIAPAY';

export interface VerificationRemboursement {
  paiement: {
    id: string;
    reference: string;
    montant: number;
    frais: number;
    total: number;
    moyen: string | null;
    date: Date;
    statut: PaiementStatus;
    rembourse_at: Date | null;
    rembourse_par: string | null;
  };
  commande: { id: string; reference: string } | null;
  /** Ce que dit KKiaPay ; null quand il n'a pas été interrogé (paiement manuel, déjà remboursé) ou ne connaît pas la transaction. */
  kkiapay: {
    statut: string;
    libelle: string;
    montant: number | null;
    frais: number | null;
    moyen: string | null;
    date: string | null;
  } | null;
  /** Compte KKiaPay qui a encaissé. */
  compte: string;
  remboursable: boolean;
  constatable: boolean;
  raison: string | null;
}

export interface ResultatRemboursement {
  message: string;
  paiement: { id: string; status: PaiementStatus; rembourse_at: Date | null; rembourse_par_nom: string | null };
  /** La commande est-elle encore payée (autre paiement) ? null sans commande. */
  commande_payee: boolean | null;
}

const nombre = (v: unknown): number | null => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const texte = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

type PaiementCharge = NonNullable<Awaited<ReturnType<RemboursementService['charger']>>>;

/**
 * REMBOURSEMENT KKiaPay d'un paiement, depuis l'onglet Paiement d'une commande
 * (12/11). Deux temps : la vérification auprès du compte qui a encaissé
 * (lecture seule), puis la demande de remboursement, revendiquée sur le
 * paiement (un seul clic aboutit, deux backends compris) et revérifiée juste
 * avant de partir.
 *
 * Le paiement passe « Remboursé » (REVERTED) avec qui et quand ; la commande
 * repasse « non payée » si plus rien ne la couvre, sans alerte d'impayé
 * (voir `impaye.rules.ts`).
 */
@Injectable()
export class RemboursementService {
  private readonly logger = new Logger(RemboursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kkiapay: KkiapayService,
    private readonly paiements: PaiementsService,
    private readonly paiementEvent: PaiementEvent,
  ) {}

  async charger(id: string) {
    return this.prisma.paiement.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        amount: true,
        fees: true,
        total: true,
        mode: true,
        source: true,
        status: true,
        created_at: true,
        restaurant_id: true,
        order_id: true,
        rembourse_at: true,
        rembourse_par_nom: true,
        order: { select: { id: true, reference: true, restaurant_id: true } },
      },
    });
  }

  /** Le paiement, si ce compte peut le rembourser : 404 sinon, 403 pour une commande d'un autre restaurant. */
  private async chargerAutorise(id: string, user: User): Promise<PaiementCharge> {
    const p = await this.charger(id);
    if (!p) throw new NotFoundException(MESSAGE_INTROUVABLE);
    if (!peutRembourser(user, p.order?.restaurant_id ?? null)) throw new ForbiddenException(MESSAGE_DROIT);
    return p;
  }

  /** Nom du compte KKiaPay qui a encaissé. */
  private async nomCompte(restaurantId: string | null): Promise<string> {
    if (!restaurantId) return 'Compte global';
    const r = await this.prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true } });
    return r?.name ? `Compte du restaurant ${r.name}` : 'Compte du restaurant';
  }

  /** La transaction chez KKiaPay, en traduisant ses pannes en messages lisibles. */
  private async lire(p: PaiementCharge) {
    try {
      return await this.kkiapay.lireSurCompteEncaisseur(p.reference, p.restaurant_id ?? null);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw new ServiceUnavailableException(MESSAGE_INJOIGNABLE);
      throw e;
    }
  }

  // ─── Vérifier ───────────────────────────────────────────────────────────────

  /** Lecture seule : ce que dit KKiaPay de la transaction, et ce qui est permis. */
  async verifier(id: string, user: User): Promise<VerificationRemboursement> {
    const p = await this.chargerAutorise(id, user);
    const base = {
      paiement: {
        id: p.id,
        reference: p.reference,
        montant: p.amount,
        frais: p.fees,
        total: p.total,
        moyen: p.source,
        date: p.created_at,
        statut: p.status,
        rembourse_at: p.rembourse_at,
        rembourse_par: p.rembourse_par_nom,
      },
      commande: p.order ? { id: p.order.id, reference: p.order.reference } : null,
      compte: await this.nomCompte(p.restaurant_id ?? null),
    };
    if (!estPaiementKkiapay(p)) {
      return { ...base, kkiapay: null, remboursable: false, constatable: false, raison: MESSAGE_MANUEL };
    }
    if (p.status === PaiementStatus.REVERTED || p.rembourse_at) {
      return { ...base, kkiapay: null, remboursable: false, constatable: false, raison: MESSAGE_DEJA_REMBOURSE };
    }
    const t = await this.lire(p);
    const bilan = bilanRemboursement(p, t);
    return {
      ...base,
      kkiapay: t
        ? {
            statut: statutKkiapay(t),
            libelle: libelleStatutKkiapay(t),
            montant: nombre(t.amount),
            frais: nombre(t.fees),
            moyen: texte(t.source_common_name) ?? texte(t.source),
            date: texte(t.performedAt) ?? texte(t.performed_at),
          }
        : null,
      ...bilan,
    };
  }

  // ─── Rembourser ─────────────────────────────────────────────────────────────

  /**
   * Revendique le paiement, revérifie chez KKiaPay, puis demande le
   * remboursement. Rien n'est marqué si KKiaPay refuse ou ne répond pas
   * clairement ; la revendication est alors rendue.
   */
  async rembourser(id: string, dto: RembourserPaiementDto, user: User, maintenant = new Date()): Promise<ResultatRemboursement> {
    const p = await this.preparer(id, dto, user);
    await this.revendiquer(p.id, maintenant);
    let enregistre = false;
    try {
      const t = await this.lire(p);
      const bilan = bilanRemboursement(p, t);
      if (!bilan.remboursable) {
        if (bilan.constatable) {
          throw new ConflictException({ message: bilan.raison, code: CODE_REMBOURSEE_CHEZ_KKIAPAY });
        }
        throw new BadRequestException(bilan.raison);
      }
      const issue = await this.kkiapay.rembourserTransaction(p.reference, p.restaurant_id ?? null);
      if (issue.issue === 'REFUSE') throw new BadRequestException(messageRefusKkiapay(issue.code, issue.raison));
      if (issue.issue === 'INCERTAIN') throw new HttpException(MESSAGE_INCERTAIN, 502);
      const resultat = await this.enregistrer(p, user, maintenant, `Remboursement de ${montantLisible(Number(t?.amount ?? p.amount))} effectué.`);
      enregistre = true;
      return resultat;
    } finally {
      if (!enregistre) await this.rendre(p.id, maintenant);
    }
  }

  /**
   * « Enregistrer le remboursement » : KKiaPay l'a déjà fait (relance après une
   * réponse incertaine, remboursement fait depuis son tableau de bord). On ne
   * lui redemande rien ; on le note chez nous.
   */
  async constater(id: string, dto: RembourserPaiementDto, user: User, maintenant = new Date()): Promise<ResultatRemboursement> {
    const p = await this.preparer(id, dto, user);
    await this.revendiquer(p.id, maintenant);
    let enregistre = false;
    try {
      const t = await this.lire(p);
      if (!estRembourseeChezKkiapay(t)) throw new ConflictException(MESSAGE_PAS_REMBOURSE_KKIAPAY);
      const resultat = await this.enregistrer(p, user, maintenant, 'Remboursement enregistré.');
      enregistre = true;
      return resultat;
    } finally {
      if (!enregistre) await this.rendre(p.id, maintenant);
    }
  }

  /** Contrôles communs : droits, paiement KKiaPay, référence vue à l'écran, statut. */
  private async preparer(id: string, dto: RembourserPaiementDto, user: User): Promise<PaiementCharge> {
    const p = await this.chargerAutorise(id, user);
    if (!estPaiementKkiapay(p)) throw new BadRequestException(MESSAGE_MANUEL);
    if (dto.reference !== p.reference) throw new ConflictException(MESSAGE_CHANGE);
    if (p.status === PaiementStatus.REVERTED || p.rembourse_at) throw new ConflictException(MESSAGE_DEJA_REMBOURSE);
    if (p.status !== PaiementStatus.SUCCESS) throw new BadRequestException(MESSAGE_PAS_REUSSI);
    return p;
  }

  /** Un seul clic aboutit : la demande est revendiquée sur le paiement encore réussi. */
  private async revendiquer(id: string, maintenant: Date): Promise<void> {
    const pris = await this.prisma.paiement.updateMany({
      where: {
        id,
        status: PaiementStatus.SUCCESS,
        rembourse_at: null,
        OR: [
          { remboursement_demande_at: null },
          { remboursement_demande_at: { lt: new Date(maintenant.getTime() - DELAI_DEMANDE_MS) } },
        ],
      },
      data: { remboursement_demande_at: maintenant },
    });
    if (pris.count === 0) throw new ConflictException(MESSAGE_EN_COURS);
  }

  private async rendre(id: string, maintenant: Date): Promise<void> {
    try {
      await this.prisma.paiement.updateMany({
        where: { id, remboursement_demande_at: maintenant },
        data: { remboursement_demande_at: null },
      });
    } catch (e) {
      this.logger.warn(`Revendication du remboursement ${id} non rendue : ${(e as Error)?.message}`);
    }
  }

  /**
   * L'argent est rendu : le paiement passe « Remboursé », avec qui et quand,
   * puis la commande est recalculée (« non payée » si plus rien ne la couvre).
   */
  private async enregistrer(p: PaiementCharge, user: User, maintenant: Date, message: string): Promise<ResultatRemboursement> {
    const maj = await this.prisma.paiement.update({
      where: { id: p.id },
      data: {
        status: PaiementStatus.REVERTED,
        rembourse_at: maintenant,
        rembourse_par_id: user.id,
        rembourse_par_nom: user.fullname,
        remboursement_demande_at: null,
        updated_at: maintenant,
      },
      select: { id: true, status: true, rembourse_at: true, rembourse_par_nom: true },
    });
    this.logger.log(`Paiement ${p.id} (${p.reference}) remboursé par ${user.fullname}`);
    let commandePayee: boolean | null = null;
    if (p.order_id) {
      try {
        await this.paiements.recomputeOrderPaiedFlag(p.order_id);
        const o = await this.prisma.order.findUnique({ where: { id: p.order_id }, select: { paied: true } });
        commandePayee = o?.paied ?? null;
      } catch (e) {
        // Le remboursement est fait et noté : un recalcul raté se rattrape au prochain encaissement.
        this.logger.error(`Commande du paiement remboursé ${p.id} non recalculée : ${(e as Error)?.message}`);
      }
    }
    this.paiementEvent.paiementAnnule(maj);
    return { message, paiement: maj, commande_payee: commandePayee };
  }
}

