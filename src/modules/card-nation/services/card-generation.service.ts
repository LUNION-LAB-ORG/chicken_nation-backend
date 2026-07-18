import { Injectable, Logger } from '@nestjs/common';
import { LoyaltyLevel } from '@prisma/client';
import { createCanvas, loadImage } from 'canvas';
import { randomInt } from 'crypto';
import * as QRCode from 'qrcode';
import { S3Service } from 'src/s3/s3.service';
import { v4 as uuidv4 } from 'uuid';

/** Options de thème / contenu passées à la génération d'image. */
export interface CardImageThemeOptions {
  /** Niveau de fidélité snapshoté → pilote la couleur d'accent de la carte. */
  level?: LoyaltyLevel | null;
  /** Marqueur ETUDIANT → ajoute un liseré/badge jaune par-dessus. */
  is_student?: boolean;
  /**
   * Clé S3 de la photo du titulaire → dessinée en grand en bas de la carte.
   * Absente → photo par défaut « champion » (cf. DEFAULT_PHOTO_KEY).
   */
  photo_key?: string | null;
  /**
   * Photo fournie directement (aperçu backoffice : on teste un rendu avec une
   * vraie photo sans rien uploader). Prioritaire sur `photo_key`.
   */
  photo_buffer?: Buffer | null;
}

@Injectable()
export class CardGenerationService {
  private readonly logger = new Logger(CardGenerationService.name);

  // Résolution de l'image à reproduire
  private readonly CARD_WIDTH = 1536;
  private readonly CARD_HEIGHT = 1024;

  /** Alphabet du code carte : ni 0/O, ni 1/I/L → aucune erreur de lecture/dictée. */
  private static readonly CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  private static readonly CODE_LENGTH = 6;

  /**
   * Photo par défaut du titulaire : la mascotte « champion » CN.
   * Utilisée quand le client n'envoie aucune photo → aucune carte sans visage.
   */
  static readonly DEFAULT_PHOTO_KEY =
    'chicken-nation/assets/images/carte_nation/champion-default.png';

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
   * Génère le code affiché sur la carte : `CN-XXXXXX`.
   *
   * Préfixe marque + 6 caractères d'un alphabet NON AMBIGU (ni 0/O, ni 1/I/L) →
   * 31^6 ≈ 887 M combinaisons, lisible et dictable sans erreur. Même convention
   * que les codes de parrainage.
   *
   * ⚠️ Remplace l'ancien format `DDMM YYXX MMYY RAND` (16 chiffres) qui était
   * long ET encodait la DATE DE NAISSANCE du titulaire (donnée perso imprimée
   * sur la carte).
   *
   * ⚠️ Ne garantit pas à lui seul l'unicité : l'appelant vérifie la contrainte
   * `card_number @unique` et régénère en cas de collision
   * (cf. CardRequestService.allocateCardNumber).
   */
  generateCardNumber(): string {
    const alphabet = CardGenerationService.CODE_ALPHABET;
    let code = '';
    for (let i = 0; i < CardGenerationService.CODE_LENGTH; i++) {
      code += alphabet[randomInt(alphabet.length)];
    }
    return `CN-${code}`;
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
       🎨 DOMINANTE COULEUR = LE NIVEAU (cahier des charges §4.5)
       « Niveau (couleur) : Standard → VIP → VVIP » avec une DOMINANTE
       Orange / Or / Rouge. On recolore donc le fond de marque à la teinte du
       niveau : le blend 'color' prend la teinte+saturation de la couleur et
       garde la luminosité du fond (volutes, dégradé, texture préservés).
       Sans ça, tous les niveaux partagent le même fond orange et sont
       indiscernables — c'était le cas avant.
    ====================================================== */
    ctx.save();
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);
    // 'color' seul délave les teintes sombres (VVIP) : on renforce la densité.
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, this.CARD_WIDTH, this.CARD_HEIGHT);
    ctx.restore();

    /* =====================================================
       🎨 BORDURE D'ACCENT AU NIVEAU
       + LISERÉ JAUNE ÉTUDIANT (marqueur posé PAR-DESSUS le niveau, §4.5)
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
       🔳 QR CODE + CODE CARTE (AU CENTRE GAUCHE)
       Le QR est posé DEVANT le code, à l'emplacement de l'ancien glyphe « ▶ »
       qui s'affichait en carré vide (police sans ce caractère → tofu).
    ====================================================== */
    const qrSize = 130;
    const qrDataUrl = await QRCode.toDataURL(qrValue, {
      width: qrSize * 2, // rendu 2x puis réduit → QR net
      margin: 0,
      errorCorrectionLevel: 'M',
    });
    const qr = await loadImage(qrDataUrl);

    const qrX = 70;
    const qrY = 520 - qrSize + 12; // aligné sur la ligne de base du code

    // Fond blanc : indispensable à la lisibilité du QR sur un fond coloré.
    ctx.fillStyle = '#ffffff';
    this.createRoundedRectPath(ctx, qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12);
    ctx.fill();
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    ctx.font = 'medium 80px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(displayCode, qrX + qrSize + 40, 520);

    /* =====================================================
       🧑 PHOTO DU TITULAIRE (EN BAS À DROITE, EN GRAND)
       Bornée à 1/2 hauteur × 1/2 largeur de la carte, ratio préservé.
       Défaut « champion » si le client n'a pas fourni de photo.
    ====================================================== */
    // La carte affiche TOUJOURS la mascotte « champion ». La photo du client
    // n'est PLUS imprimée sur la carte : elle sert uniquement à la vérification
    // d'identité au backoffice (cf. décision CEO). On ignore donc photo_key /
    // photo_buffer pour le rendu.
    const photoKey = CardGenerationService.DEFAULT_PHOTO_KEY;
    try {
      const photoSource = await this.s3service.getCdnFileUrl(photoKey);
      const photo = await loadImage(photoSource as never);

      // Cercle borné à 1/2 de la carte (diamètre = moitié du petit côté).
      const diameter = Math.min(this.CARD_WIDTH, this.CARD_HEIGHT) / 2;
      const radius = diameter / 2;
      const cx = this.CARD_WIDTH - radius - 80;
      const cy = this.CARD_HEIGHT - radius - 55;

      // COVER : la photo remplit le cercle sans être déformée (on rogne le débord).
      const scale = Math.max(diameter / photo.width, diameter / photo.height);
      const pw = photo.width * scale;
      const ph = photo.height * scale;

      // Champion détouré en cercle, SANS anneau/bordure autour (le cercle qui
      // l'entourait a été retiré à la demande du CEO).
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(photo, cx - pw / 2, cy - ph / 2, pw, ph);
      ctx.restore();
    } catch (error) {
      // Une photo illisible ne doit jamais faire échouer l'émission de la carte.
      this.logger.warn(
        `Photo carte ignorée (${photoKey}) : ${(error as Error)?.message}`,
      );
    }

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