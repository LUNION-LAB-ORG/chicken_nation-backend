import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggerInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    const { method, url, body, query, headers } = request;
    const ip = request.ip || request.connection.remoteAddress;
    const userAgent = headers['user-agent'] || 'unknown';
    const now = Date.now();

    this.logger.log(
      `Request | ${method} ${url} | IP: ${ip} | UA: ${userAgent} | Body: ${JSON.stringify(body)} | Query: ${JSON.stringify(query)}`
    );

    return next.handle().pipe(
      tap(() => {
        const responseTime = Date.now() - now;
        this.logger.log(
          `Response | ${method} ${url} | ${responseTime}ms | IP: ${ip} | UA: ${userAgent}`
        );
      })
    );
  }
}
