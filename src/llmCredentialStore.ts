/** Minimal boundary implemented by VS Code's platform-specific SecretStorage. */
export interface SecretStoragePort {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}

/** Reads and removes the pre-v1.0.29 plaintext configuration value. */
export interface LegacyApiKeySource {
    read(): string | undefined;
    clear(): PromiseLike<void>;
}

export interface CredentialMigrationReporter {
    onMigrated?(provider: string | undefined): void;
    onCleanupFailed?(provider: string | undefined, error: Error): void;
}

/** A display-safe summary. It never contains the complete stored credential. */
export interface LlmCredentialStatus {
    configured: boolean;
    maskedValue?: string;
}

const SECRET_PREFIX = 'heaplens.llm.credential.';
const UNASSIGNED_LEGACY_KEY = `${SECRET_PREFIX}legacy`;

function providerSecretKey(provider: string): string {
    return `${SECRET_PREFIX}${encodeURIComponent(provider)}`;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function maskApiKey(value: string): string {
    if (value.length <= 4) {
        return '•'.repeat(value.length);
    }
    return `••••${value.slice(-4)}`;
}

/**
 * Owns LLM credentials and the one-time migration out of ordinary settings.
 * It deliberately has no dependency on UI, HTTP transport, or prompt building.
 */
export class LlmCredentialStore {
    private migrationInFlight: Promise<void> | null = null;

    constructor(
        private readonly secrets: SecretStoragePort,
        private readonly legacy: LegacyApiKeySource,
        private readonly reporter: CredentialMigrationReporter = {}
    ) {}

    public async getApiKey(provider: string): Promise<string> {
        await this.migrateLegacyApiKey(provider);

        if (provider === 'ollama') {
            return '';
        }

        const providerKey = providerSecretKey(provider);
        const existing = await this.secrets.get(providerKey);
        if (existing !== undefined) {
            return existing;
        }

        // If the legacy setting was found while Ollama was selected, preserve it
        // securely until the user next selects a provider that needs a key.
        const unassigned = await this.secrets.get(UNASSIGNED_LEGACY_KEY);
        if (unassigned === undefined) {
            return '';
        }

        await this.secrets.store(providerKey, unassigned);
        await this.secrets.delete(UNASSIGNED_LEGACY_KEY);
        return unassigned;
    }

    public async setApiKey(provider: string, value: string): Promise<void> {
        const normalized = value.trim();
        if (!normalized) {
            throw new Error('API key cannot be empty.');
        }
        if (provider === 'ollama') {
            throw new Error('Ollama does not require an API key.');
        }
        await this.secrets.store(providerSecretKey(provider), normalized);
    }

    public async getApiKeyStatus(provider: string): Promise<LlmCredentialStatus> {
        const value = await this.getApiKey(provider);
        if (!value) {
            return { configured: false };
        }
        return {
            configured: true,
            maskedValue: maskApiKey(value)
        };
    }

    public async clearApiKey(provider: string): Promise<void> {
        await this.secrets.delete(providerSecretKey(provider));
        // Clearing a provider key also clears an unassigned migrated key so the
        // command has the unsurprising meaning "no credential remains to use".
        await this.secrets.delete(UNASSIGNED_LEGACY_KEY);
    }

    public async migrateLegacyApiKey(provider: string): Promise<void> {
        if (!this.migrationInFlight) {
            this.migrationInFlight = this.performLegacyMigration(provider)
                .finally(() => { this.migrationInFlight = null; });
        }
        await this.migrationInFlight;
    }

    private async performLegacyMigration(provider: string): Promise<void> {
        const legacyValue = this.legacy.read();
        if (!legacyValue) {
            return;
        }

        const assignedProvider = provider === 'ollama' ? undefined : provider;
        const targetKey = assignedProvider
            ? providerSecretKey(assignedProvider)
            : UNASSIGNED_LEGACY_KEY;
        const existing = await this.secrets.get(targetKey);

        if (existing === undefined) {
            // Never remove the plaintext value unless encrypted storage succeeds.
            await this.secrets.store(targetKey, legacyValue);
        } else if (existing !== legacyValue) {
            // Preserve a different legacy value instead of silently overwriting
            // either credential. It can be assigned on the next provider switch.
            await this.secrets.store(UNASSIGNED_LEGACY_KEY, legacyValue);
        }

        try {
            await this.legacy.clear();
            this.reporter.onMigrated?.(assignedProvider);
        } catch (error) {
            // The credential is already safe in SecretStorage. Keep using it and
            // report that the old plaintext setting still needs manual cleanup.
            this.reporter.onCleanupFailed?.(assignedProvider, asError(error));
        }
    }
}
