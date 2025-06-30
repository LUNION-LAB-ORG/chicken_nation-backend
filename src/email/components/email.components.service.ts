import { Injectable } from '@nestjs/common';
import { EmailThemeService } from '../theme/email-theme.service';
import { EmailTheme } from '../interfaces/email-theme.interface';

@Injectable()
export class EmailComponentsService {
  constructor(private readonly emailThemeService: EmailThemeService) { }

  // Accédez au thème via this.emailThemeService.theme
  private get theme(): EmailTheme {
    return this.emailThemeService.theme;
  }
  /**
   * Header avec logo et slogan
   */
  Header(logoUrl: string, title: string, subtitle: string): string {
    return `
    <div style="background: ${this.theme.colors.surface}; padding: ${this.theme.spacing['xl']} ${this.theme.spacing.lg}; text-align: center; position: relative; overflow: hidden;">
      <div style="position: relative;">
        <img src="${logoUrl}" alt="Logo" style="width: 100px; height: 100px;">
        <h3 style="color: ${this.theme.colors.primary}; font-size: ${this.theme.typography.fontSize['2xl']}; font-weight: ${this.theme.typography.fontWeight.bold}; margin-bottom: ${this.theme.spacing.sm}; font-family: ${this.theme.typography.fontFamily};">${title}</h3>
        <p style="color: ${this.theme.colors.text.secondary}; font-size: ${this.theme.typography.fontSize.sm}; font-family: ${this.theme.typography.fontFamily};">${subtitle}</p>
      </div>
    </div>
  `;
  }

  /**
   * Composant de salutation
   */
  Greeting(text: string, emoji: string = '🎉'): string {
    return `<div style="font-size: ${this.theme.typography.fontSize.lg}; color: ${this.theme.colors.primary}; margin-bottom: ${this.theme.spacing.xl}; font-weight: ${this.theme.typography.fontWeight.bold}; font-family: ${this.theme.typography.fontFamily};">${text} ${emoji}</div>`;
  }

  /**
   * Composant de message principal
   */
  Message(content: string): string {
    return `<div style="font-size: ${this.theme.typography.fontSize.base}; margin-bottom: ${this.theme.spacing.xl}; color: ${this.theme.colors.text.secondary}; font-family: ${this.theme.typography.fontFamily};">${content}</div>`;
  }

  /**
   * Composant de titre
   */
  Title(text: string, level: 1 | 2 | 3 | 4 = 2): string {
    return `<h${level} style="color: ${this.theme.colors.primary}; margin: ${this.theme.spacing.xl} 0 ${this.theme.spacing.md} 0; font-family: ${this.theme.typography.fontFamily}; font-size: ${this.theme.typography.fontSize.xl};">${text}</h${level}>`;
  }

  /**
   * Composant de sous-titre
   */
  Subtitle(text: string): string {
    return `<p style="color: ${this.theme.colors.text.secondary}; font-size: ${this.theme.typography.fontSize.sm}; margin-bottom: ${this.theme.spacing.lg}; font-family: ${this.theme.typography.fontFamily};">${text}</p>`;
  }

  /**
   * Composant de résumé de commande
   */
  Summary(items: Array<{ label: string; value: string; isTotal?: boolean }>): string {
    const itemsHtml = items.map(item =>
      `<div style="display: flex; justify-content: space-between; padding: ${this.theme.spacing.sm} 0; border-bottom: 1px solid ${this.theme.colors.primary}30; ${item.isTotal ? `font-weight: ${this.theme.typography.fontWeight.bold}; color: ${this.theme.colors.primary}; padding-top: ${this.theme.spacing.md}; margin-top: ${this.theme.spacing.sm};` : ''} font-family: ${this.theme.typography.fontFamily};">
      <span>${item.label} : </span>
      <span>${item.value}</span>
    </div>`
    ).join('');

    return `
    <div style="background-color: ${this.theme.colors.primary}10; border: 2px solid ${this.theme.colors.primary}; border-radius: ${this.theme.borderRadius.lg}; padding: ${this.theme.spacing.xl}; margin: ${this.theme.spacing.xl} 0;">
      ${itemsHtml}
    </div>
  `;
  }

