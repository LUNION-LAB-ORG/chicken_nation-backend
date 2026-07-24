import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService, AuditEntry } from './audit.service';

/** Clés dont la valeur ne doit JAMAIS être journalisée (secrets / PII sensible). */
const REDACT_KEYS = new Set(
  [
    'password',
    'current_password',
    'currentpassword',
    'new_password',
    'newpassword',
    'old_password',
    'token',
    'refreshtoken',
    'refresh_token',
    'accesstoken',
    'access_token',
    'secret',
    'apikey',
    'api_key',
    'authorization',
    'x-api-key',
    'otp',
    'code_otp',
    'pin',
  ].map((k) => k.toLowerCase()),
);

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_MAX = 4000;

/**
 * Journalise automatiquement les actions du PERSONNEL dans `audit_logs`.
 *
 * Politique (pour rester utile sans noyer la table) :
 *  - staff (req.user porteur d'un `role`) : toutes ses MUTATIONS
 *    (POST/PUT/PATCH/DELETE) + toute requête qu'il termine en erreur (>=400) ;
 *  - n'importe qui : les erreurs SERVEUR (>=500), utiles au débogage.
 * Les GET réussis du public/clients ne sont PAS journalisés (bruit).
 *
 * Écriture fire-and-forget via AuditService → aucune latence ajoutée, aucune
 * requête cassée si l'audit échoue.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const started = Date.now();

    const finalize = (statusOverride?: number) => {
      try {
        this.persist(req, statusOverride ?? res?.statusCode, started);
      } catch {
        /* l'audit ne casse jamais la requête */
      }
    };

    return next.handle().pipe(
      tap({
        next: () => finalize(),
        // Erreur : on capte le status porté par l'exception puis on laisse
        // remonter (on ne modifie pas le flux).
        error: (err) => finalize(err?.status ?? err?.statusCode ?? 500),
      }),
    );
  }

  private persist(req: any, status: number | undefined, started: number) {
    const method: string = (req.method || 'GET').toUpperCase();
    const isMutation = MUTATIONS.has(method);
    const isError = typeof status === 'number' && status >= 400;
    const isServerError = typeof status === 'number' && status >= 500;

    // Staff = un User (porte un `role`) ; un Customer n'en a pas.
    const user = req.user;
    const isStaff = !!user && typeof user === 'object' && 'role' in user && !!user.role;

    // Filtre : staff (mutation ou erreur) OU erreur serveur pour tous.
    if (!((isStaff && (isMutation || isError)) || isServerError)) return;

    const path: string = (req.originalUrl || req.url || '').split('?')[0];
    const segments = this.pathSegments(path);
    const module = segments[0] ?? null;
    const entity_id = segments.find((s) => UUID_RE.test(s)) ?? null;

    const entry: AuditEntry = {
      actor_id: isStaff ? (user.id ?? null) : null,
      actor_name: isStaff ? (user.fullname ?? user.email ?? null) : null,
      actor_role: isStaff ? (user.role ?? null) : null,
      restaurant_id: isStaff ? (user.restaurant_id ?? null) : null,
      action: this.deriveAction(method, path),
      module,
      entity_id,
      method,
      path,
      status_code: status ?? null,
      duration_ms: Date.now() - started,
      ip: this.clientIp(req),
      user_agent: req.headers?.['user-agent'] ?? null,
      summary: this.summary(method, module, entity_id, status),
      metadata: this.buildMetadata(req),
    };

    this.audit.record(entry);
  }

  private pathSegments(path: string): string[] {
    // Retire le préfixe global /api/v1 pour que le module soit le vrai 1er segment.
    return path
      .replace(/^\/api\/v\d+\//, '')
      .split('/')
      .filter(Boolean);
  }

  private deriveAction(method: string, path: string): string {
    if (/\b(login|auth|verify-otp|refresh)\b/i.test(path) && method === 'POST') return 'LOGIN';
    switch (method) {
      case 'POST':
        return 'CREATE';
      case 'PUT':
      case 'PATCH':
        return 'UPDATE';
      case 'DELETE':
        return 'DELETE';
      case 'GET':
        return 'READ';
      default:
        return 'OTHER';
    }
  }

  private summary(
    method: string,
    module: string | null,
    entityId: string | null,
    status: number | undefined,
  ): string {
    const verb = this.deriveAction(method, module ?? '');
    const target = module ? ` ${module}` : '';
    const id = entityId ? ` #${entityId.slice(0, 8)}` : '';
    const err = typeof status === 'number' && status >= 400 ? ` — échec (${status})` : '';
    return `${verb}${target}${id}${err}`;
  }

  private clientIp(req: any): string | null {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || null;
  }

  /** Snapshot { body, query } redacté + tronqué (jamais de secret, jamais énorme). */
  private buildMetadata(req: any) {
    const meta: Record<string, unknown> = {};
    const body = this.redact(req.body);
    const query = this.redact(req.query);
    if (body && Object.keys(body).length) meta.body = body;
    if (query && Object.keys(query).length) meta.query = query;

    let json = JSON.stringify(meta);
    if (json.length > META_MAX) json = json.slice(0, META_MAX) + '…';
    try {
      return JSON.parse(json.endsWith('…') ? json.slice(0, -1) : json);
    } catch {
      return { truncated: true } as Record<string, unknown>;
    }
  }

  private redact(value: any, depth = 0): any {
    if (value == null || depth > 4) return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.redact(v, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (REDACT_KEYS.has(k.toLowerCase())) out[k] = '***';
        else if (typeof v === 'string' && v.length > 500) out[k] = v.slice(0, 500) + '…';
        else out[k] = this.redact(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}
