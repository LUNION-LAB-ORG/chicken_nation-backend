import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { S3Service } from 'src/s3/s3.service';
import { CardRequestService } from 'src/modules/card-nation/services/card-request.service';
import { CreateAdhesionDto } from './dto/create-adhesion.dto';
import {
  customerPhoneVariants,
  normaliserTelephoneCI,
} from 'src/common/utils/customer-phone.util';

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
    private readonly s3service: S3Service,
  ) {}

  async register(dto: CreateAdhesionDto, photo?: Express.Multer.File) {
    // Photo FACULTATIVE sur le tunnel web (décision 22/07) : elle sert à la
    // vérification backoffice et peut être fournie plus tard dans l'app.
    const phone = this.normalizePhone(dto.phone);
    const now = new Date();

    // Prénom / nom : les champs EXPLICITES du formulaire priment (un prénom
    // composé « Jean Marc » n'est plus coupé) ; `name` (legacy, ancien site
    // encore déployé) reste accepté en secours via la découpe best-effort.
    const explicitFirst = dto.first_name?.trim() || null;
    const explicitLast = dto.last_name?.trim() || null;
    const { firstName, lastName } =
      explicitFirst || explicitLast
        ? { firstName: explicitFirst, lastName: explicitLast }
        : this.splitName(dto.name ?? '');
    if (!firstName && !lastName) {
      throw new BadRequestException('Le nom est requis.');
    }

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

    // Email PLACEHOLDER (déterministe par téléphone, donc unique et idempotent) :
    // le client venu du site ne saisit pas d'email, mais un email non nul évite
    // les trous dans les exports/intégrations. Le client pourra le remplacer
    // par le sien dans l'app (le placeholder n'est posé que si l'email manque).
    const placeholderEmail = `${phone.replace('+', '')}@client.chicken-nation.com`;

    // 📸 Photo soumise → PHOTO DE PROFIL du compte (décision 30/07) : uploadée
    // dans le dossier avatar client (le même que l'app), posée à la création ou
    // en complément d'un compte existant SANS image (on n'écrase jamais un
    // avatar choisi par le client). La photo de VÉRIFICATION de la demande de
    // carte reste gérée par createRequest (usage distinct). Best-effort : un
    // échec S3 ne bloque jamais l'adhésion.
    let avatarKey: string | null = null;
    if (photo?.buffer?.length) {
      try {
        const upload = await this.s3service.uploadFile({
          buffer: photo.buffer,
          path: 'chicken-nation/customer-avatar',
          originalname: photo.originalname || 'adhesion-photo.jpg',
          mimetype: photo.mimetype || 'image/jpeg',
        });
        avatarKey = upload?.key ?? null;
      } catch (e: any) {
        this.logger.warn(
          `[Adhesion] Avatar non uploadé (best-effort) pour ${phone} : ${e?.message || e}`,
        );
      }
    }

    const customer = existing
      ? // À la mise à jour : on ne réécrit le nom que s'il n'était pas déjà connu
        // (ne pas écraser un profil déjà renseigné par le client dans l'app).
        await this.prisma.customer.update({
          where: { id: existing.id },
          data: {
            first_name: existing.first_name?.trim() ? undefined : (firstName ?? undefined),
            last_name: existing.last_name?.trim() ? undefined : (lastName ?? undefined),
            email: existing.email?.trim() ? undefined : placeholderEmail,
            image: existing.image?.trim() ? undefined : (avatarKey ?? undefined),
            profile_type: dto.profile_type,
            ...optInData,
          },
        })
      : // À la création : on pose nom + profil + opt-in + photo de profil.
        await this.prisma.customer.create({
          data: {
            phone,
            first_name: firstName,
            last_name: lastName,
            email: placeholderEmail,
            image: avatarKey,
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
   * Normalise un téléphone en E.164 `+<indicatif><numéro>`, Côte d'Ivoire par
   * défaut. La règle vit dans `customer-phone.util` et est la MÊME que celle du
   * formulaire du site, pour que les deux ne divergent jamais.
   *
   * Refuse au lieu d'enregistrer un numéro injoignable : voir le commentaire de
   * `normaliserTelephoneCI` pour les cas écartés et pourquoi.
   */
  private normalizePhone(raw: string): string {
    const normalise = normaliserTelephoneCI(raw);
    if (!normalise) {
      throw new BadRequestException(
        "Ce numéro n'est pas exploitable. Saisissez vos dix chiffres (ex. 07 07 00 00 00), ou ajoutez l'indicatif du pays pour un numéro étranger.",
      );
    }
    return normalise;
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
