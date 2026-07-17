import { Injectable, Logger } from '@nestjs/common';
import { LoyaltyLevel } from '@prisma/client';
import { createCanvas, loadImage } from 'canvas';
import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
import { v4 as uuidv4 } from 'uuid';

/** Options de thème passées à la génération d'image (Phase 3). */
export interface CardImageThemeOptions {
  /** Niveau de fidélité snapshoté → pilote la couleur d'accent de la carte. */
  level?: LoyaltyLevel | null;
  /** Marqueur ETUDIANT → ajoute un liseré/badge jaune par-dessus. */
  is_student?: boolean;
}

@Injectable()
export class CardGenerationService {
  private readonly logger = new Logger(CardGenerationService.name);

  // Résolution de l'image à reproduire
  private readonly CARD_WIDTH = 1536;
  private readonly CARD_HEIGHT = 1024;

  // Thème couleur par niveau (généré par dessin canvas, sans asset externe).
  private readonly STUDENT_COLOR = '#FFD24C'; // liseré / badge ETUDIANT (jaune)
  private readonly LEVEL_THEME: Record<LoyaltyLevel, { color: string; label: string }> = {
    STANDARD: { color: '#F17922', label: 'STANDARD' }, // orange
    VIP: { color: '#D4AF37', label: 'VIP' }, // or
    VVIP: { color: '#C0392B', label: 'VVIP' }, // rouge
  };

  constructor(private readonly s3service: S3Service) { }

  /** Résout le thème (couleur + libellé) pour un niveau donné (défaut STANDARD). */
  private resolveTheme(level?: LoyaltyLevel | null): { color: string; label: string } {
    return (level && this.LEVEL_THEME[level]) || this.LEVEL_THEME.STANDARD;
  }

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
    theme?: CardImageThemeOptions,
    /**
     * true → renvoie un data-URL base64 SANS uploader sur S3 (aperçu backoffice :
     * galerie des designs / testeur de génération). Évite les PNG orphelins.
     */
    renderOnly = false,
  ): Promise<string> {
    const canvas = createCanvas(this.CARD_WIDTH, this.CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    const { color: accentColor, label: levelLabel } = this.resolveTheme(theme?.level);
    const isStudent = theme?.is_student === true;

    /* =====================================================
       🖼️ FOND OFFICIEL (COVER) AVEC COINS ARRONDIS
    ====================================================== */
    const bgUrl = await this.s3service.getCdnFileUrl(
      'chicken-nation/assets/images/carte_nation/carte_nation_fond.png',
    );
    const bg = await loadImage(bgUrl);

    // Créer un chemin avec coins arrondis
    const cornerRadius = 40; // Rayon des coins arrondis
    this.createRoundedRectPath(ctx, 0, 0, this.CARD_WIDTH, this.CARD_HEIGHT, cornerRadius);
    ctx.clip(); // Appliquer le masque

    this.drawImageCover(ctx, bg);

    /* =====================================================
       🎨 THÈME COULEUR PAR NIVEAU (bordure d'accent)
       + LISERÉ JAUNE ÉTUDIANT (par-dessus, si applicable)
    ====================================================== */
    // Bordure d'accent au niveau (orange / or / rouge).
    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 20;
    this.createRoundedRectPath(ctx, 22, 22, this.CARD_WIDTH - 44, this.CARD_HEIGHT - 44, 30);
    ctx.stroke();
    // Liseré jaune ETUDIANT, en retrait de la bordure de niveau.
    if (isStudent) {
      ctx.strokeStyle = this.STUDENT_COLOR;
      ctx.lineWidth = 10;
      this.createRoundedRectPath(ctx, 48, 48, this.CARD_WIDTH - 96, this.CARD_HEIGHT - 96, 24);
      ctx.stroke();
    }
    ctx.restore();

    /* =====================================================
       🏷️ TITRE "CARTE NATION"
    ====================================================== */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 80px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('CARTE DE LA NATION', 80, 160);

    /* =====================================================
       🥇 BADGE NIVEAU (pilule colorée) + BADGE ÉTUDIANT
    ====================================================== */
    this.drawPill(ctx, 80, 210, levelLabel, accentColor, '#ffffff');
    if (isStudent) {
      // Décalé à droite du badge niveau.
      const levelPillWidth = this.pillWidth(ctx, levelLabel);
      this.drawPill(ctx, 80 + levelPillWidth + 24, 210, 'ÉTUDIANT', this.STUDENT_COLOR, '#1A1A1A');
    }

    /* =====================================================
       🐔 LOGO (AGRANDI - EN HAUT À DROITE)
    ====================================================== */
    const logoUrl = await this.s3service.getCdnFileUrl(
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
    ctx.font = 'medium 80px monospace';
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

    // Aperçu backoffice : image renvoyée en data-URL, AUCUN upload (sinon chaque
    // prévisualisation laisserait un PNG orphelin sur S3).
    if (renderOnly) {
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }

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
     🧩 UTIL — PILL (badge arrondi coloré)
  ====================================================== */
  private readonly PILL_FONT = 'bold 44px Arial';
  private readonly PILL_PAD_X = 34;
  private readonly PILL_HEIGHT = 74;

  /** Largeur totale d'une pilule pour un libellé (pour enchaîner les badges). */
  private pillWidth(ctx: any, label: string): number {
    ctx.save();
    ctx.font = this.PILL_FONT;
    const textWidth = ctx.measureText(label).width;
    ctx.restore();
    return textWidth + this.PILL_PAD_X * 2;
  }

  /** Dessine une pilule remplie (badge) avec texte centré verticalement. */
  private drawPill(
    ctx: any,
    x: number,
    y: number,
    label: string,
    bgColor: string,
    textColor: string,
  ) {
    const width = this.pillWidth(ctx, label);
    const height = this.PILL_HEIGHT;

    ctx.save();
    ctx.fillStyle = bgColor;
    this.createRoundedRectPath(ctx, x, y, width, height, height / 2);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.font = this.PILL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + this.PILL_PAD_X, y + height / 2 + 2);
    ctx.restore();
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