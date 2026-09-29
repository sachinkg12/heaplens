package com.heaplens.intellij;

import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

// HPROF selection and the external-server editor do not use PSI or project indexes.
// Future index-dependent capabilities must gate their own work on smart mode.
public final class HeapEditorProvider implements FileEditorProvider, DumbAware {
    @Override public boolean accept(@NotNull Project project, @NotNull VirtualFile file) {
        return !file.isDirectory() && "hprof".equalsIgnoreCase(file.getExtension()) && file.isInLocalFileSystem();
    }
    @Override public @NotNull FileEditor createEditor(@NotNull Project project, @NotNull VirtualFile file) {
        return new HeapEditor(project, file);
    }
    @Override public @NotNull String getEditorTypeId() { return "heaplens.prototype.editor"; }
    @Override public @NotNull FileEditorPolicy getPolicy() { return FileEditorPolicy.HIDE_DEFAULT_EDITOR; }
}
