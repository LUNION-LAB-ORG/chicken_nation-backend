import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { OrderService } from './order.service';

@Injectable()
export class ReceiptsService {
  constructor(private readonly orderService: OrderService) { }

  async generateReceiptPdf(orderId: string, res: Response): Promise<void> {
    const orderData = await this.orderService.findById(orderId);

    const doc = new PDFDocument({ size: [200, 300], margins: { top: 10, bottom: 10, left: 10, right: 10 } });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=recu-${orderData.reference}.pdf`);

    doc.pipe(res);

    // -- Votre logique de création de reçu PDF --
    const drawLine = (document: any, y: number) => {
      document.strokeColor('#000000')
        .lineWidth(1)
        .moveTo(document.page.margins.left, y)
        .lineTo(document.page.width - document.page.margins.right, y)
        .stroke();
    };

    const formatCurrency = (amount: number) => `${amount.toFixed(2)} €`;

    doc.fontSize(14).font('Helvetica-Bold').text(orderData.restaurant.name.toUpperCase(), { align: 'center' });
    doc.fontSize(8).font('Helvetica').text(orderData.restaurant.address, { align: 'center' });
    doc.text(`Tél: ${orderData.restaurant.phone}`, { align: 'center' });
    doc.text(`Email: ${orderData.restaurant.email}`, { align: 'center' });
    doc.moveDown(1);
    drawLine(doc, doc.y);
    doc.moveDown(1);

    doc.fontSize(10).font('Helvetica-Bold').text('REÇU DE COMMANDE', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica');
    doc.text(`N° Commande: ${orderData.reference}`);
    doc.text(`Date: ${new Date(orderData.date!).toLocaleDateString()}`);
    doc.text(`Client: ${orderData.fullname}`);
    doc.text(`Tél Client: ${orderData.phone}`);
    doc.moveDown(1);
    drawLine(doc, doc.y);
    doc.moveDown(1);

    // Détails des articles
    doc.fontSize(8).font('Helvetica-Bold').text('Description', 10, doc.y, { width: 120 });
    doc.text('Prix', 140, doc.y, { width: 50, align: 'right' });
    doc.moveDown(1);

    orderData.order_items.forEach(item => {
      const itemPrice = item.dish.is_promotion ? item.dish.promotion_price : item.dish.price;
      const totalItemPrice = item.quantity * itemPrice!;
      doc.fontSize(8).font('Helvetica').text(`${item.quantity} x ${item.dish.name}`, { continued: true });
      doc.text(formatCurrency(totalItemPrice), { align: 'right' });
      doc.moveDown(0.5);
    });

    doc.moveDown(1);
    drawLine(doc, doc.y);
    doc.moveDown(1);

    // Totaux
    doc.fontSize(10).font('Helvetica-Bold').text('Sous-Total:', { continued: true });
    doc.text(formatCurrency(orderData.net_amount!), { align: 'right' });

    doc.text('Taxe:', { continued: true });
    doc.text(formatCurrency(orderData.tax!), { align: 'right' });

    if (orderData.discount > 0) {
      doc.text('Réduction:', { continued: true });
      doc.text(`- ${formatCurrency(orderData.discount!)}`, { align: 'right' });
    }

    if (orderData.delivery_fee > 0) {
      doc.text('Frais de livraison:', { continued: true });
      doc.text(formatCurrency(orderData.delivery_fee!), { align: 'right' });
    }

    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').text('TOTAL:', { continued: true });
    doc.text(formatCurrency(orderData.amount!), { align: 'right' });

    doc.moveDown(1);
    drawLine(doc, doc.y);
    doc.moveDown(1);

    doc.fontSize(8).font('Helvetica-Bold').text('Moyen de Paiement:', { continued: true });
    doc.font('Helvetica').text(orderData.paiements[0].mode, { align: 'right' });
    doc.text(`Référence Paiement: ${orderData.paiements[0].reference}`, { align: 'center' });

    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').text('MERCI DE VOTRE VISITE', { align: 'center' });

    doc.end();
  }
}