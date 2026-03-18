import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { startOfDay, endOfDay, subDays, format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { MarketingReportService } from '../services/marketing-report.service';
import { EmailService } from 'src/modules/notifications/services/email.service';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class MarketingReportTask {
  private readonly logger = new Logger(MarketingReportTask.name);

  constructor(
    private readonly reportService: MarketingReportService,
    private readonly emailService: EmailService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Tous les jours à 10h30 — envoie le rapport marketing des données J-1
   */
  @Cron('30 10 * * *')
  async sendDailyMarketingReport() {
    this.logger.log('Début de l\'envoi du rapport marketing quotidien...');

    try {
      // Vérifier si l'envoi est actif
      const isActive = await this.settingsService.get('marketing_report_active');
      if (isActive === 'false') {
        this.logger.log('Envoi du rapport marketing désactivé. Skip.');
        return;
      }

      // Récupérer les emails destinataires
      const emails = await this.settingsService.getJson<string[]>('marketing_report_emails');
      if (!emails || emails.length === 0) {
        this.logger.warn('Aucun email destinataire configuré pour le rapport marketing. Skip.');
        return;
      }

      // Dates J-1
      const yesterday = subDays(new Date(), 1);
      const startDate = startOfDay(yesterday);
      const endDate = endOfDay(yesterday);

      const dateStr = format(yesterday, 'dd/MM/yyyy', { locale: fr });
      const dateIso = format(startDate, 'yyyy-MM-dd');

      this.logger.log(`Génération du rapport pour le ${dateStr}...`);

      // Générer le PDF
      const { buffer, filename } = await this.reportService.generatePdf({
        startDate: dateIso,
        endDate: dateIso,
      });

      // Envoyer par email
      await this.emailService.sendMail({
        to: emails,
        subject: `📊 Rapport Marketing Chicken Nation — ${dateStr}`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #F17922, #e06816); padding: 24px; border-radius: 12px 12px 0 0;">
              <h1 style="color: #fff; margin: 0; font-size: 20px;">Rapport Marketing Quotidien</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 14px;">${dateStr}</p>
            </div>
            <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e9ecef; border-top: none;">
              <p style="color: #495057; font-size: 14px; line-height: 1.6;">
                Bonjour,<br><br>
                Veuillez trouver ci-joint le rapport marketing de la journée du <strong>${dateStr}</strong>.<br>
                Ce rapport contient les données de commandes, les plats les plus vendus, la répartition par restaurant, source et type, ainsi que les avis clients.
              </p>
              <p style="color: #6c757d; font-size: 12px; margin-top: 20px;">
                — Chicken Nation, rapport automatique
              </p>
            </div>
          </div>
        `,
        attachments: [
          {
            filename,
            content: buffer,
            contentType: 'application/pdf',
          },
        ],
      });

      this.logger.log(`Rapport marketing envoyé avec succès à ${emails.length} destinataire(s): ${emails.join(', ')}`);
    } catch (error) {
      this.logger.error(`Erreur lors de l'envoi du rapport marketing: ${error.message}`, error.stack);
    }
  }
}
