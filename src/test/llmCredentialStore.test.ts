import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    LlmCredentialStore,
    LegacyApiKeySource,
    SecretStoragePort
} from '../llmCredentialStore';
import {
    LlmConfigurationService,
    LlmSettingsSource
} from '../llmConfigurationService';

class FakeSecrets implements SecretStoragePort {
    public readonly values = new Map<string, string>();
    public readonly stores: Array<{ key: string; value: string }> = [];
    public readonly deletes: string[] = [];
    public storeError: Error | null = null;

    public async get(key: string): Promise<string | undefined> {
        return this.values.get(key);
    }

    public async store(key: string, value: string): Promise<void> {
        if (this.storeError) {
            throw this.storeError;
        }
        this.stores.push({ key, value });
        this.values.set(key, value);
    }

    public async delete(key: string): Promise<void> {
        this.deletes.push(key);
        this.values.delete(key);
    }
}

class FakeLegacySource implements LegacyApiKeySource {
    public clearCount = 0;
    public clearError: Error | null = null;

    constructor(public value: string | undefined) {}

    public read(): string | undefined {
        return this.value;
    }

    public async clear(): Promise<void> {
        this.clearCount++;
        if (this.clearError) {
            throw this.clearError;
        }
        this.value = undefined;
    }
}

class FakeSettings implements LlmSettingsSource {
    constructor(
        public provider = 'anthropic',
        public baseUrl = '',
        public model = ''
    ) {}

    public getProvider(): string { return this.provider; }
    public getBaseUrl(): string { return this.baseUrl; }
    public getModel(): string { return this.model; }
}

test('stores separate API keys for each provider', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));

    await store.setApiKey('anthropic', 'anthropic-secret');
    await store.setApiKey('openai', 'openai-secret');

    assert.equal(await store.getApiKey('anthropic'), 'anthropic-secret');
    assert.equal(await store.getApiKey('openai'), 'openai-secret');
    assert.notEqual(secrets.stores[0].key, secrets.stores[1].key);
});

test('rejects empty credentials and trims accidental surrounding whitespace', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));

    await assert.rejects(store.setApiKey('anthropic', '   '), /cannot be empty/);
    await store.setApiKey('anthropic', '  secret-without-whitespace  ');
    assert.equal(await store.getApiKey('anthropic'), 'secret-without-whitespace');
});

test('generated provider identifiers remain isolated in secure storage', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));

    for (let index = 0; index < 32; index++) {
        const provider = `provider/${index}?variant=${index % 3}`;
        await store.setApiKey(provider, `secret-${index}`);
    }

    for (let index = 0; index < 32; index++) {
        const provider = `provider/${index}?variant=${index % 3}`;
        assert.equal(await store.getApiKey(provider), `secret-${index}`);
    }
    assert.equal(new Set(secrets.stores.map(entry => entry.key)).size, 32);
});

test('migrates a plaintext legacy key and clears it only after secure storage succeeds', async () => {
    const secrets = new FakeSecrets();
    const legacy = new FakeLegacySource('legacy-secret');
    const store = new LlmCredentialStore(secrets, legacy);

    assert.equal(await store.getApiKey('anthropic'), 'legacy-secret');
    assert.equal(legacy.clearCount, 1);
    assert.equal(legacy.value, undefined);
    assert.equal(await store.getApiKey('anthropic'), 'legacy-secret');
    assert.equal(secrets.stores.length, 1);
});

test('does not delete the plaintext key when secure storage fails', async () => {
    const secrets = new FakeSecrets();
    secrets.storeError = new Error('secure storage unavailable');
    const legacy = new FakeLegacySource('legacy-secret');
    const store = new LlmCredentialStore(secrets, legacy);

    await assert.rejects(store.getApiKey('anthropic'), /secure storage unavailable/);
    assert.equal(legacy.clearCount, 0);
    assert.equal(legacy.value, 'legacy-secret');
});

test('preserves a migrated secret when legacy settings cleanup fails', async () => {
    const secrets = new FakeSecrets();
    const legacy = new FakeLegacySource('legacy-secret');
    legacy.clearError = new Error('settings are read-only');
    const cleanupFailures: string[] = [];
    const store = new LlmCredentialStore(secrets, legacy, {
        onCleanupFailed: (_provider, error) => cleanupFailures.push(error.message)
    });

    assert.equal(await store.getApiKey('anthropic'), 'legacy-secret');
    assert.equal(cleanupFailures.length, 1);
    assert.equal(await store.getApiKey('anthropic'), 'legacy-secret');
    assert.equal(secrets.stores.length, 1);
});

