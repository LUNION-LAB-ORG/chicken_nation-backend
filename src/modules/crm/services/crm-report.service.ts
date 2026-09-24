import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmCampaignStatsService } from './crm-campaign-stats.service';
import { CrmExportService, FichierExport } from './crm-export.service';
import { LIBELLES_PUBLIC, compter, identiteContact } from '../crm.rules';
import { nomClient } from './crm-contact.query';

type Stats = Awaited<ReturnType<CrmCampaignStatsService['statistiques']>>;

const STATUTS: Record<string, string> = {
  A_APPELER: 'À appeler',
  A_RAPPELER: 'À rappeler',
  INTERESSE: 'Intéressé',
  COUPON_ENVOYE: 'Coupon envoyé',
  NON_INTERESSE: 'Pas intéressé',
  INJOIGNABLE: 'Injoignable',
  CONVERTI: 'Converti',
};

// Pas de tiret pour une valeur absente : le rapport se lit comme un texte écrit à la main.
const f = (n: number | null | undefined) => (n == null ? 'non renseigné' : new Intl.NumberFormat('fr-FR').format(Math.round(n)));
const d = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10).split('-').reverse().join('/') : 'non fixée');

/** Rapport de fin de campagne (cahier §8), en Excel ou en PDF. */
@Injectable()
export class CrmReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: CrmCampaignStatsService,
    private readonly exports: CrmExportService,
  ) {}

  async generer(user: User, campagneId: string, format: 'xlsx' | 'pdf'): Promise<FichierExport> {
    // Mêmes chiffres que le tableau de bord de la campagne, y compris après sa clôture.
    const s = await this.stats.statistiques(campagneId);
    const nom = `rapport-${s.campagne.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const fichier: FichierExport =
      format === 'pdf'
        ? { nom: `${nom}.pdf`, type: 'application/pdf', contenu: await this.pdf(s) }
        : {
            nom: `${nom}.xlsx`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            contenu: await this.xlsx(campagneId, s),
          };
    await this.exports.journaliserExport(user, 'RAPPORT_CAMPAGNE', format.toUpperCase(), { campaign_id: campagneId }, s.indicateurs.cibles);
    return fichier;
  }

  private synthese(s: Stats): [string, string][] {
    const i = s.indicateurs;
    return [
      ['Campagne', s.campagne.name],
      ['Pilote', s.campagne.lead_agent?.fullname ?? 'compte supprimé'],
      ['Offre', s.campagne.offer?.label ?? 'offre par défaut'],
      ['Période prévue', `${d(s.duree.debut_prevu)} au ${d(s.duree.fin_prevue)}`],
      ['Durée prévue / réelle', `${s.duree.planifiee_jours != null ? `${s.duree.planifiee_jours} j` : 'sans fin prévue'} / ${s.duree.reelle_jours} j`],
      ['Contacts ciblés', f(i.cibles)],
      ['Traités (couverture)', `${f(i.traites)} (${i.couverture} %)`],
      ['Joints (taux de contact)', `${f(i.joints)} (${i.taux_contact} %)`],
      ['Restants', f(i.restants)],
      ['Coupons envoyés / utilisés', `${f(i.coupons_envoyes)} / ${f(i.coupons_utilises)} (${i.taux_utilisation} %)`],
      ['Conversions (taux)', `${f(i.conversions)} (${i.taux_conversion} %)`],
      ['Objectif de conversion', i.objectif_taux_conversion != null ? `${i.objectif_taux_conversion} %` : 'non fixé'],
      ['Chiffre d’affaires des conversions', `${f(i.ca_conversions)} F`],
      ['Panier moyen', `${f(i.panier_moyen)} F`],
    ];
  }

  private async xlsx(campagneId: string, s: Stats): Promise<Buffer> {
    const classeur = new ExcelJS.Workbook();
    const onglet = (nom: string, entetes: string[], lignes: (string | number)[][]) => {
      const o = classeur.addWorksheet(nom);
      o.addRow(entetes).font = { bold: true };
      lignes.forEach((l) => o.addRow(l));
      o.columns.forEach((c) => (c.width = 22));
      o.views = [{ state: 'frozen', ySplit: 1 }];
    };
    onglet('Synthèse', ['Indicateur', 'Valeur'], this.synthese(s));
    onglet(
      'Rythme quotidien',
      ['Jour', 'Nouveaux traités', 'Appels', 'Conversions', 'Cumul traités', 'Objectif cumulé'],
      s.rythme.serie.map((r) => [r.jour, r.traites, r.appels, r.conversions, r.cumul, r.objectif_cumul ?? '']),
    );
    onglet(
      'Agents',
      ['Agent', 'Assignés', 'Appels', 'Traités', 'Joints', 'Coupons', 'Conversions', 'Taux de conversion (%)', 'CA (F)'],
      s.agents.map((a) => [a.fullname, a.assignes, a.appels, a.traites, a.joints, a.coupons, a.conversions, a.taux_conversion, a.ca]),
    );
    onglet('Raisons', ['Raison de non-commande', 'Contacts', 'Part (%)'], s.raisons.map((r) => [r.raison, r.nombre, r.part]));

    const membres = await this.prisma.crmCampaignMember.findMany({
      where: { campaign_id: campagneId },
      orderBy: { joined_at: 'asc' },
      select: {
        converted_at: true,
        release_reason: true,
        agent: { select: { fullname: true } },
        contact: {
          select: {
            status: true,
            segment: true,
            call_count: true,
            conversion_amount: true,
            last_call_status: { select: { label: true } },
            loss_reason: { select: { name: true } },
            name: true,
            phone: true,
            customer: { select: { first_name: true, last_name: true, phone: true } },
          },
        },
      },
    });
    onglet(
      'Contacts',
      ['Nom', 'Téléphone', 'Public', 'Agent', 'Statut', 'Tentatives', "Dernier statut d'appel", 'Raison', 'Converti ou reconquis le', 'Montant (F)'],
      membres.map((m) => [
        nomClient(m.contact),
        identiteContact(m.contact).telephone,
        LIBELLES_PUBLIC[m.contact.segment] ?? m.contact.segment,
        m.agent?.fullname ?? '',
        STATUTS[m.contact.status] ?? m.contact.status,
        m.contact.call_count,
        m.contact.last_call_status?.label ?? '',
        m.contact.loss_reason?.name ?? '',
        m.converted_at ? d(m.converted_at) : '',
        m.converted_at ? Math.round(m.contact.conversion_amount ?? 0) : '',
      ]),
    );
    return Buffer.from(await classeur.xlsx.writeBuffer());
  }

  private pdf(s: Stats): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const morceaux: Buffer[] = [];
      doc.on('data', (m: Buffer) => morceaux.push(m));
      doc.on('end', () => resolve(Buffer.concat(morceaux)));
      doc.on('error', reject);

      doc.fillColor('#F17922').fontSize(20).text('Chicken Nation', { continued: false });
      doc.fillColor('#111827').fontSize(16).text(`Rapport de campagne : ${s.campagne.name}`);
      doc.fillColor('#6B7280').fontSize(9).text(`Édité le ${d(new Date())}`).moveDown();

      doc.fillColor('#111827').fontSize(12).text('Synthèse', { underline: true }).moveDown(0.3);
      doc.fontSize(10);
      for (const [cle, valeur] of this.synthese(s)) {
        doc.fillColor('#6B7280').text(`${cle} : `, { continued: true }).fillColor('#111827').text(valeur);
      }
      doc.moveDown();

      doc.fontSize(12).text('Performance par agent', { underline: true }).moveDown(0.3).fontSize(10);
      if (s.agents.length === 0) doc.text('Aucun agent.');
      for (const a of s.agents) {
        doc.text(
          `${a.fullname} : ${compter(a.traites, 'traité')}, ${compter(a.joints, 'joint')}, ${compter(a.coupons, 'coupon')}, ${compter(a.conversions, 'conversion')} (${a.taux_conversion} %), ${f(a.ca)} F`,
        );
      }
      doc.moveDown();

      doc.fontSize(12).text('Raisons de non-commande', { underline: true }).moveDown(0.3).fontSize(10);
      if (s.raisons.length === 0) doc.text('Aucune raison saisie.');
      for (const r of s.raisons) doc.text(`${r.raison} : ${r.nombre} (${r.part} %)`);
      doc.moveDown();

      doc.fontSize(12).text('Rythme', { underline: true }).moveDown(0.3).fontSize(10);
      const dernier = s.rythme.serie[s.rythme.serie.length - 1];
      doc.text(
        dernier
          ? `${compter(dernier.cumul, 'contact traité', 'contacts traités')} au ${d(dernier.jour)}${dernier.objectif_cumul != null ? `, pour un objectif cumulé de ${dernier.objectif_cumul}` : ''}.`
          : 'Aucun appel.',
      );
      doc.end();
    });
  }
}
