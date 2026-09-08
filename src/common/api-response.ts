export class ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  code?: string;
  errors: string[];

  private constructor(init: {
    success: boolean;
    data?: T;
    message?: string;
    code?: string;
    errors?: string[];
  }) {
    this.success = init.success;
    this.data = init.data;
    this.message = init.message;
    this.code = init.code;
    this.errors = init.errors ?? [];
  }

  static ok<T>(data?: T, message?: string, code?: string): ApiResponse<T> {
    return new ApiResponse<T>({
      success: true,
      data,
      message,
      code,
    });
  }

  static fail(message: string, code?: string, errors?: string[]): ApiResponse<never> {
    return new ApiResponse<never>({
      success: false,
      message,
      code,
      errors: errors && errors.length > 0 ? errors : [message],
    });
  }
}
