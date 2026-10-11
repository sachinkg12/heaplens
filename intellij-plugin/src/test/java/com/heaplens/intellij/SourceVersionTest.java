package com.heaplens.intellij;

import java.nio.file.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class SourceVersionTest {
    @TempDir Path directory;
    @Test void unchangedDiskPassesButExternalSameLengthEditWithRestoredTimestampDoesNot()throws Exception {
        Path file=directory.resolve("Owner.java");Files.writeString(file,"original");
        var timestamp=Files.getLastModifiedTime(file);var version=SourceVersion.capture(file);
        assertTrue(version.unchanged(file));Files.writeString(file,"useredit");Files.setLastModifiedTime(file,timestamp);
        assertFalse(version.unchanged(file));
    }
    @Test void deletedMovedAndReplacedFilesCannotPassDiskFence()throws Exception {
        Path file=directory.resolve("Owner.java");Files.writeString(file,"original");var version=SourceVersion.capture(file);
        Path moved=directory.resolve("Moved.java");Files.move(file,moved);assertFalse(version.unchanged(file));
        assertFalse(version.unchanged(moved));Files.writeString(file,"replacement");assertFalse(version.unchanged(file));
    }
    @Test void directoriesAndOversizedDiskFilesAreRejected()throws Exception {
        assertThrows(java.io.IOException.class,()->SourceVersion.capture(directory));
        Path file=directory.resolve("Owner.java");Files.writeString(file,"x".repeat(com.heaplens.ai.ReviewedProposal.MAX_CHARS+1));
        assertThrows(java.io.IOException.class,()->SourceVersion.capture(file));
    }
}
