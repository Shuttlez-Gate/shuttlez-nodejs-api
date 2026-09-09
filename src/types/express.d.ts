export {};

declare global {
  namespace Express {
    interface Request {
      jwtAuthFailed?: boolean;
    }
  }
}
