export class AppException extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.name = 'AppException';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundException extends AppException {
  constructor(message: string, code?: string) {
    super(message, 404, code);
    this.name = 'NotFoundException';
  }
}

export class UnauthorizedAppException extends AppException {
  constructor(message: string, code?: string) {
    super(message, 401, code);
    this.name = 'UnauthorizedAppException';
  }
}

export class ForbiddenAppException extends AppException {
  constructor(message: string, code?: string) {
    super(message, 403, code);
    this.name = 'ForbiddenAppException';
  }
}
