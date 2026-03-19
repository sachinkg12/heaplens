import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as vscode from 'vscode';
import { execFile } from 'child_process';

const CFR_VERSION = '0.152';
const CFR_DOWNLOAD_URL = `https://github.com/leibnitz27/cfr/releases/download/${CFR_VERSION}/cfr-${CFR_VERSION}.jar`;
const DECOMPILED_HEADER = '// Decompiled by HeapLens (CFR decompiler)\n\n';

export function getCfrJarPath(globalStoragePath: string): string {
    return path.join(globalStoragePath, `cfr-${CFR_VERSION}.jar`);
}

export function checkJavaAvailable(outputChannel: vscode.OutputChannel, cache: { javaAvailable: boolean | null }): Promise<boolean> {
    if (cache.javaAvailable !== null) {
        return Promise.resolve(cache.javaAvailable);
    }

    return new Promise((resolve) => {
        execFile('java', ['-version'], { timeout: 5000 }, (error) => {
            cache.javaAvailable = !error;
            if (error) {
                outputChannel.appendLine('HeapLens: java not found on PATH — decompilation unavailable');
            }
            resolve(cache.javaAvailable);
        });
    });
}

export async function ensureCfrAvailable(cfrJarPath: string, globalStoragePath: string, outputChannel: vscode.OutputChannel, state: { cfrDownloadAttempted: boolean }): Promise<boolean> {
    if (fs.existsSync(cfrJarPath)) {
        return true;
    }
    if (state.cfrDownloadAttempted) {
        return false;
    }
    state.cfrDownloadAttempted = true;

    outputChannel.appendLine('HeapLens: Downloading CFR decompiler...');
    return downloadCfr(cfrJarPath, globalStoragePath, outputChannel);
}

function downloadCfr(cfrJarPath: string, globalStoragePath: string, outputChannel: vscode.OutputChannel): Promise<boolean> {
    return new Promise((resolve) => {
        fs.mkdirSync(globalStoragePath, { recursive: true });
        const tmpPath = cfrJarPath + '.download';

        const doGet = (url: string, redirects: number) => {
            if (redirects > 5) {
                outputChannel.appendLine('HeapLens: CFR download failed — too many redirects');
                cleanupFile(tmpPath);
                return resolve(false);
            }

            https.get(url, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    doGet(res.headers.location, redirects + 1);
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    outputChannel.appendLine(`HeapLens: CFR download failed — HTTP ${res.statusCode}`);
                    cleanupFile(tmpPath);
                    return resolve(false);
                }

                const file = fs.createWriteStream(tmpPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        try {
                            fs.renameSync(tmpPath, cfrJarPath);
                            outputChannel.appendLine('HeapLens: CFR decompiler downloaded successfully');
                            resolve(true);
                        } catch (e: any) {
                            outputChannel.appendLine(`HeapLens: Failed to finalize CFR download: ${e.message}`);
                            cleanupFile(tmpPath);
                            resolve(false);
                        }
                    });
                });
                file.on('error', (e) => {
                    outputChannel.appendLine(`HeapLens: CFR download write error: ${e.message}`);
                    cleanupFile(tmpPath);
                    resolve(false);
                });
            }).on('error', (e) => {
                outputChannel.appendLine(`HeapLens: CFR download failed: ${e.message}`);
                cleanupFile(tmpPath);
                resolve(false);
            });
        };

        doGet(CFR_DOWNLOAD_URL, 0);
    });
}

function cleanupFile(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Best-effort cleanup
    }
}

export function decompileClass(className: string, jarPath: string, cfrJarPath: string, tempDir: string, outputChannel: vscode.OutputChannel): Promise<string | null> {
    return new Promise((resolve) => {
        execFile('java', ['-jar', cfrJarPath, className, '--jarfilepath', jarPath],
            { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error || !stdout) {
                    if (error) {
                        outputChannel.appendLine(`HeapLens: CFR decompilation failed for ${className}: ${stderr || error.message}`);
                    }
                    return resolve(null);
                }

                if (stdout.startsWith('/*\n') && !stdout.includes('\npublic ') && !stdout.includes('\nclass ')) {
                    return resolve(null);
                }

                const internalPath = className.replace(/\./g, '/') + '.java';
                const outPath = path.join(tempDir, 'decompiled', internalPath);
                const outDir = path.dirname(outPath);

                try {
                    fs.mkdirSync(outDir, { recursive: true });
                    fs.writeFileSync(outPath, DECOMPILED_HEADER + stdout, 'utf-8');
                    resolve(outPath);
                } catch (e: any) {
                    outputChannel.appendLine(`HeapLens: Failed to write decompiled source: ${e.message}`);
                    resolve(null);
                }
            }
        );
    });
}
