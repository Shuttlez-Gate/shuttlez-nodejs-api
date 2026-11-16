import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception';

@Injectable()
export class AuthRateLimiter {
  private readonly hits = new Map<string, number[]>();

  hit(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      throw new AppException(
        'محاولات كثيرة. حاول بعد قليل',
        429,
        'RATE_LIMITED',
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [entry, times] of this.hits) {
        if (times.every((at) => now - at >= windowMs)) {
          this.hits.delete(entry);
        }
      }
    }
  }
}
