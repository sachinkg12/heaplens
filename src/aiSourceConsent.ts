import * as vscode from 'vscode';
import { LlmConfig, PROVIDER_REGISTRY } from './llmClient';

/** Per-request source-sharing boundary. Provider definitions, not provider-specific branches,
 * determine the destination. A local endpoint is not a promise about downstream forwarding.
 */
export async function confirmAiSourceSharing(config: LlmConfig, sourceUri: vscode.Uri): Promise<boolean> {
    const provider = PROVIDER_REGISTRY[config.provider || 'anthropic'];
    if (!provider) { throw new Error('AI Fix: unsupported provider. Check the LLM endpoint settings.'); }

    let endpoint: URL;
    try {
        endpoint = new URL(config.baseUrl || provider.defaultBaseUrl);
        if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
            throw new Error('Unsafe endpoint');
        }
    } catch {
        // Never echo a malformed URL: it may contain a credential.
        throw new Error('AI Fix: invalid endpoint. Use an HTTP(S) base URL without credentials, query parameters, or fragments.');
    }

    const fileName = sourceUri.fsPath.split(/[\\/]/).pop() || 'the resolved source file';
    const choice = await vscode.window.showWarningMessage(
        `Send the entire source file ${fileName} for an AI fix?`,
        {
            modal: true,
            detail: `Destination: ${endpoint.origin} (${provider.label.replace(' (Local)', '')}).\n\n` +
                'This sends the full source file, including comments and any embedded secrets, plus heap metadata (class/field names, sizes and leak descriptions). ' +
                'The local file path is not added to the prompt. Source contents are not redacted and may themselves contain paths or credentials.\n\n' +
                'Only send code you are authorized to share. Review the file first if unsure. ' +
                'A local endpoint or proxy may forward requests elsewhere. Cancel sends nothing.'
        },
        'Send Source',
        'Review Source'
    );
    if (choice === 'Review Source') { await vscode.window.showTextDocument(sourceUri); }
    return choice === 'Send Source';
}
