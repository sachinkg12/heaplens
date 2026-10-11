package com.heaplens.intellij;

import com.intellij.openapi.fileTypes.FileType;
import javax.swing.Icon;
import org.jetbrains.annotations.*;

public final class HprofFileType implements FileType {
    public static final HprofFileType INSTANCE = new HprofFileType();
    private HprofFileType() { }
    @Override public @NotNull String getName() { return "HeapLens HPROF"; }
    @Override public @NotNull String getDescription() { return "Java heap dump (HeapLens prototype)"; }
    @Override public @NotNull String getDefaultExtension() { return "hprof"; }
    @Override public @Nullable Icon getIcon() { return null; }
    @Override public boolean isBinary() { return true; }
}
