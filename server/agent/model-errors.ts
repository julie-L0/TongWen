import { AppError } from '../domain/rules.ts';
import type { Usage } from './types.ts';

export class ModelResponseError extends AppError {
  readonly usage: Usage;
  constructor(code: string, message: string, usage: Usage) {
    super(code, message, 502);
    this.usage = usage;
  }
}
