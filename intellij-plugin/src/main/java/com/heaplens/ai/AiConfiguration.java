package com.heaplens.ai;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/** Credentials intentionally have no record-generated toString and never belong in persisted settings. */
public final class AiConfiguration {
    public record Settings(String provider, String baseUrl, String model) {
        public Settings {
            AiProviders.Provider definition = AiProviders.get(provider);
            baseUrl = baseUrl == null || baseUrl.isBlank() ? definition.defaultBaseUrl() : baseUrl.trim();
            while (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0,baseUrl.length()-1);
            validateEndpoint(baseUrl);
            model = model == null || model.isBlank() ? definition.defaultModel() : model.trim();
            if (model.length() > 200 || !model.matches("[A-Za-z0-9_./:@+\\-]+"))
                throw new IllegalArgumentException("Use a valid model ID (up to 200 characters).");
        }
        public URI endpoint() {
            String path = AiProviders.get(provider).chatPath();
            // Compatible APIs may already include a version in their base URL.
            if (baseUrl.endsWith("/v1") || baseUrl.endsWith("/v1beta/openai")) path = path.replaceFirst("^/v1/", "/");
            return URI.create(baseUrl + path);
        }
        public String credentialId() {
            try {
                byte[] digest = MessageDigest.getInstance("SHA-256").digest((provider + "\n" + baseUrl).getBytes(StandardCharsets.UTF_8));
                return "HeapLens IntelliJ AI " + HexFormat.of().formatHex(digest);
            } catch (Exception impossible) { throw new IllegalStateException("Credential scope unavailable"); }
        }
    }
    private final Settings settings;
    private final String key;
    public AiConfiguration(Settings settings, String key) {
        this.settings = settings; this.key = key == null ? "" : key;
        if (this.key.length() > 4096 || this.key.chars().anyMatch(c -> c <= 32 || c >= 127))
            throw new IllegalArgumentException("API key contains unsupported characters.");
        if (this.key.isEmpty() && !settings.provider().equals("ollama"))
            throw new IllegalArgumentException("No API key for this provider and endpoint. Use Configure AI.");
    }
    public Settings settings() { return settings; }
    String key() { return key; }
    /** In-memory consent identity only; never persist it or send it to the page/provider. */
    String chatApprovalScope() {
        try {
            String value=settings.provider()+"\n"+settings.baseUrl()+"\n"+settings.model()+"\n"+key;
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception impossible) { throw new IllegalStateException("AI approval scope unavailable"); }
    }
    @Override public String toString() { return "AiConfiguration[credentials redacted]"; }
    static URI validateEndpoint(String value) {
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            boolean loopback = host != null && (host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("[::1]"));
            if (value.length() > 2048 || host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null ||
                uri.getRawFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0 ||
                !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && loopback)) ||
                !uri.normalize().equals(uri) || value.chars().anyMatch(c -> c < 33 || c > 126)) throw new IllegalArgumentException();
            return uri;
        } catch (Exception invalid) {
            throw new IllegalArgumentException("Use HTTPS (HTTP only for localhost), without URL credentials, queries, fragments or relative paths.");
        }
    }
}