  /**
   * Composant d'informations restaurant
   */
  RestaurantInfo(title: string, infos: Array<{ label: string; value: string }>): string {
    const infosHtml = infos.map(info =>
      `<p style="margin: 0; padding-bottom: ${this.theme.spacing.xs}; font-family: ${this.theme.typography.fontFamily};"><strong>${info.label}:</strong> ${info.value}</p>`
    ).join('');

    return `
    <div style="background-color: ${this.theme.colors.primary}05; border-radius: ${this.theme.borderRadius.md}; padding: ${this.theme.spacing.xl}; margin: ${this.theme.spacing.xl} 0; border: 1px solid ${this.theme.colors.primary}20;">
      <h4 style="color: ${this.theme.colors.primary}; margin-bottom: ${this.theme.spacing.md}; font-family: ${this.theme.typography.fontFamily};">${title}</h4>
      ${infosHtml}
    </div>
  `;
  }

  /**
   * Composant de boîte d'information
   */
  InfoBox(content: string, icon: string = '💡'): string {
    return `
    <div style="background-color: ${this.theme.colors.background}; border-left: 4px solid ${this.theme.colors.primary}; padding: ${this.theme.spacing.xl}; margin: ${this.theme.spacing.xl} 0; border-radius: 0 ${this.theme.borderRadius.md} ${this.theme.borderRadius.md} 0; font-family: ${this.theme.typography.fontFamily};">
      <p><strong>${icon} Bon à savoir :</strong> ${content}</p>
    </div>
  `;
  }

  /**
   * Composant de bouton d'action
   */
  CtaButton(text: string, url: string, icon: string = ''): string {
    return `
    <div style="text-align: center;">
      <a href="${url}" target="_blank" style="display: inline-block; background: ${this.theme.colors.gradients.primary}; color: ${this.theme.colors.text.inverse}; padding: ${this.theme.spacing.md} ${this.theme.spacing['2xl']}; text-decoration: none; border-radius: ${this.theme.borderRadius.full}; font-weight: ${this.theme.typography.fontWeight.bold}; font-size: ${this.theme.typography.fontSize.base}; margin: ${this.theme.spacing.xl} 0; box-shadow: ${this.theme.shadows.md}; transition: all ${this.theme.animation.duration.normal} ${this.theme.animation.easing.default}; font-family: ${this.theme.typography.fontFamily};">${icon} ${text}</a>
    </div>
  `;
  }

  /**
   * Composant de liste simple
    */
  List(items: string[], ordered: boolean = false): string {
    const tag = ordered ? 'ol' : 'ul';
    const itemsHtml = items.map(item => `<li style="margin-bottom: ${this.theme.spacing.xs};">${item}</li>`).join('');

    return `
    <${tag} style="margin: ${this.theme.spacing.lg} 0; padding-left: ${this.theme.spacing.xl}; color: ${this.theme.colors.text.secondary}; font-family: ${this.theme.typography.fontFamily};">
      ${itemsHtml}
    </${tag}>
  `;
  }

  /**
   * Composant de séparateur
   */
  Divider(): string {
    return `<hr style="border: none; border-top: 1px solid ${this.theme.colors.text.muted}20; margin: ${this.theme.spacing['2xl']} 0;">`;
  }

  /**
   * Composant de citation/highlight
   */
  Quote(text: string, author?: string): string {
    const authorHtml = author ? `<cite style="font-style: italic; color: ${this.theme.colors.text.secondary}; font-family: ${this.theme.typography.fontFamily};">— ${author}</cite>` : '';

    return `
    <blockquote style="
      border-left: 4px solid ${this.theme.colors.primary};
      padding: ${this.theme.spacing.lg} ${this.theme.spacing.xl};
      margin: ${this.theme.spacing.xl} 0;
      background-color: ${this.theme.colors.primary}05;
      font-style: italic;
      font-family: ${this.theme.typography.fontFamily};
    ">
      <p style="margin: 0;">${text}</p>
      ${authorHtml}
    </blockquote>
  `;
  }

