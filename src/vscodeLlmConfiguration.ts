import * as vscode from 'vscode';
import { PROVIDER_REGISTRY } from './llmClient';
import {
    CredentialMigrationReporter,
    LegacyApiKeySource,
    LlmCredentialStore,
    SecretStoragePort
} from './llmCredentialStore';
import {
    LlmConfigurationService,
    LlmSettingsSource
} from './llmConfigurationService';

class VscodeLlmSettingsSource implements LlmSettingsSource {
    public getProvider(): string {
        return vscode.workspace.getConfiguration('heaplens.llm')
            .get<string>('provider', 'anthropic');
    }

    public getBaseUrl(): string {
        return vscode.workspace.getConfiguration('heaplens.llm')
            .get<string>('baseUrl', '');
    }

    public getModel(): string {
        return vscode.workspace.getConfiguration('heaplens.llm')
            .get<string>('model', '');
    }
}

class VscodeLegacyApiKeySource implements LegacyApiKeySource {
    public read(): string | undefined {
        return vscode.workspace.getConfiguration('heaplens.llm')
            .get<string>('apiKey') || undefined;
    }

    public async clear(): Promise<void> {
        const config = vscode.workspace.getConfiguration('heaplens.llm');
        const inspected = config.inspect<string>('apiKey');
        if (!inspected) {
            return;
        }

        // Remove every explicit scope so a lower-precedence plaintext value does
        // not reappear after the effective value is cleared.
        if (inspected.workspaceFolderValue !== undefined) {
            await config.update('apiKey', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        if (inspected.workspaceValue !== undefined) {
            await config.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);
        }
        if (inspected.globalValue !== undefined) {
            await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
        }
    }
}

function providerLabel(provider: string): string {
    return PROVIDER_REGISTRY[provider]?.label || provider;
}

// VS Code's numeric QuickInputButtonLocation.Input value. Assign it without
// referencing the runtime enum so older compatible hosts can safely ignore the
// placement hint instead of failing when that enum is unavailable.
const INPUT_BUTTON_LOCATION = 3;

function secretStorageFor(context: vscode.ExtensionContext): SecretStoragePort {
    const secrets = (context as vscode.ExtensionContext & {
        secrets?: vscode.SecretStorage;
    }).secrets;
    if (secrets) {
        return secrets;
    }

    const unavailable = async (): Promise<never> => {
        throw new Error(
            'This editor does not provide the VS Code SecretStorage API required by HeapLens.'
        );
    };
    return {
        get: unavailable,
        store: unavailable,
        delete: unavailable
    };
}

function visibilityButton(visible: boolean): vscode.QuickInputButton {
    const button: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon(visible ? 'eye-closed' : 'eye'),
        tooltip: visible ? 'Hide API key' : 'Show API key'
    };
    (button as vscode.QuickInputButton & { location?: number }).location =
        INPUT_BUTTON_LOCATION;
    return button;
}

function promptForApiKey(provider: string): Promise<string | undefined> {
    return new Promise(resolve => {
        const input = vscode.window.createInputBox();
        const subscriptions: vscode.Disposable[] = [];
        let settled = false;
        let visible = false;

        const finish = (value: string | undefined): void => {
            if (settled) { return; }
            settled = true;
            input.hide();
            subscriptions.forEach(subscription => subscription.dispose());
            input.dispose();
            resolve(value);
        };

        input.title = `HeapLens: Set API Key for ${providerLabel(provider)}`;
        input.prompt = 'Stored in this editor\'s encrypted SecretStorage and not synced.';
        input.password = true;
        input.ignoreFocusOut = true;
        input.buttons = [visibilityButton(visible)];

        subscriptions.push(
            input.onDidChangeValue(value => {
                input.validationMessage = value.trim()
                    ? undefined
                    : 'API key cannot be empty.';
            }),
            input.onDidTriggerButton(() => {
                visible = !visible;
                input.password = !visible;
                input.buttons = [visibilityButton(visible)];
            }),
            input.onDidAccept(() => {
                if (!input.value.trim()) {
                    input.validationMessage = 'API key cannot be empty.';
                    return;
                }
                finish(input.value);
            }),
            input.onDidHide(() => finish(undefined))
        );

        input.show();
    });
}

