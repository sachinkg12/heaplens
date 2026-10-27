export interface ChatQuerySegment { text: string; query?: string }

/** Presentation only: recognize read-only suggestions; the engine remains the query parser. */
export function chatQuerySegments(answer: string): ChatQuerySegment[] {
    if (answer.length > 65536) return [{text: answer}];
    const text = answer;
    const found: Array<{start:number;end:number;query:string}> = [];
    const fences: Array<{start:number;end:number}> = [];
    const candidate = (raw: string): string | undefined => {
        const query = raw.trim();
        if (!query || query.length > 32000) return;
        if (/^:(?:info|path|refs|children)\s+(?:0x[0-9a-f]+|[0-9]+)\s*$/i.test(query)) return query;
        if (!/^SELECT\b/i.test(query)) return;
        // Ignore quoted literals when recognizing table names and statement boundaries.
        let masked = '', quote = '';
        for (let i=0;i<query.length;i++) {
            const ch=query[i];
            if (quote) {
                if (ch==='\\') { i++; masked+='  '; continue; }
                if (ch===quote) { if(query[i+1]===quote){i++;masked+='  ';continue;}quote=''; }
                masked+=' ';
            } else if(ch==="'" || ch==='"') { quote=ch;masked+=' '; }
            else masked+=ch;
        }
        if (quote || /--|\/\*|\*\/|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|PRAGMA|EXEC|CALL|INTO)\b/i.test(masked)) return;
        if (masked.replace(/;\s*$/, '').includes(';')) return;
        const tables=[...masked.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(m=>m[1].toLowerCase());
        if (!tables.length || tables.some(t=>!['instances','class_histogram','dominator_tree','leak_suspects'].includes(t))) return;
        // SQL-style terminal delimiters are presentation, not supported HeapQL tokens.
        return query.endsWith(';') ? query.slice(0,-1).trimEnd() : query;
    };
    const add=(start:number,end:number,raw:string)=>{const query=candidate(raw);if(query && found.length<16)found.push({start,end,query});};
    // Exclude every fenced language from prose scanning, including shell/Java/JavaScript.
    const fence=/^ {0,3}(`{3,}|~{3,})([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?(?=\n|$)/gm;
    for(const match of text.matchAll(fence)) {
        const start=match.index!,end=start+match[0].length;fences.push({start,end});
        if(/^(?:heapql|sql)?$/i.test(match[2]))add(start,end,match[3]);
    }
    for(const match of text.matchAll(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm)) {
        if(!fences.some(span=>match.index!>=span.start && match.index!<span.end)){fences.push({start:match.index!,end:text.length});break;}
    }
    fences.sort((a,b)=>a.start-b.start);
    const scan=(start:number,end:number)=>{
        const chunk=text.slice(start,end);
        for(const match of chunk.matchAll(/`([^`\n]+)`/g))add(start+match.index!,start+match.index!+match[0].length,match[1]);
        for(const match of chunk.matchAll(/[^\n]+(?:\n(?![ \t\r]*\n)[^\n]+)*/g))add(start+match.index!,start+match.index!+match[0].length,match[0]);
    };
    let offset=0;for(const span of fences){scan(offset,span.start);offset=span.end;}scan(offset,text.length);
    found.sort((a,b)=>a.start-b.start || b.end-a.end);
    const segments:ChatQuerySegment[]=[];offset=0;
    for(const span of found){if(span.start<offset)continue;if(span.start>offset)segments.push({text:text.slice(offset,span.start)});segments.push({text:text.slice(span.start,span.end),query:span.query});offset=span.end;}
    if(offset<text.length || !segments.length)segments.push({text:text.slice(offset)});
    return segments;
}
