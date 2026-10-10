package com.heaplens.intellij;

import com.heaplens.telemetry.TelemetryContract;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PackagedTelemetryVersionTest {
    @Test void generatedVersionIsAvailableWithoutPluginManagerOrNetwork() {
        String version=IntellijTelemetry.packagedVersion();
        assertTrue(version.matches("[0-9]+\\.[0-9]+\\.[0-9]+-prototype"));
        var contract=new TelemetryContract("intellij",version,"darwin","arm64");
        var event=contract.record("analysis/completed",Map.of(),Map.of());
        assertEquals(version,event.getAsJsonObject("properties").get("version").getAsString());
    }
}
