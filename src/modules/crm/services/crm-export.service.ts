import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityStatus, Prisma, User } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExportAnalyticsQueryDto } from '../dto/analytics.dto';
import { ExportCrmContactDto, QueryExportsDto } from '../dto/contact.dto';
import { CrmAccessService } from './crm-access.service';
import { LIBELLES_PUBLIC, LIBELLES_LIGNE_PUBLIC, compter, dateCourte } from '../crm.rules';
import { SELECT_LIGNE, filtreContacts, triContacts, versLigne } from './crm-contact.query';
import { LignePublic, CrmPublicsService } from './crm-publics.service';

/** Au-delà, l'export sort de la requête HTTP : on préfère refuser que tronquer en silence. */
const PLAFOND_EXPORT = 20_000;

const LIBELLES_STATUT: Record<string, string> = {
  A_APPELER: 'À appeler',
  A_RAPPELER: 'À rappeler',
  INTERESSE: 'Intéressé',
  COUPON_ENVOYE: 'Coupon envoyé',
  NON_INTERESSE: 'Pas intéressé',
  INJOIGNABLE: 'Injoignable',
  CONVERTI: 'Converti',
};

const LIBELLES_COUPON: Record<string, string> = {
  ACTIF: 'Envoyé, non utilisé',
  UTILISE: 'Utilisé',
  EXPIRE: 'Expiré',
};

export interface FichierExport {
  nom: string;
  type: string;
  contenu: Buffer;
}