export function createVscodeLlmConfiguration(
    context: vscode.ExtensionContext
): LlmConfigurationService {
    let migrationNoticeShown = false;
    let cleanupWarningShown = false;
    const reporter: CredentialMigrationReporter = {
        onMigrated: (provider) => {
            if (migrationNoticeShown) { return; }
            migrationNoticeShown = true;
            const destination = provider ? ` for ${providerLabel(provider)}` : '';
            vscode.window.showInformationMessage(
                `HeapLens moved your LLM API key${destination} to encrypted secret storage.`
            );
        },
        onCleanupFailed: () => {
            if (cleanupWarningShown) { return; }
            cleanupWarningShown = true;
            vscode.window.showWarningMessage(
                'HeapLens stored your LLM API key securely, but could not remove the old ' +
                'heaplens.llm.apiKey setting. Remove that setting manually.'
            );
        }
    };

    const credentials = new LlmCredentialStore(
        secretStorageFor(context),
        new VscodeLegacyApiKeySource(),
        reporter
    );
    return new LlmConfigurationService(new VscodeLlmSettingsSource(), credentials);
}

export function registerLlmCredentialCommands(
    context: vscode.ExtensionContext,
    configuration: LlmConfigurationService
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('heaplens.setLlmApiKey', async () => {
            const provider = configuration.getCurrentProvider();
            if (provider === 'ollama') {
                vscode.window.showInformationMessage('HeapLens: Ollama does not require an API key.');
                return;
            }

            const value = await promptForApiKey(provider);
            if (value === undefined) { return; }

            try {
                await configuration.setApiKeyForCurrentProvider(value);
                const status = await configuration.getApiKeyStatusForCurrentProvider();
                vscode.window.showInformationMessage(
                    `HeapLens: API key for ${providerLabel(provider)} stored securely ` +
                    `(${status.maskedValue || 'configured'}).`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`HeapLens: Could not store API key: ${message}`);
            }
        }),
        vscode.commands.registerCommand('heaplens.clearLlmApiKey', async () => {
            const provider = configuration.getCurrentProvider();
            try {
                await configuration.clearApiKeyForCurrentProvider();
                vscode.window.showInformationMessage(
                    `HeapLens: API key for ${providerLabel(provider)} removed.`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`HeapLens: Could not remove API key: ${message}`);
            }
        }),
        vscode.commands.registerCommand('heaplens.showLlmApiKeyStatus', async () => {
            const provider = configuration.getCurrentProvider();
            if (provider === 'ollama') {
                vscode.window.showInformationMessage('HeapLens: Ollama does not require an API key.');
                return;
            }

            try {
                const status = await configuration.getApiKeyStatusForCurrentProvider();
                if (!status.configured) {
                    const action = await vscode.window.showInformationMessage(
                        `HeapLens: No API key is configured for ${providerLabel(provider)}.`,
                        'Set API Key'
                    );
                    if (action === 'Set API Key') {
                        await vscode.commands.executeCommand('heaplens.setLlmApiKey');
                    }
                    return;
                }

                const action = await vscode.window.showInformationMessage(
                    `HeapLens: ${providerLabel(provider)} API key is configured ` +
                    `(${status.maskedValue || 'stored securely'}).`,
                    'Replace',
                    'Clear'
                );
                if (action === 'Replace') {
                    await vscode.commands.executeCommand('heaplens.setLlmApiKey');
                } else if (action === 'Clear') {
                    await vscode.commands.executeCommand('heaplens.clearLlmApiKey');
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`HeapLens: Could not read API key status: ${message}`);
            }
        })
    );
}
