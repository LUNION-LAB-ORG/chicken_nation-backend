import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmCampaignStatsService } from './crm-campaign-stats.service';
import { CrmExportService, FichierExport } from './crm-export.service';
import { LIBELLES_PUBLIC, VENTE_VALIDE_SQL, compter, identiteContact } from '../crm.rules';
import { nomClient } from './crm-contact.query';

type Stats = Awaited<ReturnType<CrmCampaignStatsService['statistiques']>>;
type LignePublic = Stats['par_public'][number];
type LigneComparatif = Awaited<ReturnType<CrmCampaignStatsService['comparer']>>[number];

const STATUTS_CAMPAGNE: Record<string, string> = {
  PLANIFIED: 'Planifiée',
  ACTIVE: 'En cours',
  SUSPENDED: 'Suspendue',
  COMPLETED: 'Terminée',
};

const STATUTS: Record<string, string> = {
  A_APPELER: 'À appeler',
  A_RAPPELER: 'À rappeler',
  INTERESSE: 'Intéressé',
  COUPON_ENVOYE: 'Coupon envoyé',
  NON_INTERESSE: 'Pas intéressé',
  INJOIGNABLE: 'Injoignable',
  CONVERTI: 'Converti',
};

/** « Converti » se dit selon le public : un inactif est reconquis, un Glovo/Yango commande en direct. */
const CONVERTI_PAR_PUBLIC: Record<string, string> = {
  JAMAIS_COMMANDE: 'Converti',
  INACTIF: 'Reconquis',
  GLOVO: 'A commandé en direct',
  YANGO: 'A commandé en direct',
};

const libelleStatut = (statut: string, segment?: string | null) =>
  statut === 'CONVERTI' && segment ? (CONVERTI_PAR_PUBLIC[segment] ?? STATUTS.CONVERTI) : (STATUTS[statut] ?? statut);

const nomPublic = (segment: string) => LIBELLES_PUBLIC[segment] ?? segment;

