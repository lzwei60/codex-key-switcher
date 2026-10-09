import type { ProviderService } from '@codex-key-switcher/core';
import type { Provider, ProviderInput, RouteSettings } from '@codex-key-switcher/shared';

export interface ProviderApplicationPorts {
  providers: ProviderService;
  routeSettings(): Promise<RouteSettings>;
  syncCodex(): Promise<void>;
  refreshStatus(): Promise<void>;
  stopGateway(): Promise<void>;
  validateInput(input: ProviderInput): void;
  assertSaveSupportsMode(input: ProviderInput, providers: Provider[]): Promise<void>;
  assertDirectProvider(provider: Provider): Promise<void>;
  notifyFirstProvider(hadProviders: boolean): Promise<void>;
  notifySwitch(input: {
    previousProvider?: Provider | null;
    nextProvider?: Provider | null;
    switchedTarget: 'provider' | 'model';
  }): Promise<void>;
}

// Provider transactions live here; the desktop shell supplies platform effects.
export class ProviderApplicationService {
  constructor(private readonly ports: ProviderApplicationPorts) {}

  async save(input: ProviderInput): Promise<Provider> {
    const { providers } = this.ports;
    this.ports.validateInput(input);
    const existing = await providers.list();
    await this.ports.assertSaveSupportsMode(input, existing);
    const previous = input.id?.trim()
      ? existing.find((provider) => provider.id === input.id?.trim()) ?? null
      : null;
    const previousApiKey = previous ? await providers.currentApiKey(previous) : null;
    const provider = await providers.upsert(input);
    try {
      await this.ports.syncCodex();
      await this.ports.notifyFirstProvider(existing.length > 0);
      return provider;
    } catch (error) {
      if (previous) await providers.restore(previous, previousApiKey).catch(() => undefined);
      else await providers.delete(provider.id).catch(() => undefined);
      await this.ports.syncCodex().catch(() => undefined);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.ports.providers.delete(id);
    if (!(await this.ports.providers.list()).length) await this.ports.stopGateway();
    else await this.ports.syncCodex();
  }

  async switchProvider(providerId: string): Promise<void> {
    const { providers } = this.ports;
    const previousProvider = await providers.current();
    const settings = await this.ports.routeSettings();
    const nextProvider = (await providers.list()).find((provider) => provider.id === providerId);
    if (!nextProvider) throw new Error('配置不存在。');
    if (settings.enabled && settings.mode === 'direct_provider') {
      await this.ports.assertDirectProvider(nextProvider);
    }

    await providers.setCurrent(providerId);
    try {
      await this.ports.syncCodex();
      await this.ports.refreshStatus();
      await this.ports.notifySwitch({ previousProvider, nextProvider, switchedTarget: 'provider' });
    } catch (error) {
      if (previousProvider) await providers.setCurrent(previousProvider.id).catch(() => undefined);
      await this.ports.syncCodex().catch(() => undefined);
      await this.ports.refreshStatus().catch(() => undefined);
      throw error;
    }
  }

  async switchModel(providerId: string, model: string): Promise<void> {
    const { providers } = this.ports;
    const previousProvider = (await providers.list()).find((provider) => provider.id === providerId);
    if (!previousProvider) throw new Error('配置不存在。');
    const settings = await this.ports.routeSettings();

    await providers.setSelectedModel(providerId, model);
    try {
      const nextProvider = (await providers.list()).find((provider) => provider.id === providerId);
      if (!nextProvider) throw new Error('配置不存在。');
      if (settings.enabled && settings.mode === 'direct_provider') {
        await this.ports.assertDirectProvider(nextProvider);
      }
      await this.ports.syncCodex();
      await this.ports.refreshStatus();
      await this.ports.notifySwitch({ previousProvider, nextProvider, switchedTarget: 'model' });
    } catch (error) {
      await providers.setSelectedModel(providerId, previousProvider.selectedModel).catch(() => undefined);
      await this.ports.syncCodex().catch(() => undefined);
      await this.ports.refreshStatus().catch(() => undefined);
      throw error;
    }
  }
}
