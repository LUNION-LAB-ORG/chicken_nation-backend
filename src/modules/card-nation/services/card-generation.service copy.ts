import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, loadImage } from 'canvas';
import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CardGenerationService {
  private readonly logger = new Logger(CardGenerationService.name);
  private readonly CARD_WIDTH = 1014; // 85.6mm at 300 DPI
  private readonly CARD_HEIGHT = 638; // 53.98mm at 300 DPI

  constructor(private readonly s3service: S3Service
  ) {
  }


  /**
   * Génère un numéro de carte unique
   * Format: CN-YYYYMMDD-XXXX
   */
  generateCardNumber(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

    return `CN-${year}${month}${day}-${random}`;
  }

  /**
   * Génère une valeur QR code unique
   */
  generateQRValue(cardNumber: string, customerId: string): string {
    return `${cardNumber}-${customerId}`;
  }

  /**
   * Génère l'image de la carte Nation
   */
  async generateCardImage(
    customerFirstName: string,
    customerLastName: string,
    cardNumber: string,
    qrCodeValue: string,
    nickname?: string,
  ): Promise<string> {
    try {
      const canvas = createCanvas(this.CARD_WIDTH, this.CARD_HEIGHT);
      const ctx = canvas.getContext('2d');
      // const fondUrl = this.s3service.getCdnFileUrl('chicken-nation/assets/images/carte_nation/carte_nation_fond.png');
      // const fondImage = await loadImage(fondUrl);
      // Fond de la carte (dégradé ou couleur unie)
      const gradient = ctx.createLinearGradient(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);
      gradient.addColorStop(0, '#1e3a8a'); // Bleu foncé
      gradient.addColorStop(1, '#3b82f6'); // Bleu clair
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);

      // Bordure arrondie
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      this.roundRect(ctx, 20, 20, this.CARD_WIDTH - 40, this.CARD_HEIGHT - 40, 20);
      ctx.stroke();

      try {
        const logoUrl = this.s3service.getCdnFileUrl('chicken-nation/assets/images/logos/logo_fond_blanc.png');
        const logoImage = await loadImage(logoUrl);
        ctx.drawImage(logoImage, 50, 40, 150, 60);
      } catch (error) {
        // Si le logo n'existe pas, afficher le texte
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px Arial';
        ctx.fillText('CHICKEN NATION', 50, 80);
      }

      // Titre "CARTE NATION"
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 42px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('CARTE NATION', this.CARD_WIDTH / 2, 150);

      // Ligne décorative
      ctx.strokeStyle = '#fbbf24'; // Jaune/or
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.CARD_WIDTH / 2 - 200, 170);
      ctx.lineTo(this.CARD_WIDTH / 2 + 200, 170);
      ctx.stroke();

      // Nom du titulaire
      ctx.font = 'bold 32px Arial';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';

      const displayName = nickname || `${customerFirstName} ${customerLastName}`;
      ctx.fillText(displayName.toUpperCase(), 80, 260);

      // Label "Étudiant"
      ctx.font = '24px Arial';
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('ÉTUDIANT', 80, 300);

      // Numéro de carte
      ctx.font = 'bold 22px monospace';
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(`N° ${cardNumber}`, 80, 350);

      // QR Code
      const qrCodeDataUrl = await QRCode.toDataURL(qrCodeValue, {
        width: 150,
        margin: 1,
        color: {
          dark: '#1e3a8a',
          light: '#ffffff',
        },
      });
      const qrImage = await loadImage(qrCodeDataUrl);

      // QR Code dans le coin inférieur droit
      const qrX = this.CARD_WIDTH - 200;
      const qrY = this.CARD_HEIGHT - 200;

      // Fond blanc pour le QR
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(qrX - 10, qrY - 10, 170, 170);
      ctx.drawImage(qrImage, qrX, qrY, 150, 150);

      // Label sous le QR
      ctx.fillStyle = '#e5e7eb';
      ctx.font = '14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Scannez-moi', qrX + 75, qrY + 180);

      // Texte légal en bas
      ctx.font = '12px Arial';
      ctx.fillStyle = '#d1d5db';
      ctx.textAlign = 'left';
      ctx.fillText('Cette carte est personnelle et non cessible', 80, this.CARD_HEIGHT - 40);

      // Sauvegarder l'image
      const fileName = `nation-card-${uuidv4()}.png`;
      const buffer = canvas.toBuffer('image/png');

      // S3 upload
      const result = await this.s3service.uploadFile({
        buffer: buffer,
        path: "chicken-nation/carte-nation",
        originalname: fileName,
        mimetype: 'image/png'
      })

      this.logger.log(`Carte générée avec succès: ${fileName}`);
      return result?.key || "";
    } catch (error) {
      this.logger.error(`Erreur lors de la génération de la carte: ${error.message}`);
      throw error;
    }
  }

  /**
   * Dessine un rectangle avec coins arrondis
   */
  private roundRect(
    ctx: any,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /**
   * Supprime une image de carte
   */
  async deleteCardImage(filePath: string): Promise<boolean> {
    try {
      this.logger.log(`Image de carte supprimée: ${filePath}`);
      return await this.s3service.deleteFile(filePath);
    } catch (error) {
      this.logger.warn(`Impossible de supprimer l'image: ${filePath}`);
      return false;
    }
  }
}