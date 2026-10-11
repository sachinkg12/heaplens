package com.heaplens.source;

import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SourceTargetTest {
    @Test void normalizesArraysClassObjectsAndNestedOrAnonymousNames() {
        for (String name : List.of("example.Outer", "example.Outer$Nested", "example.Outer$1", "example.Outer[][]", "class example.Outer")) {
            assertEquals(new SourceTarget("Outer.java", "example"), SourceTarget.parse(name));
        }
        assertEquals(new SourceTarget("ShallowSizeCounterexample.java", ""), SourceTarget.parse("ShallowSizeCounterexample$Mixed"));
        assertEquals(new SourceTarget("$Valid.java", ""), SourceTarget.parse("$Valid$Inner"));
        assertEquals(new SourceTarget("Café.java", "例"), SourceTarget.parse("例.Café"));
    }
    @Test void matchesWholePackageSuffixAndHandlesWindowsWithoutGuessingOtherPackages() {
        SourceTarget target = SourceTarget.parse("com.example.Outer$Nested");
        assertTrue(target.matchesPath("/project/src/main/java/com/example/Outer.java"));
        assertTrue(target.matchesPath("C:\\project\\src\\com\\example\\Outer.java"));
        for (String path : List.of("/project/src/org/example/Outer.java", "/project/src/Outer.java", "/project/notcom/example/Outer.java", "/project/com/example/Outer.java.backup"))
            assertFalse(target.matchesPath(path), path);
        assertTrue(SourceTarget.parse("Outer").matchesPath("/project/src/Outer.java"));
    }
    @Test void rejectsPathsPrimitivesDescriptorsAndMalformedInput() {
        assertThrows(IllegalArgumentException.class, () -> SourceTarget.parse(null));
        for (String name : List.of("", " ", "..Foo", "a..Foo", "../Secret", "C:\\keys", "/tmp/Secret.java", "file:///Secret.java",
            "a.Foo\" onclick=\"bad", "a.Foo<script>", "[La.Foo;", "a.Foo/0x123", "1Foo", "byte[][]", "int", "a.\u0000Foo", "a".repeat(1025)))
            assertThrows(IllegalArgumentException.class, () -> SourceTarget.parse(name), name);
    }
    @Test void libraryNamesMatchAttachedJarAndJdkSourcePaths() {
        assertTrue(SourceTarget.parse("java.lang.String").matchesPath("/jdk/lib/src.zip!/java.base/java/lang/String.java"));
        assertTrue(SourceTarget.parse("org.library.Outer$Inner").matchesPath("/cache/library-sources.jar!/org/library/Outer.java"));
    }
}
