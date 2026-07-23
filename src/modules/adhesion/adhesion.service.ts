import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CardRequestService } from 'src/modules/card-nation/services/card-request.service';
import { CreateAdhesionDto } from './dto/create-adhesion.dto';
import { customerPhoneVariants } from 'src/common/utils/customer-phone.util';

/**
 * Tunnel d'adhésion (Phase 4) — PRÉ-INSCRIPTION SILENCIEUSE depuis le site.
 *
 * Objectif : le visiteur laisse nom + téléphone + profil déclaratif ; on
 * crée/retrouve son Customer (idempotent par téléphone), on enregistre son
 * consentement WhatsApp, puis on crée (best-effort) une DEMANDE de carte PENDING.
 * La carte — et le WhatsApp « carte prête » — sont émis à la VALIDATION backoffice
 * (pas ici) : la carte n'est jamais auto-émise.
 *
 * RG-07 : AUCUNE session n'est créée ici. Le client se connectera ensuite dans
 * l'app par OTP sur le MÊME numéro → il retombe sur le compte déjà pré-créé.
 * Pour que la jonction fonctionne, on normalise le téléphone EXACTEMENT comme
 * le login OTP de l'app (E.164 CI → `+225XXXXXXXXXX`).
 */
@Injectable()
export class AdhesionService {
  private readonly logger = new Logger(AdhesionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cardRequestService: CardRequestService,
  ) {}

  async register(dto: CreateAdhesionDto, photo?: Express.Multer.File) {
    // Photo FACULTATIVE sur le tunnel web (décision 22/07) : elle sert à la
    // vérification backoffice et peut être fournie plus tard dans l'app.
    const phone = this.normalizePhone(dto.phone);
    const now = new Date();

    // Découpe simple du nom déclaré en prénom / reste (best-effort d'affichage).
    const { firstName, lastName } = this.splitName(dto.name);

    // Pré-inscription IDEMPOTENTE par téléphone (unique). Un numéro déjà présent
    // (créé par un login OTP antérieur ou une adhésion précédente) est mis à
    // jour, jamais dupliqué. On NE réactive PAS un compte SUPPRIMÉ ici (respect
    // du soft-delete) : on retombe sur upsert avec entity_status inchangé.
    const optInData: Prisma.CustomerUpdateInput =
      dto.whatsapp_opt_in === true
        ? { whatsapp_opt_in: true, whatsapp_opt_in_at: now }
        : { whatsapp_opt_in: false, whatsapp_opt_in_at: null };

    // Lookup TOLÉRANT (`+225…` app / `225…` héritée) : un compte déjà créé par
    // le login OTP de l'app doit être RETROUVÉ, jamais dupliqué. On préfère un
    // compte NON supprimé (les doublons fusionnés par migration restent en
    // DELETED avec leur graphie `225…`) ; à défaut on retombe sur la ligne
    // supprimée (comportement historique : mise à jour sans réactivation).
    const variants = customerPhoneVariants(phone);
    const existing =
      (await this.prisma.customer.findFirst({
        where: { phone: { in: variants }, entity_status: { not: 'DELETED' } },
        orderBy: { created_at: 'asc' },
      })) ??
      (await this.prisma.customer.findFirst({
        where: { phone: { in: variants } },
        orderBy: { created_at: 'asc' },
      }));

    const customer = existing
      ? // À la mise à jour : on ne réécrit le nom que s'il n'était pas déjà connu
        // (ne pas écraser un profil déjà renseigné par le client dans l'app).
        await this.prisma.customer.update({
          where: { id: existing.id },
          data: {
            first_name: existing.first_name?.trim() ? undefined : (firstName ?? undefined),
            last_name: existing.last_name?.trim() ? undefined : (lastName ?? undefined),
            profile_type: dto.profile_type,
            ...optInData,
          },
        })
      : // À la création : on pose nom + profil + opt-in.
        await this.prisma.customer.create({
          data: {
            phone,
            first_name: firstName,
            last_name: lastName,
            profile_type: dto.profile_type,
            whatsapp_opt_in: dto.whatsapp_opt_in === true,
            whatsapp_opt_in_at: dto.whatsapp_opt_in === true ? now : null,
          },
        });

    // 💳 DEMANDE DE CARTE (V1 déclaratif) — BEST-EFFORT. On crée une demande en
    // statut PENDING : la carte N'EST PLUS émise ici. C'est le backoffice qui la
    // validera (et c'est à la validation que part le WhatsApp « carte prête »).
    // createRequest gère les gardes : no-op (ConflictException) si le client a déjà
    // une carte/demande en cours. N'échoue JAMAIS l'adhésion.
    try {
      await this.cardRequestService.createRequest(
        customer.id,
        {
          profile_type: dto.profile_type,
          nickname: firstName || undefined,
          institution: dto.establishment,
        },
        undefined,
        { file: photo },
      );
    } catch (error: any) {
      this.logger.log(
        `[Adhesion] Demande de carte non créée à l'adhésion (best-effort) pour ${phone} : ${
          error?.message || error
        }`,
      );
    }

    // On ne renvoie AUCUNE donnée sensible ni de session (RG-07).
    return {
      success: true,
      message:
        "Votre pré-inscription est enregistrée. Ouvrez l'application Chicken Nation avec ce numéro pour récupérer votre carte.",
    };
  }

  /**
   * Normalise un téléphone ivoirien en `+225XXXXXXXXXX` (E.164).
   *
   * On garde les 10 derniers chiffres (le numéro national CI) et on préfixe
   * `+225` : c'est le format que le login OTP de l'app écrit en base → la
   * pré-inscription et le compte créé au login se rejoignent (RG-07), et
   * l'appel est idempotent quel que soit le format saisi sur le site.
   * ⚠️ L'ancien format `225…` (sans `+`) créait des DOUBLONS : résorbé par la
   * migration de fusion + les lookups tolérants (customerPhoneVariants).
   */
  private normalizePhone(raw: string): string {
    const digits = (raw || '').replace(/\D/g, '');
    const national = digits.slice(-10); // 10 derniers = numéro CI
    return `+225${national}`;
  }

  private splitName(name: string): {
    firstName: string | null;
    lastName: string | null;
  } {
    const cleaned = (name || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) return { firstName: null, lastName: null };
    const parts = cleaned.split(' ');
    const firstName = parts.shift() ?? null;
    const lastName = parts.length ? parts.join(' ') : null;
    return { firstName, lastName };
  }
}
