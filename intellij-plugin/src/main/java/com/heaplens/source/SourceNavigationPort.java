package com.heaplens.source;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Host opens a local file; no source bytes or paths cross back to the webview. */
@FunctionalInterface
public interface SourceNavigationPort {
    enum Status { SEARCHING, INDEXING, OPENED, OPENED_READ_ONLY, DEPENDENCY_SOURCE, DECOMPILED, NOT_FOUND, CANCELLED, TOO_MANY, ERROR, BUSY, UNAVAILABLE }
    void open(SourceTarget target, BooleanSupplier active, Consumer<Status> reply);
}
