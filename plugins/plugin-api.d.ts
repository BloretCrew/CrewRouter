export type PluginTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PluginTaskRecord<Result extends Record<string, unknown> = Record<string, unknown>> {
  id: number;
  task_name: string;
  status: PluginTaskStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  result?: Result | null;
  last_error?: string | null;
}

export interface PluginEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: 1;
  event: 'plugin.lifecycle.v1' | 'model.health.changed.v1' | 'quota.threshold.v1';
  occurredAt: string;
  payload: Readonly<T>;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly log: {
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
  };
  on(name: string, handler: (payload: Record<string, unknown>, meta: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>, priority?: number): void;
  tasks?: {
    register(name: string, handler: (payload: Record<string, unknown>, meta: { taskId: number; attempt: number; signal: AbortSignal }) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>): void;
    enqueue(name: string, payload: Record<string, unknown>, options: { idempotencyKey: string; maxAttempts?: number }): Promise<PluginTaskRecord>;
    get(taskId: number | string): Promise<PluginTaskRecord | null>;
    cancel(taskId: number | string): Promise<{ id: number; status: 'cancelled' } | null>;
  };
  events?: {
    on(event: PluginEvent['event'], handler: (event: PluginEvent) => void | Promise<void>): void;
  };
  expose?(method: string, path: string, handler: (req: Record<string, any>, res: Record<string, any>) => void | Promise<void>): void;
}

export type PluginFactory = (ctx: PluginContext) => void | Promise<void>;
