package com.heaplens.source;

import java.util.Set;

/** Conservative Java file lookup, not a claim of declaration or dependency resolution. */
public record SourceTarget(String fileName, String packagePath) {
    private static final Set<String> PRIMITIVES = Set.of(
        "boolean", "byte", "char", "short", "int", "long", "float", "double", "void");

    public static SourceTarget parse(String name) {
        if (name == null || name.isBlank() || name.length() > 1024)
            throw new IllegalArgumentException("Invalid class name");
        if (name.startsWith("class ")) name = name.substring(6);
        while (name.endsWith("[]")) name = name.substring(0, name.length() - 2);
        String[] parts = name.split("\\.", -1);
        for (String part : parts) {
            if (part.isEmpty() || !Character.isJavaIdentifierStart(part.codePointAt(0)))
                throw new IllegalArgumentException("Invalid class name");
            for (int i = 0; i < part.length();) {
                int point = part.codePointAt(i);
                if (!Character.isJavaIdentifierPart(point) || Character.isIdentifierIgnorable(point))
                    throw new IllegalArgumentException("Invalid class name");
                i += Character.charCount(point);
            }
        }
        String simple = parts[parts.length - 1];
        if (PRIMITIVES.contains(simple)) throw new IllegalArgumentException("Primitive type");
        // Binary nested/anonymous classes map to their containing Java file.
        int inner = simple.indexOf('$', 1);
        if (inner >= 0) simple = simple.substring(0, inner);
        String packagePath = name.contains(".") ? name.substring(0, name.lastIndexOf('.')).replace('.', '/') : "";
        return new SourceTarget(simple + ".java", packagePath);
    }

    public boolean matchesPath(String path) {
        String normalized = path.replace('\\', '/');
        String suffix = packagePath.isEmpty() ? fileName : packagePath + "/" + fileName;
        return normalized.equals(suffix) || normalized.endsWith("/" + suffix);
    }
}
