import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';

import { BuildTool, Dependency, detectBuildTool, loadMavenDependencies, loadGradleDependencies } from './resolvers/buildToolDetector';
import { findSourceJar, findCompiledJar, extractFromJar } from './resolvers/jarExtractor';
import { getCfrJarPath, checkJavaAvailable, ensureCfrAvailable, decompileClass } from './resolvers/cfrDecompiler';

export interface DependencyInfo {
    groupId: string;
    artifactId: string;
    version: string;
}

export interface DependencyResolutionResult {
    uri: vscode.Uri;
    dependency: DependencyInfo;
    tier: 'source-jar' | 'decompiled';
}

export class DependencyResolver {
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;
    private globalStoragePath: string;
    private cfrJarPath: string;
    private buildTool: BuildTool | null = null;
    private dependencies: Dependency[] = [];
    private extractedCache = new Map<string, string>();
    private dependencyCache = new Map<string, { dependency: DependencyInfo; tier: 'source-jar' | 'decompiled' }>();
    private tempDir: string;
    private initPromise: Promise<void> | null = null;
    private offeredSourceDownload = false;
    private cfrState = { cfrDownloadAttempted: false };
    private javaState = { javaAvailable: null as boolean | null };

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel, globalStoragePath: string) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.globalStoragePath = globalStoragePath;
        this.cfrJarPath = getCfrJarPath(globalStoragePath);
        this.tempDir = path.join(os.tmpdir(), 'heaplens-sources');
    }

    async resolveFromDependencies(className: string): Promise<DependencyResolutionResult | null> {
        await this.ensureInitialized();

        this.outputChannel.appendLine(`[HeapLens] Resolving dependency for: ${className}`);

        if (this.buildTool === 'none' || this.dependencies.length === 0) {
            return null;
        }

        // Check cache first
        const cached = this.dependencyCache.get(className);
        if (cached) {
            const internalPath = className.replace(/\./g, '/') + '.java';
            const extractedPath = this.extractedCache.get(internalPath);
            if (extractedPath && fs.existsSync(extractedPath)) {
                return {
                    uri: vscode.Uri.file(extractedPath),
                    dependency: cached.dependency,
                    tier: cached.tier,
                };
            }
        }

        const internalPath = className.replace(/\./g, '/') + '.java';

        // Try each dependency for source JAR resolution
        for (const dep of this.dependencies) {
            const sourceJar = findSourceJar(dep, this.buildTool!);
            if (sourceJar) {
                const extractedPath = await extractFromJar(sourceJar, internalPath, this.tempDir, this.outputChannel);
                if (extractedPath) {
                    this.extractedCache.set(internalPath, extractedPath);
                    const depInfo: DependencyInfo = { groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version };
                    this.dependencyCache.set(className, { dependency: depInfo, tier: 'source-jar' });
                    return { uri: vscode.Uri.file(extractedPath), dependency: depInfo, tier: 'source-jar' };
                }
            }
        }

        // Offer to download source JARs (Maven only, once)
        if (this.buildTool === 'maven' && !this.offeredSourceDownload) {
            const downloaded = await this.offerSourceDownload();
            if (downloaded) {
                // Retry after download
                for (const dep of this.dependencies) {
                    const sourceJar = findSourceJar(dep, this.buildTool!);
                    if (sourceJar) {
                        const extractedPath = await extractFromJar(sourceJar, internalPath, this.tempDir, this.outputChannel);
                        if (extractedPath) {
                            this.extractedCache.set(internalPath, extractedPath);
                            const depInfo: DependencyInfo = { groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version };
                            this.dependencyCache.set(className, { dependency: depInfo, tier: 'source-jar' });
                            return { uri: vscode.Uri.file(extractedPath), dependency: depInfo, tier: 'source-jar' };
                        }
                    }
                }
            }
        }

        // Tier 3: Decompilation fallback
        const decompilerEnabled = vscode.workspace.getConfiguration('heaplens').get<boolean>('sourceResolution.decompilerEnabled', true);
        if (!decompilerEnabled) {
            return null;
        }

        const javaOk = await checkJavaAvailable(this.outputChannel, this.javaState);
        if (!javaOk) {
            return null;
        }

        const cfrOk = await ensureCfrAvailable(this.cfrJarPath, this.globalStoragePath, this.outputChannel, this.cfrState);
        if (!cfrOk) {
            return null;
        }

        for (const dep of this.dependencies) {
            const compiledJar = findCompiledJar(dep, this.buildTool!);
            if (compiledJar) {
                const decompiledPath = await decompileClass(className, compiledJar, this.cfrJarPath, this.tempDir, this.outputChannel);
                if (decompiledPath) {
                    const depInfo: DependencyInfo = { groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version };
                    this.dependencyCache.set(className, { dependency: depInfo, tier: 'decompiled' });
                    return { uri: vscode.Uri.file(decompiledPath), dependency: depInfo, tier: 'decompiled' };
                }
            }
        }

        return null;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.initialize();
        }
        return this.initPromise;
    }

    private async initialize(): Promise<void> {
        this.buildTool = detectBuildTool(this.workspaceRoot);
        this.outputChannel.appendLine(`[HeapLens] Detected build tool: ${this.buildTool}`);

        if (this.buildTool === 'none') {
            return;
        }

        if (this.buildTool === 'maven') {
            this.dependencies = await loadMavenDependencies(this.workspaceRoot, this.outputChannel);
        } else {
            this.dependencies = await loadGradleDependencies(this.workspaceRoot, this.outputChannel);
        }

        this.outputChannel.appendLine(`[HeapLens] Loaded ${this.dependencies.length} dependencies`);
    }

    private async offerSourceDownload(): Promise<boolean> {
        this.offeredSourceDownload = true;

        const choice = await vscode.window.showInformationMessage(
            'HeapLens: Source JARs not found for some dependencies. Download via Maven?',
            'Download Sources', 'No'
        );

        if (choice !== 'Download Sources') {
            return false;
        }

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'HeapLens: Downloading source JARs...' },
            () => new Promise<boolean>((resolve) => {
                execFile('mvn', ['dependency:sources'],
                    { cwd: this.workspaceRoot, timeout: 300000 },
                    (error, _stdout, stderr) => {
                        if (error) {
                            this.outputChannel.appendLine(`HeapLens: mvn dependency:sources failed: ${stderr}`);
                            vscode.window.showWarningMessage('HeapLens: Failed to download some source JARs.');
                            resolve(false);
                        } else {
                            vscode.window.showInformationMessage('HeapLens: Source JARs downloaded successfully.');
                            resolve(true);
                        }
                    }
                );
            })
        );
    }

    async dispose(): Promise<void> {
        try {
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }
        } catch (e: any) {
            this.outputChannel.appendLine(`HeapLens: Failed to clean temp dir: ${e.message}`);
        }
        this.extractedCache.clear();
        this.dependencyCache.clear();
        this.dependencies = [];
        this.buildTool = null;
    }
}
