import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { BuildTool, Dependency } from './buildToolDetector';

export function findSourceJar(dep: Dependency, buildTool: BuildTool): string | null {
    if (buildTool === 'maven') {
        return findMavenSourceJar(dep);
    }
    return findGradleSourceJar(dep);
}

export function findMavenSourceJar(dep: Dependency): string | null {
    const config = vscode.workspace.getConfiguration('heaplens');
    const customHome = config.get<string>('sourceResolution.mavenHome');
    const repoRoot = customHome || path.join(os.homedir(), '.m2', 'repository');

    const groupPath = dep.groupId.replace(/\./g, '/');
    const jarPath = path.join(repoRoot, groupPath, dep.artifactId, dep.version,
        `${dep.artifactId}-${dep.version}-sources.jar`);

    return fs.existsSync(jarPath) ? jarPath : null;
}

export function findGradleSourceJar(dep: Dependency): string | null {
    const config = vscode.workspace.getConfiguration('heaplens');
    const customHome = config.get<string>('sourceResolution.gradleHome');
    const cacheRoot = customHome || path.join(os.homedir(), '.gradle', 'caches',
        'modules-2', 'files-2.1');

    const depDir = path.join(cacheRoot, dep.groupId, dep.artifactId, dep.version);
    if (!fs.existsSync(depDir)) {
        return null;
    }

    const sourcesName = `${dep.artifactId}-${dep.version}-sources.jar`;
    try {
        for (const hashDir of fs.readdirSync(depDir)) {
            const candidate = path.join(depDir, hashDir, sourcesName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    } catch {
        // Directory read failed
    }
    return null;
}

export function findCompiledJar(dep: Dependency, buildTool: BuildTool): string | null {
    if (buildTool === 'maven') {
        return findMavenCompiledJar(dep);
    }
    return findGradleCompiledJar(dep);
}

export function findMavenCompiledJar(dep: Dependency): string | null {
    const config = vscode.workspace.getConfiguration('heaplens');
    const customHome = config.get<string>('sourceResolution.mavenHome');
    const repoRoot = customHome || path.join(os.homedir(), '.m2', 'repository');

    const groupPath = dep.groupId.replace(/\./g, '/');
    const jarPath = path.join(repoRoot, groupPath, dep.artifactId, dep.version,
        `${dep.artifactId}-${dep.version}.jar`);

    return fs.existsSync(jarPath) ? jarPath : null;
}

export function findGradleCompiledJar(dep: Dependency): string | null {
    const config = vscode.workspace.getConfiguration('heaplens');
    const customHome = config.get<string>('sourceResolution.gradleHome');
    const cacheRoot = customHome || path.join(os.homedir(), '.gradle', 'caches',
        'modules-2', 'files-2.1');

    const depDir = path.join(cacheRoot, dep.groupId, dep.artifactId, dep.version);
    if (!fs.existsSync(depDir)) {
        return null;
    }

    const jarName = `${dep.artifactId}-${dep.version}.jar`;
    try {
        for (const hashDir of fs.readdirSync(depDir)) {
            const candidate = path.join(depDir, hashDir, jarName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    } catch {
        // Directory read failed
    }
    return null;
}

export function extractFromJar(jarPath: string, internalPath: string, tempDir: string, outputChannel: vscode.OutputChannel): Promise<string | null> {
    return new Promise((resolve) => {
        const outPath = path.join(tempDir, internalPath);
        const outDir = path.dirname(outPath);

        execFile('unzip', ['-p', jarPath, internalPath], { timeout: 10000 },
            (error, stdout, _stderr) => {
                if (error || !stdout) {
                    return resolve(null);
                }

                try {
                    fs.mkdirSync(outDir, { recursive: true });
                    fs.writeFileSync(outPath, stdout, 'utf-8');
                    resolve(outPath);
                } catch (e: any) {
                    outputChannel.appendLine(`HeapLens: Failed to write extracted source: ${e.message}`);
                    resolve(null);
                }
            }
        );
    });
}