  /**
   * Composant d'alerte
   */
  Alert(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): string {
    const colors = {
      info: { bg: `${this.theme.colors.status.info}15`, border: `${this.theme.colors.status.info}`, icon: 'ℹ️' },
      success: { bg: `${this.theme.colors.status.success}15`, border: `${this.theme.colors.status.success}`, icon: '✅' },
      warning: { bg: `${this.theme.colors.status.warning}15`, border: `${this.theme.colors.status.warning}`, icon: '⚠️' },
      error: { bg: `${this.theme.colors.status.error}15`, border: `${this.theme.colors.status.error}`, icon: '❌' }
    };

    const color = colors[type];

    return `
    <div style="
      background-color: ${color.bg};
      border: 1px solid ${color.border};
      border-radius: ${this.theme.borderRadius.md};
      padding: ${this.theme.spacing.lg};
      margin: ${this.theme.spacing.lg} 0;
      font-family: ${this.theme.typography.fontFamily};
    ">
      <p style="margin: 0;"><strong>${color.icon}</strong> ${message}</p>
    </div>
  `;
  }

  /**
   * Composant de colonnes (layout)
   */
  Columns(leftContent: string, rightContent: string): string {
    return `
    <div style="display: flex; gap: ${this.theme.spacing.xl}; margin: ${this.theme.spacing.xl} 0; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 250px;">${leftContent}</div>
      <div style="flex: 1; min-width: 250px;">${rightContent}</div>
    </div>
  `;
  }

  /**
   * Composant de liens sociaux
   */
  SocialLinks(links: Array<{ icon: string; url: string }>): string {
    const linksHtml = links.map(link => `<a href="${link.url}" style="display: inline-block; margin: 0 ${this.theme.spacing.md}; color: ${this.theme.colors.primary}; font-size: ${this.theme.typography.fontSize.lg}; text-decoration: none;">${link.icon.toUpperCase()}</a>`).join('');
    return `<div style="margin: ${this.theme.spacing.xl} 0;">${linksHtml}</div>`;
  }

  /**
   * Composant de footer personnalisé
   */
  Footer(companyName: string, slogan: string, supportEmail: string, unsubscribeUrl: string, websiteUrl: string, socialLinksHtml: string = ''): string {
    return `
    <div style="background-color: ${this.theme.colors.text.primary}; color: ${this.theme.colors.text.inverse}; padding: ${this.theme.spacing['2xl']} ${this.theme.spacing.xl}; text-align: center; font-family: ${this.theme.typography.fontFamily};">
      <p style="margin: 0 0 ${this.theme.spacing.xs} 0;"><strong>${companyName}</strong></p>
      <p style="margin: 0 0 ${this.theme.spacing.lg} 0;">${slogan}</p>
      ${socialLinksHtml}
      <p style="font-size: ${this.theme.typography.fontSize.xs}; color: ${this.theme.colors.text.muted}; margin-top: ${this.theme.spacing.xl};">
        Support: <a target="_blank" href="mailto:${supportEmail}" style="color: ${this.theme.colors.primary}; text-decoration: none;">${supportEmail}</a><br>
        <a target="_blank" href="${unsubscribeUrl}" style="color: ${this.theme.colors.primary}; text-decoration: none;">Se désabonner</a> |
        <a target="_blank" href="${websiteUrl}" style="color: ${this.theme.colors.primary}; text-decoration: none;">Visiter notre site</a>
      </p>
    </div>
  `;
  }
  /**
   * Hero Section
   */
  HeroSection(title: string, subtitle?: string, backgroundImage?: string): string {
    const bgStyle = backgroundImage
      ? `background-image: linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), url('${backgroundImage}'); background-size: cover; background-position: center;`
      : `background: ${this.theme.colors.gradients.primary};`;

    return `
      <div style="
        ${bgStyle}
        padding: ${this.theme.spacing['3xl']} ${this.theme.spacing.lg};
        text-align: center;
        border-radius: ${this.theme.borderRadius.lg};
        margin: ${this.theme.spacing.lg} 0;
        color: ${this.theme.colors.text.inverse};
      ">
        <h1 style="
          font-size: ${this.theme.typography.fontSize['3xl']};
          font-weight: ${this.theme.typography.fontWeight.bold};
          margin: 0 0 ${this.theme.spacing.md} 0;
          font-family: ${this.theme.typography.fontFamily};
        ">${title}</h1>
        ${subtitle ? `
          <p style="
            font-size: ${this.theme.typography.fontSize.lg};
            margin: 0;
            opacity: 0.9;
            font-family: ${this.theme.typography.fontFamily};
          ">${subtitle}</p>
        ` : ''}
      </div>
    `;
  }

