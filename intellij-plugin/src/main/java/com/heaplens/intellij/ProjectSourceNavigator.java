package com.heaplens.intellij;

import com.heaplens.source.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.*;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.*;
import com.intellij.openapi.roots.ProjectFileIndex;
import com.intellij.openapi.ui.popup.*;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.search.*;
import com.intellij.util.concurrency.AppExecutorUtil;
import java.util.Comparator;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.awt.Component;
import javax.swing.*;

/** Project files, attached dependency sources, then IDE decompilation. No shell or downloads. */
final class ProjectSourceNavigator implements SourceNavigationPort {
    private final Project project;
    private final Disposable owner;
    ProjectSourceNavigator(Project project, Disposable owner) { this.project = project; this.owner = owner; }

    @Override public void open(SourceTarget target, BooleanSupplier active, Consumer<Status> reply) {
        select(target, false, active, reply, file -> { if (file != null) openFile(file, active, reply); });
    }
    void select(SourceTarget target, boolean projectOnly, BooleanSupplier active, Consumer<Status> reply, Consumer<VirtualFile> result) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!active.getAsBoolean() || project == null || project.isDisposed()) return;
            reply.accept(DumbService.isDumb(project) ? Status.INDEXING : Status.SEARCHING);
            ReadAction.nonBlocking(() -> candidates(target, projectOnly))
                .inSmartMode(project).expireWith(owner).expireWhen(() -> !active.getAsBoolean() || project.isDisposed())
                .finishOnUiThread(ModalityState.nonModal(), files -> {
                    if (!active.getAsBoolean() || project.isDisposed()) return;
                    try { choose(files, active, reply, result); }
                    catch (ProcessCanceledException cancelled) { reply.accept(Status.CANCELLED); result.accept(null); }
                    catch (RuntimeException failure) { reply.accept(Status.ERROR); result.accept(null); }
                }).submit(AppExecutorUtil.getAppExecutorService())
                .onError(failure -> { if (active.getAsBoolean()) { reply.accept(Status.ERROR); result.accept(null); } });
        });
    }
    private List<VirtualFile> candidates(SourceTarget target, boolean projectOnly) {
        ProjectFileIndex index = ProjectFileIndex.getInstance(project);
        var scope = GlobalSearchScope.allScope(project);
        var sources = FilenameIndex.getVirtualFilesByName(target.fileName(), scope).stream()
            .filter(file -> file.isValid() && !file.isDirectory() && target.matchesPath(file.getPath())).toList();
        var local = sources.stream().filter(file -> file.isInLocalFileSystem() && index.isInContent(file)).toList();
        if (projectOnly || !local.isEmpty()) return ordered(local);
        var libraries = sources.stream().filter(index::isInLibrarySource).toList();
        if (!libraries.isEmpty()) return ordered(libraries);
        String compiled = target.fileName().replaceFirst("\\.java$", ".class");
        return ordered(FilenameIndex.getVirtualFilesByName(compiled, scope).stream()
            .filter(file -> file.isValid() && index.isInLibraryClasses(file)
                && target.matchesPath(file.getPath().replaceFirst("\\.class$", ".java"))).toList());
    }
    private static List<VirtualFile> ordered(List<VirtualFile> files) {
        return files.stream().sorted(Comparator.comparing(VirtualFile::getPath)).limit(51).toList();
    }
    private void choose(List<VirtualFile> files, BooleanSupplier active, Consumer<Status> reply, Consumer<VirtualFile> result) {
        if (files.isEmpty()) { reply.accept(Status.NOT_FOUND); result.accept(null); return; }
        if (files.size() > 50) { reply.accept(Status.TOO_MANY); result.accept(null); return; }
        if (files.size() > 1) {
            // Paths stay in this local chooser, never in the page or analysis process.
            JBPopup popup = JBPopupFactory.getInstance().createPopupChooserBuilder(files)
                .setTitle("HeapLens: Choose Matching Java Source").setRequestFocus(true)
                .setRenderer(new DefaultListCellRenderer() {
                    @Override public Component getListCellRendererComponent(JList<?> list, Object value, int index,
                            boolean selected, boolean focused) {
                        return super.getListCellRendererComponent(list, ((VirtualFile)value).getPresentableUrl(), index, selected, focused);
                    }
                })
                .setNamerForFiltering(VirtualFile::getPresentableUrl)
                .setItemChosenCallback(file -> { if (active.getAsBoolean()) result.accept(file); })
                .addListener(new JBPopupListener() {
                    @Override public void onClosed(LightweightWindowEvent event) {
                        if (!event.isOk() && active.getAsBoolean()) { reply.accept(Status.CANCELLED); result.accept(null); }
                    }
                }).createPopup();
            Disposer.register(owner, popup);
            popup.showInFocusCenter();
            return;
        }
        result.accept(files.getFirst());
    }
    private void openFile(VirtualFile file, BooleanSupplier active, Consumer<Status> reply) {
        if (!active.getAsBoolean() || project.isDisposed()) return;
        try {
            ProjectFileIndex index = ProjectFileIndex.getInstance(project);
            if (!file.isValid() || !(index.isInContent(file) || index.isInLibrarySource(file) || index.isInLibraryClasses(file))) {
                reply.accept(Status.NOT_FOUND); return;
            }
            boolean opened = FileEditorManager.getInstance(project).openFile(file, true).length > 0;
            reply.accept(!opened ? Status.ERROR : "class".equals(file.getExtension()) ? Status.DECOMPILED
                : index.isInLibrarySource(file) ? Status.DEPENDENCY_SOURCE
                : file.isInLocalFileSystem() && file.isWritable() && "java".equals(file.getExtension()) && file.getLength()<=1024*1024
                    ? Status.OPENED : Status.OPENED_READ_ONLY);
        } catch (ProcessCanceledException cancelled) {
            reply.accept(Status.CANCELLED);
        } catch (RuntimeException failure) {
            reply.accept(Status.ERROR);
        }
    }
}
