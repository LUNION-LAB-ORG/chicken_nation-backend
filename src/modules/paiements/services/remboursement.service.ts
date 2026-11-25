import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FournisseurPaiement, PaiementStatus, User } from '@prisma/client';
import { ErreurPaystack } from 'src/paystack/paystack-http';
import { EvenementRemboursementPaystack, PaystackChannels } from 'src/paystack/paystack.channels';
import { PaystackService } from 'src/paystack/paystack.service';
import type { TransactionPaystackLue } from 'src/paystack/paystack.rules';
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
  MESSAGE_PAYSTACK_EN_COURS,
  MESSAGE_PAYSTACK_INJOIGNABLE,
  MESSAGE_PAYSTACK_PAS_REMBOURSE,
  bilanRemboursement,
  bilanRemboursementPaystack,
  libelleStatutPaystack,
  referenceRemboursementPaystack,
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
  /** Compte qui a encaissé. */
  compte: string;
  /** Prestataire du paiement (25/11) : le bloc `kkiapay` porte alors ce que dit Paystack. */
  fournisseur: FournisseurPaiement;
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
    // En dernier : les essais existants construisent le service sans lui.
    @Optional() private readonly paystack?: PaystackService,
  ) {}

  private estPaystack(p: { fournisseur?: FournisseurPaiement | null }): boolean {
    return p.fournisseur === FournisseurPaiement.PAYSTACK;
  }

  /** La transaction chez Paystack ; null si inconnue. Pannes traduites en messages lisibles. */
  private async lirePaystack(p: PaiementCharge): Promise<TransactionPaystackLue | null> {
    if (!this.paystack) throw new ServiceUnavailableException(MESSAGE_PAYSTACK_INJOIGNABLE);
    try {
      return await this.paystack.verifier(p.reference);
    } catch (e) {
      if (e instanceof ErreurPaystack && e.nature === 'INTROUVABLE') return null;
      throw new ServiceUnavailableException(MESSAGE_PAYSTACK_INJOIGNABLE);
    }
  }

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
        rembourse_par_id: true,
        remboursement_demande_at: true,
        fournisseur: true,
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
      compte: this.estPaystack(p)
        ? (await this.nomCompte(p.restaurant_id ?? null)).replace(/^Compte du restaurant/, 'Sous-compte Paystack du restaurant')
        : await this.nomCompte(p.restaurant_id ?? null),
      fournisseur: p.fournisseur ?? FournisseurPaiement.KKIAPAY,
    };
    if (this.estPaystack(p)) {
      if (p.status === PaiementStatus.REVERTED || p.rembourse_at) {
        return { ...base, kkiapay: null, remboursable: false, constatable: false, raison: MESSAGE_DEJA_REMBOURSE };
      }
      const t = await this.lirePaystack(p);
      const bilan = bilanRemboursementPaystack({ ...p, demandeEnCours: this.demandePaystackEnCours(p) }, t);
      return {
        ...base,
        kkiapay: t
          ? {
              statut: t.statutPaystack.toUpperCase(),
              libelle: libelleStatutPaystack(t.statutPaystack),
              montant: t.montant,
              frais: t.frais,
              moyen: t.source,
              date: t.paieLe,
            }
          : null,
        ...bilan,
      };
    }
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
    if (this.estPaystack(p)) return this.rembourserPaystack(p, user, maintenant);
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
    await this.revendiquer(p.id, maintenant, { memeSiDemandeEnCours: this.estPaystack(p) });
    let enregistre = false;
    try {
      if (this.estPaystack(p)) {
        const t = await this.lirePaystack(p);
        if (t?.statutPaystack !== 'reversed') throw new ConflictException(MESSAGE_PAYSTACK_PAS_REMBOURSE);
      } else {
        const t = await this.lire(p);
        if (!estRembourseeChezKkiapay(t)) throw new ConflictException(MESSAGE_PAS_REMBOURSE_KKIAPAY);
      }
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

  /**
   * Un seul clic aboutit : la demande est revendiquée sur le paiement encore
   * réussi. `memeSiDemandeEnCours` : un remboursement Paystack déjà demandé
   * (et pas encore traité) peut être enregistré une fois fait.
   */
  private async revendiquer(id: string, maintenant: Date, options: { memeSiDemandeEnCours?: boolean } = {}): Promise<void> {
    const pris = await this.prisma.paiement.updateMany({
      where: {
        id,
        status: PaiementStatus.SUCCESS,
        rembourse_at: null,
        ...(options.memeSiDemandeEnCours
          ? {}
          : {
              OR: [
                { remboursement_demande_at: null },
                { remboursement_demande_at: { lt: new Date(maintenant.getTime() - DELAI_DEMANDE_MS) } },
              ],
            }),
      },
      data: { remboursement_demande_at: maintenant },
    });
    if (pris.count === 0) throw new ConflictException(MESSAGE_EN_COURS);
  }

  /** Remboursement Paystack demandé et pas encore traité : la personne qui l'a demandé est notée, sans date de remboursement. */
  private demandePaystackEnCours(p: { rembourse_at: Date | null; rembourse_par_id?: string | null; remboursement_demande_at?: Date | null }): boolean {
    return !p.rembourse_at && !!p.rembourse_par_id && !!p.remboursement_demande_at;
  }

  /**
   * PAYSTACK (25/11) : revérifie chez Paystack, puis demande le remboursement
   * avec notre référence (une par paiement : un second envoi ne crée pas un
   * second remboursement). Paystack traite souvent en différé : « en cours »,
   * la personne qui a demandé est notée et le paiement passe « Remboursé » au
   * webhook `refund.processed` (ou à « Enregistrer le remboursement »).
   */
  private async rembourserPaystack(p: PaiementCharge, user: User, maintenant: Date): Promise<ResultatRemboursement> {
    if (this.demandePaystackEnCours(p)) throw new ConflictException(MESSAGE_PAYSTACK_EN_COURS);
    await this.revendiquer(p.id, maintenant);
    let garder = false;
    try {
      const t = await this.lirePaystack(p);
      const bilan = bilanRemboursementPaystack(p, t);
      if (!bilan.remboursable) {
        if (bilan.constatable) throw new ConflictException({ message: bilan.raison, code: CODE_REMBOURSEE_CHEZ_KKIAPAY });
        throw new BadRequestException(bilan.raison);
      }
      let statut: string;
      try {
        ({ statut } = await this.paystack!.rembourser({
          transaction: p.reference,
          montant: Math.round(t?.montant ?? p.amount),
          reference: referenceRemboursementPaystack(p.id),
          note: `Commande ${p.order?.reference ?? ''} remboursée par ${user.fullname}`.trim(),
        }));
      } catch (e) {
        if (e instanceof ErreurPaystack && e.nature === 'INJOIGNABLE') throw new HttpException(MESSAGE_INCERTAIN, 502);
        if (e instanceof ErreurPaystack) {
          throw new BadRequestException(e.messagePaystack ? `Paystack refuse le remboursement : ${e.messagePaystack}` : 'Paystack refuse le remboursement.');
        }
        throw e;
      }
      if (statut === 'processed') {
        const resultat = await this.enregistrer(p, user, maintenant, `Remboursement de ${montantLisible(Math.round(t?.montant ?? p.amount))} effectué.`);
        garder = true;
        return resultat;
      }
      if (statut === 'failed') throw new BadRequestException("Paystack n'a pas pu rembourser ce paiement.");
      if (!['pending', 'processing', 'needs-attention'].includes(statut)) throw new HttpException(MESSAGE_INCERTAIN, 502);
      // Demandé, pas encore traité : la revendication reste, avec qui l'a demandé.
      const maj = await this.prisma.paiement.update({
        where: { id: p.id },
        data: { rembourse_par_id: user.id, rembourse_par_nom: user.fullname, remboursement_demande_at: maintenant },
        select: { id: true, status: true, rembourse_at: true, rembourse_par_nom: true },
      });
      garder = true;
      this.logger.log(`Remboursement Paystack demandé pour ${p.id} (${p.reference}) par ${user.fullname} : ${statut}.`);
      return {
        message:
          statut === 'needs-attention'
            ? "Remboursement demandé : Paystack a besoin des coordonnées du client pour le terminer. Complétez-le depuis le tableau de bord Paystack."
            : MESSAGE_PAYSTACK_EN_COURS,
        paiement: maj,
        commande_payee: null,
      };
    } finally {
      if (!garder) await this.rendre(p.id, maintenant);
    }
  }

  /**
   * Webhook `refund.*` de Paystack (25/11) : remboursement traité, le
   * paiement passe « Remboursé » (fait depuis notre écran ou depuis le
   * tableau de bord Paystack) ; échoué, la demande est rendue.
   */
  @OnEvent(PaystackChannels.REMBOURSEMENT, { suppressErrors: false })
  async remboursementPaystack(evenement: EvenementRemboursementPaystack): Promise<void> {
    const paiements = await this.prisma.paiement.findMany({
      where: { reference: evenement.reference, fournisseur: FournisseurPaiement.PAYSTACK, status: PaiementStatus.SUCCESS },
      select: { id: true, reference: true, order_id: true, rembourse_par_nom: true, rembourse_at: true },
    });
    const maintenant = new Date();
    for (const p of paiements) {
      if (evenement.statut === 'processed') {
        const maj = await this.prisma.paiement.update({
          where: { id: p.id },
          data: {
            status: PaiementStatus.REVERTED,
            rembourse_at: maintenant,
            rembourse_par_nom: p.rembourse_par_nom ?? 'Tableau de bord Paystack',
            remboursement_demande_at: null,
            updated_at: maintenant,
          },
          select: { id: true, status: true, rembourse_at: true, rembourse_par_nom: true },
        });
        if (p.order_id) await this.paiements.recomputeOrderPaiedFlag(p.order_id);
        this.paiementEvent.paiementAnnule(maj);
        this.logger.log(`Remboursement Paystack traité : paiement ${p.id} (${p.reference}) remboursé.`);
      } else if (evenement.statut === 'failed' && !p.rembourse_at) {
        await this.prisma.paiement.update({
          where: { id: p.id },
          data: { remboursement_demande_at: null, rembourse_par_id: null, rembourse_par_nom: null },
        });
        this.logger.warn(`Remboursement Paystack échoué pour ${p.id} (${p.reference}) : demande rendue.`);
      }
    }
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

