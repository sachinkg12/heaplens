package com.heaplens.monitor;

import com.google.gson.*;
import com.heaplens.session.CommandRouter;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MonitorActionsTest {
    record Consent(boolean histogram,BooleanSupplier active,Consumer<Boolean> reply){}
    static JsonObject start(int port){JsonObject m=new JsonObject();m.addProperty("host","127.0.0.1");m.addProperty("port",port);return m;}
    static JsonObject next(BlockingQueue<JsonObject> events,String command)throws Exception{
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);while(System.nanoTime()<end){var e=events.poll(100,TimeUnit.MILLISECONDS);if(e!=null && e.get("command").getAsString().equals(command))return e;}fail("Missing "+command);return null;
    }
    @Test void cancelAndRetiredApprovalMakeNoConnection()throws Exception{
        try(var server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())){
            server.setSoTimeout(150);List<Consent> approvals=new ArrayList<>();var events=new LinkedBlockingQueue<JsonObject>();
            try(var actions=new MonitorActions((h,p,hist,active,reply)->approvals.add(new Consent(hist,active,reply)),events::add)){
                actions.start(start(server.getLocalPort()));approvals.getLast().reply.accept(false);assertThrows(SocketTimeoutException.class,server::accept);
                assertTrue(next(events,"monitorError").get("message").getAsString().contains("cancelled"));
                actions.start(start(server.getLocalPort()));Consent retired=approvals.getLast();actions.stop();assertFalse(retired.active.getAsBoolean());retired.reply.accept(true);
                assertThrows(SocketTimeoutException.class,server::accept);
            }
        }
    }
    @Test void actualAgentProtocolMetricsHistogramAndDisconnect()throws Exception{
        try(var server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())){
            server.setSoTimeout(4000);var approvals=new LinkedBlockingQueue<Consent>();var events=new LinkedBlockingQueue<JsonObject>();
            try(var actions=new MonitorActions((h,p,hist,active,reply)->approvals.add(new Consent(hist,active,reply)),events::add)){
                actions.start(start(server.getLocalPort()));approvals.take().reply.accept(true);
                try(Socket client=server.accept()){
                    client.setSoTimeout(4000);var input=new BufferedReader(new InputStreamReader(client.getInputStream(),StandardCharsets.UTF_8));
                    var output=new PrintWriter(new OutputStreamWriter(client.getOutputStream(),StandardCharsets.UTF_8),true);
                    next(events,"monitorConnected");assertTrue(input.readLine().contains("get_metrics"));
                    JsonObject m=new JsonObject();for(String k:List.of("timestamp","heapUsed","heapMax","heapCommitted","nonHeapUsed","nonHeapCommitted","threadCount","daemonThreadCount","uptime"))m.addProperty(k,100);
                    m.add("gcCollectors",new JsonArray());m.add("memoryPools",new JsonArray());output.println("{\"type\":\"metrics\",\"data\":"+m+"}");
                    assertEquals(100,next(events,"monitorMetrics").getAsJsonObject("data").get("heapUsed").getAsInt());
                    actions.register(new CommandRouter(Map.of())).dispatch("{\"command\":\"requestMonitorHistogram\"}");Consent consent=approvals.take();assertTrue(consent.histogram);consent.reply.accept(true);
                    assertTrue(input.readLine().contains("get_histogram"));output.println("{\"type\":\"histogram\",\"data\":[{\"className\":\"example.Payload\",\"instanceCount\":2,\"totalBytes\":32}]}");
                    assertEquals(1,next(events,"monitorHistogram").getAsJsonArray("data").size());actions.stop();next(events,"monitorDisconnected");assertEquals(-1,input.read());
                }
            }
        }
    }
    @Test void malformedFramesFailClosedAndNeverEchoAgentContent()throws Exception{
        try(var server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())){
            server.setSoTimeout(4000);var events=new LinkedBlockingQueue<JsonObject>();
            try(var monitor=new AgentMonitor(events::add)){monitor.connect("127.0.0.1",server.getLocalPort());
                try(Socket client=server.accept()){next(events,"monitorConnected");client.getOutputStream().write("PRIVATE_INVALID\n".getBytes(StandardCharsets.UTF_8));client.getOutputStream().flush();
                    next(events,"monitorDisconnected");assertFalse(next(events,"monitorError").toString().contains("PRIVATE_INVALID"));}
            }
        }
    }
    @Test void invalidEndpointsAreRejectedBeforeConfirmation(){var events=new ArrayList<JsonObject>();
        try(var actions=new MonitorActions((h,p,hist,active,reply)->fail("Unexpected approval"),events::add)){
            for(String host:List.of("https://example.com","name/path","","bad host")){var m=start(9095);m.addProperty("host",host);actions.start(m);}
            actions.start(start(0));assertEquals(5,events.size());
        }
    }
}
