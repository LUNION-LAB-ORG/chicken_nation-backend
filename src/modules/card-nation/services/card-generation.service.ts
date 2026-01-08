import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, loadImage } from 'canvas';
import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CardGenerationService {
  private readonly logger = new Logger(CardGenerationService.name);

  // Ratio carte bancaire HD
  private readonly CARD_WIDTH = 1014;
  private readonly CARD_HEIGHT = 638;

  constructor(private readonly s3service: S3Service) { }

  /**
   * Génère le code affiché sur la carte
   * Format: DDMM YYXX XXXX XXXX
   */
  generateCardNumber(): string {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const rand = () => Math.floor(1000 + Math.random() * 9000);

    return `${dd}${mm} ${yy}${rand().toString().slice(0, 2)} ${rand()} ${rand()}`;
  }
  generateQRValue(cardNumber: string, customerId: string): string {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const rand = () => Math.floor(1000 + Math.random() * 9000);

    return `${dd}${mm} ${yy}${rand().toString().slice(0, 2)} ${rand()} ${rand()}`;
  }

  async generateCardImage(
    firstName: string,
    lastName: string,
    displayCode: string,
    qrValue: string,
    nickname?: string,
  ): Promise<string> {
    const canvas = createCanvas(this.CARD_WIDTH, this.CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    /* =====================
       🎨 FOND ORANGE
    ====================== */
    const bg = ctx.createLinearGradient(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);
    bg.addColorStop(0, '#f59e0b');
    bg.addColorStop(0.5, '#ea580c');
    bg.addColorStop(1, '#c2410c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);

    /* =====================
       🌊 LIGNES ONDULÉES
    ====================== */
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 420 + i * 8);
      ctx.bezierCurveTo(
        250,
        360 - i * 10,
        750,
        520 + i * 10,
        this.CARD_WIDTH,
        360 - i * 6,
      );
      ctx.stroke();
    }

    /* =====================
       🏷️ TITRE
    ====================== */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('CARTE NATION', 60, 90);

    /* =====================
       🐔 LOGO
    ====================== */
    try {
      const logoUrl = this.s3service.getCdnFileUrl(
        'chicken-nation/assets/images/logos/logo_fond_blanc.png',
      );
      this.logger.log(`Logo URL: ${logoUrl}`);

      const logo = await loadImage(logoUrl);
      this.logger.log(`Logo loaded: ${logo}`);
      ctx.drawImage(logo, this.CARD_WIDTH - 260, 40, 200, 120);
    } catch {
      ctx.font = 'bold 36px Arial';
      ctx.fillText('CHICKEN NATION', this.CARD_WIDTH - 350, 90);
    }

    /* =====================
       ▶️ CODE CARTE
    ====================== */
    ctx.font = 'bold 44px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('▶', 60, 300);
    ctx.fillText(displayCode, 110, 300);

    /* =====================
       📦 QR CODE
    ====================== */
    const qrDataUrl = await QRCode.toDataURL(qrValue, {
      width: 260,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const qr = await loadImage(qrDataUrl);

    const qrX = this.CARD_WIDTH - 300;
    const qrY = this.CARD_HEIGHT - 300;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(qrX - 10, qrY - 10, 280, 280);
    ctx.drawImage(qr, qrX, qrY, 260, 260);

    /* =====================
       👤 SURNOM
    ====================== */
    if (nickname) {
      ctx.font = 'bold 26px Arial';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(nickname.toUpperCase(), qrX - 420, qrY + 40);
    }

    /* =====================
       👤 NOM COMPLET (SUR LE QR)
    ====================== */
    ctx.font = 'bold 34px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      `${lastName.toUpperCase()} ${firstName.toUpperCase()}`,
      qrX - 420,
      qrY + 90,
    );

    /* =====================
       💾 UPLOAD
    ====================== */
    const fileName = `carte-nation-${uuidv4()}.png`;
    const buffer = canvas.toBuffer('image/png');

    const result = await this.s3service.uploadFile({
      buffer,
      path: 'chicken-nation/carte-nation',
      originalname: fileName,
      mimetype: 'image/png',
    });

    this.logger.log(`Carte générée : ${fileName}`);
    return result?.key || "";
  }
}
