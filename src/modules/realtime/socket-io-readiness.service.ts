import { Injectable } from '@nestjs/common';

@Injectable()
export class SocketIoReadinessService {
  private redisRequired = false;
  private redisConfigured = false;
  private redisReady = false;
  private configured = false;

  configure(redisRequired: boolean, redisConfigured: boolean): void {
    this.redisRequired = redisRequired;
    this.redisConfigured = redisConfigured;
    this.configured = true;
  }

  setRedisReady(ready: boolean): void {
    this.redisReady = ready;
  }

  get isReady(): boolean {
    return this.configured && (!this.redisRequired && !this.redisConfigured || this.redisReady);
  }

  get status(): 'ready' | 'degraded' {
    return this.isReady ? 'ready' : 'degraded';
  }
}
