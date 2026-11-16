import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { normalizePayload } from '../../common/guards/optional-jwt.guard';

type HandshakeLike = {
  handshake: {
    auth?: Record<string, unknown> | null;
    query?: Record<string, unknown> | null;
    headers?: Record<string, unknown> | null;
  };
};

export function extractSocketToken(client: HandshakeLike): string {
  const auth = client.handshake.auth ?? {};
  const query = client.handshake.query ?? {};
  const headers = client.handshake.headers ?? {};
  const header = headers.authorization;
  const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
  const queryToken = query.token ?? query.access_token;
  const queryValue = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  return String(auth.token ?? auth.access_token ?? queryValue ?? bearer ?? '').trim();
}

/**
 * A claimed user id is accepted only when it is the same account as the verified token.
 * Missing or mismatched claims do not grant another user's identity.
 */
export function resolveVerifiedUserId(
  verifiedUserId: string | null | undefined,
  claimedUserId?: string | null,
): string | null {
  const verified = String(verifiedUserId ?? '').trim();
  if (!verified) return null;
  const claimed = String(claimedUserId ?? '').trim();
  if (claimed && claimed.toLowerCase() !== verified.toLowerCase()) return null;
  return verified;
}

@Injectable()
export class SocketIdentity {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async userId(client: Socket, claimedUserId?: string | null): Promise<string | null> {
    const token = extractSocketToken(client);
    if (!token) return null;
    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER', 'Shuttlez'),
        audience: this.config.get<string>('JWT_AUDIENCE', 'ShuttlezApp'),
        clockTolerance: 60,
      });
      const normalized = normalizePayload(payload);
      return resolveVerifiedUserId(
        typeof normalized.userId === 'string' ? normalized.userId : null,
        claimedUserId,
      );
    } catch {
      return null;
    }
  }
}
