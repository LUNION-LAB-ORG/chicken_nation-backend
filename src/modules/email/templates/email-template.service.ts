import { Injectable } from '@nestjs/common';
import { EmailThemeService } from '../theme/email-theme.service';
import { EmailTheme } from '../interfaces/email-theme.interface';

@Injectable()
export class EmailTemplateService {

    constructor(
        private readonly emailThemeService: EmailThemeService
    ) { }

    // Accédez au thème via this.emailThemeService.theme
    private get theme(): EmailTheme {
        return this.emailThemeService.theme;
    }

    /**
     * Génère le HTML d'un email Chicken Nation
     * @param content Contenu à injecter dans le template
     * @returns HTML string prêt à être envoyé
     */
    generateEmailTemplate({ content, header, footer }: { content: string, header?: string, footer?: string }): string {
        const baseTemplate = this.getBaseTemplate();

        return baseTemplate.replace('{{CONTENT}}', content)
            .replace('{{HEADER}}', header ?? '')
            .replace('{{FOOTER}}', footer ?? '');
    }

    private getBaseTemplate(): string {
        return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chicken Nation</title>
            <style>
                body {
                    font-family: ${this.theme.typography.fontFamily};
                    background-color: ${this.theme.colors.background};
                    color: ${this.theme.colors.text.primary};
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
  
                .email-container {
                    max-width: 800px;
                    margin: 0 auto;
                    background-color: ${this.theme.colors.surface};
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }
  
                .content {
                    padding: ${this.theme.spacing['2xl']} ${this.theme.spacing['2xl']};
                }
  
                @media (max-width: 800px) {
                    .email-container {
                        margin: 0;
                        box-shadow: none;
                    }
                    .content {
                        padding: ${this.theme.spacing.xl} ${this.theme.spacing.lg};
                    }
                }
            </style>
        </head>
        <body>
            <div class="email-container">
           {{HEADER}}
              <div class="content">
               {{CONTENT}}
              </div>
              {{FOOTER}}
            </div>
        </body>
        </html>
      `;
    }
}