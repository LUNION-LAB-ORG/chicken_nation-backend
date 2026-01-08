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
       🏷️ TITRE
    ====================================================== */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('CARTE NATION', 60, 90);

    /* =====================================================
       🐔 LOGO (RATIO RESPECTÉ – PETIT)
    ====================================================== */
    const logoUrl = this.s3service.getCdnFileUrl(
      'chicken-nation/assets/images/logos/logo_fond_blanc.png',
    );
    const logo = await loadImage(logoUrl);

    const logoTargetHeight = 90;
    const logoRatio = logo.width / logo.height;
    const logoTargetWidth = logoTargetHeight * logoRatio;

    ctx.drawImage(
      logo,
      this.CARD_WIDTH - logoTargetWidth - 60,
      50,
      logoTargetWidth,
      logoTargetHeight,
    );

    /* =====================================================
       ▶️ CODE CARTE
    ====================================================== */
    ctx.font = 'bold 44px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('▶', 60, 300);
    ctx.fillText(displayCode, 110, 300);

    /* =====================================================
       📦 QR CODE (TAILLE MAÎTRISÉE)
    ====================================================== */
    const qrSize = 180;

    const qrDataUrl = await QRCode.toDataURL(qrValue, {
      width: qrSize,
      margin: 0,
      errorCorrectionLevel: 'M',
    });

    const qr = await loadImage(qrDataUrl);

    const qrX = this.CARD_WIDTH - qrSize - 70;
    const qrY = this.CARD_HEIGHT - qrSize - 100;

    // fond blanc discret
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16);
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    /* =====================================================
       👤 SURNOM / NOM / PRÉNOMS
       → À CÔTÉ DU QR
       → ALIGNÉS SUR LE PIED DU QR
    ====================================================== */
    const textBaseY = qrY + qrSize;
    const textX = qrX - 420;

    if (nickname) {
      ctx.font = 'bold 22px Arial';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(nickname.toUpperCase(), textX, textBaseY - 30);
    }

    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      `${lastName.toUpperCase()} ${firstName.toUpperCase()}`,
      textX,
      textBaseY,
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
