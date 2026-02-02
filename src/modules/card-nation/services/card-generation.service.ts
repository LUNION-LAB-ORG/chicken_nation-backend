import { Injectable, Logger } from '@nestjs/common';
// import { createCanvas, loadImage } from 'canvas';
// import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
// import { v4 as uuidv4 } from 'uuid';

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
  generateCardNumber(birth_dayDB: string): string {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);

    const birth_day = new Date(birth_dayDB);
    const BD_dd = String(birth_day.getDate()).padStart(2, '0');
    const BD_mm = String(birth_day.getMonth() + 1).padStart(2, '0');
    const BD_yy = String(birth_day.getFullYear()).slice(-2);

    const rand = () => Math.floor(1000 + Math.random() * 9000);

    return `${dd}${mm} ${yy}${BD_dd} ${BD_mm}${BD_yy} ${rand()}`;
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
    return "";
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

  /* =====================================================
     🧩 UTIL — CREATE ROUNDED RECT PATH
  ====================================================== */
  private createRoundedRectPath(
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
}