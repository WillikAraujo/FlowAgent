import type { AgentProviderAdapter } from '../../domain/agent-provider.ts';
import { ProviderOperationError } from '../../domain/agent-provider.ts';

/** The sole place where provider adapters are registered and selected. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, AgentProviderAdapter>();

  register(adapter: AgentProviderAdapter): void {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(adapter.providerId)) {
      throw new ProviderOperationError('failed', 'Provider ID is invalid.');
    }
    if (this.adapters.has(adapter.providerId)) {
      throw new ProviderOperationError('failed', `Provider '${adapter.providerId}' is already registered.`);
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): AgentProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new ProviderOperationError('unsupported', `Provider '${providerId}' is not registered.`);
    return adapter;
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
