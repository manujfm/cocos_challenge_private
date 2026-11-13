import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { BusinessError, ErrorCode } from '../../domain/model';
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof ZodError)
      return response.status(400).json({ code: ErrorCode.INVALID_REQUEST, issues: error.issues });
    if (error instanceof BusinessError)
      return response.status(error.status).json({ code: error.code, message: error.message });
    if (error instanceof HttpException)
      return response.status(error.getStatus()).json(error.getResponse());
    const pgCode = (error as { code?: string })?.code;
    if (
      pgCode &&
      [
        '55P03',
        '57014',
        '40P01',
        '40001',
        '53300',
        '08006',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
      ].includes(pgCode)
    ) {
      return response
        .status(503)
        .json({
          code: ErrorCode.TEMPORARILY_UNAVAILABLE,
          message: 'Retry with the same Idempotency-Key',
        });
    }
    // Do not log connection strings, SQL parameters, or raw driver errors.
    this.logger.error('Unhandled request failure');
    return response
      .status(500)
      .json({ code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' });
  }
}
