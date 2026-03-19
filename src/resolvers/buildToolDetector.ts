import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import * as vscode from 'vscode';

export type BuildTool = 'maven' | 'gradle' | 'none';

export interface Dependency {
    groupId: string;
    artifactId: string;
    version: string;
}

export function detectBuildTool(workspaceRoot: string): BuildTool {
    if (fs.existsSync(path.join(workspaceRoot, 'pom.xml'))) {
        return 'maven';
    }
    if (fs.existsSync(path.join(workspaceRoot, 'build.gradle')) ||
        fs.existsSync(path.join(workspaceRoot, 'build.gradle.kts'))) {
        return 'gradle';
    }
    return 'none';
}

export function loadMavenDependencies(workspaceRoot: string, outputChannel: vscode.OutputChannel): Promise<Dependency[]> {
    const tmpFile = path.join(os.tmpdir(), `heaplens-mvn-deps-${Date.now()}.txt`);

    return new Promise((resolve) => {
        execFile('mvn', ['dependency:list', `-DoutputFile=${tmpFile}`, '-DincludeScope=compile'],
            { cwd: workspaceRoot, timeout: 60000 },
            (error, _stdout, stderr) => {
                if (error) {
                    if ((error as any).code === 'ENOENT') {
                        outputChannel.appendLine('HeapLens: mvn not found on PATH');
                    } else {
                        outputChannel.appendLine(`HeapLens: mvn dependency:list failed: ${stderr}`);
                    }
                    resolve([]);
                    return;
                }

                try {
                    const content = fs.readFileSync(tmpFile, 'utf-8');
                    const deps = parseMavenOutput(content);
                    fs.unlinkSync(tmpFile);
                    resolve(deps);
                } catch (e: any) {
                    outputChannel.appendLine(`HeapLens: Failed to parse Maven output: ${e.message}`);
                    resolve([]);
                }
            }
        );
    });
}

export function parseMavenOutput(content: string): Dependency[] {
    const deps: Dependency[] = [];
    const pattern = /^\s+([\w.-]+):([\w.-]+):\w+:([\w.-]+)/;

    for (const line of content.split('\n')) {
        const match = line.match(pattern);
        if (match) {
            deps.push({ groupId: match[1], artifactId: match[2], version: match[3] });
        }
    }
    return deps;
}

export function loadGradleDependencies(workspaceRoot: string, outputChannel: vscode.OutputChannel): Promise<Dependency[]> {
    const useWrapper = fs.existsSync(path.join(workspaceRoot, 'gradlew'));
    const cmd = useWrapper ? path.join(workspaceRoot, 'gradlew') : 'gradle';

    return new Promise((resolve) => {
        execFile(cmd,
            ['dependencies', '--configuration', 'compileClasspath', '--console=plain'],
            { cwd: workspaceRoot, timeout: 120000 },
            (error, stdout, stderr) => {
                if (error) {
                    if ((error as any).code === 'ENOENT') {
                        outputChannel.appendLine('HeapLens: gradle not found on PATH');
                    } else {
                        outputChannel.appendLine(`HeapLens: gradle dependencies failed: ${stderr}`);
                    }
                    resolve([]);
                    return;
                }

                try {
                    resolve(parseGradleOutput(stdout));
                } catch (e: any) {
                    outputChannel.appendLine(`HeapLens: Failed to parse Gradle output: ${e.message}`);
                    resolve([]);
                }
            }
        );
    });
}

export function parseGradleOutput(output: string): Dependency[] {
    const seen = new Set<string>();
    const deps: Dependency[] = [];
    const pattern = /[+\\|]---\s+([\w.-]+):([\w.-]+):([\w.-]+)(?:\s+->\s+([\w.-]+))?/;

    for (const line of output.split('\n')) {
        const match = line.match(pattern);
        if (match) {
            const version = match[4] || match[3];
            const key = `${match[1]}:${match[2]}:${version}`;
            if (!seen.has(key)) {
                seen.add(key);
                deps.push({ groupId: match[1], artifactId: match[2], version });
            }
        }
    }
    return deps;
}