// Pas de tiret pour une valeur absente : le rapport se lit comme un texte écrit à la main.
const f = (n: number | null | undefined) => (n == null ? 'non renseigné' : new Intl.NumberFormat('fr-FR').format(Math.round(n)));
const p = (n: number) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n)} %`;
const JOURS_FR = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** Public dont le vocabulaire s'applique à toute la campagne : un seul public, ou seulement Glovo et Yango. */
const publicUnique = (segments: string[]): string | null => {
  const uniques = [...new Set(segments)];
  if (uniques.length === 1) return uniques[0];
  if (uniques.length > 0 && uniques.every((s) => s === 'GLOVO' || s === 'YANGO')) return 'GLOVO';
  return null;
};

const d = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10).split('-').reverse().join('/') : 'non fixée');

/** Résultats d'un public en une phrase, pour la synthèse et le PDF. */
function resumePublic(l: LignePublic): string {
  const morceaux = [
    compter(l.cibles, 'ciblé'),
    `${compter(l.traites, 'traité')} (${p(l.couverture)})`,
    `${compter(l.joints, 'joint')} (${p(l.taux_contact)})`,
    `${compter(l.coupons_envoyes, 'coupon envoyé', 'coupons envoyés')}, ${compter(l.coupons_utilises, 'utilisé')}`,
    `${compter(l.conversions, 'vente')} (${p(l.taux_conversion)}${l.objectif_taux_conversion != null ? `, objectif ${p(l.objectif_taux_conversion)}` : ''})`,
    `${f(l.ca_conversions)} F`,
  ];
  if (l.inscrits_appli_pendant != null) {
    morceaux.push(`${compter(l.inscrits_appli_pendant, "inscrit sur l'appli", "inscrits sur l'appli")} pendant la campagne`);
  }
  return morceaux.join(', ');
}

/** Rapport de fin de campagne (cahier §8), en Excel ou en PDF, ventilé par public au ciblage. */
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

  /**
   * Comparatif des campagnes en Excel, avec les filtres de l'écran : une
   * ligne par campagne, puis une ligne par campagne et par public.
   */
  async comparatif(user: User, lignes: LigneComparatif[], filtres: { segment?: string }): Promise<FichierExport> {
    const classeur = new ExcelJS.Workbook();
    const onglet = (nom: string, entetes: string[], contenu: (string | number)[][]) => {
      const o = classeur.addWorksheet(nom);
      o.addRow(entetes).font = { bold: true };
      contenu.forEach((l) => o.addRow(l));
      o.columns.forEach((c) => (c.width = 20));
      o.views = [{ state: 'frozen', ySplit: 1 }];
    };
    const colonnes = [
      'Ciblés',
      'Traités',
      'Couverture (%)',
      'Joints',
      'Taux de contact (%)',
      'Coupons envoyés',
      'Coupons utilisés',
      'Ventes',
      'Taux de conversion (%)',
      'Objectif de conversion (%)',
      'CA des ventes (F)',
      'Panier moyen (F)',
    ];
    const chiffres = (i: LigneComparatif['indicateurs']) => [
      i.cibles,
      i.traites,
      i.couverture,
      i.joints,
      i.taux_contact,
      i.coupons_envoyes,
      i.coupons_utilises,
      i.conversions,
      i.taux_conversion,
      i.objectif_taux_conversion ?? '',
      i.ca_conversions,
      i.panier_moyen,
    ];
    onglet(
      'Campagnes',
      ['Campagne', 'Statut', 'Lancée le', 'Close le', 'Publics', ...colonnes, 'Durée prévue (j)', 'Durée réelle (j)'],
      lignes.map((l) => [
        l.name,
        STATUTS_CAMPAGNE[l.status] ?? l.status,
        l.started_at ? d(l.started_at) : '',
        l.completed_at ? d(l.completed_at) : '',
        l.segments.map(nomPublic).join(', '),
        ...chiffres(l.indicateurs),
        l.duree.planifiee_jours ?? '',
        l.duree.reelle_jours,
      ]),
    );
    onglet(
      'Par public',
      ['Campagne', 'Public', ...colonnes, "Inscrits sur l'appli pendant la campagne"],
      lignes.flatMap((l) =>
        l.par_public
          .filter((x) => !filtres.segment || x.segment === filtres.segment)
          .map((x) => [l.name, nomPublic(x.segment), ...chiffres(x), x.inscrits_appli_pendant ?? '']),
      ),
    );
    await this.exports.journaliserExport(user, 'COMPARATIF_CAMPAGNES', 'XLSX', filtres, lignes.length);
    return {
      nom: `comparatif-campagnes${filtres.segment ? `-${filtres.segment.toLowerCase()}` : ''}.xlsx`,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contenu: Buffer.from(await classeur.xlsx.writeBuffer()),
    };
  }

  private synthese(s: Stats): [string, string][] {
    const i = s.indicateurs;
    const lignes: [string, string][] = [
      ['Campagne', s.campagne.name],
      ['Pilote', s.campagne.lead_agent?.fullname ?? 'compte supprimé'],
      ['Offre', s.campagne.offer?.label ?? 'offre par défaut'],
      ['Période prévue', s.duree.fin_prevue ? `du ${d(s.duree.debut_prevu)} au ${d(s.duree.fin_prevue)}` : `à partir du ${d(s.duree.debut_prevu)}, sans fin prévue`],
      ['Durée prévue / réelle', `${s.duree.planifiee_jours != null ? `${s.duree.planifiee_jours} j` : 'sans fin prévue'} / ${JOURS_FR.format(s.duree.reelle_jours)} j`],
      ['Publics visés', s.campagne.publics.map((x) => nomPublic(x.segment)).join(', ') || 'aucun'],
    ];
    for (const x of s.campagne.publics) {
      const offre = x.offer?.label ? ` ; offre : ${x.offer.label}` : '';
      const objectif = x.target_contacts_count != null ? ` ; objectif : ${compter(x.target_contacts_count, 'contact à joindre', 'contacts à joindre')}` : '';
      lignes.push([`Critères : ${nomPublic(x.segment)}`, `${x.criteres}${offre}${objectif}`]);
    }
    lignes.push(
      ['Contacts ciblés', f(i.cibles)],
      ['Traités (couverture)', `${f(i.traites)} (${p(i.couverture)})`],
      ['Joints (taux de contact)', `${f(i.joints)} (${p(i.taux_contact)})`],
      [
        'Objectif de contacts à joindre',
        i.objectif_contacts != null ? `${f(i.objectif_contacts)} (atteint à ${p(i.progression_objectif_contacts ?? 0)})` : 'non fixé',
      ],
      ['Restants', `${f(i.restants)}${s.chiffres_figes ? ' (à la clôture)' : ''}`],
      ['Coupons envoyés / utilisés', `${f(i.coupons_envoyes)} / ${f(i.coupons_utilises)} (${p(i.taux_utilisation)})`],
      ['Ventes (taux)', `${f(i.conversions)} (${p(i.taux_conversion)})`],
      ['Objectif de conversion', i.objectif_taux_conversion != null ? p(i.objectif_taux_conversion) : 'non fixé'],
      ['Chiffre d’affaires des ventes', `${f(i.ca_conversions)} F`],
      ['Chiffre d’affaires des coupons utilisés', `${f(i.ca_coupons)} F`],
      ['Panier moyen', `${f(i.panier_moyen)} F`],
    );
    if (s.ventes_sans_agent.conversions > 0) {
      lignes.push(['Ventes sans agent', `${f(s.ventes_sans_agent.conversions)} (${f(s.ventes_sans_agent.ca)} F)`]);
    }
    for (const l of s.par_public) lignes.push([`Résultats : ${nomPublic(l.segment)}`, resumePublic(l)]);
    return lignes;
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
    const criteres = new Map(s.campagne.publics.map((x) => [x.segment as string, x]));
    onglet(
      'Par public',
      [
        'Public',
        'Critères',
        'Offre',
        'Ciblés',
        'Traités',
        'Couverture (%)',
        'Joints',
        'Taux de contact (%)',
        'Objectif de contacts à joindre',
        'Restants',
        'Coupons envoyés',
        'Coupons utilisés',
        'Ventes',
        'Taux de conversion (%)',
        'Objectif de conversion (%)',
        'CA des ventes (F)',
        'Panier moyen (F)',
        "Inscrits sur l'appli pendant la campagne",
      ],
      s.par_public.map((l) => {
        const c = criteres.get(l.segment);
        return [
          nomPublic(l.segment),
          c?.criteres ?? '',
          c?.offer?.label ?? 'offre de la campagne',
          l.cibles,
          l.traites,
          l.couverture,
          l.joints,
          l.taux_contact,
          l.objectif_contacts ?? '',
          l.restants,
          l.coupons_envoyes,
          l.coupons_utilises,
          l.conversions,
          l.taux_conversion,
          l.objectif_taux_conversion ?? '',
          l.ca_conversions,
          l.panier_moyen,
          l.inscrits_appli_pendant ?? '',
        ];
      }),
    );
    onglet(
      'Statuts',
      ['Public', 'Statut', 'Contacts'],
      [
        // Un seul public visé (ou Glovo et Yango) : le statut « Converti » prend son vocabulaire.
        ...s.statuts.map((x) => ['Tous les publics', libelleStatut(x.statut, publicUnique(s.par_public.map((l) => l.segment))), x.nombre]),
        ...s.par_public.flatMap((l) => l.statuts.map((x) => [nomPublic(l.segment), libelleStatut(x.statut, l.segment), x.nombre])),
      ],
    );
    onglet(
      'Rythme quotidien',
      ['Jour', 'Nouveaux traités', 'Nouveaux joints', 'Appels', 'Ventes', 'Cumul joints', 'Objectif cumulé de joints'],
      s.rythme.serie.map((r) => [r.jour, r.traites, r.joints, r.appels, r.conversions, r.cumul, r.objectif_cumul ?? '']),
    );
    onglet(
      'Agents',
      ['Agent', 'Assignés', 'Appels', 'Traités', 'Joints', 'Coupons', 'Ventes', 'Taux de conversion (%)', 'CA (F)', 'Ventes par public'],
      s.agents.map((a) => [
        a.fullname,
        a.assignes,
        a.appels,
        a.traites,
        a.joints,
        a.coupons,
        a.conversions,
        a.taux_conversion,
        a.ca,
        a.par_public
          .filter((x) => x.conversions > 0)
          .map((x) => `${nomPublic(x.segment)} : ${x.conversions}`)
          .join(' ; '),
      ]),
    );
    onglet('Raisons', ['Raison de non-commande', 'Contacts', 'Part (%)'], s.raisons.map((r) => [r.raison, r.nombre, r.part]));

    const [membres, derniers, ventes] = await Promise.all([
      this.prisma.crmCampaignMember.findMany({
        where: { campaign_id: campagneId },
        orderBy: { joined_at: 'asc' },
        select: {
          contact_id: true,
          segment: true,
          agent: { select: { fullname: true } },
          contact: {
            select: {
              status: true,
              segment: true,
              name: true,
              phone: true,
              customer: { select: { first_name: true, last_name: true, phone: true } },
            },
          },
        },
      }),
      // Dernier appel de chaque contact PENDANT la campagne, et leur nombre.
      this.prisma.$queryRaw<{ contact_id: string; appels: number; status_label: string; raison: string | null }[]>`
        SELECT DISTINCT ON (k.contact_id) k.contact_id, count(*) OVER (PARTITION BY k.contact_id)::int AS appels,
               k.status_label, r.name AS raison
        FROM "CrmCall" k LEFT JOIN "ProspectLossReason" r ON r.id = k.loss_reason_id
        WHERE k.campaign_id = ${campagneId}::uuid
        ORDER BY k.contact_id, k.created_at DESC`,
      // Vente tirée du registre : elle reste acquise quand le client repart dans un nouveau passage.
      this.prisma.$queryRaw<{ contact_id: string; converted_at: Date; montant: number }[]>`
        SELECT v.contact_id, min(v.converted_at) AS converted_at, coalesce(sum(v.amount), 0)::float AS montant
        FROM "CrmConversion" v
        WHERE v.campaign_id = ${campagneId}::uuid AND v.source = 'CRM' AND ${Prisma.raw(VENTE_VALIDE_SQL)}
        GROUP BY v.contact_id`,
    ]);
    const appels = new Map(derniers.map((x) => [x.contact_id, x]));
    const venteDe = new Map(ventes.map((x) => [x.contact_id, x]));
    onglet(
      'Contacts',
      [
        'Nom',
        'Téléphone',
        'Public au ciblage',
        'Agent',
        "Statut aujourd'hui",
        'Appels pendant la campagne',
        'Dernier résultat pendant la campagne',
        'Raison',
        'Vente le',
        'Montant (F)',
      ],
      membres.map((m) => {
        const a = appels.get(m.contact_id);
        const v = venteDe.get(m.contact_id);
        return [
          nomClient(m.contact),
          identiteContact(m.contact).telephone,
          nomPublic(m.segment),
          m.agent?.fullname ?? '',
          libelleStatut(m.contact.status, m.contact.segment),
          a?.appels ?? 0,
          a?.status_label ?? '',
          a?.raison ?? '',
          v ? d(v.converted_at) : '',
          v ? Math.round(v.montant) : '',
        ];
      }),
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
      for (const [cle, valeur] of this.synthese(s).filter(([cle]) => !cle.startsWith('Résultats : '))) {
        doc.fillColor('#6B7280').text(`${cle} : `, { continued: true }).fillColor('#111827').text(valeur);
      }
      doc.moveDown();

      doc.fontSize(12).text('Par public', { underline: true }).moveDown(0.3).fontSize(10);
      if (s.par_public.length === 0) doc.text('Aucun public.');
      for (const l of s.par_public) {
        doc.fillColor('#6B7280').text(`${nomPublic(l.segment)} : `, { continued: true }).fillColor('#111827').text(resumePublic(l));
        const statuts = l.statuts.map((x) => `${libelleStatut(x.statut, l.segment)} ${x.nombre}`).join(', ');
        if (statuts) doc.fillColor('#6B7280').text(`Statuts${s.chiffres_figes ? ' à la clôture' : ''} : ${statuts}`).fillColor('#111827');
      }
      doc.moveDown();

      doc.fontSize(12).text('Performance par agent', { underline: true }).moveDown(0.3).fontSize(10);
      if (s.agents.length === 0) doc.text('Aucun agent.');
      for (const a of s.agents) {
        const parPublic = a.par_public
          .filter((x) => x.conversions > 0)
          .map((x) => `${nomPublic(x.segment)} ${x.conversions}`)
          .join(', ');
        doc.text(
          `${a.fullname} : ${compter(a.traites, 'traité')}, ${compter(a.joints, 'joint')}, ${compter(a.coupons, 'coupon')}, ${compter(a.conversions, 'vente')} (${p(a.taux_conversion)}), ${f(a.ca)} F${parPublic ? ` ; ventes par public : ${parPublic}` : ''}`,
        );
      }
      if (s.ventes_sans_agent.conversions > 0) {
        doc.text(`Sans agent : ${compter(s.ventes_sans_agent.conversions, 'vente')}, ${f(s.ventes_sans_agent.ca)} F`);
      }
      doc.moveDown();

      doc.fontSize(12).text('Raisons de non-commande', { underline: true }).moveDown(0.3).fontSize(10);
      if (s.raisons.length === 0) doc.text('Aucune raison saisie.');
      for (const r of s.raisons) doc.text(`${r.raison} : ${r.nombre} (${p(r.part)})`);
      doc.moveDown();

      doc.fontSize(12).text('Rythme', { underline: true }).moveDown(0.3).fontSize(10);
      const dernier = s.rythme.serie[s.rythme.serie.length - 1];
      doc.text(
        dernier
          ? `${compter(dernier.cumul, 'contact joint', 'contacts joints')} au ${d(dernier.jour)}${dernier.objectif_cumul != null ? `, pour un objectif cumulé de ${dernier.objectif_cumul}` : ''}.`
          : 'Aucun appel.',
      );
      doc.end();
    });
  }
}

