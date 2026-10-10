package com.heaplens.ai;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Local fake servers only. No account credentials or external provider requests. */
class HttpLlmTransportTest {
    record Request(String path,Headers headers,String body) { }
    static final class Server implements AutoCloseable {
        final HttpServer server;
        final ExecutorService executor=Executors.newCachedThreadPool();
        final BlockingQueue<Request> requests=new LinkedBlockingQueue<>();
        Server(HttpHandler handler) throws IOException {
            server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.setExecutor(executor);
            server.createContext("/",exchange -> {
                requests.add(new Request(exchange.getRequestURI().getPath(),exchange.getRequestHeaders(),
                    new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8)));
                try {handler.handle(exchange);} finally {exchange.close();}
            });server.start();
        }
        String url(){return "http://127.0.0.1:"+server.getAddress().getPort();}
        Request next() throws Exception {Request request=requests.poll(5,TimeUnit.SECONDS);assertNotNull(request);return request;}
        public void close(){server.stop(0);executor.shutdownNow();}
    }
    static final class Result implements LlmTransport.Listener {
        final StringBuffer text=new StringBuffer();
        final CompletableFuture<String> terminal=new CompletableFuture<>();
        final AtomicInteger terminalCount=new AtomicInteger();
        public void chunk(String value){text.append(value);}
        public void done(){terminalCount.incrementAndGet();terminal.complete("done");}
        public void error(String value){terminalCount.incrementAndGet();terminal.complete(value);}
        String await() throws Exception{return terminal.get(5,TimeUnit.SECONDS);}
    }
    static AiConfiguration config(String provider,String base){return new AiConfiguration(new AiConfiguration.Settings(provider,base,"test-model"),"FAKE_SECRET_123");}
    static List<LlmTransport.Message> messages(){return List.of(new LlmTransport.Message("system","SYSTEM"),new LlmTransport.Message("system","METADATA"),new LlmTransport.Message("user","QUESTION"));}
    static String delta(String text){JsonObject d=new JsonObject();d.addProperty("content",text);JsonObject c=new JsonObject();c.add("delta",d);JsonArray choices=new JsonArray();choices.add(c);JsonObject root=new JsonObject();root.add("choices",choices);return "data: "+root+"\n\n";}
    static void response(HttpExchange x,int status,String body) throws IOException {
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8);x.getResponseHeaders().set("Content-Type","text/event-stream");
        x.sendResponseHeaders(status,bytes.length);x.getResponseBody().write(bytes);
    }
    @Test void allTenProviderFormatsProduceCorrectRealRequestsAndFilteredBodies() throws Exception {
        for(AiProviders.Provider provider:AiProviders.all()) {
            boolean anthropic=provider.apiFormat().equals("anthropic");
            String sse=anthropic ? "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hello 世界\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n" : delta("hello 世界")+"data: [DONE]\n\n";
            try(Server server=new Server(x->response(x,200,sse));HttpLlmTransport transport=new HttpLlmTransport()) {
                Result result=new Result();
                JsonObject analysis=JsonParser.parseString("{\"path\":\"PRIVATE_PATH\",\"summary\":{\"total_heap_size\":42},\"wasteAnalysis\":{\"duplicate_strings\":[{\"preview\":\"PRIVATE_VALUE\"}]}}").getAsJsonObject();
                transport.start(config(provider.id(),server.url()),List.of(new LlmTransport.Message("system",ChatContext.from(analysis)),new LlmTransport.Message("user","QUESTION")),result);
                Request request=server.next();assertEquals("done",result.await(),provider.id());assertEquals("hello 世界",result.text.toString());
                assertEquals(provider.chatPath(),request.path());assertEquals("application/json",request.headers().getFirst("Content-Type"));
                assertEquals(anthropic ? "FAKE_SECRET_123" : "Bearer FAKE_SECRET_123",request.headers().getFirst(anthropic ? "x-api-key" : "Authorization"));
                provider.headers().forEach((key,value)->assertEquals(value,request.headers().getFirst(key)));
                assertFalse(request.body().contains("FAKE_SECRET"));assertFalse(request.body().contains("PRIVATE_"));
                JsonObject body=JsonParser.parseString(request.body()).getAsJsonObject();assertTrue(body.get("stream").getAsBoolean());assertEquals("test-model",body.get("model").getAsString());
                assertEquals(anthropic ? 1 : 2,body.getAsJsonArray("messages").size());
                if(anthropic){assertTrue(body.get("system").getAsString().contains("42"));assertEquals(4096,body.get("max_tokens").getAsInt());}
                assertEquals(1,result.terminalCount.get());
            }
        }
    }
    @Test void httpFailuresNeverExposeBodiesAndRedirectsAreNotFollowed() throws Exception {
        for(int status:List.of(401,403,404,429,500,302)) {
            try(Server target=new Server(x->response(x,200,delta("unexpected")));Server server=new Server(x->{x.getResponseHeaders().set("Location",target.url());response(x,status,"FAKE_SECRET_123 PRIVATE_PATH raw provider error");});HttpLlmTransport transport=new HttpLlmTransport()) {
                Result result=new Result();transport.start(config("openai",server.url()),messages(),result);server.next();
                String error=result.await();assertTrue(error.contains("HTTP "+status));assertFalse(error.contains("SECRET"));assertFalse(error.contains("PRIVATE"));assertEquals("",result.text.toString());
                assertTrue(target.requests.isEmpty());
            }
        }
    }
    @Test void malformedOversizedAndIncompleteStreamsFailSafely() throws Exception {
        for(String body:List.of("data: invalid FAKE_SECRET_123\n\n","data: {\"error\":\"FAKE_SECRET_123\"}\n\n","data: "+"x".repeat(65537)+"\n\n",delta("partial"))) {
            try(Server server=new Server(x->response(x,200,body));HttpLlmTransport transport=new HttpLlmTransport()) {
                Result result=new Result();transport.start(config("openai",server.url()),messages(),result);assertNotEquals("done",result.await());
                assertFalse(result.await().contains("SECRET"));assertEquals(1,result.terminalCount.get());
            }
        }
    }
    @Test void echoedCredentialIsRedactedAcrossSseChunksAndUtf8ByteBoundaries() throws Exception {
        String stream=delta("Answer: FAKE_")+delta("SECRET_")+delta("123 世界")+"data:[DONE]\n\n";
        try(Server server=new Server(x->{x.sendResponseHeaders(200,0);for(byte b:stream.getBytes(StandardCharsets.UTF_8)){x.getResponseBody().write(b);x.getResponseBody().flush();}});HttpLlmTransport transport=new HttpLlmTransport()) {
            Result result=new Result();transport.start(config("openai",server.url()),messages(),result);
            assertEquals("done",result.await());assertEquals("Answer: [redacted] 世界",result.text.toString());
        }
    }
    @Test void deadlinesAndCancellationReleaseStalledRequestsWithoutLateCallbacks() throws Exception {
        CountDownLatch release=new CountDownLatch(1);
        try(Server server=new Server(x->{x.sendResponseHeaders(200,0);x.getResponseBody().flush();try{release.await(4,TimeUnit.SECONDS);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}});HttpLlmTransport timeout=new HttpLlmTransport(Duration.ofSeconds(1));HttpLlmTransport cancel=new HttpLlmTransport()) {
            Result timed=new Result();timeout.start(config("openai",server.url()),messages(),timed);server.next();assertTrue(timed.await().contains("timed out"));
            Result stopped=new Result();var call=cancel.start(config("openai",server.url()),messages(),stopped);server.next();call.cancel();cancel.close();release.countDown();
            assertFalse(stopped.terminal.isDone());assertEquals("",stopped.text.toString());
            assertThrows(IllegalStateException.class,()->cancel.start(config("openai",server.url()),messages(),new Result()));
        } finally {release.countDown();}
    }
    @Test void oversizedBodiesMakeNoHttpCall() throws Exception {
        try(Server server=new Server(x->response(x,200,""));HttpLlmTransport transport=new HttpLlmTransport()) {
            Result result=new Result();transport.start(config("openai",server.url()),List.of(new LlmTransport.Message("user","x".repeat(262145))),result);
            assertTrue(result.await().contains("too large"));assertTrue(server.requests.isEmpty());
        }
    }
}
