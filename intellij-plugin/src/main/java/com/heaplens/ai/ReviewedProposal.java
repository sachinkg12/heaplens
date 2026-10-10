package com.heaplens.ai;

import java.util.Objects;

/** A reviewed snapshot is not permission to overwrite a changed or replaced source file. */
public record ReviewedProposal(String original, String proposed) {
    public static final int MAX_CHARS = 1024 * 1024;
    public ReviewedProposal {
        Objects.requireNonNull(original); Objects.requireNonNull(proposed);
        if (original.length() > MAX_CHARS || proposed.length() > MAX_CHARS)
            throw new IllegalArgumentException("Proposal exceeds the source limit");
    }
    public void check(String current, String reviewed, boolean active, boolean sameTarget, boolean writableProjectSource) {
        if (!active) throw new IllegalStateException("This proposal has expired. Reopen the dump or retry Fix with AI.");
        if (!sameTarget || !writableProjectSource)
            throw new IllegalStateException("The selected source is unavailable, replaced, moved or read-only. No edit was applied.");
        if (!original.equals(current))
            throw new IllegalStateException("Source changed since approval. No edit was applied. Generate a fresh proposal.");
        if (reviewed == null || reviewed.length() > MAX_CHARS)
            throw new IllegalStateException("Reviewed text exceeds the source limit. No edit was applied.");
    }
}