test('safely holds an unassigned legacy key selected under Ollama and assigns it later', async () => {
    const secrets = new FakeSecrets();
    const legacy = new FakeLegacySource('legacy-secret');
    const store = new LlmCredentialStore(secrets, legacy);

    await store.migrateLegacyApiKey('ollama');
    assert.equal(legacy.value, undefined);
    assert.equal(await store.getApiKey('ollama'), '');
    assert.equal(await store.getApiKey('openai'), 'legacy-secret');
    assert.equal(await store.getApiKey('anthropic'), '');
});

test('concurrent migration stores and clears a legacy key once', async () => {
    const secrets = new FakeSecrets();
    const legacy = new FakeLegacySource('legacy-secret');
    const store = new LlmCredentialStore(secrets, legacy);

    const [first, second] = await Promise.all([
        store.getApiKey('anthropic'),
        store.getApiKey('anthropic')
    ]);

    assert.equal(first, 'legacy-secret');
    assert.equal(second, 'legacy-secret');
    assert.equal(secrets.stores.length, 1);
    assert.equal(legacy.clearCount, 1);
});

test('configuration service combines non-secret settings with secure credentials', async () => {
    const secrets = new FakeSecrets();
    const credentials = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));
    const settings = new FakeSettings('openai', 'https://proxy.example.test', 'custom-model');
    const service = new LlmConfigurationService(settings, credentials);
    await service.setApiKeyForCurrentProvider('openai-secret');

    assert.deepEqual(await service.getConfig(), {
        provider: 'openai',
        apiKey: 'openai-secret',
        baseUrl: 'https://proxy.example.test',
        model: 'custom-model'
    });

    await service.clearApiKeyForCurrentProvider();
    assert.equal((await service.getConfig()).apiKey, '');
});

test('Ollama configuration never requires or returns an API key', async () => {
    const secrets = new FakeSecrets();
    const credentials = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));
    const service = new LlmConfigurationService(new FakeSettings('ollama'), credentials);

    assert.deepEqual(await service.getConfig(), {
        provider: 'ollama',
        apiKey: '',
        baseUrl: undefined,
        model: undefined
    });
    assert.equal(secrets.stores.length, 0);
});

test('clearing one provider does not remove another provider credential', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));
    await store.setApiKey('anthropic', 'anthropic-secret');
    await store.setApiKey('openai', 'openai-secret');

    await store.clearApiKey('anthropic');

    assert.equal(await store.getApiKey('anthropic'), '');
    assert.equal(await store.getApiKey('openai'), 'openai-secret');
});

test('credential status exposes only a fixed mask and the final four characters', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));

    await store.setApiKey('openai', 'sk-example-secret-7Kp2');

    assert.deepEqual(await store.getApiKeyStatus('openai'), {
        configured: true,
        maskedValue: '••••7Kp2'
    });
    assert.equal(JSON.stringify(await store.getApiKeyStatus('openai')).includes('example-secret'), false);
});

test('credential status completely masks short values and reports missing keys', async () => {
    const secrets = new FakeSecrets();
    const store = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));

    await store.setApiKey('openai', 'aa');

    assert.deepEqual(await store.getApiKeyStatus('openai'), {
        configured: true,
        maskedValue: '••'
    });
    assert.deepEqual(await store.getApiKeyStatus('anthropic'), { configured: false });
    assert.deepEqual(await store.getApiKeyStatus('ollama'), { configured: false });
});

test('configuration service reports status for the selected provider only', async () => {
    const secrets = new FakeSecrets();
    const credentials = new LlmCredentialStore(secrets, new FakeLegacySource(undefined));
    const settings = new FakeSettings('openai');
    const service = new LlmConfigurationService(settings, credentials);
    await credentials.setApiKey('anthropic', 'anthropic-secret');

    assert.deepEqual(await service.getApiKeyStatusForCurrentProvider(), { configured: false });

    await service.setApiKeyForCurrentProvider('openai-secret-1234');
    assert.deepEqual(await service.getApiKeyStatusForCurrentProvider(), {
        configured: true,
        maskedValue: '••••1234'
    });
});
