package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.heaplens.telemetry.TelemetryClient;
import com.heaplens.telemetry.TelemetryContract;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TelemetryPermissionTest {
    final List<JsonObject> sent=new ArrayList<>();
    TelemetryPermission permission(TelemetryPreferences preferences,boolean disabled){
        var contract=new TelemetryContract("intellij","0.1.14-prototype","darwin","arm64");
        var client=new TelemetryClient(contract,disabled,body->{sent.add(body);return CompletableFuture.completedFuture(true);});
        return new TelemetryPermission(preferences,client,disabled);
    }
    void usage(TelemetryPermission permission){permission.track("analysis/completed",Map.of(),Map.of("durationMs",100.0));}
    void error(TelemetryPermission permission){permission.track("analysis/failed",Map.of("errorType","unknown"),Map.of());}
    @Test void noCollectionOrTransportUntilExplicitApprovalAndNoReplay(){
        var preferences=new TelemetryPreferences();
        try(var permission=permission(preferences,false)){
            usage(permission);error(permission);
            assertEquals(0,permission.report().getAsJsonArray("events").size());assertTrue(sent.isEmpty());
            assertTrue(permission.beginPrompt());assertFalse(permission.beginPrompt());
            usage(permission);assertTrue(sent.isEmpty());
            permission.finishPrompt(1);
            assertEquals("all",permission.level());assertTrue(preferences.decided());assertFalse(permission.beginPrompt());
            assertTrue(sent.isEmpty());usage(permission);assertEquals(1,sent.size());
        }
    }
    @Test void errorsOnlyDoesNotCollectUsage(){
        var preferences=new TelemetryPreferences();
        try(var permission=permission(preferences,false)){
            permission.beginPrompt();permission.finishPrompt(0);
            usage(permission);assertEquals(0,permission.report().getAsJsonArray("events").size());assertTrue(sent.isEmpty());
            error(permission);assertEquals(1,sent.size());assertEquals(1,permission.report().getAsJsonArray("events").size());
        }
    }
    @Test void declineDismissAndEscapeAreRememberedOff(){
        for(int choice:new int[]{-1,2,9}){
            var preferences=new TelemetryPreferences();
            try(var permission=permission(preferences,false)){
                permission.beginPrompt();permission.finishPrompt(choice);
                usage(permission);error(permission);assertEquals("off",permission.level());assertTrue(sent.isEmpty());
                assertTrue(preferences.decided());assertFalse(permission.beginPrompt());
                var restored=new TelemetryPreferences();restored.loadState(preferences.getState());
                try(var next=permission(restored,false)){assertFalse(next.beginPrompt());error(next);assertTrue(sent.isEmpty());}
            }
        }
    }
    @Test void disposedEditorAbandonsWithoutGrantAndAnotherEditorCanAsk(){
        var preferences=new TelemetryPreferences();
        try(var permission=permission(preferences,false)){
            assertTrue(permission.beginPrompt());permission.abandonPrompt();permission.finishPrompt(1);
            assertFalse(preferences.decided());usage(permission);assertTrue(sent.isEmpty());
            assertTrue(permission.beginPrompt());permission.finishPrompt(2);
            assertTrue(preferences.decided());assertEquals("off",permission.level());
        }
    }
    @Test void configureRetiresPendingPromptAndWithdrawalClearsLocalRecords(){
        var preferences=new TelemetryPreferences();
        try(var permission=permission(preferences,false)){
            permission.beginPrompt();permission.choose("all");
            assertFalse(permission.promptPending());permission.finishPrompt(2);assertEquals("all",permission.level());
            usage(permission);assertEquals(1,sent.size());assertEquals(1,permission.report().getAsJsonArray("events").size());
            permission.choose("off");error(permission);assertEquals(1,sent.size());
            assertEquals(0,permission.report().getAsJsonArray("events").size());assertFalse(permission.beginPrompt());
            permission.choose("error");error(permission);assertEquals(2,sent.size());
        }
    }
    @Test void disabledLaunchCannotPromptCollectOrSendEvenAfterSavedApproval(){
        var preferences=new TelemetryPreferences();preferences.save("all");
        try(var permission=permission(preferences,true)){
            assertFalse(permission.beginPrompt());permission.choose("all");usage(permission);error(permission);
            assertEquals("off",permission.level());assertTrue(sent.isEmpty());assertEquals(0,permission.report().getAsJsonArray("events").size());
        }
    }
    @Test void legacyOnCannotCollectUntilReapprovedAndClosingRetiresDialog(){
        var state=new TelemetryPreferences.Values();state.level="all";
        var preferences=new TelemetryPreferences();preferences.loadState(state);
        var permission=permission(preferences,false);usage(permission);assertTrue(sent.isEmpty());
        assertTrue(permission.beginPrompt());permission.close();permission.finishPrompt(1);permission.choose("all");
        usage(permission);assertTrue(sent.isEmpty());assertFalse(preferences.decided());assertFalse(permission.beginPrompt());
    }
}
