package com.heaplens.ai;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class AiConfigurationTest {
    @Test void reusesAllTenProviderDefinitionsAndBuildsExpectedPaths() {
        assertEquals(10,AiProviders.all().size());
        for(AiProviders.Provider provider:AiProviders.all()) {
            var settings=new AiConfiguration.Settings(provider.id(),"","");
            assertEquals(provider.defaultModel(),settings.model());
            assertEquals(provider.id().equals("anthropic") ? "/v1/messages" :
                provider.id().equals("gemini") ? "/v1beta/openai/chat/completions" :
                provider.id().equals("groq") ? "/openai/v1/chat/completions" :
                provider.id().equals("openrouter") ? "/api/v1/chat/completions" : "/v1/chat/completions",settings.endpoint().getPath());
        }
        assertEquals("https://example.com/v1/chat/completions",new AiConfiguration.Settings("openai","https://example.com/v1/","test").endpoint().toString());
    }
    @Test void rejectsUnsafeEndpointsWithoutEchoingUntrustedUrls() {
        for(String url:List.of("http://example.com","https://user:SECRET@example.com","https://example.com?key=SECRET",
            "https://example.com/#SECRET","file:///private/SECRET","ftp://example.com","https://example.com/a/../b",
            "http://localhost.evil.test","https://example.com:70000","https://example.com:0","https://example.com\nSECRET")) {
            var failure=assertThrows(IllegalArgumentException.class,()->new AiConfiguration.Settings("openai",url,"test"),url);
            assertFalse(failure.getMessage().contains("SECRET"));
        }
        for(String url:List.of("http://127.0.0.1:1234","http://localhost:11434","http://[::1]:11434"))
            assertDoesNotThrow(()->new AiConfiguration.Settings("ollama",url,"test"));
    }
    @Test void keysAreScopedToProviderAndEndpointAndNeverPrintedByConfiguration() {
        var first=new AiConfiguration.Settings("openai","https://example.com", "model");
        var modelChange=new AiConfiguration.Settings("openai","https://example.com", "other");
        assertEquals(first.credentialId(),modelChange.credentialId());
        assertNotEquals(first.credentialId(),new AiConfiguration.Settings("openai","https://other.example.com","model").credentialId());
        assertNotEquals(first.credentialId(),new AiConfiguration.Settings("groq","https://example.com","model").credentialId());
        assertFalse(new AiConfiguration(first,"test-secret").toString().contains("test-secret"));
        assertThrows(IllegalArgumentException.class,()->new AiConfiguration(first,""));
        assertThrows(IllegalArgumentException.class,()->new AiConfiguration(first,"test\nsecret"));
        assertDoesNotThrow(()->new AiConfiguration(new AiConfiguration.Settings("ollama","",""),""));
    }
    @Test void modelIsValidatedAndSettingsHaveOnlyNonSecretFields() {
        assertThrows(IllegalArgumentException.class,()->new AiConfiguration.Settings("openai","","<html>SECRET"));
        var fields=Arrays.stream(com.heaplens.intellij.AiPreferences.Values.class.getDeclaredFields()).map(java.lang.reflect.Field::getName).sorted().toList();
        assertEquals(List.of("baseUrl","model","provider"),fields);
        var storage=com.heaplens.intellij.AiPreferences.class.getAnnotation(com.intellij.openapi.components.State.class).storages()[0];
        assertEquals(com.intellij.openapi.components.RoamingType.DISABLED,storage.roamingType());
    }
}
