import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
import { SettingsService } from 'src/modules/settings/settings.service';

export interface ScanResult {
  engine: string;
  platform: 'GLOVO' | 'YANGO' | null;
  name: string | null;
  phone: string | null;
  order_number: string | null;
}

const PROMPT = `Tu reçois une capture d'écran d'une commande passée via Glovo ou Yango (Côte d'Ivoire).
Réponds STRICTEMENT en JSON, sans aucun texte autour :
{"platform":"GLOVO"|"YANGO"|null,"name":string|null,"phone":string|null,"order_number":string|null}
Règles :
- platform : déduis de l'interface (Glovo = écran avec QR + "Enregistrons la commande" ; Yango = écran "N°...-..." / "En préparation").
- name : nom du client si visible, sinon null (Yango n'affiche pas de nom).
- phone : numéro de téléphone (chiffres uniquement).
- order_number : numéro de la commande.`;

@Injectable()
export class ProspectScanService {
  private readonly logger = new Logger(ProspectScanService.name);

  constructor(private readonly settings: SettingsService) {}

  async scan(image: Buffer, mime: string): Promise<ScanResult> {
    const v = await this.settings.getMany([
      'prospect.scan_engine',
      'prospect.scan_api_key',
      'prospect.scan_model',
    ]);
    const engine = (v['prospect.scan_engine'] || 'TESSERACT').toUpperCase();
    const apiKey = v['prospect.scan_api_key'] || '';
    const model = v['prospect.scan_model'] || '';

    if (engine !== 'TESSERACT' && !apiKey) {
      throw new BadRequestException(
        `Clé API manquante pour le moteur ${engine}. Renseignez-la dans Paramètres → Marketing.`,
      );
    }

    let raw: Record<string, unknown> = {};
    try {
      if (engine === 'OPENAI') raw = await this.openai(image, mime, apiKey, model);
      else if (engine === 'GEMINI') raw = await this.gemini(image, mime, apiKey, model);
      else if (engine === 'ANTHROPIC')
        raw = await this.anthropic(image, mime, apiKey, model);
      else raw = await this.tesseract(image);
    } catch (e) {
      this.logger.warn(`Scan ${engine} échoué: ${(e as Error)?.message}`);
      throw new BadRequestException(
        `Échec de l'analyse de l'image (${engine}). Réessayez ou saisissez manuellement.`,
      );
    }

    return { engine, ...this.normalize(raw) };
  }

  // ---------- Normalisation ----------
  private normalize(f: Record<string, unknown>): Omit<ScanResult, 'engine'> {
    const platRaw = String(f?.platform ?? '').toUpperCase();
    const platform =
      platRaw === 'GLOVO' || platRaw === 'YANGO'
        ? (platRaw as 'GLOVO' | 'YANGO')
        : null;

    const phoneDigits = f?.phone ? String(f.phone).replace(/\D/g, '') : '';
    let phone: string | null = null;
    if (phoneDigits.length === 13 && phoneDigits.startsWith('225'))
      phone = phoneDigits.slice(3);
    else if (phoneDigits.length >= 10) phone = phoneDigits.slice(-10);

    const name = f?.name ? String(f.name).trim() : null;
    const order_number = f?.order_number ? String(f.order_number).trim() : null;
    return { platform, name, phone, order_number };
  }

  // ---------- OCR simple (Tesseract) ----------
  private async tesseract(image: Buffer): Promise<Record<string, unknown>> {
    const worker = await createWorker('fra+eng');
    try {
      const { data } = await worker.recognize(image);
      return this.parseText(data.text || '');
    } finally {
      await worker.terminate();
    }
  }

  private parseText(text: string): Record<string, unknown> {
    // Téléphone : suite de chiffres normalisable en 10 (local) ou 13 (225 + 10)
    let phone: string | null = null;
    const runs = text.match(/\d[\d\s.\-]{7,}\d/g) ?? [];
    for (const run of runs) {
      const d = run.replace(/\D/g, '');
      if (d.length === 13 && d.startsWith('225')) {
        phone = d.slice(3);
        break;
      }
      if (d.length === 10) {
        phone = d;
        break;
      }
    }
    // N° commande : suite de chiffres (>=6), éventuellement avec un tiret, != téléphone
    let order: string | null = null;
    for (const o of text.match(/\d{6,}(?:-\d{3,})?/g) ?? []) {
      const od = o.replace(/\D/g, '');
      if (phone && (od === phone || od.endsWith(phone))) continue;
      order = o;
      break;
    }
    // Plateforme : indices textuels (faible)
    let platform: 'GLOVO' | 'YANGO' | null = null;
    if (/yango|pr[ée]paration|N[°o]\s*\d{6}-/i.test(text)) platform = 'YANGO';
    else if (/glovo|enregistrons la commande/i.test(text)) platform = 'GLOVO';

    return { platform, name: null, phone, order_number: order };
  }

  // ---------- IA vision ----------
  private parseJson(text: string): Record<string, unknown> {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    try {
      return JSON.parse(m[0]);
    } catch {
      return {};
    }
  }

  private async gemini(
    image: Buffer,
    mime: string,
    apiKey: string,
    model: string,
  ): Promise<Record<string, unknown>> {
    const m = model || 'gemini-1.5-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: mime, data: image.toString('base64') } },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      },
    );
    const json: any = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return this.parseJson(text);
  }

  private async openai(
    image: Buffer,
    mime: string,
    apiKey: string,
    model: string,
  ): Promise<Record<string, unknown>> {
    const m = model || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: m,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${image.toString('base64')}` },
              },
            ],
          },
        ],
      }),
    });
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    return this.parseJson(text);
  }

  private async anthropic(
    image: Buffer,
    mime: string,
    apiKey: string,
    model: string,
  ): Promise<Record<string, unknown>> {
    const m = model || 'claude-3-5-haiku-latest';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mime,
                  data: image.toString('base64'),
                },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });
    const json: any = await res.json();
    const text = json?.content?.[0]?.text ?? '';
    return this.parseJson(text);
  }
}
