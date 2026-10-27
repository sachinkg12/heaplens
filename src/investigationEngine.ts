import { randomBytes } from 'crypto';
import type { ReadAction } from './aiInvestigation';

export interface InvestigationEnginePort { sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> }
/** This port can invoke exactly one bounded read API and its cancellation control. */
export async function readInvestigation(engine: InvestigationEnginePort,path: string,analysisId: string,
    action: ReadAction,signal: AbortSignal): Promise<unknown> {
    if(signal.aborted)throw Error('Investigation cancelled.');
    if(!/^[1-9][0-9]*$/.test(analysisId))throw Error('Current analysis identity is unavailable. Reanalyze the dump.');
    const job=randomBytes(16).toString('hex');
    const cancel=()=>{void engine.sendRequest('cancel_investigation',{job_id:job},3000).catch(()=>undefined);};
    signal.addEventListener('abort',cancel,{once:true});
    try {
        if(signal.aborted)throw Error('Investigation cancelled.');
        const raw=await engine.sendRequest('investigate_heap',{path,analysis_id:analysisId,job_id:job,action},3000);
        if(signal.aborted)throw Error('Investigation cancelled.');
        const result=raw as {analysis_id?:unknown;evidence?:unknown};
        if(!result || result.analysis_id!==analysisId || !result.evidence)throw Error('Investigation belongs to an unavailable or different analysis.');
        return result.evidence;
    } catch {
        cancel();
        throw Error('Bounded engine investigation failed or was cancelled. Reanalyze with the updated server if needed; no unrestricted fallback was used.');
    } finally {signal.removeEventListener('abort',cancel);}
}
