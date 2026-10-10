package com.heaplens.session;

import com.heaplens.intellij.NativeServer;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class NativeServerTest {
    @TempDir Path temp;
    Path create(String target) throws Exception {
        Path directory = Files.createDirectories(temp.resolve("plugin with spaces/native/" + target));
        Path binary = directory.resolve(target.equals("win32-x64") ? "hprof-server.exe" : "hprof-server");
        byte[] bytes = "test payload, not executed".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(binary, bytes);
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        Files.writeString(directory.resolve("server.properties"), "target=" + target + "\nsha256=" + hash + "\n");
        if (Files.getFileStore(binary).supportsFileAttributeView("posix"))
            Files.setPosixFilePermissions(binary, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        return binary;
    }
    Path root() { return temp.resolve("plugin with spaces"); }
    Path resolveMac() throws IOException { return NativeServer.bundled(root(), "Mac OS X", "aarch64"); }

    @Test void mapsSupportedPlatformsAndAliasesWithoutGuessing() throws Exception {
        assertEquals("darwin-arm64", NativeServer.target("Mac OS X", "aarch64"));
        assertEquals("darwin-arm64", NativeServer.target("Mac OS X", "arm64"));
        assertEquals("darwin-x64", NativeServer.target("Mac OS X", "x86_64"));
        assertEquals("linux-x64", NativeServer.target("Linux", "amd64"));
        assertEquals("win32-x64", NativeServer.target("Windows 11", "amd64"));
        assertThrows(IOException.class, () -> NativeServer.target("Linux", "aarch64"));
        assertThrows(IOException.class, () -> NativeServer.target("Darwin", "x86"));
        assertThrows(IOException.class, () -> NativeServer.target("FreeBSD", "amd64"));
    }
    @Test void resolvesOnlyTheMatchingInstalledPayloadIncludingSpaces() throws Exception {
        Path binary = create("darwin-arm64"); create("darwin-x64");
        assertEquals(binary.toRealPath(), resolveMac());
        Path windows = create("win32-x64");
        assertEquals(windows.toRealPath(), NativeServer.bundled(root(), "Windows 11", "amd64"));
    }
    @Test void doesNotFallBackToAnotherArchitectureOrRootExecutable() throws Exception {
        create("darwin-x64"); Files.writeString(root().resolve("hprof-server"), "not trusted");
        assertThrows(IOException.class, this::resolveMac);
    }
    @Test void rejectsMissingMalformedOrMismatchedManifest() throws Exception {
        Path manifest = create("darwin-arm64").resolveSibling("server.properties");
        String original = Files.readString(manifest);
        Files.delete(manifest); assertThrows(IOException.class, this::resolveMac);
        Files.writeString(manifest, "sha256=bad\n"); assertThrows(IOException.class, this::resolveMac);
        Files.writeString(manifest, original.replace("darwin-arm64", "darwin-x64"));
        assertThrows(IOException.class, this::resolveMac);
    }
    @Test void rejectsCorruptionAndCanRecoverAfterRepair() throws Exception {
        Path binary = create("darwin-arm64"); byte[] original = Files.readAllBytes(binary);
        Files.writeString(binary, "corrupted"); assertThrows(IOException.class, this::resolveMac);
        Files.write(binary, original); assertEquals(binary.toRealPath(), resolveMac());
    }
    @Test void restoresOnlyOwnerExecuteAfterVerification() throws Exception {
        Path binary = create("darwin-arm64");
        assumeTrue(Files.getFileStore(binary).supportsFileAttributeView("posix"));
        Set<PosixFilePermission> before = Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
        Files.setPosixFilePermissions(binary, before);
        resolveMac();
        assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE), Files.getPosixFilePermissions(binary));
        Files.setPosixFilePermissions(binary, before); Files.writeString(binary, "bad");
        assertThrows(IOException.class, this::resolveMac);
        assertEquals(before, Files.getPosixFilePermissions(binary));
    }
    @Test void rejectsBinaryManifestAndDirectorySymlinks() throws Exception {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"));
        Path binary = create("darwin-arm64"), saved = temp.resolve("outside");
        Files.move(binary, saved); Files.createSymbolicLink(binary, saved);
        assertThrows(IOException.class, this::resolveMac);
        Files.delete(binary); Files.move(saved, binary);
        Path manifest = binary.resolveSibling("server.properties");
        Files.move(manifest, saved); Files.createSymbolicLink(manifest, saved);
        assertThrows(IOException.class, this::resolveMac);
        Files.delete(manifest); Files.move(saved, manifest);
        Path directory = binary.getParent(); Files.move(directory, saved);
        Files.createSymbolicLink(directory, saved); assertThrows(IOException.class, this::resolveMac);
    }
}
