import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExportConversionProspectDto, QueryExportsDto } from '../dto/prospect.dto';
import { ConversionAccessService } from './conversion-access.service';
import { SELECT_LIGNE, filtreProspects, triProspects, versLigne } from './conversion-prospect.query';

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
export class ConversionExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
  ) {}

  async exporterProspects(user: User, q: ExportConversionProspectDto): Promise<FichierExport> {
    const where = filtreProspects(this.access.portee(user), q);
    const total = await this.prisma.conversionProspect.count({ where });
    if (total > PLAFOND_EXPORT) {
      throw new BadRequestException(
        `${total} lignes : affinez les filtres pour rester sous ${PLAFOND_EXPORT} lignes par export`,
      );
    }
    const lignes = (
      await this.prisma.conversionProspect.findMany({ where, select: SELECT_LIGNE, orderBy: triProspects(q.sort) })
    ).map(versLigne);

    const entetes = [
      'Nom', 'Téléphone', 'E-mail', 'Inscrit le', 'Statut', 'Agent', 'Campagne', 'Tentatives',
      'Dernier appel', "Statut d'appel", 'Raison de non-commande', 'Commentaire', 'Coupon', 'Offre',
      'Coupon envoyé le', 'Expire le', 'État du coupon', 'Converti le', 'Montant 1re commande',
      'Paiements abandonnés',
    ];
    const date = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '');
    const rangees = lignes.map((l) => [
      l.nom,
      l.customer.phone ?? '',
      l.customer.email ?? '',
      date(l.registered_at),
      LIBELLES_STATUT[l.status] ?? l.status,
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
      l.first_order_amount != null ? String(Math.round(l.first_order_amount)) : '',
      String(l.abandoned_orders),
    ]);

    const format = q.format === 'xlsx' ? 'xlsx' : 'csv';
    const horodatage = new Date().toISOString().slice(0, 10);
    const fichier: FichierExport =
      format === 'xlsx'
        ? {
            nom: `prospects-${horodatage}.xlsx`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            contenu: await this.versXlsx('Prospects', entetes, rangees),
          }
        : {
            nom: `prospects-${horodatage}.csv`,
            type: 'text/csv; charset=utf-8',
            contenu: this.versCsv(entetes, rangees),
          };

    const { page, limit, format: _f, ...filtres } = q;
    await this.prisma.conversionExport.create({
      data: {
        user_id: user.id,
        kind: 'PROSPECTS',
        format: format.toUpperCase(),
        filters: filtres as Prisma.InputJsonValue,
        row_count: rangees.length,
      },
    });
    return fichier;
  }

  async historique(q: QueryExportsDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const [data, total] = await Promise.all([
      this.prisma.conversionExport.findMany({
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
      this.prisma.conversionExport.count(),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async journaliserExport(user: User, kind: string, format: string, filtres: object, lignes: number) {
    await this.prisma.conversionExport.create({
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
