import { Injectable, Logger } from '@nestjs/common';
import { Deliverer, EntityStatus, UserRole } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { EmailService } from 'src/modules/notifications/services/email.service';

/**
 * Notification email aux admins (ADMIN role) pour les évènements
 * "demandeurs d'attention humaine" côté livreurs :
 *  - inscription complétée → un nouveau livreur attend validation
 *  - (futur : auto-pause répétée, score critique, etc.)
 *
 * Strict fire-and-forget : un échec d'envoi NE BLOQUE PAS la mutation
 * principale. On log et on passe.
 */
@Injectable()
export class DelivererAdminNotificationService {
  private readonly logger = new Logger(DelivererAdminNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Récupère la liste des emails ADMIN actifs.
   * Skip silencieux si aucun (pas de fallback hard-coded — on ne veut pas
   * envoyer à un email inattendu).
   */
  private async getAdminEmails(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        role: UserRole.ADMIN,
        entity_status: EntityStatus.ACTIVE,
      },
      select: { email: true },
    });
    return admins
      .map((a) => a.email)
      .filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
  }

  /**
   * Notifie les admins qu'un nouveau livreur attend validation.
   *
   * Appelée à la fin de `completeRegistration` — fire-and-forget pour ne
   * pas ralentir la réponse au mobile.
   */
  async notifyNewDelivererPending(deliverer: Deliverer): Promise<void> {
    try {
      const adminEmails = await this.getAdminEmails();
      if (adminEmails.length === 0) {
        this.logger.warn(
          `[Admin notif] Aucun ADMIN actif trouvé — email skip pour livreur ${deliverer.reference}`,
        );
        return;
      }

      const fullName = [deliverer.first_name, deliverer.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Livreur sans nom';

      await this.email.sendMail({
        to: adminEmails,
        subject: `[Chicken Nation] Nouveau livreur à valider : ${fullName}`,
        html: this.buildPendingHtml({
          fullName,
          reference: deliverer.reference,
          phone: deliverer.phone,
          email: deliverer.email,
          vehicule: deliverer.type_vehicule ?? 'non précisé',
        }),
      });

      this.logger.log(
        `[Admin notif] Email envoyé à ${adminEmails.length} admin(s) pour livreur ${deliverer.reference}`,
      );
    } catch (err) {
      this.logger.warn(
        `[Admin notif] échec envoi pour livreur ${deliverer.reference}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Notifie les admins qu'un livreur a été suspendu pour refus répétés
   * (auto-pause queue P5 / scoring P6). Permet une revue humaine pour
   * décider si le livreur doit être réactivé manuellement ou rejeté.
   */
  async notifyDelivererAutoPaused(input: {
    deliverer: Deliverer;
    refusalCount: number;
    pauseDurationMinutes: number;
  }): Promise<void> {
    try {
      const adminEmails = await this.getAdminEmails();
      if (adminEmails.length === 0) return;

      const fullName = [input.deliverer.first_name, input.deliverer.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || input.deliverer.reference;

      await this.email.sendMail({
        to: adminEmails,
        subject: `[Chicken Nation] Livreur auto-suspendu : ${fullName}`,
        html: this.buildAutoPausedHtml({
          fullName,
          reference: input.deliverer.reference,
          phone: input.deliverer.phone,
          refusalCount: input.refusalCount,
          pauseDurationMinutes: input.pauseDurationMinutes,
        }),
      });

      this.logger.log(
        `[Admin notif] Auto-pause email envoyé pour ${input.deliverer.reference}`,
      );
    } catch (err) {
      this.logger.warn(
        `[Admin notif] échec auto-pause pour ${input.deliverer.reference}: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // TEMPLATES HTML
  // ============================================================

  private buildPendingHtml(data: {
    fullName: string;
    reference: string;
    phone: string;
    email: string | null;
    vehicule: string;
  }): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #F4721E; margin: 0 0 16px;">Nouveau livreur en attente</h2>
        <p style="color: #374151; line-height: 1.5;">
          Un livreur vient de finaliser son inscription et attend une validation administrateur.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Nom complet</td>
            <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(data.fullName)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Référence</td>
            <td style="padding: 8px 0; font-family: monospace;">${escapeHtml(data.reference)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Téléphone</td>
            <td style="padding: 8px 0;">${escapeHtml(data.phone)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Email</td>
            <td style="padding: 8px 0;">${escapeHtml(data.email ?? '—')}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Véhicule</td>
            <td style="padding: 8px 0;">${escapeHtml(data.vehicule)}</td>
          </tr>
        </table>
        <p style="color: #6B7280; font-size: 13px; margin-top: 24px;">
          Connecte-toi au backoffice pour vérifier les documents (pièce d'identité, permis) puis valider ou refuser le compte.
        </p>
      </div>
    `;
  }

  private buildAutoPausedHtml(data: {
    fullName: string;
    reference: string;
    phone: string;
    refusalCount: number;
    pauseDurationMinutes: number;
  }): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #EF4444; margin: 0 0 16px;">Livreur auto-suspendu</h2>
        <p style="color: #374151; line-height: 1.5;">
          Un livreur a été automatiquement mis en pause après plusieurs refus consécutifs.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Livreur</td>
            <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(data.fullName)} (${escapeHtml(data.reference)})</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Téléphone</td>
            <td style="padding: 8px 0;">${escapeHtml(data.phone)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Refus consécutifs</td>
            <td style="padding: 8px 0; font-weight: 600; color: #EF4444;">${data.refusalCount}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280;">Durée pause</td>
            <td style="padding: 8px 0;">${data.pauseDurationMinutes} min</td>
          </tr>
        </table>
        <p style="color: #6B7280; font-size: 13px; margin-top: 24px;">
          La pause se lèvera automatiquement à expiration. Connecte-toi au backoffice pour réactiver manuellement ou ouvrir un échange via le module Tickets.
        </p>
      </div>
    `;
  }
}

/** Échappement minimal HTML pour les valeurs interpolées dans les templates. */
function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