  /**
   * Glassmorphism Card
   */
  GlassCard(content: string, title?: string): string {
    return `
      <div style="
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: ${this.theme.borderRadius.xl};
        padding: ${this.theme.spacing.xl};
        margin: ${this.theme.spacing.lg} 0;
        box-shadow: ${this.theme.shadows.lg};
      ">
        ${title ? `
          <h3 style="
            color: ${this.theme.colors.primary};
            font-size: ${this.theme.typography.fontSize.xl};
            font-weight: ${this.theme.typography.fontWeight.semibold};
            margin: 0 0 ${this.theme.spacing.md} 0;
            font-family: ${this.theme.typography.fontFamily};
          ">${title}</h3>
        ` : ''}
        <div style="font-family: ${this.theme.typography.fontFamily};">${content}</div>
      </div>
    `;
  }

  /**
   * Button
   */
  Button(text: string, url: string, variant: 'primary' | 'secondary' | 'outline' = 'primary', size: 'sm' | 'md' | 'lg' = 'md'): string {
    const variants = {
      primary: {
        background: this.theme.colors.gradients.primary,
        color: this.theme.colors.text.inverse,
        border: 'none',
      },
      secondary: {
        background: this.theme.colors.surface,
        color: this.theme.colors.text.primary,
        border: `2px solid ${this.theme.colors.primary}`,
      },
      outline: {
        background: 'transparent',
        color: this.theme.colors.primary,
        border: `2px solid ${this.theme.colors.primary}`,
      },
    };

    const sizes = {
      sm: { padding: `${this.theme.spacing.sm} ${this.theme.spacing.md}`, fontSize: this.theme.typography.fontSize.sm },
      md: { padding: `${this.theme.spacing.md} ${this.theme.spacing.xl}`, fontSize: this.theme.typography.fontSize.base },
      lg: { padding: `${this.theme.spacing.lg} ${this.theme.spacing['2xl']}`, fontSize: this.theme.typography.fontSize.lg },
    };

    const style = variants[variant];
    const sizeStyle = sizes[size];

    return `
      <div style="text-align: center; margin: ${this.theme.spacing.xl} 0;">
        <a href="${url}" target="_blank" style="
          display: inline-block;
          background: ${style.background};
          color: ${style.color};
          border: ${style.border};
          padding: ${sizeStyle.padding};
          font-size: ${sizeStyle.fontSize};
          font-weight: ${this.theme.typography.fontWeight.semibold};
          text-decoration: none;
          border-radius: ${this.theme.borderRadius.full};
          box-shadow: ${this.theme.shadows.md};
          transition: all ${this.theme.animation.duration.normal} ${this.theme.animation.easing.default};
          font-family: ${this.theme.typography.fontFamily};
        " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='${this.theme.shadows.lg}';"
           onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='${this.theme.shadows.md}';">
          ${text}
        </a>
      </div>
    `;
  }

  /**
   * Stats Grid
   */
  StatsGrid(stats: Array<{ label: string; value: string; icon?: string; color?: string }>): string {
    const statsHtml = stats.map(stat => `
      <div style="
        text-align: center;
        padding: ${this.theme.spacing.lg};
        background: ${this.theme.colors.surface};
        border-radius: ${this.theme.borderRadius.lg};
        border: 1px solid rgba(0,0,0,0.05);
      ">
        ${stat.icon ? `<div style="font-size: 32px; margin-bottom: ${this.theme.spacing.sm};">${stat.icon}</div>` : ''}
        <div style="
          font-size: ${this.theme.typography.fontSize['2xl']};
          font-weight: ${this.theme.typography.fontWeight.bold};
          color: ${stat.color || this.theme.colors.primary};
          margin-bottom: ${this.theme.spacing.xs};
          font-family: ${this.theme.typography.fontFamily};
        ">${stat.value}</div>
        <div style="
          font-size: ${this.theme.typography.fontSize.sm};
          color: ${this.theme.colors.text.muted};
          font-family: ${this.theme.typography.fontFamily};
        ">${stat.label}</div>
      </div>
    `).join('');

    return `
      <div style="
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: ${this.theme.spacing.md};
        margin: ${this.theme.spacing.xl} 0;
      ">
        ${statsHtml}
      </div>
    `;
  }

