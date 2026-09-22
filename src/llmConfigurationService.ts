import type { LlmConfig } from './llmClient';
import { LlmCredentialStatus, LlmCredentialStore } from './llmCredentialStore';

/** Non-secret LLM settings that remain in ordinary VS Code configuration. */
export interface LlmSettingsSource {
    getProvider(): string;
    getBaseUrl(): string;
    getModel(): string;
}

/** Combines public provider settings with credentials at the use boundary. */
export class LlmConfigurationService {
    constructor(
        private readonly settings: LlmSettingsSource,
        private readonly credentials: LlmCredentialStore
    ) {}

    public getCurrentProvider(): string {
        return this.settings.getProvider() || 'anthropic';
    }

    public async getConfig(): Promise<LlmConfig> {
        const provider = this.getCurrentProvider();
        return {
            provider,
            apiKey: await this.credentials.getApiKey(provider),
            baseUrl: this.settings.getBaseUrl() || undefined,
            model: this.settings.getModel() || undefined
        };
    }

    public async migrateLegacyApiKey(): Promise<void> {
        await this.credentials.migrateLegacyApiKey(this.getCurrentProvider());
    }

    public async setApiKeyForCurrentProvider(value: string): Promise<void> {
        await this.credentials.setApiKey(this.getCurrentProvider(), value);
    }

    public async getApiKeyStatusForCurrentProvider(): Promise<LlmCredentialStatus> {
        return this.credentials.getApiKeyStatus(this.getCurrentProvider());
    }

    public async clearApiKeyForCurrentProvider(): Promise<void> {
        await this.credentials.clearApiKey(this.getCurrentProvider());
    }
}
