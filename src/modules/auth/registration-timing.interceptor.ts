import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { finalize, Observable } from 'rxjs';
import {
  monotonicNow,
  recordPerformanceDiagnostic,
} from '../../common/performance-diagnostics';

@Injectable()
export class RegistrationTimingInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = monotonicNow();
    return next.handle().pipe(
      finalize(() => {
        recordPerformanceDiagnostic('registration.route_pipeline', {
          durationMs: monotonicNow() - startedAt,
        });
      }),
    );
  }
}
