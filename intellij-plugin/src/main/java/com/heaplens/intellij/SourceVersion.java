package com.heaplens.intellij;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.*;
import java.util.HexFormat;
import java.util.Objects;

/** Bounded local disk identity/content fence, including edits not yet refreshed by the IDE. */
record SourceVersion(Path realPath, Object fileKey, String digest) {
    static SourceVersion capture(Path path) throws IOException {
        var attrs=Files.readAttributes(path,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!attrs.isRegularFile() || attrs.size()>com.heaplens.ai.ReviewedProposal.MAX_CHARS)
            throw new IOException("Source unavailable or too large");
        byte[] bytes;
        try(var input=Files.newInputStream(path,LinkOption.NOFOLLOW_LINKS)){
            bytes=input.readNBytes(com.heaplens.ai.ReviewedProposal.MAX_CHARS+1);
        }
        if(bytes.length>com.heaplens.ai.ReviewedProposal.MAX_CHARS)throw new IOException("Source too large");
        try {
            return new SourceVersion(path.toRealPath(),attrs.fileKey(),HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        } catch(NoSuchAlgorithmException impossible){throw new AssertionError(impossible);}
    }
    boolean unchanged(Path path) {
        try {
            SourceVersion current=capture(path);
            return realPath.equals(current.realPath) && Objects.equals(fileKey,current.fileKey) && digest.equals(current.digest);
        } catch(IOException | RuntimeException unavailable){return false;}
    }
}
