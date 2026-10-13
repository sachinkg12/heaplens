package com.heaplens.intellij;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class StoragePreferenceTest {
    @Test void statusShowsOnlyFixedStorageLabels() {
        var event=JsonParser.parseString("{\"storage\":{\"mode\":\"disk\",\"cache_status\":\"reused\",\"path\":\"private-canary\",\"sha256\":\"secret-canary\"}}").getAsJsonObject();
        assertEquals(" | references: disk | cache: reused",StoragePreference.label(event));
    }
    @Test void oldAndMalformedServerReportsRemainCompatible() {
        for(String text:new String[]{"{}","{\"storage\":null}","{\"storage\":{\"mode\":{}}}","{\"storage\":{\"mode\":\"private-canary\",\"cache_status\":\"reused\"}}"})
            assertEquals("",StoragePreference.label(JsonParser.parseString(text).getAsJsonObject()));
    }
}