@Injectable()
export class CrmExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly publics: CrmPublicsService,
  ) {}

  async exporterContacts(user: User, q: ExportCrmContactDto): Promise<FichierExport> {
    const where = filtreContacts(this.access.portee(user), q);
    const total = await this.prisma.crmContact.count({ where });
    if (total > PLAFOND_EXPORT) {
      throw new BadRequestException(
        `${total} lignes : affinez les filtres pour rester sous ${PLAFOND_EXPORT} lignes par export`,
      );
    }
    const lignes = (
      await this.prisma.crmContact.findMany({
        where,
        select: {
          ...SELECT_LIGNE,
          captures: {
            where: { entity_status: { not: EntityStatus.DELETED } },
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { platform: true, order_number: true, created_at: true, restaurant: { select: { name: true } } },
          },
        },
        orderBy: triContacts(q.sort),
      })
    ).map((l) => ({ ...versLigne(l), capture: l.captures[0] ?? null }));

    const entetes = [
      'Nom', 'Téléphone', 'E-mail', 'Public', 'Inscrit le', 'Dernière commande', 'Capté sur', 'Capté le', 'Restaurant de capture',
      'N° de commande capturée', 'Statut', 'Agent', 'Campagne', 'Tentatives',
      'Dernier appel', "Statut d'appel", 'Raison de non-commande', 'Commentaire', 'Coupon', 'Offre',
      'Coupon envoyé le', 'Expire le', 'État du coupon', 'Converti ou reconquis le', 'Montant de cette commande',
      'Paiements abandonnés',
    ];
    const date = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '');
    const rangees = lignes.map((l) => [
      l.nom,
      l.telephone,
      l.customer?.email ?? '',
      LIBELLES_PUBLIC[l.segment] ?? l.segment,
      date(l.registered_at),
      date(l.last_order_at),
      l.capture ? (l.capture.platform === 'YANGO' ? 'Yango' : 'Glovo') : '',
      date(l.capture?.created_at),
      l.capture?.restaurant?.name ?? '',
      l.capture?.order_number ?? '',
      l.status === 'CONVERTI' && l.segment === 'INACTIF' ? 'Reconquis' : (LIBELLES_STATUT[l.status] ?? l.status),
      l.assigned_to?.fullname ?? '',
      l.campaign?.name ?? '',
      String(l.call_count),
      date(l.last_call_at),
      l.last_call_status?.label ?? '',
      l.loss_reason?.name ?? '',
      l.last_comment ?? '',
      l.coupon?.code ?? '',
      l.coupon?.offer_label ?? '',
      date(l.coupon?.sent_at),
      date(l.coupon?.expires_at),
      l.coupon ? LIBELLES_COUPON[l.coupon.etat] : '',
      date(l.converted_at),
      l.conversion_amount != null ? String(Math.round(l.conversion_amount)) : '',
      String(l.abandoned_orders),
    ]);

    const format = q.format === 'xlsx' ? 'xlsx' : 'csv';
    const horodatage = new Date().toISOString().slice(0, 10);
    const fichier: FichierExport =
      format === 'xlsx'
        ? {
            nom: `contacts-${horodatage}.xlsx`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            contenu: await this.versXlsx('Contacts', entetes, rangees),
          }
        : {
            nom: `contacts-${horodatage}.csv`,
            type: 'text/csv; charset=utf-8',
            contenu: this.versCsv(entetes, rangees),
          };

    const { page, limit, format: _f, ...filtres } = q;
    await this.prisma.crmExport.create({
      data: {
        user_id: user.id,
        kind: 'CONTACTS',
        format: format.toUpperCase(),
        filters: filtres as Prisma.InputJsonValue,
        row_count: rangees.length,
      },
    });
    return fichier;
  }

  /**
   * Vue comparée des publics en Excel (tableau de bord), avec les filtres de
   * l'écran : une ligne par public, Glovo + Yango réunis, le total. Une
   * valeur sans objet ou non disponible reste vide.
   */
  async exporterPublics(user: User, q: ExportAnalyticsQueryDto): Promise<FichierExport> {
    const vue = await this.publics.comparer(q);
    const campagne = q.campaign_id
      ? await this.prisma.crmCampaign.findUnique({ where: { id: q.campaign_id }, select: { name: true } })
      : null;
    const fenetre = compter(vue.fenetre_jours, 'jour');
    type Colonne = [groupe: string, titre: string, valeur: (l: LignePublic) => number | null];
    const colonnes: Colonne[] = [
      ['Entrés sur la période', 'Entrés', (l) => l.devenir.entrees],
      ['Entrés sur la période', 'Contactés', (l) => l.devenir.contactes],
      ['Entrés sur la période', 'Joints', (l) => l.devenir.joints],
      ['Entrés sur la période', 'Intéressés', (l) => l.devenir.interesses],
      ['Entrés sur la période', 'Coupon envoyé', (l) => l.devenir.coupons],
      ['Entrés sur la période', 'Commandes au bout de l’entonnoir', (l) => l.devenir.commandes],
      ['Entrés sur la période', 'Ventes', (l) => l.devenir.ventes],
      ['Entrés sur la période', 'Dont hors entonnoir', (l) => l.devenir.hors_entonnoir],
      ['Entrés sur la période', 'Dont sans contact préalable', (l) => l.devenir.sans_contact],
      ['Entrés sur la période', 'Ventes antérieures à l’entrée (reprise)', (l) => l.devenir.repris],
      ['Entrés sur la période', 'Chiffre d’affaires des ventes (F)', (l) => l.devenir.ca],
      ['Entrés sur la période', 'Taux de contact (%)', (l) => (l.devenir.entrees > 0 ? l.devenir.taux_contact : null)],
      ['Entrés sur la période', 'Taux de conversion (%)', (l) => (l.devenir.base_taux > 0 ? l.devenir.taux_conversion : null)],
      ['Entrés sur la période', `Taux de conversion à ${fenetre} (%)`, (l) => (l.devenir.mesurables_30j > 0 ? l.devenir.taux_30j : null)],
      ['Entrés sur la période', 'Délai médian de conversion (jours)', (l) => l.devenir.delai_median_j],
      ['Entrés sur la période', 'Délai moyen de conversion (jours)', (l) => l.devenir.delai_moyen_j],
      ['Entrés sur la période', 'Délai médian du premier appel (heures)', (l) => l.devenir.premier_appel_median_h],
      ['Entrés sur la période', 'Appelés au plus tard le lendemain (%)', (l) => (l.devenir.mesurables_j1 > 0 ? l.devenir.part_j1 : null)],
      ['Entrés sur la période', 'Appelés au plus tard le surlendemain (%)', (l) => (l.devenir.mesurables_j2 > 0 ? l.devenir.part_j2 : null)],
      ['Entrés sur la période', 'Déjà clients de l’appli', (l) => l.devenir.deja_clients],
      ['Entrés sur la période', 'Déjà inscrits à la capture', (l) => l.devenir.deja_inscrits_a_la_capture],
      ['Entrés sur la période', 'Inscrits après la capture', (l) => l.devenir.inscrits_apres_capture],
      ['Entrés sur la période', 'Sans compte sur l’appli', (l) => l.devenir.sans_compte],
      ['Activité de la période', 'Appels', (l) => l.activite.appels],
      ['Activité de la période', 'Contacts appelés', (l) => l.activite.contacts_appeles],
      ['Activité de la période', 'Coupons envoyés', (l) => l.activite.coupons_envoyes],
      ['Activité de la période', 'Coupons utilisés', (l) => l.activite.coupons_utilises],
      ['Activité de la période', 'Ventes du CRM', (l) => l.activite.ventes_crm],
      ['Activité de la période', 'Chiffre d’affaires du CRM (F)', (l) => l.activite.ca_crm],
      ['Activité de la période', 'Panier moyen (F)', (l) => (l.activite.ventes_crm > 0 ? l.activite.panier_moyen : null)],
      ['Activité de la période', 'Remise totale des commandes payées par coupon (F)', (l) => l.activite.remises_coupons],
      ['Activité de la période', 'Ventes de l’ancienne acquisition', (l) => l.activite.ventes_historiques],
      ['Activité de la période', 'Chiffre d’affaires de l’ancienne acquisition (F)', (l) => l.activite.ca_historique],
      ['Aujourd’hui', 'Contacts à travailler', (l) => l.aujourdhui.ouverts],
      ['Aujourd’hui', 'Jamais appelés', (l) => l.aujourdhui.jamais_appeles],
      ['Aujourd’hui', 'À rappeler', (l) => l.aujourdhui.a_rappeler],
      ['Aujourd’hui', 'File commune Glovo/Yango', (l) => l.aujourdhui.file_commune],
      ['Aujourd’hui', 'Sans agent, hors campagne et hors file commune', (l) => l.aujourdhui.sans_agent_hors_file],
      ['Aujourd’hui', 'En campagne', (l) => l.aujourdhui.en_campagne],
      ['Seconde commande', 'Ventes de la période', (l) => l.seconde_commande.ventes],
      ['Seconde commande', 'Ventes mesurables', (l) => l.seconde_commande.mesurables],
      ['Seconde commande', `Nouvelle commande sous ${fenetre}`, (l) => l.seconde_commande.recommande_30j],
      ['Seconde commande', 'Taux (%)', (l) => (l.seconde_commande.mesurables > 0 ? l.seconde_commande.taux_30j : null)],
      ['Seconde commande', 'Trop récentes pour conclure', (l) => l.seconde_commande.en_attente],
      ['Seconde commande', 'Non mesurables (sans compte)', (l) => l.seconde_commande.non_mesurables],
      ['Seconde commande', 'Délai médian jusqu’à la commande suivante (jours)', (l) => l.seconde_commande.delai_median_j],
    ];
    const lignes = [...vue.lignes, ...(vue.glovo_yango ? [vue.glovo_yango] : []), vue.total];

    const classeur = new ExcelJS.Workbook();
    const onglet = classeur.addWorksheet('Vue comparée');
    onglet.addRow(['', ...colonnes.map(([groupe]) => groupe)]);
    onglet.addRow(['Public', ...colonnes.map(([, titre]) => titre)]);
    // Groupes de colonnes fusionnés sur la première ligne.
    let debut = 0;
    for (let i = 1; i <= colonnes.length; i++) {
      if (i === colonnes.length || colonnes[i][0] !== colonnes[debut][0]) {
        if (i - debut > 1) onglet.mergeCells(1, debut + 2, 1, i + 1);
        debut = i;
      }
    }
    lignes.forEach((l) => onglet.addRow([l.libelle, ...colonnes.map(([, , valeur]) => valeur(l) ?? null)]));
    onglet.getRow(1).font = { bold: true };
    onglet.getRow(2).font = { bold: true };
    onglet.getRow(onglet.rowCount).font = { bold: true };
    onglet.getColumn(1).width = 26;
    for (let i = 2; i <= colonnes.length + 1; i++) onglet.getColumn(i).width = 16;
    onglet.getRow(2).alignment = { wrapText: true, vertical: 'top' };
    onglet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

    const filtres = classeur.addWorksheet('Filtres et définitions');
    const jourDe = (v: string) => dateCourte(new Date(`${v}T00:00:00.000Z`));
    const { from, to } = vue.periode;
    const periode =
      from && to
        ? `du ${jourDe(from)} au ${jourDe(to)}`
        : from
          ? `du ${jourDe(from)} jusqu'à aujourd'hui`
          : to
            ? `jusqu'au ${jourDe(to)}`
            : 'Depuis le début';
    [
      ['Période', periode],
      ['Publics', vue.publics.map((p) => LIBELLES_LIGNE_PUBLIC[p] ?? p).join(', ')],
      ['Campagne', campagne?.name ?? 'Toutes'],
      ["Délai d'inactivité", fenetre],
      ['Exporté le', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)'],
      [],
      ['Entrés sur la période', "Passages entrés dans le CRM pendant la période (entrée = la plus tardive de l'entrée dans le public et de l'ouverture du CRM), et ce qui leur est arrivé depuis. Étapes emboîtées : chacune exige la précédente, dans le même passage."],
      ['Ventes', 'Ventes du CRM (commandes ni annulées ni supprimées) faites après l’entrée, dans ce passage. « Hors entonnoir » : sans coupon envoyé à un contact joint ; « sans contact » : ni appel joint ni coupon avant la commande.'],
      ['Taux de conversion', 'Ventes sur entrés, hors clients Glovo/Yango déjà clients de l’appli (comptés à part).'],
      [`Taux à ${fenetre}`, `Ventes dans les ${fenetre} qui suivent l’entrée, sur les entrés depuis au moins ${fenetre}.`],
      ['Activité de la période', 'Appels, coupons et ventes datés dans la période, rangés sous le public du passage où ils ont eu lieu.'],
      ['Aujourd’hui', 'État actuel des fiches, sans période.'],
      ['Seconde commande', `Ventes du CRM de la période suivies d’une autre commande du même compte sous ${fenetre}. Mesurables : ventes d’un client qui a un compte, faites il y a au moins ${fenetre}.`],
      ['Glovo + Yango', 'Calculé sur l’ensemble des deux publics (les médianes ne sont pas des sommes).'],
    ].forEach((r) => filtres.addRow(r));
    filtres.getColumn(1).width = 28;
    filtres.getColumn(2).width = 110;
    filtres.getColumn(1).font = { bold: true };

    await this.journaliserExport(
      user,
      'TABLEAU_PUBLICS',
      'XLSX',
      { vue: q.vue, from: q.from ?? null, to: q.to ?? null, campaign_id: q.campaign_id ?? null, segments: vue.publics },
      lignes.length,
    );
    return {
      nom: `crm-publics-${new Date().toISOString().slice(0, 10)}.xlsx`,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contenu: Buffer.from(await classeur.xlsx.writeBuffer()),
    };
  }

  async historique(q: QueryExportsDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const [data, total] = await Promise.all([
      this.prisma.crmExport.findMany({
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          kind: true,
          format: true,
          filters: true,
          row_count: true,
          created_at: true,
          user: { select: { id: true, fullname: true } },
        },
      }),
      this.prisma.crmExport.count(),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async journaliserExport(user: User, kind: string, format: string, filtres: object, lignes: number) {
    await this.prisma.crmExport.create({
      data: {
        user_id: user.id,
        kind,
        format,
        filters: filtres as Prisma.InputJsonValue,
        row_count: lignes,
      },
    });
  }

  async versXlsx(feuille: string, entetes: string[], rangees: string[][]): Promise<Buffer> {
    const classeur = new ExcelJS.Workbook();
    const onglet = classeur.addWorksheet(feuille);
    onglet.addRow(entetes);
    onglet.getRow(1).font = { bold: true };
    rangees.forEach((r) => onglet.addRow(r));
    onglet.columns.forEach((colonne) => {
      colonne.width = 18;
    });
    onglet.views = [{ state: 'frozen', ySplit: 1 }];
    return Buffer.from(await classeur.xlsx.writeBuffer());
  }

  /** Point-virgule et BOM : Excel en français ouvre le fichier sans assistant. */
  versCsv(entetes: string[], rangees: string[][]): Buffer {
    const cellule = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const texte = [entetes, ...rangees].map((r) => r.map((c) => cellule(c ?? '')).join(';')).join('\r\n');
    return Buffer.from(`﻿${texte}`, 'utf8');
  }
}