  /**
   * Badge
   */
  Badge(text: string, variant: 'success' | 'warning' | 'error' | 'info' | 'primary' = 'primary'): string {
    const colors = {
      success: this.theme.colors.status.success,
      warning: this.theme.colors.status.warning,
      error: this.theme.colors.status.error,
      info: this.theme.colors.status.info,
      primary: this.theme.colors.primary,
    };

    return `
      <span style="
        display: inline-block;
        background: ${colors[variant]}15;
        color: ${colors[variant]};
        padding: ${this.theme.spacing.xs} ${this.theme.spacing.sm};
        border-radius: ${this.theme.borderRadius.full};
        font-size: ${this.theme.typography.fontSize.xs};
        font-weight: ${this.theme.typography.fontWeight.medium};
        border: 1px solid ${colors[variant]}30;
        font-family: ${this.theme.typography.fontFamily};
      ">${text}</span>
    `;
  }

  /**
   * Timeline
   */
  Timeline(steps: Array<{ title: string; description: string; status: 'completed' | 'current' | 'pending'; time?: string }>): string {
    const stepsHtml = steps.map((step, index) => {
      const statusConfig = {
        completed: { color: this.theme.colors.status.success, icon: '✓', bg: this.theme.colors.status.success + '15' },
        current: { color: this.theme.colors.primary, icon: '●', bg: this.theme.colors.primary + '15' },
        pending: { color: this.theme.colors.text.muted, icon: '○', bg: this.theme.colors.text.muted + '15' },
      };

      const config = statusConfig[step.status];
      const isLast = index === steps.length - 1;

      return `
        <div style="display: flex; position: relative;">
          <div style="
            display: flex;
            flex-direction: column;
            align-items: center;
            margin-right: ${this.theme.spacing.lg};
          ">
            <div style="
              width: 32px;
              height: 32px;
              border-radius: ${this.theme.borderRadius.full};
              background: ${config.bg};
              color: ${config.color};
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: ${this.theme.typography.fontWeight.bold};
              font-size: ${this.theme.typography.fontSize.sm};
              border: 2px solid ${config.color};
            ">${config.icon}</div>
            ${!isLast ? `
              <div style="
                width: 2px;
                height: 40px;
                background: ${this.theme.colors.text.muted}30;
                margin: ${this.theme.spacing.xs} 0;
              "></div>
            ` : ''}
          </div>
          <div style="flex: 1; margin-bottom: ${this.theme.spacing.lg};">
            <div style="
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: ${this.theme.spacing.xs};
            ">
              <h4 style="
                margin: 0;
                color: ${config.color};
                font-size: ${this.theme.typography.fontSize.base};
                font-weight: ${this.theme.typography.fontWeight.semibold};
                font-family: ${this.theme.typography.fontFamily};
              ">${step.title}</h4>
              ${step.time ? `
                <span style="
                  font-size: ${this.theme.typography.fontSize.xs};
                  color: ${this.theme.colors.text.muted};
                  font-family: ${this.theme.typography.fontFamily};
                ">${step.time}</span>
              ` : ''}
            </div>
            <p style="
              margin: 0;
              color: ${this.theme.colors.text.secondary};
              font-size: ${this.theme.typography.fontSize.sm};
              font-family: ${this.theme.typography.fontFamily};
            ">${step.description}</p>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="
        background: ${this.theme.colors.surface};
        border-radius: ${this.theme.borderRadius.lg};
        padding: ${this.theme.spacing.xl};
        margin: ${this.theme.spacing.lg} 0;
        border: 1px solid rgba(0,0,0,0.05);
      ">
        ${stepsHtml}
      </div>
    `;
  }

  /**
   * Pricing Card
   */
  PricingCard(title: string, price: string, features: string[], buttonText: string, buttonUrl: string, featured: boolean = false): string {
    const cardStyle = featured
      ? `background: ${this.theme.colors.gradients.primary}; color: ${this.theme.colors.text.inverse}; transform: scale(1.05);`
      : `background: ${this.theme.colors.background}; color: ${this.theme.colors.text.primary}; border: 1px solid rgba(0,0,0,0.1);`;

    const featuresHtml = features.map(feature => `
      <div style="
        display: flex;
        align-items: center;
        margin: ${this.theme.spacing.sm} 0;
        font-family: ${this.theme.typography.fontFamily};
      ">
        <span style="color: ${featured ? this.theme.colors.text.inverse : this.theme.colors.status.success}; margin-right: ${this.theme.spacing.sm};">✓</span>
        <span style="font-size: ${this.theme.typography.fontSize.sm};">${feature}</span>
      </div>
    `).join('');

    return `
      <div style="
        ${cardStyle}
        border-radius: ${this.theme.borderRadius.xl};
        padding: ${this.theme.spacing['2xl']};
        text-align: center;
        box-shadow: ${this.theme.shadows.lg};
        margin: ${this.theme.spacing.lg} 0;
      ">
        <h3 style="
          font-size: ${this.theme.typography.fontSize.xl};
          font-weight: ${this.theme.typography.fontWeight.bold};
          margin: 0 0 ${this.theme.spacing.md} 0;
          font-family: ${this.theme.typography.fontFamily};
        ">${title}</h3>
        <div style="
          font-size: ${this.theme.typography.fontSize['3xl']};
          font-weight: ${this.theme.typography.fontWeight.bold};
          margin: ${this.theme.spacing.lg} 0;
          font-family: ${this.theme.typography.fontFamily};
        ">${price}</div>
        <div style="text-align: left; margin: ${this.theme.spacing.xl} 0;">
          ${featuresHtml}
        </div>
        ${this.Button(buttonText, buttonUrl, featured ? 'secondary' : 'primary')}
      </div>
    `;
  }

  /**
   * Table
   */
  Table(headers: string[], rows: Array<string[]>, striped: boolean = true): string {
    const headersHtml = headers.map(header => `
      <th style="
        padding: ${this.theme.spacing.md};
        background: ${this.theme.colors.surface};
        color: ${this.theme.colors.text.primary};
        font-weight: ${this.theme.typography.fontWeight.semibold};
        text-align: left;
        border-bottom: 2px solid ${this.theme.colors.primary};
        font-family: ${this.theme.typography.fontFamily};
      ">${header}</th>
    `).join('');

    const rowsHtml = rows.map((row, index) => {
      const bgColor = striped && index % 2 === 1 ? this.theme.colors.surface : 'transparent';
      const cellsHtml = row.map(cell => `
        <td style="
          padding: ${this.theme.spacing.md};
          border-bottom: 1px solid rgba(0,0,0,0.05);
          font-family: ${this.theme.typography.fontFamily};
        ">${cell}</td>
      `).join('');

      return `<tr style="background: ${bgColor};">${cellsHtml}</tr>`;
    }).join('');

    return `
      <div style="margin: ${this.theme.spacing.xl} 0; border-radius: ${this.theme.borderRadius.lg}; overflow: hidden; box-shadow: ${this.theme.shadows.sm};">
        <table style="width: 100%; border-collapse: collapse;">
          <thead><tr>${headersHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  /**
   * Toast Notification
   */
  ToastNotification(message: string, type: 'success' | 'warning' | 'error' | 'info' = 'info', action?: { text: string; url: string }): string {
    const config = {
      success: { color: this.theme.colors.status.success, icon: '✅' },
      warning: { color: this.theme.colors.status.warning, icon: '⚠️' },
      error: { color: this.theme.colors.status.error, icon: '❌' },
      info: { color: this.theme.colors.status.info, icon: 'ℹ️' },
    }[type];

    return `
      <div style="
        background: ${config.color}15;
        border: 1px solid ${config.color}30;
        border-left: 4px solid ${config.color};
        border-radius: ${this.theme.borderRadius.md};
        padding: ${this.theme.spacing.lg};
        margin: ${this.theme.spacing.lg} 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div style="display: flex; align-items: center;">
          <span style="font-size: 20px; margin-right: ${this.theme.spacing.md};">${config.icon}</span>
          <span style="
            color: ${this.theme.colors.text.primary};
            font-family: ${this.theme.typography.fontFamily};
          ">${message}</span>
        </div>
        ${action ? `
          <a href="${action.url}" target="_blank" style="
            color: ${config.color};
            text-decoration: none;
            font-weight: ${this.theme.typography.fontWeight.semibold};
            font-family: ${this.theme.typography.fontFamily};
          ">${action.text}</a>
        ` : ''}
      </div>
    `;
  }
}