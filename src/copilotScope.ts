import type { AnalysisData } from './analysisContext';
import type { ReadAction } from './aiInvestigation';
export interface CopilotAnalysisScope {
    identity: string;
    label: string;
    data: AnalysisData;
    signal: AbortSignal;
    current(): boolean;
    read(action: ReadAction,signal: AbortSignal): Promise<unknown>;
    dispose(): void;
}
