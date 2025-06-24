import { Injectable } from '@nestjs/common';
import { EmailTheme } from '../interfaces/email-theme.interface'; // Assurez-vous que le chemin est correct

@Injectable()
export class EmailThemeService {
  public readonly theme: EmailTheme = {
    colors: {
      primary: '#f27922',
      secondary: '#f7931e',
      accent: '#ff8c42',
      background: '#ffffff',
      surface: '#f8fafc',
      text: {
        primary: '#1a202c',
        secondary: '#4a5568',
        muted: '#718096',
        inverse: '#ffffff',
      },
      status: {
        success: '#10b981',
        warning: '#f59e0b',
        error: '#ef4444',
        info: '#3b82f6',
      },
      gradients: {
        primary: 'linear-gradient(135deg, #f27922 0%, #f7931e 100%)',
        secondary: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        accent: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
      },
    },
    typography: {
      fontFamily: "'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
      fontSize: {
        xs: '12px',
        sm: '14px',
        base: '16px',
        lg: '18px',
        xl: '20px',
        '2xl': '24px',
        '3xl': '30px',
      },
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '600',
        bold: '700',
      },
      lineHeight: {
        tight: '1.25',
        normal: '1.5',
        relaxed: '1.75',
      },
    },
    spacing: {
      xs: '4px',
      sm: '8px',
      md: '16px',
      lg: '24px',
      xl: '32px',
      '2xl': '48px',
      '3xl': '64px',
    },
    borderRadius: {
      sm: '4px',
      md: '8px',
      lg: '12px',
      xl: '16px',
      full: '9999px',
    },
    shadows: {
      sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
      lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
      xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
    },
    animation: {
      duration: {
        fast: '150ms',
        normal: '300ms',
        slow: '500ms',
      },
      easing: {
        default: 'cubic-bezier(0.4, 0, 0.2, 1)',
        bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        smooth: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      },
    },
  };
}