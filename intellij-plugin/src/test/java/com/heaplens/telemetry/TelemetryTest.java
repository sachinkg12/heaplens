package com.heaplens.telemetry;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TelemetryTest {
    TelemetryContract contract(){return new TelemetryContract("intellij","0.1.8-prototype","darwin","arm64");}
    @Test void finalBodyRejectsRawValuesAndIdentifiers() {
        var c=contract();
        for(String key:List.of("errorSummary","path","query","source","apiKey","className","userId","sessionId"))
            assertNull(c.record("analysis/failed",Map.of(key,"private-canary"),Map.of()));
        assertNull(c.record("analysis/failed",Map.of("errorType","private-canary"),Map.of()));
        for(double value:new double[]{-1,Double.NaN,Double.POSITIVE_INFINITY,86400001})
            assertNull(c.record("analysis/completed",Map.of(),Map.of("durationMs",value)));
        var body=c.envelope(c.record("analysis/completed",Map.of(),Map.of("durationMs",1234.0,"heapSizeMB",95.0)));
        assertTrue(body.getAsJsonObject("tags").isEmpty());
        var metrics=body.getAsJsonObject("data").getAsJsonObject("baseData").getAsJsonObject("measurements");
        assertEquals(1200,metrics.get("durationMs").getAsInt());assertEquals(64,metrics.get("heapSizeMB").getAsInt());
        assertFalse(body.toString().contains("private-canary"));
    }
    @Test void offDevelopmentAndErrorsOnlyRespectConsent() {
        List<JsonObject> sent=new ArrayList<>();
        try(var c=new TelemetryClient(contract(),false,body->{sent.add(body);return CompletableFuture.completedFuture(true);})) {
            c.track("analysis/failed",Map.of("errorType","unknown"),Map.of());assertTrue(sent.isEmpty());assertTrue(c.report().getAsJsonArray("events").isEmpty());
            c.setLevel("error");c.track("analysis/completed",Map.of(),Map.of());assertTrue(sent.isEmpty());assertTrue(c.report().getAsJsonArray("events").isEmpty());
            c.track("analysis/failed",Map.of("errorType","parse","phase","loading"),Map.of());assertEquals(1,sent.size());
        }
        try(var c=new TelemetryClient(contract(),true,body->{fail("Tests must never send");return null;})) {
            c.setLevel("all");c.track("analysis/failed",Map.of(),Map.of());assertEquals("off",c.level());
        }
    }
    @Test void withdrawalCancelsQueuedEventsAndIgnoresStaleDelivery() {
        List<CompletableFuture<Boolean>> requests=new ArrayList<>();
        try(var c=new TelemetryClient(contract(),false,body->{var future=new CompletableFuture<Boolean>();requests.add(future);return future;})) {
            c.setLevel("all");c.track("analysis/started",Map.of(),Map.of());c.track("analysis/completed",Map.of(),Map.of());
            assertEquals(1,requests.size());c.setLevel("off");assertTrue(requests.getFirst().isCancelled());
            assertTrue(c.report().getAsJsonArray("events").isEmpty());assertEquals(0,c.report().get("queued").getAsInt());
            c.setLevel("all");assertEquals(1,requests.size());assertEquals(0,c.report().get("accepted").getAsInt());
        }
    }
    @Test void diagnosticFailuresNeverEscapeTheBoundary() {
        try(var c=new TelemetryClient(contract(),false,body->{throw new IllegalStateException("private error");})) {
            c.setLevel("all");assertDoesNotThrow(()->c.track("analysis/failed",Map.of(),Map.of()));
            assertFalse(c.report().toString().contains("private error"));
        }
    }
    @Test void commandObserverNeverReceivesMessageContentsAndCannotSuppressHandlers() {
        List<String> names=new ArrayList<>();List<JsonObject> handled=new ArrayList<>();
        var router=new com.heaplens.session.CommandRouter(Map.of("inspectObject",handled::add)).observed(names::add);
        assertTrue(router.dispatch("{\"command\":\"inspectObject\",\"objectId\":\"private-canary\"}"));
        assertEquals(List.of("inspectObject"),names);assertEquals(1,handled.size());
        assertTrue(router.observed(name->{throw new IllegalStateException();}).dispatch("{\"command\":\"inspectObject\"}"));
        List<String> records=new ArrayList<>();DiagnosticActions.requested((name,props,metrics)->records.add(name+props+metrics),"inspectObject");
        assertFalse(records.toString().contains("private-canary"));
    }
}
