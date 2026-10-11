package com.heaplens.intellij;

import org.junit.jupiter.api.Test;
import com.intellij.util.xmlb.XmlSerializer;
import com.intellij.util.xmlb.SkipDefaultValuesSerializationFilters;
import org.jdom.Element;
import static org.junit.jupiter.api.Assertions.*;

class TelemetryPreferencesTest {
    @Test void freshApplicationWaitsForPermissionAndEveryExplicitChoiceSurvivesReload() {
        var fresh=new TelemetryPreferences();
        assertEquals("off",fresh.level());assertFalse(fresh.decided());
        for(String choice:new String[]{"off","error","all"}){
            fresh.save(choice);assertTrue(fresh.decided());
            var reloaded=new TelemetryPreferences();reloaded.loadState(fresh.getState());
            assertEquals(choice,reloaded.level());assertTrue(reloaded.decided());
        }
    }
    @Test void omittedLegacyOffXmlDoesNotBecomeOnAndNewStatesRoundTrip() {
        var preferences=new TelemetryPreferences();
        preferences.loadState(XmlSerializer.deserialize(new Element("state"),TelemetryPreferences.Values.class));
        assertEquals("off",preferences.level());assertFalse(preferences.decided());
        for(String choice:new String[]{"off","error","all"}){
            preferences.save(choice);
            var xml=XmlSerializer.serialize(preferences.getState(),new SkipDefaultValuesSerializationFilters());
            var reloaded=new TelemetryPreferences();
            reloaded.loadState(XmlSerializer.deserialize(xml,TelemetryPreferences.Values.class));
            assertEquals(choice,reloaded.level());assertTrue(reloaded.decided());
        }
    }
    @Test void legacyOnOrErrorsOnlyCannotAuthorizeNewTelemetry() {
        for(String level:new String[]{"off","error","all"}){
            var old=new TelemetryPreferences.Values();old.level=level;
            var preferences=new TelemetryPreferences();preferences.loadState(old);
            assertEquals("off",preferences.level());assertFalse(preferences.decided());
            var xml=XmlSerializer.serialize(preferences.getState(),new SkipDefaultValuesSerializationFilters());
            var reloaded=new TelemetryPreferences();reloaded.loadState(XmlSerializer.deserialize(xml,TelemetryPreferences.Values.class));
            assertEquals("off",reloaded.level());assertFalse(reloaded.decided());
        }
    }
    @Test void unknownPermissionVersionsFailClosed() {
        for(int version:new int[]{-1,0,2,100}){
            var state=new TelemetryPreferences.Values();state.level="all";state.consentVersion=version;
            var preferences=new TelemetryPreferences();preferences.loadState(state);
            assertEquals("off",preferences.level());assertFalse(preferences.decided());
        }
    }
    @Test void malformedPreferenceStillFailsClosed() {
        var preferences=new TelemetryPreferences();
        for(String value:new String[]{null,"private-canary",""}){
            var state=new TelemetryPreferences.Values();state.level=value;state.consentVersion=TelemetryPreferences.CONSENT_VERSION;
            preferences.loadState(state);assertEquals("off",preferences.level());assertFalse(preferences.decided());
        }
        preferences.loadState(null);assertEquals("off",preferences.level());assertFalse(preferences.decided());
    }
}
