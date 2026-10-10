package com.heaplens.intellij;

import com.heaplens.snapshots.SnapshotCatalog;
import com.intellij.openapi.components.Service;

/** No global cross-project dump registry. No graph or process ownership here. */
@Service(Service.Level.PROJECT)
public final class ProjectSnapshots {
    public final SnapshotCatalog catalog=new SnapshotCatalog();
}
