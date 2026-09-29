package com.heaplens.session;

import com.heaplens.intellij.HeapEditorProvider;
import com.intellij.openapi.fileEditor.FileEditorPolicy;
import com.intellij.openapi.project.DumbService;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HeapEditorProviderTest {
    @Test void hidingTheDefaultEditorSatisfiesTheSdkIndexingContract() {
        HeapEditorProvider provider = new HeapEditorProvider();
        assertEquals(FileEditorPolicy.HIDE_DEFAULT_EDITOR, provider.getPolicy());
        // Use the same SDK predicate as FileEditorProviderManagerImpl.checkPolicy.
        assertTrue(DumbService.isDumbAware(provider),
            "HIDE_DEFAULT_EDITOR providers must be available without project indexes");
    }
}
