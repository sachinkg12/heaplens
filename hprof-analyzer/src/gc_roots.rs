//! Shared GC-root classification for every heap-graph backend.
//!
//! Keeping the HPROF root-variant list here prevents the indexed and legacy
//! parsers from drifting when another root kind is added or corrected.

use jvm_hprof::heap_dump::SubRecord;

/// Returns the heap object designated by a GC-root sub-record.
///
/// `ROOT_THREAD_OBJECT` may legally omit its object ID for a newly attached
/// JNI thread; in that case there is no object node to connect.
pub(crate) fn object_id(record: &SubRecord<'_>) -> Option<u64> {
    match record {
        SubRecord::GcRootUnknown(root) => Some(root.obj_id().id()),
        SubRecord::GcRootThreadObj(root) => root.thread_obj_id().map(|id| id.id()),
        SubRecord::GcRootJniGlobal(root) => Some(root.obj_id().id()),
        SubRecord::GcRootJniLocalRef(root) => Some(root.obj_id().id()),
        SubRecord::GcRootJavaStackFrame(root) => Some(root.obj_id().id()),
        SubRecord::GcRootNativeStack(root) => Some(root.obj_id().id()),
        SubRecord::GcRootSystemClass(root) => Some(root.obj_id().id()),
        SubRecord::GcRootThreadBlock(root) => Some(root.obj_id().id()),
        SubRecord::GcRootBusyMonitor(root) => Some(root.obj_id().id()),
        SubRecord::GcRootInternedString(root) => Some(root.obj_id().id()),
        SubRecord::GcRootFinalizing(root) => Some(root.obj_id().id()),
        SubRecord::GcRootDebugger(root) => Some(root.obj_id().id()),
        SubRecord::GcRootReferenceCleanup(root) => Some(root.obj_id().id()),
        SubRecord::GcRootVmInternal(root) => Some(root.obj_id().id()),
        SubRecord::GcRootJniMonitor(root) => Some(root.obj_id().id()),
        SubRecord::GcRootUnreachable(root) => Some(root.obj_id().id()),
        _ => None,
    }
}
