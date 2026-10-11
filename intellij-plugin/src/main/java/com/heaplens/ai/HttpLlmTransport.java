package com.heaplens.ai;

import com.google.gson.*;
import java.io.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Bounded SSE transport; redirects and raw provider errors never cross the credential boundary. */
public final class HttpLlmTransport implements LlmTransport {
    private final ExecutorService workers=Executors.newCachedThreadPool(r -> {Thread t=new Thread(r,"heaplens-ai-http");t.setDaemon(true);return t;});
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r -> {Thread t=new Thread(r,"heaplens-ai-deadline");t.setDaemon(true);return t;});
    private final Set<Job> jobs=ConcurrentHashMap.newKeySet();
    private final Duration timeout;
    private HttpClient client;
    private boolean closed;
    public HttpLlmTransport() { this(Duration.ofSeconds(90)); }
    HttpLlmTransport(Duration timeout) { this.timeout=timeout; }
    @Override public synchronized Call start(AiConfiguration config,List<Message> messages,Listener listener) {
        if(closed) throw new IllegalStateException("AI transport closed");
        if(client==null) client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NEVER).build();
        Job job=new Job(config,messages,listener,client); jobs.add(job);
        job.deadline=timer.schedule(() -> job.fail("AI request timed out. Stop or retry with a smaller question."),timeout.toMillis(),TimeUnit.MILLISECONDS);
        workers.execute(job); return job;
    }
    static JsonObject body(AiConfiguration config,List<Message> messages) {
        JsonObject body=new JsonObject(); body.addProperty("model",config.settings().model()); body.addProperty("stream",true);
        boolean anthropic=AiProviders.get(config.settings().provider()).apiFormat().equals("anthropic");
        JsonArray conversation=new JsonArray(); StringBuilder system=new StringBuilder();
        for(Message message:messages) {
            if(anthropic && message.role().equals("system")) {system.append(message.content()).append('\n');continue;}
            JsonObject row=new JsonObject();row.addProperty("role",message.role());row.addProperty("content",message.content());conversation.add(row);
        }
        body.add("messages",conversation);
        if(anthropic) {body.addProperty("system",system.toString());body.addProperty("max_tokens",4096);}
        return body;
    }
    static String httpError(int code) {
        String detail=switch(code) {
            case 401,403 -> "Authentication or access failed. Check the configured API key and permissions.";
            case 404 -> "Endpoint or model not found. Check Configure AI.";
            case 429 -> "Rate limit or quota reached. Wait or check your provider account.";
            default -> code>=300 && code<400 ? "Redirects are blocked. Configure the final trusted endpoint." : "Provider request failed. Check its endpoint, model or availability.";
        };
        return "AI provider HTTP "+code+": "+detail;
    }
    private final class Job implements Runnable,Call {
        final AiConfiguration config; final List<Message> messages; final Listener listener; final HttpClient http;
        final AtomicBoolean ended=new AtomicBoolean();
        volatile CompletableFuture<HttpResponse<InputStream>> request;
        volatile InputStream stream;
        volatile ScheduledFuture<?> deadline;
        Job(AiConfiguration c,List<Message> m,Listener l,HttpClient h) {config=c;messages=m;listener=l;http=h;}
        public void run() {
            try {
                if(ended.get()) return;
                String payload=body(config,messages).toString();
                if(payload.getBytes(StandardCharsets.UTF_8).length>262144) {fail("Conversation is too large. Clear chat and ask a shorter question.");return;}
                AiProviders.Provider provider=AiProviders.get(config.settings().provider());
                HttpRequest.Builder builder=HttpRequest.newBuilder(config.settings().endpoint()).timeout(timeout)
                    .header("Content-Type","application/json").header("Accept","text/event-stream");
                if(!config.key().isEmpty()) builder.header(provider.authStyle().equals("x-api-key") ? "x-api-key" : "Authorization",
                    provider.authStyle().equals("x-api-key") ? config.key() : "Bearer "+config.key());
                provider.headers().forEach(builder::header);
                request=http.sendAsync(builder.POST(HttpRequest.BodyPublishers.ofString(payload,StandardCharsets.UTF_8)).build(),HttpResponse.BodyHandlers.ofInputStream());
                if(ended.get()) {request.cancel(true);return;}
                HttpResponse<InputStream> response=request.get(); stream=response.body();
                if(ended.get()) {cleanup();return;}
                if(response.statusCode()!=200) {fail(httpError(response.statusCode()));return;}
                SecretFilter filter=new SecretFilter(config.key(),text -> {if(!ended.get()) listener.chunk(text);});
                boolean finished=readSse(new BufferedReader(new InputStreamReader(stream,StandardCharsets.UTF_8)),provider.apiFormat(),filter::accept);
                if(finished && !ended.get()) {
                    filter.finish();
                    if(ended.compareAndSet(false,true)) {cleanup();listener.done();}
                } else fail("AI stream ended unexpectedly. Partial text is not saved to conversation history.");
            } catch(Exception failure) {
                fail("AI connection or response failed. Check the trusted endpoint and try again.");
            } finally {cleanup();}
        }
        private boolean readSse(Reader reader,String format,Consumer<String> chunk) throws IOException {
            StringBuilder line=new StringBuilder(),data=new StringBuilder(); int count=0,ch;
            while(!ended.get() && (ch=reader.read())!=-1) {
                if(++count>2_097_152) throw new IOException("Stream limit");
                if(ch=='\r') continue;
                if(ch!='\n') {if(line.length()>=65536) throw new IOException("Line limit");line.append((char)ch);continue;}
                if(line.isEmpty()) {
                    if(!data.isEmpty()) {if(event(data.toString().stripTrailing(),format,chunk)) return true;data.setLength(0);}
                } else if(line.toString().startsWith("data:")) {
                    data.append(line.substring(5).stripLeading()).append('\n');
                    if(data.length()>131072) throw new IOException("Event limit");
                }
                line.setLength(0);
            }
            return false;
        }
        private boolean event(String value,String format,Consumer<String> chunk) throws IOException {
            if(value.equals("[DONE]")) return true;
            JsonObject json=JsonParser.parseString(value).getAsJsonObject();
            if(json.has("error") || (json.has("type") && json.get("type").getAsString().equals("error"))) throw new IOException("Provider stream error");
            if(format.equals("anthropic")) {
                String type=json.has("type") ? json.get("type").getAsString() : "";
                if(type.equals("message_stop")) return true;
                if(type.equals("content_block_delta") && json.has("delta")) emitText(json.getAsJsonObject("delta").get("text"),chunk);
            } else if(json.has("choices")) {
                JsonArray choices=json.getAsJsonArray("choices");
                if(!choices.isEmpty()) {
                    JsonObject choice=choices.get(0).getAsJsonObject();
                    if(choice.has("delta")) emitText(choice.getAsJsonObject("delta").get("content"),chunk);
                    if(choice.has("finish_reason") && !choice.get("finish_reason").isJsonNull()) return true;
                }
            }
            return false;
        }
        private void emitText(JsonElement value,Consumer<String> chunk) throws IOException {
            if(value==null || value.isJsonNull()) return;
            if(!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IOException("Invalid text");
            chunk.accept(value.getAsString());
        }
        void fail(String message) {if(ended.compareAndSet(false,true)) {cleanup();listener.error(message);}}
        public void cancel() {ended.set(true);cleanup();}
        private void cleanup() {
            if(deadline!=null) deadline.cancel(false);
            if(request!=null && !request.isDone()) request.cancel(true);
            InputStream body=stream;stream=null;
            if(body!=null) try {body.close();} catch(IOException ignored) { }
            jobs.remove(this);
        }
    }
    /** Redact an echoed credential even when a malicious response splits it across SSE chunks. */
    static final class SecretFilter {
        private final String secret; private final Consumer<String> output; private String pending="";
        SecretFilter(String secret,Consumer<String> output) {this.secret=secret;this.output=output;}
        void accept(String text) {
            if(secret.isEmpty()) {output.accept(text);return;}
            StringBuilder safe=new StringBuilder();
            for(int i=0;i<text.length();i++) {
                pending+=text.charAt(i);
                while(!pending.isEmpty() && !secret.startsWith(pending)) {safe.append(pending.charAt(0));pending=pending.substring(1);}
                if(pending.equals(secret)) {safe.append("[redacted]");pending="";}
            }
            if(!safe.isEmpty()) output.accept(safe.toString());
        }
        void finish() {if(!pending.isEmpty()) output.accept(pending);pending="";}
    }
    @Override public synchronized void close() {
        if(closed) return;closed=true;
        for(Job job:List.copyOf(jobs)) job.cancel();
        workers.shutdownNow();timer.shutdownNow();if(client!=null) client.shutdownNow();
    }
}
