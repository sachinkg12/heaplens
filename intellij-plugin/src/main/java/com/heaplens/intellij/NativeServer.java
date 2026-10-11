package com.heaplens.intellij;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.security.*;
import java.util.*;

/** Resolves only the installed plugin's own native payload. No workspace or PATH search. */
public final class NativeServer {
    private NativeServer() { }

    public static String target(String os, String arch) throws IOException {
        String cpu = switch (arch.toLowerCase(Locale.ROOT)) {
            case "aarch64", "arm64" -> "arm64";
            case "x86_64", "amd64" -> "x64";
            default -> throw new IOException("Unsupported server architecture");
        };
        String platform = os.startsWith("Mac") ? "darwin" : os.startsWith("Windows") ? "win32" : os.equals("Linux") ? "linux" : "unsupported";
        String target = platform + "-" + cpu;
        if (!Set.of("darwin-arm64", "darwin-x64", "linux-x64", "win32-x64").contains(target))
            throw new IOException("Unsupported server platform");
        return target;
    }

    public static Path bundled(Path pluginRoot, String os, String arch) throws IOException {
        String target = target(os, arch);
        Path root = pluginRoot.toRealPath();
        Path directory = root.resolve("native").resolve(target);
        if (Files.isSymbolicLink(root.resolve("native")) || Files.isSymbolicLink(directory))
            throw new IOException("Invalid bundled server directory");
        Path binary = directory.resolve(target.equals("win32-x64") ? "hprof-server.exe" : "hprof-server");
        Path manifest = directory.resolve("server.properties");
        if (!Files.isRegularFile(binary, LinkOption.NOFOLLOW_LINKS) || !Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS))
            throw new IOException("Matching bundled server is missing; reinstall the matching platform package");
        Properties metadata = new Properties();
        try (var input = Files.newInputStream(manifest)) { metadata.load(input); }
        String expected = metadata.getProperty("sha256", "");
        if (!target.equals(metadata.getProperty("target")) || !expected.matches("[0-9a-f]{64}"))
            throw new IOException("Invalid bundled server metadata");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var input = Files.newInputStream(binary)) {
                byte[] buffer = new byte[65536];
                for (int length; (length = input.read(buffer)) != -1;) digest.update(buffer, 0, length);
            }
            if (!HexFormat.of().formatHex(digest.digest()).equals(expected)) throw new IOException("Bundled server checksum mismatch; reinstall the plugin");
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        // Some ZIP installers drop Unix execute bits. Repair only this verified bundled file.
        if (!target.startsWith("win32") && !Files.isExecutable(binary)) {
            Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(binary);
            permissions.add(PosixFilePermission.OWNER_EXECUTE);
            Files.setPosixFilePermissions(binary, permissions);
        }
        if (!Files.isExecutable(binary)) throw new IOException("Bundled server is not executable");
        return binary;
    }
}
