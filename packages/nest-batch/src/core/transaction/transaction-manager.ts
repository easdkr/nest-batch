export interface TransactionContext {
  readonly isActive: true;
  readonly id: string;
}

export abstract class TransactionManager {
  abstract withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
