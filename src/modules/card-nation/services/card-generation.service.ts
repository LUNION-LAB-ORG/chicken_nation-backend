import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, loadImage } from 'canvas';
import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CardGenerationService {
  private readonly logger = new Logger(CardGenerationService.name);

  // Résolution de l'image à reproduire
  private readonly CARD_WIDTH = 1536;
  private readonly CARD_HEIGHT = 1024;

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
    return `${cardNumber}-${customerId}`;
  }

  /**
   * Génération image carte Nation
   */
  async generateCardImage(
    firstName: string,
    lastName: string,
    displayCode: string,
    qrValue: string,
    nickname?: string,
  ): Promise<string> {
    const canvas = createCanvas(this.CARD_WIDTH, this.CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    /* =====================================================
       🖼️ FOND OFFICIEL (COVER)
    ====================================================== */
    const bgUrl = this.s3service.getCdnFileUrl(
      'chicken-nation/assets/images/carte_nation/carte_nation_fond.png',
    );
    const bg = await loadImage(bgUrl);
    this.drawImageCover(ctx, bg);

    /* =====================================================
       🏷️ TITRE "CARTE NATION"
    ====================================================== */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 90px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('CARTE NATION', 80, 160);

    /* =====================================================
       🐔 LOGO (AGRANDI - EN HAUT À DROITE)
    ====================================================== */
    const logoUrl = this.s3service.getCdnFileUrl(
      'chicken-nation/assets/images/logos/logo_fond_blanc.png',
    );
    const logo = await loadImage(logoUrl);

    // Logo beaucoup plus grand
    const logoTargetHeight = 280;
    const logoRatio = logo.width / logo.height;
    const logoTargetWidth = logoTargetHeight * logoRatio;

    ctx.drawImage(
      logo,
      this.CARD_WIDTH - logoTargetWidth - 80,
      60,
      logoTargetWidth,
      logoTargetHeight,
    );

    /* =====================================================
       ▶️ CODE CARTE (AU CENTRE GAUCHE)
    ====================================================== */
    ctx.font = 'bold 90px monospace';
    ctx.fillStyle = '#ffffff';

    // Triangle play à gauche
    ctx.fillText('▶', 70, 520);

    // Code carte avec espacement
    ctx.fillText(displayCode, 200, 520);

    /* =====================================================
       📦 QR CODE (EN BAS À DROITE - AGRANDI)
    ====================================================== */
    const qrSize = 280;

    const qrDataUrl = await QRCode.toDataURL(qrValue, {
      width: qrSize,
      margin: 0,
      errorCorrectionLevel: 'M',
    });

    const qr = await loadImage(qrDataUrl);

    const qrX = this.CARD_WIDTH - qrSize - 100;
    const qrY = this.CARD_HEIGHT - qrSize - 80;

    // Fond blanc pour le QR
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24);
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    /* =====================================================
       👤 SURNOM / NOM / PRÉNOMS
       → EN BAS À GAUCHE DU QR CODE
       → TEXTES AGRANDIS ET BIEN POSITIONNÉS
    ====================================================== */
    const textX = 80;
    const textBaseY = this.CARD_HEIGHT - 180;

    // Surnom (plus petit, couleur dorée/jaune)
    if (nickname) {
      ctx.font = 'bold 42px Arial';
      ctx.fillStyle = '#FFD700'; // Couleur dorée
      ctx.textAlign = 'left';
      ctx.fillText(nickname.toUpperCase(), textX, textBaseY);
    }

    // Nom et prénom (gros et blanc)
    ctx.font = 'bold 60px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${lastName.toUpperCase()} ${firstName.toUpperCase()}`,
      textX,
      textBaseY + 70,
    );

    /* =====================================================
       💾 UPLOAD S3
    ====================================================== */
    const fileName = `carte-nation-${uuidv4()}.png`;
    const buffer = canvas.toBuffer('image/png');

    const result = await this.s3service.uploadFile({
      buffer,
      path: 'chicken-nation/carte-nation',
      originalname: fileName,
      mimetype: 'image/png',
    });

    this.logger.log(`Carte Nation générée : ${fileName}`);
    return result?.key || '';
  }

  /* =====================================================
     🧩 UTIL — DRAW IMAGE COVER
  ====================================================== */
  private drawImageCover(ctx: any, img: any) {
    const canvasRatio = this.CARD_WIDTH / this.CARD_HEIGHT;
    const imgRatio = img.width / img.height;

    let sx = 0,
      sy = 0,
      sw = img.width,
      sh = img.height;

    if (imgRatio > canvasRatio) {
      sw = img.height * canvasRatio;
      sx = (img.width - sw) / 2;
    } else {
      sh = img.width / canvasRatio;
      sy = (img.height - sh) / 2;
    }

    ctx.drawImage(
      img,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      this.CARD_WIDTH,
      this.CARD_HEIGHT,
    );
  }
}