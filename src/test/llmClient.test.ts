import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ChatMessage, streamLlmResponse } from '../llmClient';

const TEST_MESSAGES: ChatMessage[] = [
    { role: 'user', content: 'test request' }
];

async function withErrorServer(
    statusCode: number,
    responseBody: string,
    run: (baseUrl: string) => Promise<void>
): Promise<void> {
    const server = http.createServer((_request, response) => {
        response.writeHead(statusCode, { 'Content-Type': 'application/json' });
        response.end(responseBody);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address() as AddressInfo;
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

function requestError(baseUrl: string, apiKey: string): Promise<string> {
    return new Promise(resolve => {
        streamLlmResponse(
            { provider: 'openai', apiKey, baseUrl },
            TEST_MESSAGES,
            () => undefined,
            () => resolve('unexpected success'),
            resolve
        );
    });
}

test('does not expose an API key echoed by a provider authentication error', async () => {
    const secret = 'p1-11-secret-do-not-leak';
    const body = JSON.stringify({
        error: {
            message: `Incorrect API key provided: ${secret}`,
            code: 'invalid_api_key'
        }
    });

    await withErrorServer(401, body, async baseUrl => {
        const error = await requestError(baseUrl, secret);
        assert.equal(
            error,
            'OpenAI (GPT) API error (401): Authentication failed. Verify the configured API key.'
        );
        assert.doesNotMatch(error, /p1-11-secret-do-not-leak/);
        assert.doesNotMatch(error, /Incorrect API key provided/);
    });
});
test('does not forward arbitrary provider response bodies for other HTTP errors', async () => {
    const secret = 'p1-11-secret-in-bad-request';
    const malformedBody = `upstream rejected token ${secret} <html>internal details</html>`;

    await withErrorServer(400, malformedBody, async baseUrl => {
        const error = await requestError(baseUrl, secret);
        assert.equal(
            error,
            'OpenAI (GPT) API error (400): Request rejected. Check the provider, model, and base URL settings.'
        );
        assert.doesNotMatch(error, /p1-11-secret-in-bad-request/);
        assert.doesNotMatch(error, /internal details/);
    });
});
