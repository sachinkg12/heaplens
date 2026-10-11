package com.heaplens.ai;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

public interface AiHostPort {
    /** Called on a worker; secure storage must not block the IDE UI. */
    AiConfiguration loadConfiguration();
    /** Fresh, user-visible approval of the immutable destination and data categories. */
    void confirm(AiConfiguration.Settings settings, boolean hasHistory, BooleanSupplier active, Consumer<Boolean> reply);
    /** Explicit session-scoped chat approval. Hosts must disclose that later sends reuse it. */
    default void confirmChatSession(AiConfiguration.Settings settings, boolean hasHistory, BooleanSupplier active, Consumer<Boolean> reply) {
        // A host with only one-request consent must not silently grant broader permission.
        reply.accept(false);
    }
    void configure(BooleanSupplier active, Consumer<String> status);
}
